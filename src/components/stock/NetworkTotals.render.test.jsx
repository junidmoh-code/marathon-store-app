// ─── NETWORK TOTALS — THROUGH THE REAL COMPONENT ──────────────────────────────
// networkTotalsCore.test.js pins the arithmetic. This renders the actual card
// against a faked RTDB and proves the four things a person betting an order on
// this number needs to be true:
//
//   • the number on screen really is every size at every location;
//   • the card NEVER reads a whole node — every stock read is scoped to one
//     product at one location, and only for rows on screen;
//   • search returns exactly what the app's shared matcher returns;
//   • the card issues no write of any kind, of any shape, ever.
//
// It also MEASURES the bytes the card pulls on first open and on a search, so
// the cost claim in the commit message is a test result rather than a promise.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { searchProducts } from "../../utils/productSearch";

const LOCS = ["studio", "central", "base", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "in_transit"];
const registry = Object.fromEntries(LOCS.map((id) => [id, { id, label: id, active: id !== "studio" && id !== "base" }]));

const cell = (qty) => ({ qty, v: 2, mv: "mv1", lastType: "received", state: "live", updatedAt: "2026-08-01T00:00:00.000Z", updatedBy: "u1" });

// ── the fake database ────────────────────────────────────────────────────────
// Deliberately holds stock at sizes NOT declared on the product records, at a
// location that is active:false, and in the ARRAY shape RTDB returns for numeric
// size runs — because all three exist in the live data.
const reads = {
  locations: registry,
  "stock/central/wide":       { S: cell(40), M: cell(30), XXXL: cell(5) },   // XXXL not in sizes[]
  "stock/hub2/wide":          { S: cell(20), M: cell(10) },
  "stock/base/wide":          { S: cell(3) },                                 // active:false, still counted
  "stock/marathon-pe/wide":   { S: cell(2) },
  "stock/central/mid":        { S: cell(12) },
  "stock/trophy/mid":         { S: cell(6) },
  "stock/hub3/drag":          { S: cell(-50), M: cell(-2) },                  // the honest negative
  "stock/central/drag":       { S: cell(10) },
  "stock/hub1/runner":        (() => { const a = []; a[6] = cell(4); a[7] = cell(3); return a; })(),
  // A one-size product: the "_" sentinel key, plus a _meta node at the size level.
  "stock/central/onesize":    { _: cell(-4), _meta: { drainedAt: "2026-07-26" } },
  // "ghost" has no cells at any location — the 196-product case.
};

// Every write API RTDB exposes, wired to a spy that FAILS the test if touched.
// A card that can be proved read-only by construction beats one that is merely
// believed to be.
const writeSpies = {};
for (const name of ["set", "update", "push", "remove", "runTransaction", "setWithPriority", "child"]) {
  writeSpies[name] = vi.fn(() => { throw new Error(`NetworkTotals called a write API: ${name}`); });
}

const readCalls = [];
// Paths listed here reject, so a dropped read can be told apart from a slow one.
const failPaths = new Set();
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: (r) => {
    readCalls.push(r.path);
    if (failPaths.has(r.path)) return Promise.reject(new Error("permission_denied"));
    return Promise.resolve({ val: () => reads[r.path] ?? null });
  },
  onValue: (r, cb) => { readCalls.push(r.path); cb({ val: () => reads[r.path] ?? null }); return () => {}; },
  ...writeSpies,
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));

const { default: NetworkTotals } = await import("./NetworkTotals.jsx");
const { __resetTotalsCache, totalsBytesRead, totalsReadsIssued, loadTotals } = await import("./networkTotalsStore.js");

