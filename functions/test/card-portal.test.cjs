// ─── THE SIMPLYBLU PORTAL: A CROSS-CHECK FOR STANDARD BANK TILLS ─────────────
// Junid, 2 Nov 2026 (lib/card-portal.cjs): the portal was the record from 3
// Nov. From 7 Nov 2026 the photographed end-of-day report is the record
// (lib/card-sb-photo.cjs) and a pull only writes its figure BESIDE the record
// in force (`portalCheck`) — it never creates a record and never replaces one.
// The rows below have the portal's REAL column layout (Monthly Card POS -
// Terminal Batch Report → Card POS Transactions, read 2 Nov 2026); every value
// in them is invented.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const P = require("../lib/card-portal.cjs");
const { handlePortalDay } = require("../cardRecon/cardPortal.js");
const { handleSlip, processReadJob } = require("../cardRecon/cardRecon.js");
const { buildBatchRecord } = require("../lib/card-recon.cjs");
const { handleManualEntry } = require("../cardRecon/cardBatchManual.js");

const SAST = (s) => Date.parse(`${s}+02:00`);
const COLS = ["DateCreated: Minute", "ID", "TransactionNumber", "TransactionType", "TransactionStatus", "ProviderName",
  "Payment Method", "TerminalId", "BatchNo", "PaymentRefNo", "AuthCode", "Transaction Amount", "Amount Paid",
  "PurchaseValue", "TipAmount", "Refund", "CashbackWithdrawalValue", "SettlementValue", "User"];
let n = 0;
const row = (at, tid, rands, { type = "Purchase", status = "Success", id = null } = {}) => {
  n++;
  return [`${at}+02:00`, id || `id-${n}`, n, type, status, "Card", "Card - POS", tid, 561, `ref${n}`, `auth${n}`, rands, rands, rands, 0, 0, 0, rands, "Guest User"];
};

