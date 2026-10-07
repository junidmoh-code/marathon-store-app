// ─── A TYPED-TOTAL MACHINE: ONE FIGURE, NO PAPER ─────────────────────────────
// Trophy Till 2 (TID 0000Z4M6) cannot email its report and its printer leaves
// the total off the paper, so there is nothing to photograph and nothing to
// read (Junid, 1 Oct 2026). Its capture is a typed figure and that is all.
//
// WHAT THESE PIN is not that the path is permissive — it is that it invents
// LESS than the path it replaces. anchorDeclaredWindow had to guess which day a
// bare clock time belonged to; when it guessed wrong the till's card money fell
// outside its own batch window and was reported twice, once as a slip with no
// money and once as money with no slip. Here both ends of the window are real
// instants, and the things that genuinely cannot be known are refused or named
// rather than filled in.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planTypedCapture, validateExtraction, MAX_WINDOW_MS } = require("../lib/card-recon.cjs");
const { captureMode, takesPhoto, typesTotal } = require("../lib/card-terminals.cjs");

const TID = "0000Z4M6";
const DAY = 24 * 60 * 60 * 1000;
// 1 Oct 2026, 17:30 SAST.
const NOW = Date.parse("2026-10-01T17:30:00+02:00");
const YESTERDAY_CLOSE = Date.parse("2026-09-30T16:45:00+02:00");

const plan = (over = {}) => planTypedCapture({
  tid: TID, totalText: "2250.00", nowMs: NOW,
  lastBatchNo: 486, lastClosedAt: YESTERDAY_CLOSE, lastWasTyped: true, ...over,
});

// ── the registry setting ─────────────────────────────────────────────────────

test("a typed machine takes no photograph, and nothing else types", () => {
  assert.equal(captureMode({ capture: "typed" }), "typed");
  assert.equal(takesPhoto({ capture: "typed" }), false);
  assert.equal(typesTotal({ capture: "typed" }), true);
  for (const capture of ["email", "photo", "both", undefined]) {
    assert.equal(typesTotal({ capture }), false, String(capture));
  }
});

// ── the number ───────────────────────────────────────────────────────────────

test("the batch number is the next after this terminal's highest", () => {
  const out = plan({ lastWasTyped: false });
  assert.equal(out.ok, true);
  assert.equal(out.batchNo, 487);
  assert.equal(out.extraction.batchNo, "487");
});

test("the first batch on a machine with no history is #1, and says so", () => {
  const out = plan({ lastBatchNo: null, lastClosedAt: null, lastWasTyped: false });
  assert.equal(out.ok, true);
  assert.equal(out.batchNo, 1);
  assert.match(out.warnings.join(" "), /first batch recorded for this machine/);
});

// ── the window ───────────────────────────────────────────────────────────────

test("the window runs from the previous settlement to NOW — both real instants", () => {
  const out = plan({ lastWasTyped: false });
  assert.equal(out.extraction.openedAt, YESTERDAY_CLOSE);
  assert.equal(out.extraction.closedAt, NOW);
  assert.equal(out.extraction.windowSource, "typed-span");
  // THE POINT OF THE WHOLE CHANGE: not a guessed day. A reader can tell this
  // window apart from the one anchorDeclaredWindow invents.
  assert.notEqual(out.extraction.windowSource, "declared-fallback");
});

test("with no previous settlement the window is the last 24 hours, named as such", () => {
  const out = plan({ lastBatchNo: null, lastClosedAt: null, lastWasTyped: false });
  assert.equal(out.extraction.openedAt, NOW - DAY);
  assert.equal(out.extraction.windowSource, "typed-fallback");
});

test("a settlement more than 7 days back is CLAMPED and said out loud, never refused", () => {
  // The figure in front of the manager is real; refusing it would lose it. But
  // the period it is compared against is not trustworthy, so the record says so.
  const out = plan({ lastClosedAt: NOW - 30 * DAY, lastWasTyped: false });
  assert.equal(out.ok, true);
  assert.equal(out.extraction.openedAt, NOW - MAX_WINDOW_MS);
  assert.equal(out.extraction.windowSource, "typed-clamped");
  assert.match(out.warnings.join(" "), /more than 7 days ago/);
  // …and it still passes the 7-day window cap it was clamped to.
  assert.equal(validateExtraction(out.extraction, { summaryOnly: true, source: "typed", declaredTotal: true }).ok, true);
});

