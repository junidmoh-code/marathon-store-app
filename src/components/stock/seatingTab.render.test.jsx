// ─── THE SEATING TAB — WHAT IT SHOWS, AND WHO MAY SEE IT ─────────────────────
// Read-only behaviour: the tab strip, the per-location rows, the reason each
// row gives, and GATE 2c — the tab's own super-admin check, independent of the
// tile, the route and the card's.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

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

// The live reads, stubbed at the ONE place the tab makes them.
// A held read: while HOLD names a product, its gets never resolve until
// RELEASE is called — the shape needed to land a stale response late.
let HOLD = null;
const HELD = [];
const STOCK = {
  trophy: {
    p1: { M: { qty: 4, lastType: "sold", updatedAt: "2026-08-20T09:00:00.000Z" } },
    p2: { L: { qty: 7, lastType: "received", updatedAt: "2026-08-21T09:00:00.000Z" } },
  },
  "marathon-pe": { p1: { L: { qty: 0, lastType: "transfer_out", updatedAt: "2026-08-01T09:00:00.000Z" } } },
  in_transit: { p1: { S: { qty: 2, lastType: "transfer_out", updatedAt: "2026-08-22T09:00:00.000Z" } } },
};
// Every path the tab reads, so a read it never makes is visible as an absence.
const READS = [];
const TARGETS = { "marathon-pe": { p1: { S: { target: 0, minQty: 0 }, M: { target: 0, minQty: 0 }, L: { target: 0, minQty: 0 } } } };

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    READS.push(String(r.path));
    // ── THE LOOP BREAKER ──────────────────────────────────────────────────
    // If the location lists stop being stable, `load` changes identity every
    // render and the effect re-reads /stock for ever. Throwing here does NOT
    // stop it — load() catches and calls setError, which re-renders and feeds
    // the loop again. Never RESOLVING does stop it: no setCtx, no setError, no
    // further render, so the run ends in a clean assertion failure instead of
    // a killed worker. Without this the mutation harness's own M-STABLE-LISTS
    // hangs for ever on the mutation it exists to prove.
    if (READS.length > 100) return new Promise(() => {});
    const [root, loc, pid] = String(r.path).split("/");
    const src = root === "stock" ? STOCK : root === "stock_targets" ? TARGETS : {};
    const v = src?.[loc]?.[pid];
    const snap = { exists: () => v !== undefined, val: () => v };
    if (HOLD && pid === HOLD) return new Promise((res) => HELD.push(() => res(snap)));
    return snap;
  },
  onValue: () => () => {},
  update: async () => {},
  push: () => ({ key: "mv1" }),
  child: () => ({}),
}));

// useLocations hands back a FRESH OBJECT on every render here, exactly as
// usePath can — that is the shape that turns an identity-keyed useMemo into a
// read loop, so the fixture keeps it that way deliberately.
vi.mock("./useStock", () => ({
  useLocations: () => ({
    trophy: { id: "trophy", label: "Trophy", kind: "store", sellable: true, active: true },
    "marathon-pe": { id: "marathon-pe", label: "Marathon PE", kind: "store", sellable: true, active: true },
    in_transit: { id: "in_transit", label: "In Transit", kind: "transit", active: true },
    base: { id: "base", label: "Base", kind: "warehouse", sellable: false, active: false },
  }),
  useEngineConfig: () => ({ ruleBasedTargets: true, defaultRunByStore: { trophy: { S: 1, M: 2, L: 2 }, "marathon-pe": { S: 1, M: 2, L: 2 } } }),
}));

const SeatingTab = (await import("./SeatingTab.jsx")).default;
const EnginePolicyCard = (await import("./EnginePolicyCard.jsx")).default;

const PRODUCTS = [
  { id: "p1", name: "Nike Tee Navy", sizes: ["S", "M", "L"], productType: "clothing", photoUrl: "https://x/p1.jpg" },
  { id: "p2", name: "Adidas Tee Black", sizes: ["S", "M", "L"], productType: "clothing", photoUrl: "https://x/p2.jpg" },
  // No photo at all — the row must still be usable.
  { id: "p3", name: "Puma Tee Grey", sizes: ["S", "M", "L"], productType: "clothing" },
];
const OWNER = { email: "gunidmoh@gmail.com" };
const STAFF = { email: "rashid@marathon.internal" };

