// ─── Full-field compliance — pinned ──────────────────────────────────────────
// The validator is the last gate before any Shopify write; these tests prove
// it refuses a trigger in EVERY pushed field, that the description template
// and the Returns & Condition page copy are themselves trigger-free, and that
// condition has no default. Weakening an assertion here reopens the payment
// gateway's keyword scan — fix the code, not the test.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  VENDOR, CONDITIONS, buildDescriptionHtml, buildHandle, buildSeo, buildTags,
  validatePayload,
} from "./compliance.mjs";
import { isTriggerFree } from "../../src/utils/shopifyTriggers.js";

const cleanPayload = () => ({
  title: "Low-top sneaker black with blue laces",
  handle: "low-top-sneaker-black-with-blue-laces",
  vendor: VENDOR,
  productType: "Sneakers",
  tags: ["Footwear", "Sneakers"],
  descriptionHtml: buildDescriptionHtml(CONDITIONS[0]),
  seo: buildSeo("Low-top sneaker black with blue laces", CONDITIONS[0]),
  media: [{ alt: "Low-top sneaker black with blue laces" }],
});

describe("condition", () => {
  it("has exactly the three owner-specified values", () => {
    expect(CONDITIONS).toEqual([
      "Excellent — no visible wear",
      "Very good — light cosmetic marks",
      "Good — visible wear, priced accordingly",
    ]);
  });
  it("has NO default: unset/unknown condition throws instead of substituting", () => {
    expect(() => buildDescriptionHtml(undefined)).toThrow(/NO default/);
    expect(() => buildDescriptionHtml("Mint")).toThrow();
    expect(() => buildDescriptionHtml("")).toThrow();
  });
  it("substitutes the condition into the fixed template", () => {
    for (const c of CONDITIONS) {
      const html = buildDescriptionHtml(c);
      expect(html).toContain("Curated by Marathon Club");
      expect(html).toContain(`<strong>Condition:</strong> ${c}`);
      expect(html).toContain("checked by hand");
      expect(html).toContain('href="/pages/returns-and-condition"');
      expect(html).toContain("14-day exchange on anything faulty");
      expect(isTriggerFree(html)).toBe(true);
    }
  });
});

describe("builders", () => {
  it("handle derives from the cleaned title, slug-safe", () => {
    expect(buildHandle("Low-top sneaker black — 100ml")).toBe("low-top-sneaker-black-100ml");
    expect(() => buildHandle("—")).toThrow();
    expect(() => buildHandle("")).toThrow();
  });
  it("vendor is the fixed string", () => {
    expect(VENDOR).toBe("Marathon Club");
  });
  it("tags carry only category/subcategory", () => {
    expect(buildTags({ category: "Footwear", subcategory: "Sneakers", brand: "Nike" }))
      .toEqual(["Footwear", "Sneakers"]);
    expect(buildTags({})).toEqual([]);
  });
});

describe("validatePayload — the pre-flight gate", () => {
  it("passes a fully clean payload", () => {
    expect(validatePayload(cleanPayload())).toEqual({ ok: true, violations: [] });
  });

  // One deliberately dirty payload PER FIELD (owner spec) — each must be
  // refused, and the violation must name the field.
  const dirtyPerField = [
    ["title", (p) => { p.title = "Nike Air Force 1 black"; }],
    ["handle", (p) => { p.handle = "air-jordan-1-mid"; }],
    ["vendor", (p) => { p.vendor = "Nike"; }],
    ["productType", (p) => { p.productType = "Yeezy slides"; }],
    ["tags[0]", (p) => { p.tags = ["NOCTA"]; }],
    ["descriptionHtml", (p) => { p.descriptionHtml += "<p>Genuine AirMax stock.</p>"; }],
    ["seo.title", (p) => { p.seo.title = "Jordan retro | Marathon Club"; }],
    ["seo.description", (p) => { p.seo.description = "Off-White belt, checked by hand."; }],
    ["media[0].alt", (p) => { p.media[0].alt = "AIRFORCE1 side view"; }],
  ];
  for (const [field, dirty] of dirtyPerField) {
    it(`refuses a trigger in ${field}`, () => {
      const p = cleanPayload();
      dirty(p);
      const res = validatePayload(p);
      expect(res.ok).toBe(false);
      expect(res.violations.map((v) => v.field)).toContain(field);
    });
  }

  it("enforces title guards and the fixed vendor", () => {
    expect(validatePayload({ ...cleanPayload(), title: "" }).ok).toBe(false);
    expect(validatePayload({ ...cleanPayload(), title: "9060 grey" }).ok).toBe(false);
    expect(validatePayload({ ...cleanPayload(), vendor: "marathon club" }).ok).toBe(false);
    expect(validatePayload({ ...cleanPayload(), handle: "Bad Handle!" }).ok).toBe(false);
  });

  it("catches concatenated and misspelt triggers in any field", () => {
    const p = cleanPayload();
    p.tags = ["nikeairmax"];
    expect(validatePayload(p).ok).toBe(false);
    const q = cleanPayload();
    q.descriptionHtml += "<p>Lacoster style.</p>";
    expect(validatePayload(q).ok).toBe(false);
  });
});

describe("docs/RETURNS-AND-CONDITION.md", () => {
  const doc = readFileSync(new URL("../../docs/RETURNS-AND-CONDITION.md", import.meta.url), "utf8");
  it("contains no trigger term anywhere", () => {
    expect(isTriggerFree(doc), "returns doc trips the trigger lexicon").toBe(true);
  });
  it("covers every required clause", () => {
    for (const c of CONDITIONS) expect(doc).toContain(c);
    expect(doc).toContain("sold as found");
    expect(doc).toContain("No manufacturer warranty");
    expect(doc).toContain("independent reseller");
    expect(doc).toContain("not an authorised dealer for");
    expect(doc).toContain("not affiliated with");
    expect(doc).toContain("endorsed by, any third-party rights holder");
    expect(doc).toContain("14 days of\ndelivery");
  });
  it("never states or implies branded goods are featured", () => {
    expect(doc.toLowerCase()).not.toContain("branded");
    expect(doc.toLowerCase()).not.toContain("designer");
    expect(doc.toLowerCase()).not.toContain("authentic");
    expect(doc.toLowerCase()).not.toContain("genuine");
  });
});
