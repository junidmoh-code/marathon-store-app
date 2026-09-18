// ─── ONLY THE TID IDENTIFIES A TERMINAL ──────────────────────────────────────
// The six live terminals make three assumptions unsafe, and each of them is
// the kind a future change makes by accident:
//
//   MID IS NOT UNIQUE PER STORE. pe/till-3 and pine/till-1 both print MID
//   100000001178101 — two different STORES on one merchant account — and
//   pe/till-2 and trophy/till-2 both print 000000004977890, which is the same
//   trap in the other direction: one merchant number across two SHOPS. Anything
//   that resolved a store from a MID would put Pine's takings on Marathon's
//   till.
//
//   MID MAY BE ABSENT ENTIRELY. Trophy Till 1 (TID 67377843) was mapped with no
//   `mid` key at all — not an empty string — because its merchant number was
//   not known. It is known now (its emailed reports all print 100000002816030,
//   and the registry carries it as of 2026-09-18), but a machine can be mapped
//   before its merchant number is, and anything that REQUIRED one would refuse
//   that shop's slips outright. The MID-less path is still live code and is
//   still tested here.
//
//   THE TRADING NAME IDENTIFIES NOTHING. Three names across six terminals in
//   three stores: "THE MARATHON", "OMARS FASHION" (twice, different stores) and
//   "Marathon Club". It is not read, and must not become read.
//
// And the TID format itself is not one thing: 0000HP1X and 0000Z4M6 are
// alphanumeric, the other four are 8-digit numeric.
//
// Store identity comes from the TID→store map at /config/cardTerminals and from
// nowhere else.
//
// ─── AND THE ROW IS MUTABLE WHILE THE HISTORY IS NOT ─────────────────────────
// On 2026-09-18 three tills were renamed, two machines were added and none were
// removed. The rename moved two rows to a different TILL as well as a different
// label — and not one batch already filed changed, because a batch record
// stamps its own storeId, tillId and terminalLabel at capture. That is the
// property this file now also pins, along with the retirement mechanism that
// exists so the next swap does not delete a mapping and strand its records.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { normaliseTid, validateExtraction, buildBatchRecord } = require("../lib/card-recon.cjs");
const { isRetiredTerminal, wasActiveAt } = require("../lib/card-terminals.cjs");
const { routeEmailSlip } = require("../lib/card-recon-email.cjs");

// The live registry as applied 2026-09-18 — the shapes the code must survive.
// The store ids are the POS ones (`pe`, `pine`, `trophy`); the shop's TRADING
// name lives in the label, which is why "Marathon Till 2" sits on a row keyed
// `pe`. Re-keying the store would have to re-key /pos/paymentEvents, which the
// expected-card calculator joins against verbatim.
const LIVE = {
  "67325636": { mid: "100000002453164", storeId: "pe",     tillId: "till-1", label: "Marathon Till 1" },
  "0000HP1X": { mid: "000000004977890", storeId: "pe",     tillId: "till-2", label: "Marathon Till 2" },
  "67365901": { mid: "100000001178101", storeId: "pe",     tillId: "till-3", label: "Marathon Till 3" },
  "67377843": { mid: "100000002816030", storeId: "trophy", tillId: "till-1", label: "Trophy Till 1"   },
  "0000Z4M6": { mid: "000000004977890", storeId: "trophy", tillId: "till-2", label: "Trophy Till 2"   },
  "67364485": { mid: "100000001178101", storeId: "pine",   tillId: "till-1", label: "Pine Till 1"     },
};

