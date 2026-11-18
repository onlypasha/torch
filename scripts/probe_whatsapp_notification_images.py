"""Read-only WhatsApp toast image probe. Never prints text, contacts or image URIs.

Only image files under WhatsApp's package folders or Windows' notification
cache are inspected. --fetch-cdn optionally probes WhatsApp HTTPS image hosts.
Images, signed URLs, contact names and message contents are never exported.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import urllib.request
import urllib.error


def image_metadata(data):
    result = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        result.update(format="PNG", dimensions=list(struct.unpack(">II", data[16:24])))
    elif data.startswith(b"\xff\xd8"):
        result["format"] = "JPEG"
        offset = 2
        while offset + 4 < len(data) and data[offset] == 0xff:
            marker = data[offset + 1]
            if marker in (0xd8, 0xd9):
                offset += 2
                continue
            length = int.from_bytes(data[offset + 2:offset + 4], "big")
            if length < 2:
                break
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf) and offset + 9 <= len(data):
                height, width = struct.unpack(">HH", data[offset + 5:offset + 9])
                result["dimensions"] = [width, height]
                break
            offset += length + 2
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        result["format"] = "WEBP"
    else:
        result["format"] = "other"
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def inspect_image(uri, local, package_root, fetch_cdn=False):
    parsed = urlsplit(uri)
    result = {"uri_scheme": parsed.scheme or "local"}
    if parsed.scheme == "https":
        result["source_host"] = parsed.hostname
        host = parsed.hostname or ""
        if fetch_cdn and (host == "static.whatsapp.net" or host.endswith(".cdn.whatsapp.net")) and parsed.port in (None, 443) and not parsed.username:
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                request = urllib.request.Request(uri, headers={"Accept": "image/*"})
                with opener.open(request, timeout=5) as response:
                    result.update(http_status=response.status, content_type=response.headers.get_content_type())
                    if not result["content_type"].startswith("image/"):
                        return {**result, "fetch_status": "not_an_image"}
                    data = response.read(1024 * 1024 + 1)
                    if len(data) > 1024 * 1024:
                        return {**result, "fetch_status": "exceeds_one_megabyte"}
                    return {**result, **image_metadata(data), "fetch_status": "ok"}
            except urllib.error.HTTPError as error:
                return {**result, "fetch_status": "http_error", "http_status": error.code}
            except (OSError, urllib.error.URLError) as error:
                return {**result, "fetch_status": "network_error", "error_type": type(error).__name__}
    package_data = local / "Packages" / "5319275A.WhatsAppDesktop_cv1g1gvanyjgm"
    if parsed.scheme == "file" and parsed.netloc in ("", "localhost"):
        image = Path(unquote(parsed.path).lstrip("/"))
    elif parsed.scheme == "ms-appdata" and parsed.path.startswith("/local/"):
        image = package_data / "LocalState" / unquote(parsed.path[7:])
    elif parsed.scheme == "ms-appdata" and parsed.path.startswith("/temp/"):
        image = package_data / "TempState" / unquote(parsed.path[6:])
    elif parsed.scheme == "ms-appx" and package_root:
        image = package_root / unquote(parsed.path).lstrip("/")
    elif not parsed.scheme and Path(uri).is_absolute():
        image = Path(uri)
    else:
        return {**result, "inspection": "not_resolved_or_remote"}

    image = image.resolve()
    buckets = [("whatsapp_package_data", package_data),
               ("windows_notification_cache", local / "Microsoft" / "Windows" / "Notifications")]
    if package_root:
        buckets.append(("whatsapp_install_assets", package_root))
    bucket = next((name for name, root in buckets if image.is_relative_to(root.resolve())), None)
    if not bucket:
        return {**result, "inspection": "outside_allowed_image_roots"}
    result.update(origin_bucket=bucket, file_exists=image.is_file())
    if not image.is_file():
        return result
    length = image.stat().st_size
    result["bytes"] = length
    if length > 4 * 1024 * 1024:
        return {**result, "inspection": "image_exceeds_probe_limit"}
    return {**result, **image_metadata(image.read_bytes())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", type=Path)
    parser.add_argument("--fetch-cdn", action="store_true")
    args = parser.parse_args()
    local = Path(os.environ["LOCALAPPDATA"])
    database = local / "Microsoft" / "Windows" / "Notifications" / "wpndatabase.db"
    report = {"source": "live_read_only_sqlite_transaction", "private_text_exported": False,
              "remote_fetch_requested": args.fetch_cdn, "toast_limit": 10, "notifications": []}
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    rows = connection.execute("""SELECT n.Payload FROM Notification n
        JOIN NotificationHandler h ON h.RecordId=n.HandlerId
        WHERE h.PrimaryId LIKE ? AND n.Type='toast'
        ORDER BY n.ArrivalTime DESC LIMIT 10""", ("%WhatsApp%",)).fetchall()
    connection.rollback()
    connection.close()
    for index, (payload,) in enumerate(rows):
        record = {"sample": index + 1, "images": []}
        try:
            root = ET.fromstring(payload)
            for element in root.iter():
                if element.tag.split("}")[-1] != "image":
                    continue
                info = {"placement": element.get("placement"), "crop": element.get("hint-crop")}
                info.update(inspect_image(element.get("src", ""), local, args.package_root, args.fetch_cdn))
                record["images"].append(info)
        except (ET.ParseError, OSError, ValueError) as error:
            record["error_type"] = type(error).__name__
        report["notifications"].append(record)
    report["toast_samples"] = len(rows)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
