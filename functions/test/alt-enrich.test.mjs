// lib/alt-enrich.mjs — automatic enrichment + the alternatives profile.
// A fake RTDB that behaves like the real one where it matters: an empty array
// (or an object left empty) is DELETED and reads back null, an array with a
// hole comes back as an object, update() merges, null deletes, and a
// transaction handler is called with null FIRST (the cached guess) before the
// server value.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  refreshAltProfile, needsVision, profileInputsChanged, inAlternativesScope, sastDay,
  ENRICH_ROOT, DAILY_VISION_CAP,
} from "../lib/alt-enrich.mjs";
import { decodeAltProfile } from "../lib/alt-shared/altProfile.js";
import { EXTRACTOR_VERSION } from "../lib/alt-shared/productAttributes.js";

function coerce(v) {
  if (Array.isArray(v)) {
    const o = {};
    v.forEach((x, i) => { const c = coerce(x); if (c !== null && c !== undefined) o[String(i)] = c; });
    return Object.keys(o).length ? o : null;
  }
  if (v && typeof v === "object") {
    if (v[".sv"]) return 1790000000000;
    const o = {};
    for (const [k, x] of Object.entries(v)) { const c = coerce(x); if (c !== null && c !== undefined) o[k] = c; }
    return Object.keys(o).length ? o : null;
  }
  return v === undefined ? null : v;
}
function revive(v) {
  if (!v || typeof v !== "object") return v;
  const ks = Object.keys(v);
  if (ks.length && ks.every((k, i) => k === String(i))) return ks.map((k) => revive(v[k]));
  const o = {}; for (const k of ks) o[k] = revive(v[k]); return o;
}
export function fakeDb(initial = {}) {
  let root = coerce(initial) || {};
  const segs = (p) => String(p).split("/").filter(Boolean);
  const read = (p) => { let n = root; for (const s of segs(p)) { if (!n || typeof n !== "object") return null; n = n[s]; } return n === undefined ? null : n; };
  const write = (p, v) => {
    const ss = segs(p); const c = coerce(v);
    if (!ss.length) { root = c || {}; return; }
    const stack = [root]; let n = root;
    for (const s of ss.slice(0, -1)) { if (!n[s] || typeof n[s] !== "object") n[s] = {}; n = n[s]; stack.push(n); }
    const last = ss[ss.length - 1];
    if (c === null) delete n[last]; else n[last] = c;
    // prune parents left empty, like RTDB
    for (let i = ss.length - 1; i > 0; i--) { const parent = stack[i - 1]; const k = ss[i - 1]; if (parent[k] && typeof parent[k] === "object" && !Object.keys(parent[k]).length) delete parent[k]; }
  };
  const snap = (v, key) => ({ val: () => revive(v === undefined ? null : JSON.parse(JSON.stringify(v ?? null))), key,
    forEach: (fn) => { for (const [k, x] of Object.entries(v || {})) if (fn(snap(x, k)) === true) return true; return false; } });
  const writes = [];
  const ref = (p) => {
    const q = { child: null, start: null, end: null, limit: Infinity };
    const api = {
      get: async () => {
        if (q.child === null) return snap(read(p), segs(p).pop());
        const all = read(p) || {};
        const rows = Object.entries(all).filter(([, x]) => { const c = x?.[q.child]; return typeof c === "string" && (q.start === null || c >= q.start) && (q.end === null || c <= q.end); })
          .sort((a, b) => String(a[1][q.child]).localeCompare(String(b[1][q.child]))).slice(0, q.limit);
        return snap(Object.fromEntries(rows), segs(p).pop());
      },
      set: async (v) => { writes.push(["set", p, v]); write(p, v); },
      update: async (patch) => { writes.push(["update", p, patch]); for (const [k, v] of Object.entries(patch)) write(`${p}/${k}`, v); },
      remove: async () => { writes.push(["remove", p]); write(p, null); },
      transaction: async (fn) => {
        // Optimistic first call with the CACHED value (null), then the server's.
        const guess = fn(null);
        const cur = revive(read(p));
        const out = cur === null && guess !== undefined ? guess : fn(cur);
        if (out === undefined) return { committed: false };
        write(p, out); writes.push(["txn", p, out]);
        return { committed: true };
      },
      orderByChild: (c) => { q.child = c; return api; },
      startAt: (s) => { q.start = s; return api; },
      endAt: (e) => { q.end = e; return api; },
      limitToFirst: (n) => { q.limit = n; return api; },
    };
    return api;
  };
  return { ref, read: (p) => revive(read(p)), writes };
}

