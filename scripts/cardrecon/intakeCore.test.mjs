// Every awkward thing a shop mailbox actually contains: an invoice, an inline
// signature image, a renamed JPEG, a 30 MB scan, the same report forwarded
// twice, and a claim left behind by a run that was killed.
import { describe, it, expect } from "vitest";
import {
  messageKey, classifyAttachment, planMessage, classifyRefusal,
  attachmentOutcome, intakeRecord, claimDecision, clip,
  MAX_ATTACHMENT_BYTES, STALE_CLAIM_MS,
} from "./intakeCore.mjs";

const pdf = (name, extra = 0) => ({
  filename: name, contentType: "application/pdf",
  content: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(extra)]),
});

describe("messageKey", () => {
  it("is stable, key-safe, and the same for the same message", () => {
    const m = { messageId: "<abc.def@mail.gmail.com>", from: "t@x", subject: "Batch", date: 1, size: 2 };
    expect(messageKey(m)).toBe(messageKey({ ...m }));
    expect(messageKey(m)).toMatch(/^[0-9a-f]{40}$/);
    expect(messageKey({ ...m, messageId: "<other@x>" })).not.toBe(messageKey(m));
  });

  it("still identifies a message that carries no Message-ID", () => {
    const a = messageKey({ from: "t@x", subject: "Batch", date: 111, size: 900 });
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(messageKey({ from: "t@x", subject: "Batch", date: 111, size: 900 })).toBe(a);
    expect(messageKey({ from: "t@x", subject: "Batch", date: 222, size: 900 })).not.toBe(a);
  });
});

describe("classifyAttachment — the BYTES decide", () => {
  it("accepts a real PDF whatever the client called it", () => {
    expect(classifyAttachment({ ...pdf("report.pdf"), contentType: "application/octet-stream" }).ok).toBe(true);
  });

  it("refuses a file NAMED .pdf whose bytes are not one — that did not arrive intact", () => {
    const v = classifyAttachment({ filename: "slip.pdf", contentType: "application/pdf", content: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]) });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("refuse");
    expect(v.why).toMatch(/not one|intact/i);
  });

  it("SKIPS an inline signature image rather than refusing it — it was never a slip", () => {
    const v = classifyAttachment({ filename: "logo.png", contentType: "image/png", content: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D]) });
    expect(v).toEqual({ ok: false, kind: "skip", why: "logo.png is not a PDF" });
  });

  it("refuses a scan far larger than any batch report", () => {
    const v = classifyAttachment(pdf("scan.pdf", MAX_ATTACHMENT_BYTES + 1));
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("refuse");
    expect(v.why).toMatch(/too large/i);
  });

  it("does not throw on a malformed attachment", () => {
    expect(classifyAttachment({}).ok).toBe(false);
    expect(classifyAttachment(null).ok).toBe(false);
  });
});

