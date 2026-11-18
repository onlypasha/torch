import type { NotificationItem } from "./notifications";
import { NotificationAvatar } from "./NotificationAvatar";
import "./CollapsedNotification.css";

export function CollapsedNotification({ item }: { item: NotificationItem }) {
  const name = item.title && item.title !== item.appName ? item.title : item.appName;
  return <div className="notch-notification-signal" role="status" aria-live="polite" aria-atomic="true" aria-label={`Notifikasi dari ${item.appName}: ${name}`}>
    <NotificationAvatar item={item} compact />
    <span className="notch-notification-summary"><strong>{name}</strong><small>{name === item.appName ? "Notifikasi baru" : item.appName}</small></span>
    <span className="notch-notification-signal-dot" aria-hidden="true" />
  </div>;
}