const DUCKS = {
  id: "p1790157727504", name: "Nike Air Force 1 Low Ducks of a Feather University of Oregon Duck or Egg",
  brand: "Nike", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", retailPrice: 750,
  photoUrl: "https://example.invalid/ducks.jpg", sizes: ["6", "7", "8"], styleCodeNormalised: "IU7612700",
};
const VISION_JSON = JSON.stringify({
  silhouette: "low-top", upperMaterial: "leather", primaryColour: "white", secondaryColour: "green",
  pattern: "multi", toeShape: "round", soleColour: "white", soleType: "cup", closure: "laced", finish: "plain",
  styleTags: ["retro", "basketball"], confidence: { silhouette: 0.9 },
});
const deps = (db, extra = {}) => ({ db, now: () => 1790000000000, serverTimestamp: { ".sv": "timestamp" }, ...extra });

test("an unenriched sneaker is read by vision once and indexed", async () => {
  const db = fakeDb({ products: { [DUCKS.id]: DUCKS } });
  let calls = 0;
  const r = await refreshAltProfile(deps(db, { vision: async () => { calls += 1; return VISION_JSON; } }), DUCKS.id);
  assert.equal(r.status, "written");
  assert.equal(r.vision, "read");
  assert.equal(calls, 1);
  const attrs = db.read(`product_attributes/${DUCKS.id}`);
  assert.equal(attrs.v, EXTRACTOR_VERSION);
  assert.equal(attrs.photo, DUCKS.photoUrl);
  assert.equal(attrs.a.primaryColour, "white");
  const prof = decodeAltProfile(db.read(`products/${DUCKS.id}/altProfile`));
  assert.equal(prof.fam, "nike-air-force-1");
  assert.equal(prof.famSrc, "name");
  assert.equal(prof.cut, "low");
  assert.equal(prof.col, "white");
  assert.equal(prof.col2, "green");
  assert.equal(prof.en, true);
  // Second run: nothing to do, nothing paid.
  const again = await refreshAltProfile(deps(db, { vision: async () => { calls += 1; return VISION_JSON; } }), DUCKS.id);
  assert.equal(again.status, "unchanged");
  assert.equal(calls, 1);
});

test("a replaced photo is read again; a pre-stamp record is trusted", async () => {
  assert.equal(needsVision(DUCKS, { v: EXTRACTOR_VERSION, a: { silhouette: "low-top" } }), false);
  assert.equal(needsVision(DUCKS, { v: EXTRACTOR_VERSION, a: {}, photo: DUCKS.photoUrl }), false);
  assert.equal(needsVision(DUCKS, { v: EXTRACTOR_VERSION, a: {}, photo: "https://example.invalid/old.jpg" }), true);
  assert.equal(needsVision(DUCKS, null), true);
  assert.equal(needsVision({ ...DUCKS, photoUrl: "" }, null), false);
});

test("a vision failure is recorded, and the profile is still written from the name", async () => {
  const db = fakeDb({ products: { [DUCKS.id]: DUCKS } });
  const r = await refreshAltProfile(deps(db, { vision: async () => { throw new Error("Gemini HTTP 402"); } }), DUCKS.id);
  assert.equal(r.vision, "failed");
  assert.equal(r.status, "written");
  assert.match(db.read(`${ENRICH_ROOT}/failures/${DUCKS.id}`).error, /402/);
  const prof = decodeAltProfile(db.read(`products/${DUCKS.id}/altProfile`));
  assert.equal(prof.fam, "nike-air-force-1");
  assert.equal(prof.en, false);
  // A later success clears the failure.
  db.ref(`${ENRICH_ROOT}/claims/${DUCKS.id}`).remove();
  await refreshAltProfile(deps(db, { now: () => 1790000000000 + 20 * 60 * 1000, vision: async () => VISION_JSON }), DUCKS.id);
  assert.equal(db.read(`${ENRICH_ROOT}/failures/${DUCKS.id}`), null);
});

