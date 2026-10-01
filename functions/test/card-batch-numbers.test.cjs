// ─── A BATCH NUMBER IS THE TERMINAL'S, AND NOBODY ELSE'S ─────────────────────
// Two machines joined the estate on 18 Sep 2026 SECOND-HAND, mid-life:
// 67325636 arrived on batch 57 and 0000Z4M6 on batch 480. Neither has ever
// printed a #1 here and neither ever will. A third machine, 0000HP1X, is past
// #509. So:
//
//   NOTHING MAY ASSUME A TERMINAL STARTS AT 1, or near it, or that its numbers
//   are contiguous with anything this system has seen.
//
//   AND THE DUPLICATE REFUSAL MUST BE SCOPED TO ONE TERMINAL. This is not
//   hypothetical: 67325636 (batch 57) and 67365901 (live on batches 59-77) are
//   BOTH AT STORE `pe`. A refusal scoped to the store would have refused the new
//   machine's first weeks of slips as "already captured" — and a refusal scoped
//   to the store would look perfectly correct in a test using one terminal.
//
// The scoping is structural: records are filed at
// /card_batches/{storeId}/{tid}/{batchKey}, so a batch number is a KEY UNDER A
// TERMINAL. What this file proves is that the probe which decides "already
// captured?" reads inside that terminal's node and nowhere wider.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBatchWrite, normaliseBatchNo, MAX_REVISIONS } = require("../lib/card-recon.cjs");
const { readBatchKeysFor } = require("../cardRecon/cardRecon.js");

// A database that answers from a map of paths and REMEMBERS EVERY PATH ASKED.
// The paths are the assertion — an answer alone cannot tell a correctly scoped
// probe from one that read the whole store and filtered afterwards.
function fakeDb(present) {
  const read = [];
  return {
    read,
    ref(path) {
      read.push(path);
      return { once: async () => ({ exists: () => Object.prototype.hasOwnProperty.call(present, path) }) };
    },
  };
}

test("a first capture at batch 480 is an ordinary first capture", () => {
  const w = resolveBatchWrite({ existingKeys: [], batchNo: "480", correction: false });
  assert.deepEqual(w, { ok: true, key: "480", revision: 1, supersedes: null, autoSuperseded: false });
});

test("every batch number the live estate actually carries parses", () => {
  // 57 and 480 (the two that arrived mid-life), 509 (the highest live), and the
  // shapes a slip prints them in.
  for (const [printed, want] of [["57", "57"], ["#57", "57"], ["480", "480"], ["#480", "480"],
                                 ["509", "509"], ["0480", "480"], ["99999999", "99999999"]]) {
    assert.equal(normaliseBatchNo(printed), want, `${printed} must read as ${want}`);
  }
  // …and nothing about the SIZE of a number refuses it: only its shape does.
  assert.equal(normaliseBatchNo("123456789"), null, "nine digits is not a batch number");
  assert.equal(normaliseBatchNo("4a80"), null);
  assert.equal(normaliseBatchNo(""), null);
});

test("the duplicate probe reads ONE terminal's node, by exact key", async () => {
  // 67325636 arrives on batch 57 at store pe, where 67365901 is already live on
  // 59-77 and has long since filed a 57-key of its own… under ITS tid.
  const present = { "card_batches/pe/67365901/57/batchKey": true };
  const db = fakeDb(present);
  const keys = await readBatchKeysFor(db, "pe", "67325636", "57");
  assert.deepEqual(keys, [], "the sibling terminal's batch 57 is not this terminal's");
  // The probe asked about exactly one path, and it was inside the NEW
  // terminal's own node.
  assert.deepEqual(db.read, ["card_batches/pe/67325636/57/batchKey"]);
  // And so the write resolves as a first capture, not a refusal.
  assert.deepEqual(resolveBatchWrite({ existingKeys: keys, batchNo: "57", correction: false }),
    { ok: true, key: "57", revision: 1, supersedes: null, autoSuperseded: false });
});

test("the same number on the SAME terminal is still refused", () => {
  const w = resolveBatchWrite({ existingKeys: ["480"], batchNo: "480", correction: false });
  assert.equal(w.ok, false);
  assert.match(w.reason, /already captured/);
  // …and a correction of it lands beside it at a high number just as at a low
  // one. Nothing about the revision suffix cares how big the batch number is.
  const c = resolveBatchWrite({ existingKeys: ["480"], batchNo: "480", correction: true });
  assert.deepEqual(c, { ok: true, key: "480-r2", revision: 2, supersedes: "480", autoSuperseded: false });
});

test("the probe walks a high number's revision chain and stops at the first gap", async () => {
  const present = {
    "card_batches/trophy/0000Z4M6/480/batchKey": true,
    "card_batches/trophy/0000Z4M6/480-r2/batchKey": true,
    // 480-r3 absent — and a stray -r4 that must NOT be reached, because the
    // chain ends at the gap.
    "card_batches/trophy/0000Z4M6/480-r4/batchKey": true,
  };
  const db = fakeDb(present);
  const keys = await readBatchKeysFor(db, "trophy", "0000Z4M6", "480");
  assert.deepEqual(keys, ["480", "480-r2"]);
  assert.deepEqual(db.read, [
    "card_batches/trophy/0000Z4M6/480/batchKey",
    "card_batches/trophy/0000Z4M6/480-r2/batchKey",
    "card_batches/trophy/0000Z4M6/480-r3/batchKey",
  ], "it stops probing at the gap rather than sweeping the node");
  // ONE TINY CHILD PER PROBE, never the record: each record carries a whole
  // transaction roll, and they accumulate for years.
  for (const path of db.read) assert.match(path, /\/batchKey$/);
});

