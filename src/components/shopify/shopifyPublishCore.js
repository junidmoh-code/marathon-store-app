// ─── SHOPIFY PUBLISHING — PURE CORE ──────────────────────────────────────────
// The decision logic behind the Shopify Publishing page, kept free of
// firebase imports so it is unit-testable and shares nothing but the trigger
// engine with the owner-run scripts. The page and the client store import
// from here; scripts/shopify/* has its own server-side twin of the condition
// list (compliance.mjs) — the two are pinned equal by the tests.
import { triggersInText, cleanTitleFor } from "../../utils/shopifyTriggers";
import { NAME_PROPOSAL_KEY, isPendingProposal, isRefusedProposal, validateVisionName } from "../../utils/visionNaming";
import { isPriceRecord } from "../../utils/productCategory";
import { normalizePhotoList, CONDITIONS } from "./publishShared";
import { staleHandleBlock } from "../../utils/shopifyHandle";

// Condition values, exactly these three (owner spec 2026-08-13). NO default:
// a product with condition unset is state=blocked and cannot be pushed.
// Single-sourced from publishShared.js (with the description template the
// values feed); re-exported so the page and store keep their import path.
export { CONDITIONS };

// ─── STATE MODEL (owner spec 2026-08-14) ─────────────────────────────────────
// Three states only — the old Approve → Nominate → Live chain is collapsed to
// a single Publish action:
//   awaiting — under review; the default for any touched product
//   live     — the product EXISTS on Shopify; `liveState` says whether it is
//              ON (published to the Online Store channel) or OFF (unpublished,
//              but never archived or deleted — it can be switched back on)
//   blocked  — cannot go live: condition unset, or the reconciler's apply-time
//              validator refused (its reason lands in `blockedReason`)
//
// The browser NEVER talks to Shopify. The page writes INTENT only — a
// `desiredState` ("on"|"off") field — and the owner-run reconciler
// (scripts/shopify/reconcile.mjs) applies it with credentials, then writes the
// confirmed `state`/`liveState` back. A row whose desiredState differs from
// its confirmed state shows as pending until the reconciler catches up.
// The publishing-state vocabulary and the two predicates now live in
// publishState.js — a module with no imports, so the Admin-SDK scripts can
// load it under plain Node and stop hand-rolling their own narrower `isOn`.
// Re-exported here so every existing import path is unchanged.
export { PUBLISH_STATES, normalizedState, isOn, isOnOrGoingOn } from "./publishState";
// …and imported for use inside this file: a re-export does not bring a name
// into scope.
import { normalizedState, isOn } from "./publishState";

// The state fields a WRITE must carry for this node. Writing normalizedState
// alone would be a trap for legacy nodes: "draft" normalises to "live", and a
// live node without liveState reads as ON (the legacy-live fallback in isOn) —
// so a write that upgrades the state string must pin liveState from the
// LEGACY value at the same time (draft was never published → off).
export function normalizedFields(node) {
  const state = normalizedState(node);
  if (state !== "live") return { state };
  const liveState = node?.liveState === "on" || node?.liveState === "off"
    ? node.liveState
    : (node?.state === "live" ? "on" : "off");
  return { state, liveState };
}

// Pending = an intent the reconciler hasn't applied yet. desiredState is the
// UI's write; state/liveState are the reconciler's — the row shows pending
// exactly while they disagree.
export function isPendingSwitch(node) {
  const d = node?.desiredState;
  if (d !== "on" && d !== "off") return false;
  return (d === "on") !== isOn(node);
}

// Who may use the card — mirrors the console write rule on /shopify_publish
// (Junid, i.e. super-admin, or stockRole admin). The card renders null for
// everyone else; the rule is what actually enforces it.
export function canUseShopifyPublish(viewer) {
  return !!viewer && (viewer.isSuperAdmin === true || viewer.stockRole === "admin");
}

