// The weekly learning report: Junid's own words on each photo against the
// learning log. Three findings that cite their numbers — never padded — and
// prompt changes that are only ever PROPOSED.
import { describe, it, expect } from "vitest";
import { tiers, joinRows, findings, chipCounts, proposals, weekSpend, learningReport, PROPOSALS } from "./learningCore.mjs";
import { run } from "./learningReport.mjs";

const NOW = Date.UTC(2026, 9, 5, 6, 0);
const DAY = 86_400_000;
const gen = (id) => ({ url: `https://s/${id}.jpg`, code: `G-${id}` });
const d = (pid, genId, action, at, extra = {}) => ({ pid, genId, action, at, gen: gen(genId), ...extra });
const log = (pid, genId, over = {}) => ({ pid, genId, code: `G-${genId}`, at: NOW - DAY, method: "full", promptVersion: "baseline-2026-10-02+steam (studio-2026-10-04.1)", kind: "single",
  costZar: 2.75, timing: { requestMs: 40_000 }, inputs: [{ role: "source" }], thoughts: "I hung the garment on the fence.", ...over });

describe("tiers: Junid's final word on each generation", () => {
  it("❤ outranks everything until it is un-loved; otherwise the last of approve / pick / a chip wins; chips are all kept", () => {
    const t = tiers([
      d("p1", "a", "reject", 1, { reason: "colour off" }), d("p1", "a", "reject", 2, { reason: "framing" }), d("p1", "a", "approve", 3),
      d("p2", "b", "approve", 1), d("p2", "b", "love", 2), d("p2", "b", "reject", 3, { reason: "blurry" }),
      d("p3", "c", "love", 1), d("p3", "c", "unlove", 2),
      d("p4", "e", "pick", 1), d("p4", "e", "reject", 2, { reason: "box wrong" }),
      d("p5", "f", "generate", 1), d("p5", "f", "skip", 2),
    ]);
    const by = Object.fromEntries(t.map((x) => [x.genId, x]));
    expect(by.a.tier).toBe("approved");
    expect(by.a.reasons).toEqual(["colour off", "framing"]);
    expect(by.b.tier).toBe("loved");
    expect(by.c).toBeUndefined();          // loved then un-loved, nothing else said: not judged
    expect(by.e.tier).toBe("rejected");
    expect(by.f).toBeUndefined();          // generate / skip are not a judgement of a photo
  });
});

describe("findings", () => {
  const m = (sharp, crease) => ({ measurements: { sharpness: { laplacianVar: sharp }, crease: { delta: crease }, noise: { highpassStd: 1 }, background: { mad: 2 } } });
  const decisions = [
    d("p1", "a", "love", 10), d("p2", "b", "love", 11), d("p3", "c", "approve", 12),
    d("p4", "x", "reject", 13, { reason: "blurry" }), d("p5", "y", "reject", 14, { reason: "blurry" }), d("p6", "z", "reject", 15, { reason: "colour off" }),
  ];
  const genlogs = [
    log("p1", "a", m(900, 0.01)), log("p2", "b", m(800, 0.02)), log("p3", "c", m(700, 0.02)),
    log("p4", "x", { ...m(200, 0.09), method: "split" }), log("p5", "y", { ...m(250, 0.08), method: "split" }), log("p6", "z", { ...m(300, 0.1), method: "split" }),
  ];
  const rows = joinRows(decisions, genlogs);

  it("cites the numbers on both sides and says who is compared", () => {
    const f = findings(rows);
    expect(f).toHaveLength(3);
    const sharp = f.find((x) => x.key === "sharpness");
    expect(sharp.text).toBe("Loved photos had sharpness 850 (the middle of 2) against 250 for the ones you marked not right (the middle of 3) (higher = sharper).");
    expect(sharp.goodIsBetter).toBe(true);
    expect(f.find((x) => x.key === "method").text).toBe('Loved photos: 2 of 2 were method "Full Gemini", against 0 of 3 of the ones you marked not right.');
  });

  it("with fewer than three clear differences it says so once, with the counts — never padded", () => {
    const few = joinRows([d("p1", "a", "love", 1), d("p4", "x", "reject", 2, { reason: "blurry" })], genlogs);
    const f = findings(few);
    expect(f).toHaveLength(1);
    expect(f[0].key).toBeNull();
    expect(f[0].text).toBe("Not enough to compare yet: 1 loved, 0 approved and 1 marked not right so far — a finding needs at least 2 good and 2 not-right photos that differ on something measured.");
  });

  it("a number that points the wrong way is said to explain nothing — and proposes nothing", () => {
    const odd = joinRows(decisions, [log("p1", "a", m(100, 0.01)), log("p2", "b", m(120, 0.01)), log("p4", "x", m(900, 0.01)), log("p5", "y", m(950, 0.01))]);
    const f = findings(odd).find((x) => x.key === "sharpness");
    expect(f.text).toMatch(/the opposite of what was expected, so this number does not explain your choice/);
    expect(proposals([f], [])).toEqual([]);
  });

  it("proposals come only from findings that point the right way and from chips used at least twice; never duplicated", () => {
    const f = findings(rows);
    const p = proposals(f, chipCounts(rows));
    expect(chipCounts(rows)).toEqual([["blurry", 2], ["colour off", 1]]);
    expect(p.map((x) => x.change)).toContain(PROPOSALS.sharpness);
    expect(p.filter((x) => x.change === PROPOSALS.sharpness)).toHaveLength(1);   // the finding and the "blurry" chip agree: one proposal
    expect(p.every((x) => x.because)).toBe(true);
  });
});