// The row 67377843 carried until 2026-09-18: no `mid` KEY at all. Kept because
// the MID-less path is still live code — a machine can be mapped before its
// merchant number is known, which is exactly what happened to this one.
const MIDLESS = { storeId: "trophy", tillId: "till-1", label: "Trophy Till 1" };

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
  // The second sharing, added 2026-09-18: Marathon Till 2 and Trophy Till 2
  // print the same merchant number in two different SHOPS.
  const alsoShared = Object.entries(LIVE).filter(([, r]) => r.mid === "000000004977890");
  assert.equal(alsoShared.length, 2, "0000HP1X and 0000Z4M6 share a merchant number");
  assert.equal(new Set(alsoShared.map(([, r]) => r.storeId)).size, 2, "…across two shops");
  // The registry is keyed by TID, so all four are distinguishable. A map keyed
  // by MID would collapse each pair into one entry — that is the mistake being
  // pinned, and the estate now contains it twice.
  const byMid = {};
  for (const [tid, r] of Object.entries(LIVE)) if (r.mid) byMid[r.mid] = tid;
  assert.equal(Object.keys(byMid).length, 4, "six terminals, four merchant numbers");
  assert.notEqual(Object.keys(byMid).length, Object.keys(LIVE).filter((t) => LIVE[t].mid).length,
    "keying terminals by MID loses two — which is exactly why nothing does");
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
    extraction: ex, terminal: MIDLESS, tid: "67377843",
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
      `the trading name must not be read or matched — three different names cover six terminals in three stores`);
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

// ─── THE ROW MOVES; THE RECORD DOES NOT ──────────────────────────────────────

test("a rename and a till move are stamped on the NEW record and rewrite no old one", () => {
  // 0000HP1X on 2026-09-17: pe/till-1, "PE Till 1". On 2026-09-18: pe/till-2,
  // "Marathon Till 2". Same machine, same TID, same store — and the twelve
  // batches already filed under it were captured against the till it was at.
  const before = { mid: "000000004977890", storeId: "pe", tillId: "till-1", label: "PE Till 1" };
  const after = LIVE["0000HP1X"];
  const ex = {
    tid: "0000HP1X", mid: "000000004977890", batchNo: "509",
    openedAt: 1787763004000, closedAt: 1787849404000, printedAt: null,
    openedText: null, closedText: null, txnCount: 1,
    purchasesCents: 10000, cashCents: 0, refundsCents: 0, totalCents: 10000, reconLine: null,
    confidence: {}, lines: [],
  };
  const args = {
    extraction: ex, tid: "0000HP1X", batchKey: "509", revision: 1, supersedes: null,
    photoPaths: [], summaryOnly: true, warnings: [],
    expected: { cardCents: 10000, legs: 1, byKind: {} }, cashiers: [],
    submittedBy: { uid: "u", email: null }, submittedAt: 1, draftId: "d", ocr: null,
  };
  const old = buildBatchRecord({ ...args, terminal: before });
  const now = buildBatchRecord({ ...args, terminal: after });

  // The record filed yesterday says where the money was rung yesterday.
  assert.equal(old.tillId, "till-1");
  assert.equal(old.terminalLabel, "PE Till 1");
  // Today's says where it is rung today. Nothing re-reads the registry to
  // render either one, which is the whole reason the label is on the record.
  assert.equal(now.tillId, "till-2");
  assert.equal(now.terminalLabel, "Marathon Till 2");
  // And the STORE is the same on both, because the store key did not change —
  // the shop was renamed, not re-keyed. If this ever fails, the two records are
  // filed under different /card_batches nodes and a reader subscribed to the
  // registry's current store cannot see the older one.
  assert.equal(old.storeId, "pe");
  assert.equal(now.storeId, "pe");
});

test("every live row's store id is a POS store id, not a trading name", () => {
  // The registry joins against /pos/paymentEvents verbatim. "marathon" is what
  // the shop is CALLED; `pe` is what every payment event, sale, cashup and
  // stock location on the estate is keyed by.
  for (const [tid, row] of Object.entries(LIVE)) {
    assert.ok(["pe", "pine", "trophy"].includes(row.storeId), `${tid} is keyed to store "${row.storeId}"`);
    assert.match(row.tillId, /^till-\d$/, `${tid} carries till "${row.tillId}"`);
  }
  // …and the trading name is only ever in the label.
  assert.ok(Object.values(LIVE).some((r) => /Marathon/.test(r.label)), "the trading name lives in the label");
});

