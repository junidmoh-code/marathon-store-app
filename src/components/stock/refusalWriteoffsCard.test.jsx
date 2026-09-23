// ─── "WRITTEN OFF AFTER REFUSAL" — Junid's card reads what the scan writes ───
// The record is produced by functions/lib/refusal-writeoff.cjs (run here for
// real, on the functions fake RTDB) and drawn by HealthView through
// refusalWriteoffsCore.js — two runtimes held together only by field names.
// Pins: the card shows product, size, location, units, who refused and when,
// from a REAL record; the read is opened only for the super admin (counted, not
// assumed) and is always bounded; the screen is read-only and gated.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const onValue = vi.fn(() => () => {});
const limitToLast = vi.fn(() => ({}));
vi.mock("firebase/database", () => ({
  ref: (db, path) => ({ path }), onValue: (...a) => onValue(...a), query: (r) => r,
  orderByKey: () => ({}), orderByChild: () => ({}), limitToLast: (...a) => limitToLast(...a), limitToFirst: () => ({}),
  startAt: () => ({}), startAfter: () => ({}), endAt: () => ({}), equalTo: () => ({}),
  get: vi.fn(), update: vi.fn(), push: vi.fn(), set: vi.fn(), remove: vi.fn(), runTransaction: vi.fn(), serverTimestamp: () => ({}),
}));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (auth, cb) => { cb({ uid: "u1" }); return () => {}; },
  getAuth: () => ({ currentUser: { uid: "u1" } }), GoogleAuthProvider: class {},
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } }, storage: {}, app: {}, functions: {}, functionsUS: {}, googleProvider: {} }));

const { useRefusalWriteoffs, REFUSAL_WRITEOFFS_PATH, useRefusalWriteoffDigestStatus, REFUSAL_DIGEST_STATUS_PATH } = await import("./useStock");
const { writeoffRows, recentCount, digestStatusLine } = await import("./refusalWriteoffsCore");

const req = createRequire(import.meta.url);
const { planRefusalWriteoffs, applyRefusalWriteoffs } = req("../../../functions/lib/refusal-writeoff.cjs");
const { sanitizeUpdate } = req("../../../functions/lib/refill-engine.cjs");
const { makeFakeDb } = req("../../../functions/test/helpers/fake-rtdb.cjs");
const digestFn = req("../../../functions/lib/writeoff-digest.cjs");
const health = readFileSync(fileURLToPath(new URL("./HealthView.jsx", import.meta.url)), "utf8");

const NOW = Date.parse("2026-09-23T12:45:00.000Z");
const PID = "p1780382141061";

async function realRecords() {
  const refusal = (at, extra = {}) => ({ productId: PID, size: "M", qty: 2, requestingLocation: "marathon-pe", status: "cancelled", createdAt: at, resolvedAt: at, createdFrom: { engine: true, source: "hub2" }, ...extra });
  const rr = {
    a: refusal("2026-09-12T11:30:40.428Z"), b: refusal("2026-09-14T08:45:31.184Z"),
    c: refusal("2026-09-16T10:15:04.806Z"), d: refusal("2026-09-17T14:15:22.516Z", { resolvedBy: "u_mike", rejectedBy: "admin" }),
  };
  const stock = { hub2: { [PID]: { M: { qty: 3, v: 1, mv: "s", lastType: "transfer_out", updatedAt: "2026-09-09T13:18:11.169Z" } } } };
  const db = makeFakeDb({ stock, refill_requests: rr, users: { u_mike: { displayName: "Mike" } } });
  const snapshot = { nowMs: NOW, config: { routes: { hub2: "central", "marathon-pe": "hub2" } }, products: { [PID]: { name: "Nike Tech Fleece Tracksuit Brown 2" } }, stock: structuredClone(stock), refillRequests: rr, movements: [], rejectStreak: {}, cursors: {}, windowStartMs: NOW - 45 * 864e5 };
  const plan = planRefusalWriteoffs(snapshot);
  await applyRefusalWriteoffs({ db, writeoffs: plan.writeoffs, snapshot, nowMs: NOW, update: async (p) => { await db.ref().update(sanitizeUpdate(p).safe); return true; } });
  return (await db.ref(REFUSAL_WRITEOFFS_PATH).once("value")).val();
}

describe("Written off after refusal — the card", () => {
  it("draws product, size, location, units, who refused and when — from a real engine record", async () => {
    const value = await realRecords();
    const rows = writeoffRows(value);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productName: "Nike Tech Fleece Tracksuit Brown 2", size: "M", location: "Hub 2", units: 3, left: 0 });
    expect(rows[0].refusals).toEqual([
      { when: "12 Sep", who: "Hub 2 staff (no name recorded)", forShop: "Marathon PE" },
      { when: "14 Sep", who: "Hub 2 staff (no name recorded)", forShop: "Marathon PE" },
      { when: "16 Sep", who: "Hub 2 staff (no name recorded)", forShop: "Marathon PE" },
      { when: "17 Sep", who: "Mike", forShop: "Marathon PE" },
    ]);
    expect(recentCount(rows, NOW)).toBe(1);
    expect(recentCount(rows, NOW + 31 * 864e5)).toBe(0);
  });

  it("the read is opened ONLY for the super admin, and always bounded (newest 200 by key)", async () => {
    function Probe({ on }) { useRefusalWriteoffs(on); return null; }
    onValue.mockClear(); limitToLast.mockClear();
    await act(async () => { TestRenderer.create(<Probe on={false} />); });
    expect(onValue).not.toHaveBeenCalled();
    await act(async () => { TestRenderer.create(<Probe on={true} />); });
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue.mock.calls[0][0].path).toBe("refill_engine/refusalWriteoffs");
    expect(limitToLast).toHaveBeenCalledWith(200);
  });

  it("HealthView gates the card and the screen on isSuperAdmin, and the screen writes nothing", () => {
    expect(health).toContain("useRefusalWriteoffs(isSuperAdmin)");
    const cardAt = health.indexOf('label="Written off after refusal"');
    expect(cardAt).toBeGreaterThan(0);
    expect(health.slice(cardAt - 120, cardAt)).toContain("{isSuperAdmin && (");
    const block = health.slice(health.indexOf('case "refusalWriteoffs"'), health.indexOf('case "shortNotRequested"'));
    expect(block).toContain("if (!isSuperAdmin) return null;");
    // No database write of any kind (a Map.set / Array.push for grouping is not one).
    expect(block).not.toMatch(/\b(update|set|remove|push)\(\s*ref\(/);
    expect(block).not.toMatch(/runTransaction|applyMovement|database\b/);
  });
});

