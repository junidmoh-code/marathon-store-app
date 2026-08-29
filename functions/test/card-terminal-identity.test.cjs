// ─── ONLY THE TID IDENTIFIES A TERMINAL ──────────────────────────────────────
// The four live terminals make three assumptions unsafe, and each of them is
// the kind a future change makes by accident:
//
//   MID IS NOT UNIQUE PER STORE. pe/till-2 and pine/till-1 both print MID
//   100000001178101 — two different STORES on one merchant account. Anything
//   that resolved a store from a MID would put Pine's takings on PE's till.
//
//   MID MAY BE ABSENT ENTIRELY. trophy/till-1 (TID 67377843) prints no Merchant
//   line at all, and is registered with no `mid` key — not an empty string.
//   Anything that required one would refuse that shop's slips outright.
//
//   THE TRADING NAME IDENTIFIES NOTHING. Three names across four terminals in
//   three stores: "THE MARATHON", "OMARS FASHION" (twice, different stores) and
//   "Marathon Club". It is not read, and must not become read.
//
// And the TID format itself is not one thing: 0000HP1X is alphanumeric, the
// other three are 8-digit numeric.
//
// Store identity comes from the TID→store map at /config/cardTerminals and from
// nowhere else.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { normaliseTid, validateExtraction, buildBatchRecord } = require("../lib/card-recon.cjs");

// The live registry as seeded 2026-08-29 — the shapes the code must survive.
const LIVE = {
  "0000HP1X": { mid: "000000004977890", storeId: "pe", tillId: "till-1", label: "PE Till 1" },
  "67365901": { mid: "100000001178101", storeId: "pe", tillId: "till-2", label: "PE Till 2" },
  "67364485": { mid: "100000001178101", storeId: "pine", tillId: "till-1", label: "Pine Till 1" },
  "67377843": { storeId: "trophy", tillId: "till-1", label: "Trophy Till 1" }, // no mid key
};

test("every live TID normalises — neither format is assumed", () => {
  for (const tid of Object.keys(LIVE)) {
    assert.equal(normaliseTid(tid), tid, `${tid} must survive normalisation unchanged`);
  }
  // Both shapes, explicitly.
  assert.equal(normaliseTid("0000HP1X"), "0000HP1X");   // alphanumeric
  assert.equal(normaliseTid("67377843"), "67377843");   // 8-digit numeric
  // Lowercase input is uppercased, which is a no-op for the numeric ones.
  assert.equal(normaliseTid("0000hp1x"), "0000HP1X");
});

test("a MID shared across two STORES cannot be used to tell them apart", () => {
  const shared = Object.entries(LIVE).filter(([, r]) => r.mid === "100000001178101");
  assert.equal(shared.length, 2, "this test exists because two terminals share a MID");
  const stores = new Set(shared.map(([, r]) => r.storeId));
  assert.equal(stores.size, 2, "…and they are in DIFFERENT stores");
  // The registry is keyed by TID, so the two are distinguishable. A map keyed by
  // MID would collapse them into one entry — that is the mistake being pinned.
  const byMid = {};
  for (const [tid, r] of Object.entries(LIVE)) if (r.mid) byMid[r.mid] = tid;
  assert.notEqual(Object.keys(byMid).length, Object.keys(LIVE).filter((t) => LIVE[t].mid).length,
    "keying terminals by MID loses one — which is exactly why nothing does");
});

test("a slip with NO mid still validates and still records", () => {
  const ex = {
    tid: "67377843", mid: null, batchNo: "12",
    openedAt: 1787763004000, closedAt: 1787849404000, printedAt: null,
    openedText: null, closedText: null, txnCount: 1,
    purchasesCents: 10000, cashCents: 0, refundsCents: 0, totalCents: 10000,
    reconLine: null,
    confidence: { tid: 0.99, batchNo: 0.98, totalCents: 0.97, openedAt: 0.96, closedAt: 0.96,
      purchasesCents: 0.95, txnCount: 0.95, mid: 0 },   // ← mid confidence ZERO
    lines: [{ tsn: 1, at: 1787770931000, date: "2026/08/26", time: "19:02:11",
      uti: "U1", rrn: "R1", authCode: "A1", pan: "****1111", type: "purchase", amountCents: 10000 }],
  };
  const v = validateExtraction(ex);
  assert.equal(v.ok, true, `a MID-less slip must not be refused: ${v.reason}`);

  const rec = buildBatchRecord({
    extraction: ex, terminal: LIVE["67377843"], tid: "67377843",
    batchKey: "12", revision: 1, supersedes: null, photoPaths: ["cardRecon/d/photo-0.jpg"],
    summaryOnly: false, warnings: [], expected: { cardCents: 10000, legs: 1, byKind: {} },
    cashiers: [], submittedBy: { uid: "u", email: null }, submittedAt: 1, draftId: "d", ocr: null,
  });
  assert.equal(rec.mid, null, "an absent MID records as null, never as a guess");
  // The store still resolves — from the terminal record, which came from the TID.
  assert.equal(rec.storeId, "trophy");
  assert.equal(rec.tillId, "till-1");
});

test("MID is not confidence-gated, so an unreadable one cannot refuse a slip", () => {
  const src = readFileSync(resolve(__dirname, "../lib/card-recon.cjs"), "utf8");
  const keyFields = src.match(/const KEY_FIELDS = \[([^\]]*)\]/)[1];
  assert.ok(!/\bmid\b/i.test(keyFields),
    "mid must never join KEY_FIELDS — trophy/till-1 prints no Merchant line, and every one of its slips would be refused");
});

test("nothing reads a trading name — it is not even extracted", () => {
  const callable = readFileSync(resolve(__dirname, "../cardRecon/cardRecon.js"), "utf8");
  const code = callable.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const name of ["tradingName", "merchantName", "storeName", "THE MARATHON", "OMARS", "Marathon Club"]) {
    assert.ok(!code.includes(name),
      `the trading name must not be read or matched — three different names cover four terminals in three stores`);
  }
});

test("the store is resolved from the TID map and from nothing else", () => {
  const callable = readFileSync(resolve(__dirname, "../cardRecon/cardRecon.js"), "utf8");
  const code = callable.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // The only lookups into the registry are by TID.
  const lookups = [...code.matchAll(/terminals(?:Now)?\[([^\]]+)\]/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(lookups)].sort(), ["extraction.tid", "picked"],
    "the terminal registry may only ever be indexed by a TID");
  // And nothing reads a MID off the REGISTRY at all — which is what a
  // comparison against the slip's MID would need. (An earlier version of this
  // assertion banned `mid ===` outright and tripped on `typeof parsed.mid ===
  // "string"`, a type check on OCR output. The registry object is the thing
  // that must never carry a MID into a decision.)
  for (const shape of [/terminal\.mid/, /mapped\.mid/, /terminals(?:Now)?\[[^\]]*\]\.mid/]) {
    assert.ok(!shape.test(code),
      `the registry's MID must never be read (${shape}) — MIDs are shared across stores and sometimes absent`);
  }
});
