// ─── MULTI-TOKEN LABEL IDENTITY — the 2026-08-13 root-cause proofs ───────────
// (Owner spec 2026-08-13, proven from physical labels the same day.) The OCR
// used to capture ONE line off a label, and WHICH line it captured varied
// between registrations — "Lacoster white" holds its PRODUCTION line
// (35289 0625 → 352890625), not its article code (45SMA0018); the Timberland
// holds A5VACM while its label prints A6CWNEN3 and A8425. The fix: identity is
// the SET of tokens on a label. These tests are the owner's mandatory proofs:
//
//   P1  the Lacoste label yields 45SMA0018 AND the production token AND the
//       model-name line, separately;
//   P2  the Timberland label yields BOTH A6CWNEN3 and A8425;
//   P3  a scan of the Lacoste label RESOLVES to the existing product holding
//       352890-625 via the production token — no migration, no typing;
//   P4  a later scan matching ANY ONE registered token resolves silently;
//   P5  a token owned by a DIFFERENT product routes to the duplicate flow —
//       resolveAnyCode returns every owner and refuses to pick;
//   P6  tier 2 PREFERS, it no longer erases — and it harvests its own extra
//       tokens (otherCodes) into the same candidate set;
//   P7  a learned layout rule answers BEFORE tier 2 is paid for.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { extractStyleCodeCandidates, labelTokens } = require("../lib/style-code-ocr.cjs");
const { normaliseStyleCode, styleCodeFormat } = require("../lib/style-code.cjs");
const { runLabelAlias } = require("../labelAlias/labelAlias.js");
const { runLabelRead } = require("../styleCode/readStyleCodeLabel.js");
const { STYLE_CODE_INDEX_PATH } = require("../styleCode/resolveStyleCode.js");
const { LAYOUT_RULES_PATH } = require("../lib/label-layout.cjs");

const NOW = 1786000000000;
const ACTOR = { uid: "staff1" };

// ── The physical labels, verbatim from the owner's floor check ───────────────
const LACOSTE_LABEL = [
  "LGUARD BRKR CTT 225 2 SFA",
  "45SMA0018",
  "35289 0625",
  "TTJJ21FB00001",
  "UK 8 US 9 EUR 42.5",
  "MADE IN VIETNAM",
].join("\n");

const TIMBERLAND_LABEL = [
  "TIMBERLAND",
  "MOTION 6 MID GTX",
  "A6CWNEN3",
  "A8425",
  "US 9 UK 8.5 EU 43",
  "MADE IN VIETNAM",
].join("\n");

// Faithful RTDB fake (same contract as label-alias-codes.test.cjs: empty
// arrays/objects are DELETED on write, exactly like production), extended with
// the orderByChild/equalTo query findProductsByStyleCode runs.
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
  const strip = (v) => {
    if (!v || typeof v !== "object") return v;
    const out = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) {
      if ((Array.isArray(x) && x.length === 0) || (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 0)) continue;
      out[k] = strip(x);
    }
    return out;
  };
  const makeRef = (p) => ({
    async get() { const v = at(p); const val = v === undefined ? null : v; return { val: () => val, exists: () => val !== null }; },
    async set(v) { put(p, strip(v)); },
    async update(patch) { for (const [k, v] of Object.entries(patch)) put(`${p}/${k}`, v); },
    push() { const id = `al${++pushN}`; return { key: id, ...makeRef(`${p}/${id}`) }; },
    child(k) { return makeRef(`${p}/${k}`); },
    orderByChild(field) {
      return {
        equalTo(value) {
          return {
            async get() {
              const node = at(p) || {};
              const out = {};
              for (const [k, v] of Object.entries(node)) {
                if (v && v[field] === value) out[k] = v;
              }
              const val = Object.keys(out).length ? out : null;
              return { val: () => val, exists: () => val !== null };
            },
          };
        },
      };
    },
    async transaction(fn) {
      const cur = at(p);
      const out = fn(cur === undefined ? null : cur);
      if (out === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
      put(p, strip(out));
      return { committed: true, snapshot: { val: () => out } };
    },
  });
  return { data, ref: makeRef };
}

// ── P1 — the Lacoste label: article + production + model-name, separately ────
test("P1: the Lacoste label yields the article code AND the production token AND the model-name line", () => {
  const candidates = extractStyleCodeCandidates(LACOSTE_LABEL);
  const codes = candidates.map((c) => c.normalised);
  assert.ok(codes.includes("45SMA0018"), "the article code (45SMA0018) must be a candidate");
  assert.ok(codes.includes("352890625"),
    "the production line '35289 0625' must be a candidate — it is the code 'Lacoster white' already holds");
  assert.ok(codes.includes("TTJJ21FB00001"), "the long serial is a code-shaped token too");
  // The model-name line survives as tokens for the name tier.
  const tokens = labelTokens(LACOSTE_LABEL);
  for (const word of ["LGUARD", "BRKR", "CTT"]) {
    assert.ok(tokens.includes(word), `model-name word ${word} must survive as a token`);
  }
});

