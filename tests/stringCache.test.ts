import { expect, test } from "bun:test";
import { StringCache } from "../src/stringCache";

test("large image keys stay within the byte budget across many tracks", () => {
  const cache = new StringCache(16, 1024);
  for (let i = 0; i < 1000; i++) {
    cache.set(`${i}${"x".repeat(200)}`, "rgb(1 2 3)");
    expect(cache.sizeBytes).toBeLessThanOrEqual(1024);
  }
  cache.set("huge".repeat(1024), "red");
  expect(cache.get("huge".repeat(1024))).toBeUndefined();
});
test("LRU retains recent entries and replacement accounts for the old value", () => {
  const cache = new StringCache(2, 100);
  cache.set("a", null); cache.set("b", "blue");
  expect(cache.get("a")).toBeNull();
  cache.set("c", "red");
  expect(cache.get("b")).toBeUndefined();
  cache.set("a", "green");
  expect(cache.sizeBytes).toBe(20);
});
