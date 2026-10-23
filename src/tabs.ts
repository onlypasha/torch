/**
 * The four tabs, in their fixed left-to-right order; the direction of every
 * panel transition (see `Panel.tsx`) is a sign of index differences against
 * this order, so the string of the list is the only geometry the switch knows.
 */
export const TABS = [
  { id: "nook", label: "Nook" },
  { id: "tray", label: "Tray" },
  { id: "sharing", label: "Sharing" },
  { id: "notification", label: "Notif" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export const TAB_COUNT = TABS.length;

/** Index in the fixed order, or -1 when the id is unknown. */
export const tabIndex = (id: TabId): number => TABS.findIndex((tab) => tab.id === id);

/**
 * Which side the switching content comes from: moving right enters from the
 * right (+1), moving left from the left (-1), and staying put doesn't move at
 * all (0).
 */
export const tabDirection = (from: TabId, to: TabId): number =>
  Math.sign(tabIndex(to) - tabIndex(from));

/** The active pill's spring, shared with nothing else in the notch. */
export const TAB_PILL_SPRING = { type: "spring", stiffness: 500, damping: 34 } as const;

/** One tab switch: 28px of sideways travel with the blur, 200ms, easeOut. */
export const TAB_SWITCH_MS = 0.2;
export const TAB_SLIDE_PX = 28;