const text = (tree) => JSON.stringify(tree.toJSON());
async function renderTab(props = {}) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<SeatingTab products={PRODUCTS} viewer={OWNER} flash={() => {}} {...props} />);
  });
  await act(async () => {});
  return tree;
}
const find = (tree, pred) => tree.root.findAll(pred);
const buttonSaying = (tree, label) =>
  find(tree, (n) => n.type === "button").find((b) => JSON.stringify(b.children).includes(label));

beforeEach(() => { callableMock.mockClear(); READS.length = 0; HOLD = null; HELD.length = 0; });

describe("the tab strip", () => {
  it("Engine Policy shows Categories and Seating, and starts on Categories", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    const s = text(tree);
    expect(s).toContain("Categories");
    expect(s).toContain("Seating");
  });

  it("Seating is reachable and renders the tab, not the category list", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} products={PRODUCTS} onExit={() => {}} />); });
    await act(async () => { buttonSaying(tree, "Seating").props.onClick(); });
    expect(tree.root.findAllByType(SeatingTab).length).toBe(1);
  });
});

// ── GATE 2c ──────────────────────────────────────────────────────────────────
describe("GATE 2c — the tab has its own gate", () => {
  it("the card's Seating branch is guarded by enginePolicyVisibleForViewer", () => {
    const src = readFileSync(new URL("./EnginePolicyCard.jsx", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf('tab === "seating"'), src.indexOf("<SeatingTab"));
    expect(branch).toContain("enginePolicyVisibleForViewer(viewer)");
  });

  it("a staff account never reaches the tab, whichever tab is selected", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={STAFF} products={PRODUCTS} onExit={() => {}} />); });
    expect(tree.root.findAllByType(SeatingTab).length).toBe(0);
    // The refusal wording stopped saying "owner-only" when the `engine_policy`
    // grant landed (2026-08-27) — an ungranted staff account is refused just
    // the same, and the screen now says so without naming an owner.
    expect(text(tree)).toContain("don't have access");
  });
});

describe("the rows", () => {
  it("says nothing until a product is chosen — and reads nothing", async () => {
    const tree = await renderTab();
    expect(text(tree)).toContain("Search or scan a product");
  });

  it("search finds the product by name", async () => {
    const tree = await renderTab();
    const box = tree.root.findAllByType("input")[0];
    await act(async () => { box.props.onChange({ target: { value: "navy" } }); });
    expect(text(tree)).toContain("Nike Tee Navy");
  });

  it("one row per location, each with its reason", async () => {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    const s = text(tree);
    expect(s).toContain("Trophy");
    expect(s).toContain("Marathon PE");
    // Trophy: a stocked clothing line under a live size run.
    expect(s).toContain("Size run");
    // Marathon PE: every declared size zeroed by an explicit row.
    expect(s).toContain("Switched off");
  });

  it("in_transit is never a seat", async () => {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    expect(text(tree)).not.toContain("In Transit");
  });

  it("shows the last movement, and names a sale as a sale", async () => {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    expect(text(tree)).toContain("Last sold");
  });
});

// ── THE ACTIONS ──────────────────────────────────────────────────────────────
// The default tick is the load-bearing one: it is what tells "this shop should
// not carry this line" apart from "both shops should".
describe("the actions on a row", () => {
  async function openRow(name) {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    // Trophy is the first row and it holds 4 units.
    await act(async () => { buttonSaying(tree, "Change").props.onClick(); });
    return tree;
  }

  it("offers Switch off and Move and switch off, and no bulk button", async () => {
    const tree = await openRow();
    const s = text(tree);
    expect(s).toContain("Switch off");
    expect(s).toContain("Move and switch off");
    for (const bulk of ["All locations", "Switch off all", "Apply to all", "Select all"]) {
      expect(s).not.toContain(bulk);
    }
  });

  it("refuses to switch off a row holding units, and says how many", async () => {
    const tree = await openRow();
    expect(text(tree)).toContain("4 units here");
    const off = buttonSaying(tree, "Switch off");
    expect(off.props.disabled).toBe(true);
  });

  it("SWITCH OFF THE SOURCE IS TICKED BY DEFAULT", async () => {
    const tree = await openRow();
    await act(async () => { buttonSaying(tree, "Move and switch off").props.onClick(); });
    const tick = tree.root.findAll((n) => n.type === "input" && n.props.type === "checkbox")[0];
    expect(tick).toBeTruthy();
    expect(tick.props.checked).toBe(true);
  });

  it("and it can be un-ticked — two shops may genuinely carry one line", async () => {
    const tree = await openRow();
    await act(async () => { buttonSaying(tree, "Move and switch off").props.onClick(); });
    const tick = () => tree.root.findAll((n) => n.type === "input" && n.props.type === "checkbox")[0];
    await act(async () => { tick().props.onChange({ target: { checked: false } }); });
    expect(tick().props.checked).toBe(false);
    expect(text(tree)).toContain("Move only");
  });

  it("shows every size line before the confirm", async () => {
    const tree = await openRow();
    await act(async () => { buttonSaying(tree, "Move and switch off").props.onClick(); });
    // One cell holds units at Trophy (M: 4), so exactly one line is offered.
    expect(text(tree)).toContain("size");
    expect(text(tree)).toContain("out of");
    expect(text(tree)).toContain("Trophy");
  });
});

