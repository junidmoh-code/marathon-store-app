import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { alternativesForSize, tierOf, MAX_ALTERNATIVES_SHOWN } from "./alternativesCore";
import { shownEntry, pickedEntry } from "./alternativesTelemetry";
import { ducksWorld, DUCKS_PID, isAirForce1 } from "./__fixtures__/ducksHarness";
import { encodeAltProfile, deriveAltProfile, ALT_PROFILE_FIELD, profileOfProduct } from "../../utils/altProfile";
import { modelFamilyOf } from "../../utils/modelFamily";
import { resolveAttributes } from "../../utils/productAttributes";
import fixture from "./__fixtures__/ducksOfAFeather.json";

// ── A small world: every live fact a callback, exactly as the screen wires it ─
let seq = 0;
const shoe = (name, brand, extra = {}) => ({
  id: extra.id || `p${++seq}`, name, brand, category: "Footwear", categoryKey: "sneakers",
  productType: "sneaker", retailPrice: 750, photoUrl: "u", sizes: ["6", "7", "8", "9"], ...extra,
});
function world(products, { stock = () => true, known = () => true } = {}) {
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  return (source, size = "8", extra = {}) => alternativesForSize({
    sourceProduct: source, requestedSize: size, neighbours: source.alternatives, candidates: products,
    resolveProduct: (pid) => byId[pid] || null, sizesOf: (p) => p.sizes,
    availabilityKnown: known, sizeAvailable: (p, s) => stock(p, s), isSellable: () => true, ...extra,
  });
}
// A shoe as the trigger would index it: vision attributes + family.
const indexed = (p, a) => ({
  ...p,
  [ALT_PROFILE_FIELD]: encodeAltProfile(deriveAltProfile(p, {
    attrs: resolveAttributes({ a }), family: modelFamilyOf({ name: p.name, brand: p.brand }),
  })),
});
const A = (silhouette, primaryColour, extra = {}) => ({ silhouette, primaryColour, upperMaterial: "leather", pattern: "solid", ...extra });

describe("Ducks of a Feather size 8 — after enrichment", () => {
  // What the sheet shows once the trigger has read the photo (white upper,
  // green overlays — the attribute record the vision call produced for the
  // older Ducks colourway). The white Air Force 1s come first.
  const w = ducksWorld();
  const ducks = indexed(w.products[DUCKS_PID], A("low-top", "white", { secondaryColour: "green", soleColour: "white", soleType: "cup" }));
  const products = Object.fromEntries(Object.entries(w.products).map(([pid, p]) => {
    if (pid === DUCKS_PID) return [pid, ducks];
    const a = fixture.attributes[pid]?.a;
    return [pid, a ? indexed(p, a) : p];
  }));
  const w2 = ducksWorld({ products });

  it("eight rows, every one an Air Force 1 in size 8, tier a", () => {
    const r = alternativesForSize(w2.args(products[DUCKS_PID], "8"));
    expect(r.rows).toHaveLength(8);
    expect(r.rows.every((row) => isAirForce1(row.product) && row.tier === "a")).toBe(true);
    expect(r.rows.every((row) => row.matchedSize === "8" && row.sizes.includes("8"))).toBe(true);
    expect(r.rows[0].why).toBe("Same model — Air Force 1");
  });
  it("the closest colourway leads: the first rows are white Air Force 1s", () => {
    const { rows } = alternativesForSize(w2.args(products[DUCKS_PID], "8"));
    const firstThree = rows.slice(0, 3).map((r) => profileOfProduct(r.product).cf);
    expect(firstThree).toEqual(["white", "white", "white"]);
  });
  it("never offers the shoe itself", () => {
    const { rows } = alternativesForSize(w2.args(products[DUCKS_PID], "8"));
    expect(rows.map((r) => r.product.id)).not.toContain(DUCKS_PID);
  });
});

