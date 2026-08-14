// ── Pure planner for migrate-live-state.mjs ──────────────────────────────────
// Kept free of firebase so the mapping table — the one function that bulk
// rewrites production /shopify_publish state — is unit-testable
// (migrateLiveStatePlan.test.mjs pins it the way idMap.test.mjs pins
// planIdMapWrite). The script re-derives the plan INSIDE each per-node
// transaction, so a page write landing between the survey read and the apply
// can never be clobbered by a stale plan.

// → the merge to apply, or null when the node is already in the new model.
export function planMigration(node) {
  if (!node || typeof node !== "object") return null;
  switch (node.state) {
    case "none":
    case "nominated":
      return { state: "awaiting" };
    case "draft":
      return { state: "live", liveState: "off", desiredState: "off" };
    case "live":
      // Old-model live (no liveState) was storefront-visible; new-model live
      // nodes already carry a confirmed liveState and are left alone.
      if (node.liveState === "on" || node.liveState === "off") return null;
      return { state: "live", liveState: "on", desiredState: "on" };
    case "blocked":
    case "awaiting":
      return null;
    default:
      // Unknown state string — surface it, never guess.
      throw new Error(`unrecognised state ${JSON.stringify(node.state)} — refusing to migrate this node`);
  }
}
