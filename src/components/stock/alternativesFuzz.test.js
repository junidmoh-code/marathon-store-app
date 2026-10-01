import { describe, it, expect } from "vitest";
import {
  ATTRIBUTE_FIELDS, ATTRIBUTE_KEYS, VISION_FIELDS, MAX_STYLE_TAGS, MAX_NAME_LENGTH,
  COLOURS, SILHOUETTES, UPPER_MATERIALS, PATTERNS, TOE_SHAPES, STYLE_TAGS,
  SOLE_TYPES, CLOSURES, FINISHES, PRICE_BANDS,
  buildAttributeRecord, resolveAttributes, usableAttributes, nameFromAttributes,
  distinctNamesFor, handleFromName, colourFamily,
} from "../../utils/productAttributes";
import { validateVisionName } from "../../utils/visionNaming";
import { parseAttributeResponse } from "../../utils/attributeExtraction";
import {
  neighbourProfile, topNeighbours, scorePair, silhouetteGroup,
  encodeNeighbour, parseNeighbours, MAX_NEIGHBOURS, SIMILARITY_WEIGHTS,
} from "../../utils/productNeighbours";
import { sellableAlternatives, MAX_ALTERNATIVES_SHOWN } from "./alternativesCore";

// ─── A PROPERTY FUZZ OVER THE WHOLE CHAIN ────────────────────────────────────
//
// This is the standing substitute when the independent second-brain reviewer is
// unavailable: a second adversarial architect pass, plus a property fuzz of the
// thing under test. Kimi's provider returned HTTP 500 on a two-word prompt on
// 2026-09-06, so this is that fuzz.
//
// The example tests elsewhere assert what the author THOUGHT to check. This
// asserts the invariants over inputs nobody chose — including malformed,
// hostile and merely unusual ones — because the failure that matters here is
// the one nobody imagined: a suggestion a customer is shown that cannot be
// sold.
//
// SEEDED, so a failure is reproducible from its case index alone. A fuzz whose
// failures cannot be replayed is a flaky test, not a proof.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
// Deliberately includes values NO caller should ever produce. Every one of
// these has reached a JS object from RTDB at some point in this codebase's
// history: an absent child, a legacy empty string, a number where a string
// belongs, an array RTDB rebuilt as an object.
const JUNK = [undefined, null, "", " ", 0, -1, NaN, [], {}, "UNKNOWN", "  black ", 1.5, true, "__proto__"];

const randAttrs = (r, { junk = 0 } = {}) => {
  const a = {
    silhouette: pick(r, SILHOUETTES), upperMaterial: pick(r, UPPER_MATERIALS),
    primaryColour: pick(r, COLOURS), secondaryColour: r() < 0.4 ? "" : pick(r, COLOURS),
    pattern: pick(r, PATTERNS), toeShape: r() < 0.2 ? "" : pick(r, TOE_SHAPES),
    soleColour: r() < 0.2 ? "" : pick(r, COLOURS), soleType: r() < 0.2 ? "" : pick(r, SOLE_TYPES),
    closure: r() < 0.2 ? "" : pick(r, CLOSURES), finish: r() < 0.2 ? "" : pick(r, FINISHES),
    priceBand: pick(r, PRICE_BANDS),
    styleTags: Array.from({ length: Math.floor(r() * 4) }, () => pick(r, STYLE_TAGS)),
  };
  a.colourFamily = colourFamily(a.primaryColour);
  if (junk && r() < junk) a[pick(r, ATTRIBUTE_KEYS)] = pick(r, JUNK);
  return a;
};