describe("each tier, and the fall-through between them", () => {
  const src = indexed(shoe("Nike Air Force 1 Low White", "Nike", { id: "src" }), A("low-top", "white"));
  const af1 = indexed(shoe("Air force blue", "Nike", { id: "af1" }), A("low-top", "blue"));
  const dunk = indexed(shoe("Nike Dunk Low Panda", "Nike", { id: "dunk" }), A("low-top", "black"));
  const samba = indexed(shoe("Adidas Samba OG White", "Adidas", { id: "samba" }), A("low-top", "white"));
  const runner = indexed(shoe("New Balance 9060 Grey", "New Balance", { id: "nb" }), A("runner", "grey"));
  const slide = indexed(shoe("Gucci slide black", "Gucci", { id: "slide", categoryKey: "slides" }), A("slide", "black"));

  it("tiers are assigned as specified", () => {
    const s = profileOfProduct(src);
    expect(tierOf(s, profileOfProduct(af1))).toBe("a");
    expect(tierOf(s, profileOfProduct(dunk))).toBe("b");
    expect(tierOf(s, profileOfProduct(samba))).toBe("c");
    expect(tierOf(s, profileOfProduct(runner))).toBe("d");
    expect(tierOf(s, profileOfProduct(slide))).toBe("d");
  });
  it("a fills before b before c before d", () => {
    const r = world([src, slide, runner, samba, dunk, af1])(src);
    expect(r.rows.map((x) => x.product.id)).toEqual(["af1", "dunk", "samba", "nb", "slide"]);
    expect(r.rows.map((x) => x.tier)).toEqual(["a", "b", "c", "d", "d"]);
    expect(r.tiers).toEqual({ a: 1, b: 1, c: 1, d: 2 });
  });
  it("inside the family the colourway leads even when another member is more alike overall", () => {
    // Same material, pattern, sole, finish, closure, tags and price as the
    // source — but black. Versus: white, and otherwise nothing in common.
    const full = { upperMaterial: "leather", pattern: "solid", soleType: "cup", finish: "plain", closure: "laced", soleColour: "white", toeShape: "round", styleTags: ["retro", "basketball", "casual"] };
    const s2 = indexed(shoe("Nike Air Force 1 Low White", "Nike", { id: "s2" }), A("low-top", "white", full));
    const alike = indexed(shoe("Nike Air Force 1 Low Black", "Nike", { id: "alike" }), A("low-top", "black", full));
    const sameColour = indexed(shoe("Nike Air Force 1 Low White Suede", "Nike", { id: "white", retailPrice: 2500 }),
      A("low-top", "white", { upperMaterial: "nubuck", pattern: "two-tone", soleType: "gum", finish: "matte", closure: "strap", soleColour: "brown", toeShape: "square", styleTags: ["luxury"] }));
    const r = world([s2, alike, sameColour])(s2);
    expect(r.rows.map((x) => x.product.id)).toEqual(["white", "alike"]);
  });
  it("inside the family a known different cut comes after the same cut, whatever the colour", () => {
    const lo = shoe("Air Jordan 1 Low Black", "Jordan", { id: "lo" });
    const hiWhite = shoe("Air Jordan 1 High White", "Jordan", { id: "hi" });
    const loRed = shoe("Air Jordan 1 Low Red", "Jordan", { id: "lored" });
    const plain = shoe("Air Jordan 1 Blue", "Jordan", { id: "plain" });
    const src2 = shoe("Air Jordan 1 Low White", "Jordan", { id: "src2" });
    const r = world([src2, hiWhite, lo, loRed, plain])(src2);
    expect(r.rows.map((x) => x.product.id).at(-1)).toBe("hi");
    expect(r.rows.every((x) => x.tier === "a")).toBe(true);
  });
  it("no same model in the size → same brand and shape lead", () => {
    const r = world([src, af1, dunk, samba], { stock: (p) => p.id !== "af1" })(src);
    expect(r.rows[0].product.id).toBe("dunk");
    expect(r.rows[0].why).toBe("Same brand, same shape");
  });
  it("no Nike lows either → same colour from another brand", () => {
    const r = world([src, af1, dunk, samba, runner], { stock: (p) => !["af1", "dunk"].includes(p.id) })(src);
    expect(r.rows.map((x) => x.tier)).toEqual(["c", "d"]);
  });
  it("only an unrelated shoe in the size → it is still offered (tier d)", () => {
    const r = world([src, af1, slide], { stock: (p) => p.id === "slide" })(src);
    expect(r.rows.map((x) => [x.product.id, x.tier])).toEqual([["slide", "d"]]);
    expect(r.rows[0].why).toBe("Also in this size");
  });
  it("fills to eight across tiers when that many exist", () => {
    const many = Array.from({ length: 12 }, (_, i) => indexed(shoe(`Lacoste Carnaby ${i}`, "Lacoste"), A("low-top", "black")));
    const r = world([src, af1, dunk, ...many])(src);
    expect(r.rows).toHaveLength(MAX_ALTERNATIVES_SHOWN);
    expect(r.rows.slice(0, 2).map((x) => x.tier)).toEqual(["a", "b"]);
    expect(r.inSize).toBe(14);
  });
});

