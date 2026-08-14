// ─── SHOPIFY PUBLISHING — PURE CORE ──────────────────────────────────────────
// The decision logic behind the home-page Shopify Publishing card, kept free
// of firebase imports so it is unit-testable and shares nothing but the
// trigger engine with the push scripts. The card and the client store import
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

export const PUBLISH_STATES = ["none", "nominated", "draft", "live", "blocked"];

// Who may use the card — mirrors the console write rule on /shopify_publish
// (Junid, i.e. super-admin, or stockRole admin). The card renders null for
// everyone else; the rule is what actually enforces it.
export function canUseShopifyPublish(viewer) {
  return !!viewer && (viewer.isSuperAdmin === true || viewer.stockRole === "admin");
}

// The state a nomination lands in: nominated when a condition is set,
// blocked otherwise (condition has NO default — owner spec).
export function nominationState(condition) {
  return CONDITIONS.includes(condition) ? "nominated" : "blocked";
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

// Why a product cannot be pushed right now (the card shows this loudly),
// or null when it is pushable. node = the /shopify_publish value (or null).
export function blockedReason(node) {
  if (!node || !node.state || node.state === "none") return null;
  if (node.state === "draft" || node.state === "live") return null;
  if (!CONDITIONS.includes(node.condition)) return "Condition not set — pick one of the three grades to unblock";
  return null;
}

// ─── REVIEW-FLOW STATE (the full-page tab) ───────────────────────────────────
// The page's row chip and header filter speak in REVIEW terms, which are one
// step finer than the push pipeline's `state` enum: a /shopify_publish node's
// EXISTENCE means the product has been seen at least once, and an approved
// name that hasn't been nominated stays state "none" with `nameApprovedAt`
// stamped on the node (the console rules' $other clause admits the extra
// field — the state enum itself is frozen in the live rules and gains no
// "approved" value without a console edit).

export const STATE_FILTERS = [
  { key: "all",       label: "All" },
  { key: "awaiting",  label: "Awaiting review" },
  { key: "nominated", label: "Nominated" },
  { key: "draft",     label: "Draft" },
  { key: "live",      label: "Live" },
  { key: "blocked",   label: "Blocked" },
];

// Where a product sits in the review flow. A node with state "none" and no
// approval stamp (a withdrawn nomination, or a grade set before any name
// decision) still reads "awaiting" — the name has not been signed off.
export function reviewStateFor(node) {
  if (!node || !node.state || node.state === "none") {
    return node?.nameApprovedAt ? "approved" : "awaiting";
  }
  return node.state; // nominated | draft | live | blocked
}

// Does a review state pass the header filter? "approved" products appear
// under All only — they are done reviewing and not yet in the pipeline.
export function matchesStateFilter(filterKey, reviewState) {
  if (filterKey === "all") return true;
  return reviewState === filterKey;
}

// Counts for the collapsed card summary: { nominated, draft, live, blocked }.
export function pipelineCounts(nodes) {
  const counts = { nominated: 0, draft: 0, live: 0, blocked: 0 };
  for (const node of Object.values(nodes || {})) {
    if (node && counts[node.state] !== undefined) counts[node.state] += 1;
  }
  return counts;
}
