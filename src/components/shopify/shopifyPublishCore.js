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

// Counts for the collapsed card summary: { nominated, draft, live, blocked }.
export function pipelineCounts(nodes) {
  const counts = { nominated: 0, draft: 0, live: 0, blocked: 0 };
  for (const node of Object.values(nodes || {})) {
    if (node && counts[node.state] !== undefined) counts[node.state] += 1;
  }
  return counts;
}
