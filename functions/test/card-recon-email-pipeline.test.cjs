// ─── THE EMAIL CHANNEL, END TO END: extract → draft → submit → record ───────
// The pure path is pinned by the corpus and the unit tests; these push real
// files through the callable's own extract and submit, on a fake RTDB that
// drops nulls and empty arrays the way the real one does — which is exactly
// what a totals-only draft (txnCount null, lines []) must survive.
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = "127.0.0.1:9";

const nodeTest = require("node:test");
// THE REAL REPORTS LIVE ON THE MAC MINI ONLY (gitignored — the repo is public
// and they print card numbers). Everywhere else these tests skip, by name.
const HAVE_REAL = require("node:fs").existsSync(require("node:path").join(__dirname, "fixtures", "card-recon-real"));
const SKIP_WHY = "real FNB reports are kept on the Mac mini only (functions/test/fixtures/card-recon-real/ is gitignored)";
const test = (name, fn) => nodeTest.test(name, { skip: HAVE_REAL ? false : SKIP_WHY }, fn);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { makeSlipPdfPaged } = require("./fixtures/makeSlipPdf.cjs");
const { parseSlipPdf } = require("../lib/card-recon-pdf.cjs");
const { handleExtract, handleSubmit } = require("../cardRecon/cardRecon.js");

const REAL = path.join(__dirname, "fixtures", "card-recon-real");
const realPdf = (n) => fs.readFileSync(path.join(REAL, `${n}.pdf`));
const realLines = (n) => require(path.join(REAL, `${n}.lines.json`));
// The poller's identity, as the owner for brevity: both permission checks
// short-circuit on it, and neither is what these tests are about.
const POLLER = { uid: "card-recon-email-poller", token: { email: "gunidmoh@gmail.com" } };
const TERMINALS = {
  "67377843": { label: "Marathon Till 1", storeId: "trophy", tillId: "till-1" },
  "67325636": { label: "Trophy Till 1", storeId: "pe", tillId: "till-1" },
  "67365901": { label: "Marathon Till 3", storeId: "pe", tillId: "till-3" },
};
const bucket = () => ({ saved: [], file(p) { const self = this; return { save: async () => { self.saved.push(p); } }; } });

async function viaEmail(db, pdfBytes, n = 1) {
  const extract = await handleExtract(db, {
    auth: POLLER,
    data: { action: "extract", channel: "email", pdf: { base64: pdfBytes.toString("base64") },
      intake: { messageId: `<test-${n}@fnb>`, from: "FNB", subject: "Banking Report", filename: "FNB-Txn-Notification.pdf", receivedAt: 1 } },
  }, { bucket: bucket() });
  if (!extract.ok) return { extract };
  const submit = await handleSubmit(db, { auth: POLLER, data: { action: "submit", draftId: extract.draftId } });
  return { extract, submit };
}

test("an Items-less report is recorded TOTALS ONLY through the real extract and submit", async () => {
  const db = makeFakeDb({ config: { cardTerminals: TERMINALS } });
  const lines = realLines("20261013-67377843-b44-accepted-m527").filter((l) => l !== "Items: 5");
  const { extract, submit } = await viaEmail(db, makeSlipPdfPaged(lines, { perPage: 50 }));
  assert.equal(extract.ok, true, extract.reason);
  assert.equal(extract.review.summaryOnly, true);
  assert.equal(submit.ok, true, submit.reason);
  assert.equal(submit.linesCaptured, false);
  const rec = (await db.ref("card_batches/trophy/67377843/44").once("value")).val();
  assert.equal(rec.linesCaptured, false);
  assert.equal(rec.slip.totalCents, 270000);
  assert.equal(rec.slip.txnCount ?? null, null, "no count was invented");
  assert.equal(rec.capturedVia, "pdf");
  assert.ok(rec.warnings.some((w) => /^Totals only — the transaction list could not be read/.test(w)));
});

test("Trophy Till 1 batch 69's 15 Oct report supersedes the recorded 5 Oct capture, with the long-batch warning", async () => {
  // What is on file: batch 69 as first recorded (the 5 Oct report's lines).
  const day1 = parseSlipPdf(realLines("20261005-67325636-b69-accepted-batch69-day1-m414")).extraction;
  const recorded = Object.fromEntries(day1.lines.map((l) => [String(l.tsn), { tsn: l.tsn, amountCents: l.amountCents, rrn: l.rrn }]));
  const db = makeFakeDb({
    config: { cardTerminals: TERMINALS },
    card_batches: { pe: { 67325636: { 69: { batchKey: "69", batchNo: 69, lines: recorded, slip: { totalCents: day1.totalCents, windowSource: "transactions-to-print" } } } } },
  });
  const { extract, submit } = await viaEmail(db, realPdf("20261015-67325636-b69-refused-long-batch-m560"));
  assert.equal(extract.ok, true, extract.reason);
  assert.ok(extract.review.warnings.includes("This batch ran 11 days — the terminal was not closed daily."));
  assert.equal(submit.ok, true, submit.reason);
  assert.equal(submit.batchKey, "69-r2");
  const rec = (await db.ref("card_batches/pe/67325636/69-r2").once("value")).val();
  assert.equal(rec.autoSuperseded, true);
  assert.equal(rec.supersedes, "69");
  assert.equal(rec.lineCount, 64);
  assert.equal(rec.slip.totalCents, 5411800);
});

test("Marathon Till 3 batch 91 (failed attempt only) records as an empty R0.00 batch", async () => {
  const db = makeFakeDb({ config: { cardTerminals: TERMINALS } });
  const { extract, submit } = await viaEmail(db, realPdf("20261013-67365901-b91-refused-empty-with-failed-attempt-m528"));
  assert.equal(extract.ok, true, extract.reason);
  assert.equal(submit.ok, true, submit.reason);
  const rec = (await db.ref("card_batches/pe/67365901/91").once("value")).val();
  assert.equal(rec.slip.totalCents, 0);
  assert.equal(rec.slip.windowSource, "empty-batch");
  assert.ok(rec.warnings.some((w) => /1 failed attempt/.test(w)));
  // …and the same report again is a re-send, refused as one.
  const again = await viaEmail(db, realPdf("20261013-67365901-b91-refused-empty-with-failed-attempt-m537"), 2);
  assert.equal(again.extract.ok, false);
  assert.match(again.extract.reason, /already captured/);
});

test("a Banking Done notice is refused in words the poller files as unrelated, and nothing is written", async () => {
  const db = makeFakeDb({ config: { cardTerminals: TERMINALS } });
  const { extract } = await viaEmail(db, realPdf("20261014-67365901-b92-refused-banking-done-m553"));
  assert.equal(extract.ok, false);
  assert.match(extract.reason, /"Banking Done" notice for batch 92/);
  assert.equal((await db.ref("card_batches").once("value")).val(), null);
});
