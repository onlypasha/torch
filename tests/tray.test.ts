import { expect, test } from "bun:test";
import { selectTrayItem, trayDetail } from "../src/tray";
import type { TrayItem } from "../src/tray";
const items: TrayItem[] = ["a", "b", "c", "d"].map((id) => ({ id, name: id, kind: "file",
  value: `C:\\${id}.pdf`, extension: "pdf", sizeBytes: 2048, available: true, addedAtMs: 0 }));
test("Tray selection toggles and ranges in shelf order", () => {
  expect(selectTrayItem(items, ["a"], "c", "a", false, true)).toEqual(["a", "b", "c"]);
  expect(selectTrayItem(items, ["d"], "a", "c", true, true)).toEqual(["d", "a", "b", "c"]);
  expect(selectTrayItem(items, ["a", "b"], "b", "a", true, false)).toEqual(["a"]);
  expect(selectTrayItem(items, ["a"], "d", "a", false, false)).toEqual(["d"]);
  expect(selectTrayItem(items, ["a"], "c", "missing", false, true)).toEqual(["c"]);
});
test("Tray details distinguish unavailable paths, links, folders and file sizes", () => {
  expect(trayDetail(items[0])).toBe("PDF · 2 KB");
  expect(trayDetail({ ...items[0], available: false })).toBe("Tidak ditemukan");
  expect(trayDetail({ ...items[0], kind: "folder" })).toBe("Folder");
  expect(trayDetail({ ...items[0], kind: "link", value: "https://example.com/path" })).toBe("example.com");
  expect(trayDetail({ ...items[0], sizeBytes: 1048576 })).toBe("PDF · 1.0 MB");
});
