// ─── MISSING PRODUCTS, RENDERED FOR REAL ─────────────────────────────────────
// solveOneSize.test.js pins the decision logic; this renders the actual
// component, because both of the day's claims are WIRING claims:
//
//   1. A one-size product with stock at a source is SOLVABLE — the same button,
//      in the same state, as a sized one. That only holds if /stock_targets is
//      actually plumbed into the component (it was not — HealthView subscribed
//      to it for another card entirely and NetworkTransfer never saw it).
//   2. No disabled action is silent. The reason has to reach the DOM as TEXT,
//      not `title=`: the old strings were hover tooltips, and these screens run
//      on warehouse tablets where hover does not exist.
//
// And the standing safety claim, asserted on every path here: Solve seeds
// carriage cells and writes NO target rows. Arming a product is the owner's
// separate, deliberate act.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-08-10T10:00:00.000Z");

const paths = {};                       // onValue subscriptions
const gets = {};                        // one-shot get() reads
const updateMock = vi.fn(() => Promise.resolve());
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const perm = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: NetworkTransfer } = await import("./NetworkTransfer.jsx");
const { computeMissingProducts } = await import("./missingProductsCore.js");
const { solveReason } = await import("./actionReasons.js");

// The live engine config, 2026-08-10.
const CONFIG = {
  ruleBasedTargets: true,
  defaultRunByStore: {
    hub2: { L: 3, M: 3, S: 2, XL: 2, XXL: 2, XXXL: 1 },
    "marathon-pe": { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
    trophy: { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
  },
  subcategoryRunByLocation: { hub2: { Watches: 2 }, trophy: { Watches: 2 }, "marathon-pe": { Watches: 2 } },
};

// A beanie exactly as the catalogue holds it, and a jersey as the sized control.
const BEANIE = "p1786357771559";
const JERSEY = "jersey1";
const PRODUCTS = [
  { id: BEANIE, name: "Hugo Boss beanie black #1", productType: "clothing", subcategory: "Caps & Hats", sizes: ["_"] },
  { id: JERSEY, name: "Real Madrid Home Jersey", productType: "clothing", subcategory: "Jerseys", sizes: ["S", "M", "L"] },
];
// Stock as useStockCells hands it over: DECODED size keys, one cell per size.
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const STOCK = {
  central: { [BEANIE]: { _: cell(10) }, [JERSEY]: { S: cell(4), M: cell(4), L: cell(4) } },
};

// ONE product per render, deliberately: the component keys every piece of state
// by pid, so a single-card screen makes "the Solve button" unambiguous without a
// tree-walking helper that would itself need testing.
const BEANIE_ONLY = PRODUCTS.filter((p) => p.id === BEANIE);
const JERSEY_ONLY = PRODUCTS.filter((p) => p.id === JERSEY);

const render = (targets, { products = BEANIE_ONLY, stock = STOCK, settled = true, error = false, category = "clothing" } = {}) => {
  const cards = computeMissingProducts({ allStock: stock, products });
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <NetworkTransfer products={products} category={category} allStock={stock} cards={cards}
        targets={targets} targetsSettled={settled} targetsError={error} />
    );
  });
  return tree;
};

// Every rendered string, flattened — the operator's actual view of the screen.
// toJSON() is a plain serialisable tree; the test-instance graph is circular and
// must never be stringified.
const textOf = (tree) => JSON.stringify(tree.toJSON());
const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const solveButton = (tree) => buttonsOf(tree).find((b) => (b.children || []).includes("Solve"));
const buttonSaying = (tree, needle) =>
  buttonsOf(tree).find((b) => (b.children || []).some((c) => typeof c === "string" && c.includes(needle)));

beforeEach(() => {
  updateMock.mockClear();
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  paths["config/refillEngine"] = CONFIG;
  perm.permRecord = { stockRole: "warehouse" };
});

