// ─── SHOPIFY PUBLISHING — THE BUTTONS' DECISIONS, WITHOUT FIREBASE ───────────
// Each Shopify Publishing button is a transaction on /shopify_publish/{pid}.
// What the transaction DECIDES — refuse, or the next node — lives here, with
// no Firebase import, so that exactly the same decision runs in two places:
//
//   • the browser (shopifyPublishStore.js wraps each in runTransaction), and
//   • the New Arrivals chain on the Mac mini (scripts/newArrivals/chain.mjs
//     wraps each in an Admin SDK transaction) — the agents perform the same
//     action the button does by calling the same code, never a copy of it.
//
// Every mutator takes (base, args, ctx) where `base` is the server's node (or
// the caller's snapshot on the cold-cache first call), `ctx` is
// { now: serverNowMs(), uid }, and returns { next } or { refusal }.
import { CONDITIONS, checkCleanName, isOn, canGoLive, normalizedState, normalizedFields,
         NAME_PROPOSAL_KEY, PROPOSAL_APPROVED_SOURCE, proposalApplyBlocker } from "./shopifyPublishCore.js";
import { MAX_PUBLISH_PHOTOS, APP_STORAGE_PREFIX, normalizePhotoList, normalizeMediaItems, cleanMediaItem,
         mergePhotosIntoMedia, mediaListProblem, photoUrlsOf, storedMediaKey } from "./publishShared.js";
import { buildOffRecord, offAuditFields } from "./publishAudit.js";

const stamp = (ctx) => ({ updatedAt: ctx.now, updatedBy: ctx.uid ?? null });

// What a publishing photo list may contain — the client-side mirror of the
// media.mjs guards. Pinned to THIS app's bucket (the prefix now lives in
// publishShared.js, beside the media list it also guards).
export { APP_STORAGE_PREFIX };
export function publishPhotoListProblem(photos) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return "The photo set can't be empty — a product never ships imageless.";
  }
  if (photos.length > MAX_PUBLISH_PHOTOS) {
    return `At most ${MAX_PUBLISH_PHOTOS} photos per product.`;
  }
  const trimmed = photos.map((u) => (typeof u === "string" ? u.trim() : u));
  if (new Set(trimmed).size !== trimmed.length) return "The photo set has a duplicate.";
  for (const u of trimmed) {
    if (typeof u !== "string" || u === "") return "The photo set has an empty entry.";
    try { new URL(u); } catch { return "The photo set has an invalid URL."; }
    if (!u.startsWith(APP_STORAGE_PREFIX)) {
      return "Photos must be this app's own Firebase Storage URLs.";
    }
  }
  return null;
}

/** Pre-transaction argument checks (no node needed). Returns a message or null. */
export const precheck = {
  approveName: (name) => { const v = checkCleanName(name); return v.ok ? null : v.problems.join("; "); },
  publish: (name) => { const v = checkCleanName(name); return v.ok ? null : v.problems.join("; "); },
  condition: (condition) => (CONDITIONS.includes(condition) ? null : "Not one of the three condition grades."),
  photos: (photos) => (photos === null ? null : publishPhotoListProblem(photos.map((u) => (typeof u === "string" ? u.trim() : u)))),
  media: (items) => mediaListProblem(items),
  desiredState: (want) => (want === "on" || want === "off" ? null : "Switch must be on or off."),
};

export function approveNameMutator(base, { name, source = "manual" }, ctx) {
  if (isOn(base)) return { refusal: "Listing is ON the storefront — switch it off before renaming." };
  return { next: { ...base, ...normalizedFields(base), cleanName: String(name).trim(), cleanNameSource: source,
                   nameApprovedAt: ctx.now, ...stamp(ctx) } };
}

export function applyProposalMutator(base, { seenProposedAt = null }, ctx) {
  const gate = proposalApplyBlocker(base);
  if (!gate.ok) return { refusal: gate.reason };
  const proposal = base[NAME_PROPOSAL_KEY];
  // THE REVIEWER MAY ONLY APPROVE THE NAME HE WAS SHOWN (see shopifyPublishStore.js).
  if (seenProposedAt != null && Number(proposal?.proposedAt) !== Number(seenProposedAt)) {
    return { refusal: "A newer suggestion arrived for this product while you were reading — nothing was changed. The name shown now is the new one." };
  }
  return { next: {
    ...base, ...normalizedFields(base),
    cleanName: String(proposal.name).trim(),
    cleanNameSource: PROPOSAL_APPROVED_SOURCE,
    nameApprovedAt: ctx.now,
    [NAME_PROPOSAL_KEY]: { ...proposal, status: "applied", decidedAt: ctx.now },
    ...stamp(ctx),
  } };
}