const HP1X = "0000HP1X", Z4M6 = "0000Z4M6", F1Y = "00000F1Y", F2Y = "00000F2Y";
const sb = { bank: "standard-bank" };
const TERMINALS = {
  [HP1X]: { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", mid: "000000004977890", ...sb, activeFrom: SAST("2026-09-18T14:00:00") },
  [Z4M6]: { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", mid: "000000004977890", capture: "typed", ...sb, activeFrom: SAST("2026-09-18T14:00:00") },
  [F2Y]: { storeId: "concrete", tillId: "till-1", label: "Concrete Till 1", mid: "0005377331", capture: "typed", ...sb, record: "portal", activeFrom: SAST("2026-10-30T00:00:00") },
  [F1Y]: { storeId: "concrete", tillId: "till-2", label: "Concrete Till 2", mid: "0005377331", capture: "typed", ...sb, record: "portal", activeFrom: SAST("2026-10-30T00:00:00") },
  "67325636": { storeId: "pe", tillId: "till-1", label: "Trophy Till 1", mid: "100000002453164" },
};
const POLLER = { uid: "card-recon-email-poller", token: {} };
const JUNID = { uid: "junid", token: { email: "gunidmoh@gmail.com", email_verified: true } };
const AMANDA = { uid: "u-amanda", token: { email: "amanda@marathon.internal" } };
const PHOTO = { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg")]).toString("base64") };
const bucket = () => ({ saved: [], file(p) { const self = this; return { save: async () => { self.saved.push(p); }, delete: async () => {} }; } });
const DAY = "2026-11-03";
const NOW = SAST("2026-11-03T18:00:30");
const card = (storeId, tillId, at, cents) => ({ method: "card", storeId, tillId, amount: cents, at: SAST(at), cashierUid: "c1", cashierName: "yasmin" });

// PE Till 2's last photographed batch before the portal took over.
const B560 = { batchKey: "560", batchNo: 560, revision: 1, capturedVia: "photo", tid: HP1X, storeId: "pe", tillId: "till-2",
  slip: { openedAt: SAST("2026-11-01T14:50:22"), closedAt: SAST("2026-11-02T17:01:42"), totalCents: 3837500, format: "printed", windowSource: "printed" } };

function world({ batches = {}, events = {}, extra = {} } = {}) {
  return makeFakeDb({
    config: { cardTerminals: TERMINALS },
    users: { [POLLER.uid]: { permFlags: { card_recon: true, card_recon_intake: true } }, [AMANDA.uid]: { cardSlipTills: { trophy: { "till-2": true } } } },
    card_batches: { pe: { [HP1X]: { 560: B560 } }, ...batches },
    pos: { paymentEvents: events },
    network: { pe: { tills: { "till-2": { label: "Till 2" } } } },
    ...extra,
  });
}
const pull = (db, rows, { tids = [HP1X, Z4M6], day = DAY, now = NOW, cols = COLS } = {}) => handlePortalDay(db, {
  auth: POLLER, data: { dayYmd: day, sources: [{ business: { name: "THE MARATHON", merchantNo: "0004977890" }, tids, cols, rows }] },
}, { now: () => now });
const node = async (db, p) => (await db.ref(p).once("value")).val();

// ── pure ─────────────────────────────────────────────────────────────────────

test("parse: successful purchases and refunds only, refunds negative, a repeated row once", () => {
  const rows = [
    row("2026-11-03T10:00:00", HP1X, 930),
    row("2026-11-03T10:05:00", HP1X, 350, { status: "Failed" }),
    row("2026-11-03T10:06:00", HP1X, 100, { type: "Refund" }),
    row("2026-11-03T10:07:00", HP1X, 50, { type: "Void" }),
  ];
  rows.push([...rows[0]]); // the same transaction twice (same ID)
  const p = P.parsePortalRows({ cols: COLS, rows });
  assert.equal(p.ok, true);
  assert.deepEqual(p.txns.map((t) => t.amountCents), [93000, -10000]);
  assert.deepEqual(p.skipped, { status: 1, type: 1, unreadable: 0 });
});

test("parse: a missing column or a row count at Metabase's cap refuses the day", () => {
  assert.equal(P.parsePortalRows({ cols: COLS.filter((c) => c !== "TerminalId"), rows: [] }).ok, false);
  const cap = Array.from({ length: P.METABASE_ROW_CAP }, () => row("2026-11-03T10:00:00", HP1X, 1));
  assert.match(P.parsePortalRows({ cols: COLS, rows: cap }).reason, /limit/);
});

test("rands: numbers and the portal's printed forms", () => {
  assert.equal(P.randsToCents(930), 93000);
  assert.equal(P.randsToCents(12.345), 1235);
  assert.equal(P.randsToCents("R 1 000,00"), 100000);
  assert.equal(P.randsToCents("1,000.50"), 100050);
  assert.equal(P.randsToCents("abc"), null);
});

test("TIDs: exact, O/0 and leading zeros for Standard Bank rows; 'Unknown' ignored; a new machine unassigned", () => {
  const m = P.mapPortalTids([HP1X, "0000OF1Y", "0F2Y", "Unknown", "", "0000NEW1"], TERMINALS);
  assert.deepEqual(m.mapped, { [HP1X]: HP1X, "0000OF1Y": F1Y, "0F2Y": F2Y });
  assert.deepEqual(m.unassigned, ["0000NEW1"]);
  assert.equal(P.unassignedKey("0000OEW1"), "EW1");
});

test("the portal is the record only for Standard Bank machines, only from 3 Nov", () => {
  assert.equal(P.isPortalDay(TERMINALS[HP1X], "2026-11-03"), true);
  assert.equal(P.isPortalDay(TERMINALS[HP1X], "2026-11-02"), false);
  assert.equal(P.isPortalDay(TERMINALS["67325636"], "2026-11-03"), false);
  assert.deepEqual(P.daysToPull("2026-10-31"), ["2026-10-30", "2026-10-31"]);
  assert.deepEqual(P.daysToPull("2026-11-03"), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(P.daysToPull("2026-11-10"), ["2026-11-08", "2026-11-09", "2026-11-10"]);
});

test("the window is the SAST calendar day; a transaction at 23:59 is in it, 00:00 next day is not", () => {
  const txns = P.parsePortalRows({ cols: COLS, rows: [row("2026-11-03T00:00:00", HP1X, 1), row("2026-11-03T23:59:00", HP1X, 2), row("2026-11-04T00:00:00", HP1X, 4)] }).txns;
  const ex = P.portalExtraction({ tid: HP1X, dayYmd: DAY, txns });
  assert.equal(ex.openedAt, SAST("2026-11-03T00:00:00"));
  assert.equal(ex.closedAt, SAST("2026-11-04T00:00:00") - 1);
  assert.equal(ex.totalCents, 300);
  assert.equal(ex.windowSource, "portal-day");
});

// ── the ingest: a cross-check (7 Nov 2026) ───────────────────────────────────

// A portal record written by the 3–6 Nov ingest, before the photo took over.
function legacyPortal(tid, storeId, tillId, key, rows, day = DAY) {
  const txns = P.parsePortalRows({ cols: COLS, rows }).txns;
  const ex = { ...P.portalExtraction({ tid, dayYmd: day, txns }), batchNo: String(parseInt(key, 10)) };
  const rec = buildBatchRecord({
    extraction: ex, terminal: { storeId, tillId, label: null }, tid, batchKey: key, revision: 1, supersedes: null,
    photoPaths: null, summaryOnly: false, warnings: [], expected: { cardCents: 0, byKind: {} }, cashiers: [],
    submittedBy: { uid: "poller", email: null }, submittedAt: NOW, draftId: null, ocr: null, capturedVia: P.PORTAL_SOURCE,
  });
  return JSON.parse(JSON.stringify({ ...rec, portal: { dayYmd: day, source: P.PORTAL_SOURCE } }));
}
// The photographed #561 of 3 Nov (Yasmin's real paper: R33,440.00, closed 17:08:38).
const B561 = { batchKey: "561", batchNo: 561, revision: 1, capturedVia: "photo", tid: HP1X, storeId: "pe", tillId: "till-2",
  slip: { openedAt: SAST("2026-11-02T17:01:40"), closedAt: SAST("2026-11-03T17:08:38"), totalCents: 3344000, format: "printed", windowSource: "printed" } };

test("a pull never creates a record: with no record for the day it only says what the portal showed", async () => {
  const db = world({ events: { a: card("pe", "till-2", "2026-11-03T10:01:30", 93000) } });
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930), row("2026-11-03T11:15:00", HP1X, 350)]);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.results[HP1X].outcome, "awaiting-photo");
  assert.equal(out.results[HP1X].totalCents, 128000);
  assert.deepEqual(Object.keys(await node(db, `card_batches/pe/${HP1X}`)), ["560"], "no portal record");
  const day = await node(db, `card_batch_overrides/portal/days/${DAY}/${HP1X}`);
  assert.equal(day.outcome, "awaiting-photo");
  assert.equal(day.totalCents, 128000);
});

