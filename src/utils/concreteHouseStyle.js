// ─── CONCRETE HOUSE STYLE — the shared rules (browser + Mac mini worker) ──────
// Junid (15 Nov 2026): every Concrete product gets a FULL AI-generated studio
// photo — Gemini image, from scratch, clean white background — using the
// product's own photo as the subject, his reference library as the style, and
// an editable house-style prompt. Paid generation is his deliberate exception
// for Concrete; cost is shown per image and a batch shows its total and needs
// one confirm tap before anything is spent.
//
// Nothing generated is ever published until a human approves it. The original
// photo is always kept; an approved image becomes the product's CONCRETE
// publishing photo only — Marathon's photos never change.
//
//   /config/concrete_house_style = { prompt, model, refs: { refId: { url, path, addedAt, by } }, updatedAt }
//   /concrete_house_style/{pid} = {
//       status: queued | running | awaiting_approval | approved | rejected | failed,
//       requestedAt, requestedBy, attempts, estimateUsd,
//       url, path, model, costUsd, generatedAt,            // the generated image
//       subjectUrl,                                        // the original it was made from
//       error, flaggedAt,                                  // failed twice → flagged
//       approvedAt, approvedBy, rejectedAt, rejectedBy,
//   }
export const HOUSE_STYLE_CONFIG_PATH = "config/concrete_house_style";
export const HOUSE_STYLE_JOBS_PATH = "concrete_house_style";
export const HOUSE_STYLE_REFS_STORAGE = "concrete_style_refs";
export const MAX_STYLE_REFS_SENT = 6;      // Nano Banana Pro takes up to 14 images; 6 refs + subject keeps requests lean
export const MAX_ATTEMPTS = 2;             // "failures retry once, then flag"
export const USD_TO_ZAR = 18.0;            // the rate the repo already quotes rand with

export const STATUS = Object.freeze({
  QUEUED: "queued", RUNNING: "running", AWAITING: "awaiting_approval",
  APPROVED: "approved", REJECTED: "rejected", FAILED: "failed",
});

// Models the worker may use. Price = the documented per-image figure (2K,
// square); the worker records the MEASURED cost from usageMetadata per image.
export const MODELS = Object.freeze({
  nbpro: { id: "gemini-3-pro-image", label: "Gemini 3 Pro Image (best for style references)", estimateUsd: 0.134 },
  flash: { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image (cheaper)", estimateUsd: 0.067 },
});
export const DEFAULT_MODEL = "nbpro";

export const DEFAULT_PROMPT =
  "Create a professional e-commerce studio product photograph of the SUBJECT product on a pure, seamless white " +
  "background (#FFFFFF). Reproduce the product exactly as it appears in the subject photo: the same shape, " +
  "proportions, colours, materials, textures, stitching, logos and every detail — do not redesign, simplify, add " +
  "or remove anything. Soft, even, high-key studio lighting; a subtle natural contact shadow directly beneath the " +
  "product; product centred and filling about 80% of a square frame; tack-sharp focus; true-to-life colour. No " +
  "props, no text, no watermark, no people, no hands, no mannequin, no box or packaging unless it is in the " +
  "subject photo. Match the lighting, framing, shadow and overall look of the STYLE REFERENCES.";

export const modelFor = (key) => MODELS[key] || MODELS[DEFAULT_MODEL];
export const estimateUsd = (cfg) => modelFor(cfg?.model).estimateUsd;
export const usdToZar = (usd) => Math.round(Number(usd || 0) * USD_TO_ZAR * 100) / 100;
export const money = (usd) => `$${Number(usd || 0).toFixed(3)} (≈ R${usdToZar(usd).toFixed(2)})`;

/** The subject photo(s): the record's AI source copy first, then the photo, then one gallery shot. */
export function subjectUrls(product) {
  const out = [];
  const push = (u) => { if (typeof u === "string" && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u); };
  push(product?.photoSourceUrl);
  push(product?.photoUrl);
  if (Array.isArray(product?.gallery)) push(product.gallery[0]);
  return out.slice(0, 2);
}

/** Enabled refs, newest first, capped. */
export function refsToSend(cfg) {
  return Object.entries(cfg?.refs || {})
    .filter(([, r]) => r && r.url && r.enabled !== false)
    .sort(([, a], [, b]) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0))
    .slice(0, MAX_STYLE_REFS_SENT)
    .map(([id, r]) => ({ id, url: r.url }));
}

/**
 * The Gemini request parts — labelled so the model cannot confuse the item to
 * render with the scene to copy. `img(x)` turns a fetched image into a part.
 */
export function buildParts({ prompt, subjects, refs, img }) {
  const parts = [{ text: (prompt || DEFAULT_PROMPT).trim() }, { text: "SUBJECT — the product to photograph (reproduce it exactly):" }];
  for (const s of subjects) parts.push(img(s));
  if (refs.length) {
    parts.push({ text: "STYLE REFERENCES — match this lighting, white background, framing and shadow. Do NOT copy any product from these:" });
    for (const r of refs) parts.push(img(r));
  }
  return parts;
}

/** What a failed attempt leaves behind: queued again once, then failed + flagged. */
export function afterFailure(job, error, nowMs) {
  const attempts = (Number(job?.attempts) || 0);
  const msg = String(error || "unknown error").slice(0, 500);
  if (attempts < MAX_ATTEMPTS) return { status: STATUS.QUEUED, error: msg, lastErrorAt: nowMs };
  return { status: STATUS.FAILED, error: msg, flaggedAt: nowMs };
}

/** The queue write for a batch (one multi-path update). */
export function buildQueueUpdate({ pids, uid, nowMs, cfg }) {
  const est = estimateUsd(cfg);
  const u = {};
  for (const pid of pids) {
    u[`${HOUSE_STYLE_JOBS_PATH}/${pid}`] = { status: STATUS.QUEUED, requestedAt: nowMs, requestedBy: uid, attempts: 0, estimateUsd: est, model: cfg?.model || DEFAULT_MODEL };
  }
  return u;
}
