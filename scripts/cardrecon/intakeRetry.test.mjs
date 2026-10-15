// A parser fix reaches the refusals it was written for by itself: the poller
// re-runs every refusal from the last fortnight that an older parser judged.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  retryCandidates, sweepDue, judgedVersion, intakeRecord, attachmentOutcome,
  RETRY_WINDOW_MS, RESWEEP_MS,
} from "./intakeCore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-15T16:00:00Z");
const DAY = 86400000;
const row = (over = {}) => ({
  at: NOW - DAY, receivedAt: NOW - DAY, messageKey: "k1", messageId: "<m1@fnb>",
  recorded: 0, refused: 1, unrelated: 0,
  attachments: [{ outcome: "refused", reason: "That banking report does not print an Items count." }],
  ...over,
});

describe("retryCandidates", () => {
  it("re-runs a refusal judged by an older parser — and by none at all", () => {
    const out = retryCandidates({ a: row(), b: row({ messageKey: "k2", parserVersion: 1 }) }, { nowMs: NOW, deployedVersion: 2 });
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out[0]).toEqual({ id: "a", messageKey: "k1", messageId: "<m1@fnb>" });
  });

  it("leaves alone what the current parser judged, or what was already re-run", () => {
    expect(retryCandidates({ a: row({ parserVersion: 2 }) }, { nowMs: NOW, deployedVersion: 2 })).toEqual([]);
    expect(retryCandidates({ a: row({ retriedAt: NOW - 1000 }) }, { nowMs: NOW, deployedVersion: 2 })).toEqual([]);
  });

  it("never re-runs a message that recorded anything, or one with no refusal", () => {
    expect(retryCandidates({ a: row({ recorded: 1 }) }, { nowMs: NOW, deployedVersion: 2 })).toEqual([]);
    expect(retryCandidates({ a: row({ refused: 0, unrelated: 1 }) }, { nowMs: NOW, deployedVersion: 2 })).toEqual([]);
  });

  it("does not re-run a re-send refused as a duplicate — no parser change makes it new", () => {
    const dup = row({ attachments: [{ outcome: "refused", reason: "Batch #92 for this terminal is already captured. If…" }] });
    expect(retryCandidates({ a: dup }, { nowMs: NOW, deployedVersion: 2 })).toEqual([]);
  });

  it("only the last fortnight — older mail is outside the poller's search", () => {
    const old = row({ at: NOW - RETRY_WINDOW_MS - DAY, receivedAt: NOW - RETRY_WINDOW_MS - DAY });
    expect(retryCandidates({ a: old }, { nowMs: NOW, deployedVersion: 2 })).toEqual([]);
  });

  it("skips the EFT reader's synthetic slip-loss rows and rows with no key", () => {
    expect(retryCandidates({ "eftslip-x": row(), b: row({ messageKey: null }) }, { nowMs: NOW, deployedVersion: 2 })).toEqual([]);
  });

  it("does nothing when the deployed version is unknown", () => {
    expect(retryCandidates({ a: row() }, { nowMs: NOW, deployedVersion: undefined })).toEqual([]);
  });
});

describe("sweepDue", () => {
  it("sweeps when the deployed parser is newer than the last sweep, and otherwise every six hours", () => {
    expect(sweepDue({}, { deployedVersion: 2, nowMs: NOW })).toBe(true);
    expect(sweepDue({ sweptVersion: 1, sweptAt: NOW - 1000 }, { deployedVersion: 2, nowMs: NOW })).toBe(true);
    expect(sweepDue({ sweptVersion: 2, sweptAt: NOW - 1000 }, { deployedVersion: 2, nowMs: NOW })).toBe(false);
    expect(sweepDue({ sweptVersion: 2, sweptAt: NOW - RESWEEP_MS - 1 }, { deployedVersion: 2, nowMs: NOW })).toBe(true);
    expect(sweepDue({}, { deployedVersion: null, nowMs: NOW })).toBe(false);
  });
});

describe("the version a row was judged by", () => {
  it("is the lowest any attachment reported, or null when one got no answer", () => {
    expect(judgedVersion([2, 2])).toBe(2);
    expect(judgedVersion([2, 1])).toBe(1);
    expect(judgedVersion([2, null])).toBe(null);
    expect(judgedVersion([])).toBe(null);
  });

  it("is stamped on the intake row", () => {
    const rec = intakeRecord({
      message: { key: "k", messageId: "<m>", from: "f", subject: "s", receivedAt: 1 },
      results: [attachmentOutcome({ filename: "a.pdf", capture: { ok: false, reason: "No." } })],
      skipped: [], at: 2, parserVersion: 2,
    });
    expect(rec.parserVersion).toBe(2);
    expect(intakeRecord({ message: { key: "k" }, results: [], skipped: [], at: 2 }).parserVersion).toBe(null);
  });
});

describe("the poller's wiring", () => {
  const src = readFileSync(join(HERE, "email-poller.mjs"), "utf8");
  it("remembers a release BEFORE clearing the claim, so a crash cannot strand it", () => {
    const body = src.slice(src.indexOf("async function retryStale("), src.indexOf("// ─── TIME"));
    expect(body.indexOf("state.pending[c.messageKey] = now;")).toBeLessThan(body.indexOf("[`${SEEN_PATH}/${c.messageKey}`]: null"));
    expect(body.indexOf("writeRetryState(state);")).toBeLessThan(body.indexOf("await db.ref().update({"));
  });
  it("reads the intake feed only as a bounded range on `at`", () => {
    expect(src).toMatch(/db\.ref\(INTAKE_PATH\)\.orderByChild\("at"\)\.startAt\(now - windowMs\)\.once\("value"\)/);
  });
  it("runs the sweep before the mailbox scan, and never lets it fail the tick", () => {
    expect(src.indexOf("retryPending = await retryStale(")).toBeLessThan(src.indexOf("const client = new ImapFlow({\n    host: cfg.host"));
    expect(src).toMatch(/the automatic re-run sweep failed/);
  });
  it("stamps the row with the version the callable reported", () => {
    expect(src).toMatch(/parserVersion: judgedVersion\(versions\)/);
  });
});

describe("the callable's side", () => {
  const require = createRequire(import.meta.url);
  const src = readFileSync(join(HERE, "../../functions/cardRecon/cardRecon.js"), "utf8");
  it("answers `version` with the parser version, and stamps it on extract and submit", () => {
    expect(src).toMatch(/if \(action === "version"\) return \{ ok: true, parserVersion: PARSER_VERSION \};/);
    expect((src.match(/\{ \.\.\.out, parserVersion: PARSER_VERSION \}/g) || []).length).toBe(2);
    expect(Number.isInteger(require("../../functions/lib/card-recon-pdf.cjs").PARSER_VERSION)).toBe(true);
  });
});
