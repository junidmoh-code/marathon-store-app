// ─── SHOPIFY PUBLISHING — PURE CORE ──────────────────────────────────────────
// The decision logic behind the Shopify Publishing page, kept free of
// firebase imports so it is unit-testable and shares nothing but the trigger
// engine with the owner-run scripts. The page and the client store import
// from here; scripts/shopify/* has its own server-side twin of the condition
// list (compliance.mjs) — the two are pinned equal by the tests.
import { triggersInText } from "../../utils/shopifyTriggers";

// Condition values, exactly these three (owner spec 2026-08-13). NO default:
// a product with condition unset is state=blocked and cannot be pushed.
export const CONDITIONS = [
  "Excellent — no visible wear",
  "Very good — light cosmetic marks",
  "Good — visible wear, priced accordingly",
];

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
export const PUBLISH_STATES = ["awaiting", "live", "blocked"];

// Pre-migration values still readable in old nodes (migrate-live-state.mjs
// rewrites them; the UI tolerates them in the meantime): a draft existed on
// Shopify unpublished — exactly what live+off now means.
const LEGACY_STATE_MAP = { none: "awaiting", nominated: "awaiting", draft: "live", live: "live", blocked: "blocked" };

export function normalizedState(node) {
  const s = node?.state;
  if (PUBLISH_STATES.includes(s)) return s;
  return LEGACY_STATE_MAP[s] || "awaiting";
}

// Is the product CONFIRMED on the public storefront right now? Legacy "draft"
// normalises to live but was never published → off; legacy "live" was → on.
export function isOn(node) {
  if (!node || normalizedState(node) !== "live") return false;
  if (node.liveState === "on" || node.liveState === "off") return node.liveState === "on";
  return node.state === "live"; // legacy node without liveState
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

// Can this node's product be published (or switched on) right now? The one
// hard gate that survives every redesign: condition has NO default, and a
// product cannot reach the storefront without one (owner spec).
export function canGoLive(node) {
  return CONDITIONS.includes(node?.condition);
}

// Live validation for the inline clean-name editor. Returns
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

// Why a product cannot go live right now (the row shows this loudly), or
// null when nothing blocks it. The condition gate wins over any recorded
// reason — an unset condition is always the first thing to fix; a
// reconciler-refused product carries the validator's words in blockedReason.
export function blockedReason(node) {
  if (!node || normalizedState(node) !== "blocked") return null;
  if (!CONDITIONS.includes(node.condition)) return "Condition not set — pick one of the three grades to unblock";
  return node.blockedReason || null;
}

// ─── REVIEW-FLOW STATE (the full-page tab) ───────────────────────────────────
// The page's row chip and header filter speak in REVIEW terms, one step finer
// than the stored `state`: a /shopify_publish node's EXISTENCE means the
// product has been seen at least once, and an approved name that hasn't been
// published stays state "awaiting" with `nameApprovedAt` stamped on the node
// (the console rules' $other clause admits the extra field).

export const STATE_FILTERS = [
  { key: "all",      label: "All" },
  { key: "awaiting", label: "Awaiting review" },
  { key: "live",     label: "Live" },
  { key: "blocked",  label: "Blocked" },
];

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

// Does a review state pass the header filter? "approved" products appear
// under All only — their names are done and they are not yet on Shopify.
export function matchesStateFilter(filterKey, reviewState) {
  if (filterKey === "all") return true;
  return reviewState === filterKey;
}
