// ─── LABEL LAYOUT RULES — the same question is not asked twice ───────────────
// (Owner spec 2026-08-08.) Proofs: a human's tap teaches the shape rule for
// that label layout; the NEXT read of the same layout auto-picks without
// asking (through runLabelRead, cached and fresh paths both); a disagreement
// replaces the rule once; a second disagreement disables it for good; a
// same-shape pair can never auto-pick.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  LAYOUT_RULES_PATH, MAX_LAYOUT_CONFLICTS, layoutKeyFor, applyLayoutRule, learnLayoutTransition,
} = require("../lib/label-layout.cjs");
const { runLabelAlias } = require("../labelAlias/labelAlias.js");
const { runLabelRead } = require("../styleCode/readStyleCodeLabel.js");
const { imageHash, OCR_CACHE_PATH } = require("../lib/style-code-ocr.cjs");

const NOW = 1786000000000;
const ACTOR = { uid: "staff1" };

// The Diesel Big D label: 190935-505 (numeric-6-3) + 740750-35 (puma-6-2).
const TOKEN_A = "190935505";
const TOKEN_B = "74075035";
const KEY = "numeric-6-3__puma-6-2";

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
    async set(v) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        v = { ...v };
        for (const [k, x] of Object.entries(v)) { if (Array.isArray(x) && x.length === 0) delete v[k]; }
      }
      put(p, v);
    },
    push() { const id = `p${++pushN}`; return { key: id, ...makeRef(`${p}/${id}`) }; },
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

// ─── The key ─────────────────────────────────────────────────────────────────
test("a layout is keyed by its shape multiset, order-independent, fail-closed", () => {
  assert.strictEqual(layoutKeyFor([TOKEN_A, TOKEN_B]), KEY);
  assert.strictEqual(layoutKeyFor([TOKEN_B, TOKEN_A]), KEY, "OCR reading order must not matter");
  assert.strictEqual(layoutKeyFor([TOKEN_A]), null, "one candidate is not a layout");
  assert.strictEqual(layoutKeyFor([TOKEN_A, "WEIRDSHAPE1X"]), null, "an unrecognised shape keys nothing");
});

// ─── The transitions ─────────────────────────────────────────────────────────
test("learn → confirm → conflict-replace → second conflict DISABLES for good", () => {
  const meta = { nowMs: NOW, uid: "u1" };
  const born = learnLayoutTransition(null, "numeric-6-3", meta);
  assert.deepStrictEqual(
    { chosenFormat: born.chosenFormat, confirms: born.confirms, conflicts: born.conflicts },
    { chosenFormat: "numeric-6-3", confirms: 1, conflicts: 0 });

  const confirmed = learnLayoutTransition(born, "numeric-6-3", meta);
  assert.strictEqual(confirmed.confirms, 2);

  // First disagreement: maybe the FIRST answer was the mistake — replace once.
  const flipped = learnLayoutTransition(confirmed, "puma-6-2", meta);
  assert.strictEqual(flipped.chosenFormat, "puma-6-2");
  assert.strictEqual(flipped.conflicts, 1);
  assert.ok(!flipped.disabled);

  // Second disagreement: the layout genuinely varies. Dead, permanently.
  const dead = learnLayoutTransition(flipped, "numeric-6-3", meta);
  assert.strictEqual(dead.disabled, true);
  assert.strictEqual(dead.conflicts, MAX_LAYOUT_CONFLICTS);
  // Dead stays dead — even an agreeing answer cannot revive it.
  const stillDead = learnLayoutTransition(dead, "numeric-6-3", meta);
  assert.strictEqual(stillDead.disabled, true);
  assert.strictEqual(applyLayoutRule(stillDead, [TOKEN_A, TOKEN_B]), null);
});

test("a rule applies only when EXACTLY one candidate carries the learned shape", () => {
  const rule = { chosenFormat: "numeric-6-3", confirms: 1, conflicts: 0 };
  assert.strictEqual(applyLayoutRule(rule, [TOKEN_A, TOKEN_B]), TOKEN_A);
  // Two numeric-6-3 candidates: the shape cannot distinguish them → ask.
  assert.strictEqual(applyLayoutRule(rule, [TOKEN_A, "315122111"]), null);
  assert.strictEqual(applyLayoutRule(null, [TOKEN_A, TOKEN_B]), null);
});

