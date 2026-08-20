// ─── IS THIS PRODUCT ON THE STOREFRONT? ONE ANSWER ───────────────────────────
// The single definition of a publishing node's state, in a module with NO
// imports at all — so a plain `node scripts/…` run can load it, which is the
// whole point of it existing separately from shopifyPublishCore.js. That file
// imports its siblings without file extensions (fine under vite, fatal under
// Node ESM), and the consequence was two Admin-SDK scripts each carrying their
// own hand-rolled copy of `isOn`:
//
//     const isOn = (n) => n?.state === "live" && n?.liveState === "on";
//
// which is NARROWER than the real one. A legacy node — `state: "live"` with no
// `liveState` field at all — is ON the storefront by the app's definition and
// NOT-ON by that copy. A script that renames "non-live" products would have
// renamed such a node, changing the Shopify handle of a page customers and
// Google already hold. There are none in the database today (checked
// 2026-08-20: 0 of 3,457), and that is not a reason to keep a predicate that
// would mishandle one.
//
// shopifyPublishCore.js re-exports these, so every existing import path is
// unchanged.

export const PUBLISH_STATES = ["awaiting", "live", "blocked"];

// Pre-migration values still readable in old nodes (migrate-live-state.mjs
// rewrites them; the UI tolerates them in the meantime): a draft existed on
// Shopify unpublished — exactly what live+off now means.
export const LEGACY_STATE_MAP = {
  none: "awaiting", nominated: "awaiting", draft: "live", live: "live", blocked: "blocked",
};

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

/**
 * Is this product on the storefront, OR on its way there?
 *
 * `isOn` answers only about the CONFIRMED present. A product whose
 * `desiredState` is "on" has been published by a human and is waiting for the
 * reconciler's next run — renaming it in that window changes the name that is
 * about to be pushed, out from under the person who signed it off. Every
 * offline tool that rewrites `cleanName` must gate on this, not on `isOn`.
 */
export function isOnOrGoingOn(node) {
  return isOn(node) || node?.desiredState === "on";
}
