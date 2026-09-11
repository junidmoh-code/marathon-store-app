// ─── THE ARMING TAB — FOUR TABS, AND EDITING ON THE SPOT ─────────────────────
//
// Four exclusive tabs whose counts add up, a list that is COMPLETE on first
// paint (the residue settles itself rather than waiting for a button), badges
// for the facts that are not a place, and a row that opens the Seating tab's
// own rows and actions inline.
//
// THE READS ARE PART OF THE BEHAVIOUR. Every path the tab asks for is recorded,
// so a read it must never make is an assertion and not a comment.
//
// Run: npx vitest run src/components/stock/armingTab.render.test.jsx

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  confirm: () => false,
  requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

const callableMock = vi.fn(async () => ({ data: { categories: [], destinations: [], history: [], cap: 75 } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callableMock(...a) }));
vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true }, auth: { currentUser: { uid: "u1" } } }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));

// ── THE DATABASE DOUBLE ──────────────────────────────────────────────────────
// RTDB HAS NO EMPTY CHILDREN, at any depth, and cannot store an empty array. A
// fake that kept `{ p1: {} }` would let a test pass over a shape the database
// cannot produce, so the write prunes recursively.
const NODES = {};
function prune(value) {
  if (value == null) return undefined;
  if (typeof value !== "object") return value;
  const out = Array.isArray(value) ? [] : {};
  let kept = 0;
  for (const k of Object.keys(value)) {
    const v = prune(value[k]);
    if (v === undefined) continue;
    out[k] = v; kept += 1;
  }
  return kept ? out : undefined;
}
function setNode(path, value) {
  const p = prune(value);
  if (p === undefined) delete NODES[path]; else NODES[path] = p;
}
// The per-(location, product) reads resolve against the same store, so a node
// written at `stock/hub1` answers a read of `stock/hub1/p1` too. Without this
// the settle pass would see nothing and every test of it would be vacuous.
function readNode(path) {
  if (Object.prototype.hasOwnProperty.call(NODES, path)) return NODES[path];
  const parts = String(path).split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join("/");
    if (!Object.prototype.hasOwnProperty.call(NODES, head)) continue;
    let v = NODES[head];
    for (const k of parts.slice(i)) { v = v?.[k]; if (v == null) return null; }
    return v;
  }
  return null;
}

// A WRITE would land here. Read-only-until-you-act is asserted at the database.
const updateMock = vi.fn(async () => {});
const pushMock = vi.fn(() => ({ key: "mv1" }));

const READS = [];
// While HOLD_PRODUCT_READS is on, the per-(location, product) reads never settle
// until RELEASE() — the shape needed to land a Refresh mid-settle.
let HOLD_PRODUCT_READS = false;
const HELD = [];
const RELEASE = () => { const q = HELD.splice(0); for (const f of q) f(); };

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    READS.push(String(r.path));
    // A read loop must end in a clean failure, not a killed worker.
    if (READS.length > 6000) return new Promise(() => {});
    const v = readNode(String(r.path));
    const snap = { exists: () => v != null, val: () => v };
    if (HOLD_PRODUCT_READS && String(r.path).split("/").length === 3) {
      return new Promise((res) => HELD.push(() => res(snap)));
    }
    return snap;
  },
  onValue: () => () => {},
  update: (...a) => updateMock(...a),
  push: (...a) => pushMock(...a),
  child: () => ({}),
}));

// MUTABLE, and a FRESH OBJECT every render — exactly as usePath does. A static
// mock leaves the whole registry-invalidation path untestable.
let LOCATIONS = {};
const BASE_LOCATIONS = {
  hub1: { id: "hub1", label: "Hub 1", kind: "warehouse", active: true },
  hub2: { id: "hub2", label: "Hub 2", kind: "warehouse", active: true },
  central: { id: "central", label: "Central", kind: "warehouse", active: true },
  trophy: { id: "trophy", label: "Trophy", kind: "store", sellable: true, active: true },
};
let CONFIG_STATE = { value: null, settled: false, error: false };