describe("size keys are compared in ONE place", () => {
  const src = shoe("Nike Air Force 1 White", "Nike", { id: "src" });
  const spellings = [["8"], ["8.0"], ["UK 8"], [8]];
  it.each(spellings)("requested %s matches a candidate's '8', 'UK 8' and '8.0' — and passes ITS OWN label to the availability test", (req) => {
    const a = shoe("Air force white", "Nike", { id: "a", sizes: ["7", "8"] });
    const b = shoe("Air force blue", "Nike", { id: "b", sizes: ["UK 7", "UK 8"] });
    const c = shoe("Nike Air force1", "Nike", { id: "c", sizes: ["8.0", "9.0"] });
    const asked = [];
    const r = world([src, a, b, c], { stock: (p, s) => { asked.push(`${p.id}:${s}`); return true; } })(src, req);
    expect(r.rows.map((x) => [x.product.id, x.matchedSize]).sort()).toEqual([["a", "8"], ["b", "UK 8"], ["c", "8.0"]]);
    expect(asked).toEqual(expect.arrayContaining(["a:8", "b:UK 8", "c:8.0"]));
  });
  it("a half size matches only the half size, the cell-key spelling included", () => {
    const a = shoe("Air force white", "Nike", { id: "a", sizes: ["8", "8.5"] });
    const r = world([src, a])(src, "8_5");
    expect(r.rows[0].matchedSize).toBe("8.5");
  });
  it("a kids 8 is not an adult 8", () => {
    const kid = shoe("Nike Air Force 1 GS White", "Nike", { id: "kid", sizes: ["8"] });
    expect(world([src, kid])(src, "8").rows).toHaveLength(0);
  });
  it("an unclassifiable request matches nothing (never a guess)", () => {
    const a = shoe("Air force white", "Nike", { id: "a" });
    expect(world([src, a])(src, "M").rows).toHaveLength(0);
  });
});

describe("a fallback family is not a model", () => {
  it("'Nike Air Rift' and 'Nike Air Tuned' share a fallback word, not a model — never 'Same model'", () => {
    const src = shoe("Nike Air Tuned Black", "Nike", { id: "src" });
    const rift = shoe("Nike Air Rift Black", "Nike", { id: "rift" });
    expect(profileOfProduct(src).famSrc).toBe("fallback");
    const r = world([src, rift])(src);
    expect(r.rows[0].tier).not.toBe("a");
    expect(r.rows[0].why).not.toMatch(/Same model/);
  });
});

describe("a product with no enrichment", () => {
  it("is offered, and ranks by what its name says", () => {
    const src = shoe("Nike Air Force 1 Low Ducks of a Feather", "Nike", { id: "src" });
    const plainAf1 = shoe("Air force white", "Nike", { id: "plain" });
    const other = shoe("Puma Suede Black", "Puma", { id: "other" });
    const r = world([src, other, plainAf1])(src);
    expect(r.rows.map((x) => [x.product.id, x.tier])).toEqual([["plain", "a"], ["other", "d"]]);
  });
  it("a corrupt or old-version profile string reads as absent, not as wrong facts", () => {
    const p = shoe("Air force white", "Nike", { id: "x", [ALT_PROFILE_FIELD]: "9|bogus" });
    expect(profileOfProduct(p).stored).toBe(false);
    expect(profileOfProduct(p).fam).toBe("nike-air-force-1");
  });
});

