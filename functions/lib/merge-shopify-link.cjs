// ─── A MERGE TAKES THE SHOPIFY LINK WITH IT (Junid, 25 Oct 2026) ─────────────
// A merge moves the loser's stock onto the survivor and deletes the loser's
// cells. Until now it left the loser's Shopify link behind — /shopify_sync
// {pid} (the id map), /shopify_sync/_claims/{numeric id} (the reverse index)
// and /shopify_publish/{pid} (the listing's name, photos and state) — so the
// listing kept pointing at a record with no stock: the website went to 0 on a
// shoe the survivor still holds, and the survivor had no listing at all.
//
// What this decides, purely, from the five records as read:
//   • loser has no link                → "none": nothing to do.
//   • survivor has NO link of its own  → "move": all three records move to the
//     survivor in the merge's own atomic update. Nothing is sent to Shopify:
//     the listing's title, images and variant ids stay exactly as they are;
//     the variant map is keyed by size, and the merge already gives the
//     survivor every size the loser had, so each key still names a size the
//     survivor carries. The next inventory pass pushes the survivor's stock.
//   • survivor HAS its own link        → "keep-survivor": one product cannot
//     own two listings, so the survivor's stays and the loser's records are
//     left as they are — its stock is now 0, so the stock paths take that
//     listing to 0 (kept, not deleted). The merge result says so.
//
// REFUSES (the merge is refused, nothing written) when:
//   • the claim index names a THIRD record for the loser's listing — two
//     records already think they own it, and a merge must not pick one;
//   • the loser's listing has a publish change still pending (desiredState
//     not yet confirmed): moving it would let the reconciler apply that intent
//     with the SURVIVOR's record — a new title or photo set on Shopify;
//   • the loser's id map holds an unusable Shopify id.
//
// The caller fences all five paths (re-read just before the commit, refuse on
// any change) — the reconciler writes these nodes every tick.
"use strict";

const SYNC = "shopify_sync";
const CLAIMS = "shopify_sync/_claims";
const PUBLISH = "shopify_publish";

function claimKeyOf(gid) {
  const m = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(String(gid || ""));
  return m ? m[1] : null;
}

// The intent the page wrote has not been confirmed by the reconciler yet.
function hasPendingIntent(publish) {
  if (!publish || publish.desiredState == null) return false;
  const confirmedOn = publish.state === "live" && publish.liveState === "on";
  return (publish.desiredState === "on") !== confirmedOn;
}

// Paths the caller must read (and fence) for this pair. The claim path is
// known only once the loser's map is read, so it is derived separately.
function linkPaths(loserId, survivorId) {
  return {
    loserSync: `${SYNC}/${loserId}`,
    survivorSync: `${SYNC}/${survivorId}`,
    loserPublish: `${PUBLISH}/${loserId}`,
    survivorPublish: `${PUBLISH}/${survivorId}`,
  };
}
const claimPathFor = (gid) => {
  const k = claimKeyOf(gid);
  return k ? `${CLAIMS}/${k}` : null;
};

// → { action: "none" | "move" | "keep-survivor", updates, before, gid }
//   | { action: "refuse", reason }
function planShopifyLinkMove({ loserId, survivorId, loserSync, survivorSync, loserPublish, survivorPublish, claimOwner }) {
  const gid = loserSync && loserSync.shopifyProductId ? loserSync.shopifyProductId : null;
  if (!loserSync && !loserPublish) return { action: "none", updates: {}, before: null, gid: null };
  if (survivorSync || survivorPublish) {
    return { action: "keep-survivor", updates: {}, before: null, gid,
      survivorGid: survivorSync && survivorSync.shopifyProductId ? survivorSync.shopifyProductId : null };
  }
  if (gid && !claimKeyOf(gid)) return { action: "refuse", reason: `its Shopify id map holds an unusable id (${JSON.stringify(gid)})` };
  if (gid && claimOwner != null && claimOwner !== loserId) {
    return { action: "refuse", reason: `its Shopify listing is also claimed by another record (${claimOwner})` };
  }
  if (hasPendingIntent(loserPublish)) {
    return { action: "refuse", reason: "its Shopify listing has a publish change still pending — wait for it to finish (a minute or two), then merge" };
  }
  const updates = {};
  if (loserSync) {
    updates[`${SYNC}/${survivorId}`] = loserSync;
    updates[`${SYNC}/${loserId}`] = null;
  }
  if (gid) updates[claimPathFor(gid)] = survivorId;
  if (loserPublish) {
    updates[`${PUBLISH}/${survivorId}`] = loserPublish;
    updates[`${PUBLISH}/${loserId}`] = null;
  }
  return { action: "move", updates, gid,
    before: { loserSync: loserSync || null, loserPublish: loserPublish || null, claimOwner: claimOwner == null ? null : claimOwner } };
}

module.exports = { planShopifyLinkMove, linkPaths, claimPathFor, hasPendingIntent, claimKeyOf };
