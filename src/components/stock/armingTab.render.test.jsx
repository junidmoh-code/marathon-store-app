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
// The delete is RECURSIVE. RTDB removes a key whose value becomes empty at EVERY
// depth, not only at the node the write addressed — so `{ p1: {} }` is a shape
// the database cannot hold, and a fake that kept it would let a test pass over
// an impossible fixture. `[]` is pruned the same way, which is what "RTDB cannot
// store empty arrays" means in practice.
function prune(value) {
  if (value == null) return undefined;
  if (typeof value !== "object") return value;
  const arr = Array.isArray(value);
  const out = arr ? [] : {};
  let kept = 0;
  for (const k of Object.keys(value)) {
    const v = prune(value[k]);
    if (v === undefined) continue;
    out[k] = v; kept += 1;
  }
  return kept ? out : undefined;
}
function setNode(path, value) {
  const pruned = prune(value);
  if (pruned === undefined) delete NODES[path];
  else NODES[path] = pruned;
}

const READS = [];
// A WRITE would land here. Read-only is asserted at the database, not by
// grepping the rendered text for the word "Save".
const updateMock = vi.fn(async () => {});
const pushMock = vi.fn(() => ({ key: "mv1" }));

// A HELD READ. While HOLD_PRODUCT_READS is on, the per-(location, product) reads
// the resolve pass makes never settle until RELEASE() is called — the shape
// needed to land a Refresh in the MIDDLE of a resolve, which is the only way to
// reach the wedge below. The four location reads are deliberately not held: the
// test needs Refresh to complete while the resolve is still outstanding.
let HOLD_PRODUCT_READS = false;
const HELD = [];
const RELEASE = () => { const q = HELD.splice(0); for (const f of q) f(); };

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    READS.push(String(r.path));
    // A read loop must end in a clean failure, not a killed worker.
    if (READS.length > 4000) return new Promise(() => {});
    const v = Object.prototype.hasOwnProperty.call(NODES, r.path) ? NODES[r.path] : null;
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

// A FRESH OBJECT every render, exactly as usePath can hand one back — the shape
// that turns an identity-keyed memo into a read loop.
// MUTABLE, and handed back as a FRESH OBJECT every render — exactly as usePath
// does. A static mock makes locSig constant, which leaves the whole
// registry-invalidation path untestable: five separate mutations to it survived
// the suite before this. (Adversarial review, PR #601.)
let LOCATIONS = {};
const BASE_LOCATIONS = {
  hub1: { id: "hub1", label: "Hub 1", kind: "warehouse", active: true },
  hub2: { id: "hub2", label: "Hub 2", kind: "warehouse", active: true },
  central: { id: "central", label: "Central", kind: "warehouse", active: true },
  trophy: { id: "trophy", label: "Trophy", kind: "store", sellable: true, active: true },
};

vi.mock("./useStock", () => ({
  useLocations: () => ({ ...LOCATIONS }),
  useEngineConfig: () => CONFIG,
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
    // Unscoped: arms a hub whether or not it holds a cell — section B's source.
    bags: { hub2: { target: 4, minQty: 2 } },
  },
};

// Mutable, so a test can hold the policy in flight — the state the tab is
// gated on and the one a warm page actually hits.
let CONFIG_STATE = { value: null, settled: false, error: false };

const ArmingMod = await import("./ArmingTab.jsx");
const ArmingTab = ArmingMod.default;
const { ArmRow, bySize, mergeStock, mb } = ArmingMod;
const SeatingTab = (await import("./SeatingTab.jsx")).default;
const { SizeFactChip } = await import("./healthWidgets.jsx");
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
  // Carried at Hub 1 with empty cells and NO units anywhere else. Undecided on
  // the hub read, and STILL unarmed once every location has been asked — so
  // `resolvedPids` is the only thing that decides it, which is what makes the
  // invalidation tests below mean anything.
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

    p5: { 8: cell(0), 9: cell(0) },      // carried, empty — undecided, armed by Central
    p7: { 8: cell(0), 9: cell(0) },      // carried, empty — and empty everywhere
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

// The RENDERED text under any test instance. `label` reads an element's own
// children prop, which is empty for a component that takes data props instead —
// so a row has to be read from what it produced, not from what it was given.
function innerText(inst) {
  if (inst == null) return "";
  if (typeof inst === "string" || typeof inst === "number") return String(inst);
  return (inst.children || []).map(innerText).join(" ");
}

async function renderTab(props = {}) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<ArmingTab products={PRODUCTS} onOpenSeating={() => {}} {...props} />);
  });
  await act(async () => {});
  return tree;
}