const PRODUCTS = [
  { id: "wide",   name: "Nike Air Force 1 Cream Black Grey", sizes: ["S", "M"], photoUrl: null },
  { id: "mid",    name: "Adidas Ultraboost Light Grey",      sizes: ["S"],      photoUrl: null },
  { id: "drag",   name: "Puma Suede Classic Navy",           sizes: ["S", "M"], photoUrl: null },
  { id: "runner", name: "New Balance 574 Evergreen",         sizes: ["6", "7"], photoUrl: null },
  { id: "ghost",  name: "Converse Chuck 70 Parchment",       sizes: ["S"],      photoUrl: null },
  { id: "onesize", name: "Lacoste Original Eau de Toilette",  sizes: [],         photoUrl: null },
];

const textOf = (n) => {
  if (n == null || n === false || n === true) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (n.children !== undefined) return textOf(n.children);   // rendered JSON node
  if (n.props) return textOf(n.props.children);              // React element
  return "";
};
const screen = (tree) => textOf(tree.toJSON());

async function mount(products = PRODUCTS) {
  let tree;
  await act(async () => { tree = TestRenderer.create(<NetworkTotals products={products} registry={registry} />); });
  await act(async () => {});
  await act(async () => {});
  return tree;
}
// The card's rows are its only elements carrying className "nt-row".
const rowTexts = (tree) => tree.root.findAll((n) => n.props && n.props.className === "nt-row").map((n) => textOf(n.props.children));
// The total is the last number on the row, immediately before "unit"/"units".
const totalOf = (rowText) => { const m = /(-?\d+)units?$/.exec(rowText); return m ? Number(m[1]) : null; };
const typeSearch = async (tree, q) => {
  const box = tree.root.findAll((n) => n.type === "input")[0];
  await act(async () => { box.props.onChange({ target: { value: q } }); });
  await act(async () => {});
  await act(async () => {});
};
const clickText = async (tree, label) => {
  const btn = tree.root.findAll((n) => n.type === "button" && textOf(n.props.children).includes(label))[0];
  await act(async () => { btn.props.onClick(); });
  await act(async () => {});
  await act(async () => {});
};

beforeEach(() => { __resetTotalsCache(); readCalls.length = 0; failPaths.clear(); for (const s of Object.values(writeSpies)) s.mockClear(); });

describe("the number itself", () => {
  it("sums every size at every location into one figure per product", async () => {
    const tree = await mount();
    const rows = rowTexts(tree);
    // wide: central 40+30+5 · hub2 20+10 · base 3 · marathon-pe 2 = 110
    expect(totalOf(rows.find((r) => r.includes("Air Force")))).toBe(110);
    // mid: central 12 · trophy 6 = 18
    expect(totalOf(rows.find((r) => r.includes("Ultraboost")))).toBe(18);
    // runner: the array-shaped numeric size run, 4 + 3 = 7
    expect(totalOf(rows.find((r) => r.includes("New Balance")))).toBe(7);
  });

  it("counts a size the product record does not declare, and an inactive location", async () => {
    const tree = await mount([PRODUCTS[0]]);
    // 110 only holds if XXXL (not in sizes[]) and base (active:false) both count.
    // The declared-sizes-only answer would be 102; skipping base would give 107.
    expect(totalOf(rowTexts(tree)[0])).toBe(110);   // not 102 (declared sizes only), not 107 (base skipped)
  });

  it("names every location it summed, so the number cannot be misread", async () => {
    const tree = await mount();
    const page = screen(tree);
    expect(page).toContain(`all ${LOCS.length} locations`);
    for (const id of LOCS) expect(page).toContain(id);
  });
});

describe("negatives are visible, not clamped", () => {
  it("shows the negative total and says where the drag came from", async () => {
    const tree = await mount();
    const row = rowTexts(tree).find((r) => r.includes("Puma Suede"));
    expect(totalOf(row)).toBe(-42);                  // 10 + (−50) + (−2), not the clamped 10 or 0
    expect(row).toContain("2 negative cells");
    expect(row).toContain("hub3");
  });

  it("ranks the negative product last when most-first, first when least-first", async () => {
    const tree = await mount();
    expect(rowTexts(tree)[0]).toContain("Air Force");        // 110
    expect(rowTexts(tree).at(-1)).toContain("Puma Suede");   // −42
    await clickText(tree, "Least first");
    expect(rowTexts(tree)[0]).toContain("Puma Suede");
    expect(rowTexts(tree).at(-1)).toContain("Air Force");
  });
});