// ─── The learn action ────────────────────────────────────────────────────────
test("learnLayout writes the rule; a chosen code outside the set is refused", async () => {
  const db = fakeDb({});
  const ok = await runLabelAlias(db, {
    action: "learnLayout", codes: [TOKEN_A, TOKEN_B], chosenCode: TOKEN_A, actor: ACTOR, nowMs: NOW,
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.layoutKey, KEY);
  assert.strictEqual(db.data[LAYOUT_RULES_PATH][KEY].chosenFormat, "numeric-6-3");

  const bad = await runLabelAlias(db, {
    action: "learnLayout", codes: [TOKEN_A, TOKEN_B], chosenCode: "CT8527016", actor: ACTOR, nowMs: NOW,
  });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, "chosen-not-a-candidate");
});

// ─── The apply path, end to end through the funnel ───────────────────────────
const IMG = Buffer.from("diesel-label-bytes");
const HASH = imageHash(IMG);
const freshCacheRow = {
  candidates: [TOKEN_A, TOKEN_B], source: "vision", at: NOW - 1000, expiresAt: NOW + 1000, fpv: 2,
};
const ruleRow = { chosenFormat: "numeric-6-3", confirms: 1, conflicts: 0, addedAt: 1, updatedAt: 1, by: "u" };
const base = (over = {}) => ({
  buffer: IMG, base64: IMG.toString("base64"), mimeType: "image/jpeg", nowMs: NOW, geminiKey: "k",
  tokenFn: async () => "t", ...over,
});

test("a learned rule AUTO-PICKS on the cached path — the question is not asked again", async () => {
  const db = fakeDb({
    [OCR_CACHE_PATH]: { [HASH]: freshCacheRow },
    [LAYOUT_RULES_PATH]: { [KEY]: ruleRow },
  });
  const out = await runLabelRead(db, base());
  assert.strictEqual(out.fromCache, true);
  assert.deepStrictEqual(out.candidates, [TOKEN_A, TOKEN_B], "the full candidate list still rides the response");
  assert.strictEqual(out.autoPick, TOKEN_A);
  assert.strictEqual(out.autoPickDisplay, "190935-505");
});

test("no rule (or a disabled one) → no autoPick, the human is asked", async () => {
  const db = fakeDb({ [OCR_CACHE_PATH]: { [HASH]: freshCacheRow } });
  const out = await runLabelRead(db, base());
  assert.strictEqual(out.autoPick, null);

  const db2 = fakeDb({
    [OCR_CACHE_PATH]: { [HASH]: freshCacheRow },
    [LAYOUT_RULES_PATH]: { [KEY]: { ...ruleRow, disabled: true } },
  });
  const out2 = await runLabelRead(db2, base());
  assert.strictEqual(out2.autoPick, null);
});

test("the rule applies on the FRESH path too (vision reads two codes, tier 2 cannot settle)", async () => {
  const db = fakeDb({ [LAYOUT_RULES_PATH]: { [KEY]: ruleRow } });
  const visionOk = async () => ({ ok: true, status: 200, async json() {
    return { responses: [{ fullTextAnnotation: { text: "DIESEL\n190935-505\n740750-35\nMADE IN VIETNAM" } }] };
  } });
  const geminiNoAnswer = async () => ({ ok: true, status: 200, async json() {
    return { candidates: [{ content: { parts: [{ text: JSON.stringify({ styleCode: "", styleCodeConfidence: 0 }) }] } }] };
  } });
  const out = await runLabelRead(db, base({ visionFetch: visionOk, geminiFetch: geminiNoAnswer }));
  assert.deepStrictEqual(out.candidates.sort(), [TOKEN_A, TOKEN_B].sort());
  assert.strictEqual(out.autoPick, TOKEN_A);
});
