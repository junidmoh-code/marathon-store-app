// ─── COLOURWAY ANSWERS — an answered question is never asked twice ───────────
// (Owner spec 2026-08-08.) Server-side proofs: an answer stores against the
// shoe's signature (code + palette) only when the picked product is a REAL
// registered owner of the code; near-identical repeats dedupe; the lookup
// action serves the rows. The CJS paletteDistance is pinned to the client
// twin (src/utils/dominantColours.js) by parity test — the dedupe here and
// the matching there must never quietly diverge.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  COLOURWAY_ANSWERS_PATH, cleanPalette, paletteDistance, isDuplicateAnswer,
} = require("../lib/colourway-answers.cjs");
const { runSibling } = require("../styleCode/styleCodeSibling.js");
const { STYLE_CODE_INDEX_PATH } = require("../styleCode/resolveStyleCode.js");

const NOW = 1786000000000;
const ACTOR = { uid: "staff1" };
const CODE = "HF0438001"; // the owner's two-colourway evidence code

function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  let pushN = 0;
  const at = (p) => String(p).split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), data);
  const put = (p, v) => {
    const parts = String(p).split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    if (v === null) delete node[last]; else node[last] = v;
  };
  const makeRef = (p) => ({
    async get() { const v = at(p); const val = v === undefined ? null : v; return { val: () => val, exists: () => val !== null }; },
    async set(v) { put(p, v); },
    async update(patch) { for (const [k, v] of Object.entries(patch)) put(`${p}/${k}`, v); },
    push() { const id = `cw${++pushN}`; return { key: id, ...makeRef(`${p}/${id}`) }; },
    async transaction(fn) {
      const cur = at(p);
      const out = fn(cur === undefined ? null : cur);
      if (out === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
      put(p, out);
      return { committed: true, snapshot: { val: () => out } };
    },
  });
  return { data, ref: makeRef };
}

const WHITE_BLUE = [{ r: 240, g: 240, b: 245, w: 0.6 }, { r: 60, g: 120, b: 230, w: 0.4 }];
const WHITE_GRAY = [{ r: 238, g: 238, b: 240, w: 0.6 }, { r: 150, g: 150, b: 155, w: 0.4 }];

const baseDb = () => fakeDb({
  products: {
    pBlue: { id: "pBlue", name: "RTFKT White Photo Blue" },
    pGray: { id: "pGray", name: "RTFKT White Gray" },
    pStranger: { id: "pStranger", name: "Unrelated Shoe" },
  },
  [STYLE_CODE_INDEX_PATH]: {
    [CODE]: { productId: "pBlue", claimedAt: 1, claimedBy: "x", siblings: { pGray: { addedAt: 1 } } },
  },
});

// ─── Validation ──────────────────────────────────────────────────────────────
test("cleanPalette bounds and validates; garbage yields null, never a partial", () => {
  assert.strictEqual(cleanPalette(null), null);
  assert.strictEqual(cleanPalette([]), null);
  assert.strictEqual(cleanPalette([{ r: 300, g: 0, b: 0, w: 0.5 }]), null);
  assert.strictEqual(cleanPalette([{ r: 10, g: 10, b: 10, w: 0 }]), null);
  const ok = cleanPalette(WHITE_BLUE);
  assert.strictEqual(ok.length, 2);
});

test("paletteDistance parity: the CJS twin matches src/utils/dominantColours.js exactly", async () => {
  const client = await import("../../src/utils/dominantColours.js");
  for (const [a, b] of [[WHITE_BLUE, WHITE_GRAY], [WHITE_BLUE, WHITE_BLUE], [WHITE_BLUE, []]]) {
    assert.strictEqual(paletteDistance(a, b), client.paletteDistance(a, b));
  }
});

// ─── The store ───────────────────────────────────────────────────────────────
test("an answer stores for a registered owner (primary OR sibling), and dedupes", async () => {
  const db = baseDb();
  const first = await runSibling(db, {
    action: "answerColourway", code: CODE, productId: "pGray", palette: WHITE_GRAY, actor: ACTOR, nowMs: NOW,
  });
  assert.strictEqual(first.ok, true);
  assert.ok(first.answerId);
  const rows = db.data[COLOURWAY_ANSWERS_PATH][CODE];
  assert.strictEqual(Object.keys(rows).length, 1);

  // The SAME shoe photographed again (a near-identical palette): dedupe.
  const again = await runSibling(db, {
    action: "answerColourway", code: CODE, productId: "pGray",
    palette: [{ r: 240, g: 239, b: 241, w: 0.6 }, { r: 151, g: 149, b: 156, w: 0.4 }],
    actor: ACTOR, nowMs: NOW,
  });
  assert.strictEqual(again.deduped, true);
  assert.strictEqual(Object.keys(db.data[COLOURWAY_ANSWERS_PATH][CODE]).length, 1);
  assert.ok(isDuplicateAnswer(rows, "pGray", WHITE_GRAY));
});

test("a product that is NOT a registered owner of the code is refused", async () => {
  const db = baseDb();
  await assert.rejects(
    runSibling(db, { action: "answerColourway", code: CODE, productId: "pStranger", palette: WHITE_BLUE, actor: ACTOR, nowMs: NOW }),
    /not a registered owner/);
  assert.strictEqual(db.data[COLOURWAY_ANSWERS_PATH], undefined, "nothing may be stored");
});

test("colourwayAnswers serves the rows the picker matches against", async () => {
  const db = baseDb();
  await runSibling(db, { action: "answerColourway", code: CODE, productId: "pBlue", palette: WHITE_BLUE, actor: ACTOR, nowMs: NOW });
  const out = await runSibling(db, { action: "colourwayAnswers", code: CODE, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.answers.length, 1);
  assert.strictEqual(out.answers[0].productId, "pBlue");
  assert.ok(Array.isArray(out.answers[0].p));
});

test("answers are served MERGE-RESOLVED; rows pointing at nothing live are dropped", async () => {
  const db = baseDb();
  await runSibling(db, { action: "answerColourway", code: CODE, productId: "pGray", palette: WHITE_GRAY, actor: ACTOR, nowMs: NOW });
  // pGray is merged away after the answer was stored — the picker must be
  // handed the SURVIVOR, never the hidden record (CodeRabbit, PR #334).
  db.data.products.pGray.mergedInto = "pBlue";
  const out = await runSibling(db, { action: "colourwayAnswers", code: CODE, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.answers.length, 1);
  assert.strictEqual(out.answers[0].productId, "pBlue");
  // …and a row whose product chain dead-ends vanishes rather than misleads.
  delete db.data.products.pBlue;
  const gone = await runSibling(db, { action: "colourwayAnswers", code: CODE, actor: ACTOR, nowMs: NOW });
  assert.deepStrictEqual(gone.answers, []);
});

test("a sub-1% weight survives rounding as a positive weight, never 0", () => {
  const clean = cleanPalette([{ r: 10, g: 10, b: 10, w: 0.99 }, { r: 200, g: 200, b: 200, w: 0.004 }]);
  assert.ok(clean.every((sw) => sw.w > 0), "a stored 0 weight would violate the invariant and distort distances");
});