// ─── WHAT MAY BE PUBLISHED AT ALL ────────────────────────────────────────────
// Separate from, and above, every "is it ready yet" gate. `canGoLive` and
// `batchSelectBlocker` answer "what still needs doing"; this answers "is this
// even a thing we sell". Today the only answer is price-carrier records — 35
// bookkeeping rows that Junid saw listed on this page under a "Price Products"
// heading, which is the defect this closes.
//
// The predicate itself lives in productCategory.js so the owner-run reconciler
// imports the SAME function (it refuses these at apply time). The UI filter and
// the server refusal must never be able to disagree about what a price record
// is.
export const PRICE_RECORD_BLOCKER = "internal price record — not merchandise, cannot be published";
export function isPublishableProduct(product) {
  return !isPriceRecord(product);
}

// Can this node's product be published (or switched on) right now? The one
// hard gate that survives every redesign: condition has NO default, and a
// product cannot reach the storefront without one (owner spec).
export function canGoLive(node) {
  return CONDITIONS.includes(node?.condition);
}

// The name a publish would ship for this product: an already-saved cleanName
// wins, else the lexicon's automatic clean, else empty (needs typing on the
// product page). Shared by the product page's editor, the list row's
// read-only name line and the batch dialog — one answer everywhere.
export function effectiveNameFor(product, node) {
  if (node?.cleanName) return { name: node.cleanName, source: node.cleanNameSource || "manual" };
  const lex = cleanTitleFor(product);
  if (!lex.needsAI) return { name: lex.title, source: "lexicon" };
  return { name: "", source: "manual", needsAI: true, reason: lex.reason };
}

// Live validation for the clean-name editor. Returns
// { ok, problems: [] } — problems are shown beside the input as Junid types.
export function checkCleanName(input) {
  const name = String(input ?? "").trim();
  const problems = [];
  if (name === "") problems.push("name is empty");
  else {
    if (/^\d/.test(name)) problems.push("cannot start with a digit");
    if (name.length < 3) problems.push("under 3 characters");
    if (name.length > 80) problems.push("over 80 characters");
    const hits = triggersInText(name);
    if (hits.length) problems.push(`brand trigger: ${hits.join(", ")}`);
  }
  return { ok: problems.length === 0, problems };
}

// Why an awaiting-review row cannot join a batch selection right now, or null
// when it can. The gates mirror what the publish path refuses anyway
// (condition unset; no valid cleaned name; no photo — the reconciler never
// ships imageless) — surfaced inline on the row so an unselectable product is
// never a silent skip, and never a surprise block minutes after a script run
// (owner spec 2026-08-14).
export function batchSelectBlocker(node, effectiveName, photoCount, product) {
  // Not merchandise — the hardest gate, ahead of every fixable one. A price
  // record has no grade, no name and no photo either, so without this it would
  // read "set a condition grade first", which invites someone to try. The page
  // also filters these products out of the list entirely (isPublishable); this
  // is the second lock, for any row that reaches a batch by another route.
  // `product` is optional so an older two/three-arg caller still works — it
  // simply gets the pre-existing gates.
  if (product !== undefined && !isPublishableProduct(product)) return PRICE_RECORD_BLOCKER;
  if (!canGoLive(node)) return "set a condition grade first";
  if (!checkCleanName(effectiveName).ok) return "needs a valid cleaned name first";
  if (!(photoCount > 0)) return "needs at least one photo";
  return null;
}

// Why a product cannot go live right now (the row shows this loudly), or
// null when nothing blocks it. The condition gate wins over any recorded
// reason — an unset condition is always the first thing to fix; a
// reconciler-refused product carries the validator's words in blockedReason.
export function blockedReason(node) {
  if (!node || normalizedState(node) !== "blocked") return null;
  if (!CONDITIONS.includes(node.condition)) return "Condition not set — pick one of the three grades to unblock";
  return node.blockedReason || null;
}