vi.mock("./useStock", () => ({
  useLocations: () => ({ ...LOCATIONS }),
  useEngineConfig: () => CONFIG_STATE.value,
  useEngineConfigState: () => CONFIG_STATE,
}));

// sneakers is per-size and carriedOnly at BOTH hubs — the live shape, and the
// one that produced the 34 both-hub rows this tab was built to surface.
const leg = (carriedOnly) => ({
  ...(carriedOnly ? { carriedOnly: true } : {}),
  sizes: { 8: { target: 2, minQty: 1 }, 9: { target: 2, minQty: 1 } },
});
const CONFIG = {
  ruleBasedTargets: true,
  categoryPolicy: {
    sneakers: { perSize: true, hub1: leg(true), hub2: leg(true) },
    // Unscoped: arms a hub whether or not it holds a cell — the NOT_SEATED flag.
    bags: { hub2: { target: 4, minQty: 2 } },
  },
};

const ArmingMod = await import("./ArmingTab.jsx");
const ArmingTab = ArmingMod.default;
const { ArmRow, ProductSeating, mergeStock, mb } = ArmingMod;
const { SeatRow } = await import("./SeatingTab.jsx");
const EnginePolicyCard = (await import("./EnginePolicyCard.jsx")).default;

const cell = (qty) => ({ qty, v: 1, lastType: "received", updatedAt: "2026-09-01T00:00:00.000Z" });

const PRODUCTS = [
  { id: "p1", name: "Both Hubs Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/p1.jpg" },
  { id: "p2", name: "Hub One Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"] },
  { id: "p3", name: "Hub Two Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"] },
  { id: "p4", name: "Unseated Bag", category: "Bags", categoryKey: "bags", sizes: [] },
  // Carried at Hub 1 with empty cells; its units live at CENTRAL, so the
  // dead-size rule cannot be settled from the two hubs alone. It belongs in
  // Hub 1 and only the settle pass can put it there.
  { id: "p5", name: "Elsewhere Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"] },
  { id: "p6", name: "Retired Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"],
    deactivated: { at: 1757000000000, by: "u1" } },
  // Carried at Hub 1, empty everywhere. Unarmed even after every location is
  // read — so the resolved set is the only thing that decides it.
  { id: "p7", name: "Nowhere Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"] },
];

const OWNER = { email: "gunidmoh@gmail.com" };
const STAFF = { email: "rashid@marathon.internal" };

function seed() {
  for (const k of Object.keys(NODES)) delete NODES[k];
  setNode("stock/hub1", {
    p1: { 8: cell(3) },
    p2: { 8: cell(1) },
    p3: { 8: cell(0), 9: cell(0) },      // carried, empty — the policy would arm it
    p5: { 8: cell(0), 9: cell(0) },      // units are at Central
    p6: { 8: cell(4) },                  // deactivated: armed nowhere
    p7: { 8: cell(0), 9: cell(0) },      // empty everywhere
  });
  setNode("stock/hub2", { p1: { 9: cell(2) }, p3: { 9: cell(5) } });
  // A hand-written target:0 pair at Hub 1 over a policy that would arm — the
  // SUPPRESSED flag. Size 9 is alive at Hub 2, so the dead-size rule is not
  // what is answering.
  setNode("stock_targets/hub1", {
    p3: { 8: { target: 0, minQty: 0, source: "seating_off" }, 9: { target: 0, minQty: 0, source: "seating_off" } },
  });
  setNode("stock/central", { p5: { 8: cell(4) } });
}

