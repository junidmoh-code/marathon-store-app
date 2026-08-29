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

describe("silenceNotice", () => {
  const day = 86400000;
  it("says nothing while the feed is fresh", () => {
    expect(silenceNotice(1000 * day, 1000 * day + 3600000)).toBe(null);
    expect(silenceNotice(null, 1000 * day)).toBe(null);
  });

  it("names the silence once it is long enough to mean something", () => {
    expect(silenceNotice(1000 * day, 1003 * day)).toMatch(/3 days/);
    expect(silenceNotice(1000 * day, 1003 * day)).toMatch(/card-recon-poll\.log/);
  });
});