// ─── A BLOCK IS ONLY TRUE WHILE THE NAME IT WAS ABOUT IS STILL THE NAME ──────
// A recorded refusal is a snapshot of one publish attempt, and the intent is
// consumed with it — a block clears only when somebody publishes again. So a
// handle-collision refusal from August ("Shopify product gid://…9338746241173
// already owns handle 'sneaker-black'") sits on the row for ever, describing a
// collision between a handle the product no longer wants and a Shopify product
// that has since been renamed to something else entirely.
//
// That is not a blocked product. It is a product nobody has tried to publish
// since it was renamed. Judged at RENDER time, against the name it has NOW.
//
// Evaluated ONLY for handle collisions: those name the exact fact that went
// stale. A compliance refusal, a missing photo, a size mismatch — none of those
// are answered by a rename, and softening them would talk somebody straight
// into the refusal again. The reconciler re-validates everything at apply time
// regardless; this decides what the row SAYS, never what the push allows.
//
// → { blocked, reason, staleNote }
//   blocked   — should the row still read as blocked
//   reason    — the sentence to show when it is
//   staleNote — the quiet aside when it is not: an earlier attempt under a
//               different name was refused, and that is worth knowing
export function blockStatus(node, effectiveName) {
  const reason = blockedReason(node);
  if (!reason) return { blocked: false, reason: null, staleNote: null };
  // A condition-unset block is about the condition, not the name.
  if (!CONDITIONS.includes(node?.condition)) return { blocked: true, reason, staleNote: null };
  const { stale } = staleHandleBlock(reason, effectiveName);
  if (!stale) return { blocked: true, reason, staleNote: null };
  return {
    blocked: false,
    reason: null,
    staleNote: "An earlier attempt under a different name was refused. The name has changed since — this is ready to publish.",
  };
}

// ─── PUBLISHING PHOTOS ───────────────────────────────────────────────────────
// The photos a publish would ship, in order, first = primary. Photos are a
// PUBLISHING concern living at /shopify_publish/{pid}/photos — /products is
// never written. Absent that node, the set is the record's own photoUrl +
// gallery in the same order and de-duplication the push scripts use
// (media.mjs) and the app's viewers use (productPhotos in App.jsx).
export function effectivePhotoList(product, node) {
  const custom = normalizePhotoList(node?.photos);
  if (custom) return { photos: custom, custom: true };
  const out = [];
  const push = (u) => {
    if (typeof u === "string" && u.trim() !== "" && !out.includes(u)) out.push(u);
  };
  push(product?.photoUrl);
  for (const u of Array.isArray(product?.gallery) ? product.gallery : []) push(u);
  return { photos: out, custom: false };
}

// ─── REVIEW-FLOW STATE (the full-page tab) ───────────────────────────────────
// The page's row chip and header filter speak in REVIEW terms, one step finer
// than the stored `state`: a /shopify_publish node's EXISTENCE means the
// product has been seen at least once, and an approved name that hasn't been
// published stays state "awaiting" with `nameApprovedAt` stamped on the node
// (the console rules' $other clause admits the extra field).

// TWO TABS AND A LANE (owner instruction 2026-08-28). Categories are gone from
// this page entirely — they grouped the catalogue by a fact the publishing job
// never asks about, and the collapsible sections meant the answer to "what is
// on the shop" was spread across thirty headings you had to open one at a time
// on a phone.
//
//   live     — published AND on. What a customer can see right now.
//   awaiting — everything else that is waiting for a decision: never reviewed,
//              reviewed and not published, refused, and ON SHOPIFY BUT OFF.
//              That last group is the one this page has been hiding: 152 nodes
//              sit at live+off, 97 of them switched off in August so their
//              names could be changed and never put back
//              (docs/PUBLISH-AUTO-OFF.md). They are not live and they are not
//              finished, so this is where they belong.
//   proposed — the vision-naming review lane, unchanged. Not a state; a queue.
//
// "All" and "Blocked" are gone with the sections. All was the catalogue, which
// is what the admin catalogue is for; Blocked was a subset of awaiting that a
// row already announces in red, and pulling it out into its own tab hid those
// products from the list where the work happens.
export const STATE_FILTERS = [
  { key: "live",     label: "Live" },
  { key: "awaiting", label: "Awaiting review" },
  { key: "proposed", label: "Suggested names" },
];