const text = (tree) => JSON.stringify(tree.toJSON());
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");
function label(node) {
  const out = [];
  const walk = (c) => {
    if (c == null || typeof c === "boolean") return;
    if (Array.isArray(c)) { c.forEach(walk); return; }
    if (typeof c === "object") { walk(c.props?.children); return; }
    out.push(String(c));
  };
  walk(node.props?.children);
  return out.join("");
}
// The RENDERED text under a test instance — `label` reads an element's own
// children prop, which is empty for a component taking data props instead.
function innerText(inst) {
  if (inst == null) return "";
  if (typeof inst === "string" || typeof inst === "number") return String(inst);
  return (inst.children || []).map(innerText).join(" ");
}
const buttonSaying = (tree, said) => buttons(tree).find((b) => label(b).includes(said));
const chip = (tree, title) => buttons(tree).find((b) => label(b).startsWith(title + " "));
const rowFor = (tree, name) => tree.root.findAllByType(ArmRow).find((n) => n.props.row.name === name);

async function renderTab(props = {}) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<ArmingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} {...props} />);
  });
  await act(async () => {});
  await act(async () => {});    // the settle pass lands on the second flush
  return tree;
}

beforeEach(() => {
  seed(); READS.length = 0; HELD.length = 0; HOLD_PRODUCT_READS = false;
  LOCATIONS = { ...BASE_LOCATIONS };
  CONFIG_STATE = { value: CONFIG, settled: true, error: false };
  callableMock.mockClear(); updateMock.mockClear(); pushMock.mockClear();
});

// ── THE READ ────────────────────────────────────────────────────────────────
describe("what it reads", () => {
  it("four location-scoped paths for the list, and no root", async () => {
    await renderTab();
    const listReads = READS.filter((p) => p.split("/").length === 2);
    expect(listReads.sort()).toEqual([
      "stock/hub1", "stock/hub2", "stock_targets/hub1", "stock_targets/hub2",
    ]);
    for (const banned of ["stock", "stock_targets", "products"]) {
      expect(READS, `must never read /${banned} wholesale`).not.toContain(banned);
    }
  });

  it("and only per-(location, product) reads to settle the rest", async () => {
    await renderTab();
    for (const path of READS.filter((p) => p.split("/").length === 3)) {
      expect(path).toMatch(/^stock\/[^/]+\/[^/]+$/);
      // Never at a hub — those two are already held in full.
      expect(path.startsWith("stock/hub1/")).toBe(false);
      expect(path.startsWith("stock/hub2/")).toBe(false);
    }
  });

  it("does not re-read on every render", async () => {
    const tree = await renderTab();
    const after = READS.length;
    await act(async () => { tree.update(<ArmingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} />); });
    await act(async () => {});
    expect(READS.length).toBe(after);
  });

  it("reports what it cost, on screen, including the settle", async () => {
    const tree = await renderTab();
    const n = Number(text(tree).match(/(\d+) scoped reads/)[1]);
    expect(n).toBeGreaterThan(4);      // 4 for the list, plus the settle pass
    expect(text(tree)).toMatch(/\d+ KB|\d+\.\d MB/);
  });
});