test("the probe is bounded — it cannot walk for ever on a strange node", async () => {
  const present = {};
  for (let r = 1; r <= 50; r++) present[`card_batches/pe/67325636/${r === 1 ? "57" : `57-r${r}`}/batchKey`] = true;
  const db = fakeDb(present);
  const keys = await readBatchKeysFor(db, "pe", "67325636", "57");
  assert.equal(keys.length, MAX_REVISIONS);
  assert.equal(db.read.length, MAX_REVISIONS);
  // …and the resolver refuses rather than minting revision 21.
  const w = resolveBatchWrite({ existingKeys: keys, batchNo: "57", correction: true });
  assert.equal(w.ok, false);
  assert.match(w.reason, /not a correction chain any more/);
});

test("a correction of a batch this terminal has never filed is refused, not invented", () => {
  // The case a high starting number makes likelier: somebody assumes the new
  // machine's #480 must already be in, and submits a correction for it.
  const w = resolveBatchWrite({ existingKeys: [], batchNo: "480", correction: true });
  assert.equal(w.ok, false);
  assert.match(w.reason, /has not been captured yet/);
});

// ── THE SCAN, AND THE ONE REGION IT DOES NOT READ ────────────────────────────
// The rule this file protects is about a batch number that was READ OFF A
// REPORT: it is the machine's own number, it is whatever the machine says, and
// nothing may judge it by its size or its distance from the last one. Two of
// the six live machines joined the estate mid-life, on batches 57 and 480.
//
// A TYPED-TOTAL MACHINE HAS NO REPORT AND SO NO NUMBER TO READ (Trophy Till 2,
// 1 Oct 2026). Its record still has to be filed somewhere, so planTypedCapture
// MINTS a key — the next after that terminal's highest. That is a different act
// from judging a number, and the scan cannot tell the two apart by shape, so
// the typed region is marked in the source and held out here.
//
// The carve-out is kept honest three ways: the markers must be present (a
// rename cannot silently empty the exclusion), the region must be a real
// region rather than the whole file, and the region itself is scanned for the
// thing that actually matters — a refusal or a warning keyed on sequence,
// which is the failure mode, not the arithmetic.
const TYPED_REGION = /\/\/ \[typed-capture:start\][\s\S]*?\/\/ \[typed-capture:end\]/;

test("nothing in the capture path reasons about a batch number's size or sequence", () => {
  // A scan, because the failure this guards against is a FUTURE one: somebody
  // adds "warn if this batch is not the previous one plus one" and every
  // second-hand machine's first slip becomes a warning, or worse a refusal.
  // (TSN contiguity is a different thing entirely — those run inside one batch
  // and a gap there IS a missing line, which is why it is checked.)
  const { readFileSync } = require("node:fs");
  const { resolve } = require("node:path");
  for (const rel of ["../lib/card-recon.cjs", "../cardRecon/cardRecon.js"]) {
    const raw = readFileSync(resolve(__dirname, rel), "utf8");
    const region = raw.match(TYPED_REGION);
    assert.ok(region, `${rel} has lost its [typed-capture] markers — the exclusion below would be silently empty`);
    assert.ok(region[0].length < raw.length / 2, `${rel}'s typed region has grown to most of the file`);
    const code = raw.replace(TYPED_REGION, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const shape of [/batchNo\s*[<>]/, /batchNo\s*[-+]\s*1/, /previousBatch/i, /lastBatchNo/i, /expectedBatch/i]) {
      assert.ok(!shape.test(code), `${rel} reasons about batch-number sequence (${shape})`);
    }
  }
});

test("the typed path mints a number and never judges one", () => {
  // The carve-out above is only safe while this holds: the typed region may do
  // arithmetic on a batch number, but it must never turn one into a refusal or
  // a warning. That is the behaviour the whole file exists to prevent, and it
  // is prevented here by reading the region rather than by exempting it.
  const { readFileSync } = require("node:fs");
  const { resolve } = require("node:path");
  for (const rel of ["../lib/card-recon.cjs", "../cardRecon/cardRecon.js"]) {
    const raw = readFileSync(resolve(__dirname, rel), "utf8");
    const region = raw.match(TYPED_REGION)[0].replace(/^\s*\/\/.*$/gm, "");
    // No comparison of one batch number against another, in either direction.
    assert.ok(!/batchNo\s*(===|!==|==|!=|[<>]=?)\s*\w*[Bb]atch/.test(region),
      `${rel}'s typed region compares two batch numbers`);
    // …and nothing in it refuses or warns with a batch number as the reason.
    for (const line of region.split("\n")) {
      if (!/\b(ok:\s*false|warnings\.push|reason:)/.test(line)) continue;
      assert.ok(!/\bnot the previous|out of sequence|skipped a batch|should be #/i.test(line),
        `${rel}'s typed region refuses or warns on batch sequence: ${line.trim()}`);
    }
  }
});

test("the exclusion is scoped to the typed region, not to the words it uses", () => {
  // Proof the scan still bites OUTSIDE the markers: the same shape it exempts
  // inside them must still fail when it appears anywhere else.
  const sample = "// [typed-capture:start]\nconst a = lastBatchNo + 1;\n// [typed-capture:end]\nconst b = lastBatchNo + 1;";
  const stripped = sample.replace(TYPED_REGION, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(/lastBatchNo/i.test(stripped), "the scan must still see a sequence reference outside the markers");
  assert.equal((stripped.match(/lastBatchNo/g) || []).length, 1, "exactly the one outside the markers");
});
