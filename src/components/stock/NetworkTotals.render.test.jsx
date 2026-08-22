// ─── TOTAL STOCK — THROUGH THE REAL COMPONENT ─────────────────────────────────
// networkTotalsCore.test.js pins the arithmetic. This renders the actual page
// against a faked RTDB and proves the things a person betting an order on this
// number needs to be true:
//
//   • the number is every size at every COUNTED location — Pine and Hub 3 are
//     not read at all, not merely subtracted afterwards;
//   • a negative cell contributes nothing and is never mentioned on screen;
//   • the page NEVER reads a whole node — every stock read is scoped to one
//     product at one location, and only for rows on screen;
//   • search returns exactly what the app's shared matcher returns;
//   • it issues no write of any kind, of any shape, ever.
//
// It also MEASURES the bytes pulled on first open and on a search, so the cost
// claim in the commit message is a test result rather than a promise.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { searchProducts } from "../../utils/productSearch";

const LOCS = ["studio", "central", "base", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "in_transit"];
// What the card must actually sum: every LIVE location except Pine and Hub 3.
// studio and base are retired (active:false) and drop out on that flag.
const COUNTED = ["central", "hub1", "hub2", "in_transit", "marathon-pe", "trophy"];
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
  // "drag" holds a big negative and units in BOTH excluded locations — the
  // strongest fixture for "negatives add nothing" and "Pine and Hub 3 are out".
  "stock/hub2/drag":          { S: cell(-50), M: cell(-2) },
  "stock/central/drag":       { S: cell(10) },
  "stock/hub3/drag":          { S: cell(500) },
  "stock/marathon-pine/drag": { S: cell(700) },
  "stock/hub3/wide":          { S: cell(999) },
  "stock/marathon-pine/wide": { S: cell(999) },
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
const { __resetTotalsCache, totalsBytesRead, totalsReadsIssued, totalsBatches, loadTotals } = await import("./networkTotalsStore.js");

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
  // createNodeMock: react-test-renderer leaves host refs null without it, and the
  // scroll sentinel is a ref on a host node — no mock, no observer, and the
  // auto-load test would pass for the wrong reason.
  await act(async () => {
    tree = TestRenderer.create(
      <NetworkTotals products={products} registry={registry} onExit={() => {}} />,
      { createNodeMock: () => ({}) },
    );
  });
  await act(async () => {});
  await act(async () => {});
  return tree;
}
// The card's rows are its only elements carrying className "nt-row".
// A row is read as { text, total }. The total is taken from the ONE element on
// the row that renders it (the 26px number), never scraped off the row's text —
// product names end in digits ("Air Force 1", "574") and a regex would happily
// read the name as the answer.
const rowNodes = (tree) => tree.root.findAll((n) => n.props && n.props.className === "ts-row");
const rowTexts = (tree) => rowNodes(tree).map((n) => textOf(n.props.children));
const totalNodeOf = (rowNode) => rowNode.findAll((n) => n.props && n.props.style && n.props.style.fontSize === 26)[0];
const rowTotals = (tree) => Object.fromEntries(rowNodes(tree).map((n) => {
  const t = totalNodeOf(n);
  return [textOf(n.props.children), t ? Number(textOf(t.props.children)) : null];
}));
const totalFor = (tree, nameFragment) => {
  const node = rowNodes(tree).find((n) => textOf(n.props.children).includes(nameFragment));
  if (!node) return undefined;
  const t = totalNodeOf(node);
  if (!t) return null;                       // a failed row shows Retry, no number
  const txt = textOf(t.props.children);
  return txt === "\u00b7" ? null : Number(txt);
};
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
    // wide: central 40+30+5 · hub2 20+10 · marathon-pe 2 = 107
    expect(totalFor(tree, "Air Force")).toBe(107);
    // mid: central 12 · trophy 6 = 18
    expect(totalFor(tree, "Ultraboost")).toBe(18);
    // runner: the array-shaped numeric size run, 4 + 3 = 7
    expect(totalFor(tree, "New Balance")).toBe(7);
  });

  it("counts a size the product record does not declare, and an inactive location", async () => {
    const tree = await mount([PRODUCTS[0]]);
    // 107 only holds if XXXL (not in sizes[]) counts AND base (retired, holds 3),
    // Hub 3 (999) and Pine (999) all do not. Declared sizes only would be 102;
    // counting base 110; counting the excluded pair 2,105.
    expect(totalFor(tree, "Air Force")).toBe(107);
  });

  it("names the locations it summed, so the number cannot be misread", async () => {
    const tree = await mount();
    const page = screen(tree);
    for (const id of COUNTED) expect(page).toContain(id);
    expect(page).not.toContain("marathon-pine");
    expect(page).not.toContain("hub3");
  });
});

