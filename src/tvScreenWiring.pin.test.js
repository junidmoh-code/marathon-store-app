// Pins the TV screen's wiring inside the App.jsx monolith (whose views can't
// be imported in isolation):
//  1. the #tv kiosk shell subscribes through useTvOrders — the orderByKey
//     range that excludes refill carts server-side (measured: 2,150 KB →
//     465 KB per sync, 2026-08-13) — NOT the full-node useOrders;
//  2. useTvOrders really queries by key with the shared range constants;
//  3. both TV mounts hand the live specials to the board, and the board
//     gives the specials rail the conveyor's band only when specials exist.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const tv = readFileSync(new URL("./components/TvDisplayMockup.jsx", import.meta.url), "utf8");

test("TvOnlyShell subscribes via the key-ranged useTvOrders, not useOrders", () => {
  const shell = app.match(/function TvOnlyShell\(\) \{[\s\S]{0,300}?\n\}/);
  expect(shell, "TvOnlyShell should exist").toBeTruthy();
  expect(shell[0]).toContain("useTvOrders()");
  expect(shell[0]).not.toMatch(/\buseOrders\(/);
});

test("useTvOrders queries /orders by key with the shared range bounds", () => {
  const hook = app.match(/function useTvOrders\(\) \{[\s\S]{0,1200}?\n\}/);
  expect(hook, "useTvOrders should exist").toBeTruthy();
  expect(hook[0]).toContain('ref(database, "orders")');
  expect(hook[0]).toContain("orderByKey()");
  expect(hook[0]).toContain("startAt(TV_ORDER_KEY_START)");
  expect(hook[0]).toContain("endAt(TV_ORDER_KEY_END)");
});

test("TvWithAutoCollect passes live specials into the board", () => {
  expect(app).toContain("const specials = useSpecials();");
  expect(app).toMatch(/<TvDisplayMockup orders=\{filteredOrders\} specials=\{specials\}/);
});

test("the board hands the conveyor band to the specials rail only when specials exist", () => {
  expect(tv).toMatch(/\{\(specials && specials\.length > 0\)\s*\?\s*<TvSpecialsRail specials=\{specials\}/);
  // Empty state: the long-standing conveyor/spacer fallback must survive.
  expect(tv).toContain("<ShoeConveyor wcSkin={wcSkin} />");
});
