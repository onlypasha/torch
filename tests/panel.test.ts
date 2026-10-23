import { expect, test } from "bun:test";
import { TABS, tabDirection, TAB_COUNT, tabIndex } from "../src/tabs";

test("the bar has the four tabs in fixed order, Notification shortened", () => {
  expect(TABS.map((tab) => tab.label)).toEqual(["Nook", "Tray", "Sharing", "Notif"]);
  expect(TAB_COUNT).toBe(4);
});

test("tabDirection follows the tab order", () => {
  expect(tabDirection("nook", "sharing")).toBe(1);
  expect(tabDirection("nook", "nook")).toBe(0);
  expect(tabDirection("sharing", "nook")).toBe(-1);
});

test("tabIndex answers -1 for unknown ids", () => {
  expect(tabIndex("tray")).toBe(1);
  expect(tabIndex("unknown" as never)).toBe(-1);
});