// ── A RE-RENDER MUST NOT MEAN A RE-READ ──────────────────────────────────────
// `load` depends on contextLocations and an effect depends on `load`. Keyed on
// the registry OBJECT, a hook that returns a fresh object render would re-read
// /stock on every render — a request loop against a shop's network. The lists
// are keyed on a signature instead. (CodeRabbit full review, PR #429.)
describe("the location lists are stable across renders", () => {
  // ── THE SOURCE-LEVEL PIN COMES FIRST, AND IT IS THE LOAD-BEARING ONE ───────
  //
  // When this property breaks, `load` changes identity on every render and the
  // effect re-reads /stock in a loop. That does not FAIL the behavioural tests
  // below — it kills the vitest worker, and a dead worker is indistinguishable
  // from a slow CI run. A thrown error inside the mocked `get` does not help
  // either: load() catches it and calls setError, so the loop simply carries on
  // reporting errors to nobody.
  //
  // Twice on this branch a killed mutation harness left `[registry]` in the
  // file and `git add -A` committed it, and both times the only symptom was a
  // suite that stopped producing output. This assertion needs no render, runs
  // in microseconds, and names the exact line. (Adversarial re-review, #429.)
  it("the memo depends on the signature, never on the registry object", () => {
    const src = readFileSync(new URL("./SeatingTab.jsx", import.meta.url), "utf8");
    expect(src).toContain("}, [locSig]);");
    expect(src).not.toContain("}, [registry]);");
  });

  it("selecting a product reads each path once, not once per render", async () => {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    const trophyReads = READS.filter((p) => p === "stock/trophy/p1").length;
    expect(trophyReads).toBe(1);
  });

  it("and further renders add no reads at all", async () => {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    const after = READS.length;
    // a pure re-render: open a row, close it again
    await act(async () => { buttonSaying(tree, "Change").props.onClick(); });
    await act(async () => { buttonSaying(tree, "Close").props.onClick(); });
    expect(READS.length).toBe(after);
  });
});

// ── RE-SELECTING THE SAME PRODUCT ────────────────────────────────────────────
// setPid is a no-op when the value is unchanged, so the effect never refired —
// but setCtx(null) had already thrown the rows away, and the screen sat empty
// until the product was changed and changed back. (CodeRabbit, PR #429.)
describe("choosing the product that is already open", () => {
  it("keeps its rows on screen and re-reads", async () => {
    const tree = await renderTab();
    const search = async (q) => {
      await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: q } }); });
    };
    await search("navy");
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    expect(text(tree)).toContain("Trophy");

    const before = READS.length;
    await search("navy");
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    // the rows are still there...
    expect(text(tree)).toContain("Trophy");
    expect(text(tree)).toContain("Size run");
    // ...and it actually re-read rather than silently doing nothing
    expect(READS.length).toBeGreaterThan(before);
  });
});