test("ZERO transactions (Marathon's merchant from 3 Nov) never becomes a R0.00 SHORT record", async () => {
  const db = world({ events: { a: card("trophy", "till-2", "2026-11-03T12:00:00", 50000) } });
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930)]);
  assert.equal(out.results[Z4M6].outcome, "awaiting-photo");
  assert.equal(await node(db, `card_batches/trophy/${Z4M6}`), null);
});

test("the photographed report on file for the day stands; the portal figure goes beside it", async () => {
  const db = world({ batches: { pe: { [HP1X]: { 560: B560, 561: B561 } } } });
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930)]);
  assert.equal(out.results[HP1X].outcome, "checked");
  assert.equal(out.results[HP1X].key, "561");
  const rec = await node(db, `card_batches/pe/${HP1X}/561`);
  assert.equal(rec.capturedVia, "photo");
  assert.equal(rec.slip.totalCents, 3344000, "the photo's figure is untouched");
  assert.equal(rec.portalCheck.totalCents, 93000);
  assert.equal(rec.portalCheck.differsCents, 93000 - 3344000);
  assert.deepEqual(Object.keys(await node(db, `card_batches/pe/${HP1X}`)).sort(), ["560", "561"]);
});

test("a staff-typed record for the day is not replaced by a pull either (it was, 3–6 Nov)", async () => {
  const staff = { batchKey: "510", batchNo: 510, revision: 1, capturedVia: "typed", tid: Z4M6, storeId: "trophy", tillId: "till-2",
    declaredTotal: { cents: 40000, via: "staff-slip", byUid: "u-amanda", byEmail: "amanda@marathon.internal", at: SAST("2026-11-03T16:00:00") },
    photos: ["cardRecon/x/photo-0.jpg"],
    slip: { openedAt: SAST("2026-11-02T18:50:00"), closedAt: SAST("2026-11-03T18:50:00"), totalCents: 40000, format: "typed", windowSource: "typed-span" } };
  const db = world({ batches: { trophy: { [Z4M6]: { 510: staff } } } });
  const out = await pull(db, [row("2026-11-03T15:00:00", Z4M6, 500)]);
  assert.equal(out.results[Z4M6].outcome, "checked");
  assert.deepEqual(Object.keys(await node(db, `card_batches/trophy/${Z4M6}`)), ["510"]);
  assert.equal((await node(db, `card_batches/trophy/${Z4M6}/510`)).portalCheck.totalCents, 50000);
});

test("a legacy portal record (3–6 Nov) is still revised by a later pull — one card, never two", async () => {
  const db = world({ batches: { pe: { [HP1X]: { 560: B560, 561: legacyPortal(HP1X, "pe", "till-2", "561", [row("2026-11-03T10:01:00", HP1X, 930)]) } } } });
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930, { id: "id-x" }), row("2026-11-03T16:40:00", HP1X, 200)], { now: NOW + 86400000 });
  assert.equal(out.results[HP1X].key, "561-r2");
  const r2 = await node(db, `card_batches/pe/${HP1X}/561-r2`);
  assert.equal(r2.supersedes, "561");
  assert.equal(r2.slip.totalCents, 113000);
});

test("when Concrete's merchant appears, its machines are picked up by their O/0 spelling — nothing registered", async () => {
  const db = world();
  const r = await handlePortalDay(db, { auth: POLLER, data: { dayYmd: DAY, sources: [
    { business: { name: "THE MARATHON", merchantNo: "0004977890" }, tids: [HP1X, Z4M6], cols: COLS, rows: [] },
    { business: { name: "MARATHON CONCRETE", merchantNo: "0005377331" }, tids: ["0000OF2Y", "0000OF1Y"], cols: COLS, rows: [row("2026-11-03T09:00:00", "0000OF2Y", 500)] },
  ] } }, { now: () => NOW });
  // Concrete's record IS the portal (record: "portal", Junid 7 Nov 2026).
  assert.equal(r.results[F2Y].outcome, "recorded");
  assert.equal((await node(db, `card_batches/concrete/${F2Y}/1`)).slip.totalCents, 50000);
  assert.equal((await node(db, `card_batches/concrete/${F1Y}/1`)).slip.totalCents, 0);
  assert.equal(await node(db, "card_batch_overrides/portal/unassigned"), null, "both spellings resolved");
});

test("a machine the portal does not list (not linked yet) is awaiting, as before", async () => {
  const db = world({ events: { a: card("concrete", "till-1", "2026-11-03T12:00:00", 50000) } });
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930)]);
  assert.equal(out.results[F2Y].outcome, "awaiting");
  assert.equal(out.results[F1Y].outcome, "awaiting");
  assert.equal(await node(db, "card_batches/concrete"), null);
  const st = await node(db, "card_batch_overrides/portal/status");
  assert.deepEqual(st.awaiting.sort(), [F1Y, F2Y].sort());
});

test("a TID in the portal that is not registered is kept as UNASSIGNED with its money — never dropped, never guessed", async () => {
  const db = world();
  const out = await pull(db, [row("2026-11-03T10:01:00", "0000NEW1", 250)], { tids: [HP1X, Z4M6, "0000NEW1"] });
  assert.equal(out.results["unassigned:0000NEW1"].outcome, "unassigned");
  const u = await node(db, "card_batch_overrides/portal/unassigned/NEW1");
  assert.equal(u.tid, "0000NEW1");
  assert.equal(u.merchantNo, "0004977890");
  assert.deepEqual(u.days[DAY], { txns: 1, cents: 25000 });
  assert.equal(u.firstSeenAt, NOW);
});

