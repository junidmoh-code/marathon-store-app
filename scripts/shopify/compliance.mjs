// ── Full-field compliance for the Shopify push ───────────────────────────────
// NOTHING pushed to Shopify may contain a brand trigger, in ANY field — the
// payment gateway keyword-flags brand terms wherever they appear, and one hit
// triggers a documentation review. The title alone passing is not enough:
// handle, vendor, productType, tags, descriptionHtml, SEO title/description
// and image alt text all travel with the product.
//
// This module owns the pushed-field builders and the ONE pre-flight validator
// (validatePayload) that refuses any payload containing a trigger in any
// field. Every push path calls it LAST, after all builders — nothing reaches
// the Shopify client without a pass. Pure functions, no I/O.
import { triggersInText } from "../../src/utils/shopifyTriggers.js";

// Vendor is a FIXED string — never a brand, never derived from the record.
export const VENDOR = "Marathon Club";

// Condition values, exactly these three (owner spec). Condition has NO
// default: a product with condition unset is state=blocked and cannot be
// pushed — buildDescriptionHtml throws rather than invents one.
export const CONDITIONS = [
  "Excellent — no visible wear",
  "Very good — light cosmetic marks",
  "Good — visible wear, priced accordingly",
];

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The one description template. {condition} is the only substitution.
export function buildDescriptionHtml(condition) {
  if (!CONDITIONS.includes(condition)) {
    throw new Error(
      `condition must be one of the three fixed values, got: ${JSON.stringify(condition)}. ` +
        `There is NO default — an unset condition blocks the push.`
    );
  }
  return (
    `<p>Curated by Marathon Club. Sourced from clearance, factory surplus and pre-loved stock — each piece is limited and rarely restocked.</p>\n` +
    `<p><strong>Condition:</strong> ${escapeHtml(condition)}</p>\n` +
    `<p>Every item is checked by hand before listing. Original packaging isn't always included.</p>\n` +
    `<p>14-day exchange on anything faulty. Full detail on our <a href="/pages/returns-and-condition">Returns &amp; Condition</a> page.</p>`
  );
}

// Handle derives from the CLEANED title only — set explicitly so Shopify can
// never derive it from a dirty source. Lowercase alnum + single hyphens.
export function buildHandle(cleanTitle) {
  const handle = String(cleanTitle ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!handle) throw new Error(`cannot build a handle from title: ${JSON.stringify(cleanTitle)}`);
  return handle;
}

// SEO fields, built only from already-clean inputs (validated again anyway).
export function buildSeo(cleanTitle, condition) {
  return {
    title: `${cleanTitle} | Marathon Club`,
    description: `${cleanTitle}. Condition: ${condition}. Curated by Marathon Club — limited stock, checked by hand before listing.`,
  };
}

// Tags carry the record's own browse vocabulary — category + subcategory.
// Anything else (brand fields especially) stays out.
export function buildTags(product) {
  return [product?.category, product?.subcategory].filter(
    (t) => typeof t === "string" && t.trim() !== ""
  );
}

// ── THE pre-flight validator ─────────────────────────────────────────────────
// Walks EVERY pushed string field and refuses the payload when any contains a
// trigger. Also enforces the structural guards on the title. Returns
// { ok, violations: [{ field, problem }] } — callers must not push unless ok.
//
// payload shape (superset tolerated; absent optional fields are skipped):
//   { title, handle, vendor, productType, tags: [], descriptionHtml,
//     seo: { title, description }, media: [{ alt, originalSource }],
//     variants: [{ sku }] }
//
// Media source URLs are pushed fields too (Shopify fetches and keeps them, and
// the filename shows in admin): the DECODED PATH of each originalSource is
// trigger-checked. Deliberately not the query string — Firebase Storage access
// tokens are random and a random token containing "puma" must not block a
// clean product; the path is the only part a human named.
export function validatePayload(payload) {
  const violations = [];
  const check = (field, value) => {
    if (value == null) return;
    const hits = triggersInText(value);
    if (hits.length) violations.push({ field, problem: `brand trigger(s): ${hits.join(", ")}` });
  };

  const title = payload?.title;
  if (!title || String(title).trim() === "") {
    violations.push({ field: "title", problem: "empty" });
  } else {
    if (/^\d/.test(String(title))) violations.push({ field: "title", problem: "digit-leading" });
    if (String(title).trim().length < 3) violations.push({ field: "title", problem: "under 3 chars" });
    if (String(title).trim().length > 80) violations.push({ field: "title", problem: "over 80 chars" });
  }
  check("title", title);

  if (payload?.handle != null && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(payload.handle)) {
    violations.push({ field: "handle", problem: "not a clean lowercase-hyphen slug" });
  }
  check("handle", payload?.handle);

  if (payload?.vendor !== VENDOR) {
    violations.push({ field: "vendor", problem: `must be the fixed string "${VENDOR}"` });
  }
  check("vendor", payload?.vendor);

  check("productType", payload?.productType);
  for (const [i, tag] of (payload?.tags ?? []).entries()) check(`tags[${i}]`, tag);
  check("descriptionHtml", payload?.descriptionHtml);
  check("seo.title", payload?.seo?.title);
  check("seo.description", payload?.seo?.description);
  for (const [i, m] of (payload?.media ?? []).entries()) {
    check(`media[${i}].alt`, m?.alt);
    if (m?.originalSource != null) {
      let path = String(m.originalSource);
      try { path = decodeURIComponent(new URL(m.originalSource).pathname); } catch { /* checked raw */ }
      const hits = triggersInText(path);
      if (hits.length) {
        violations.push({ field: `media[${i}].originalSource`, problem: `brand trigger(s) in URL path: ${hits.join(", ")}` });
      }
    }
  }
  for (const [i, v] of (payload?.variants ?? []).entries()) check(`variants[${i}].sku`, v?.sku);

  return { ok: violations.length === 0, violations };
}
