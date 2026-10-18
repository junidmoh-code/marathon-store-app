// Pins the TV screen's wiring inside the App.jsx monolith (whose views can't
// be imported in isolation):
//  1. the #tv kiosk shell subscribes through useTvOrders — the orderByKey
//     range that excludes refill carts server-side (measured: 2,150 KB →
//     465 KB per sync, 2026-08-13) — NOT the full-node useOrders;
//  2. useTvOrders really queries by key with the shared range constants;
//  3. both TV mounts hand the live specials to the board, and the board
//     draws the specials rail only when specials exist.
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

test("useTvOrders bounds /orders by the shared range, on BOTH of its sources", () => {
  // The hook now has two sources — the offline mirror's local copy and the
  // live key range — and the bound has to be the same on both or the kiosk
  // shows a different set of orders depending on which one answered. The
  // mirrored path applies the SAME TV_ORDER_KEY_START/END constants by string
  // comparison, which is what the server query does.
  const hook = app.match(/function useTvOrders\(\) \{[\s\S]{0,3000}?\n\}/);
  expect(hook, "useTvOrders should exist").toBeTruthy();
  // The live path, unchanged.
  expect(hook[0]).toContain('ref(database, "orders")');
  expect(hook[0]).toContain("orderByKey()");
  expect(hook[0]).toContain("startAt(TV_ORDER_KEY_START)");
  expect(hook[0]).toContain("endAt(TV_ORDER_KEY_END)");
  // The mirrored path, bounded by the same two constants and nothing else.
  expect(hook[0]).toContain("key >= TV_ORDER_KEY_START && key <= TV_ORDER_KEY_END");
  // And both end in the SAME shaping function — defined once, called from
  // each path — so the rows the kiosk renders cannot differ by source.
  expect(hook[0]).toContain("const shapeTvOrders = useCallback(");
  expect((hook[0].match(/shapeTvOrders\(/g) || []).length).toBe(2);
});

test("TvWithAutoCollect passes live specials into the board", () => {
  expect(app).toContain("const specials = useSpecials();");
  expect(app).toMatch(/<TvDisplayMockup orders=\{filteredOrders\} specials=\{specials\}/);
});

test("the board draws the specials rail only when specials exist", () => {
  // The queue-board redesign dropped the decorative shoe conveyor: with no
  // specials the floor band under the board is simply empty.
  expect(tv).toContain("const hasSpecials = !!(specials && specials.length > 0);");
  expect(tv).toMatch(/\{hasSpecials && \([\s\S]{0,200}<TvSpecialsRail specials=\{specials\} \/>/);
});

// The TV component never reloads its own page. It used to poll index.html and
// reload on every deploy, and each reload re-locked the browser's audio — the
// daytime voice drop-off. (updateChecker.tv.test.js covers the global checker.)
test("TvWithAutoCollect has no reload path", () => {
  const start = app.indexOf("function TvWithAutoCollect(");
  const end = app.indexOf("\nfunction TvOnlyShell(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = app.slice(start, end);
  expect(body).not.toMatch(/location\.reload\s*\(/);
  expect(body).not.toMatch(/location\.(replace|assign)\s*\(/);
  expect(body).not.toMatch(/location\.href\s*=/);
  // And the TV shells mount nothing that would.
  const shells = app.slice(end, app.indexOf("export default function App()", end));
  expect(shells).not.toMatch(/location\.reload\s*\(/);
});

test("the voice unlock is the keeper's, and the old full-width tap button is gone", () => {
  expect(app).toContain("createVoiceKeeper({");
  // Started on mount and stopped on unmount — a keeper that is built but never
  // started arms nothing and listens for nothing.
  expect(app).toMatch(/keeperRef\.current = keeper;\s*keeper\.start\(\);\s*return \(\) => \{ keeper\.stop\(\);/);
  // Announcements go through it (resume + retry + stuck-queue guard).
  expect(app).toContain("keeper.whenRunning(() => {");
  expect(app).toContain("keeper.guardStart({");
  expect(app).toContain("shouldShowVoiceHint({ kiosk, state: voiceState })");
  expect(app).not.toContain("Tap once to enable pickup voice");
});