describe("a one-size product with stock at a source is solvable, exactly like a sized one", () => {
  it("SOLVE IS ARMED for a beanie once a target row exists at both seed locations", () => {
    const targets = {
      hub2: { [BEANIE]: { _: { target: 15, minQty: 14 } } },
      trophy: { [BEANIE]: { _: { target: 5, minQty: 4, reorderPoint: 0 } } },
    };
    const tree = render(targets);
    expect(solveButton(tree).props.disabled).toBe(false);
    // …and armed means armed: no "unavailable" line on the row.
    expect(textOf(tree)).not.toMatch(/Solve unavailable/);
  });

  it("the sized control is armed by the size run alone, exactly as before", () => {
    const tree = render({}, { products: JERSEY_ONLY });
    expect(solveButton(tree).props.disabled).toBe(false);
  });

  it("WITHOUT a target row the beanie stays disabled and says what it needs", () => {
    const tree = render({});
    const btn = solveButton(tree);
    expect(btn.props.disabled).toBe(true);
    const text = textOf(tree);
    expect(text).toMatch(/Solve unavailable/);
    expect(text).toMatch(/one-size/i);
    expect(text).toMatch(/target/i);
  });

  it("an explicit row keeps the beanie armed even with rule-based refills SWITCHED OFF", () => {
    // The engine still honours explicit rows when the kill switch is off, so
    // Solve must not grey them — while the rule-only jersey correctly goes dark.
    paths["config/refillEngine"] = { ...CONFIG, ruleBasedTargets: false };
    const armed = render({
      hub2: { [BEANIE]: { _: { target: 15 } } },
      trophy: { [BEANIE]: { _: { target: 5 } } },
    });
    expect(solveButton(armed).props.disabled).toBe(false);
    // …while the rule-only jersey correctly goes dark, and says which switch.
    const jersey = render({}, { products: JERSEY_ONLY });
    expect(solveButton(jersey).props.disabled).toBe(true);
    expect(textOf(jersey)).toMatch(/switched off/i);
  });
});

describe("a one-size product with NO stock anywhere stays disabled and says so", () => {
  it("is not even a card — nothing upstream means nothing stranded", () => {
    // The honest form of "no stock anywhere" in this tab: the row does not exist,
    // because a card is built from real source units. Asserted so a future change
    // that starts listing zero-stock products is forced to confront this test.
    const empty = { central: { [BEANIE]: { _: cell(0) } } };
    const cards = computeMissingProducts({ allStock: empty, products: PRODUCTS });
    expect(cards.find((c) => c.pid === BEANIE)).toBeUndefined();
    const tree = render({}, { stock: empty });
    expect(textOf(tree)).toMatch(/No stranded products/);
  });

  it("a card whose source stock vanished underneath the operator says 'no stock at any source'", () => {
    // Reachable when another till empties the source while this screen is open:
    // the card list is a snapshot, the reason is computed from live units.
    expect(solveReason({
      canAct: true, configLoaded: true, targetsLoaded: true, hasSourceStock: false,
      policyAtAnyStore: true, ruleOnAnywhere: true,
    })).toMatch(/No stock at any source/);
  });
});

