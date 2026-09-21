// ─── THE PHOTO PATH'S TID, AND A READER THAT IS OVERLOADED ───────────────────
// Since 18 Sept 2026 photo capture failed on the two terminals with
// ALPHANUMERIC TIDs — Marathon Till 2 (0000HP1X) and Trophy Till 2 (0000Z4M6).
// What the investigation found (21 Sept):
//
//   • Trophy Till 2: every attempt in the log is Gemini answering 503 "high
//     demand". The account was funded. Nothing to do with the TID.
//   • Marathon Till 2: ONE billed call (20 Sept 14:22 UTC) came back with no
//     usable TID, and nothing recorded what the model had said. Re-run against
//     three real HP1X slips from storage, the live prompt read "0000HP1X" at
//     0.99 every time it got through.
//
// So this file pins: the real model response for an HP1X slip extracts; an
// alphanumeric and a numeric TID both extract; the shapes a model may return
// around the ID ("TID:" label, a space) still read; O/0 confusion confirms the
// pick and never routes elsewhere; and a 503 is retried, then falls back, then
// names itself.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  toExtraction, runSlipOcr, OCR_MODEL, OCR_FALLBACK_MODEL, EXTRACTION_PROMPT,
} = require("../cardRecon/cardRecon.js");
const { validateExtraction, readSlipTid, slipTidMatchesPicked } = require("../lib/card-recon.cjs");

// THE REAL RESPONSE: gemini-3.6-flash, the live prompt, a real photo of
// Marathon Till 2's batch #509 summary slip (captured 10 Sept, from storage).
const REAL_HP1X = require(path.join(__dirname, "fixtures/ocr-response-0000HP1X-batch509.json"));
// The same slip format for the other two shapes. No numeric-TID terminal has
// ever been photo-captured and no Trophy Till 2 capture ever reached the model,
// so these are the real response with only the TID changed — the format is the
// same FNB summary slip on every terminal.
const withTid = (tid) => ({ ...REAL_HP1X, tid });

const REGISTERED = ["67325636", "67364485", "67365901", "67377843", "0000HP1X", "0000Z4M6"];

test("the real HP1X model response extracts TID 0000HP1X and validates", () => {
  const ex = toExtraction(REAL_HP1X);
  assert.equal(ex.tid, "0000HP1X");
  assert.equal(ex.batchNo, "509");
  assert.equal(ex.totalCents, 2125000);
  const v = validateExtraction({ ...ex, lines: [] }, { summaryOnly: true });
  assert.equal(v.ok, true, v.reason);
});

test("an alphanumeric TID and a numeric TID both extract exactly", () => {
  assert.equal(toExtraction(withTid("0000Z4M6")).tid, "0000Z4M6");
  assert.equal(toExtraction(withTid("0000HP1X")).tid, "0000HP1X");
  assert.equal(toExtraction(withTid("67377843")).tid, "67377843");
  for (const tid of ["0000Z4M6", "67377843"]) {
    const v = validateExtraction({ ...toExtraction(withTid(tid)), lines: [] }, { summaryOnly: true });
    assert.equal(v.ok, true, `${tid}: ${v.reason}`);
  }
});

test("the TID still reads when the model hands back the label or a space", () => {
  for (const [raw, want] of [
    ["TID:0000HP1X", "0000HP1X"], ["TID: 0000Z4M6", "0000Z4M6"], ["tid 0000hp1x", "0000HP1X"],
    ["0000 HP1X", "0000HP1X"], ["0000-Z4M6", "0000Z4M6"], ["Terminal ID: 67377843", "67377843"],
    [" 67365901 ", "67365901"],
  ]) assert.equal(readSlipTid(raw), want, raw);
  for (const raw of ["", "TID:", "   ", null, undefined, 67377843, "TID:0000HP1X!", "no spaces!"]) {
    assert.equal(readSlipTid(raw), null, String(raw));
  }
});

test("O/0 and I/1 confirm the PICKED till, and never route anywhere else", () => {
  assert.equal(slipTidMatchesPicked("OOOOHP1X", "0000HP1X", REGISTERED), true);
  assert.equal(slipTidMatchesPicked("0000HPIX", "0000HP1X", REGISTERED), true);
  assert.equal(slipTidMatchesPicked("OOOOZ4M6", "0000Z4M6", REGISTERED), true);
  assert.equal(slipTidMatchesPicked("0000Z4M6", "0000HP1X", REGISTERED), false, "another real TID is another till");
  assert.equal(slipTidMatchesPicked("67377843", "67365901", REGISTERED), false);
  // If a second registered terminal folds to the same characters, the
  // tolerance stands down and only the exact reading counts.
  assert.equal(slipTidMatchesPicked("OOOOHP1X", "0000HP1X", [...REGISTERED, "OOOOHP1X"]), false);
});

test("the prompt's example TID is made up — no live terminal is named in it", () => {
  for (const tid of REGISTERED) assert.ok(!EXTRACTION_PROMPT.includes(tid), `${tid} is in the prompt`);
  assert.match(EXTRACTION_PROMPT, /letters AND digits/);
});