test("a prior close in the FUTURE is not used as a window start", () => {
  // A clock that ran ahead, or a hand-edited record. Falls back rather than
  // producing a window that ends before it begins.
  const out = plan({ lastClosedAt: NOW + DAY, lastWasTyped: false });
  assert.equal(out.extraction.openedAt, NOW - DAY);
  assert.equal(out.extraction.closedAt, NOW);
  assert.ok(out.extraction.closedAt > out.extraction.openedAt);
});

// ── double entry ─────────────────────────────────────────────────────────────

test("a second typed total on the same SA day is refused, with the way out", () => {
  // The batch number cannot catch this the way it catches a re-sent email —
  // every typed entry gets a fresh number by construction — so the DAY is the
  // guard. Without it, tapping twice records the evening's takings twice.
  const out = plan({ lastClosedAt: Date.parse("2026-10-01T16:45:00+02:00") });
  assert.equal(out.ok, false);
  assert.match(out.reason, /already been typed in today/);
  assert.match(out.reason, /replacement/);
});

test("the same day's entry CAN be replaced, and reuses the number so it supersedes", () => {
  const sameDay = Date.parse("2026-10-01T16:45:00+02:00");
  const out = plan({ lastClosedAt: sameDay, correction: true });
  assert.equal(out.ok, true);
  // The SAME number: resolveBatchWrite then lands it as 486-r2, a revision of
  // the record it replaces, rather than a second batch of its own.
  assert.equal(out.batchNo, 486);
  // A replacement covers the same trading period, so it does not start at the
  // close of the entry it is replacing — that would cover no trading at all.
  assert.ok(out.extraction.openedAt < sameDay);
});

test("a replacement with nothing to replace is refused", () => {
  const out = plan({ correction: true });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no typed total for this machine today/i);
});

test("yesterday's typed entry does not block today's", () => {
  assert.equal(plan().ok, true);
});

test("a PHOTOGRAPHED batch yesterday does not count as a typed entry", () => {
  // The day guard asks about typed entries only: a machine switched to typed
  // entry today must not be blocked by the slip that was photographed for it.
  const out = plan({ lastClosedAt: Date.parse("2026-10-01T16:45:00+02:00"), lastWasTyped: false });
  assert.equal(out.ok, true);
  assert.equal(out.batchNo, 487);
});

// ── the figure ───────────────────────────────────────────────────────────────

test("the typed figure goes through the slip's own strict parser", () => {
  assert.equal(plan({ totalText: "2,250.00" }).extraction.totalCents, 225000);
  assert.equal(plan({ totalText: "R 2 250,00" }).ok, false);
  assert.match(plan({ totalText: "two thousand" }).reason, /is not an amount/);
  assert.match(plan({ totalText: "-5.00" }).reason, /cannot be negative/);
  assert.match(plan({ totalText: "99999999.00" }).reason, /more than any terminal takes/);
  assert.match(plan({ totalText: 2250 }).reason, /did not arrive as text/);
});

test("R0.00 is a real answer — a till that took no card still reports", () => {
  const out = plan({ totalText: "0.00", lastWasTyped: false });
  assert.equal(out.ok, true);
  assert.equal(out.extraction.totalCents, 0);
});

// ── what the record claims about itself ──────────────────────────────────────

test("nothing that was never read is recorded as zero", () => {
  // A figure nobody saw is null. Zero would be a claim that a slip printed a
  // zero, and this capture never saw a slip at all.
  const { extraction } = plan({ lastWasTyped: false });
  for (const f of ["txnCount", "purchasesCents", "cashCents", "refundsCents", "mid", "reconLine", "confidence"]) {
    assert.equal(extraction[f], null, f);
  }
  assert.deepEqual(extraction.lines, []);
  assert.equal(extraction.format, "typed");
});

test("the extraction passes validation as a typed, summary-only, declared capture", () => {
  const { extraction } = plan({ lastWasTyped: false });
  const v = validateExtraction(extraction, { summaryOnly: true, source: "typed", declaredTotal: true });
  assert.equal(v.ok, true, v.reason);
  assert.match(v.warnings.join(" "), /Summary only/);
});