describe("no disabled action is silent", () => {
  it("a viewer with no stock role is told, on the row, for every action", () => {
    perm.permRecord = { stockRole: null };
    const tree = render({});
    const text = textOf(tree);
    expect(solveButton(tree).props.disabled).toBe(true);
    expect(text).toMatch(/stock role/i);
  });

  it("a config that failed to load names itself rather than blaming the product", () => {
    // onValue's error path sets cfgErr — simulated by the component's fail-safe
    // shape: config present but empty, with the error flag raised via a null read.
    paths["config/refillEngine"] = null;
    const tree = render({});
    expect(textOf(tree)).toMatch(/Solve unavailable/);
  });

  it("targets still loading is a 'one moment', never a false 'no policy'", () => {
    // NOT ANSWERED YET — distinct from "answered with an empty node", which is
    // also a null value and which must NOT read as loading (see the
    // empty-or-unreadable block below).
    const tree = render(null, { settled: false });
    expect(solveButton(tree).props.disabled).toBe(true);
    expect(textOf(tree)).toMatch(/one moment/i);
    // Crucially it must NOT accuse the product of having no policy.
    expect(textOf(tree)).not.toMatch(/No refill policy/);
  });

  it("every disabled button on the screen carries a reason", () => {
    // The structural guard: walk the rendered tree and assert that no button is
    // disabled without a title (the reason) — the contract actionReasons.js
    // exists to make unbreakable.
    perm.permRecord = { stockRole: null };
    const tree = render({});
    const disabled = tree.root.findAll((n) => n.type === "button" && n.props.disabled);
    expect(disabled.length).toBeGreaterThan(0);
    for (const b of disabled) {
      expect(typeof b.props.title, `a disabled button rendered with no reason: ${JSON.stringify(b.children)}`).toBe("string");
      expect(b.props.title.length).toBeGreaterThan(10);
    }
  });
});

