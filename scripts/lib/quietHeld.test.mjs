import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendQuietHeld, heldLine, heldMailSender } from "./quietHeld.mjs";

describe("Junid's quiet rule — held lines", () => {
  it("writes the dm-agent importer's shape", () => {
    const l = heldLine({ at: 5, source: "marathon-store-app:x", subject: "S", text: "T" });
    expect(l).toEqual({ at: 5, channel: "email", source: "marathon-store-app:x", kind: null, subject: "S", text: "T", needsDecision: true, recordOnly: false });
  });
  it("a report is recordOnly, never needsDecision", () => {
    const l = heldLine({ source: "s", needsDecision: false, channel: "whatsapp" });
    expect(l.needsDecision).toBe(false);
    expect(l.recordOnly).toBe(true);
    expect(l.channel).toBe("whatsapp");
  });
  it("refuses a line with no source", () => {
    expect(() => heldLine({ subject: "x" })).toThrow();
  });
  it("appends one JSON line per message to the file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "quiet-")), "sub", "quiet-held.jsonl");
    appendQuietHeld({ source: "a", subject: "one" }, { file });
    const send = heldMailSender({ source: "b", file, decide: (m) => !/waybill/i.test(m.subject) });
    const r = await send({ subject: "Waybill R300 for #1", text: "t" });
    expect(r.held).toBe(true);
    const rows = readFileSync(file, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(rows.map((x) => [x.source, x.subject, x.needsDecision])).toEqual([["a", "one", true], ["b", "Waybill R300 for #1", false]]);
  });
});