// ── PHOTOS IN THE SEARCH RESULTS ─────────────────────────────────────────────
// Owner request: see the picture BEFORE opening the product, and be able to
// open the picture. The catalogue makes this load-bearing — colourway siblings
// share a style code and twins share a name — so a text-only list asks the
// operator to pick blind.
describe("the search results carry photos", () => {
  const searchFor = async (tree, q) => {
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: q } }); });
  };
  const imgs = (tree) => tree.root.findAllByType("img");

  it("shows a thumbnail next to each match, before anything is opened", async () => {
    const tree = await renderTab();
    await searchFor(tree, "tee");
    const srcs = imgs(tree).map((i) => i.props.src);
    expect(srcs).toContain("https://x/p1.jpg");
    expect(srcs).toContain("https://x/p2.jpg");
    // and nothing has been selected yet
    expect(text(tree)).not.toContain("on hand");
    expect(READS).toHaveLength(0);
  });

  it("a product with no photo still lists and still selects", async () => {
    const tree = await renderTab();
    await searchFor(tree, "puma");
    expect(text(tree)).toContain("Puma Tee Grey");
    await act(async () => { buttonSaying(tree, "Puma Tee Grey").props.onClick(); });
    await act(async () => {});
    expect(READS.length).toBeGreaterThan(0);
  });

  it("TAPPING THE PHOTO OPENS IT AND SELECTS NOTHING", async () => {
    const tree = await renderTab();
    await searchFor(tree, "navy");
    const thumb = imgs(tree).find((i) => i.props.src === "https://x/p1.jpg");
    await act(async () => { thumb.props.onClick({ stopPropagation: () => {} }); });
    // NOTE ON WHAT THIS PROVES. Here the protection is STRUCTURAL — the thumb
    // is a sibling of the row's button, so the click has no path to it.
    // Asserting that stopPropagation was called would prove only that a method
    // was invoked on an object this test handed over; the contract it actually
    // serves is for nested callers and is tested in
    // photoWidgets.render.test.jsx. What matters here is the outcome:
    expect(READS).toHaveLength(0);
    expect(text(tree)).not.toContain("on hand");
    // ...and the picture is open, full size
    const big = imgs(tree).find((i) => i.props.style?.maxHeight === "100%");
    expect(big).toBeTruthy();
    expect(big.props.src).toBe("https://x/p1.jpg");
  });

  it("the opened photo closes again", async () => {
    const tree = await renderTab();
    await searchFor(tree, "navy");
    const thumb = imgs(tree).find((i) => i.props.src === "https://x/p1.jpg");
    await act(async () => { thumb.props.onClick({ stopPropagation: () => {} }); });
    const dialog = tree.root.findAll((n) => n.props?.role === "dialog")[0];
    expect(dialog).toBeTruthy();
    await act(async () => { dialog.props.onClick(); });
    expect(tree.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(0);
  });

  it("the OPEN product's own photo opens too", async () => {
    const tree = await renderTab();
    await searchFor(tree, "navy");
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    const card = imgs(tree).find((i) => i.props.src === "https://x/p1.jpg");
    expect(card).toBeTruthy();
    // ProductCard puts the handler on the wrapper, not the img
    const tap = tree.root.findAll((n) => typeof n.props?.onClick === "function"
      && n.props?.style?.cursor === "zoom-in")[0];
    expect(tap).toBeTruthy();
    await act(async () => { tap.props.onClick(); });
    expect(tree.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(1);
  });
});