// ── THE FOUR TABS ───────────────────────────────────────────────────────────
describe("the four tabs", () => {
  it("names all four with a count, and the counts add up to the catalogue", async () => {
    const tree = await renderTab();
    const counts = {};
    for (const title of ["Both hubs", "Hub 1", "Hub 2", "Nowhere"]) {
      const c = chip(tree, title);
      expect(c, `${title} must be a tab`).toBeTruthy();
      counts[title] = Number(label(c).slice(title.length + 1));
    }
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(PRODUCTS.length);
  });

  it("opens on Both hubs — the defect, not the inventory", async () => {
    const tree = await renderTab();
    expect(chip(tree, "Both hubs").props["aria-pressed"]).toBe(true);
    expect(text(tree)).toContain("Both Hubs Sneaker");
    expect(text(tree)).not.toContain("Hub One Sneaker");
  });

  it("shows one list at a time", async () => {
    const tree = await renderTab();
    await act(async () => { chip(tree, "Hub 1").props.onClick(); });
    const s = text(tree);
    expect(s).toContain("Hub One Sneaker");
    expect(s).not.toContain("Both Hubs Sneaker");
    expect(s).not.toContain("Hub Two Sneaker");
  });

  it("Nowhere holds the quiet ones, and they are reachable", async () => {
    // The first build dropped these from the screen entirely.
    const tree = await renderTab();
    await act(async () => { chip(tree, "Nowhere").props.onClick(); });
    const s = text(tree);
    expect(s).toContain("Retired Sneaker");     // deactivated
    expect(s).toContain("Nowhere Sneaker");     // armed by nothing
  });

  it("every product is in exactly one tab", async () => {
    const tree = await renderTab();
    const seen = [];
    for (const title of ["Both hubs", "Hub 1", "Hub 2", "Nowhere"]) {
      await act(async () => { chip(tree, title).props.onClick(); });
      for (const r of tree.root.findAllByType(ArmRow)) seen.push(r.props.row.name);
    }
    expect(seen.length).toBe(PRODUCTS.length);
    expect(new Set(seen).size).toBe(PRODUCTS.length);
  });
});

// ── THE LIST IS COMPLETE ON FIRST PAINT ─────────────────────────────────────
describe("the residue settles itself", () => {
  it("puts a product armed only by stock at another location in the right tab", async () => {
    // p5 is carried at Hub 1 with zero units of both sizes; its units are at
    // Central. On the hub-scoped read alone the engine's dead-size rule reads it
    // as unarmed and it lands in Nowhere. It is armed at Hub 1, and the tab must
    // say so WITHOUT anyone pressing anything — a list that is wrong until you
    // press something is a list that is wrong. 64 live products were in this
    // state.
    const tree = await renderTab();
    await act(async () => { chip(tree, "Hub 1").props.onClick(); });
    expect(text(tree), "Elsewhere Sneaker belongs in Hub 1").toContain("Elsewhere Sneaker");

    await act(async () => { chip(tree, "Nowhere").props.onClick(); });
    expect(text(tree)).not.toContain("Elsewhere Sneaker");
  });

  it("reads the other locations per product, never as a node", async () => {
    await renderTab();
    const perProduct = READS.filter((p) => p.split("/").length === 3);
    expect(perProduct.length).toBeGreaterThan(0);
    expect(READS).not.toContain("stock/central");
    expect(READS).not.toContain("stock/trophy");
  });

  it("does not loop: the settle runs once and then has nothing to do", async () => {
    const tree = await renderTab();
    const after = READS.length;
    await act(async () => { tree.update(<ArmingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} />); });
    await act(async () => {});
    await act(async () => {});
    expect(READS.length).toBe(after);
  });
});

// ── THE BADGES ──────────────────────────────────────────────────────────────
describe("the flags that are not a place", () => {
  it("marks a hub armed with nothing on the shelf", async () => {
    const tree = await renderTab();
    await act(async () => { chip(tree, "Hub 2").props.onClick(); });
    expect(innerText(rowFor(tree, "Unseated Bag"))).toContain("Not seated");
  });

  it("marks a product a target:0 row switched off", async () => {
    const tree = await renderTab();
    await act(async () => { chip(tree, "Hub 2").props.onClick(); });
    expect(innerText(rowFor(tree, "Hub Two Sneaker"))).toContain("Switched off");
  });

  it("marks a deactivated line, in Nowhere", async () => {
    const tree = await renderTab();
    await act(async () => { chip(tree, "Nowhere").props.onClick(); });
    expect(innerText(rowFor(tree, "Retired Sneaker"))).toContain("Deactivated");
  });

  it("names the hub and its units on an armed row", async () => {
    const tree = await renderTab();
    expect(innerText(rowFor(tree, "Both Hubs Sneaker"))).toContain("Hub 1 · 3");
    expect(innerText(rowFor(tree, "Both Hubs Sneaker"))).toContain("Hub 2 · 2");
  });
});

