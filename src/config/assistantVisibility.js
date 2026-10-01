// ─── WHO STILL SEES DEACTIVATED PRODUCTS IN THE ASSISTANT VIEW ───────────────
// (Owner spec 2026-09-05, BUG 1 + BUG 1b.)
//
// THE COST BUG 1 WAS PAYING. "Dolce & Gabbana Sneakers Navy" rendered in the
// assistant view carrying a DEACTIVATED badge and a live SELECT SIZE / Quantity
// block. The assistant searched, found the zero-size deactivated duplicate, told
// the customer there was no stock — and the sizes were sitting under the OTHER
// copy the whole time. Badging it was not enough: a deactivated product must be
// COMPLETELY ABSENT from that screen. Not greyed, not badged, not showing zero
// sizes. Gone, and not findable by SEARCH there either.
//
// Before this change the contract was deliberately "browse drops them, SEARCH
// keeps and marks them" (utils/deactivation.js browsableProducts). That split
// is now overruled for the ASSISTANT VIEW only — the one screen that talks to a
// customer. Every admin/stock surface keeps them, in full, exactly as before.
//
// ── THE PINE EXEMPTION (BUG 1b) ──────────────────────────────────────────────
// Marathon Pine is exempt: Hub 3 has never been counted and Pine works from the
// shelf, by hand, so a product that looks dead in the data may genuinely be in
// front of the customer. Pine's assistant view therefore shows EVERYTHING,
// deactivated products included (still badged, so the operator knows).
//
// IT IS DATA, NOT CODE. The day Hub 3 is counted the owner switches it off from
// the console with no deploy:
//
//     /config/assistantView/showDeactivatedShops/marathon-pine = false
//
// (deleting the key does the same thing). The node is keyed by SHOP id — the
// physical shop the user is standing in, resolved by AssistantView from the
// user's `destShop` assignment (falling back to their selected/allowed shop),
// which is the same value that routes their orders. Not by universe: "pine" the
// routing universe and "marathon-pine" the shop are different vocabularies, and
// the exemption is about one shop's floor.
//
// ── THE TWO FAILURE DIRECTIONS, AND WHICH ONE IS SAFE ────────────────────────
// The DEFAULT below (Pine exempt) is what ships, so the feature is correct on
// deploy day with an absent config node, and a denied or malformed read falls
// back to it rather than to "nobody sees anything". Getting it wrong for Pine
// hides shoes that are physically on Pine's shelf — Pine loses the sale it was
// exempted to keep. Getting it wrong the other way shows Pine one extra badged
// card. Fail toward the badged card.
//
// UNKNOWN OR MISSING SHOP → STRICT HIDING. A user with no shop we can name
// (no destShop, no assignable shop, an unmapped id) is not standing on Pine's
// floor as far as the data knows, so they get the strict behaviour — the one
// that costs a sale only where a twin exists, never where the shelf is real.
// (A user with NO store access at all never reaches the order flow: AssistantView
// blocks on `noStoreAccess` before any of this is consulted.)

/** The console node this reads. Admin-writable, staff-readable. */
export const ASSISTANT_VISIBILITY_PATH = "config/assistantView";

/** Shipped default: Pine's floor is uncounted, so Pine sees everything. */
export const DEFAULT_DEACTIVATED_SHOPS = Object.freeze({ "marathon-pine": true });

/**
 * Normalise whatever /config/assistantView holds into a { shopId: boolean } map.
 * Accepts the RTDB map form ({ "marathon-pine": true }) and an array form
 * (["marathon-pine"]) so a hand-typed console edit either way still works.
 * Anything unusable → the shipped default (fail toward the exemption).
 */
export function readDeactivatedShops(configValue, fallback = DEFAULT_DEACTIVATED_SHOPS) {
  const raw = configValue && typeof configValue === "object"
    ? configValue.showDeactivatedShops
    : undefined;
  if (Array.isArray(raw)) {
    // RTDB cannot store an empty array — it deletes the key — so an array that
    // survives a round trip is always non-empty. Still tolerated either way.
    const out = {};
    for (const id of raw) if (typeof id === "string" && id) out[id] = true;
    return out;
  }
  if (raw && typeof raw === "object") {
    const out = {};
    for (const [id, on] of Object.entries(raw)) if (typeof id === "string" && id) out[id] = !!on;
    return out;
  }
  return fallback;
}

/**
 * Does the assistant view at this shop still show deactivated products?
 * An unknown, empty or unmapped shop is never exempt — strict hiding is the
 * safe default (see the header).
 */
export function showsDeactivated(shopMap, shopId) {
  if (!shopId || typeof shopId !== "string") return false;
  return !!(shopMap && shopMap[shopId] === true);
}