// ─── THE DAILY EMAIL'S STATUS ON THE CARD (2026-09-23) ───────────────────────
// The 23 Sep digest was logged as sent and never arrived, and nothing said so.
// The status node is written by functions/index.js refusalWriteoffDigest from
// the REAL judgeDelivery verdict; these pin what the card says for each.
describe("Written off after refusal — the daily email's status", () => {
  const SENT = Date.parse("2026-09-23T17:40:03.000Z");
  const DIGEST = { summary: "133 sizes / 250 units written off after four refused days — Central: 98 (194u)" };
  const POLICY = { name: "p/1", displayName: digestFn.POLICY_NAME, enabled: true, notificationChannels: ["c/1"] };
  const CHANNEL = { enabled: true, labels: { email_address: digestFn.RECIPIENT } };
  const ALERT = { name: "a/1", openTime: "2026-09-23T17:41:06Z", log: { extractedLabels: { digest: DIGEST.summary } } };
  const status = (over) => ({ atMs: SENT, outcome: "sent", count: 133, units: 250,
    delivery: digestFn.judgeDelivery({ policy: POLICY, channel: CHANNEL, alerts: [ALERT], digest: DIGEST, sentAtMs: SENT, ...over }) });
  const soon = SENT + 3600e3;

  it("emailed: green, says who it went to and when — and that Google gives no inbox receipt", () => {
    const l = digestStatusLine(status({}), soon);
    expect(l.tone).toBe("ok");
    expect(l.text).toContain("Emailed 133 write-offs to junidmoh@gmail.com at 23 Sep 19:41");
    expect(l.text).toContain("no inbox receipt");
  });
  it("Google raised no alert: RED, says it did NOT go out and why", () => {
    const l = digestStatusLine(status({ alerts: [] }), soon);
    expect(l.tone).toBe("fail");
    expect(l.text).toMatch(/did NOT go out: Google raised no alert/);
  });
  it("channel switched off / wrong address: RED", () => {
    expect(digestStatusLine(status({ channel: { ...CHANNEL, enabled: false } }), soon).tone).toBe("fail");
    expect(digestStatusLine(status({ channel: { enabled: true, labels: { email_address: "x@y.z" } } }), soon).text).toContain("sends to x@y.z");
  });
  it("the run threw, or has not run for over a day: RED", () => {
    expect(digestStatusLine({ atMs: SENT, outcome: "error", why: "boom" }, soon)).toMatchObject({ tone: "fail" });
    expect(digestStatusLine(status({}), SENT + 27 * 3600e3).text).toContain("has not run since 23 Sep 19:40");
  });
  it("could not ask Google: amber, never green", () => {
    const l = digestStatusLine({ atMs: SENT, outcome: "sent", count: 1, delivery: { state: "unchecked", why: "HTTP 403" } }, soon);
    expect(l.tone).toBe("warn");
  });
  it("nothing new, and never checked yet", () => {
    expect(digestStatusLine({ atMs: SENT, outcome: "nothing_new" }, soon).tone).toBe("ok");
    expect(digestStatusLine(null, soon).tone).toBe("warn");
  });
  it("the status read is ONE small node, opened only for the super admin", async () => {
    function Probe({ on }) { useRefusalWriteoffDigestStatus(on); return null; }
    onValue.mockClear();
    await act(async () => { TestRenderer.create(<Probe on={false} />); });
    expect(onValue).not.toHaveBeenCalled();
    await act(async () => { TestRenderer.create(<Probe on={true} />); });
    expect(onValue.mock.calls[0][0].path).toBe(REFUSAL_DIGEST_STATUS_PATH);
    expect(REFUSAL_DIGEST_STATUS_PATH).toBe(digestFn.STATUS);   // the function writes exactly what the card reads
  });
  it("HealthView shows the line on the screen and turns the stat card red on a failed email", () => {
    expect(health).toContain("useRefusalWriteoffDigestStatus(isSuperAdmin)");
    const block = health.slice(health.indexOf('case "refusalWriteoffs"'), health.indexOf('case "shortNotRequested"'));
    expect(block).toContain("data-digest-status");
    const cardAt = health.indexOf('label="Written off after refusal"');
    expect(health.slice(cardAt, cardAt + 500)).toContain('digestLine?.tone === "fail" ? RED');
  });
});