// ── SEARCH AND PAGING ───────────────────────────────────────────────────────
describe("the search box", () => {
  it("filters the list that is open", async () => {
    const tree = await renderTab();
    await act(async () => { chip(tree, "Nowhere").props.onClick(); });
    const box = tree.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "retired" } }); });
    const s = text(tree);
    expect(s).toContain("Retired Sneaker");
    expect(s).not.toContain("Nowhere Sneaker");
  });

  it("requires every term, so a second word narrows", async () => {
    const tree = await renderTab();
    await act(async () => { chip(tree, "Nowhere").props.onClick(); });
    const box = tree.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "sneaker nowhere" } }); });
    expect(text(tree)).not.toContain("Retired Sneaker");
  });

  it("says so when nothing matches", async () => {
    const tree = await renderTab();
    const box = tree.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "zzzznothing" } }); });
    expect(text(tree)).toContain("No match in this list.");
    // The TAB COUNT stays unfiltered — it is what the list holds, not what the
    // search found.
    expect(label(chip(tree, "Both hubs"))).toContain("1");
  });

  it("keeps the tab counts unfiltered while searching", async () => {
    const tree = await renderTab();
    const before = label(chip(tree, "Nowhere"));
    const box = tree.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "zzzznothing" } }); });
    expect(label(chip(tree, "Nowhere"))).toBe(before);
  });
});

describe("a long list does not render at once", () => {
  const MANY = [
    ...PRODUCTS,
    ...Array.from({ length: 140 }, (_, i) => ({
      id: `q${i}`, name: `Bulk Sneaker ${String(i).padStart(3, "0")}`,
      category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"],
    })),
  ];

  it("shows a page and offers the rest", async () => {
    setNode("stock/hub2", {
      p1: { 9: cell(2) }, p3: { 9: cell(5) },
      ...Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`q${i}`, { 8: cell(2) }])),
    });
    const tree = await renderTab({ products: MANY });
    await act(async () => { chip(tree, "Hub 2").props.onClick(); });
    const s = text(tree);
    expect(s).toContain("Bulk Sneaker 000");
    expect(s).not.toContain("Bulk Sneaker 139");
    const more = buttons(tree).find((b) => /^\d+ more$/.test(label(b)));
    expect(more).toBeTruthy();
    await act(async () => { more.props.onClick(); });
    expect(text(tree)).toContain("Bulk Sneaker 060");
  });

  it("starts a new list at the top", async () => {
    setNode("stock/hub2", {
      p1: { 9: cell(2) }, p3: { 9: cell(5) },
      ...Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`q${i}`, { 8: cell(2) }])),
    });
    const tree = await renderTab({ products: MANY });
    await act(async () => { chip(tree, "Hub 2").props.onClick(); });
    await act(async () => { buttons(tree).find((b) => /^\d+ more$/.test(label(b))).props.onClick(); });
    expect(text(tree)).toContain("Bulk Sneaker 060");
    await act(async () => { chip(tree, "Both hubs").props.onClick(); });
    await act(async () => { chip(tree, "Hub 2").props.onClick(); });
    expect(text(tree)).not.toContain("Bulk Sneaker 060");
  });
});