describe("gates still fail closed in the live pool", () => {
  const src = shoe("Nike Air Force 1 White", "Nike", { id: "src" });
  const a = shoe("Air force white", "Nike", { id: "a" });
  it("a shoe the screen cannot answer for is dropped", () => {
    expect(world([src, a], { known: () => false })(src).rows).toHaveLength(0);
  });
  it("a shoe not sellable in the size is dropped", () => {
    expect(world([src, a], { stock: (p, s) => s !== "8" })(src).rows).toHaveLength(0);
  });
  it("the same shoe reached twice (a merged-away pid) appears once", () => {
    const ghost = { ...a, id: "ghost", mergedInto: "a" };
    const byId = { a, ghost, src };
    const r = alternativesForSize({
      sourceProduct: src, requestedSize: "8", candidates: [ghost, a], resolveProduct: (pid) => (pid === "ghost" ? a : byId[pid]),
      sizesOf: (p) => p.sizes, availabilityKnown: () => true, sizeAvailable: () => true, isSellable: () => true,
    });
    expect(r.rows.map((x) => x.product.id)).toEqual(["a"]);
  });
});

// ── THE NEVER-EMPTY GUARD ────────────────────────────────────────────────────
// Whenever anything is sellable in the size, the sheet shows it — at least
// min(8, how many) rows. Random worlds, including a source with no profile,
// an empty stored list, and neighbour lists full of shoes with no stock.
describe("never 'nothing' while something is sellable in the size", () => {
  const rnd = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  it("holds over 400 random worlds", () => {
    const names = ["Nike Air Force 1", "Air force white", "Nike Dunk Low", "Adidas Samba", "Lacoste Gripshot", "Puma Suede", "Gucci slide", "On Cloud 6"];
    const brands = ["Nike", "Nike", "Nike", "Adidas", "Lacoste", "Puma", "Gucci", "On"];
    for (let t = 0; t < 400; t++) {
      const r = rnd(t + 1);
      const n = 1 + Math.floor(r() * 25);
      const products = Array.from({ length: n }, (_, i) => {
        const k = Math.floor(r() * names.length);
        return shoe(`${names[k]} ${i}`, brands[k], { id: `w${t}_${i}`, sizes: r() < 0.8 ? ["7", "8", "9"] : ["5", "6"] });
      });
      const src = products[0];
      src.alternatives = products.slice(1, 4).map((p) => `${p.id}:x`);
      const stocked = new Set(products.filter(() => r() < 0.4).map((p) => p.id));
      const res = world(products, { stock: (p) => stocked.has(p.id) })(src);
      const sellable = products.filter((p) => p.id !== src.id && stocked.has(p.id) && p.sizes.includes("8")).length;
      expect(res.inSize).toBe(sellable);
      expect(res.rows.length).toBe(Math.min(MAX_ALTERNATIVES_SHOWN, sellable));
    }
  });
});

describe("telemetry stays log only and records the tier", () => {
  it("the shown row carries each row's tier and the pool size; the pick its tier", () => {
    const src = shoe("Nike Air Force 1 White", "Nike", { id: "src" });
    const a = shoe("Air force white", "Nike", { id: "a" });
    const res = world([src, a])(src);
    const e = shownEntry({ ts: 1, shop: "marathon-pe", surface: "sheet", product: src, size: "8", result: res });
    expect(e).toMatchObject({ shownIds: ["a"], shownTiers: ["a"], inSize: 1, shown: 1 });
    expect(pickedEntry({ ts: 2, product: src, size: "8", row: res.rows[0] })).toMatchObject({ pickedId: "a", pickedTier: "a" });
  });
  it("nothing in the ranking path reads the log back", () => {
    const root = path.resolve(__dirname, "../..");
    for (const f of ["components/stock/alternativesCore.js", "utils/altProfile.js", "utils/modelFamily.js", "utils/productNeighbours.js"]) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect(src).not.toMatch(/alternatives_log|ALTERNATIVES_LOG_PATH|alternativesTelemetry/);
    }
  });
  it("the core never calls a writer — it is handed callbacks and returns data", () => {
    const spy = vi.fn(() => true);
    const src = shoe("Nike Air Force 1 White", "Nike", { id: "src" });
    world([src, shoe("Air force white", "Nike", { id: "a" })], { stock: spy })(src);
    expect(spy).toHaveBeenCalled();
  });
});