test("a portal layout the parser cannot read: its machines are awaiting, nothing written", async () => {
  const db = world();
  const out = await pull(db, [], { cols: COLS.filter((c) => c !== "TransactionStatus") });
  assert.equal(out.results[HP1X].outcome, "awaiting");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/561`), null);
  assert.equal(out.sources[0].ok, false);
});

test("nothing before the floor (30 Oct 2026); each machine from its OWN start (Junid, 2 Nov 2026)", async () => {
  assert.equal((await pull(world(), [], { day: "2026-10-29" })).ok, false);
  const db = world();
  await db.ref(`config/cardTerminals/${F2Y}/portalFrom`).set("2026-10-30");
  await db.ref(`config/cardTerminals/${F1Y}/portalFrom`).set("2026-10-30");
  const out = await handlePortalDay(db, { auth: POLLER, data: { dayYmd: "2026-10-31", sources: [
    { business: { name: "THE MARATHON", merchantNo: "0004977890" }, tids: [HP1X, Z4M6], cols: COLS, rows: [row("2026-10-31T10:00:00", HP1X, 100)] },
    { business: { name: "CONCRETE", merchantNo: "0005377331" }, tids: ["0000OF2Y", "0000OF1Y"], cols: COLS, rows: [row("2026-10-31T11:00:00", "0000OF2Y", 7380), row("2026-10-31T12:00:00", "0000OF1Y", 750)] },
  ] } }, { now: () => SAST("2026-11-02T20:00:00") });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.results[F2Y].outcome, "recorded");
  assert.equal((await node(db, `card_batches/concrete/${F2Y}/1`)).slip.totalCents, 738000);
  assert.equal(out.results[HP1X].outcome, "ignored", "PE Till 2 is not a portal till before 3 Nov");
  assert.equal(P.portalFromOf({ portalFrom: "2026-01-01" }), "2026-10-30", "never before the floor");
});

test("TODAY with no transaction on the merchant at all: awaiting; the day after, still no record", async () => {
  const db = world();
  assert.equal((await pull(db, [], { now: NOW })).results[HP1X].outcome, "awaiting");
  assert.equal((await pull(db, [], { now: NOW + 86400000 })).results[HP1X].outcome, "awaiting-photo");
  assert.deepEqual(Object.keys(await node(db, `card_batches/pe/${HP1X}`)), ["560"]);
});

// ── the photographed report takes the portal's day over ─────────────────────

const YASMIN = { uid: "u-yasmin", token: { email: "yasmin@marathon.internal" } };
const report = (over = {}) => ({
  mid: "000000004977890", tid: "0000HP1X", batchNo: "561",
  opened: "2026/11/02 17:01:40", closed: "2026/11/03 17:08:38", printed: "2026/11/03 17:08:40",
  txnCount: 48, purchases: "R33,440.00", cash: "R0.00", refunds: "R0.00", total: "R33,440.00",
  reconLine: "500 - Reconciled, in balance",
  confidence: { mid: 0.99, tid: 0.99, batchNo: 0.99, opened: 0.99, closed: 0.99, txnCount: 0.99, purchases: 0.99, refunds: 0.99, total: 0.99 },
  transactions: [], ...over,
});
async function sendAndRead(db, parsed, at) {
  const sent = await handleSlip(db, { auth: YASMIN, data: { action: "slip", pickedTid: HP1X, photos: [PHOTO] } }, { now: () => at, bucket: bucket() });
  assert.equal(sent.ok, true, sent.reason);
  const jobs = Object.values(await node(db, "card_batch_jobs"));
  const job = jobs.sort((a, b) => a.receivedAt - b.receivedAt).at(-1);
  return processReadJob(db, job.jobId, { now: () => at + 60000, onArrival: true, loadPhotos: async () => [PHOTO],
    ocr: async () => ({ parsed, model: "t", attempts: 1, tokensIn: 1, tokensOut: 1 }) });
}
const peWorld = (batches) => world({ batches: { pe: { [HP1X]: batches } }, extra: {
  users: { [YASMIN.uid]: { cardSlipTills: { pe: { "till-2": true } } } },
} });

test("Yasmin's #561 of 3 Nov takes over the portal's R0.00 record of the same day — a revision, one card", async () => {
  const db = peWorld({ 560: B560, 561: legacyPortal(HP1X, "pe", "till-2", "561", []) });
  const out = await sendAndRead(db, report(), SAST("2026-11-07T09:00:00"));
  assert.equal(out.final, "recorded");
  const r2 = await node(db, `card_batches/pe/${HP1X}/561-r2`);
  assert.equal(r2.capturedVia, "photo");
  assert.equal(r2.supersedes, "561");
  assert.equal(r2.slip.totalCents, 3344000);
  assert.equal(r2.photoReport.filing, "over");
  assert.ok(r2.warnings.some((w) => /replaces the SimplyBLU portal's record for 2026-11-03 \(561\)/.test(w)), r2.warnings.join(" | "));
  assert.equal((await node(db, `card_batches/pe/${HP1X}/561`)).slip.totalCents, 0, "the portal record is kept unchanged");
  // A second photo of the same paper is a duplicate.
  assert.equal((await sendAndRead(db, report(), SAST("2026-11-07T09:10:00"))).final, "duplicate");
  // …and the next pull leaves the photo standing, its figure beside it.
  const again = await pull(db, [], { now: SAST("2026-11-07T18:00:00") });
  assert.equal(again.results[HP1X].outcome, "checked");
  assert.equal(again.results[HP1X].key, "561-r2");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/561-r3`), null);
});