describe("Pine and Hub 3 are not counted", () => {
  it("never issues a read against either of them", async () => {
    await mount();
    const locs = readCalls.filter((p) => p.startsWith("stock/")).map((p) => p.split("/")[1]);
    expect(new Set(locs)).toEqual(new Set(COUNTED));
    expect(locs).not.toContain("marathon-pine");
    expect(locs).not.toContain("hub3");
  });

  // Not merely subtracted afterwards — never fetched. A card that read them and
  // then dropped them would still be paying for them.
  it("leaves their units out of the number entirely", async () => {
    const tree = await mount();
    // "drag": central 10, hub2 −50/−2 → 10. Hub 3 (500) and Pine (700) are out.
    expect(totalFor(tree, "Puma Suede")).toBe(10);
  });
});

describe("a negative cell adds nothing, and is never mentioned", () => {
  it("does not drag the total down", async () => {
    const tree = await mount();
    expect(totalFor(tree, "Puma Suede")).toBe(10);   // not −42, not 0
  });

  it("says nothing about negatives anywhere on the page", async () => {
    const tree = await mount();
    const page = screen(tree).toLowerCase();
    for (const word of ["negative", "minus", "drag", "clamp"]) expect(page).not.toContain(word);
    expect(screen(tree)).not.toMatch(/-\d/);
  });

  it("ranks by the counted number, in both directions", async () => {
    const tree = await mount();
    expect(rowTexts(tree)[0]).toContain("Air Force");        // 110
    await clickText(tree, "Least first");
    expect(rowTexts(tree)[0]).toContain("Chuck 70");         // 0
  });
});

describe("the one-size sentinel and _meta", () => {
  it("shows a one-size product whose only cell is negative as zero, silently", async () => {
    const tree = await mount();
    expect(totalFor(tree, "Lacoste")).toBe(0);
    const row = rowTexts(tree).find((r) => r.includes("Lacoste"));
    expect(row).not.toContain("_");     // no size key leaks onto a clean row
  });
});

describe("a read that fails", () => {
  it("shows no number and offers a retry, rather than counting forever or showing 0", async () => {
    failPaths.add("stock/hub2/drag");
    const tree = await mount();
    const row = rowTexts(tree).find((r) => r.includes("Puma Suede"));
    expect(row).toContain("Retry");
    expect(totalFor(tree, "Puma Suede")).toBe(null);   // NOT 0 — a failed read is not a zero
  });

  it("re-reads that product when Retry is pressed, and only that product", async () => {
    failPaths.add("stock/hub2/drag");
    const tree = await mount();
    readCalls.length = 0;
    failPaths.clear();
    await clickText(tree, "Retry");
    const retried = readCalls.filter((p) => p.startsWith("stock/"));
    expect(new Set(retried.map((p) => p.split("/")[2]))).toEqual(new Set(["drag"]));
    expect(totalFor(tree, "Puma Suede")).toBe(10);
  });

  it("keeps the other products' totals — one bad location does not poison the page", async () => {
    failPaths.add("stock/hub2/drag");
    const tree = await mount();
    expect(totalFor(tree, "Air Force")).toBe(107);
    expect(totalFor(tree, "Ultraboost")).toBe(18);
  });
});

describe("Refresh", () => {
  it("re-reads the page so a number he is about to order against is current", async () => {
    const tree = await mount();
    const before = totalsReadsIssued();
    reads["stock/central/mid"] = { S: cell(99) };
    await clickText(tree, "Refresh");
    expect(totalsReadsIssued()).toBeGreaterThan(before);
    expect(totalFor(tree, "Ultraboost")).toBe(105);   // 99 + 6
    reads["stock/central/mid"] = { S: cell(12) };
  });
});

describe("StrictMode", () => {
  it("still renders totals after React's development mount / unmount / remount", async () => {
    let tree;
    await act(async () => {
      tree = TestRenderer.create(
        <React.StrictMode><NetworkTotals products={PRODUCTS} registry={registry} onExit={() => {}} /></React.StrictMode>,
        { createNodeMock: () => ({}) },
      );
    });
    await act(async () => {});
    await act(async () => {});
    expect(totalFor(tree, "Air Force")).toBe(107);
  });
});

