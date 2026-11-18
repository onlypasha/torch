import { useState } from "react";
import { whatsappInitials } from "./notifications";
import type { NotificationItem } from "./notifications";
import "./NotificationAvatar.css";

function WhatsAppMark() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 20 1-4a8 8 0 1 1 3 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="M8.2 7.5c-.8.5-.6 2.2.6 3.9 1.3 1.8 3.4 3.4 5.1 3.5 1 .1 1.6-.6 1.8-1.4l-2.4-1.2-.8 1c-1.5-.5-2.7-1.7-3.2-3.1l.8-.8-1.1-2.1c-.2-.3-.5-.2-.8.2Z" fill="currentColor" /></svg>;
}

export function NotificationAvatar({ item, compact = false }: { item: NotificationItem; compact?: boolean }) {
  const initials = whatsappInitials(item);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const photo = item.avatar && failedAvatar !== item.avatar ? item.avatar : null;
  const isWhatsApp = /whatsapp/i.test(`${item.appName} ${item.appId}`);
  const conversation = isWhatsApp && (!!initials || !!photo);
  return <span className="notification-avatar" data-conversation={conversation} data-compact={compact} aria-hidden="true">
    {conversation ? <>
      {photo ? <img className="notification-avatar-photo" src={photo} alt="" onError={() => setFailedAvatar(photo)} />
        : <span className="notification-avatar-initials">{initials ?? "?"}</span>}
      <span className="notification-avatar-badge">{item.icon ? <img src={item.icon} alt="" /> : <WhatsAppMark />}</span>
    </> : item.icon ? <img className="notification-avatar-logo" src={item.icon} alt="" /> : <svg width="56%" height="56%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3ZM10 20h4" /></svg>}
  </span>;
}