test("PE Till 2's real #562 (3→5 Nov) and #563 (5→6 Nov): printed numbers kept, 5 Nov displaced, one card a day", async () => {
  const db = peWorld({ 560: B560,
    561: legacyPortal(HP1X, "pe", "till-2", "561", []),
    562: legacyPortal(HP1X, "pe", "till-2", "562", [], "2026-11-04"),
    563: legacyPortal(HP1X, "pe", "till-2", "563", [], "2026-11-05") });
  const r562 = await sendAndRead(db, report({ batchNo: "562", opened: "2026/11/03 17:08:35", closed: "2026/11/05 16:53:43", printed: "2026/11/05 16:53:45",
    txnCount: 59, purchases: "R38,890.00", total: "R38,890.00" }), SAST("2026-11-07T09:00:00"));
  assert.equal(r562.final, "recorded");
  const a = await node(db, `card_batches/pe/${HP1X}/562-r2`);
  assert.equal(a.slip.totalCents, 3889000);
  assert.equal(a.supersedes, "562");
  assert.equal(a.printedBatchNo, undefined, "filed under the number it prints");
  assert.equal((await node(db, `card_batches/pe/${HP1X}/563`)).displacedBy, "562-r2", "the portal's 5 Nov is displaced, kept");
  const r563 = await sendAndRead(db, report({ batchNo: "563", opened: "2026/11/05 16:53:40", closed: "2026/11/06 17:05:58", printed: "2026/11/06 17:06:01",
    txnCount: 62, purchases: "R46,500.00", total: "R46,500.00" }), SAST("2026-11-07T09:05:00"));
  assert.equal(r563.final, "recorded");
  const b = await node(db, `card_batches/pe/${HP1X}/563-r2`);
  assert.equal(b.slip.totalCents, 4650000);
  assert.equal(b.supersedes, "563");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/564`), null, "nothing renumbered");
  // A pull of 4 Nov with CHANGED figures: the portal's 4 Nov chain is now the
  // photo's (562-r2, closed 5 Nov) — nothing is revised over it (CodeRabbit, #862).
  const p4 = await pull(db, [row("2026-11-04T10:00:00", HP1X, 120)], { day: "2026-11-04", now: SAST("2026-11-07T18:00:00") });
  assert.equal(p4.results[HP1X].outcome, "superseded");
  assert.equal(p4.results[HP1X].key, "562-r2");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/562-r3`), null);
  // A pull of 5 Nov afterwards: the displaced portal record is not the day's.
  const pullAfter = await pull(db, [], { day: "2026-11-05", now: SAST("2026-11-07T18:00:00") });
  assert.equal(pullAfter.results[HP1X].outcome, "checked");
  assert.equal(pullAfter.results[HP1X].key, "562-r2");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/563-r3`), null);
});

test("a printed number taken by ANOTHER day's portal record: filed under the next free number, saying so", async () => {
  // The portal's #561 is 3 Nov; this machine's paper prints #561 for 7 Nov.
  const db = peWorld({ 560: B560, 561: legacyPortal(HP1X, "pe", "till-2", "561", []), 562: legacyPortal(HP1X, "pe", "till-2", "562", [], "2026-11-04") });
  const out = await sendAndRead(db, report({ opened: "2026/11/06 17:00:00", closed: "2026/11/07 17:05:00", printed: "2026/11/07 17:05:02" }), SAST("2026-11-07T17:20:00"));
  assert.equal(out.final, "recorded");
  const rec = await node(db, `card_batches/pe/${HP1X}/563`);
  assert.equal(rec.capturedVia, "photo");
  assert.equal(rec.printedBatchNo, 561);
  assert.equal(rec.photoReport.filing, "renumbered");
  assert.ok(rec.warnings.some((w) => /prints batch #561; that number is already used by the SimplyBLU portal's record for 2026-11-03, so this report is filed as #563/.test(w)));
  assert.equal((await node(db, `card_batches/pe/${HP1X}/561`)).slip.totalCents, 0, "3 Nov untouched");
  // The same paper again is still a duplicate, not a third number.
  assert.equal((await sendAndRead(db, report({ opened: "2026/11/06 17:00:00", closed: "2026/11/07 17:05:00", printed: "2026/11/07 17:05:02" }), SAST("2026-11-07T17:30:00"))).final, "duplicate");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/564`), null);
});

test("a Standard Bank staff photo is never held for the portal any more — it is read", async () => {
  const db = world({ extra: { network: { trophy: { tills: { "till-2": { label: "Till 2" } } } } } });
  const sent = await handleSlip(db, { auth: AMANDA, data: { action: "slip", pickedTid: Z4M6, photos: [PHOTO], declaredTotal: "500.00" } },
    { now: () => SAST("2026-11-07T16:55:00"), bucket: bucket() });
  assert.equal(sent.ok, true, sent.reason);
  assert.equal(await node(db, "card_batch_overrides/portal/held"), null);
  const [job] = Object.values(await node(db, "card_batch_jobs"));
  assert.equal(job.bank, "standard-bank");
  assert.equal(job.typedCents, 50000);
  assert.equal(job.mode, undefined);
});

