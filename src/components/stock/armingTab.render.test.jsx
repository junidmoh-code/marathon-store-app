// ─── THE ARMING TAB — WHAT IT SHOWS, WHAT IT READS, WHO MAY SEE IT ───────────
//
// Five sections, the collapse state, the search box, the paging that keeps a
// three-thousand-row inventory off the phone, the hand-off into Seating, and
// GATE 2d — the tab's own super-admin check, independent of the tile, the
// route, the card's and the Seating tab's.
//
// THE READS ARE PART OF THE BEHAVIOUR. Every path the tab asks for is recorded,
// so a read it must never make is visible as an assertion and not as a comment.
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
// RTDB HAS NO EMPTY CHILDREN: a node whose value becomes {} or [] is deleted
// and reads back as null. NODES is written through setNode, which deletes, so
// no fixture below can assert against a shape the database cannot produce.
const NODES = {};
function setNode(path, value) {
  const empty = value == null
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === "object" && Object.keys(value).length === 0);
  if (empty) delete NODES[path];
  else NODES[path] = value;
}

const READS = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    READS.push(String(r.path));
    // A read loop must end in a clean failure, not a killed worker.
    if (READS.length > 400) return new Promise(() => {});
    const v = Object.prototype.hasOwnProperty.call(NODES, r.path) ? NODES[r.path] : null;
    return { exists: () => v != null, val: () => v };
  },
  onValue: () => () => {},
  update: async () => {},
  push: () => ({ key: "mv1" }),
  child: () => ({}),
}));

// A FRESH OBJECT every render, exactly as usePath can hand one back — the shape
// that turns an identity-keyed memo into a read loop.
vi.mock("./useStock", () => ({
  useLocations: () => ({
    hub1: { id: "hub1", label: "Hub 1", kind: "warehouse", active: true },
    hub2: { id: "hub2", label: "Hub 2", kind: "warehouse", active: true },
    central: { id: "central", label: "Central", kind: "warehouse", active: true },
    trophy: { id: "trophy", label: "Trophy", kind: "store", sellable: true, active: true },
  }),
  useEngineConfig: () => CONFIG,
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
    // Unscoped: arms a hub whether or not it holds a cell — section B's source.
    bags: { hub2: { target: 4, minQty: 2 } },
  },
};

const ArmingTab = (await import("./ArmingTab.jsx")).default;
const SeatingTab = (await import("./SeatingTab.jsx")).default;
const EnginePolicyCard = (await import("./EnginePolicyCard.jsx")).default;

const cell = (qty) => ({ qty, v: 1, lastType: "received", updatedAt: "2026-09-01T00:00:00.000Z" });

const PRODUCTS = [
  { id: "p1", name: "Both Hubs Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"], photoUrl: "https://x/p1.jpg" },
  { id: "p2", name: "Hub One Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"] },
  { id: "p3", name: "Hub Two Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"] },
  { id: "p4", name: "Unseated Bag", category: "Bags", categoryKey: "bags", sizes: [] },
  { id: "p5", name: "Quiet Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"] },
  { id: "p6", name: "Retired Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8", "9"],
    deactivated: { at: 1757000000000, by: "u1" } },
];

const OWNER = { email: "gunidmoh@gmail.com" };
const STAFF = { email: "rashid@marathon.internal" };

function seed() {
  for (const k of Object.keys(NODES)) delete NODES[k];
  setNode("stock/hub1", {
    p1: { 8: cell(3) },
    p2: { 8: cell(1) },
    p5: { 8: cell(0), 9: cell(0) },      // carried, empty — undecided
    p6: { 8: cell(4) },                  // deactivated: armed nowhere
  });
  setNode("stock/hub2", {
    p1: { 9: cell(2) },
    p3: { 9: cell(5) },
  });
  // A hand-written target:0 pair at hub 1 over a policy that would arm — the
  // suppression section. The units live at Central so the dead-size rule is not
  // what is answering.
  setNode("stock_targets/hub1", {
    p3: { 8: { target: 0, minQty: 0, source: "seating_off" }, 9: { target: 0, minQty: 0, source: "seating_off" } },
  });
  setNode("stock/central", { p3: { 8: cell(9), 9: cell(9) }, p5: { 8: cell(4) } });
  setNode("stock/central/p3", { 8: cell(9), 9: cell(9) });
  setNode("stock/central/p5", { 8: cell(4) });
}