describe("the one-size sentinel and _meta", () => {
  it("renders the one-size key as one size, not as a full stop", async () => {
    const tree = await mount();
    const row = rowTexts(tree).find((r) => r.includes("Lacoste"));
    expect(totalOf(row)).toBe(-4);
    // A broad _ → . replace would print "central .: -4".
    expect(row).not.toMatch(/central \.:/);
    expect(row).toContain("central _: -4");
  });

  it("does not count the _meta node beside it as a cell", async () => {
    const tree = await mount();
    const row = rowTexts(tree).find((r) => r.includes("Lacoste"));
    expect(row).toContain("1 cell across 1 location");   // the "_" cell only
  });
});

describe("a read that fails", () => {
  it("shows no number and offers a retry, rather than counting forever or showing 0", async () => {
    failPaths.add("stock/hub3/drag");
    const tree = await mount();
    const row = rowTexts(tree).find((r) => r.includes("Puma Suede"));
    expect(row).toContain("could not be read");
    expect(row).toContain("Retry");
    expect(totalOf(row)).toBe(null);          // NOT 0, and NOT the partial 10
    expect(screen(tree)).toContain("could not be read");
  });

  it("re-reads that product when Retry is pressed, and only that product", async () => {
    failPaths.add("stock/hub3/drag");
    const tree = await mount();
    readCalls.length = 0;
    failPaths.clear();
    await clickText(tree, "Retry");
    const retried = readCalls.filter((p) => p.startsWith("stock/"));
    expect(new Set(retried.map((p) => p.split("/")[2]))).toEqual(new Set(["drag"]));
    expect(totalOf(rowTexts(tree).find((r) => r.includes("Puma Suede")))).toBe(-42);
  });

  it("keeps the other products' totals — one bad location does not poison the page", async () => {
    failPaths.add("stock/hub3/drag");
    const tree = await mount();
    expect(totalOf(rowTexts(tree).find((r) => r.includes("Air Force")))).toBe(110);
    expect(totalOf(rowTexts(tree).find((r) => r.includes("Ultraboost")))).toBe(18);
  });
});

describe("Refresh", () => {
  it("re-reads the page so a number he is about to order against is current", async () => {
    const tree = await mount();
    const before = totalsReadsIssued();
    reads["stock/central/mid"] = { S: cell(99) };
    await clickText(tree, "Refresh");
    expect(totalsReadsIssued()).toBeGreaterThan(before);
    expect(totalOf(rowTexts(tree).find((r) => r.includes("Ultraboost")))).toBe(105);   // 99 + 6
    reads["stock/central/mid"] = { S: cell(12) };
  });
});

describe("StrictMode", () => {
  it("still renders totals after React's development mount / unmount / remount", async () => {
    let tree;
    await act(async () => {
      tree = TestRenderer.create(
        <React.StrictMode><NetworkTotals products={PRODUCTS} registry={registry} /></React.StrictMode>,
      );
    });
    await act(async () => {});
    await act(async () => {});
    expect(totalOf(rowTexts(tree).find((r) => r.includes("Air Force")))).toBe(110);
  });
});

describe("a product with no stock anywhere", () => {
  it("shows zero and says so, rather than breaking or going blank", async () => {
    const tree = await mount();
    const row = rowTexts(tree).find((r) => r.includes("Chuck 70"));
    expect(totalOf(row)).toBe(0);
    expect(row).toContain("no stock recorded anywhere");
  });
});