describe("planMessage", () => {
  it("splits a mixed message into candidates, refusals and quiet skips", () => {
    const { take, refused, skipped } = planMessage([
      pdf("batch-494.pdf"),
      { filename: "signature.png", contentType: "image/png", content: Buffer.from([0x89, 0x50, 0x4E, 0x47]) },
      { filename: "broken.pdf", contentType: "application/pdf", content: Buffer.from("not a pdf at all") },
    ]);
    expect(take.map((t) => t.filename)).toEqual(["batch-494.pdf"]);
    expect(refused).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it("a message with nothing attached is a quiet nothing, not a crash", () => {
    expect(planMessage(null)).toEqual({ take: [], refused: [], skipped: [] });
    expect(planMessage([]).take).toEqual([]);
  });

  it("bounds how many capture calls one message can cost", () => {
    const many = new Array(14).fill(0).map((_, i) => pdf(`b${i}.pdf`));
    const { take, refused } = planMessage(many);
    expect(take).toHaveLength(10);
    expect(refused).toHaveLength(4);
    expect(refused[0].reason).toMatch(/More than 10 attachments/);
  });
});

describe("classifyRefusal — a failing terminal must not be filed as noise", () => {
  it("calls a real check failure REFUSED", () => {
    for (const reason of [
      "Terminal 9999ZZZZ is not registered under /config/cardTerminals",
      "Batch #494 for this terminal is already captured.",
      "The transaction lines in that PDF add up to R10.00, but the slip's own total is R20.00.",
      "The slip says 12 transactions but 11 lines were read.",
      "The slip's Opened→Closed window is longer than 7 days",
      "That PDF prints merchant ID 1 but terminal 0000HP1X is registered to merchant 2.",
    ]) expect(classifyRefusal(reason)).toBe("refused");
  });

  it("calls an invoice UNRELATED — recorded, but not a terminal failing", () => {
    for (const reason of [
      "That PDF does not print a terminal ID anywhere this could find it. If it is the right file, photograph the slip instead.",
      "That PDF holds no text — it is probably a scan or a photo saved as a PDF.",
      "That PDF has 42 pages — a batch report is one or two.",
      "That PDF is password-protected. Photograph the slip instead.",
    ]) expect(classifyRefusal(reason)).toBe("unrelated");
  });
});

describe("intakeRecord", () => {
  const message = { key: "k".repeat(40), messageId: "<a@b>", from: "terminal@fnb.co.za", subject: "Batch Report", receivedAt: 1_700_000_000_000 };

  it("a refusal makes the whole message NEEDS-ATTENTION", () => {
    const rec = intakeRecord({
      at: 5,
      message,
      results: [
        attachmentOutcome({ filename: "a.pdf", capture: { recorded: true, batchKey: "494", tid: "0000HP1X", storeId: "pe", tillId: "till-1", linesCaptured: true, warnings: [] } }),
        attachmentOutcome({ filename: "b.pdf", capture: { ok: false, reason: "Terminal 9999ZZZZ is not registered under /config/cardTerminals" } }),
      ],
      skipped: [{ filename: "logo.png" }],
    });
    expect(rec.state).toBe("needs-attention");
    expect(rec.recorded).toBe(1);
    expect(rec.refused).toBe(1);
    expect(rec.attachments[1].reason).toMatch(/not registered/);
    expect(rec.skipped).toEqual(["logo.png"]);
    // No slip CONTENT ever reaches this node — it is read by everyone who can
    // capture a slip, while the evidence itself stays owner-only in
    // /card_batches. (`linesCaptured` is a boolean about the capture, not a line.)
    const json = JSON.stringify(rec);
    for (const forbidden of [/"pan"/i, /varianceCents/i, /expectedC/i, /amountCents/i, /"lines":/i, /authCode/i, /"rrn"/i]) {
      expect(json).not.toMatch(forbidden);
    }
  });

  it("an invoice alone is done, not an alarm — but it is still recorded", () => {
    const rec = intakeRecord({
      at: 5, message, skipped: [],
      results: [attachmentOutcome({ filename: "invoice.pdf", capture: { ok: false, reason: "That PDF does not print a terminal ID anywhere this could find it." } })],
    });
    expect(rec.state).toBe("done");
    expect(rec.unrelated).toBe(1);
    expect(rec.attachments).toHaveLength(1);
  });

  it("a thrown error is an outcome, not a lost slip", () => {
    const row = attachmentOutcome({ filename: "a.pdf", error: "the capture call timed out" });
    expect(row.outcome).toBe("refused");
    expect(row.reason).toMatch(/timed out/);
  });

  it("clips attacker-supplied text — a subject line lands in a record people read", () => {
    const rec = intakeRecord({ at: 1, results: [], skipped: [], message: { ...message, subject: "x".repeat(900) } });
    expect(rec.subject.length).toBeLessThanOrEqual(200);
    expect(clip("", 10)).toBe(null);
  });
});

describe("claimDecision — the same slip is never submitted twice", () => {
  it("takes a message nobody has claimed", () => {
    expect(claimDecision(null, 1000).take).toBe(true);
  });

  it("never re-takes one already processed, and says it is FINISHED", () => {
    // `done` is what lets the poller mark the message read.
    expect(claimDecision({ state: "done", at: 1 }, 1e12)).toEqual({ take: false, done: true, why: "already processed" });
  });

  it("stands down while another run holds it — and says it is NOT finished", () => {
    // THE DIFFERENCE IS A SLIP. A message held by a run that died must stay
    // UNREAD in the mailbox, because only unread mail is searched and only a
    // later tick can retake the stale claim. Marking it read here would hide it
    // from the very tick that was going to rescue it.
    const d = claimDecision({ state: "claimed", at: 1000 }, 1000 + STALE_CLAIM_MS - 1);
    expect(d.take).toBe(false);
    expect(d.done).toBe(false);
  });

  it("re-takes a claim a killed run left behind — a slip must not be lost to a SIGKILL", () => {
    const d = claimDecision({ state: "claimed", at: 1000 }, 1000 + STALE_CLAIM_MS + 1);
    expect(d.take).toBe(true);
    expect(d.why).toMatch(/never finished/);
  });
});
