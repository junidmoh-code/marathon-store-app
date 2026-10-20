// ─── THE WALL POPUP'S ALTERNATIVES STRIP — Junid's round 3, item 10 ─────────
// A suggestion, not a screen. Proves:
//   1. one sideways row of 110×88 tiles, 8px gap, snap, hidden scrollbar —
//      never wraps, never grows the popup's height — at most 18, in the
//      ranking's order (nothing re-sorted here)
//   2. every tile carries the requested-size pill and nothing else
//   3. a tile tap hands the row to the host (which swaps the popup in place)
//      and does nothing else — no in-strip overlay, no add
//   4. the host wiring in App.jsx: the strip sits INSIDE the normal popup,
//      under the size pills; the swap remembers the shoe for "← back to …";
//      no full-screen alternatives view remains
//   5. an empty answer says so; a null answer draws nothing; the quiet line
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("../../offline/MirroredImg.jsx", () => ({
  MirroredImg: ({ productId, src, ...rest }) => <img src={src} data-mirrored={productId} {...rest} />,
}));
vi.mock("../stock/locations", () => ({ labelFor: (id) => id }));

const { default: WallAlternatives, quietBlockLine, ALT_PANEL_MAX } = await import("./WallAlternatives.jsx");
const SRC = readFileSync(new URL("./WallAlternatives.jsx", import.meta.url), "utf8");
const WALL = readFileSync(new URL("./SneakerWall.jsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

const shoe = (i) => ({ id: `p${i}`, name: `Shoe ${i}`, retailPrice: 900 + i, sizes: ["6", "7", "8"], photoUrl: `https://x/${i}.jpg` });
const rows = (n) => Array.from({ length: n }, (_, i) => ({ product: shoe(i), matchedSize: "7", hasRequestedSize: true, sizes: ["6", "7", "8"], why: "Same model", tier: "a" }));
const textIn = (n) => (typeof n === "string" ? n : (n.children || []).map(textIn).join(""));

function mount(props) {
  let tr;
  act(() => { tr = TestRenderer.create(<WallAlternatives requestedSize="7" {...props} />); });
  return tr;
}
const tiles = (tr) => tr.root.findAll(n => n.type === "button" && n.props.className === "alt-tile");

describe("the strip", () => {
  it("is one sideways row of 110×88 tiles — snap, no scrollbar, never wraps or grows tall", () => {
    expect(SRC).toMatch(/\.alt-row\{display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none/);
    expect(SRC).toContain(".alt-row::-webkit-scrollbar{display:none}");
    expect(SRC).not.toMatch(/\.alt-row\{[^}]*flex-wrap/);
    expect(SRC).toMatch(/\.alt-tile\{[^}]*flex:0 0 110px;width:110px;height:88px;scroll-snap-align:start/);
    expect(110 / 88).toBe(5 / 4);
  });
  it("draws at most 18, in the ranking's order", () => {
    const tr = mount({ rows: rows(25) });
    expect(ALT_PANEL_MAX).toBe(18);
    expect(tiles(tr).map(t => t.props["aria-label"].split(",")[0])).toEqual(rows(18).map(r => r.product.name));
  });
  it("every tile carries the requested-size pill and nothing else", () => {
    const tr = mount({ rows: rows(5) });
    expect(tiles(tr)).toHaveLength(5);
    for (const t of tiles(tr)) {
      expect(textIn(t.find(n => n.props.className === "alt-sz"))).toBe("7");
      expect(textIn(t)).toBe("7");
      expect(t.findAll(n => n.type === "button" && n !== t)).toHaveLength(0);
    }
  });
  it("tiles draw the full-resolution photo, like the wall", () => {
    const tr = mount({ rows: rows(2) });
    const img = tiles(tr)[1].find(n => n.type === "img");
    expect(img.props.src).toBe("https://x/1.jpg");
    expect(img.props["data-mirrored"]).toBeUndefined();
  });
  it("null draws nothing; [] says nothing in that size is available", () => {
    expect(tiles(mount({ rows: null }))).toHaveLength(0);
    const tr = mount({ rows: [] });
    expect(textIn(tr.root.find(n => n.props.className === "alt-none"))).toContain("Nothing in size 7 is available");
  });
  it("logs shown once per size", () => {
    const onShown = vi.fn();
    const tr = mount({ rows: rows(3), onShown });
    act(() => { tr.update(<WallAlternatives requestedSize="7" rows={rows(4)} onShown={onShown} />); });
    expect(onShown).toHaveBeenCalledTimes(1);
  });
});

describe("hidden under Display Partner", () => {
  it("stays mounted and does not log shown again when it reappears", () => {
    const onShown = vi.fn();
    let tr;
    act(() => { tr = TestRenderer.create(<WallAlternatives requestedSize="7" rows={rows(3)} onShown={onShown} />); });
    act(() => { tr.update(<WallAlternatives requestedSize="7" rows={rows(3)} onShown={onShown} hidden />); });
    expect(tr.root.find(n => n.props["data-testid"] === "alt-strip").props.hidden).toBe(true);
    act(() => { tr.update(<WallAlternatives requestedSize="7" rows={rows(3)} onShown={onShown} />); });
    expect(onShown).toHaveBeenCalledTimes(1);
  });
});

describe("a tile tap", () => {
  it("hands that row to the host and nothing else", () => {
    const onPicked = vi.fn();
    const tr = mount({ rows: rows(4), onPicked });
    act(() => { tiles(tr)[2].props.onClick(); });
    expect(onPicked).toHaveBeenCalledTimes(1);
    expect(onPicked.mock.calls[0][0].product.id).toBe("p2");
    // No overlay, no Back, no size pills inside the strip — the popup is it.
    expect(tiles(tr)).toHaveLength(4);
    expect(tr.root.findAll(n => n.type === "button" && n.props.className !== "alt-tile")).toHaveLength(0);
  });
});

describe("the popup hosts it (App.jsx)", () => {
  it("sits inside the normal popup, directly under the size pills", () => {
    const pills = APP.indexOf('<div className="ad-svsz"');
    const strip = APP.indexOf("<WallAlternatives key={`${qv.id}|${qvNa.size}`}");
    const dp = APP.indexOf("Display Partner (optional)", pills);
    expect(pills).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(pills);
    expect(dp).toBeGreaterThan(strip);
    // Raised by the ✕ tap's note state, lifted by Display Partner.
    expect(APP).toContain("{wall && qvNa?.snk && !clothingOrder && !deadForOrder(qv) && (() => {");
    // Display Partner hides it without a remount (a remount re-logs "shown").
    expect(APP).toContain("<WallAlternatives key={`${qv.id}|${qvNa.size}`} hidden={qvDP}");
  });
  it("the popup keeps one size: no wide alternatives mode, max-height 85vh", () => {
    expect(APP).not.toContain("ad-sv--alt");
    expect(APP).not.toContain("altMode");
    expect(WALL).not.toContain("ad-sv--alt");
    expect(APP).toContain('<div className="ad-sv" {...(wall ? { role: "dialog", "aria-modal": "true", "aria-label": qv.name, onKeyDown: trapQvTab } : {})}>');
    expect(APP).toMatch(/\.ad-sv\{width:min\(820px,100%\);/);
    // Measured in Chrome before this rule: the 18 tiles sized the text column
    // to 2116px and squeezed the photo. minmax(0,…) keeps the row scrolling.
    expect(WALL).toContain(".ad-root--wall .ad-sv{max-height:85vh;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}");
    expect(WALL).toContain(".ad-root--wall .ad-svbody,.ad-root--wall .ad-svbody>div{min-width:0}");
  });
  it("a pick swaps the popup in place and remembers the shoe for the back link", () => {
    expect(APP).toContain('onPicked={(row) => { if (!alternativeSelection(row, qvNa.size)) return; onAlternativePicked?.("wall", qv, qvNa.size, row); pickWallAlternative(row, qvNa.size); }}');
    const i = APP.indexOf("const pickWallAlternative = (row, size) => {");
    const body = APP.slice(i, APP.indexOf("\n  };", i));
    expect(body).toContain("const from = { p: qv, size };");
    expect(body).toContain("pickQvAlternative(row, size);");
    expect(body).toContain("setQvFrom(from);");
    expect(APP).toContain('<button type="button" className="ad-svback" onClick={backToQvFrom}>← back to {qvFrom.p.name}</button>');
    // Back reopens the shoe on the same ✕ size, so its strip returns.
    const j = APP.indexOf("const backToQvFrom = () => {");
    const back = APP.slice(j, APP.indexOf("\n  };", j));
    expect(back).toContain("openQv(f.p);");
    expect(back).toContain("setQvNa({ size: f.size, left: 0, snk: true });");
    // Every open and every close drops the back link.
    expect(APP).toContain("useEffect(() => { if (!qv) setQvFrom(null); }, [qv]);");
    expect(APP).toMatch(/const openQv = \(p\) => \{\n\s+setQvFrom\(null\);/);
  });
});

describe("the quiet line", () => {
  it("is the short form of the refusal", () => {
    expect(quietBlockLine("11", { booked: 0, checkedBoth: true })).toBe("Size 11 not at Hub 1 or Hub 2 — these have it:");
    expect(quietBlockLine("7", { booked: 0, hubLabel: "Hub 2" })).toBe("Size 7 not at Hub 2 — these have it:");
    expect(quietBlockLine("7", { booked: 1, available: 0, hubLabel: "Hub 1" })).toContain("held for another customer's order");
    expect(quietBlockLine("7", null, false)).toContain("can be ordered again");
  });
});