// ── SWITCHING PRODUCT WITH A READ IN FLIGHT ──────────────────────────────────
// The END STATE is what this asserts, and it holds: product 2's rows, product
// 1's numbers nowhere.
//
// BE PRECISE ABOUT WHAT IS *NOT* PROVED HERE. CodeRabbit asked for the
// loadSeq bump in `choose` because load()'s own bump happens inside the effect,
// which React schedules after the commit, while a pending read's continuation
// is a microtask and runs first — so product 1's response can land while the
// sequence number still matches, under product 2's name.
//
// The bump is in (SeatingTab.jsx, `choose`) and it is correct. This test does
// NOT demonstrate it: removing the bump leaves this test green, because the
// effect's own load(p2) overwrites whatever landed, so the settled state is
// identical either way and only a transient frame differs — which
// react-test-renderer cannot observe. It is therefore a reasoned tightening,
// not a proved guard, and it deliberately has no mutation entry: a guard that
// passes when its property is removed would be worse than none.
// (CodeRabbit, PR #429.)
describe("switching product while a read is in flight", () => {
  it("discards the previous product's response", async () => {
    const tree = await renderTab();
    const pick = async (q, name) => {
      await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: q } }); });
      await act(async () => { buttonSaying(tree, name).props.onClick(); });
    };

    // Product 1's reads are held open.
    HOLD = "p1";
    await pick("navy", "Nike Tee Navy");
    await act(async () => {});
    expect(HELD.length).toBeGreaterThan(0);

    // Switch to product 2 and let product 1's reads land IN THE SAME TICK,
    // before the passive effect that starts product 2's read has run. That is
    // the actual gap: load()'s own sequence bump happens inside the effect,
    // which React schedules after the commit, while a pending promise's
    // continuation is a microtask and runs first.
    HOLD = null;
    await act(async () => {
      tree.root.findAllByType("input")[0].props.onChange({ target: { value: "adidas" } });
    });
    await act(async () => {
      buttonSaying(tree, "Adidas Tee Black").props.onClick();
      HELD.forEach((r) => r());
    });
    await act(async () => {});

    const s = text(tree);
    expect(s).toContain("Adidas Tee Black");
    expect(s).not.toContain("Nike Tee Navy");
    // p2 holds 7 at Trophy; p1's 4 must never be what is shown. The badge
    // renders the number and the label as separate children, hence the shape.
    const onHand = (t) => `["${t}"," on hand"]`;
    expect(s).toContain(onHand(7));
    expect(s).not.toContain(onHand(4));
  });
});

// ── THE CONTEXT IS WIDER THAN THE ROWS ───────────────────────────────────────
// Rows are the places a product can be SEATED. The carriage CONTEXT is every
// location that can hold a cell, because the engine's dead-size rule counts
// units anywhere — feeding the mirror a partial snapshot makes a size whose
// only units are in transit read as dead. (Found in review, PR #429.)
describe("the carriage context covers every location that can hold a cell", () => {
  async function loadProduct() {
    const tree = await renderTab();
    await act(async () => { tree.root.findAllByType("input")[0].props.onChange({ target: { value: "navy" } }); });
    await act(async () => { buttonSaying(tree, "Nike Tee Navy").props.onClick(); });
    await act(async () => {});
    return tree;
  }

  it("reads in_transit and a DEACTIVATED warehouse, not merely the seatable ones", async () => {
    await loadProduct();
    expect(READS).toContain("stock/in_transit/p1");
    expect(READS).toContain("stock/base/p1");
    expect(READS).toContain("stock/trophy/p1");
  });

  it("but never offers them as a seat", async () => {
    const tree = await loadProduct();
    const s = text(tree);
    expect(s).not.toContain("In Transit");
    expect(s).not.toContain("Base");
  });

  it("and never offers them as a destination either", async () => {
    const tree = await loadProduct();
    await act(async () => { buttonSaying(tree, "Change").props.onClick(); });
    await act(async () => { buttonSaying(tree, "Move and switch off").props.onClick(); });
    const s = text(tree);
    expect(s).toContain("Marathon PE");     // a real destination is offered
    expect(s).not.toContain("In Transit");  // these are not
    expect(s).not.toContain("Base");
  });
});

// ── NO WHOLE-NODE READS ──────────────────────────────────────────────────────
// The rule is structural, so the check is too: every read this file makes must
// name a location AND a product.
describe("reads are scoped", () => {
  // The reader lives in seatingStore.js — the move path re-reads through the
  // SAME function the tab renders from, so the two cannot drift.
  const SRC = {
    "SeatingTab.jsx": readFileSync(new URL("./SeatingTab.jsx", import.meta.url), "utf8"),
    "seatingStore.js": readFileSync(new URL("./seatingStore.js", import.meta.url), "utf8"),
  };

  it("no file in this feature asks for /stock or /stock_targets whole", () => {
    for (const [name, src] of Object.entries(SRC)) {
      for (const bad of ['ref(database, "stock")', 'ref(database, "stock_targets")', "`stock`", "`stock_targets`"]) {
        expect(src, `${name} must not contain ${bad}`).not.toContain(bad);
      }
    }
  });

  it("every read names a location AND a product", () => {
    expect(SRC["seatingStore.js"]).toContain("stock/${loc}/${pid}");
    expect(SRC["seatingStore.js"]).toContain("stock_targets/${loc}/${pid}");
    // and the tab makes none of its own
    expect(SRC["SeatingTab.jsx"]).toContain("readSeatingContext");
  });
});