// Which tab does this product belong under? The node is the whole answer: a
// product with no node at all has never been reviewed, which is the purest
// form of awaiting.
//
// Deliberately NOT reviewStateFor: that speaks in review states (awaiting /
// approved / live / blocked) and the tabs speak in "can a customer see it".
// A live+off product is "live" by state and awaiting by every practical
// measure, and the old Live tab put it behind a second collapsed heading.
export function publishTabFor(node) {
  return isOn(node) ? "live" : "awaiting";
}

// Where a product sits in the review flow. An awaiting node with no approval
// stamp (a grade set before any name decision) still reads "awaiting" — the
// name has not been signed off; with the stamp it reads "approved" (shown
// under All only, same as before the redesign).
export function reviewStateFor(node) {
  if (!node) return "awaiting";
  const s = normalizedState(node);
  if (s === "awaiting") return node.nameApprovedAt ? "approved" : "awaiting";
  return s; // live | blocked
}

// ─── VISION NAME PROPOSALS — the review lane ─────────────────────────────────
// scripts/shopify/vision-name.mjs reads a product's PHOTO and writes a
// PROPOSED listing name to /shopify_publish/{pid}/nameProposal. Nothing is
// applied by the script; this is the surface where a proposal becomes the
// product's name, and these are the predicates that surface drives.
//
// Re-exported from src/utils/visionNaming.js so the page keeps one import
// path for everything publishing-related — the same treatment CONDITIONS gets.
export { NAME_PROPOSAL_KEY, isPendingProposal, isRefusedProposal };

// THE PROVENANCE VALUE AN APPROVED PROPOSAL RECORDS, and why it is not
// "vision". The LIVE console rule on /shopify_publish/$pid/cleanNameSource is
//   ".validate": "newData.isString() && newData.val().matches(/^(lexicon|ai|manual)$/)"
// so a browser write of "vision" is refused by the database — the page would
// show a permission error and the name would never save. "ai" is the value
// that rule already admits and it is honest: a vision name IS an AI name.
// The finer provenance is not lost — the proposal record keeps source
// "vision", the model id and the confidence, and it stays on the node after
// approval. Widening the rule to admit "vision" is optional and is printed in
// the PR; nothing here waits on it.
export const PROPOSAL_APPROVED_SOURCE = "ai";

/** The pending proposal on a node, or null. */
export function pendingProposal(node) {
  return isPendingProposal(node) ? node[NAME_PROPOSAL_KEY] : null;
}

/**
 * May this pending proposal be applied right now, and if not, why?
 * → { ok, reason }
 *
 * Two gates, both of which the write would hit anyway — surfaced here so the
 * button explains itself instead of failing:
 *   · a listing that is ON must be switched off first (approveName's rule —
 *     renaming a live product diverges from what customers already see);
 *   · the proposed name must pass the SAME check a hand-typed name passes.
 *     A proposal written before a lexicon change can carry a term that is a
 *     trigger today, and the proposal lane must never be a softer door.
 */
export function proposalApplyBlocker(node) {
  const p = pendingProposal(node);
  if (!p) return { ok: false, reason: "no proposal to apply" };
  if (isOn(node)) return { ok: false, reason: "Listing is ON the storefront — switch it off before taking a new name." };
  const verdict = validateVisionName(p.name);
  if (!verdict.ok) return { ok: false, reason: verdict.problems.join(" · ") };
  return { ok: true, reason: null };
}