// ─── 1. THE NAMER ────────────────────────────────────────────────────────────
describe("fuzz: every name the namer emits is publishable", () => {
  it("2,000 random attribute sets, every tier", () => {
    const r = rng(0xC0FFEE);
    let emitted = 0;
    for (let i = 0; i < 2000; i++) {
      const a = randAttrs(r, { junk: 0.25 });
      for (const level of [0, 1, 2, 3, 4]) {
        const n = nameFromAttributes(a, { discriminate: level });
        if (!n) continue;                       // refusal is always allowed
        emitted += 1;
        const why = `case ${i} tier ${level}: ${JSON.stringify(n)} from ${JSON.stringify(a)}`;
        // The SAME validator a hand-typed name faces. A generated name must
        // not get in through a softer door.
        expect(validateVisionName(n).ok, why).toBe(true);
        expect(n.length, why).toBeLessThanOrEqual(MAX_NAME_LENGTH);
        expect(/^\d/.test(n), why).toBe(false);
        expect(n.trim(), why).toBe(n);
        expect(n, why).not.toMatch(/\s{2,}/);
      }
    }
    expect(emitted).toBeGreaterThan(5000);      // the fuzz is not vacuous
  });

  it("a name is a pure function of the attributes — same input, same output", () => {
    const r = rng(0xBEEF);
    for (let i = 0; i < 500; i++) {
      const a = randAttrs(r, { junk: 0.3 });
      const lvl = Math.floor(r() * 5);
      expect(nameFromAttributes(a, { discriminate: lvl }))
        .toBe(nameFromAttributes({ ...a }, { discriminate: lvl }));
    }
  });

  // THE CONTRACT distinctNamesFor EXISTS FOR. Whatever it emits, no two
  // products may share a handle — that is the whole point, and it is the
  // property most likely to be broken by a later "improvement" to the tiers.
  it("distinctNamesFor NEVER emits two products with the same handle", () => {
    const r = rng(0xD00D);
    for (let round = 0; round < 200; round++) {
      const n = 2 + Math.floor(r() * 30);
      const entries = [];
      // Deliberately seeded with near-duplicates: a shared base attribute set
      // with small perturbations is exactly the live catalogue's shape.
      const base = randAttrs(r);
      for (let i = 0; i < n; i++) {
        const a = r() < 0.6 ? { ...base } : randAttrs(r);
        if (r() < 0.5) a[pick(r, ["soleType", "closure", "finish", "toeShape"])] = pick(r, JUNK);
        entries.push([`p${String(i).padStart(3, "0")}`, a]);
      }
      const out = distinctNamesFor(entries);
      const handles = [...out.values()].map((v) => v.handle);
      expect(new Set(handles).size, `round ${round}`).toBe(handles.length);
      for (const [, v] of out) {
        expect(v.handle).toBe(handleFromName(v.name));
        expect(validateVisionName(v.name).ok, v.name).toBe(true);
      }
    }
  });

  it("distinctNamesFor is order-independent", () => {
    const r = rng(0xF00D);
    for (let round = 0; round < 100; round++) {
      const entries = Array.from({ length: 2 + Math.floor(r() * 12) },
        (_, i) => [`p${i}`, r() < 0.5 ? randAttrs(r) : randAttrs(rng(round))]);
      const a = distinctNamesFor(entries);
      const b = distinctNamesFor([...entries].reverse());
      expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
      for (const k of a.keys()) expect(b.get(k).name).toBe(a.get(k).name);
    }
  });
});