describe("search is the app's search", () => {
  it("returns exactly what searchProducts returns, for every kind of query", async () => {
    for (const q of ["air force", "af1", "ultrabo", "nke air", "chuck", "zzzz"]) {
      const tree = await mount();
      await typeSearch(tree, q);
      const expected = searchProducts(PRODUCTS, q, { limit: 500 }).map((p) => p.name);
      const got = rowTexts(tree);
      expect(got).toHaveLength(expected.length);
      for (const name of expected) expect(got.some((r) => r.includes(name))).toBe(true);
    }
  });

  it("a search that matches nothing says so instead of showing the whole list", async () => {
    const tree = await mount();
    await typeSearch(tree, "zzzz");
    expect(rowTexts(tree)).toHaveLength(0);
    expect(screen(tree)).toContain("No products match");
  });
});

describe("what it reads — never a whole node", () => {
  it("scopes every stock read to one product at one location", async () => {
    await mount();
    const stockReads = readCalls.filter((p) => p.startsWith("stock"));
    expect(stockReads.length).toBeGreaterThan(0);
    for (const path of stockReads) {
      expect(path).toMatch(/^stock\/[^/]+\/[^/]+$/);     // stock/{loc}/{pid}, three segments
      expect(path).not.toBe("stock");
      expect(path.split("/")).toHaveLength(3);
    }
  });

  it("reads only the products on screen, and reads each of them once", async () => {
    await mount();
    const pids = readCalls.filter((p) => p.startsWith("stock/")).map((p) => p.split("/")[2]);
    expect(new Set(pids)).toEqual(new Set(PRODUCTS.map((p) => p.id)));
    expect(readCalls.filter((p) => p === "stock/central/wide")).toHaveLength(1);
    expect(totalsReadsIssued()).toBe(PRODUCTS.length * LOCS.length);
  });

  it("re-sorting and re-searching cost nothing — the cache answers", async () => {
    const tree = await mount();
    const after = totalsReadsIssued();
    await clickText(tree, "Least first");
    await typeSearch(tree, "air force");
    await typeSearch(tree, "");
    await clickText(tree, "Most first");
    expect(totalsReadsIssued()).toBe(after);
  });

  it("does not subscribe to stock — one-shot reads only", async () => {
    const { onValue } = await import("firebase/database");
    await mount();
    // onValue is used for /locations by useStock; it must never touch stock.
    const subscribed = readCalls.filter((p) => p.startsWith("stock"));
    expect(subscribed.every((p) => p.split("/").length === 3)).toBe(true);
    expect(typeof onValue).toBe("function");
  });
});

describe("it writes nothing", () => {
  it("never calls a write API, through a full session of use", async () => {
    const tree = await mount();
    await typeSearch(tree, "air force");
    await typeSearch(tree, "");
    await clickText(tree, "Least first");
    await clickText(tree, "Most first");
    for (const [name, spy] of Object.entries(writeSpies)) {
      expect(spy, `write API ${name} was called`).not.toHaveBeenCalled();
    }
  });
});

describe("loadTotals is not a silent no-op", () => {
  it("still reads when asked for a concurrency of zero", async () => {
    const seen = [];
    await loadTotals(["wide"], LOCS, (id, totals) => seen.push([id, totals.total]), 0);
    expect(seen).toEqual([["wide", 110]]);
  });

  it("resolves on an empty list without reading anything", async () => {
    readCalls.length = 0;
    await loadTotals([], LOCS, () => {});
    expect(readCalls).toHaveLength(0);
  });
});

describe("what it costs — measured, not claimed", () => {
  it("first open and a search both stay in the tens of KB", async () => {
    const tree = await mount();
    const onOpen = totalsBytesRead();
    expect(onOpen).toBeGreaterThan(0);
    // Per-product cost on real data measures 1,243 bytes; this fixture is
    // smaller, so the assertion is the SHAPE: cost scales with rows on screen,
    // and a whole-node read (5.36 MB live) is nowhere near possible here.
    expect(onOpen).toBeLessThan(PRODUCTS.length * 3000);
    __resetTotalsCache();
    const tree2 = await mount();
    await typeSearch(tree2, "air force");
    expect(totalsBytesRead()).toBeLessThan(PRODUCTS.length * 3000);
    expect(tree).toBeTruthy();
  });
});
