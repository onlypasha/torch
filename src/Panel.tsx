import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Variants } from "framer-motion";
import { TAB_PILL_SPRING, TAB_SLIDE_PX, TAB_SWITCH_MS, TABS, tabDirection } from "./tabs";
import type { TabId } from "./tabs";
import { Nook } from "./NookTab";
import type { NookModel } from "./useNook";
import { TrayTab } from "./TrayTab";
import type { TrayModel } from "./useTray";
import { SharingTab } from "./SharingTab";
import type { SharingModel } from "./useSharing";
import { NotificationTab } from "./NotificationTab";
import { runtimeConfig } from "./config";
import type { NotificationModel } from "./useNotifications";

/**
 * The open panel's body: four tabs with retained models.
 *
 * The notch never steals focus from other applications (WS_EX_NOACTIVATE), so
 * the bar only reads a keyboard when the panel itself is focused; Arrow keys
 * switch tabs there, the way a roving tablist does, besides the mouse.
 */

/** 16px glyph per tab, drawn inline so the pill's colours carry over. */
function TabIcon({ tab, size }: { tab: TabId; size: number }) {
  const paths: Record<TabId, ReactNode> = {
    // Nook: a shelf.
    nook: <path d="m2.5 5.5 5.5-4 5.5 4V6.5H2.5ZM3.5 6.5v7.5h2V9h2v5h5V6.5" />,
    // Tray: an open folder.
    tray: <path d="M2 3.5h4l1.5 2H14v7.5H2Z" />,
    // Sharing: three dots linked by two lines.
    sharing: (
      <>
        <circle cx="4.5" cy="8" r="1.6" />
        <circle cx="11" cy="3.6" r="1.6" />
        <circle cx="11" cy="12.4" r="1.6" />
        <path d="M5.9 7.2 9.6 4.4M5.9 8.8l3.7 2.8" />
      </>
    ),
    // Notification: a bell.
    notification: <path d="M8 2a4 4 0 0 1 4 4v2.5l1.2 2.2a.6.6 0 0 1-.53.9H9.9a2 2 0 0 1-3.8 0H4.33a.6.6 0 0 1-.53-.9L5 8.5V6a4 4 0 0 1 4-4Z" />,
  };
  return (
    <svg
      className="notch-tab-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[tab]}
    </svg>
  );
}

const TAB_SWITCH: Variants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: TAB_SLIDE_PX * direction,
    filter: "blur(6px)",
  }),
  center: {
    opacity: 1,
    x: 0,
    filter: "blur(0px)",
    transition: { duration: TAB_SWITCH_MS, ease: "easeOut" },
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: -TAB_SLIDE_PX * direction,
    filter: "blur(6px)",
    transition: { duration: TAB_SWITCH_MS, ease: "easeOut" },
  }),
};

export function Panel({ active, onTab, nook, tray, sharing, notifications }: {
  active: TabId;
  onTab: (tab: TabId) => void;
  nook: NookModel;
  tray: TrayModel;
  sharing: SharingModel;
  notifications: NotificationModel;
}) {
  const tabs = TABS.filter(({id}) => id === "nook" || (id === "notification" ? runtimeConfig.features.notifications : runtimeConfig.features[id]));
  const [direction, setDirection] = useState(0);

  // Roving focus: arrows move selection, and the newly active tab receives the
  // focus so the next Tab press travels from its place in the bar.
  const buttons = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    buttons.current[active]?.focus({ preventScroll: true });
  }, [active]);

  const switchTab = (to: TabId) => {
    if (to === active) return;
    setDirection(tabDirection(active, to));
    onTab(to);
  };

  const onTablistKeyDown = (event: React.KeyboardEvent) => {
    const at = tabs.findIndex((tab) => tab.id === active);
    if (event.key === "ArrowRight" && at < tabs.length - 1) {
      event.preventDefault();
      switchTab(tabs[at + 1].id);
    } else if (event.key === "ArrowLeft" && at > 0) {
      event.preventDefault();
      switchTab(tabs[at - 1].id);
    }
  };

  const tab = tabs.find(({ id }) => id === active) ?? tabs[0];

  return (
    <>
      <div role="tablist" aria-label="Panel notch" className="notch-tabbar" onKeyDown={onTablistKeyDown}>
        {tabs.map(({ id, label }) => (
          <motion.button
            key={id}
            ref={(node) => { buttons.current[id] = node; }}
            type="button"
            whileTap={{ scale: 0.97 }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => switchTab(id)}
            role="tab"
            aria-selected={active === id}
            aria-controls={`notch-panel-${id}`}
            id={`notch-tab-${id}`}
            tabIndex={active === id ? 0 : -1}
            data-tab-id={id}
            className="notch-tab"
            aria-label={id === "notification" && notifications.items.length ? `${label}, ${notifications.items.length} notifikasi` : label}
            title={label}
          >
            {/* One shared pill slides under the icon of whichever tab is on
                top; it is rendered by the single active button and layout took
                care of the flight between buttons. */}
            {active === id && (
              <motion.span
                layoutId="notch-tab-pill"
                className="notch-tab-pill"
                transition={TAB_PILL_SPRING}
              />
            )}
            <TabIcon tab={id} size={15} />
            {id === "notification" && notifications.items.length > 0 && <span className="notch-tab-badge" aria-label={`${notifications.items.length} notifikasi`}>{notifications.items.length > 9 ? "9+" : notifications.items.length}</span>}
          </motion.button>
        ))}
      </div>
      {/* Content area fixed to the spec's height: the notch cannot scroll, so
          each tab is built to fit - the empty ones are placeholders. */}
      <div className="notch-tab-content">
        <AnimatePresence mode="wait" custom={direction} initial={false}>
          <motion.div
            key={tab.id}
            role="tabpanel"
            id={`notch-panel-${tab.id}`}
            aria-labelledby={`notch-tab-${tab.id}`}
            custom={direction}
            variants={TAB_SWITCH}
            initial="enter"
            animate="center"
            exit="exit"
            data-tab-id={tab.id}
            className="notch-tab-panel"
          >
            {tab.id === "nook" ? (
              <Nook nook={nook} />
            ) : tab.id === "tray" ? (
              <TrayTab tray={tray} onShare={runtimeConfig.features.sharing ? (ids) => { sharing.selectTrayFiles(ids); switchTab("sharing"); } : undefined} sharingBusy={sharing.busy} />
            ) : tab.id === "sharing" ? (
              <SharingTab sharing={sharing} tray={tray} onOpenTray={() => switchTab("tray")} />
            ) : tab.id === "notification" ? (
              <NotificationTab notifications={notifications} />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </>
  );
}