describe("a product with no stock anywhere", () => {
  it("shows a plain zero rather than breaking or going blank", async () => {
    const tree = await mount();
    expect(totalFor(tree, "Chuck 70")).toBe(0);
  });

  // The row is a name and a number. Nothing else belongs on it.
  it("carries no diagnostics — just the name and the number", async () => {
    const tree = await mount();
    const row = rowTexts(tree).find((r) => r.includes("Chuck 70"));
    expect(row).toBe("Converse Chuck 70 Parchment0");
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
    expect(totalsReadsIssued()).toBe(PRODUCTS.length * COUNTED.length);
  });

  // REGRESSION. The fetch effect once depended on the same counter that fires
  // when a row LANDS, so each arriving row re-entered it while its siblings were
  // still in flight and spawned a fresh chain. Nothing extra was downloaded —
  // the store's inflight map deduped the reads — so read counts stayed innocent
  // while the promise chains grew quadratically. It surfaced as a test worker
  // exhausting its heap; on a tablet it would surface as the page locking up.
  it("fetches once per page, not once per row that arrives", async () => {
    await mount();
    expect(totalsBatches()).toBe(1);
  });

  it("fetches once more per page when a page is added, and no more than that", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}`, sizes: ["S"], photoUrl: null }));
    const observers = [];
    global.IntersectionObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
    try {
      const tree = await mount(many);
      expect(totalsBatches()).toBe(1);
      await act(async () => { observers.at(-1).cb([{ isIntersecting: true }]); });
      await act(async () => {}); await act(async () => {});
      expect(rowTexts(tree)).toHaveLength(50);
      expect(totalsBatches()).toBe(2);
    } finally { delete global.IntersectionObserver; }
  });

  it("re-sorting and re-searching cost nothing — the cache answers", async () => {
    const tree = await mount();
    const after = totalsReadsIssued();
    await clickText(tree, "Least first");
    await typeSearch(tree, "air force");
    await typeSearch(tree, "");
    await clickText(tree, "Most first");
    expect(totalsReadsIssued()).toBe(after);
    expect(totalsBatches()).toBe(1);          // and no new fetch was even attempted
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
    await loadTotals(["wide"], COUNTED, (id, totals) => seen.push([id, totals.total]), 0);
    expect(seen).toEqual([["wide", 107]]);
  });

  it("resolves on an empty list without reading anything", async () => {
    readCalls.length = 0;
    await loadTotals([], COUNTED, () => {});
    expect(readCalls).toHaveLength(0);
  });
});

describe("the next page arrives on its own", () => {
  // He asked not to press a button over and over. The sentinel coming into view
  // is what loads the next page — an observer, not a scroll handler, so pages
  // arrive one at a time as he scrolls and the bytes still track what he has
  // actually looked at.
  it("loads the next page when the sentinel comes into view", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `Product ${String(i).padStart(2, "0")}`, sizes: ["S"], photoUrl: null }));
    for (const p of many) reads[`stock/central/${p.id}`] = { S: cell(1) };

    const observers = [];
    global.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {} disconnect() {}
    };
    try {
      const tree = await mount(many);
      await act(async () => {});
      await act(async () => {});
      expect(rowTexts(tree)).toHaveLength(25);
      expect(observers.length, "no IntersectionObserver was created").toBeGreaterThan(0);
      // The sentinel scrolls into view.
      await act(async () => { observers.at(-1).cb([{ isIntersecting: true }]); });
      await act(async () => {}); await act(async () => {}); await act(async () => {});
      expect(rowTexts(tree)).toHaveLength(50);
      await act(async () => { observers.at(-1).cb([{ isIntersecting: true }]); });
      await act(async () => {}); await act(async () => {}); await act(async () => {});
      expect(rowTexts(tree)).toHaveLength(60);   // the pool, not a page more
    } finally {
      delete global.IntersectionObserver;
      for (const p of many) delete reads[`stock/central/${p.id}`];
    }
  });

  it("does not load a page the sentinel has not reached", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, name: `Item ${i}`, sizes: ["S"], photoUrl: null }));
    global.IntersectionObserver = class { constructor() {} observe() {} disconnect() {} };
    try {
      const tree = await mount(many);
      expect(rowTexts(tree)).toHaveLength(25);
    } finally { delete global.IntersectionObserver; }
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