// ── EDITING ON THE SPOT ─────────────────────────────────────────────────────
describe("opening a row", () => {
  const openRow = async (tree, name) => {
    const row = rowFor(tree, name);
    const btn = row.findAll((n) => n.type === "button").find((b) => label(b).includes(name));
    await act(async () => { btn.props.onClick(); });
    await act(async () => {});
    return row;
  };

  it("reads that ONE product from every location, never a node", async () => {
    const tree = await renderTab();
    READS.length = 0;
    await openRow(tree, "Both Hubs Sneaker");
    expect(READS.length).toBeGreaterThan(0);
    for (const path of READS) {
      expect(path, "every read must be per (location, product)").toMatch(/^(stock|stock_targets)\/[^/]+\/p1$/);
    }
    // Every location that can hold a cell, in_transit and deactivated ones
    // included — the engine's dead-size rule counts units anywhere, and
    // switchOff REFUSES a location list that does not cover the seat.
    for (const loc of Object.keys(BASE_LOCATIONS)) {
      expect(READS).toContain(`stock/${loc}/p1`);
    }
  });

  it("renders the Seating tab's own rows, one per location", async () => {
    const tree = await renderTab();
    await openRow(tree, "Both Hubs Sneaker");
    const seats = tree.root.findAllByType(SeatRow);
    expect(seats.length).toBe(Object.keys(BASE_LOCATIONS).length);
    expect(seats.map((s) => s.props.label).sort()).toEqual(["Central", "Hub 1", "Hub 2", "Trophy"]);
  });

  it("hands each row the FULL location list, or switchOff would refuse it", async () => {
    const tree = await renderTab();
    await openRow(tree, "Both Hubs Sneaker");
    for (const s of tree.root.findAllByType(SeatRow)) {
      expect(s.props.locations).toContain(s.props.seat.loc);
      expect(s.props.viewer).toBe(OWNER);
    }
  });

  it("closes again, and only one row is open at a time", async () => {
    const tree = await renderTab();
    await openRow(tree, "Both Hubs Sneaker");
    expect(tree.root.findAllByType(SeatRow).length).toBeGreaterThan(0);
    await openRow(tree, "Both Hubs Sneaker");
    expect(tree.root.findAllByType(SeatRow).length).toBe(0);
  });

  it("writes nothing merely by opening", async () => {
    const tree = await renderTab();
    await openRow(tree, "Both Hubs Sneaker");
    expect(updateMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("the actions are the Seating tab's, so the write gate is asked once", async () => {
    // ProductSeating renders SeatRow, which renders SeatingActions, which asks
    // enginePolicySeatingWritable for itself. This tab must not re-decide it.
    const src = (await import("node:fs")).readFileSync(new URL("./ArmingTab.jsx", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toContain("enginePolicySeatingWritable");
    expect(code).not.toContain("enginePolicySeatingMovable");
    expect(code).toContain('import { SeatRow } from "./SeatingTab"');
  });
});

// ── THE POLICY ARRIVES ON ITS OWN SUBSCRIPTION ──────────────────────────────
describe("before the engine policy has answered", () => {
  it("says it is still reading rather than showing a confident zero", async () => {
    CONFIG_STATE = { value: null, settled: false, error: false };
    const tree = await renderTab();
    const s = text(tree);
    expect(s).toContain("Reading the policy…");
    expect(s).not.toContain("Both Hubs Sneaker");
  });

  it("degrades with a visible warning when the policy cannot be READ", async () => {
    CONFIG_STATE = { value: null, settled: true, error: true };
    const tree = await renderTab();
    expect(text(tree)).toContain("could not be read");
  });
});

// ── REFRESH ─────────────────────────────────────────────────────────────────
describe("Refresh", () => {
  it("re-reads the four list paths", async () => {
    const tree = await renderTab();
    READS.length = 0;
    await act(async () => { await buttonSaying(tree, "Refresh").props.onClick(); });
    await act(async () => {});
    await act(async () => {});
    const listReads = READS.filter((p) => p.split("/").length === 2);
    expect(listReads.sort()).toEqual(["stock/hub1", "stock/hub2", "stock_targets/hub1", "stock_targets/hub2"]);
  });

  it("interrupting a settle leaves no frozen progress behind", async () => {
    // The settle gated its cleanup on the READ's sequence number, so a Refresh
    // landing mid-pass left "checking n/m" on screen for the life of the tab.
    HOLD_PRODUCT_READS = true;
    let tree;
    await act(async () => {
      tree = TestRenderer.create(<ArmingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} />);
    });
    await act(async () => {});
    await act(async () => { await buttonSaying(tree, "Refresh").props.onClick(); });
    HOLD_PRODUCT_READS = false;
    await act(async () => { RELEASE(); });
    await act(async () => {});
    await act(async () => {});
    expect(text(tree)).not.toContain("checking");
  });
});

// ── A NEW LOCATION INVALIDATES A SETTLE ─────────────────────────────────────
describe("the location registry changing", () => {
  it("re-settles against the new location list", async () => {
    const tree = await renderTab();
    READS.length = 0;
    LOCATIONS = { ...LOCATIONS, hub3: { id: "hub3", label: "Hub 3", kind: "warehouse", active: true } };
    await act(async () => { tree.update(<ArmingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} />); });
    await act(async () => {});
    await act(async () => {});
    // "Read from every location" stopped being true with no read having failed.
    expect(READS.some((p) => p.startsWith("stock/hub3/"))).toBe(true);
  });

  it("does not re-settle when the registry is unchanged", async () => {
    const tree = await renderTab();
    READS.length = 0;
    await act(async () => { tree.update(<ArmingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} />); });
    await act(async () => {});
    await act(async () => {});
    expect(READS).toEqual([]);
  });

  it("is insensitive to the ORDER the registry arrives in", async () => {
    const tree = await renderTab();
    READS.length = 0;
    LOCATIONS = Object.fromEntries(Object.entries(LOCATIONS).reverse());
    await act(async () => { tree.update(<ArmingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} />); });
    await act(async () => {});
    await act(async () => {});
    expect(READS).toEqual([]);
  });
});

// ── HELPERS ─────────────────────────────────────────────────────────────────
describe("mergeStock", () => {
  it("keeps the cells already held at a location", () => {
    const base = { hub1: { p1: { 8: cell(1) } } };
    const out = mergeStock(base, { hub1: { p2: { 8: cell(2) } }, central: { p3: { 8: cell(3) } } });
    expect(Object.keys(out.hub1).sort()).toEqual(["p1", "p2"]);
    expect(out.central.p3).toEqual({ 8: cell(3) });
  });

  it("does not mutate what it was given", () => {
    const base = { hub1: { p1: { 8: cell(1) } } };
    mergeStock(base, { hub1: { p2: { 8: cell(2) } } });
    expect(Object.keys(base.hub1)).toEqual(["p1"]);
  });

  it("survives an empty or absent addition", () => {
    const base = { hub1: { p1: { 8: cell(1) } } };
    expect(mergeStock(base, {})).toEqual(base);
    expect(mergeStock(base, undefined)).toEqual(base);
  });
});

describe("mb", () => {
  it("reads in KB below a megabyte and MB above it", () => {
    expect(mb(2048)).toBe("2 KB");
    expect(mb(1024 * 1024 * 2.7)).toBe("2.7 MB");
    expect(mb(0)).toBe("0 KB");
    expect(mb(undefined)).toBe("0 KB");
  });
});

// ── THE TAB STRIP ───────────────────────────────────────────────────────────
describe("the card", () => {
  it("shows three tabs and Arming is reachable", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    const s = text(tree);
    expect(s).toContain("Categories");
    expect(s).toContain("Seating");
    expect(s).toContain("Arming");
    await act(async () => { buttonSaying(tree, "Arming").props.onClick(); });
    await act(async () => {});
    expect(tree.root.findAllByType(ArmingTab).length).toBe(1);
  });

  it("hands Arming the viewer and the flash, because it writes now", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    await act(async () => { buttonSaying(tree, "Arming").props.onClick(); });
    await act(async () => {});
    const tab = tree.root.findAllByType(ArmingTab)[0];
    expect(tab.props.viewer).toBe(OWNER);
    expect(typeof tab.props.flash).toBe("function");
  });
});
