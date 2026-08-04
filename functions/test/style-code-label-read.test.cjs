// ─── readStyleCodeLabel — THE FUNNEL, AND THE OCR CACHE REAPER ───────────────
// Tiers 1 and 2 are exercised with injected fetch implementations, so the whole
// funnel — cache hit, Vision read, the tier-2 escalation rule, validation of
// what the model returned, and what lands in the cache node — is covered with
// no network and no firebase-admin.
//
// The rule under test that matters most: TIER 2 FIRES ONLY ON THE RESIDUAL.
// Escalating on every photo would spend the expensive model on labels Vision
// already read perfectly, which is the entire cost argument for the funnel.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { runLabelRead, runGeminiRead, TIER2_MODEL } = require("../styleCode/readStyleCodeLabel.js");
const { runReap, CURSOR_KEY } = require("../styleCode/reapOcrCache.js");
const { OCR_CACHE_PATH, OCR_CACHE_TTL_MS, imageHash } = require("../lib/style-code-ocr.cjs");

const NOW = 1754300000000;
const IMG = Buffer.from("fake-label-photo-bytes");
const B64 = IMG.toString("base64");
const HASH = imageHash(IMG);

function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const at = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), data);
  const put = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    if (value === null) delete node[last]; else node[last] = value;
  };
  const makeRef = (path) => ({
    async get() { const v = at(path); const val = v === undefined ? null : v; return { val: () => val, exists: () => val !== null }; },
    async set(v) { put(path, v); },
    async update(patch) { for (const [k, v] of Object.entries(patch)) put(`${path}/${k}`, v); },
    child(k) { return makeRef(`${path}/${k}`); },
    orderByKey() {
      let after = "", limit = Infinity;
      const q = {
        startAfter(c) { after = c; return q; },
        limitToFirst(n) { limit = n; return q; },
        async get() {
          const node = at(path) || {};
          const keys = Object.keys(node).sort().filter((k) => k > after).slice(0, limit);
          const out = {};
          for (const k of keys) out[k] = node[k];
          return { val: () => (keys.length ? out : null) };
        },
      };
      return q;
    },
  });
  return { data, ref: makeRef };
}

const visionOk = (text) => async () => ({ ok: true, status: 200, async json() {
  return { responses: [{ fullTextAnnotation: { text } }] };
} });
const visionFail = (status) => async () => ({ ok: false, status, async json() { return {}; } });
const TOKEN = async () => "fake-token";

const geminiOk = (obj) => async () => ({ ok: true, status: 200, async json() {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] };
} });

const NIKE_LABEL = "NIKE, INC.\nBEAVERTON, OR 97005 USA\nCT8527-016\nUS 9 UK 8 EUR 42.5\n08/15/19 - 01/20/20";

