import { describe, it, expect } from "vitest";
import { normalizeTvPromo, tvPromoMode } from "./tvPromo";

const BEFORE = Date.parse("2026-11-20T10:00:00Z");
const AFTER = Date.parse("2026-11-28T10:00:00Z");

describe("TV promo banner", () => {
  it("no node = on, built-in tape, which still takes itself down on Black Friday", () => {
    expect(tvPromoMode(null, BEFORE)).toBe("tape");
    expect(tvPromoMode(normalizeTvPromo(null), AFTER)).toBeNull();
  });
  it("the switch turns it off", () => {
    expect(tvPromoMode(normalizeTvPromo({ enabled: false }), BEFORE)).toBeNull();
  });
  it("photo mode shows the upload, with no date limit; no upload yet falls back to the tape", () => {
    expect(tvPromoMode(normalizeTvPromo({ style: "photo", photoUrl: "u" }), AFTER)).toBe("photo");
    expect(tvPromoMode(normalizeTvPromo({ style: "photo" }), BEFORE)).toBe("tape");
  });
});
