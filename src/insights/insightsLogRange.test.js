import { describe, it, expect } from "vitest";
import { pushKeyForMs, recentDaysStartKey, PAD_MS } from "./insightsLogRange";

// Push keys encode the write time in their first 8 chars, which is the ONLY
// reason a key range can stand in for a time range on a node with no .indexOn.
// If this encoding is ever wrong the range silently returns the wrong window, so
// it is pinned against real keys taken from the live node.
describe("pushKeyForMs — real keys from /insights_log", () => {
  // Real key/timestamp pairs read live 2026-08-02, one per action type
  // (docs/insights-log-investigation.md §4). Decoding each key's first 8 chars
  // reproduces its entry's own timestamp to within 7.1s across all seven.
  const REAL = [
    ["-OroHam_3lTGQVS0hYRo", "2026-05-04T18:40:11Z"], // placed
    ["-OroHdYgD9dyn87udq8Z", "2026-05-04T18:40:22Z"], // out_of_stock
    ["-OrrSynXu7Ee43Adey9b", "2026-05-05T09:28:45Z"], // ready
    ["-OrrUJLwlhDBZIouu8N8", "2026-05-05T09:34:34Z"], // tomorrow
    ["-OsAIisOb6NOXQ4WqXbn", "2026-05-09T05:56:22Z"], // collected
    ["-OsjulXZoXKXkZPTETET", "2026-05-16T08:33:16Z"], // stock_depleted
    ["-OwvR75QNAzVmSeWT5OC", "2026-07-07T07:17:29Z"], // sold
  ];

  it.each(REAL)("decodes %s back to its own timestamp (within the measured skew)", (key, iso) => {
    const PUSH = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
    let ms = 0;
    for (const c of key.slice(0, 8)) ms = ms * 64 + PUSH.indexOf(c);
    // 725s is the worst NEGATIVE skew measured across all 64,011 entries.
    expect(Math.abs(ms - Date.parse(iso))).toBeLessThan(725 * 1000);
  });

  it.each(REAL)("the prefix it builds sorts at the right place for %s", (key, iso) => {
    // A key generated for a moment BEFORE the entry must sort before it, and one
    // generated AFTER must sort after — that is all startAt() needs.
    const ms = Date.parse(iso);
    expect(pushKeyForMs(ms - 60_000) <= key).toBe(true);
    expect(pushKeyForMs(ms + 7 * 24 * 3600_000) > key).toBe(true);
  });

  it("is exactly 8 characters and uses only push-key alphabet", () => {
    const k = pushKeyForMs(1785000000000);
    expect(k).toHaveLength(8);
    expect(k).toMatch(/^[-0-9A-Z_a-z]{8}$/);
  });

  it("is monotonic in time", () => {
    const a = pushKeyForMs(1785000000000);
    const b = pushKeyForMs(1785000001000);
    const c = pushKeyForMs(1785086400000);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("is defensive about junk input", () => {
    expect(pushKeyForMs(undefined)).toHaveLength(8);
    expect(pushKeyForMs(-1)).toHaveLength(8);
    expect(pushKeyForMs(NaN)).toHaveLength(8);
  });
});

describe("recentDaysStartKey — window derived from the days the screen renders", () => {
  const NOW = Date.parse("2026-08-02T09:30:00.000Z"); // 11:30 SAST

  it("covers the whole oldest day, plus the padding", () => {
    const { startMs } = recentDaysStartKey(5, NOW);
    // SA midnight 5 days back is 2026-07-28T00:00 SAST = 2026-07-27T22:00Z.
    const expectedMidnight = Date.parse("2026-07-27T22:00:00.000Z");
    expect(startMs).toBe(expectedMidnight - PAD_MS);
  });

  it("moves with the requested period — not a fixed window", () => {
    const five = recentDaysStartKey(5, NOW).startMs;
    const ten = recentDaysStartKey(10, NOW).startMs;
    expect(five - ten).toBe(5 * 24 * 3600_000);
  });

  it("pads by 48h — far beyond the worst measured key/timestamp skew (-725s)", () => {
    const { startMs } = recentDaysStartKey(0, NOW);
    const saMidnightToday = Date.parse("2026-08-01T22:00:00.000Z");
    expect(saMidnightToday - startMs).toBe(PAD_MS);
    expect(PAD_MS).toBeGreaterThan(725 * 1000);
  });

  it("returns a usable key", () => {
    expect(recentDaysStartKey(5, NOW).startKey).toMatch(/^[-0-9A-Z_a-z]{8}$/);
  });
});
