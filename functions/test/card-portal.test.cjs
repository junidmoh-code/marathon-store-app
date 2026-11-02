// ─── THE SIMPLYBLU PORTAL IS THE RECORD FOR STANDARD BANK TILLS ──────────────
// Junid, 2 Nov 2026 (lib/card-portal.cjs). The rows below have the portal's
// REAL column layout (Monthly Card POS - Terminal Batch Report → Card POS
// Transactions, read 2 Nov 2026); every value in them is invented.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const P = require("../lib/card-portal.cjs");
const { handlePortalDay } = require("../cardRecon/cardPortal.js");
const { handleSlip } = require("../cardRecon/cardRecon.js");
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
  [F2Y]: { storeId: "concrete", tillId: "till-1", label: "Concrete Till 1", mid: "0005377331", capture: "typed", ...sb, activeFrom: SAST("2026-10-30T00:00:00") },
  [F1Y]: { storeId: "concrete", tillId: "till-2", label: "Concrete Till 2", mid: "0005377331", capture: "typed", ...sb, activeFrom: SAST("2026-10-30T00:00:00") },
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
  assert.deepEqual(P.daysToPull("2026-11-03"), ["2026-11-03"]);
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

// ── the ingest ───────────────────────────────────────────────────────────────

test("a day that agrees with the till: the terminal's next batch, clean; a re-pull writes nothing", async () => {
  const db = world({ events: { a: card("pe", "till-2", "2026-11-03T10:01:30", 93000), b: card("pe", "till-2", "2026-11-03T11:15:40", 35000) } });
  const rows = [row("2026-11-03T10:01:00", HP1X, 930), row("2026-11-03T11:15:00", HP1X, 350)];
  const out = await pull(db, rows);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.results[HP1X].outcome, "recorded");
  assert.equal(out.results[HP1X].key, "561");
  const rec = await node(db, `card_batches/pe/${HP1X}/561`);
  assert.equal(rec.capturedVia, "simplyblu-portal");
  assert.equal(rec.slip.totalCents, 128000);
  assert.equal(rec.slip.windowSource, "portal-day");
  assert.equal(rec.varianceCents, 0);
  assert.equal(rec.reconciledBy, "totals");
  assert.equal(rec.linesCaptured, true);
  assert.equal(rec.portal.merchantNo, "0004977890");
  // 18:20's catch-up: the same rows, nothing written.
  const again = await pull(db, rows, { now: NOW + 20 * 60000 });
  assert.equal(again.results[HP1X].outcome, "unchanged");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/561-r2`), null);
});

test("a transaction the portal showed late: a revision of the day, never a second card", async () => {
  const db = world();
  await pull(db, [row("2026-11-03T10:01:00", HP1X, 930)]);
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930, { id: "id-x" }), row("2026-11-03T16:40:00", HP1X, 200)], { now: NOW + 86400000 });
  assert.equal(out.results[HP1X].key, "561-r2");
  const r2 = await node(db, `card_batches/pe/${HP1X}/561-r2`);
  assert.equal(r2.supersedes, "561");
  assert.equal(r2.slip.totalCents, 113000);
});

test("ZERO transactions on a linked machine while the till took card: recorded R0.00 — a SHORT, never clean", async () => {
  const db = world({ events: { a: card("trophy", "till-2", "2026-11-03T12:00:00", 50000) } });
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930)]);
  assert.equal(out.results[Z4M6].outcome, "recorded");
  const rec = await node(db, `card_batches/trophy/${Z4M6}/${out.results[Z4M6].key}`);
  assert.equal(rec.slip.totalCents, 0);
  assert.equal(rec.slip.txnCount, 0);
  assert.equal(rec.expected.cardCents, 50000);
  assert.equal(rec.varianceCents, -50000);
  assert.ok(rec.warnings.some((w) => /NO card transactions/.test(w)));
});

test("a machine the portal does not list (Concrete, not linked yet) gets NO record — awaiting portal data", async () => {
  const db = world({ events: { a: card("concrete", "till-1", "2026-11-03T12:00:00", 50000) } });
  const out = await pull(db, [row("2026-11-03T10:01:00", HP1X, 930)]);
  assert.equal(out.results[F2Y].outcome, "awaiting");
  assert.equal(out.results[F1Y].outcome, "awaiting");
  assert.equal(await node(db, "card_batches/concrete"), null);
  const st = await node(db, "card_batch_overrides/portal/status");
  assert.deepEqual(st.awaiting.sort(), [F1Y, F2Y].sort());
});

test("when Concrete's merchant appears, its machines are picked up by their O/0 spelling — nothing registered", async () => {
  const db = world();
  const out = handlePortalDay(db, { auth: POLLER, data: { dayYmd: DAY, sources: [
    { business: { name: "THE MARATHON", merchantNo: "0004977890" }, tids: [HP1X, Z4M6], cols: COLS, rows: [] },
    { business: { name: "MARATHON CONCRETE", merchantNo: "0005377331" }, tids: ["0000OF2Y", "0000OF1Y"], cols: COLS, rows: [row("2026-11-03T09:00:00", "0000OF2Y", 500)] },
  ] } }, { now: () => NOW });
  const r = await out;
  assert.equal(r.results[F2Y].outcome, "recorded");
  const rec = await node(db, `card_batches/concrete/${F2Y}/1`);
  assert.equal(rec.slip.totalCents, 50000);
  assert.equal(rec.portal.merchantNo, "0005377331");
  assert.equal((await node(db, `card_batches/concrete/${F1Y}/1`)).slip.totalCents, 0);
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

test("a portal layout the parser cannot read: its machines are awaiting, never recorded as zero", async () => {
  const db = world();
  const out = await pull(db, [], { cols: COLS.filter((c) => c !== "TransactionStatus") });
  assert.equal(out.results[HP1X].outcome, "awaiting");
  assert.equal(await node(db, `card_batches/pe/${HP1X}/561`), null);
  assert.equal(out.sources[0].ok, false);
});

test("before 3 Nov, nothing is recorded from the portal", async () => {
  const out = await pull(world(), [], { day: "2026-11-02" });
  assert.equal(out.ok, false);
});

// ── the staff slip beside the portal ─────────────────────────────────────────

test("a staff slip BEFORE the portal pull is held, and the portal record carries it", async () => {
  const db = world({ extra: { network: { trophy: { tills: { "till-2": { label: "Till 2" } } } } } });
  const sent = await handleSlip(db, { auth: AMANDA, data: { action: "slip", pickedTid: Z4M6, photos: [PHOTO], declaredTotal: "500.00" } },
    { now: () => SAST("2026-11-03T16:55:00"), bucket: bucket() });
  assert.equal(sent.ok, true, sent.reason);
  assert.equal(await node(db, `card_batches/trophy/${Z4M6}`), null, "the slip is not the record");
  const held = await node(db, `card_batch_overrides/portal/held/trophy/${Z4M6}/${DAY}`);
  assert.equal(Object.values(held)[0].cents, 50000);
  const out = await pull(db, [row("2026-11-03T15:00:00", Z4M6, 500)]);
  const rec = await node(db, `card_batches/trophy/${Z4M6}/${out.results[Z4M6].key}`);
  assert.equal(rec.slip.totalCents, 50000);
  const sup = Object.values(rec.supportingSlips);
  assert.equal(sup.length, 1);
  assert.equal(sup[0].cents, 50000);
  assert.equal(Object.values(await node(db, `card_batch_overrides/portal/held/trophy/${Z4M6}/${DAY}`))[0].takenInto, out.results[Z4M6].key);
  const log = await node(db, `card_batch_overrides/staff_slips/trophy/${Z4M6}/${DAY}`);
  assert.equal(Object.values(log)[0].kind, "held");
});

test("a staff slip AFTER the portal record is attached to it, never a second record", async () => {
  const db = world({ extra: { network: { trophy: { tills: { "till-2": { label: "Till 2" } } } } } });
  const out = await pull(db, [row("2026-11-03T15:00:00", Z4M6, 500)], { now: SAST("2026-11-03T18:00:00") });
  const key = out.results[Z4M6].key;
  const sent = await handleSlip(db, { auth: AMANDA, data: { action: "slip", pickedTid: Z4M6, photos: [PHOTO], declaredTotal: "500.00" } },
    { now: () => SAST("2026-11-03T18:30:00"), bucket: bucket() });
  assert.equal(sent.ok, true, sent.reason);
  const recs = await node(db, `card_batches/trophy/${Z4M6}`);
  assert.deepEqual(Object.keys(recs), [key]);
  assert.equal(Object.values(recs[key].supportingSlips)[0].cents, 50000);
});

test("a record already on file for the day (a staff slip recorded before this shipped) is REPLACED as a revision of its batch", async () => {
  const staff = { batchKey: "510", batchNo: 510, revision: 1, capturedVia: "typed", tid: Z4M6, storeId: "trophy", tillId: "till-2",
    declaredTotal: { cents: 40000, via: "staff-slip", byUid: "u-amanda", byEmail: "amanda@marathon.internal", at: SAST("2026-11-03T16:00:00") },
    photos: ["cardRecon/x/photo-0.jpg"],
    slip: { openedAt: SAST("2026-11-02T18:50:00"), closedAt: SAST("2026-11-03T18:50:00"), totalCents: 40000, format: "typed", windowSource: "typed-span" } };
  const db = world({ batches: { trophy: { [Z4M6]: { 510: staff } } } });
  const out = await pull(db, [row("2026-11-03T15:00:00", Z4M6, 500)]);
  assert.equal(out.results[Z4M6].key, "510-r2");
  const rec = await node(db, `card_batches/trophy/${Z4M6}/510-r2`);
  assert.equal(rec.supersedes, "510");
  assert.equal(rec.capturedVia, "simplyblu-portal");
  assert.equal(rec.supportingSlips["rec-510"].cents, 40000);
  assert.equal((await node(db, `card_batches/trophy/${Z4M6}/510`)).slip.totalCents, 40000, "kept unchanged");
});

test("Junid's manual entry is refused for a day the portal already recorded (correction still allowed)", async () => {
  const db = world();
  await pull(db, [row("2026-11-03T10:01:00", HP1X, 930)]);
  const out = await handleManualEntry(db, { auth: JUNID, data: { tid: HP1X, dayYmd: DAY, total: "930.00", batchNo: "562" } }, { now: () => NOW + 3600000 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /SimplyBLU portal is already the record/);
});