describe("an empty or unreadable /stock_targets must not disable everything", () => {
  // RTDB returns null for an EMPTY node, for one that has not answered, and for a
  // DENIED read. Gating Solve on the value greyed every clothing product — sized
  // ones included, which never needed a target row — behind a permanent
  // "still loading". Gate on SETTLED, and degrade on error. (Kimi, PR #342.)
  it("an EMPTY targets node still lets the size run arm a sized product", () => {
    const tree = render(null, { products: JERSEY_ONLY, settled: true });
    expect(solveButton(tree).props.disabled).toBe(false);
  });

  it("a FAILED targets read leaves rule-based solving working", () => {
    const tree = render(null, { products: JERSEY_ONLY, settled: true, error: true });
    expect(solveButton(tree).props.disabled).toBe(false);
  });

  it("a FAILED targets read blames the read, not the product", () => {
    // The beanie is explicit-row-only, so it genuinely stays greyed — but the
    // reason must say the settings could not be read, not "no policy covers this".
    const tree = render(null, { settled: true, error: true });
    const btn = solveButton(tree);
    expect(btn.props.disabled).toBe(true);
    expect(btn.props.title).toMatch(/Can't read the refill settings/);
    expect(btn.props.title).not.toMatch(/No refill policy covers/);
  });
});

describe("the store the panel names is the store the write uses", () => {
  // Asymmetric policy — a target row at Trophy but NOT at Marathon PE, exactly
  // what a per-shop beanie policy creates. The panel pre-selects the first
  // QUALIFYING store (Trophy); solve() used STORES[0] (Marathon PE), found no
  // qualifying sizes and returned silently. A button reading "Solve — carry at
  // Trophy" that does nothing and says nothing. (Kimi, PR #342.)
  const TROPHY_ONLY = {
    hub2: { [BEANIE]: { _: { target: 15 } } },
    trophy: { [BEANIE]: { _: { target: 5 } } },
  };

  it("seeds the store shown on the button, not STORES[0]", async () => {
    const tree = render(TROPHY_ONLY);
    expect(solveButton(tree).props.disabled).toBe(false);
    await act(async () => { solveButton(tree).props.onClick(); });
    // The confirm button names Trophy…
    expect(buttonSaying(tree, "Solve — carry at Trophy")).toBeDefined();
    await act(async () => { buttonSaying(tree, "Solve — carry at Trophy").props.onClick(); });
    // …and the write must be Trophy's, with nothing written for Marathon PE.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const keys = Object.keys(updateMock.mock.calls[0][1]);
    expect(keys.sort()).toEqual([`stock/hub2/${BEANIE}/_`, `stock/trophy/${BEANIE}/_`]);
    expect(keys.some((k) => k.includes("marathon-pe"))).toBe(false);
    expect(textOf(tree)).toMatch(/Carrying 1 size at Trophy/);
  });
});

describe("wording only fits the product it describes", () => {
  it("a product with NO usable catalogue size is not called 'one-size'", () => {
    // `.every` is vacuously true on an empty list, and catalogSizes drops blanks,
    // so this product would have been told to set a target for a size it does not
    // have. (Sonnet review, PR #342.)
    const BLANK = "blank1";
    const tree = render({}, {
      products: [{ id: BLANK, name: "Blank Size Item", productType: "clothing", sizes: ["   "] }],
      stock: { central: { [BLANK]: { _: cell(4) } } },
    });
    const btn = solveButton(tree);
    expect(btn.props.disabled).toBe(true);
    expect(btn.props.title).toMatch(/No refill policy/);
    expect(btn.props.title).not.toMatch(/one-size/i);
  });
});

describe("the coverage estimate reads the cell the stock is actually in", () => {
  // The sibling of the sneaker defect, on the clothing side: the confirm panel
  // asks "how much of this does Central hold?" by indexing the DECODED cell map.
  // Indexing it with the RAW catalogue size is right for letters and for "_" and
  // wrong for anything that encodes — a padded " 8" lives in the cell "_8" — and
  // the miss is silent, reading as zero cover rather than as an error.
  const PADDED = "padded1";
  const PADDED_PRODUCT = [{ id: PADDED, name: "Odd Size Cap", productType: "clothing", sizes: [" 8"] }];
  const PADDED_STOCK = { central: { [PADDED]: { _8: cell(6) } } };
  const PADDED_TARGETS = {
    hub2: { [PADDED]: { _8: { target: 4 } } },
    trophy: { [PADDED]: { _8: { target: 2 } } },
  };

  it("reports Central's real cover, not a silent zero", () => {
    const tree = render(PADDED_TARGETS, { products: PADDED_PRODUCT, stock: PADDED_STOCK });
    act(() => { solveButton(tree).props.onClick(); });
    act(() => { buttonSaying(tree, "Trophy").props.onClick(); });
    // Hub 2 wants 4; Central holds 6, so it covers all 4 → the "covers ✓" branch.
    const text = textOf(tree);
    expect(text).toMatch(/covers/);
    expect(text).not.toMatch(/Central has 0\/4/);
  });
});

describe("perfume — visible, and solvable against the correct hub (2026-08-13)", () => {
  // A perfume exactly as the catalogue holds one: categoryKey "perfumes", NO
  // productType (the form can't create them), one-size. Before the isPerfume
  // gate these products were invisible in this tab in every state — absent, not
  // greyed — so 288 units sat stranded at Central with no path out.
  const SCENT = "scent1";
  const SCENT_ONLY = [{ id: SCENT, name: "Gentleman Givenchy perfume", category: "Perfume", subcategory: "Perfume", categoryKey: "perfumes", sizes: ["_"] }];
  const SCENT_STOCK = { central: { [SCENT]: { _: cell(48) } } };
  // The live perfume policy shape (perfume-targets-2026-07-28): rows at
  // marathon-pe and hub2 ONLY — Trophy carries no perfume and must not qualify.
  const SCENT_ROWS = {
    hub2: { [SCENT]: { _: { target: 10, minQty: 5, reorderPoint: 5 } } },
    "marathon-pe": { [SCENT]: { _: { target: 8, minQty: 4, reorderPoint: 3 } } },
  };
  const renderScent = (targets, over = {}) => render(targets, { products: SCENT_ONLY, stock: SCENT_STOCK, category: "perfume", ...over });

  it("a stranded perfume RENDERS as a card under its own tab", () => {
    const cards = computeMissingProducts({ allStock: SCENT_STOCK, products: SCENT_ONLY });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ pid: SCENT, source: "central", group: "perfume", units: 48 });
    let tree;
    act(() => {
      tree = TestRenderer.create(
        <NetworkTransfer products={SCENT_ONLY} category="perfume" allStock={SCENT_STOCK} cards={cards}
          targets={SCENT_ROWS} targetsSettled={true} targetsError={false} />
      );
    });
    expect(textOf(tree)).toMatch(/Gentleman Givenchy perfume/);
  });

  it("with its explicit rows, Solve is ARMED and pre-selects Marathon PE — the shop the rows name", () => {
    const tree = renderScent(SCENT_ROWS);
    expect(solveButton(tree).props.disabled).toBe(false);
    act(() => { solveButton(tree).props.onClick(); });
    // Trophy has no perfume row, so the qualifying store is Marathon PE.
    expect(buttonSaying(tree, "Solve — carry at Marathon PE")).toBeDefined();
  });

  it("Central-stranded perfume seeds Hub 2 AND the shop, on the '_' sentinel, and writes no target row", async () => {
    const tree = renderScent(SCENT_ROWS);
    await act(async () => { solveButton(tree).props.onClick(); });
    await act(async () => { buttonSaying(tree, "Solve — carry at Marathon PE").props.onClick(); });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0][1];
    const keys = Object.keys(payload);
    // The correct hub leg: central-stranded → hub2 + shop, never Trophy.
    expect(keys.sort()).toEqual([`stock/hub2/${SCENT}/_`, `stock/marathon-pe/${SCENT}/_`]);
    for (const k of keys) {
      expect(k.endsWith("/_")).toBe(true);           // the sentinel IS the cell key
      expect(k).not.toMatch(/^stock_targets/);       // Solve never arms policy
      expect(payload[k]).toMatchObject({ qty: 0, v: 0, mv: "seed" });
    }
  });

  it("WITHOUT rows the perfume is VISIBLE but greyed, and says it needs a target", () => {
    // Absent → greyed is the whole point of the change: the operator can now
    // SEE the stranded stock and read exactly what arming it takes.
    const tree = renderScent({});
    const btn = solveButton(tree);
    expect(btn.props.disabled).toBe(true);
    const text = textOf(tree);
    expect(text).toMatch(/Solve unavailable/);
    expect(text).toMatch(/one-size/i);
    expect(text).toMatch(/target/i);
  });

  it("THE MIRROR: a non-clothing card must NOT arm from the subcategory policy or the size run", () => {
    // The engine's size run and subcategory policy are both nested inside
    // isClothing(product) (refill-engine.cjs resolveTarget), so neither can ever
    // fire for a perfume. Solve must refuse them by the SAME predicate: a
    // one-size perfume whose subcategory happens to hold a live policy (Watches
    // keeps 2, applied to every catalogue size including "_") would otherwise
    // light up on a standard the engine will never apply — seed, vanish, never
    // refill. isClothing here and isClothing in the engine are the same test,
    // which is exactly what keeps the two honest for mis-filed records too: a
    // typeless record with a stray letter size is clothing to BOTH sides.
    const ODD = [{ id: SCENT, name: "Odd perfume", category: "Perfume", subcategory: "Watches", categoryKey: "perfumes", sizes: ["_"] }];
    const tree = render({}, { products: ODD, stock: SCENT_STOCK, category: "perfume" });
    const btn = solveButton(tree);
    expect(btn.props.disabled).toBe(true);
    expect(btn.props.title).toMatch(/target/i);
    // …while an explicit row still arms the same record, exactly like the engine.
    const rows = { hub2: { [SCENT]: { _: { target: 3 } } }, "marathon-pe": { [SCENT]: { _: { target: 2 } } } };
    const armed = render(rows, { products: ODD, stock: SCENT_STOCK, category: "perfume" });
    expect(solveButton(armed).props.disabled).toBe(false);
  });

  it("CATEGORY POLICY: a mapped perfume is SOLVABLE with no row at all, and seeds the mapped legs", async () => {
    // The standing policy (2026-08-13): /config/refillEngine/categoryPolicy
    // arms every product of a category with no per-product row — so a perfume
    // imported by script tomorrow renders an ARMED Solve the moment it is
    // stranded, exactly as the engine will refill it.
    paths["config/refillEngine"] = {
      ...CONFIG,
      categoryPolicy: {
        perfumes: {
          "marathon-pe": { target: 8, reorderPoint: 3, minQty: 4 },
          hub2: { target: 10, reorderPoint: 5, minQty: 5 },
        },
      },
    };
    const tree = renderScent({});          // NO /stock_targets rows anywhere
    expect(solveButton(tree).props.disabled).toBe(false);
    await act(async () => { solveButton(tree).props.onClick(); });
    // Only Marathon PE is mapped — Trophy is not a qualifying store.
    expect(buttonSaying(tree, "Solve — carry at Marathon PE")).toBeDefined();
    await act(async () => { buttonSaying(tree, "Solve — carry at Marathon PE").props.onClick(); });
    const keys = Object.keys(updateMock.mock.calls[0][1]);
    expect(keys.sort()).toEqual([`stock/hub2/${SCENT}/_`, `stock/marathon-pe/${SCENT}/_`]);
  });

  it("with the kill switch OFF, a row-less perfume still asks for a TARGET — never blames the switch", () => {
    // "Automatic refills are switched off" is a remedy sentence: it tells the
    // operator that flipping the switch will fix this row. For a perfume it
    // never will — the rule branches are nested inside isClothing on both
    // sides of the mirror — so the row must ask for the one thing that works:
    // a target row. (Sonnet review, PR #350.)
    paths["config/refillEngine"] = { ...CONFIG, ruleBasedTargets: false };
    const tree = renderScent({});
    const btn = solveButton(tree);
    expect(btn.props.disabled).toBe(true);
    expect(btn.props.title).toMatch(/target/i);
    expect(btn.props.title).not.toMatch(/switched off/i);
  });

  it("a perfume the shop already carries never becomes a card — the engine owns it from there", () => {
    const carried = { ...SCENT_STOCK, "marathon-pe": { [SCENT]: { _: cell(0) } } };
    const cards = computeMissingProducts({ allStock: carried, products: SCENT_ONLY });
    expect(cards).toHaveLength(0);
  });
});