test("a typed extraction is NOT accepted as a photo capture", () => {
  // The confidence gate is skipped only for a source that has no OCR behind it.
  // Called as a photo, this extraction has no confidence and must be refused —
  // so the exemption cannot be reached by mislabelling the source.
  const { extraction } = plan({ lastWasTyped: false });
  const v = validateExtraction(extraction, { summaryOnly: true, source: "photo", declaredTotal: true });
  assert.equal(v.ok, false);
});

test("a bad terminal id or clock is refused rather than filed somewhere", () => {
  assert.match(plan({ tid: "" }).reason, /does not look like a terminal ID/);
  assert.match(plan({ nowMs: NaN }).reason, /server clock/);
});

// ── review fixes (PR #527) ───────────────────────────────────────────────────

test("a replacement covers EXACTLY the period of the entry it replaces", () => {
  // Not "the last 24 hours": when the replaced entry's window started three
  // days back, a 24-hour replacement would drop two days of card money out of
  // the comparison and read as a false shortfall.
  const replacedOpened = Date.parse("2026-09-28T16:00:00+02:00");
  const sameDay = Date.parse("2026-10-01T16:45:00+02:00");
  const out = plan({ lastOpenedAt: replacedOpened, lastClosedAt: sameDay, correction: true });
  assert.equal(out.ok, true);
  assert.equal(out.extraction.openedAt, replacedOpened);
  assert.equal(out.extraction.windowSource, "typed-span");
});

test("a typed draft survives RTDB deleting its nulls and empty arrays", () => {
  // The draft is written to RTDB and read back at submit. RTDB stores neither
  // null nor an empty array — so every never-read figure and `lines: []` come
  // back ABSENT. Submit must still validate and build the record from that.
  const { buildBatchRecord } = require("../lib/card-recon.cjs");
  const strip = (v) => {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) { const a = v.map(strip).filter((x) => x !== undefined); return a.length ? a : undefined; }
    if (typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) { const s = strip(x); if (s !== undefined) o[k] = s; }
      return Object.keys(o).length ? o : undefined;
    }
    return v;
  };
  const extraction = strip(plan({ lastWasTyped: false }).extraction);
  assert.equal("lines" in extraction, false, "the fake must reproduce RTDB dropping lines: []");
  assert.equal("txnCount" in extraction, false);
  // What handleSubmit does on read-back.
  if (!Array.isArray(extraction.lines)) extraction.lines = [];
  const v = validateExtraction(extraction, { summaryOnly: true, source: "typed", declaredTotal: true });
  assert.equal(v.ok, true, v.reason);
  const record = buildBatchRecord({
    extraction, terminal: { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2" }, tid: TID,
    match: null, reconciledByTotals: false, batchKey: "487", revision: 1, supersedes: null,
    autoSuperseded: false, photoPaths: undefined, summaryOnly: true, warnings: [],
    expected: { cardCents: 225000, cashiers: [] }, cashiers: [],
    submittedBy: { uid: "u1", email: null }, submittedAt: NOW, draftId: "d1", ocr: null,
    capturedVia: "typed", pdfPath: null, intake: null,
    declaredTotal: { cents: 225000, ocrReadCents: null, byUid: "u1", byEmail: null, at: NOW },
  });
  assert.equal(record.slip.totalCents, 225000);
  assert.equal(record.slip.format, "typed");
  assert.equal(record.slip.txnCount, null);
});

