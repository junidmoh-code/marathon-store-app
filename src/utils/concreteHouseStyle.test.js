import { describe, it, expect } from "vitest";
import { subjectUrls, refsToSend, buildParts, afterFailure, buildQueueUpdate, estimateUsd, money, STATUS, MAX_STYLE_REFS_SENT } from "./concreteHouseStyle.js";

describe("house style rules", () => {
  it("subject = AI source copy, then the photo; max two; https only", () => {
    expect(subjectUrls({ photoSourceUrl: "https://a", photoUrl: "https://b", gallery: ["https://c"] })).toEqual(["https://a", "https://b"]);
    expect(subjectUrls({ photoUrl: "data:x", gallery: ["https://c"] })).toEqual(["https://c"]);
  });
  it("refs: enabled only, newest first, capped", () => {
    const refs = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`r${i}`, { url: `u${i}`, addedAt: i }]));
    refs.r8.enabled = false;
    const out = refsToSend({ refs });
    expect(out).toHaveLength(MAX_STYLE_REFS_SENT);
    expect(out[0].id).toBe("r7");
  });
  it("parts label the subject and the style separately", () => {
    const parts = buildParts({ prompt: "P", subjects: ["s"], refs: ["r1", "r2"], img: (x) => ({ img: x }) });
    expect(parts.map((p) => p.text ? "T" : p.img)).toEqual(["T", "T", "s", "T", "r1", "r2"]);
    expect(buildParts({ prompt: "", subjects: ["s"], refs: [], img: (x) => ({ img: x }) })).toHaveLength(3);
  });
  it("retry once, then flag", () => {
    expect(afterFailure({ attempts: 1 }, "boom", 5).status).toBe(STATUS.QUEUED);
    const f = afterFailure({ attempts: 2 }, "boom", 5);
    expect(f.status).toBe(STATUS.FAILED);
    expect(f.flaggedAt).toBe(5);
  });
  it("a batch queues every product with its estimate", () => {
    const u = buildQueueUpdate({ pids: ["p1", "p2"], uid: "u", nowMs: 9, cfg: { model: "flash" } });
    expect(Object.keys(u)).toEqual(["concrete_house_style/p1", "concrete_house_style/p2"]);
    expect(u["concrete_house_style/p1"]).toMatchObject({ status: "queued", attempts: 0, estimateUsd: 0.067 });
    expect(estimateUsd({})).toBe(0.16);
    expect(money(0.134)).toBe("$0.134 (≈ R2.41)");
  });
});

import { canQueue, isStaleRunning, STALE_RUNNING_MS } from "./concreteHouseStyle.js";
describe("queue safety", () => {
  it("never re-queues a row that is queued or generating", () => {
    expect(canQueue(null)).toBe(true);
    for (const s of ["awaiting_approval", "approved", "rejected", "failed"]) expect(canQueue({ status: s })).toBe(true);
    for (const s of ["queued", "running"]) expect(canQueue({ status: s })).toBe(false);
  });
  it("a running row is stale only after the window", () => {
    expect(isStaleRunning({ status: "running", startedAt: 0 }, STALE_RUNNING_MS + 1)).toBe(true);
    expect(isStaleRunning({ status: "running", startedAt: 0 }, STALE_RUNNING_MS)).toBe(false);
    expect(isStaleRunning({ status: "queued", startedAt: 0 }, 1e12)).toBe(false);
  });
});
