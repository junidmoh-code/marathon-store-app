// ─── AUTOMATIC ENRICHMENT + PROFILE FOR THE ALTERNATIVES SHEET ───────────────
//
// WHY (2026-10-09). Attributes were written by a hand-run script, once, on
// 6 September. Every sneaker created after that — 80 gated sneakers, among
// them Junid's "Nike Air Force 1 Low Ducks of a Feather" — had no attributes
// and no place in anyone's suggestions. Owner rule: automated or not at all.
//
// So a product write now does, for that one product:
//   1. VISION, only when needed — no attribute record at the current extractor
//      version, or the photo the record was read from has been replaced. One
//      Gemini call (one retry on a refused answer), the same prompt, parser and
//      record builder as scripts/shopify/extract-attributes.mjs. Never for a
//      product already current: re-running costs nothing.
//   2. THE PROFILE — family (name, vision namer's model, label model name,
//      Nike style-code sibling) + resolved attributes → the short `altProfile`
//      string the order screen ranks on. Written only when it changed, so the
//      trigger's own write wakes it once more and stops there.
//
// Guards, because this runs on the busiest product node:
//   • a claim per product (10 min) so two quick edits do not pay twice;
//   • a daily cap on vision calls — a write storm cannot become a bill;
//   • /config/alternatives/autoEnrich === false stops vision (profiles still
//     update); absent means ON;
//   • a failed vision call is recorded at /alt_enrich/failures/{pid} and
//     retried by the daily sweep; the profile is written anyway from the
//     name, so the product is offered meanwhile;
//   • nothing is ever written onto a product that no longer exists (a child
//     write would resurrect it as a record with no `id`).
//
// Every dependency is injected — db, the vision call, the clock — so the whole
// decision is node-tested without firebase or a network.

import {
  ATTRIBUTES_PATH, EXTRACTOR_VERSION, buildAttributeRecord, isCurrentExtraction, usableAttributes,
} from "./alt-shared/productAttributes.js";
import { ATTRIBUTE_PROMPT, parseAttributeResponse, attributeRetryNote } from "./alt-shared/attributeExtraction.js";
import { ALT_PROFILE_FIELD, deriveAltProfile, encodeAltProfile } from "./alt-shared/altProfile.js";
import { modelFamilyOf, familyRuleFor, styleBase } from "./alt-shared/modelFamily.js";
import { productIsFootwear } from "./alt-shared/footwearLine.js";
import { THINKING_CONFIG, VISION_MODEL_DEFAULT } from "./alt-shared/visionNaming.js";

export const ENRICH_ROOT = "alt_enrich";
export const ENRICH_SWITCH_PATH = "config/alternatives/autoEnrich";
export const DAILY_VISION_CAP = 200;
export const CLAIM_MS = 10 * 60 * 1000;
/** A photo that fails this many times is left for a person to look at. */
export const MAX_ATTEMPTS = 5;

// The product fields the profile (or the vision record) is built from. A write
// that changes none of them — the trigger's own altProfile write, a neighbour
// list, a stock flag — is a no-op.
export const PROFILE_INPUTS = Object.freeze([
  "name", "brand", "category", "categoryKey", "productType", "photoUrl", "retailPrice",
  "styleCodeNormalised", "labelModelName", "mergedInto", "altRefreshAt",
]);

