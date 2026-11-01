// ─── THE MINI'S WRITE-OFF DIGEST MAIL — decisions (2026-11-01) ───────────────
import { describe, it, expect } from "vitest";
import {
  DIGEST_MAIL_TO, OUTBOX, ARCHIVE, STATUS, MIN_AGE_MS, MAX_ATTEMPTS, SLOW_RETRY_MS, SENDING_STALE_MS, dueEntries, mailFor, patchAfter, senderOk,
} from "./writeoffDigestMailCore.mjs";

const NOW = Date.parse("2026-11-01T17:50:00.000Z");
const KEY = `2026-11-01_${NOW - 10 * 60e3}`;
const ENTRY = { to: "attacker@example.com", subject: "[Write-off digest] 11 sizes / 19 units written off after two refused days", text: "11 sizes / 19 units …\n\nline", createdAtMs: NOW - 10 * 60e3 };

describe("write-off digest mail", () => {
  it("always mails Junid's inbox (gunidmoh@, with a G) — the row's `to` is ignored", () => {
    expect(DIGEST_MAIL_TO).toBe("gunidmoh@gmail.com");
    const m = mailFor(KEY, ENTRY, "marathon6631@gmail.com");
    expect(m.to).toBe("gunidmoh@gmail.com");
    expect(m.from.address).toBe("marathon6631@gmail.com");
    expect(m.subject).toBe(ENTRY.subject);
    expect(m.text).toContain("line");
    expect(m.text).toContain("Written off after refusal");
  });

  it("only sends as the shop mailbox", () => {
    expect(senderOk("Marathon6631@gmail.com ")).toBe(true);
    expect(senderOk("someone@gmail.com")).toBe(false);
    expect(senderOk(undefined)).toBe(false);
  });

  it("waits out the first two minutes, skips empties and exhausted rows, oldest first", () => {
    const box = {
      [`2026-11-01_${NOW - 60e3}`]: { ...ENTRY, createdAtMs: NOW - 60e3 },          // too young
      [KEY]: ENTRY,
      "2026-10-31_1": { ...ENTRY, createdAtMs: NOW - 864e5 },
      empty: { createdAtMs: NOW - 864e5, text: "  " },
      dead: { ...ENTRY, createdAtMs: NOW - 864e5, attempts: MAX_ATTEMPTS },
    };
    expect(dueEntries(box, NOW).map(([k]) => k)).toEqual(["2026-10-31_1", KEY]);
    expect(dueEntries(null, NOW)).toEqual([]);
    expect(MIN_AGE_MS).toBe(120e3);
  });

  it("a send in flight (or a tick that died mid-send) is not re-sent for 30 minutes", () => {
    const box = { [KEY]: { ...ENTRY, sendingAtMs: NOW - 5 * 60e3 } };
    expect(dueEntries(box, NOW)).toEqual([]);
    expect(dueEntries(box, NOW + SENDING_STALE_MS).map(([k]) => k)).toEqual([KEY]);
  });

  it("past the last fast attempt it retries hourly, never gives up for good", () => {
    const box = { [KEY]: { ...ENTRY, attempts: MAX_ATTEMPTS, lastTriedAtMs: NOW - 10 * 60e3 } };
    expect(dueEntries(box, NOW)).toEqual([]);
    expect(dueEntries(box, NOW - 10 * 60e3 + SLOW_RETRY_MS).map(([k]) => k)).toEqual([KEY]);
  });

  it("sent: dequeues, records Gmail's message id on the archive, and on STATUS only when it is this digest's", () => {
    const info = { messageId: "<abc@gmail.com>", response: "250 2.0.0 OK", accepted: ["gunidmoh@gmail.com"] };
    const p = patchAfter({ key: KEY, entry: ENTRY, ok: true, info, nowMs: NOW, statusArchiveKey: KEY });
    expect(p[`${OUTBOX}/${KEY}`]).toBeNull();
    expect(p[`${ARCHIVE}/${KEY}/mail`]).toMatchObject({ state: "sent", to: "gunidmoh@gmail.com", messageId: "<abc@gmail.com>", accepted: ["gunidmoh@gmail.com"] });
    expect(p[`${STATUS}/mail`]).toEqual(p[`${ARCHIVE}/${KEY}/mail`]);
    const older = patchAfter({ key: KEY, entry: ENTRY, ok: true, info, nowMs: NOW, statusArchiveKey: "2026-11-02_9" });
    expect(older[`${STATUS}/mail`]).toBeUndefined();
  });

  it("failed: kept for the next tick with the reason; 'failed' (red) after the last attempt", () => {
    const p = patchAfter({ key: KEY, entry: ENTRY, ok: false, error: new Error("535 auth"), nowMs: NOW, statusArchiveKey: KEY });
    expect(p[`${OUTBOX}/${KEY}`]).toBeUndefined();
    expect(p[`${OUTBOX}/${KEY}/attempts`]).toBe(1);
    expect(p[`${OUTBOX}/${KEY}/sendingAtMs`]).toBeNull();
    expect(p[`${STATUS}/mail`]).toMatchObject({ state: "retrying", why: "535 auth" });
    const last = patchAfter({ key: KEY, entry: { ...ENTRY, attempts: MAX_ATTEMPTS - 1 }, ok: false, error: "x", nowMs: NOW, statusArchiveKey: KEY });
    expect(last[`${STATUS}/mail`].state).toBe("failed");
  });
});