test("the switch, the claim and the daily cap each stop the vision call", async () => {
  const off = fakeDb({ products: { [DUCKS.id]: DUCKS }, config: { alternatives: { autoEnrich: false } } });
  let calls = 0; const v = async () => { calls += 1; return VISION_JSON; };
  assert.equal((await refreshAltProfile(deps(off, { vision: v }), DUCKS.id)).vision, "switched-off");
  const claimed = fakeDb({ products: { [DUCKS.id]: DUCKS }, [ENRICH_ROOT]: { claims: { [DUCKS.id]: { at: 1790000000000 - 1000, photo: DUCKS.photoUrl } } } });
  assert.equal((await refreshAltProfile(deps(claimed, { vision: v }), DUCKS.id)).vision, "claimed");
  const spent = fakeDb({ products: { [DUCKS.id]: DUCKS }, [ENRICH_ROOT]: { budget: { [sastDay(1790000000000)]: DAILY_VISION_CAP } } });
  assert.equal((await refreshAltProfile(deps(spent, { vision: v }), DUCKS.id)).vision, "over-budget");
  assert.equal(calls, 0);
  // ...and the profile is written anyway each time.
  for (const db of [off, claimed, spent]) assert.ok(db.read(`products/${DUCKS.id}/altProfile`));
});

test("never writes onto a deleted product, and ignores what is not footwear", async () => {
  const db = fakeDb({ products: {} });
  assert.equal((await refreshAltProfile(deps(db, { vision: async () => VISION_JSON }), DUCKS.id)).status, "gone");
  assert.equal(db.read(`products/${DUCKS.id}`), null);
  const tee = { id: "pt", name: "Tee", category: "Clothing", productType: "clothing", photoUrl: "x", retailPrice: 300 };
  const db2 = fakeDb({ products: { pt: tee } });
  assert.equal((await refreshAltProfile(deps(db2, { vision: async () => VISION_JSON }), "pt")).status, "out-of-scope");
  assert.equal(inAlternativesScope({ ...DUCKS, mergedInto: "x" }), false);
});

test("a style-code sibling names the family when the name does not", async () => {
  const plain = { ...DUCKS, id: "p2", name: "Nike Green Duck", styleCodeNormalised: "CW2288001" };
  const sib = { ...DUCKS, id: "p3", name: "Nike Air Force 1 '07 White", styleCodeNormalised: "CW2288111" };
  const db = fakeDb({ products: { p2: plain, p3: sib } });
  await refreshAltProfile(deps(db), "p2");
  const prof = decodeAltProfile(db.read("products/p2/altProfile"));
  assert.equal(prof.fam, "nike-air-force-1");
  assert.equal(prof.famSrc, "stylecode");
});

test("only a change to what the profile reads re-runs the trigger", () => {
  assert.equal(profileInputsChanged(DUCKS, { ...DUCKS, altProfile: "1|x" }), false);
  assert.equal(profileInputsChanged(DUCKS, { ...DUCKS, alternatives: ["a:x"] }), false);
  assert.equal(profileInputsChanged(DUCKS, { ...DUCKS, name: "Nike Air Force 1 White" }), true);
  assert.equal(profileInputsChanged(DUCKS, { ...DUCKS, photoUrl: "https://example.invalid/new.jpg" }), true);
  assert.equal(profileInputsChanged(DUCKS, { ...DUCKS, altRefreshAt: 5 }), true);
  assert.equal(profileInputsChanged(null, DUCKS), true);
  assert.equal(profileInputsChanged(DUCKS, null), false);
});

test("empty style tags never reach the database as []", async () => {
  const db = fakeDb({ products: { [DUCKS.id]: DUCKS } });
  await refreshAltProfile(deps(db, { vision: async () => JSON.stringify({ ...JSON.parse(VISION_JSON), styleTags: [] }) }), DUCKS.id);
  const attrs = db.read(`product_attributes/${DUCKS.id}`);
  assert.equal(attrs.a.styleTags, undefined);
  assert.deepEqual(decodeAltProfile(db.read(`products/${DUCKS.id}/altProfile`)).tags, []);
});
