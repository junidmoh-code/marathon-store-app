// ── TIKTOK HANDOFF QUEUE — tests for the pure parts (tiktokHfQueue.mjs) ─────
import { describe, it, expect } from "vitest";
import {
  CAPTION_MAX, batchOrder, blocked, capEmoji, isVertical, pickBatch, rate, sast, slotFor, tiktokCaption, unsafeSentence, videoPlan,
} from "./tiktokHfQueue.mjs";

const at = (iso) => Date.parse(iso);

describe("slots", () => {
  it("picks the slot by SAST time", () => {
    expect(slotFor(at("2026-11-28T07:00:00Z"))).toBe("morning"); // 09:00 SAST
    expect(slotFor(at("2026-11-28T15:30:00Z"))).toBe("evening"); // 17:30 SAST
    expect(slotFor(at("2026-11-28T10:59:00Z"))).toBe("morning"); // 12:59 SAST
  });
  it("dates by SAST, not UTC", () => {
    expect(sast(at("2026-11-28T22:30:00Z")).date).toBe("2026-11-29");
  });
  it("orders batches by time, morning before evening", () => {
    expect(["2026-11-29-morning", "2026-11-28-evening", "2026-11-28-morning"].sort(batchOrder))
      .toEqual(["2026-11-28-morning", "2026-11-28-evening", "2026-11-29-morning"]);
  });
});

describe("tiktokCaption", () => {
  it("keeps the opening sentences within 150 characters and moves hashtags out", () => {
    const { caption, hashtags } = tiktokCaption({
      kind: "outfit",
      caption: "Clean fit, fresh scent — the full package sorted in one shot.\n\nWhite navy grey kicks, red polo, and King fragrance to finish it off. R1 350 gets you the whole look.\n\n#MarathonClub #Durban #SneakerShop #Streetwear",
    });
    expect(caption.length).toBeLessThanOrEqual(CAPTION_MAX);
    expect(caption).toMatch(/^Clean fit, fresh scent/);
    expect(caption).not.toMatch(/#/);
    expect(hashtags.length).toBeGreaterThanOrEqual(3);
    expect(hashtags.length).toBeLessThanOrEqual(5);
    expect(hashtags).toContain("#MarathonClub");
  });

  it("never uses the third paragraph (where leaked styling notes live)", () => {
    const { caption } = tiktokCaption({ caption: "Full Lacoste fit.\n\nGrab yours.\n\nMonochrome, a second accent in the details." });
    expect(caption).toBe("Full Lacoste fit. Grab yours.");
  });

  it("drops sentences with phone numbers, addresses, links, emails or link-in-bio", () => {
    const { caption } = tiktokCaption({
      caption: "New Dunks in. Call us on 031 555 1234. Visit us at Shop 12, West Street. Order at www.marathonclub.co.za. Mail sales@x.co.za. Link in bio. Fresh pairs only.",
    });
    expect(caption).toBe("New Dunks in. Fresh pairs only.");
  });

  it("cuts one long sentence at a word with an ellipsis", () => {
    const long = `${"Sharp ".repeat(40)}end.`;
    const { caption } = tiktokCaption({ caption: long });
    expect(caption.length).toBeLessThanOrEqual(CAPTION_MAX);
    expect(caption.endsWith("…")).toBe(true);
  });

  it("allows at most two emoji", () => {
    expect(capEmoji("Fire 🔥🔥🔥 kicks 👟✨")).toBe("Fire 🔥🔥 kicks");
  });

  it("falls back when nothing safe is left, and always has 3-5 tags", () => {
    const r = tiktokCaption({ caption: "WhatsApp us 0821234567" });
    expect(r.caption).toBe("Fresh at Marathon Club.");
    expect(r.hashtags.length).toBeGreaterThanOrEqual(3);
  });

  it("flags a street address", () => {
    expect(unsafeSentence("We're at 45 Smith Street in town.")).toBe(true);
    expect(unsafeSentence("Old-school shape, modern comfort.")).toBe(false);
    expect(unsafeSentence("Sorted for R1 850.")).toBe(false);
  });
});

describe("videoPlan", () => {
  const probe = (v, f = {}) => ({ streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1", pix_fmt: "yuv420p", ...v }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5", ...f } });
  it("takes a good MP4 as it is", () => expect(videoPlan(probe({}))).toEqual({ ok: true }));
  it("re-encodes off-spec fps or codec", () => {
    expect(videoPlan(probe({ avg_frame_rate: "120/1" })).transcode).toMatch(/fps/);
    expect(videoPlan(probe({ avg_frame_rate: "15/1" })).transcode).toMatch(/fps/);
    expect(videoPlan(probe({ codec_name: "hevc" })).transcode).toMatch(/codec/);
    expect(videoPlan(probe({}, { format_name: "matroska,webm" })).transcode).toMatch(/container/);
  });
  it("rejects what cannot be fixed", () => {
    expect(videoPlan(probe({}, { duration: "2" })).ok).toBe(false);
    expect(videoPlan(probe({}, { duration: "601" })).ok).toBe(false);
    expect(videoPlan(probe({ width: 320, height: 640 })).ok).toBe(false);
    expect(videoPlan({ streams: [] }).ok).toBe(false);
  });
  it("reads frame rates", () => { expect(rate("30000/1001")).toBeCloseTo(29.97, 2); expect(rate("0/0")).toBe(0); });
  it("knows a vertical picture", () => { expect(isVertical(1080, 1920)).toBe(true); expect(isVertical(1080, 1350)).toBe(false); });
});

describe("pickBatch", () => {
  const q = [
    { key: "v1", media: "VIDEO" }, { key: "p1", media: "PHOTO" }, { key: "p2", media: "PHOTO" },
    { key: "p3", media: "PHOTO" }, { key: "p4", media: "PHOTO" },
  ];
  it("photos first, in queue order, three at a time", () => {
    expect(pickBatch(q, {}).map((c) => c.key)).toEqual(["p1", "p2", "p3"]);
  });
  it("never offers posted, skipped, rejected or poster-sent families", () => {
    const state = { posted: { p1: {} }, skipped: { p2: {} }, rejects: { p3: {} }, ledger: { families: { p4: { state: "live" } } } };
    expect(pickBatch(q, state).map((c) => c.key)).toEqual(["v1"]);
  });
  it("a poster refusal (nothing created) does not block the family", () => {
    expect(blocked("p1", { ledger: { families: { p1: { state: "refused", attempts: 1 } } } })).toBe(false);
    expect(blocked("p1", { ledger: { families: { p1: { state: "sending" } } } })).toBe(true);
  });
  it("families offered before come after fresh ones, least-offered first", () => {
    const state = { offered: { p1: 2, p2: 1 } };
    expect(pickBatch(q, state, 5).map((c) => c.key)).toEqual(["p3", "p4", "v1", "p2", "p1"]);
  });
});
