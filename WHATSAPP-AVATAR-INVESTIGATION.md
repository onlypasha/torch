# WhatsApp notification avatar investigation

Date: 2026-10-30. This investigation reads shipped code and live notification
metadata. The later implementation is described below.

## Conclusion

The image used by a WhatsApp notification can be recovered on this machine.
Two current WhatsApp toast payloads contain a circular `appLogoOverride` image.
Both HTTPS image sources returned HTTP 200 without cookies. One is a static
WhatsApp WEBP asset; the other is a JPEG thumbnail of 96×96 pixels from the
WhatsApp media CDN. The specific contact/group identity was not inspected or
exported, so this does not establish coverage of every private/group message.

The missing data is the image source in the toast XML, which
`UserNotificationListener` does not expose. A separate, optional payload-image
resolver now supplies photos to the notification UI.

## Evidence

Installed package: `5319275A.WhatsAppDesktop`, version `2.2641.101.0`.
Entry point: `WhatsApp.Root.exe`; managed assembly: `WhatsApp.Root.dll`.
Assembly SHA-256:
`4dccec9b59081070a9f8ebb8c6fd2efae15417b244bf3861ff195e6e0d6e26ee`.

1. ILSpy inspection of the installed assembly identified
   `WhatsApp.SystemIntegrations.MessageNotification`. Its record contains
   `ThumbnailPath` alongside header/body and other notification fields.
2. `NotificationsManager.CreateToastContent(MessageNotification)` assigns
   `messageNotification.ThumbnailPath` to
   `ToastVisual.BindingGeneric.AppLogoOverride.Source` and sets circular crop.
   `ShowMessageNotification` passes the generated XML to Windows'
   `AppNotificationManager.Show`.
3. Read-only SQLite queries found `NotificationHandler` and `Notification`
   tables in `%LOCALAPPDATA%/Microsoft/Windows/Notifications/wpndatabase.db`.
   The latter stores `Id`, `HandlerId`, `Payload`, `ArrivalTime`, and type.
   Joining only handlers containing `WhatsApp` found toast XML with image
   placement `appLogoOverride`, crop `circle`, and HTTPS sources.
4. The last probe inspected two toasts in a read-only SQLite transaction. It
   closed that transaction before networking. Image metadata:

| Source host | HTTP | Format | Bytes | Dimensions |
| --- | --- | --- | --- | --- |
| `static.whatsapp.net` | 200 | WEBP | 554 | Not decoded by probe |
| `media-cgk2-2.cdn.whatsapp.net` | 200 | JPEG | 2062 | 96×96 |

The static asset is not established as a personalized avatar. The media JPEG
is confirmed as the image referenced by that toast, not merely a guessed URL
or an unrelated cached file. Its visual identity was not verified.

No message body, sender name, signed URL, query token, or photo was saved to
the repository or printed. Downloaded image bytes existed only in memory.
No WhatsApp process was launched, no notification was dismissed, and the
notification database was not modified. REA MCP tools were unavailable;
`rea doctor` reported a missing Codex registration. No registration was changed.
The evidence above comes from installed ILSpy, SQLite and the Python probe,
not from a REA Evidence ledger.

## Reproduction

`scripts/probe_whatsapp_notification_images.py` queries only WhatsApp toast
payloads, limits samples to ten, and outputs sanitized image metadata.
Running it without flags does not contact image hosts. `--fetch-cdn` permits
HTTPS requests only to `static.whatsapp.net` or `*.cdn.whatsapp.net`, without
cookies, proxies, redirects or authentication prompts. Reads are bounded to
one MiB with a five-second network timeout. Full URLs are never printed.
`--package-root` optionally resolves images in a known installed package.

## Implemented integration

- `UserNotificationListener` remains the authority for permission and the
  active inbox. `notification_avatar.rs` reads the WPN SQLite database only
  for a current WhatsApp notification, matching ID, exact app identity and
  arrival time. A live read-only comparison confirmed an SDK toast ID and
  timestamp matched the database row exactly.
- The resolver extracts only `appLogoOverride`, accepts HTTPS image sources
  from WhatsApp's static/media CDN hosts, disables redirects and proxies,
  limits requests to five seconds and images to one MiB, and validates PNG,
  JPEG or WebP bytes before returning a data URL. Signed source URLs remain
  inside the native process.
- Up to four image lookups run behind the listener. Only the newest sixteen
  WhatsApp toasts are candidates. Cache entries are in memory and removed when
  their notification disappears or permission is revoked. Delayed results are
  checked against the same active ID, app and timestamp before publishing.
- The shared avatar component renders the photo in the tab, expanded
  interruption and collapsed notch. The WhatsApp app icon remains a small
  badge; initials remain the fallback. Updating an active photo does not
  restart its lifetime timer.

The Windows WPN database is an internal format. Database contention, schema
changes, missing or expired image URLs, and offline use leave the notification
available with initials. An incoming WhatsApp test toast passed the native
read-only probe: ID/app/time matched, `appLogoOverride` was present, and the
resolver fetched a validated image. The test did not reveal whether it was a
private or group chat; both should still be checked for coverage.

Microsoft documents the [toast image schema](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-image)
and [app-logo override](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.windows.appnotifications.builder.appnotificationbuilder.setapplogooverride?view=windows-app-sdk-1.8).
The [notification listener guide](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)
describes the supported text and application-logo access used by the current
backend; it does not document reading WPN's internal SQLite storage.