// ─── RETIREMENT — A MACHINE LEAVES, ITS HISTORY STAYS ────────────────────────

test("retirement is the stamp itself, so there is nothing to disagree with", () => {
  assert.equal(isRetiredTerminal(LIVE["0000HP1X"]), false, "nothing is retired today");
  assert.equal(isRetiredTerminal({ ...LIVE["0000HP1X"], retiredAt: 1758153600000 }), true);
  // Not a boolean, not a string, not a truthy object: the STAMP. A row carrying
  // `retired: true` and no stamp is a row nobody can date, and it is not retired.
  assert.equal(isRetiredTerminal({ ...LIVE["0000HP1X"], retired: true }), false);
  assert.equal(isRetiredTerminal({ ...LIVE["0000HP1X"], retiredAt: "2026-09-18" }), false);
  assert.equal(isRetiredTerminal(null), false);
  assert.equal(isRetiredTerminal(undefined), false);
});

test("a terminal is only expected to report between arriving and leaving", () => {
  const ARRIVED = 1758153600000;          // 2026-09-18
  const row = { ...LIVE["67325636"], activeFrom: ARRIVED };
  assert.equal(wasActiveAt(row, ARRIVED - 1), false, "the day before it arrived");
  assert.equal(wasActiveAt(row, ARRIVED), true);
  assert.equal(wasActiveAt(row, ARRIVED + 86400000), true);

  const gone = { ...row, retiredAt: ARRIVED + 86400000 };
  assert.equal(wasActiveAt(gone, ARRIVED + 86400000), true, "its last day still counts");
  assert.equal(wasActiveAt(gone, ARRIVED + 86400001), false);

  // A row seeded before the field existed has ALWAYS been active. Treating a
  // missing activeFrom as "not yet arrived" would blank the outstanding report
  // for the four terminals that predate it — the exact failure of a default
  // that looks safe.
  const legacy = { ...LIVE["67364485"] };
  assert.equal("activeFrom" in legacy, false);
  assert.equal(wasActiveAt(legacy, 1), true);
  assert.equal(wasActiveAt(legacy, ARRIVED), true);
});

test("a retired machine's EMAILED slip is still recorded, and says so", () => {
  // Refusing it would drop a real settlement to make a point about tidiness.
  const registry = { ...LIVE, "0000HP1X": { ...LIVE["0000HP1X"], retiredAt: 1758153600000 } };
  const routed = routeEmailSlip({
    extraction: { tid: "0000HP1X", mid: "000000004977890" }, terminals: registry,
  });
  assert.equal(routed.ok, true, "a late final batch must not be refused");
  assert.equal(routed.terminal.storeId, "pe");
  assert.ok(routed.warnings.some((w) => /retired/i.test(w)),
    `the record must say the terminal was retired: ${JSON.stringify(routed.warnings)}`);
  // And an ACTIVE terminal carries no such warning — a warning on every slip is
  // a warning nobody reads.
  const fine = routeEmailSlip({ extraction: { tid: "0000HP1X", mid: "000000004977890" }, terminals: LIVE });
  assert.equal(fine.warnings.some((w) => /retired/i.test(w)), false);
});