// ── A 503 IS RETRIED, THEN FALLS BACK, THEN NAMES ITSELF ─────────────────────
const okBody = { candidates: [{ content: { parts: [{ text: JSON.stringify(REAL_HP1X) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
function fakeFetch(statuses) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const status = statuses[calls.length - 1] ?? 200;
    return { ok: status === 200, status, json: async () => okBody, text: async () => `{"error":{"code":${status}}}` };
  };
  return { fn, calls };
}
const noSleep = async () => {};

test("503 twice then 200: answered by the primary model on the 3rd attempt", async () => {
  const f = fakeFetch([503, 503, 200]);
  const out = await runSlipOcr([{ base64: "AA==" }], "k", { fetch: f.fn, sleep: noSleep });
  assert.equal(out.model, OCR_MODEL);
  assert.equal(out.attempts, 3);
  assert.equal(out.parsed.tid, "0000HP1X");
});

test("503 on every primary attempt: ONE attempt on the fallback model answers", async () => {
  const f = fakeFetch([503, 503, 503, 503, 200]);
  const out = await runSlipOcr([{ base64: "AA==" }], "k", { fetch: f.fn, sleep: noSleep });
  assert.equal(out.model, OCR_FALLBACK_MODEL);
  assert.equal(out.attempts, 5);
  assert.ok(f.calls.slice(0, 4).every((u) => u.includes(OCR_MODEL)));
  assert.ok(f.calls[4].includes(OCR_FALLBACK_MODEL));
});

test("503 everywhere: the error keeps its status so the callable can name it", async () => {
  const f = fakeFetch([503, 503, 503, 503, 503]);
  await assert.rejects(
    runSlipOcr([{ base64: "AA==" }], "k", { fetch: f.fn, sleep: noSleep }),
    (err) => err.httpStatus === 503 && err.attempts === 5,
  );
  assert.equal(f.calls.length, 5);
});

test("402 (no credit) is NOT retried — asking twice does not top up the account", async () => {
  const f = fakeFetch([402]);
  await assert.rejects(runSlipOcr([{ base64: "AA==" }], "k", { fetch: f.fn, sleep: noSleep }), (err) => err.httpStatus === 402);
  assert.equal(f.calls.length, 1);
});

test("no attempt starts that could not finish inside the callable's timeout", async () => {
  // A clock that jumps 100 s per call: after the first attempt, starting a
  // second would overrun the 270 s budget with a 120 s timeout in hand.
  let t = 0;
  const f = fakeFetch([503, 503, 503, 503, 200]);
  await assert.rejects(
    runSlipOcr([{ base64: "AA==" }], "k", { fetch: f.fn, sleep: noSleep, now: () => (t += 100000) }),
    (err) => err.httpStatus === 503 && err.attempts < 5,
  );
  assert.ok(f.calls.length < 5);
});

test("an Email-only terminal is refused BEFORE any OCR is paid for", () => {
  const src = require("node:fs").readFileSync(path.join(__dirname, "../cardRecon/cardRecon.js"), "utf8");
  const body = src.slice(src.indexOf("async function handleExtract("), src.indexOf("async function handleExtractPdf("));
  const gate = body.indexOf("if (!takesPhoto(terminal))");
  assert.ok(gate > 0, "the capture-mode gate is in the photo path");
  assert.ok(gate < body.indexOf("runSlipOcr("), "…and comes before the paid call");
});

test("the photo-read log line carries the header and NOTHING from the transaction roll", () => {
  const { photoReadLogLine, refusalLogLine } = require("../cardRecon/cardRecon.js");
  // The real HP1X response, plus a transaction line carrying card data that
  // must never reach Cloud Logging.
  const parsed = { ...REAL_HP1X, transactions: [{ date: "2026/09/10", time: "10:00:00", uti: "UTI-SECRET-1",
    rrn: "RRN-SECRET-2", authCode: "AUTH-SECRET-3", tsn: 7, pan: "518103******4436", amount: "R900.00", type: "purchase" }] };
  const line = photoReadLogLine("0000HP1X", { parsed, model: OCR_MODEL, attempts: 3 });
  assert.match(line, /^cardBatchCapture: photo read picked=0000HP1X model=gemini-3\.6-flash attempts=3 /);
  const header = JSON.parse(line.slice(line.indexOf("{")));
  assert.equal(header.tid, "0000HP1X");
  assert.equal(header.batchNo, "509");
  assert.equal(header.total, "R21,250.00");
  assert.equal(header.confidence.tid, 0.99);
  for (const secret of ["UTI-SECRET-1", "RRN-SECRET-2", "AUTH-SECRET-3", "518103", "4436", "transactions", "R900.00"]) {
    assert.ok(!line.includes(secret), `${secret} leaked into the log`);
  }
  assert.equal(refusalLogLine("0000Z4M6", "Could not read the slip's TOTAL confidently — retake that photo in better light."),
    'cardBatchCapture: extract refused picked=0000Z4M6 reason="Could not read the slip\'s TOTAL confidently — retake that photo in better light."');
});

test("the callable logs both lines on the extract path", () => {
  const src = require("node:fs").readFileSync(path.join(__dirname, "../cardRecon/cardRecon.js"), "utf8");
  const extract = src.slice(src.indexOf("async function handleExtract("), src.indexOf("async function handleExtractPdf("));
  assert.ok(extract.indexOf("console.log(photoReadLogLine(") > extract.indexOf("toExtraction(ocr.parsed)"));
  assert.match(src, /if \(out && out\.ok === false\) \{\s*console\.warn\(refusalLogLine\(/);
});