describe("the report", () => {
  const decisions = [d("p1", "a", "love", NOW - DAY), d("p2", "b", "reject", NOW - 2 * DAY, { reason: "colour off" }), d("p3", "c", "approve", NOW - 20 * DAY)];
  const genlogs = [log("p1", "a"), log("p2", "b", { costEstimated: true, costZar: 2.4 }), log("p3", "c", { at: NOW - 20 * DAY })];

  it("this week's counts and spend, the loved and not-right photos by code, and proposals marked NOT APPLIED", () => {
    const r = learningReport({ decisions, genlogs, now: NOW });
    expect(r.subject).toBe("New Arrivals photos this week: 1 loved, 1 not right (2026-10-05)");
    expect(r.body).toContain("Your photos this week: 1 loved ❤, 0 approved, 1 marked not right.");
    expect(r.body).toContain("Since the start: 1 loved, 1 approved, 1 marked not right.");
    expect(r.body).toContain("Gemini made 2 photos this week for R5.15 (of which ~R2.40 is an estimate) — R2.58 a photo, about 40 seconds each.");
    expect(r.body).toContain("G-a — Full Gemini, baseline-2026-10-02+steam");
    expect(r.body).toContain("G-b — Full Gemini, baseline-2026-10-02+steam — you said: colour off");
    expect(r.body).toContain("PROPOSED PROMPT CHANGES — NOT APPLIED. Nothing changes unless you say yes");
    expect(r.body).toContain("Gemini said (gemini's own account — not proof)");
    expect(r.images).toEqual([{ code: "G-a", url: "https://s/a.jpg", tier: "loved" }, { code: "G-b", url: "https://s/b.jpg", tier: "rejected" }]);
    // No checker language anywhere.
    expect(r.body).not.toMatch(/checker|verdict/i);
  });

  it("an empty week reads plainly", () => {
    const r = learningReport({ decisions: [], genlogs: [], now: NOW });
    expect(r.body).toContain("Gemini made no photos this week.");
    expect(r.body).toContain("none this week — nothing separates the loved photos from the others clearly enough yet");
    expect(weekSpend([], NOW)).toMatchObject({ n: 0, zar: 0, perPhoto: null });
  });

  it("the runner reads two bounded slices, attaches the photos by code, and a photo that cannot be fetched is named — never a reason not to send", async () => {
    const reads = [];
    const db = { ref: (node) => ({ orderByKey: () => ({ limitToLast: (n) => ({ once: async () => { reads.push([node, n]); return { val: () => (node.endsWith("decisions") ? Object.fromEntries(decisions.map((x, i) => [`k${i}`, x])) : Object.fromEntries(genlogs.map((g) => [g.code, g]))) }; } }) }) }) };
    const sent = [];
    const out = await run({ db, now: () => NOW, email: async (m) => { sent.push(m); return { ok: true }; },
      fetchImage: async (url) => { if (url.includes("/b.jpg")) throw new Error("404"); return Buffer.from("img"); }, resize: async (b) => b });
    expect(reads).toEqual([["new_arrivals/decisions", 4000], ["new_arrivals/genlog", 1500]]);
    expect(sent).toHaveLength(1);
    expect(sent[0].attachments.map((a) => a.filename)).toEqual(["G-a-loved.jpg"]);
    expect(sent[0].body).toContain("Photos that could not be attached: G-b (404).");
    expect(out.sent.ok).toBe(true);
    // --print sends nothing.
    const printed = await run({ db, now: () => NOW, print: true, email: async () => { throw new Error("must not send"); } });
    expect(printed.sent).toBeNull();
  });
});