// ─── 2. THE RECORD ───────────────────────────────────────────────────────────
describe("fuzz: the attribute record never stores something illegal", () => {
  it("1,500 hostile vision payloads", () => {
    const r = rng(0x5EED);
    for (let i = 0; i < 1500; i++) {
      const vision = {};
      for (const k of VISION_FIELDS) {
        vision[k] = r() < 0.4 ? pick(r, JUNK)
          : ATTRIBUTE_FIELDS[k].list
            ? Array.from({ length: Math.floor(r() * 6) }, () => pick(r, [...STYLE_TAGS, "bogus"]))
            : pick(r, [...(ATTRIBUTE_FIELDS[k].vocab || []), "bogus", "BLACK"]);
      }
      vision.confidence = r() < 0.3 ? pick(r, JUNK) : { silhouette: r() * 2 - 0.5 };
      const product = { brand: pick(r, ["Nike", "", null]), category: "Footwear", retailPrice: pick(r, [0, 750, -5, null, 6009]) };
      const rec = buildAttributeRecord({ vision, product, model: "m", at: 1 + i });

      for (const [k, v] of Object.entries(rec.a)) {
        const spec = ATTRIBUTE_FIELDS[k];
        expect(spec, `unknown field ${k} reached the record`).toBeTruthy();
        if (spec.list) {
          expect(Array.isArray(v)).toBe(true);
          expect(v.length).toBeGreaterThan(0);          // never [] — RTDB deletes it
          expect(v.length).toBeLessThanOrEqual(MAX_STYLE_TAGS);
          for (const t of v) expect(spec.vocab).toContain(t);
        } else if (spec.vocab) {
          expect(spec.vocab, `${k}=${v}`).toContain(v);
        }
      }
      // Nothing writes the human half, ever. This is the structural reason a
      // re-run cannot clobber a correction.
      expect(rec.confirmed).toBeUndefined();
      expect(JSON.stringify(rec)).not.toContain("[]");
      for (const c of Object.values(rec.conf || {})) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it("a confirmed value ALWAYS survives a re-run, whatever the machine says", () => {
    const r = rng(0xA11CE);
    for (let i = 0; i < 800; i++) {
      const field = pick(r, ATTRIBUTE_KEYS.filter((k) => !ATTRIBUTE_FIELDS[k].list));
      const spec = ATTRIBUTE_FIELDS[field];
      const human = spec.vocab ? pick(r, spec.vocab) : "Human";
      const machine = buildAttributeRecord({ vision: randAttrs(r), product: { retailPrice: 750 }, model: "m", at: i });
      expect(resolveAttributes({ ...machine, confirmed: { [field]: human } })[field]).toBe(human);
    }
  });

  it("usableAttributes is all-or-nothing — it never returns a half-filled object", () => {
    const r = rng(0x2B2B);
    for (let i = 0; i < 1000; i++) {
      const a = randAttrs(r, { junk: 0.5 });
      const got = usableAttributes({ a });
      if (!got) continue;
      for (const k of ATTRIBUTE_KEYS) {
        if (ATTRIBUTE_FIELDS[k].required) expect(String(got[k]).length, k).toBeGreaterThan(0);
      }
    }
  });
});

// ─── 3. THE PARSER ───────────────────────────────────────────────────────────
describe("fuzz: the parser never invents a value", () => {
  it("1,000 malformed model answers", () => {
    const r = rng(0x9A9A);
    for (let i = 0; i < 1000; i++) {
      const body = {};
      for (const k of VISION_FIELDS) if (r() < 0.8) body[k] = pick(r, [...JUNK, "low-top", "leather", "black", "solid", ["retro"], "retro"]);
      if (r() < 0.5) body.confidence = pick(r, [...JUNK, { silhouette: 0.9 }, 0.5, "sure"]);
      const raw = r() < 0.15 ? pick(r, ["", "{", "null", "[]", '"x"', "```json\n{}\n```"]) : JSON.stringify(body);
      const got = parseAttributeResponse(raw);
      expect(typeof got.ok).toBe("boolean");
      if (!got.ok) continue;
      for (const [k, v] of Object.entries(got.vision)) {
        if (k === "confidence") {
          for (const c of Object.values(v)) {
            expect(typeof c).toBe("number");
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(1);
          }
          continue;
        }
        const spec = ATTRIBUTE_FIELDS[k];
        if (spec.list) {
          expect(v.length).toBeGreaterThan(0);
          expect(new Set(v).size).toBe(v.length);       // deduplicated
          for (const t of v) expect(spec.vocab).toContain(t);
        } else {
          expect(spec.vocab).toContain(v);
        }
      }
      // ok:true means every REQUIRED vision field survived.
      for (const k of VISION_FIELDS) {
        if (ATTRIBUTE_FIELDS[k].required) expect(got.vision[k], k).toBeTruthy();
      }
    }
  });
});

// ─── 4. THE RANKING ──────────────────────────────────────────────────────────
describe("fuzz: the ranking holds its invariants", () => {
  const randProfile = (r, pid) => neighbourProfile(
    { id: pid, categoryKey: pick(r, ["sneakers", "slides", "boots", "soccer-boots", ""]), brand: pick(r, ["Nike", "Adidas", "", "Boss"]), retailPrice: 750 },
    randAttrs(r));

  it("400 random pools", () => {
    const r = rng(0x1234);
    for (let round = 0; round < 400; round++) {
      const pool = [];
      for (let i = 0; i < 3 + Math.floor(r() * 40); i++) {
        const p = randProfile(r, `p${String(i).padStart(3, "0")}`);
        if (p) pool.push(p);
      }
      if (pool.length < 2) continue;
      const target = pool[0];
      const got = topNeighbours(target, pool);

      expect(got.length).toBeLessThanOrEqual(MAX_NEIGHBOURS);
      const seen = new Set();
      let prev = Infinity;
      for (const n of got) {
        expect(n.pid, "a product is its own alternative").not.toBe(target.pid);
        expect(seen.has(n.pid), "duplicate neighbour").toBe(false);
        seen.add(n.pid);
        expect(n.score, "a zero-score neighbour was stored").toBeGreaterThan(0);
        expect(n.score, "not ordered best-first").toBeLessThanOrEqual(prev);
        prev = n.score;
        // THE WALL. Not a weight — nothing may cross it, ever.
        const other = pool.find((p) => p.pid === n.pid);
        expect(silhouetteGroup(other.silhouette), "crossed the silhouette wall")
          .toBe(silhouetteGroup(target.silhouette));
      }
      // Deterministic: the same pool in any order gives the same list.
      expect(topNeighbours(target, [...pool].reverse()).map((n) => n.pid)).toEqual(got.map((n) => n.pid));
    }
  });

  it("scoring is symmetric, and no term can exceed its weight", () => {
    const r = rng(0x77AA);
    for (let i = 0; i < 1500; i++) {
      const a = randProfile(r, "pa"), b = randProfile(r, "pb");
      if (!a || !b) continue;
      expect(scorePair(a, b).score).toBeCloseTo(scorePair(b, a).score, 9);
      for (const [k, v] of Object.entries(scorePair(a, b).terms)) {
        const cap = k === "styleTag" ? SIMILARITY_WEIGHTS.styleTag * MAX_STYLE_TAGS : SIMILARITY_WEIGHTS[k];
        expect(v, `${k} exceeded its weight`).toBeLessThanOrEqual(cap + 1e-9);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  // BRAND IS A WEIGHT, NOT A FILTER — the owner decision most likely to be
  // reversed by a later edit. Over random pools, a different-brand shoe must
  // still reach the list.
  it("different-brand neighbours are reachable across the whole fuzz", () => {
    const r = rng(0x5150);
    let crossBrand = 0, total = 0;
    for (let round = 0; round < 300; round++) {
      const pool = [];
      for (let i = 0; i < 12; i++) { const p = randProfile(r, `p${i}`); if (p) pool.push(p); }
      if (pool.length < 2) continue;
      for (const n of topNeighbours(pool[0], pool)) {
        total += 1;
        if (pool.find((p) => p.pid === n.pid).brand !== pool[0].brand) crossBrand += 1;
      }
    }
    expect(total).toBeGreaterThan(100);
    expect(crossBrand / total, "brand has become a filter").toBeGreaterThan(0.2);
  });
});

// ─── 5. THE JOIN — the one a customer actually meets ─────────────────────────
describe("fuzz: nothing unsellable ever reaches the sheet", () => {
  it("1,000 random worlds", () => {
    const r = rng(0xFACE);
    for (let round = 0; round < 1000; round++) {
      const n = Math.floor(r() * 16);
      const products = {}, list = [];
      for (let i = 0; i < n; i++) {
        const pid = `q${i}`;
        products[pid] = {
          id: pid, name: `shoe ${i}`, retailPrice: pick(r, [750, 0, null]),
          photoUrl: pick(r, ["u", "", null]),
          sizes: Array.from({ length: Math.floor(r() * 5) }, () => pick(r, ["7", "8", "9", "10"])),
          deactivated: r() < 0.15 ? true : undefined,
        };
        // Malformed stored entries land in the list too — RTDB has produced
        // every one of these shapes.
        list.push(r() < 0.1 ? pick(r, ["", "nocolon", ":x", "q0:", 7, null]) : encodeNeighbour(pid, pick(r, ["s", "a", "zz"])));
      }
      const known = new Set(Object.keys(products).filter(() => r() < 0.7));
      const avail = new Map();
      for (const pid of Object.keys(products)) for (const s of products[pid].sizes) avail.set(`${pid}|${s}`, r() < 0.5);
      const requested = pick(r, ["8", "9", ""]);

      const rows = sellableAlternatives({
        neighbours: r() < 0.1 ? pick(r, [null, undefined, {}, []]) : list,
        requestedSize: requested,
        resolveProduct: (pid) => products[pid] || null,
        sizesOf: (p) => p.sizes,
        availabilityKnown: (p) => known.has(p.id),
        sizeAvailable: (p, s) => !!avail.get(`${p.id}|${s}`),
        isSellable: (p) => !p.deactivated && Number(p.retailPrice) > 0 && !!p.photoUrl,
      });

      expect(rows.length).toBeLessThanOrEqual(MAX_ALTERNATIVES_SHOWN);
      const seenIds = new Set();
      for (const row of rows) {
        const why = `round ${round} pid ${row.product.id}`;
        expect(seenIds.has(row.product.id), `duplicate row · ${why}`).toBe(false);
        seenIds.add(row.product.id);
        // THE PROPERTY THIS WHOLE BUILD RESTS ON.
        expect(known.has(row.product.id), `availability unknown · ${why}`).toBe(true);
        expect(row.product.deactivated, `deactivated · ${why}`).toBeUndefined();
        expect(Number(row.product.retailPrice), `no price · ${why}`).toBeGreaterThan(0);
        expect(!!row.product.photoUrl, `no photo · ${why}`).toBe(true);
        expect(row.sizes.length, `no sizes · ${why}`).toBeGreaterThan(0);
        for (const s of row.sizes) expect(avail.get(`${row.product.id}|${s}`), `unavailable size ${s} · ${why}`).toBe(true);
        expect(row.hasRequestedSize).toBe(!!requested && row.sizes.includes(requested));
        expect(typeof row.why).toBe("string");
        expect(row.why.length).toBeGreaterThan(0);
      }
      // Size-holders lead, and rank is preserved inside each half.
      const flags = rows.map((x) => x.hasRequestedSize);
      expect(flags, `partition broken in round ${round}`).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    }
  });

  it("parseNeighbours never yields a row without both halves", () => {
    const r = rng(0x0BAD);
    for (let i = 0; i < 3000; i++) {
      const v = pick(r, [
        null, undefined, [], {}, 7, "p1:s",
        [pick(r, JUNK), "p1:s", ":", "::", "p2:x:y"],
        { 0: "p1:s", 5: pick(r, JUNK) },
      ]);
      for (const row of parseNeighbours(v)) {
        expect(typeof row.pid).toBe("string");
        expect(row.pid.length).toBeGreaterThan(0);
        expect(typeof row.why).toBe("string");
        expect(row.why.length).toBeGreaterThan(0);
      }
    }
  });
});