test("Junid's manual entry is refused for a day a legacy portal record holds (correction still allowed)", async () => {
  const db = world({ batches: { pe: { [HP1X]: { 560: B560, 561: legacyPortal(HP1X, "pe", "till-2", "561", [row("2026-11-03T10:01:00", HP1X, 930)]) } } } });
  const out = await handleManualEntry(db, { auth: JUNID, data: { tid: HP1X, dayYmd: DAY, total: "930.00", batchNo: "562" } }, { now: () => NOW + 3600000 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /SimplyBLU portal is already the record/);
});

test("Junid's correction of a portal day stands — a later pull only checks beside it", async () => {
  const db = world({ batches: { pe: { [HP1X]: { 560: B560, 561: legacyPortal(HP1X, "pe", "till-2", "561", [row("2026-11-03T10:01:00", HP1X, 930)]) } } } });
  const fix = await handleManualEntry(db, { auth: JUNID, data: { tid: HP1X, dayYmd: DAY, total: "1000.00", replaces: "561", reason: "wrong" } }, { now: () => NOW + 3600000 });
  assert.equal(fix.ok, true, fix.reason);
  const again = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930), row("2026-11-03T11:00:00", HP1X, 70)], { now: NOW + 86400000 });
  assert.equal(again.results[HP1X].outcome, "checked");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/561-r3`), null);
});

// ── review fixes (Sonnet architect, #837) ────────────────────────────────────

test("a status or type the parser does not know refuses the source — never a silent R0.00", () => {
  const p = P.parsePortalRows({ cols: COLS, rows: [row("2026-11-03T10:00:00", HP1X, 930, { status: "Paid out" })] });
  assert.equal(p.ok, false);
  assert.match(p.reason, /cannot read/);
  assert.equal(P.parsePortalRows({ cols: COLS, rows: [row("2026-11-03T10:00:00", HP1X, 930, { type: "Cashback" })] }).ok, false);
  assert.equal(P.parsePortalRows({ cols: COLS, rows: [row("2026-11-03T10:00:00", HP1X, 930, { status: "Declined" })] }).ok, true);
});

test("a slip held before 7 Nov is swept onto its legacy portal record by an unchanged pull", async () => {
  const rows = [row("2026-11-03T15:00:00", Z4M6, 500)];
  const db = world({ batches: { trophy: { [Z4M6]: { 510: legacyPortal(Z4M6, "trophy", "till-2", "510", rows) } } } });
  await db.ref(`card_batch_overrides/portal/held/trophy/${Z4M6}/${DAY}/s1`).set({ slipId: "s1", cents: 50000, photos: ["p"], at: NOW, held: true });
  const again = await pull(db, rows, { now: NOW + 60000 });
  assert.equal(again.results[Z4M6].outcome, "unchanged");
  assert.equal((await node(db, `card_batches/trophy/${Z4M6}/510/supportingSlips/s1`)).cents, 50000);
  assert.equal(await node(db, `card_batch_overrides/portal/held/trophy/${Z4M6}/${DAY}/s1/takenInto`), "510");
});

test("a TID printed with a hyphen or space keeps its transactions (CodeRabbit, #837)", async () => {
  const db = world({ events: { a: card("pe", "till-2", "2026-11-03T10:01:30", 93000) } });
  const out = await pull(db, [row("2026-11-03T10:01:00", "0000-HP1X", 930)], { tids: ["0000-HP1X", "0000 Z4M6"] });
  assert.equal(out.results[HP1X].totalCents, 93000);
});

test("a successful payment with an unreadable amount refuses the source (CodeRabbit, #837)", () => {
  const r = row("2026-11-03T10:00:00", HP1X, "abc");
  assert.equal(P.parsePortalRows({ cols: COLS, rows: [r] }).ok, false);
});

// ── Concrete stays on the portal (Junid, 7 Nov 2026: "Concrete is fine with SimplyBLU") ──
const AMANDA_C = { uid: "u-amanda-c", token: { email: "amanda@marathon.internal" } };
const concreteWorld = (batches = {}) => world({ batches: { concrete: batches }, extra: {
  users: { [POLLER.uid]: { permFlags: { card_recon: true, card_recon_intake: true } }, [AMANDA_C.uid]: { cardSlipTills: { concrete: { "till-1": true, "till-2": true } } } },
  network: { concrete: { tills: { "till-1": { label: "Till 1" }, "till-2": { label: "Till 2" } } } },
} });
const concretePull = (db, rows, { day = DAY, now = NOW } = {}) => handlePortalDay(db, {
  auth: POLLER, data: { dayYmd: day, sources: [{ business: { name: "CONCRETE", merchantNo: "0005377331" }, tids: ["0000OF2Y", "0000OF1Y"], cols: COLS, rows }] },
}, { now: () => now });

test("Concrete: the portal day is the record (a new batch); a re-pull with a late transaction revises it", async () => {
  const db = concreteWorld();
  const a = await concretePull(db, [row("2026-11-03T10:00:00", "0000OF2Y", 500)]);
  assert.equal(a.results[F2Y].outcome, "recorded");
  assert.equal(a.results[F2Y].key, "1");
  const b = await concretePull(db, [row("2026-11-03T10:00:00", "0000OF2Y", 500, { id: "x" }), row("2026-11-03T15:00:00", "0000OF2Y", 200)], { now: NOW + 86400000 });
  assert.equal(b.results[F2Y].key, "1-r2");
  assert.equal((await node(db, `card_batches/concrete/${F2Y}/1-r2`)).slip.totalCents, 70000);
});

test("Concrete: Amanda's slip (photo + typed total) is HELD for the portal, never read into a figure, and the portal record carries it", async () => {
  const db = concreteWorld();
  const sent = await handleSlip(db, { auth: AMANDA_C, data: { action: "slip", pickedTid: F2Y, photos: [PHOTO], declaredTotal: "500.00" } },
    { now: () => SAST("2026-11-03T16:55:00"), bucket: bucket() });
  assert.equal(sent.ok, true, sent.reason);
  assert.ok(sent.receipt, "Sent only with the server's receipt");
  assert.equal(await node(db, "card_batch_jobs"), null, "no read job");
  assert.equal(await node(db, `card_batches/concrete/${F2Y}`), null);
  const held = await node(db, `card_batch_overrides/portal/held/concrete/${F2Y}/${DAY}`);
  assert.equal(Object.values(held)[0].cents, 50000);
  const out = await concretePull(db, [row("2026-11-03T15:00:00", "0000OF2Y", 500)]);
  const rec = await node(db, `card_batches/concrete/${F2Y}/${out.results[F2Y].key}`);
  assert.equal(rec.capturedVia, "simplyblu-portal");
  assert.equal(Object.values(rec.supportingSlips)[0].cents, 50000);
});

test("Concrete: a staff-typed record for the day is replaced by the portal as before; Junid's correction stands", async () => {
  const staff = { batchKey: "5", batchNo: 5, revision: 1, capturedVia: "typed", tid: F2Y, storeId: "concrete", tillId: "till-1",
    declaredTotal: { cents: 40000, via: "staff-slip" }, photos: ["p"],
    slip: { openedAt: SAST("2026-11-02T18:50:00"), closedAt: SAST("2026-11-03T18:50:00"), totalCents: 40000, format: "typed", windowSource: "typed-span" } };
  const db = concreteWorld({ [F2Y]: { 5: staff } });
  const out = await concretePull(db, [row("2026-11-03T15:00:00", "0000OF2Y", 500)]);
  assert.equal(out.results[F2Y].key, "5-r2");
  assert.equal((await node(db, `card_batches/concrete/${F2Y}/5-r2`)).capturedVia, "simplyblu-portal");
  const fix = await handleManualEntry(db, { auth: JUNID, data: { tid: F2Y, dayYmd: DAY, total: "600.00", replaces: "5-r2", reason: "wrong" } }, { now: () => NOW + 3600000 });
  assert.equal(fix.ok, true, fix.reason);
  const again = await concretePull(db, [row("2026-11-03T15:00:00", "0000OF2Y", 500), row("2026-11-03T16:00:00", "0000OF2Y", 50)], { now: NOW + 86400000 });
  assert.equal(again.results[F2Y].outcome, "unchanged");
  assert.equal(again.results[F2Y].note, "Junid's correction stands");
});

test("…while Marathon PE Till 2 and Trophy Till 2 stay photographed: their pull is only a cross-check", async () => {
  const db = world();
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930)]);
  assert.equal(out.results[HP1X].outcome, "awaiting-photo");
  assert.equal(out.results[Z4M6].outcome, "awaiting-photo");
});


// ── where a till's day comes from is per terminal (Junid, 8 Nov 2026) ──
const { reportSource, isPhotoPrimary, isPortalRecordTerminal } = require("../lib/card-terminals.cjs");

test("source: read from the row; without one FNB is email and Standard Bank is photo unless record says portal", () => {
  assert.equal(reportSource({ bank: "standard-bank", source: "portal" }), "portal");
  assert.equal(reportSource({ bank: "standard-bank", source: "photo", record: "portal" }), "photo", "source wins over the older field");
  assert.equal(reportSource({ bank: "standard-bank", record: "portal" }), "portal");
  assert.equal(reportSource({ bank: "standard-bank" }), "photo");
  assert.equal(reportSource({ storeId: "pe" }), "email");
  assert.equal(reportSource({ bank: "standard-bank", source: "nonsense" }), "photo", "a mangled source falls back");
});

test("source: an FNB row is never moved off its emailed path, whatever its row says", () => {
  for (const source of ["portal", "photo"]) {
    assert.equal(isPortalRecordTerminal({ source }), false);
    assert.equal(isPhotoPrimary({ source }), false);
  }
});

test("linking PE Till 2 is one field: source becomes portal and the pull records it, no code change", async () => {
  const before = world();
  assert.equal((await pull(before, [row("2026-11-03T10:00:00", HP1X, 500)])).results[HP1X].outcome, "awaiting-photo");
  const after = world({ extra: { config: { cardTerminals: { ...TERMINALS, [HP1X]: { ...TERMINALS[HP1X], source: "portal" } } } } });
  const got = await pull(after, [row("2026-11-03T10:00:00", HP1X, 500)]);
  assert.equal(got.results[HP1X].outcome, "recorded");
  assert.equal((await node(after, `card_batches/pe/${HP1X}/${got.results[HP1X].key}`)).capturedVia, P.PORTAL_SOURCE);
});

const concreteWithSales = (events) => world({ events, extra: {
  users: { [POLLER.uid]: { permFlags: { card_recon: true, card_recon_intake: true } } },
  network: { concrete: { tills: { "till-1": { label: "Till 1" }, "till-2": { label: "Till 2" } } } },
} });
const SALE = { a: card("concrete", "till-1", "2026-11-03T12:00:00", 1989000) };

test("Concrete, today, portal empty: 'awaiting' through the 18:00 pull", async () => {
  const db = concreteWithSales(SALE);
  const got = await concretePull(db, [], { now: SAST("2026-11-03T18:00:30") });
  assert.equal(got.results[F2Y].outcome, "awaiting");
  assert.equal(await node(db, `card_batches/concrete/${F2Y}`), null);
});

test("Concrete, today, portal empty at the 18:20 pull: the figure with the specific error, and the POS amount in it", async () => {
  const db = concreteWithSales(SALE);
  const got = await concretePull(db, [], { now: SAST("2026-11-03T18:20:05") });
  assert.equal(got.results[F2Y].outcome, "recorded");
  const rec = await node(db, `card_batches/concrete/${F2Y}/${got.results[F2Y].key}`);
  assert.equal(rec.slip.totalCents, 0);
  assert.ok(rec.warnings.some((w) => /SimplyBLU lists none of the R19890\.00/.test(w)), rec.warnings.join(" / "));
});

test("the 18:20 rule is only for portal tills: a photo till's empty day today still waits", async () => {
  const db = world();
  assert.equal((await pull(db, [], { now: SAST("2026-11-03T18:20:05") })).results[HP1X].outcome, "awaiting");
});

test("a zero portal day that took no POS card money carries no 'lists none of' error", async () => {
  const db = concreteWithSales({});
  const got = await concretePull(db, [], { now: SAST("2026-11-03T18:20:05") });
  const rec = await node(db, `card_batches/concrete/${F2Y}/${got.results[F2Y].key}`);
  assert.equal(rec.warnings.some((w) => /lists none of/.test(w)), false);
});

test("the backfill is one card a day: re-pulling a recorded day changes nothing", async () => {
  const db = concreteWorld();
  const day = [row("2026-11-03T10:00:00", "0000OF2Y", 500, { id: "fixed" })];
  const first = await concretePull(db, day, { now: NOW + 86400000 });
  const again = await concretePull(db, day, { now: NOW + 2 * 86400000 });
  assert.equal(first.results[F2Y].key, again.results[F2Y].key);
  assert.equal(again.results[F2Y].outcome, "unchanged");
  assert.deepEqual(Object.keys(await node(db, `card_batches/concrete/${F2Y}`)), [first.results[F2Y].key]);
});

// ─── A MACHINE NOT IN USE (Junid, 8 Nov 2026: Concrete Till 2) ───────────────
const inactiveWorld = (events = {}) => {
  const db = makeFakeDb({
    config: { cardTerminals: { ...TERMINALS, [F1Y]: { ...TERMINALS[F1Y], source: "inactive", foldInto: F2Y } } },
    users: { [POLLER.uid]: { permFlags: { card_recon: true, card_recon_intake: true } } },
    card_batches: {},
    pos: { paymentEvents: events },
    network: { concrete: { tills: { "till-1": { label: "Till 1" }, "till-2": { label: "Till 2" } } } },
  });
  return db;
};
const concreteDay = (db, rows, now) => handlePortalDay(db, { auth: POLLER, data: { dayYmd: DAY, sources: [{ business: { name: "CONCRETE", merchantNo: "0005377331" }, tids: ["0000OF1Y", "0000OF2Y"], cols: COLS, rows }] } }, { now: () => now });

test("a machine not in use gets no card, and its payment counts on the machine in use", async () => {
  const db = inactiveWorld({ a: card("concrete", "till-1", "2026-11-03T15:02:30", 75000) });
  const got = await concreteDay(db, [row("2026-11-03T15:01:00", "0000OF1Y", 750)], SAST("2026-11-04T07:00:00"));
  assert.equal(await node(db, `card_batches/concrete/${F1Y}`), null, "no record is ever written for it");
  assert.equal(got.results[F1Y].outcome, "ignored");
  const rec = await node(db, `card_batches/concrete/${F2Y}/${got.results[F2Y].key}`);
  assert.equal(rec.slip.totalCents, 75000);
  assert.deepEqual(rec.portal.foldedFrom, { tid: "0000OF1Y", txns: 1, cents: 75000 });
  assert.ok(rec.warnings.some((w) => /not in use/.test(w)));
});

test("a machine not in use with no foldInto: its money is unattributed, never silently nothing", async () => {
  const db = makeFakeDb({
    config: { cardTerminals: { [F1Y]: { ...TERMINALS[F1Y], source: "inactive" }, [F2Y]: TERMINALS[F2Y] } },
    users: { [POLLER.uid]: { permFlags: { card_recon: true, card_recon_intake: true } } },
    card_batches: {}, pos: { paymentEvents: {} },
  });
  const got = await concreteDay(db, [row("2026-11-03T15:01:00", "0000OF1Y", 750)], SAST("2026-11-04T07:00:00"));
  assert.deepEqual(got.unattributed, { txns: 1, cents: 75000 });
});

test("foldInto only ever reaches a portal machine in the same store", () => {
  assert.equal(P.foldTargetOf(F2Y, { [F2Y]: { ...TERMINALS[F2Y], source: "portal" } }), F2Y);
  const reg = { A: { source: "inactive", foldInto: HP1X, storeId: "concrete" }, [HP1X]: TERMINALS[HP1X] };
  assert.equal(P.foldTargetOf("A", reg), null);
});