describe("Solve writes carriage cells and NEVER a target row", () => {
  it("seeds qty-0 cells at hub2 and the store, and touches no other subtree", async () => {
    const targets = {
      hub2: { [BEANIE]: { _: { target: 15 } } },
      trophy: { [BEANIE]: { _: { target: 5 } } },
    };
    const tree = render(targets);
    // Open the panel, nominate Trophy, confirm.
    await act(async () => { solveButton(tree).props.onClick(); });
    await act(async () => { buttonSaying(tree, "Trophy").props.onClick(); });
    await act(async () => { buttonSaying(tree, "Solve — carry at").props.onClick(); });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0][1];
    const keys = Object.keys(payload);
    expect(keys.sort()).toEqual([`stock/hub2/${BEANIE}/_`, `stock/trophy/${BEANIE}/_`]);
    // THE SAFETY CLAIM: not one path outside /stock, and no target row at all.
    for (const k of keys) {
      expect(k.startsWith("stock/")).toBe(true);
      expect(k).not.toMatch(/^stock_targets/);
    }
    // New cells start at v=0 with a movement marker, per the cell contract.
    for (const k of keys) {
      expect(payload[k].qty).toBe(0);
      expect(payload[k].v).toBe(0);
      expect(payload[k].mv).toBe("seed");
    }
  });

  it("the one-size cell key is the '_' sentinel — never a display label", () => {
    // "One size" is what the operator READS; "_" is what the cell is KEYED by.
    // A label reaching a storage key once minted a phantom Free_Size cell and
    // drove hub cells negative, so the two must never be the same string.
    const targets = { hub2: { [BEANIE]: { _: { target: 15 } } }, trophy: { [BEANIE]: { _: { target: 5 } } } };
    const tree = render(targets);
    act(() => { solveButton(tree).props.onClick(); });
    const text = textOf(tree);
    expect(text).toMatch(/One size/);            // shown to the operator
    expect(text).not.toMatch(/Free.?Size/);      // never the phantom label
  });
});
