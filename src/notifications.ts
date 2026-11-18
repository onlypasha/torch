export type NotificationItem = {
  id: number; appId: string; appName: string; title: string; body: string;
  createdAtMs: number; icon?: string | null; avatar?: string | null;
};
export type NotificationSnapshot = {
  revision: number; access: "unknown" | "allowed" | "denied" | "unsupported" | "error";
  message: string; items: NotificationItem[]; updatedAtMs: number;
};
export const INITIAL_NOTIFICATIONS: NotificationSnapshot = {
  revision: -1, access: "unknown", message: "", items: [], updatedAtMs: 0,
};
export function whatsappInitials(item: NotificationItem): string | null {
  if (!/whatsapp/i.test(`${item.appName} ${item.appId}`)) return null;
  const name = item.title.trim();
  if (!name || /^whatsapp(?:\s+(?:beta|business))?$/i.test(name)
    || /^(?:\d+\s+)?(?:pesan|messages?|notifikasi|notifications?)\b|^new messages?\b/i.test(name)) return null;
  const words = name.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu);
  if (!words?.length) return null;
  const selected = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return selected.map((word) => word.match(/^[\p{L}\p{N}]\p{M}*/u)![0]).join("").toLocaleUpperCase();
}
export function notificationAge(createdAtMs: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - createdAtMs) / 60000));
  if (minutes < 1) return "baru";
  if (minutes < 60) return `${minutes} mnt`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} jam` : `${Math.floor(hours / 24)} hari`;
}