test("the typed action is the OWNER's alone again, at dispatch and at submit, and reads one terminal row", () => {
  // Junid, 7 Oct 2026: "Staff never type numbers. Manual entry is Junid-only."
  // That supersedes the 1 Oct opening of this path to every card_recon holder
  // (#658). A typed-only machine nobody types for is entered from the POS
  // report (cardBatchManualEntry).
  const src = require("node:fs").readFileSync(require.resolve("../cardRecon/cardRecon.js"), "utf8");
  const callable = src.slice(src.indexOf("exports.cardBatchCapture = onCall"));
  assert.ok(callable.indexOf("assertCardRecon(request)") < callable.indexOf('if (action === "typed")'));
  const action = src.slice(src.indexOf('if (action === "typed")'), src.indexOf('if (action === "submit")'));
  assert.ok(action.length > 0);
  // The gate comes BEFORE the registry is read or anything is typed in.
  assert.ok(action.indexOf("mayDeclareTotal(request.auth?.token)") > -1);
  assert.ok(action.indexOf("mayDeclareTotal(request.auth?.token)") < action.indexOf("normaliseTid("));
  assert.match(action, /db\.ref\(`\$\{CARD_TERMINALS_PATH\}\/\$\{picked\}`\)/);
  assert.doesNotMatch(action, /db\.ref\(CARD_TERMINALS_PATH\)/);
  const submit = src.slice(src.indexOf("const typedOnly = draft.typedOnly === true;"), src.indexOf("} else if (declaredTotal) {"));
  assert.match(submit, /mayDeclareTotal\(request\.auth\?\.token\)/, "a staff draft cannot be submitted either");
  // The registry still decides at submit.
  assert.match(submit, /typesTotal\(row\)/);
});

test("the last-batch read asks only for NUMERIC batch numbers", () => {
  // RTDB orders null < booleans < numbers < strings, so a record whose batchNo
  // is the string "12" sorts above every numeric one. An unbounded
  // limitToLast(2) would hand back two such records and hide the real highest
  // batch, and the typed path would mint a number already in use.
  //
  // Driven through the real function against a fake that RECORDS the query, so
  // what is asserted is the query actually sent — not a sentence about it.
  const { readLastBatchFor } = require("../cardRecon/cardRecon.js");
  const asked = {};
  const q = {
    orderByChild: (c) => { asked.orderBy = c; return q; },
    startAt: (v) => { asked.startAt = v; return q; },
    endAt: (v) => { asked.endAt = v; return q; },
    limitToLast: (n) => { asked.limitToLast = n; return q; },
    once: async () => ({ val: () => null }),
  };
  return readLastBatchFor({ ref: (p) => { asked.path = p; return q; } }, "trophy", TID).then(() => {
    assert.equal(asked.path, "card_batches/trophy/" + TID);
    assert.equal(asked.orderBy, "batchNo");
    assert.equal(asked.limitToLast, 2);
    // BOTH endpoints, and both numbers: endAt is the half that excludes
    // strings, startAt the half that excludes null and false.
    assert.equal(typeof asked.startAt, "number", "startAt must be a number or strings stay in range");
    assert.equal(typeof asked.endAt, "number", "endAt must be a number or strings stay in range");
    assert.ok(asked.startAt <= 1, "a terminal's first batch must be inside the range");
    assert.ok(asked.endAt >= Number.MAX_SAFE_INTEGER, "no real batch number may sit above the range");
  });
});

test("the highest batch is read from the rows, not assumed to be the last one", () => {
  // The query bounds WHICH rows come back; this picks among them. A revision
  // wears its batch's number, so two rows can share the highest — and the one
  // with the LATER close is the record in force.
  const { readLastBatchFor } = require("../cardRecon/cardRecon.js");
  const rows = {
    "486": { batchNo: 486, slip: { openedAt: 10, closedAt: 20, format: "typed" } },
    "487": { batchNo: 487, slip: { openedAt: 30, closedAt: 40, format: "typed" } },
    "487-r2": { batchNo: 487, slip: { openedAt: 30, closedAt: 55, format: "typed" } },
  };
  const q = { orderByChild: () => q, startAt: () => q, endAt: () => q, limitToLast: () => q,
              once: async () => ({ val: () => rows }) };
  return readLastBatchFor({ ref: () => q }, "trophy", TID).then((last) => {
    assert.equal(last.batchNo, 487);
    assert.equal(last.closedAt, 55, "the revision in force, not the first capture");
    assert.equal(last.openedAt, 30);
    assert.equal(last.typed, true);
  });
});

test("a terminal with nothing recorded reads as nothing, never as batch 0", () => {
  const { readLastBatchFor } = require("../cardRecon/cardRecon.js");
  const q = { orderByChild: () => q, startAt: () => q, endAt: () => q, limitToLast: () => q,
              once: async () => ({ val: () => null }) };
  return readLastBatchFor({ ref: () => q }, "trophy", TID).then((last) => {
    assert.deepEqual(last, { batchNo: null, openedAt: null, closedAt: null, typed: false });
  });
});