test("the HAND capture path refuses a retired terminal on both channels", () => {
  // The screen does not draw the card; this is the half that holds when the
  // callable is called anyway. Asserted on the source because the alternative
  // is standing up the whole callable, and what must not regress is that BOTH
  // picked paths — photo and PDF — consult the predicate.
  const code = readFileSync(resolve(__dirname, "../cardRecon/cardRecon.js"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  const guards = code.match(/isRetiredTerminal\(/g) || [];
  assert.equal(guards.length, 2, "the photo path and the picked-PDF path each refuse a retired terminal");
  assert.match(code, /retiredCaptureRefusal\(/, "and the refusal is the shared sentence, not a second wording");
});

test("nothing anywhere deletes a TID mapping", () => {
  // A mapping is the only way back to /card_batches/{storeId}/{tid}. The seed
  // script refuses a delete flag outright and has no remove() in it; the
  // apply script writes per TID rather than set()ing the parent, which would
  // delete every row it did not name.
  const seed = readFileSync(resolve(__dirname, "../../scripts/seed-card-terminals.mjs"), "utf8");
  assert.match(seed, /REFUSED: a TID mapping is never deleted/);
  const seedCode = seed.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/config\/cardTerminals[^"'`]*`?\)\.remove\(/.test(seedCode),
    "the seed script must never remove a registry row");

  const apply = readFileSync(resolve(__dirname, "../../scripts/apply-terminal-registry-20260918.mjs"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/ref\("config\/cardTerminals"\)\.set\(/.test(apply),
    "a set() on the registry PARENT deletes every row the script does not name");
  assert.match(apply, /config\/cardTerminals\/\$\{tid\}`\)\.set\(/,
    "rows are written one TID at a time");
});

// ─── NO TERMINAL IS WRITTEN DOWN AS AN EXCEPTION ─────────────────────────────

test("no TID appears in the CODE of the capture feature, on either side", () => {
  // The screen used to say in its own header that three of the four machines
  // emailed and PE Till 1 (0000HP1X) could not. That was true for three weeks.
  // The machine has since been replaced with a PAX A920Pro — the same hardware
  // as the terminals that email themselves — so the estate's one manual-only
  // terminal may not be manual-only any more, and nobody has tested it yet.
  //
  // The manual path stays for EVERY till: a machine that does not email, one
  // whose email failed tonight, one nobody has tested. What must not exist is a
  // TID in a BRANCH — "if this is 0000HP1X, then". Which machines email is
  // answered by what turns up in /card_batch_intake; which machines exist is
  // answered by /config/cardTerminals. Neither answer is compiled in.
  //
  // COMMENTS MAY NAME A MACHINE — this file's own header does, and so does the
  // history in todaysArrivals.js; explaining what happened is how the next
  // person understands why the rule exists. CODE may not.
  const files = [
    "../cardRecon/cardRecon.js",
    "../lib/card-recon.cjs",
    "../lib/card-recon-email.cjs",
    "../lib/card-terminals.cjs",
    "../../src/components/cardrecon/CardReconScreen.jsx",
    "../../src/components/cardrecon/todaysArrivals.js",
    "../../src/components/cardrecon/terminalRegistry.js",
    "../../scripts/cardrecon/intakeCore.mjs",
  ];
  const offenders = [];
  let scanned = 0;
  for (const rel of files) {
    const raw = readFileSync(resolve(__dirname, rel), "utf8");
    // Line-wise, for the reason captureOnly.test.js documents at length: the
    // naive /\*[\s\S]*?\*/ strip treats the `/*` in accept="image/*" as a
    // comment opener and eats the rest of the file.
    const code = raw.split("\n").reduce(({ out, inBlock }, line) => {
      if (inBlock) return { out, inBlock: !/\*\//.test(line) };
      if (/^\s*\{?\/\*/.test(line)) return { out, inBlock: !/\*\//.test(line) };
      if (/^\s*\/\//.test(line)) return { out, inBlock: false };
      return { out: [...out, line], inBlock: false };
    }, { out: [], inBlock: false }).out.join("\n");
    scanned++;
    for (const tid of Object.keys(LIVE)) {
      if (code.includes(tid)) offenders.push(`${rel} names ${tid} in code`);
    }
  }
  assert.equal(scanned, files.length);
  assert.deepEqual(offenders, [], offenders.join("\n"));

  // THE SCAN MUST BE ABLE TO FAIL, or it passes on wreckage. Two proofs: the
  // files it read are not empty after stripping, and a TID placed in code where
  // this scan looks IS caught.
  for (const rel of files) {
    const raw = readFileSync(resolve(__dirname, rel), "utf8");
    assert.ok(raw.length > 200, `${rel} is suspiciously small`);
  }
  const planted = "const only = registry['0000HP1X'];";
  assert.ok(Object.keys(LIVE).some((tid) => planted.includes(tid)),
    "the needle this scan looks for does match a real TID in real code");
});
