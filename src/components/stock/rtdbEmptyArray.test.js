import { describe, it, expect } from "vitest";
import { buildAttributeRecord } from "../../utils/productAttributes";
import { parseNeighbours, encodeNeighbour, NEIGHBOURS_FIELD } from "../../utils/productNeighbours";

// ─── A FAKE RTDB THAT DELETES EMPTY-ARRAY CHILDREN, LIKE THE REAL ONE ────────
//
// Owner constraint: "Real RTDB deletes empty-array children — test fakes must
// reproduce that." A fake that stores `[]` faithfully is worse than no fake: it
// makes a whole class of bug pass in CI and fail in the shop, and it is the
// exact reason this rule exists as a standing instruction rather than a note.
//
// Two behaviours are reproduced, both observed in production:
//
//   1. A child written as `[]` is DELETED and reads back `null`.
//      Not "reads back []". The key is gone.
//   2. An array with any HOLE in it comes back as an OBJECT keyed "0","2",… —
//      RTDB stores arrays as objects and only reconstructs a JS array when the
//      keys are a dense 0..n-1 run.
//
// Also reproduced: `update()` merges (a child not named in the patch survives),
// and an explicit `null` in a patch deletes. Everything this build writes goes
// through one of those two calls.
function createFakeRtdb(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));

  // The real coercion, applied on the way IN.
  const coerce = (v) => {
    if (Array.isArray(v)) {
      if (v.length === 0) return null;                     // (1) the deletion
      const out = {};
      v.forEach((x, i) => { if (x !== null && x !== undefined) out[String(i)] = coerce(x); });
      return Object.keys(out).length === 0 ? null : out;
    }
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const c = coerce(x);
        if (c !== null && c !== undefined) out[k] = c;
      }
      return Object.keys(out).length === 0 ? null : out;
    }
    return v;
  };

  // The real reconstruction, applied on the way OUT: a dense 0..n-1 object of
  // string keys becomes an array; anything else stays an object.
  const revive = (v) => {
    if (!v || typeof v !== "object") return v;
    const keys = Object.keys(v);
    const dense = keys.length > 0 && keys.every((k, i) => k === String(i));
    const mapped = keys.map((k) => revive(v[k]));
    if (dense) return mapped;
    const out = {};
    keys.forEach((k, i) => { out[k] = mapped[i]; });
    return out;
  };

  const at = (path) => path.split("/").filter(Boolean);
  return {
    set(path, value) {
      const segs = at(path);
      const leaf = segs.pop();
      let node = store;
      for (const s of segs) node = (node[s] ||= {});
      const c = coerce(value);
      if (c === null || c === undefined) delete node[leaf]; else node[leaf] = c;
    },
    update(path, patch) {
      for (const [k, v] of Object.entries(patch)) this.set(`${path}/${k}`, v);
    },
    get(path) {
      let node = store;
      for (const s of at(path)) {
        if (!node || typeof node !== "object" || !(s in node)) return null;
        node = node[s];
      }
      return revive(node);
    },
    raw: () => store,
  };
}

describe("the fake reproduces what real RTDB does", () => {
  it("deletes a child written as an empty array — it reads back NULL, not []", () => {
    const db = createFakeRtdb();
    db.set("a/b", []);
    expect(db.get("a/b")).toBe(null);
    expect("b" in (db.raw().a || {})).toBe(false);
  });
  it("hands an array with a hole back as an OBJECT", () => {
    const db = createFakeRtdb();
    db.set("a/list", ["x", null, "z"]);
    const back = db.get("a/list");
    expect(Array.isArray(back)).toBe(false);
    expect(back).toEqual({ 0: "x", 2: "z" });
  });
  it("returns a dense array as an array", () => {
    const db = createFakeRtdb();
    db.set("a/list", ["x", "y"]);
    expect(db.get("a/list")).toEqual(["x", "y"]);
  });
  it("update() merges and an explicit null deletes", () => {
    const db = createFakeRtdb({ p: { keep: 1, go: 2 } });
    db.update("p", { go: null, add: 3 });
    expect(db.get("p")).toEqual({ keep: 1, add: 3 });
  });
});