export function profileInputsChanged(before, after) {
  if (!after) return false;
  if (!before) return true;
  return PROFILE_INPUTS.some((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

/** Is this a product the alternatives sheet can offer? */
export function inAlternativesScope(p) {
  return !!(p && p.id && !p.mergedInto && productIsFootwear(p) && (p.productType || "sneaker") !== "clothing");
}

/**
 * The photo's identity: its URL without the query string. A Storage download
 * token can be rotated (or a bulk URL rewrite run) without the picture
 * changing, and that must not re-bill a vision read (architect review).
 */
export function photoIdentity(url) {
  return String(url || "").trim().split("?")[0];
}

/** Does this product need a (new) vision read? */
export function needsVision(product, node) {
  const photo = String(product?.photoUrl || "").trim();
  if (!photo) return false;
  if (!isCurrentExtraction(node, EXTRACTOR_VERSION)) return true;
  // Records written before 2026-10-09 carry no photo stamp: they are trusted
  // as they are — re-reading 1,400 photos to find the few that changed would
  // re-bill the whole catalogue.
  return !!node.photo && photoIdentity(node.photo) !== photoIdentity(photo);
}

/** The SAST calendar day of a ms timestamp, for the daily cap. */
export function sastDay(ms) {
  return new Date(ms + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * One Gemini vision call — the transport scripts/shopify/visionCall.mjs uses
 * (same body, thinking off, JSON out, temperature 0.1 as the extractor uses).
 * A timeout is NOT retried: a timed-out generation may already be charged.
 */
export function makeVisionCall({ fetchImpl = fetch, apiKey, model = VISION_MODEL_DEFAULT }) {
  return async (photoUrl, prompt, extra = []) => {
    if (!apiKey) throw new Error("no GEMINI_API_KEY");
    const img = await fetchImpl(photoUrl, { signal: AbortSignal.timeout(30000) });
    if (!img.ok) throw new Error(`photo HTTP ${img.status}`);
    const mimeType = img.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const data = Buffer.from(await img.arrayBuffer()).toString("base64");
    const parts = [{ inlineData: { mimeType, data } }, { text: prompt }];
    for (const t of extra) if (t) parts.push({ text: t });
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", thinkingConfig: { ...THINKING_CONFIG } },
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) throw new Error("Gemini returned no text");
    return text;
  };
}

const val = async (db, path) => (await db.ref(path).get()).val();

// A transaction that takes the claim when it is free or stale. RTDB calls the
// handler with the CACHED value first (null when nothing is cached) — for a
// "set if absent" that is exactly right: the server rejects the guess and the
// handler runs again with the real value.
async function takeClaim(db, pid, photo, now) {
  const r = await db.ref(`${ENRICH_ROOT}/claims/${pid}`).transaction((cur) => {
    if (cur && Number(cur.at) > now - CLAIM_MS && cur.photo === photo) return undefined;
    return { at: now, photo };
  });
  return !!r.committed;
}

async function takeBudget(db, now, cap) {
  const r = await db.ref(`${ENRICH_ROOT}/budget/${sastDay(now)}`).transaction((cur) => {
    const n = Number(cur) || 0;
    return n >= cap ? undefined : n + 1;
  });
  return !!r.committed;
}

// A Nike/Jordan style-code sibling's family: products whose normalised code
// shares the 6-character model base, through the styleCodeNormalised INDEX —
// a bounded query, never a scan.
async function siblingFamily(db, product) {
  const base = styleBase(product?.styleCodeNormalised);
  if (!base) return "";
  const snap = await db.ref("products").orderByChild("styleCodeNormalised")
    .startAt(`${base}000`).endAt(`${base}999`).limitToFirst(12).get();
  let found = "";
  snap.forEach((child) => {
    const q = child.val();
    if (found || !q || child.key === product.id || q.mergedInto) return;
    const rule = familyRuleFor(q.name) || familyRuleFor(q.labelModelName);
    if (rule) found = rule.id;
  });
  return found;
}

/**
 * Enrich (when needed) and index one product.
 *
 * deps: { db, now: () => ms, vision: (photo, prompt, extra) => text | null,
 *         serverTimestamp, model, cap, log }
 * Returns { status, wrote, vision } — status is one of
 *   gone | out-of-scope | unchanged | written
 */
export async function refreshAltProfile(deps, pid, { allowVision = true } = {}) {
  const { db, now = () => Date.now(), vision = null, serverTimestamp, model = VISION_MODEL_DEFAULT,
          cap = DAILY_VISION_CAP, log = () => {} } = deps;
  // RE-READ. The event payload may be stale by the time this runs.
  const product = await val(db, `products/${pid}`);
  if (!product?.id) return { status: "gone", wrote: false, vision: "none" };
  if (!inAlternativesScope(product)) return { status: "out-of-scope", wrote: false, vision: "none" };

  let node = await val(db, `${ATTRIBUTES_PATH}/${pid}`);
  let visionOutcome = "not-needed";
  const photo = String(product.photoUrl || "").trim();
  if (allowVision && needsVision(product, node)) {
    const on = (await val(db, ENRICH_SWITCH_PATH)) !== false;
    const t = now();
    if (!on) visionOutcome = "switched-off";
    else if (!vision) visionOutcome = "no-key";
    else if (!(await takeClaim(db, pid, photo, t))) visionOutcome = "claimed";
    else if (!(await takeBudget(db, t, cap))) {
      visionOutcome = "over-budget";
      await db.ref(`${ENRICH_ROOT}/failures/${pid}`).set({ at: t, photo, error: "daily vision cap reached" });
    } else {
      try {
        let parsed = parseAttributeResponse(await vision(photo, ATTRIBUTE_PROMPT, []));
        // The retry is a second paid call, so it takes its own unit of the cap.
        if (!parsed.ok && (await takeBudget(db, t, cap))) {
          parsed = parseAttributeResponse(await vision(photo, ATTRIBUTE_PROMPT, [attributeRetryNote(parsed)]));
        }
        if (!parsed.ok) throw new Error(`unusable answer: ${parsed.error}`);
        const record = buildAttributeRecord({
          vision: parsed.vision, product, model, at: serverTimestamp ?? t, previousVersion: node?.v ?? null,
        });
        // The photo this record was read from — additive; how a replaced photo
        // is noticed next time.
        record.photo = photo;
        // Never resurrect: the product must still be there.
        if (!(await val(db, `products/${pid}/id`))) return { status: "gone", wrote: false, vision: "skipped" };
        await db.ref(`${ATTRIBUTES_PATH}/${pid}`).update(record);
        await db.ref(`${ENRICH_ROOT}/failures/${pid}`).remove();
        node = { ...(node || {}), ...record };
        visionOutcome = "read";
      } catch (e) {
        visionOutcome = "failed";
        log(`alternativesProfile ${pid}: vision failed: ${String(e?.message || e)}`);
        const prev = await val(db, `${ENRICH_ROOT}/failures/${pid}`);
        const n = (prev && prev.photo === photo ? Number(prev.n) || 1 : 0) + 1;
        await db.ref(`${ENRICH_ROOT}/failures/${pid}`).set({ at: t, photo, n, error: String(e?.message || e).slice(0, 300) });
      }
    }
  }

  // A failure record outlives its reason once vision is not needed any more
  // (current by another route, photo removed) — clear it so the sweep does not
  // keep spending its slots on it (architect review).
  if (visionOutcome === "not-needed" && allowVision) {
    if (await val(db, `${ENRICH_ROOT}/failures/${pid}/at`)) await db.ref(`${ENRICH_ROOT}/failures/${pid}`).remove();
  }

  const attrs = usableAttributes(node);
  const identityModel = (await val(db, `product_identity/${pid}/model`)) || "";
  // The sibling query runs only when no text names the model — it is the
  // fourth source, above the name fallback (modelFamilyOf's order).
  const named = familyRuleFor(product.name) || familyRuleFor(identityModel) || familyRuleFor(product.labelModelName);
  const sib = named ? "" : await siblingFamily(db, product);
  const family = modelFamilyOf({
    name: product.name, brand: product.brand, identityModel, labelModelName: product.labelModelName, siblingFamily: sib,
  });
  const encoded = encodeAltProfile(deriveAltProfile(product, { attrs, family }));
  if (product[ALT_PROFILE_FIELD] === encoded) return { status: "unchanged", wrote: false, vision: visionOutcome };
  if (!(await val(db, `products/${pid}/id`))) return { status: "gone", wrote: false, vision: visionOutcome };
  await db.ref(`products/${pid}/${ALT_PROFILE_FIELD}`).set(encoded);
  // RTDB has no conditional write, so a delete landing between the check and
  // the write would leave a record holding only `altProfile` — no `id`,
  // invisible to every list. Look again and take it back out if so; removing
  // the last child removes the stub (architect review).
  if (!(await val(db, `products/${pid}/id`))) {
    await db.ref(`products/${pid}/${ALT_PROFILE_FIELD}`).remove();
    return { status: "gone", wrote: false, vision: visionOutcome };
  }
  return { status: "written", wrote: true, vision: visionOutcome, profile: encoded };
}
