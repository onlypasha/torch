import { expect, test } from "bun:test";
import { notificationAge, whatsappInitials } from "../src/notifications";

test("notification age stays legible at minute, hour and day boundaries", () => {
  const now = 1_800_000_000_000;
  expect(notificationAge(now, now)).toBe("baru");
  expect(notificationAge(now - 61_000, now)).toBe("1 mnt");
  expect(notificationAge(now - 3_660_000, now)).toBe("1 jam");
  expect(notificationAge(now - 86_400_000, now)).toBe("1 hari");
});

test("WhatsApp initials use the notification title and leave generic notifications as app icons", () => {
  const item = { id: 1, appId: "WhatsApp.WhatsApp", appName: "WhatsApp", title: "Tim Produk", body: "Budi: Revisi sudah siap", createdAtMs: 1 };
  expect(whatsappInitials(item)).toBe("TP");
  expect(whatsappInitials({ ...item, title: "Éka Putri" })).toBe("ÉP");
  expect(whatsappInitials({ ...item, title: "3 pesan baru" })).toBeNull();
  expect(whatsappInitials({ ...item, title: "WhatsApp" })).toBeNull();
  expect(whatsappInitials({ ...item, appId: "mail", appName: "Mail" })).toBeNull();
});