// ── AND NOW THE THINGS THIS BUILD ACTUALLY WRITES, THROUGH IT ───────────────
describe("the attribute record survives a real RTDB round trip", () => {
  const product = { brand: "Nike", category: "Footwear", retailPrice: 750 };
  const vision = {
    silhouette: "low-top", upperMaterial: "leather", primaryColour: "black",
    pattern: "solid", confidence: { silhouette: 0.9 },
  };

  it("an empty styleTags is OMITTED, so the round trip is a no-op rather than a deletion", () => {
    const db = createFakeRtdb();
    const rec = buildAttributeRecord({ vision: { ...vision, styleTags: [] }, product, model: "m", at: 1 });
    db.update("product_attributes/p1", rec);
    // The key was never written, so there is nothing for RTDB to delete and
    // nothing reads back null unexpectedly.
    expect(db.get("product_attributes/p1/a/styleTags")).toBe(null);
    expect(db.get("product_attributes/p1/a/silhouette")).toBe("low-top");
  });
  it("a real styleTags list comes back as a list", () => {
    const db = createFakeRtdb();
    db.update("product_attributes/p1", buildAttributeRecord({
      vision: { ...vision, styleTags: ["retro", "skate"] }, product, model: "m", at: 1 }));
    expect(db.get("product_attributes/p1/a/styleTags")).toEqual(["retro", "skate"]);
  });
  // THE POINT OF THE `confirmed` SPLIT, proved against the storage layer rather
  // than against the pure function: a re-run is an update() naming only the
  // machine children, so a human correction is not in the patch and survives.
  it("a re-run cannot clobber a human correction", () => {
    const db = createFakeRtdb();
    db.update("product_attributes/p1", buildAttributeRecord({ vision, product, model: "m", at: 1 }));
    db.update("product_attributes/p1", { confirmed: { silhouette: "high-top" } });   // a person
    db.update("product_attributes/p1", buildAttributeRecord({
      vision: { ...vision, silhouette: "runner" }, product, model: "m", at: 2, previousVersion: 1 }));
    expect(db.get("product_attributes/p1/confirmed/silhouette")).toBe("high-top");
    expect(db.get("product_attributes/p1/a/silhouette")).toBe("runner");
  });
});

describe("the neighbour list survives a real RTDB round trip", () => {
  it("a stored list reads back and parses", () => {
    const db = createFakeRtdb({ products: { p1: { id: "p1", name: "shoe" } } });
    db.update("products", { [`p1/${NEIGHBOURS_FIELD}`]: [encodeNeighbour("p2", "s"), encodeNeighbour("p3", "a")] });
    expect(parseNeighbours(db.get(`products/p1/${NEIGHBOURS_FIELD}`)).map((n) => n.pid)).toEqual(["p2", "p3"]);
  });
  // build-neighbours.mjs writes an explicit null for a product with no
  // neighbours rather than [], and this is why: the two are the same thing in
  // RTDB, and the explicit null makes the intent readable at the call site
  // instead of inferred from a database quirk.
  it("an empty list and an explicit null are indistinguishable afterwards", () => {
    const db = createFakeRtdb({ products: { p1: { id: "p1" }, p2: { id: "p2" } } });
    db.update("products", { [`p1/${NEIGHBOURS_FIELD}`]: [], [`p2/${NEIGHBOURS_FIELD}`]: null });
    expect(db.get(`products/p1/${NEIGHBOURS_FIELD}`)).toBe(null);
    expect(db.get(`products/p2/${NEIGHBOURS_FIELD}`)).toBe(null);
    expect(parseNeighbours(db.get(`products/p1/${NEIGHBOURS_FIELD}`))).toEqual([]);
  });
  // A holed array reaches the renderer as an object, and a renderer that
  // assumes an array shows the customer nothing at all.
  it("a holed list still renders — RTDB hands it back as an object", () => {
    const db = createFakeRtdb({ products: { p1: { id: "p1" } } });
    db.update("products", { [`p1/${NEIGHBOURS_FIELD}`]: ["p2:s", null, "p4:a"] });
    const back = db.get(`products/p1/${NEIGHBOURS_FIELD}`);
    expect(Array.isArray(back)).toBe(false);
    expect(parseNeighbours(back).map((n) => n.pid)).toEqual(["p2", "p4"]);
  });
  it("writing the list touches nothing else on the product record", () => {
    const db = createFakeRtdb({ products: { p1: { id: "p1", name: "shoe", retailPrice: 750, sizes: ["8"] } } });
    db.update("products", { [`p1/${NEIGHBOURS_FIELD}`]: ["p2:s"] });
    const p = db.get("products/p1");
    expect(p.name).toBe("shoe");
    expect(p.retailPrice).toBe(750);
    expect(p.sizes).toEqual(["8"]);
  });
});