const text = (tree) => JSON.stringify(tree.toJSON());
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");

// A test instance's `children` carry fibers, which JSON.stringify cannot walk.
// The rendered TEXT is what a button says, so collect that from the element
// tree instead.
function label(node) {
  const out = [];
  const walk = (c) => {
    if (c == null || typeof c === "boolean") return;
    if (Array.isArray(c)) { c.forEach(walk); return; }
    if (typeof c === "object") { walk(c.props?.children); return; }
    out.push(String(c));
  };
  walk(node.props?.children);
  return out.join(" ");
}
const buttonSaying = (tree, said) => buttons(tree).find((b) => label(b).includes(said));

async function renderTab(props = {}) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<ArmingTab products={PRODUCTS} onOpenSeating={() => {}} {...props} />);
  });
  await act(async () => {});
  return tree;
}

beforeEach(() => { seed(); READS.length = 0; callableMock.mockClear(); });

// ── THE READ ────────────────────────────────────────────────────────────────
describe("what it reads", () => {
  it("four location-scoped paths, and no root", async () => {
    await renderTab();
    expect(READS.sort()).toEqual([
      "stock/hub1", "stock/hub2", "stock_targets/hub1", "stock_targets/hub2",
    ]);
    for (const banned of ["stock", "stock_targets", "products"]) {
      expect(READS, `must never read /${banned} wholesale`).not.toContain(banned);
    }
  });

  it("does not re-read on every render", async () => {
    const tree = await renderTab();
    const after = READS.length;
    await act(async () => { tree.update(<ArmingTab products={PRODUCTS} onOpenSeating={() => {}} />); });
    await act(async () => {});
    expect(READS.length).toBe(after);
  });

  it("reports what it cost, on screen", async () => {
    const tree = await renderTab();
    expect(text(tree)).toContain("4 scoped reads");
    expect(text(tree)).toMatch(/\d+ KB|\d+\.\d MB/);
  });
});

// ── THE SECTIONS ────────────────────────────────────────────────────────────
describe("the five sections", () => {
  it("names all five, with a count on each", async () => {
    const s = text(await renderTab());
    for (const title of ["Armed at both hubs", "Armed but not seated",
      "Armed, suppressed by seating", "Hub 1 only", "Hub 2 only"]) {
      expect(s).toContain(title);
    }
  });

  it("puts the both-hub product first and shows it", async () => {
    const s = text(await renderTab());
    expect(s).toContain("Both Hubs Sneaker");
    expect(s.indexOf("Armed at both hubs")).toBeLessThan(s.indexOf("Hub 1 only"));
  });

  it("A, B and C are open by default; D and E are not", async () => {
    const tree = await renderTab();
    const s = text(tree);
    // Open sections render their rows; the shut ones render a Show control and
    // no product name.
    expect(s).toContain("Both Hubs Sneaker");
    expect(s).toContain("Unseated Bag");        // section B, open
    expect(s).not.toContain("Hub One Sneaker"); // section D, shut
    expect(s).not.toContain("Hub Two Sneaker"); // section E, shut
  });

  it("opens a shut section on demand and shuts it again", async () => {
    const tree = await renderTab();
    const header = buttonSaying(tree, "Hub 1 only");
    await act(async () => { header.props.onClick(); });
    expect(text(tree)).toContain("Hub One Sneaker");
    await act(async () => { header.props.onClick(); });
    expect(text(tree)).not.toContain("Hub One Sneaker");
  });

  it("a deactivated product is armed nowhere and is counted, not shown", async () => {
    const tree = await renderTab();
    const s = text(tree);
    expect(s).not.toContain("Retired Sneaker");
    expect(s).toContain("deactivated, armed nowhere");
  });
});

