export type TrayItem = {
  id: string;
  kind: "file" | "folder" | "link" | "text";
  name: string;
  value: string;
  extension: string;
  sizeBytes?: number | null;
  available: boolean;
  addedAtMs: number;
};
export type TraySnapshot = { items: TrayItem[]; revision: number };
export type TrayMutation = { snapshot: TraySnapshot; added: number; skipped: number };

export function trayDetail(item: TrayItem): string {
  if (!item.available) return "Tidak ditemukan";
  if (item.kind === "folder") return "Folder";
  if (item.kind === "text") return "Teks";
  if (item.kind === "link") {
    try { return new URL(item.value).hostname; } catch { return "Tautan"; }
  }
  const type = item.extension ? item.extension.toUpperCase() : "File";
  const bytes = item.sizeBytes;
  if (bytes == null) return type;
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${type} · ${size}`;
}

/** Same selection rules as Shelf: click, Ctrl-toggle and Shift range. */
export function selectTrayItem(items: readonly TrayItem[], selected: readonly string[], id: string,
  anchor: string | null, toggle: boolean, range: boolean): string[] {
  if (range && anchor) {
    const from = items.findIndex((item) => item.id === anchor);
    const to = items.findIndex((item) => item.id === id);
    if (from >= 0 && to >= 0) {
      const ids = items.slice(Math.min(from, to), Math.max(from, to) + 1).map((item) => item.id);
      return toggle ? [...new Set([...selected, ...ids])] : ids;
    }
  }
  return toggle ? selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id] : [id];
}