export function dismissProposalMutator(base, { seenProposedAt = null }, ctx) {
  const proposal = base[NAME_PROPOSAL_KEY];
  if (!proposal || proposal.status !== "pending") return { refusal: "That suggestion has already been decided." };
  if (seenProposedAt != null && Number(proposal.proposedAt) !== Number(seenProposedAt)) {
    return { refusal: "A newer suggestion arrived for this product while you were reading — nothing was changed. The name shown now is the new one." };
  }
  return { next: { ...base, ...normalizedFields(base),
                   [NAME_PROPOSAL_KEY]: { ...proposal, status: "rejected", decidedAt: ctx.now }, ...stamp(ctx) } };
}

export function publishMutator(base, { name, source = "manual" }, ctx) {
  if (isOn(base)) return { refusal: "Already ON the storefront — refresh the page to see its current state." };
  if (!canGoLive(base)) return { refusal: "Condition not set — a product cannot go live without one of the three grades." };
  return { next: { ...base, ...normalizedFields(base),
                   cleanName: String(name).trim(), cleanNameSource: source, nameApprovedAt: ctx.now,
                   desiredState: "on", blockedReason: null, ...stamp(ctx) } };
}

export function desiredStateMutator(base, { want, reasonCode = "switched_off", detail = null }, ctx) {
  if (want === "on" && !canGoLive(base)) {
    return { refusal: "Condition not set — a product cannot go live without one of the three grades." };
  }
  if (want === "on") {
    return { next: { ...base, ...normalizedFields(base), desiredState: "on", blockedReason: null, ...stamp(ctx) } };
  }
  const at = ctx.now;
  const record = buildOffRecord({ at, actor: ctx.uid ?? "unknown", reasonCode, detail });
  return { next: { ...base, ...normalizedFields(base), desiredState: "off", ...offAuditFields(base, record, at), ...stamp(ctx) } };
}

/** `basisPhotos` is the photo list the edit was computed FROM (optimistic concurrency). */
export function photosMutator(base, { photos, basisPhotos }, ctx) {
  if (isOn(base)) return { refusal: "Listing is ON the storefront — switch it off before changing its photos." };
  if (JSON.stringify(normalizePhotoList(base.photos)) !== JSON.stringify(normalizePhotoList(basisPhotos))) {
    return { refusal: "The photo set changed in another session — reopen the strip and redo the edit." };
  }
  const clean = photos === null ? null : photos.map((u) => (typeof u === "string" ? u.trim() : u));
  // A photos-only writer (the New Arrivals chain) must not strand the media
  // list: when one exists it follows — photos in the new order, videos kept
  // in their places, position 0 a photo. Clearing the photos clears both
  // (back to the record's own photo).
  const media = normalizeMediaItems(base.media);
  const nextMedia = clean === null ? null : media ? mergePhotosIntoMedia(media, clean) : undefined;
  return { next: { ...base, ...normalizedFields(base), photos: clean,
                   ...(nextMedia !== undefined ? { media: nextMedia } : {}), ...stamp(ctx) } };
}

/**
 * THE MEDIA LIST WRITE — photos and videos, ordered, first = the primary
 * photo. Unlike photosMutator this is NOT refused while the listing is ON:
 * Junid's media changes reach a live product through the reconciler on its
 * next tick with no extra tap (6 Oct 2026), and nothing here can change what
 * the storefront NAMES the product.
 *
 * `basisKey` is storedMediaKey() of the node the edit was computed from —
 * optimistic concurrency, so an edit made from a stale screen is refused
 * rather than silently dropping another session's photo. `basisPhotos` is the
 * photo list the page SHOWED (the resolved list); on a node's first media
 * write it is kept as `mediaBasis`, which is how the reconciler recognises the
 * photos it already pushed to a live product and leaves them in place.
 */
export function mediaMutator(base, { media, basisKey, basisPhotos = null }, ctx) {
  if (storedMediaKey(base) !== basisKey) {
    return { refusal: "The photos and videos changed in another session — nothing was saved. The list now shows the latest; redo the change." };
  }
  const problem = mediaListProblem(media);
  if (problem) return { refusal: problem };
  const clean = media.map(cleanMediaItem);
  const firstWrite = !normalizeMediaItems(base.media) && base.mediaBasis == null;
  const basis = firstWrite ? normalizePhotoList(basisPhotos) : null;
  return { next: { ...base, ...normalizedFields(base), media: clean, photos: photoUrlsOf(clean),
                   ...(basis ? { mediaBasis: basis } : {}), ...stamp(ctx) } };
}

export function conditionMutator(base, { condition }, ctx) {
  if (isOn(base)) return { refusal: "Listing is ON the storefront — switch it off before changing the condition." };
  const unblocking = normalizedState(base) === "blocked";
  return { next: { ...base, ...normalizedFields(base), condition,
                   ...(unblocking ? { state: "awaiting", blockedReason: null } : {}), ...stamp(ctx) } };
}