beforeEach(() => {
  seed(); READS.length = 0; HELD.length = 0; HOLD_PRODUCT_READS = false;
  CONFIG_STATE = { value: CONFIG, settled: true, error: false };
  LOCATIONS = { ...BASE_LOCATIONS };
  callableMock.mockClear(); updateMock.mockClear(); pushMock.mockClear();
});

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
    const expanded = (title) => buttons(tree).find((b) => label(b).includes(title))?.props["aria-expanded"];
    expect(expanded("Armed at both hubs")).toBe(true);
    expect(expanded("Armed but not seated")).toBe(true);
    expect(expanded("Armed, suppressed by seating")).toBe(true);
    expect(expanded("Hub 1 only")).toBe(false);
    expect(expanded("Hub 2 only")).toBe(false);
    // …and a shut section renders none of its rows. p2 is in section D alone.
    expect(text(tree)).toContain("Both Hubs Sneaker");
    expect(text(tree)).not.toContain("Hub One Sneaker");
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
    // THE NUMBER, not the title. A version of this test that asserted only the
    // heading and the empty-state line stayed green with the header wired to
    // the FILTERED row count — which is the very thing it is named for.
    // (Adversarial review, PR #601.)
    const tree = await renderTab();
    const header = () => buttons(tree).find((b) => label(b).includes("Armed at both hubs"));
    expect(label(header())).toContain("1");
    const box = tree.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "zzzznothing" } }); });
    expect(label(header()), "the header count must stay unfiltered").toContain("1");
    expect(text(tree)).toContain("No match in this section.");
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

// ── REFRESH, AND REFRESH DURING A RESOLVE ───────────────────────────────────
describe("Refresh", () => {
  it("re-reads the four paths", async () => {
    const tree = await renderTab();
    READS.length = 0;
    await act(async () => { await buttonSaying(tree, "Refresh").props.onClick(); });
    await act(async () => {});
    expect(READS.sort()).toEqual(["stock/hub1", "stock/hub2", "stock_targets/hub1", "stock_targets/hub2"]);
  });

  it("does not leave the resolve button wedged when it interrupts one", async () => {
    // THE BUG: resolve() gated its `finally` on the READ's sequence number, so a
    // Refresh landing mid-resolve meant `resolving` was never cleared and the
    // button sat disabled on a frozen count for the life of the tab.
    const tree = await renderTab();
    const resolveBtn = buttonSaying(tree, "Read the other");
    let pending;
    HOLD_PRODUCT_READS = true;
    await act(async () => { pending = resolveBtn.props.onClick(); });
    // …the resolve is now stuck mid-flight. Refresh lands on top of it.
    await act(async () => { await buttonSaying(tree, "Refresh").props.onClick(); });
    HOLD_PRODUCT_READS = false;
    await act(async () => { RELEASE(); await pending; });
    await act(async () => {});
    // The residue is back (the fresh read holds only the hubs again) and the
    // button offers to settle it rather than showing a dead progress count.
    const live = buttonSaying(tree, "Read the other");
    expect(live, "the resolve button must be offered again").toBeTruthy();
    expect(live.props.disabled).toBe(false);
  });
});