test("P1a: the three printed spellings of the production line normalise IDENTICALLY", () => {
  assert.strictEqual(normaliseStyleCode("35289 0625"), "352890625");
  assert.strictEqual(normaliseStyleCode("352890625"), "352890625");
  assert.strictEqual(normaliseStyleCode("352890-625"), "352890625");
});

// ── P2 — the Timberland label: BOTH tokens ───────────────────────────────────
test("P2: the Timberland label yields both A6CWNEN3 and A8425", () => {
  const codes = extractStyleCodeCandidates(TIMBERLAND_LABEL).map((c) => c.normalised);
  assert.ok(codes.includes("A6CWNEN3"), "the interleaved serial must be a candidate");
  assert.ok(codes.includes("A8425"), "the short article token must be a candidate");
  assert.strictEqual(styleCodeFormat("A6CWNEN3"), "label-serial");
});

// ── P3 — the full-token read RECOVERS the existing product, no migration ─────
test("P3: a Lacoste scan resolves to the existing product holding 352890-625 via the production token", async () => {
  // "Lacoster white" exactly as it exists today: styleCodeNormalised is the
  // production line, claimed in the index. NOTHING about the product changes.
  const db = fakeDb({
    products: { pLacosterWhite: { id: "pLacosterWhite", name: "Lacoster white", styleCodeNormalised: "352890625" } },
    [STYLE_CODE_INDEX_PATH]: { "352890625": { productId: "pLacosterWhite", claimedAt: 1 } },
  });
  const scanned = extractStyleCodeCandidates(LACOSTE_LABEL).map((c) => c.normalised);
  const out = await runLabelAlias(db, { action: "resolveAnyCode", codes: scanned, actor: ACTOR, nowMs: NOW });
  assert.strictEqual(out.resolved, "pLacosterWhite",
    "ANY matching token must resolve — the stored line is still printed on the label");
  assert.strictEqual(out.owners.length, 1);
  assert.strictEqual(out.owners[0].code, "352890625", "…and the answer names WHICH token matched");
});

test("P3a: a stamped-but-never-claimed product is still found (pre-index rows)", async () => {
  const db = fakeDb({
    products: { pOld: { id: "pOld", name: "Old Row", styleCodeNormalised: "352890625" } },
  });
  const out = await runLabelAlias(db, {
    action: "resolveAnyCode", codes: ["45SMA0018", "35289 0625"], actor: ACTOR, nowMs: NOW,
  });
  assert.strictEqual(out.resolved, "pOld", "the /products styleCodeNormalised index answers when no claim exists");
});

// ── P4 — any ONE registered token resolves a later scan silently ─────────────
test("P4: after linking files every token, a later scan matching ANY ONE resolves silently", async () => {
  const db = fakeDb({
    products: { pTimb: { id: "pTimb", name: "Timberland Motion 6 Mid Hiking Boots Khaki" } },
  });
  const codes = extractStyleCodeCandidates(TIMBERLAND_LABEL).map((c) => c.normalised);
  const filed = await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pTimb",
    chosenCode: codes[0], otherCodes: codes.slice(1), actor: ACTOR, nowMs: NOW,
  });
  assert.strictEqual(filed.ok, true);
  assert.deepStrictEqual(filed.conflicts, []);
  // EITHER token alone now resolves.
  for (const one of ["A6CWNEN3", "A8425"]) {
    const out = await runLabelAlias(db, { action: "resolveAnyCode", codes: [one], actor: ACTOR, nowMs: NOW });
    assert.strictEqual(out.resolved, "pTimb", `${one} alone must resolve to the linked product`);
  }
});

// ── P5 — a token owned elsewhere NEVER silently attaches or resolves ─────────
test("P5: tokens owned by DIFFERENT products make resolveAnyCode refuse to pick", async () => {
  const db = fakeDb({
    products: {
      pA: { id: "pA", name: "Shoe A", styleCodeNormalised: "A8425" },
      pB: { id: "pB", name: "Shoe B" },
    },
    [STYLE_CODE_INDEX_PATH]: { A8425: { productId: "pA", claimedAt: 1 } },
    label_aliases: { al9: { productId: "pB", c: { A6CWNEN3: true }, n: 1 } },
  });
  const out = await runLabelAlias(db, {
    action: "resolveAnyCode", codes: ["A6CWNEN3", "A8425"], actor: ACTOR, nowMs: NOW,
  });
  assert.strictEqual(out.resolved, null, "two owners → no silent pick, ever");
  assert.deepStrictEqual(out.owners.map((o) => o.productId).sort(), ["pA", "pB"],
    "every owner rides back so the human picks between them");
});

