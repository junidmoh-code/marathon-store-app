import { describe, it, expect } from "vitest";
import { summariseIntake, attachmentRows, silenceNotice } from "./intakeFeed";

const rec = (over) => ({ at: 1000, recorded: 1, refused: 0, unrelated: 0, ...over });

describe("summariseIntake", () => {
  it("puts anything needing attention above everything else, however old", () => {
    const { rows, refusedCount } = summariseIntake({
      new1: rec({ at: 9000 }),
      old_refusal: rec({ at: 1000, recorded: 0, refused: 2 }),
      new2: rec({ at: 8000 }),
    });
    expect(rows.map((r) => r.id)).toEqual(["old_refusal", "new1", "new2"]);
    expect(refusedCount).toBe(2);
  });

  it("counts what was recorded, and survives an empty or absent node", () => {
    expect(summariseIntake({ a: rec(), b: rec({ recorded: 2 }) }).recordedCount).toBe(3);
    expect(summariseIntake(null)).toEqual({ rows: [], refusedCount: 0, recordedCount: 0, lastAt: null });
  });
});

describe("attachmentRows", () => {
  it("reads worst-first: a refusal before a record before an invoice", () => {
    const order = attachmentRows({
      attachments: [
        { filename: "invoice.pdf", outcome: "unrelated" },
        { filename: "ok.pdf", outcome: "recorded" },
        { filename: "bad.pdf", outcome: "refused" },
      ],
    }).map((a) => a.filename);
    expect(order).toEqual(["bad.pdf", "ok.pdf", "invoice.pdf"]);
    expect(attachmentRows(null)).toEqual([]);
  });
});

describe("silenceNotice — a quiet mailbox and a dead poller are opposites", () => {
  const day = 86400000;
  const now = 1000 * day;

  it("says NOTHING about a mailbox that is merely quiet, if the poller is alive", () => {
    // Two weeks of no emailed slips with a heartbeat from ten minutes ago is a
    // quiet fortnight, not an outage. An alarm here is the kind that teaches
    // people to ignore alarms.
    expect(silenceNotice(now - 14 * day, now, { lastRunAt: now - 600000 })).toBe(null);
  });

  it("calls a STOPPED poller what it is, even when the feed looks recent", () => {
    // A batch captured an hour ago and no tick since: every report emailed in
    // between is sitting unread, and the feed alone would look healthy.
    const notice = silenceNotice(now - 3600000, now, { lastRunAt: now - 5 * 3600000 });
    expect(notice).toMatch(/has stopped/);
    expect(notice).toMatch(/5 hours/);
    expect(notice).toMatch(/card-recon-poll\.log/);
  });

  it("falls back to the feed's own age when there is no heartbeat at all", () => {
    // An older build, or one that has never run. Absence is not good news.
    expect(silenceNotice(now - 3 * day, now, null)).toMatch(/3 days/);
    expect(silenceNotice(now - 3 * day, now, {})).toMatch(/not reported in at all/);
    expect(silenceNotice(now - 3600000, now, null)).toBe(null);
    expect(silenceNotice(null, now, null)).toBe(null);
  });
});