// ── THE HAND-OFF ────────────────────────────────────────────────────────────
describe("a row hands the product to Seating", () => {
  it("calls back with the product id and nothing else", async () => {
    // EVERY ARGUMENT, captured. A one-parameter closure cannot observe a second
    // argument, so the assertion that literally says "nothing else" was the one
    // assertion that could not see something else — a location appended here
    // would have sailed through. (Adversarial review, PR #601.)
    const seen = [];
    const tree = await renderTab({ onOpenSeating: (...args) => seen.push(args) });
    const row = buttonSaying(tree, "Both Hubs Sneaker");
    await act(async () => { row.props.onClick(); });
    expect(seen).toEqual([["p1"]]);
  });

  it("and does NOT survive a manual return to Seating", async () => {
    // Hand p1 over, leave to Categories, then tap Seating BY HAND. The tabs are
    // a mutually-exclusive ternary, so SeatingTab remounts and its initialPid
    // effect fires again — with a stale id it would silently re-open p1.
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    await act(async () => { buttonSaying(tree, "Arming").props.onClick(); });
    await act(async () => {});
    await act(async () => { buttonSaying(tree, "Both Hubs Sneaker").props.onClick(); });
    await act(async () => {});
    expect(tree.root.findAllByType(SeatingTab)[0].props.initialPid).toBe("p1");

    await act(async () => { buttonSaying(tree, "Categories").props.onClick(); });
    await act(async () => {});
    await act(async () => { buttonSaying(tree, "Seating").props.onClick(); });
    await act(async () => {});
    expect(tree.root.findAllByType(SeatingTab)[0].props.initialPid).toBe("");
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

// ── WHAT A ROW ACTUALLY SHOWS ───────────────────────────────────────────────
// The PR's headline sentences about the row — both hubs always, the run
// filtered to positive targets, coloured by source, the on-hand line, the
// switched-off count — were each carried by a comment and by nothing else.
describe("the row", () => {
  // Found by the ROW component instance, not by walking parents from a button —
  // a parent walk encodes the current nesting and goes green-but-meaningless the
  // moment the markup is reshaped.
  const rowFor = (tree, name) =>
    tree.root.findAllByType(ArmRow).find((n) => n.props.row.name === name);

  it("renders BOTH hub columns, including the one that is not armed", async () => {
    // p2 is armed at Hub 1 only. Its row must still name Hub 2 and say what it
    // says there — the comparison is the point of the screen.
    const tree = await renderTab();
    await act(async () => { buttonSaying(tree, "Hub 1 only").props.onClick(); });
    const t = innerText(rowFor(tree, "Hub One Sneaker"));
    expect(t).toContain("Hub 1");
    expect(t).toContain("Hub 2");
    expect(t).toContain("Not armed");
  });

  it("shows the per-size run only for sizes with a POSITIVE target", async () => {
    // p5 is carried at Hub 1 with zero units of both covered sizes, so the
    // dead-size rule resolves both to 0. Every chip on a rendered run must carry
    // a positive number; a dropped filter puts a "0" chip on screen.
    const tree = await renderTab();
    const chips = tree.root.findAllByType(SizeFactChip);
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect(c.props.value, `chip ${c.props.size}`).toBeGreaterThan(0);
  });

  it("colours each chip by which source answered", async () => {
    const tree = await renderTab();
    const chips = tree.root.findAllByType(SizeFactChip);
    // Every run on this fixture is category policy — green, not the blue an
    // explicit row would get. A dropped SOURCE_TONE lookup makes them all blue.
    expect(new Set(chips.map((c) => c.props.tone))).toEqual(new Set(["#4ADE80"]));
  });

  it("states each hub's on-hand and row count", async () => {
    const tree = await renderTab();
    expect(innerText(rowFor(tree, "Both Hubs Sneaker"))).toContain("3 on hand · 0 rows");
    expect(innerText(rowFor(tree, "Both Hubs Sneaker"))).toContain("2 on hand · 0 rows");
  });

  it("names a switched-off hub and counts its zeroed sizes", async () => {
    // p3 is carried at Hub 1 with two target:0 rows over a policy that would
    // arm it (size 9 is alive at Hub 2, so the dead-size rule is not what is
    // answering). That is section C, and the row has to say so.
    const tree = await renderTab();
    const row = rowFor(tree, "Hub Two Sneaker");
    expect(row, "the suppressed product must be on screen").toBeTruthy();
    const t = innerText(row);
    expect(t).toContain("Switched off");
    expect(t).toContain("2 sizes at 0");
  });
});

// ── THE POLICY ARRIVES ON ITS OWN SUBSCRIPTION ──────────────────────────────
describe("before the engine policy has answered", () => {
  it("says it is still reading rather than showing a confident zero", async () => {
    CONFIG_STATE = { value: null, settled: false, error: false };
    const tree = await renderTab();
    const s = text(tree);
    // The one thing it must NOT do is render the sections with every count at 0.
    expect(s).not.toContain("Armed at both hubs");
    expect(s).toContain("Reading the policy…");
  });

  it("and degrades with a visible warning when the policy cannot be READ", async () => {
    // settled AND error: an unreadable node must not be a permanent spinner,
    // and must not pass silently as an empty policy either.
    CONFIG_STATE = { value: null, settled: true, error: true };
    const tree = await renderTab();
    const s = text(tree);
    expect(s).toContain("could not be read");
    expect(s).toContain("Armed at both hubs");
  });
});

// ── IT WRITES NOTHING ───────────────────────────────────────────────────────
describe("read-only", () => {
  it("offers no unarm, no switch off and no target edit", async () => {
    const s = text(await renderTab());
    for (const word of ["Switch off", "Unarm", "Re-seat", "Save"]) {
      expect(s, `the Arming tab must not offer "${word}"`).not.toContain(word);
    }
    // …and the words are the weak half of this. Grepping rendered text passes
    // for an empty component; the database is where a write would actually
    // land, so that is where the refusal is asserted.
    expect(updateMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("writes nothing even while resolving the residue", async () => {
    const tree = await renderTab();
    await act(async () => { await buttonSaying(tree, "Read the other").props.onClick(); });
    await act(async () => {});
    expect(updateMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

// ── THE EXPORTED HELPERS ────────────────────────────────────────────────────
// Each of these carries a comment making a claim, and each claim was resting on
// nothing: deleting the body of bySize's numeric branch, or the spread in
// mergeStock, left all 74 tests green. (Adversarial review, PR #601.)
describe("bySize", () => {
  const run = (sizes) => sizes.map((size) => ({ size })).sort(bySize).map((s) => s.size);

  it("orders shoe sizes as numbers, not as strings", () => {
    expect(run(["10", "3", "9", "11", "8"])).toEqual(["3", "8", "9", "10", "11"]);
  });

  it("keeps a half size between its neighbours", () => {
    expect(run(["6", "5.5", "5"])).toEqual(["5", "5.5", "6"]);
    expect(run(["6", "5_5", "5"])).toEqual(["5", "5_5", "6"]);
  });

  it("puts letter sizes after the numbers, alphabetically", () => {
    expect(run(["M", "3", "L"])).toEqual(["3", "L", "M"]);
  });

  it("puts the one-size cell last — after the letters too", () => {
    // Blank and a letter size both rank as "not a number", so a fallback that
    // reached localeCompare sorted "" in FRONT of "L" and "M". (CodeRabbit.)
    expect(run(["", "8"])).toEqual(["8", ""]);
    expect(run(["", "M", "L"])).toEqual(["L", "M", ""]);
    expect(run(["M", "", "3", "L"])).toEqual(["3", "L", "M", ""]);
    expect(run(["  ", "L"])).toEqual(["L", "  "]);
  });
});

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

// ── A FRESH READ INVALIDATES EVERY RESOLVE ──────────────────────────────────
describe("Refresh and the resolved set", () => {
  it("drops the resolved products, because the cells they were proved against are gone", async () => {
    // Resolve, then Refresh. The residue must come BACK: the hub cells the
    // resolve was folded into have been replaced wholesale, so a product still
    // marked "decided" would be answering from stock no longer in the context.
    const tree = await renderTab();
    await act(async () => { await buttonSaying(tree, "Read the other").props.onClick(); });
    await act(async () => {});
    expect(text(tree)).not.toContain("undecided");
    await act(async () => { await buttonSaying(tree, "Refresh").props.onClick(); });
    await act(async () => {});
    expect(text(tree)).toContain("undecided");
  });

  it("a second resolve keeps what the first one proved", async () => {
    // A resolve proves ABSENCE as much as presence, and only the resolved set
    // remembers it — mergeStock cannot carry a negative.
    const tree = await renderTab();
    await act(async () => { await buttonSaying(tree, "Read the other").props.onClick(); });
    await act(async () => {});
    const s = text(tree);
    expect(s).not.toContain("undecided");
    expect(s).toContain("scoped reads");
  });
});

// ── A NEW LOCATION INVALIDATES A RESOLVE ────────────────────────────────────
// `resolvedPids` means "this product's stock has been read from EVERY
// location". A location registered afterwards makes that false with no read
// having failed.
describe("the location registry changing", () => {
  const rerender = async (tree) => {
    await act(async () => { tree.update(<ArmingTab products={PRODUCTS} onOpenSeating={() => {}} />); });
    await act(async () => {});
  };

  it("brings the residue back after a COMPLETED resolve", async () => {
    const tree = await renderTab();
    await act(async () => { await buttonSaying(tree, "Read the other").props.onClick(); });
    await act(async () => {});
    expect(text(tree)).not.toContain("undecided");

    LOCATIONS = { ...LOCATIONS, hub3: { id: "hub3", label: "Hub 3", kind: "warehouse", active: true } };
    await rerender(tree);
    expect(text(tree), "a location nobody read must un-decide the products").toContain("undecided");
  });

  it("and retires a resolve still IN FLIGHT, instead of letting it land after the clear", async () => {
    // THE HOLE THE FIRST FIX LEFT. resolve() gates on its own counters, which
    // the invalidation effect did not touch — so a pass started against the old
    // location list still landed and unioned its pids back in AFTER the clear.
    // The residue vanished and every one of those products read as fully read,
    // with the new location never asked.
    const tree = await renderTab();
    HOLD_PRODUCT_READS = true;
    let pending;
    await act(async () => { pending = buttonSaying(tree, "Read the other").props.onClick(); });

    LOCATIONS = { ...LOCATIONS, hub3: { id: "hub3", label: "Hub 3", kind: "warehouse", active: true } };
    await rerender(tree);

    HOLD_PRODUCT_READS = false;
    await act(async () => { RELEASE(); await pending; });
    await act(async () => {});
    expect(text(tree), "the stale pass must not mark anything decided").toContain("undecided");
  });

  it("does not clear when the registry is UNCHANGED", async () => {
    // A re-render with the same locations must not throw a completed resolve
    // away. usePath hands back a fresh object every time, so this is the
    // ordinary case, not the edge one.
    const tree = await renderTab();
    await act(async () => { await buttonSaying(tree, "Read the other").props.onClick(); });
    await act(async () => {});
    await rerender(tree);
    expect(text(tree)).not.toContain("undecided");
  });

  it("is insensitive to the ORDER the registry arrives in", async () => {
    // locSig sorts. Without that, usePath handing back the same locations in a
    // different key order would clear the set on every delivery.
    const tree = await renderTab();
    await act(async () => { await buttonSaying(tree, "Read the other").props.onClick(); });
    await act(async () => {});
    LOCATIONS = Object.fromEntries(Object.entries(LOCATIONS).reverse());
    await rerender(tree);
    expect(text(tree)).not.toContain("undecided");
  });
});

// ── THE BILL INCLUDES THE RESOLVE ───────────────────────────────────────────
describe("the reported read cost", () => {
  it("grows by the resolve pass's own reads and bytes", async () => {
    const tree = await renderTab();
    const before = text(tree).match(/(\d+) scoped reads/)[1];
    expect(before).toBe("4");
    await act(async () => { await buttonSaying(tree, "Read the other").props.onClick(); });
    await act(async () => {});
    const after = Number(text(tree).match(/(\d+) scoped reads/)[1]);
    // One read per (undecided product × other location). Anything that still
    // says 4 is a screen reporting a cost it did not pay.
    expect(after).toBeGreaterThan(4);
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