test("P5a: filing a token another product owns still routes to the duplicate flow (unchanged door)", async () => {
  const db = fakeDb({
    products: { pMine: { id: "pMine", name: "Mine" }, pTheirs: { id: "pTheirs", name: "Theirs" } },
    [STYLE_CODE_INDEX_PATH]: { A8425: { productId: "pTheirs", claimedAt: 1 } },
  });
  const res = await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pMine",
    chosenCode: "A6CWNEN3", otherCodes: ["A8425"], actor: ACTOR, nowMs: NOW,
  });
  assert.deepStrictEqual(res.attached, ["A6CWNEN3"], "the free token attaches");
  assert.strictEqual(res.conflicts.length, 1);
  assert.strictEqual(res.conflicts[0].code, "A8425");
  const pair = db.data.duplicate_candidates && db.data.duplicate_candidates.pMine__pTheirs;
  assert.ok(pair, "the collision lands in /duplicate_candidates — the EXISTING flow, never silence");
  assert.strictEqual(pair.status, "open");
});

// ── P6 / P7 — the funnel: preference not erasure, and the rule beats the bill ─
const IMG = Buffer.from("multi-token-label-photo");
const visionOk = (text) => async () => ({ ok: true, status: 200, async json() {
  return { responses: [{ fullTextAnnotation: { text } }] };
} });
const geminiOk = (obj) => async () => ({ ok: true, status: 200, async json() {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] };
} });
const baseRead = (over = {}) => ({
  buffer: IMG, base64: IMG.toString("base64"), mimeType: "image/jpeg",
  nowMs: NOW, geminiKey: "k", tokenFn: async () => "t", ...over,
});

test("P6: tier 2's own otherCodes join the candidate set — nothing it saw is dropped", async () => {
  const db = fakeDb({});
  const out = await runLabelRead(db, baseRead({
    visionFetch: visionOk("MADE IN VIETNAM"), // tier 1 empty → tier 2 fires
    geminiFetch: geminiOk({ styleCode: "A6CWNEN3", otherCodes: ["A8425"], styleCodeConfidence: 0.9 }),
  }));
  assert.deepStrictEqual(out.candidates, ["A6CWNEN3", "A8425"]);
  assert.strictEqual(out.preferred, "A6CWNEN3");
});

test("P6a: the full Lacoste read carries all three tokens through the funnel", async () => {
  const db = fakeDb({});
  const out = await runLabelRead(db, baseRead({
    visionFetch: visionOk(LACOSTE_LABEL),
    geminiFetch: geminiOk({ styleCode: "45SMA0018", styleCodeConfidence: 0.9 }),
  }));
  for (const c of ["45SMA0018", "352890625", "TTJJ21FB00001"]) {
    assert.ok(out.candidates.includes(c), `${c} must survive the funnel`);
  }
  assert.strictEqual(out.preferred, "45SMA0018");
  assert.ok(out.tokens.includes("LGUARD"), "the model-name line rides the same response");
});

test("P7: a learned layout rule answers BEFORE tier 2 is paid for", async () => {
  // The Lacoste layout, already taught: lacoste-ref is the style number among
  // {lacoste-ref, numeric-6-3, label-serial}. Tier 2 must NOT be called.
  const key = ["45SMA0018", "352890625", "TTJJ21FB00001"].map(styleCodeFormat).sort().join("__");
  const db = fakeDb({ [LAYOUT_RULES_PATH]: { [key]: { chosenFormat: "lacoste-ref", confirms: 3, conflicts: 0 } } });
  let geminiCalls = 0;
  const out = await runLabelRead(db, baseRead({
    visionFetch: visionOk(LACOSTE_LABEL),
    geminiFetch: async () => { geminiCalls++; throw new Error("tier 2 must not fire"); },
  }));
  assert.strictEqual(geminiCalls, 0, "a question a human answered is not re-billed to a model");
  assert.strictEqual(out.tier2Used, false);
  assert.strictEqual(out.autoPick, "45SMA0018", "the rule's pick resolves the read");
  assert.ok(out.candidates.includes("352890625"), "…and the other tokens still ride for filing");
});