const base = (over = {}) => ({
  buffer: IMG, base64: B64, mimeType: "image/jpeg", nowMs: NOW, geminiKey: "k",
  tokenFn: TOKEN, ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
test("tier 1 reads a clean label and tier 2 never fires", async () => {
  const db = fakeDb({});
  let geminiCalls = 0;
  const out = await runLabelRead(db, base({
    visionFetch: visionOk(NIKE_LABEL),
    geminiFetch: async () => { geminiCalls++; throw new Error("must not be called"); },
  }));

  assert.deepStrictEqual(out.candidates, ["CT8527016"]);
  assert.deepStrictEqual(out.displayCandidates, ["CT8527-016"]);
  assert.strictEqual(out.source, "vision");
  assert.strictEqual(out.tier2Used, false);
  assert.strictEqual(geminiCalls, 0, "the expensive model must not see a label OCR already read");
});

test("tier 2 fires on ZERO tier-1 candidates", async () => {
  const db = fakeDb({});
  const out = await runLabelRead(db, base({
    visionFetch: visionOk("MADE IN VIETNAM\nUS 9"),
    geminiFetch: geminiOk({ styleCode: "IE3437", brand: "adidas", size: "9", styleCodeConfidence: 0.9 }),
  }));

  assert.strictEqual(out.tier2Used, true);
  assert.deepStrictEqual(out.candidates, ["IE3437"]);
  assert.strictEqual(out.source, "gemini");
  assert.strictEqual(out.brand, "adidas");
  assert.strictEqual(out.confidence, 0.9);
});

test("tier 2 fires on MORE THAN ONE tier-1 candidate, and disambiguates", async () => {
  const db = fakeDb({});
  const out = await runLabelRead(db, base({
    visionFetch: visionOk("CT8527-016\nIE3437"),
    geminiFetch: geminiOk({ styleCode: "CT8527-016", styleCodeConfidence: 0.95 }),
  }));

  assert.strictEqual(out.tier2Used, true);
  assert.deepStrictEqual(out.candidates, ["CT8527016"], "the ambiguity is resolved to one code");
});

test("VALIDATION: a hallucinated code is discarded, never passed downstream", async () => {
  const db = fakeDb({});
  for (const junk of ["AIR JORDAN 4", "US 9", "08/15/19", "NIKE", ""]) {
    const out = await runLabelRead(fakeDb({}), base({
      visionFetch: visionOk("nothing useful"),
      geminiFetch: geminiOk({ styleCode: junk, styleCodeConfidence: 0.99 }),
    }));
    assert.deepStrictEqual(out.candidates, [], `"${junk}" must not survive validation`);
  }
  void db;
});

test("THE TRUNCATION GUARD: tier 2 may not shorten a code tier 1 read in full", async () => {
  // Shape validation alone CANNOT catch this: "CT8527" is a legitimate
  // adidas-block shape, so a model that drops the "-016" returns something that
  // looks perfectly valid. Context catches it — tier 1 read the longer code, so
  // tier 2's prefix is a truncation, and truncation is the collapse this whole
  // feature forbids (CT8527-016 and CT8527-700 would become one product).
  const out = await runLabelRead(fakeDb({}), base({
    visionFetch: visionOk("CT8527-016\nIE3437"),          // two candidates -> tier 2 fires
    geminiFetch: geminiOk({ styleCode: "CT8527", styleCodeConfidence: 0.99 }),
  }));
  assert.ok(out.candidates.includes("CT8527016"), "tier 1's full read must stand");
  assert.ok(!out.candidates.includes("CT8527"), "the truncated answer must be discarded");
});

test("a bare adidas-shaped code with no tier-1 context is legitimately accepted", async () => {
  // The mirror of the guard above: with nothing to contradict it, "CT8527" is a
  // real adidas-block shape and refusing it would be wrong.
  const out = await runLabelRead(fakeDb({}), base({
    visionFetch: visionOk("MADE IN VIETNAM"),
    geminiFetch: geminiOk({ styleCode: "CT8527", styleCodeConfidence: 0.9 }),
  }));
  assert.deepStrictEqual(out.candidates, ["CT8527"]);
});

test("runGeminiRead surfaces the rejected read for logging but never uses it", async () => {
  const g = await runGeminiRead(B64, "image/jpeg", "k", {
    fetchImpl: geminiOk({ styleCode: "AIR JORDAN 4", styleCodeConfidence: 1 }),
  });
  assert.strictEqual(g.code, null);
  assert.strictEqual(g.rejectedRead, "AIR JORDAN 4");
});

test("the tier-2 model is the full Flash, not a Lite variant", () => {
  assert.strictEqual(TIER2_MODEL, "gemini-3.6-flash");
  assert.ok(!/lite/i.test(TIER2_MODEL), "tier 2 only sees the residual OCR already failed on");
});

// ── Cost control ─────────────────────────────────────────────────────────────
test("a retake of the same photo is served from cache and re-bills nothing", async () => {
  const db = fakeDb({});
  let visionCalls = 0;
  const counting = (text) => async (...a) => { visionCalls++; return visionOk(text)(...a); };

  await runLabelRead(db, base({ visionFetch: counting(NIKE_LABEL), geminiFetch: geminiOk({}) }));
  assert.strictEqual(visionCalls, 1);

  const second = await runLabelRead(db, base({ visionFetch: counting(NIKE_LABEL), geminiFetch: geminiOk({}) }));
  assert.strictEqual(visionCalls, 1, "the identical photo must not be re-processed");
  assert.strictEqual(second.fromCache, true);
  assert.deepStrictEqual(second.candidates, ["CT8527016"]);
});

test("THE CACHE NODE HOLDS CODES ONLY — never the Vision payload", async () => {
  const db = fakeDb({});
  await runLabelRead(db, base({ visionFetch: visionOk(NIKE_LABEL), geminiFetch: geminiOk({}) }));
  const row = db.data[OCR_CACHE_PATH][HASH];
  assert.deepStrictEqual(Object.keys(row).sort(), ["at", "candidates", "expiresAt", "source"]);
  assert.deepStrictEqual(row.candidates, ["CT8527016"]);
  assert.strictEqual(row.expiresAt - row.at, OCR_CACHE_TTL_MS);
  assert.ok(JSON.stringify(row).length < 200, "one row must stay tiny — this node is a bandwidth risk");
});

test("an unreadable photo is cached too, so retries do not re-bill", async () => {
  const db = fakeDb({});
  const out = await runLabelRead(db, base({
    visionFetch: visionOk("MADE IN VIETNAM"),
    geminiFetch: geminiOk({ styleCode: "", styleCodeConfidence: 0 }),
  }));
  assert.deepStrictEqual(out.candidates, []);
  assert.ok(db.data[OCR_CACHE_PATH][HASH], "a blank result is still an answer worth remembering");
});

test("an expired cache row is not served", async () => {
  const db = fakeDb({
    [OCR_CACHE_PATH]: { [HASH]: { candidates: ["OLD1234"], source: "vision", at: 0, expiresAt: NOW - 1 } },
  });
  const out = await runLabelRead(db, base({ visionFetch: visionOk(NIKE_LABEL), geminiFetch: geminiOk({}) }));
  assert.deepStrictEqual(out.candidates, ["CT8527016"]);
  assert.strictEqual(out.fromCache, false);
});

// ── Failure handling ─────────────────────────────────────────────────────────
test("a broken Vision tier falls through to tier 2 rather than failing the read", async () => {
  const db = fakeDb({});
  const out = await runLabelRead(db, base({
    visionFetch: visionFail(503),
    geminiFetch: geminiOk({ styleCode: "IE3437", styleCodeConfidence: 0.8 }),
  }));
  assert.deepStrictEqual(out.candidates, ["IE3437"]);
  assert.strictEqual(out.errors.length, 1);
  assert.strictEqual(out.errors[0].tier, "vision");
});

test("both tiers broken returns no candidates AND the errors — never a false 'unreadable'", async () => {
  const db = fakeDb({});
  const out = await runLabelRead(db, base({
    visionFetch: visionFail(500),
    geminiFetch: async () => ({ ok: false, status: 429, async json() { return {}; } }),
  }));
  assert.deepStrictEqual(out.candidates, []);
  assert.strictEqual(out.errors.length, 2);
  assert.strictEqual(db.data[OCR_CACHE_PATH], undefined,
    "an outage must NOT be cached as 'this photo has no code' for 90 days");
});

test("a missing Gemini key is REPORTED as a tier-2 error, not a blank read", async () => {
  // The original version of this test fed Vision a clean label, so tier 1
  // answered, tier 2 never ran, and the missing-key branch was never reached —
  // the test asserted nothing about the thing it was named for. Force tier 1 to
  // come back empty so tier 2 actually runs. (CodeRabbit, PR #312.)
  const db = fakeDb({});
  const out = await runLabelRead(db, base({
    geminiKey: "",
    visionFetch: visionOk("MADE IN VIETNAM"),          // zero candidates -> tier 2 IS attempted
    geminiFetch: async () => { throw new Error("must not be reached without a key"); },
  }));

  assert.deepStrictEqual(out.candidates, []);
  assert.strictEqual(out.tier2Used, true);
  assert.strictEqual(out.errors.length, 1);
  assert.strictEqual(out.errors[0].tier, "gemini");
  assert.match(out.errors[0].message, /GEMINI_API_KEY is not configured/);
});

test("tier 1 answering on its own still needs no Gemini key", async () => {
  const db = fakeDb({});
  const out = await runLabelRead(db, base({
    geminiKey: "", visionFetch: visionOk(NIKE_LABEL),
    geminiFetch: async () => { throw new Error("must not be called"); },
  }));
  assert.deepStrictEqual(out.candidates, ["CT8527016"]);
  assert.strictEqual(out.tier2Used, false);
  assert.deepStrictEqual(out.errors, []);
});

// ── A TIER-2 FAILURE MUST NOT FREEZE AN AMBIGUOUS ANSWER FOR 90 DAYS ─────────
test("an AMBIGUOUS read is NOT cached when tier 2 failed", async () => {
  // Vision finds two codes, Gemini (which exists to disambiguate) throws. The
  // answer is unresolved. Caching it would pin that ambiguity for the full TTL,
  // because every later read of the photo returns from cache before tier 2 is
  // retried — a transient outage becomes permanent. (CodeRabbit, PR #312.)
  const db = fakeDb({});
  const out = await runLabelRead(db, base({
    visionFetch: visionOk("CT8527-016\nIE3437"),
    geminiFetch: async () => ({ ok: false, status: 503, async json() { return {}; } }),
  }));

  assert.strictEqual(out.candidates.length, 2, "still ambiguous");
  assert.strictEqual(db.data[OCR_CACHE_PATH], undefined, "an unsettled answer must never be cached");
});

test("the same photo gets a REAL second chance once Gemini recovers", async () => {
  const db = fakeDb({});
  await runLabelRead(db, base({
    visionFetch: visionOk("CT8527-016\nIE3437"),
    geminiFetch: async () => ({ ok: false, status: 503, async json() { return {}; } }),
  }));
  // Gemini is back.
  const retry = await runLabelRead(db, base({
    visionFetch: visionOk("CT8527-016\nIE3437"),
    geminiFetch: geminiOk({ styleCode: "CT8527-016", styleCodeConfidence: 0.95 }),
  }));
  assert.strictEqual(retry.fromCache, false, "the outage must not have pinned the earlier answer");
  assert.deepStrictEqual(retry.candidates, ["CT8527016"]);
  assert.ok(db.data[OCR_CACHE_PATH][HASH], "now it is settled, so now it caches");
});

test("a SETTLED single-candidate read still caches", async () => {
  const db = fakeDb({});
  await runLabelRead(db, base({ visionFetch: visionOk(NIKE_LABEL), geminiFetch: geminiOk({}) }));
  assert.deepStrictEqual(db.data[OCR_CACHE_PATH][HASH].candidates, ["CT8527016"]);
});

test("a settled EMPTY read still caches — a blank label must not re-bill", async () => {
  const db = fakeDb({});
  await runLabelRead(db, base({
    visionFetch: visionOk("MADE IN VIETNAM"),
    geminiFetch: geminiOk({ styleCode: "", styleCodeConfidence: 0 }),
  }));
  assert.deepStrictEqual(db.data[OCR_CACHE_PATH][HASH].candidates, []);
});

// ── The reaper ───────────────────────────────────────────────────────────────
test("the reaper deletes expired rows and keeps live ones", async () => {
  const db = fakeDb({
    [OCR_CACHE_PATH]: {
      aaa: { candidates: ["A1234567"], expiresAt: NOW - 1 },
      bbb: { candidates: ["B1234567"], expiresAt: NOW + 1000 },
      ccc: { candidates: ["C1234567"], expiresAt: NOW - 5000 },
    },
  });
  const out = await runReap(db, { nowMs: NOW });
  assert.strictEqual(out.deleted, 2);
  assert.strictEqual(db.data[OCR_CACHE_PATH].aaa, undefined);
  assert.strictEqual(db.data[OCR_CACHE_PATH].ccc, undefined);
  assert.ok(db.data[OCR_CACHE_PATH].bbb, "an unexpired row must survive");
});

test("the reaper is BOUNDED — it reads a page, not the whole node", async () => {
  const rows = {};
  for (let i = 0; i < 50; i++) rows[`k${String(i).padStart(3, "0")}`] = { candidates: [], expiresAt: NOW - 1 };
  const db = fakeDb({ [OCR_CACHE_PATH]: rows });

  const first = await runReap(db, { nowMs: NOW, batch: 10 });
  assert.strictEqual(first.scanned, 10, "one run must not download the node");
  assert.strictEqual(first.deleted, 10);
  assert.strictEqual(first.wrapped, false);
  assert.strictEqual(db.data[OCR_CACHE_PATH][CURSOR_KEY], "k009", "the cursor remembers where it stopped");

  const second = await runReap(db, { nowMs: NOW, batch: 10 });
  assert.strictEqual(second.scanned, 10);
  assert.ok(!Object.keys(db.data[OCR_CACHE_PATH]).includes("k015"), "the second page advanced past the first");
});

test("the reaper wraps to the start when it reaches the end", async () => {
  const db = fakeDb({ [OCR_CACHE_PATH]: { aaa: { candidates: [], expiresAt: NOW + 1 } } });
  const out = await runReap(db, { nowMs: NOW, batch: 10 });
  assert.strictEqual(out.wrapped, true);
  assert.strictEqual(db.data[OCR_CACHE_PATH][CURSOR_KEY], "", "next run starts from the beginning again");
});

test("the reaper never treats its own cursor as a cache row", async () => {
  const db = fakeDb({ [OCR_CACHE_PATH]: { [CURSOR_KEY]: "", aaa: { candidates: [], expiresAt: NOW - 1 } } });
  const out = await runReap(db, { nowMs: NOW, batch: 10 });
  assert.strictEqual(out.deleted, 1);
  assert.strictEqual(typeof db.data[OCR_CACHE_PATH][CURSOR_KEY], "string");
});

// ── THE BUG THIS SUITE MISSED FIRST TIME ROUND ───────────────────────────────
// The original version of the test above used 2 rows with batch 10, so the page
// was never FULL and the wrap arithmetic was never stressed. That is precisely
// how the defect below shipped: `_cursor` occupies one of the `batch` slots the
// query returns, so counting the FILTERED rows makes a full page look short.
// (CodeRabbit, PR #312.)
// Cache keys are lowercase sha256 hex, so they span "0"–"9" and "a"–"f".
// `_` is 0x5F: AFTER "9" (0x39) and BEFORE "a" (0x61). So `_cursor` lands in the
// middle of a realistic key range — which is exactly what makes it fall inside
// a page and consume one of the `batch` slots. A fixture of digit-leading keys
// only would put `_cursor` last and never reproduce the bug.
const expired = () => ({ candidates: [], expiresAt: NOW - 1 });
function hexKeyRows(nDigitLeading, nLetterLeading) {
  const rows = { [CURSOR_KEY]: "" };
  for (let i = 0; i < nDigitLeading; i++) rows[String(i).padStart(2, "0")] = expired();      // "00".."NN"
  for (let i = 0; i < nLetterLeading; i++) rows[`a${String(i).padStart(2, "0")}`] = expired(); // "a00".."aNN"
  return rows;
}

test("a FULL page containing the cursor key does NOT wrap early", async () => {
  // 9 digit-leading rows, then `_cursor`, then letter-leading rows. The first
  // page of 10 is therefore 9 real rows + `_cursor` — genuinely full.
  const db = fakeDb({ [OCR_CACHE_PATH]: hexKeyRows(9, 10) });

  const first = await runReap(db, { nowMs: NOW, batch: 10 });
  // The query returned 10 children; one was `_cursor`, so only 9 are reapable.
  // That must NOT be read as "the end of the node".
  assert.strictEqual(first.deleted, 9);
  assert.strictEqual(first.wrapped, false, "a full page must never wrap — the cursor would reset to the start");
  assert.strictEqual(first.nextCursor, CURSOR_KEY, "the cursor advances to the last RAW key of the page");

  // And the run after it must make progress rather than re-reading page one.
  const second = await runReap(db, { nowMs: NOW, batch: 10 });
  assert.ok(second.deleted > 0, "the sweep must reach rows beyond the first page");
  assert.notStrictEqual(second.nextCursor, first.nextCursor);
});

test("repeated runs eventually clear the WHOLE node, never looping on page one", async () => {
  const db = fakeDb({ [OCR_CACHE_PATH]: hexKeyRows(20, 25) });

  let deleted = 0;
  for (let run = 0; run < 12; run++) deleted += (await runReap(db, { nowMs: NOW, batch: 10 })).deleted;

  assert.strictEqual(deleted, 45, "every expired row must be reaped");
  const left = Object.keys(db.data[OCR_CACHE_PATH]).filter((k) => k !== CURSOR_KEY);
  assert.deepStrictEqual(left, [], "an unbounded node is the cost problem this function exists to prevent");
});

test("the next cursor is the LEXICOGRAPHICALLY highest key, not object-property order", async () => {
  // .val() gives a plain object; property order is not a promise to reflect
  // orderByKey. If the last property isn't the highest key, the next page skips
  // rows and they are never reaped.
  const db = fakeDb({ [OCR_CACHE_PATH]: {} });
  // Insert deliberately out of lexicographic order.
  for (const k of ["ccc", "aaa", "bbb"]) db.data[OCR_CACHE_PATH][k] = { candidates: [], expiresAt: NOW + 10000 };

  const out = await runReap(db, { nowMs: NOW, batch: 3 });
  assert.strictEqual(out.nextCursor, "ccc");
});

test("a row with no usable expiresAt is LEFT ALONE, not deleted", async () => {
  const db = fakeDb({
    [OCR_CACHE_PATH]: { aaa: { candidates: ["A1234567"] }, bbb: { candidates: [], expiresAt: "soon" } },
  });
  const out = await runReap(db, { nowMs: NOW, batch: 10 });
  assert.strictEqual(out.deleted, 0, "deleting data we cannot reason about is worse than keeping it");
  assert.ok(db.data[OCR_CACHE_PATH].aaa);
  assert.ok(db.data[OCR_CACHE_PATH].bbb);
});

test("the reaper on an empty node is a no-op", async () => {
  const db = fakeDb({});
  const out = await runReap(db, { nowMs: NOW, batch: 10 });
  assert.deepStrictEqual([out.scanned, out.deleted, out.wrapped], [0, 0, true]);
});