// ── SEARCH ──────────────────────────────────────────────────────────────────
describe("the filter", () => {
  it("narrows every section at once", async () => {
    const tree = await renderTab();
    const box = tree.root.findAll((n) => n.type === "input")[0];
    // Open section D so there is something in it to narrow.
    await act(async () => { buttonSaying(tree, "Hub 1 only").props.onClick(); });
    await act(async () => { box.props.onChange({ target: { value: "both hubs" } }); });
    const s = text(tree);
    expect(s).toContain("Both Hubs Sneaker");
    expect(s).not.toContain("Hub One Sneaker");
  });

  it("keeps the section's real count on the header while filtering", async () => {
    const tree = await renderTab();
    const box = tree.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "zzzznothing" } }); });
    const s = text(tree);
    expect(s).toContain("Armed at both hubs");
    expect(s).toContain("No match in this section.");
  });

  it("filters nothing when empty", async () => {
    const tree = await renderTab();
    const box = tree.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "  " } }); });
    expect(text(tree)).toContain("Both Hubs Sneaker");
  });
});

// ── PAGING ──────────────────────────────────────────────────────────────────
describe("a long section does not render at once", () => {
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
    await act(async () => { buttonSaying(tree, "Hub 2 only").props.onClick(); });
    const s = text(tree);
    expect(s).toContain("Bulk Sneaker 000");
    expect(s).not.toContain("Bulk Sneaker 139");
    const more = buttons(tree).find((b) => /\d+ more/.test(label(b)));
    expect(more).toBeTruthy();
    await act(async () => { more.props.onClick(); });
    expect(text(tree)).toContain("Bulk Sneaker 060");
  });
});

// ── THE RESIDUE ─────────────────────────────────────────────────────────────
describe("the undecided residue", () => {
  it("is named rather than swallowed", async () => {
    const s = text(await renderTab());
    expect(s).toContain("undecided");
  });

  it("resolves it with per-(location, product) reads and never a whole node", async () => {
    const tree = await renderTab();
    READS.length = 0;
    const btn = buttonSaying(tree, "Read the other");
    expect(btn).toBeTruthy();
    await act(async () => { await btn.props.onClick(); });
    await act(async () => {});
    // Only scoped per-product paths, and only at the locations not already held.
    expect(READS.length).toBeGreaterThan(0);
    for (const path of READS) {
      expect(path).toMatch(/^stock\/[^/]+\/[^/]+$/);
      expect(path.startsWith("stock/hub1/")).toBe(false);
      expect(path.startsWith("stock/hub2/")).toBe(false);
    }
  });

  it("and the residue is gone afterwards", async () => {
    const tree = await renderTab();
    const btn = buttonSaying(tree, "Read the other");
    await act(async () => { await btn.props.onClick(); });
    await act(async () => {});
    expect(text(tree)).not.toContain("undecided");
  });
});

// ── THE HAND-OFF ────────────────────────────────────────────────────────────
describe("a row hands the product to Seating", () => {
  it("calls back with the product id and nothing else", async () => {
    const seen = [];
    const tree = await renderTab({ onOpenSeating: (pid) => seen.push(pid) });
    const row = buttonSaying(tree, "Both Hubs Sneaker");
    await act(async () => { row.props.onClick(); });
    expect(seen).toEqual(["p1"]);
  });

  it("through the card, Arming opens Seating on that product", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    await act(async () => { buttonSaying(tree, "Arming").props.onClick(); });
    await act(async () => {});
    const row = buttonSaying(tree, "Both Hubs Sneaker");
    await act(async () => { row.props.onClick(); });
    await act(async () => {});
    expect(tree.root.findAllByType(SeatingTab).length).toBe(1);
    expect(tree.root.findAllByType(SeatingTab)[0].props.initialPid).toBe("p1");
  });
});

// ── IT WRITES NOTHING ───────────────────────────────────────────────────────
describe("read-only", () => {
  it("offers no unarm, no switch off and no target edit", async () => {
    const s = text(await renderTab());
    for (const word of ["Switch off", "Unarm", "Re-seat", "Save"]) {
      expect(s, `the Arming tab must not offer "${word}"`).not.toContain(word);
    }
  });
});

// ── THE TAB STRIP AND GATE 2d ───────────────────────────────────────────────
describe("the tab strip", () => {
  it("Engine Policy now shows three tabs", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    const s = text(tree);
    expect(s).toContain("Categories");
    expect(s).toContain("Seating");
    expect(s).toContain("Arming");
  });

  it("Arming is reachable and renders the tab", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    await act(async () => { buttonSaying(tree, "Arming").props.onClick(); });
    await act(async () => {});
    expect(tree.root.findAllByType(ArmingTab).length).toBe(1);
  });
});
