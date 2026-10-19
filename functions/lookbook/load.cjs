// ─── LOOKBOOK: READING ONLY THE PRODUCTS IT NEEDS ────────────────────────────
// The reel shortlist (loadSocialGenerationContext) ranks on sales and cannot be
// trusted to hold a hat, a bag AND a jacket on any given morning, so the
// lookbook reads its own. It reads ONLY by indexed query and by pid:
//
//   1. shopify_publish orderByChild("state").equalTo("live"): the same
//      indexed query the reels run.
//   2. The storefront title SUGGESTS a slot (social-lookbook guessSlot). The
//      newest READS_PER_SLOT of each guess are read in full by pid:
//      /products/{pid}. The record's own categoryKey then decides.
//   3. /stock/{loc}/{pid} point reads, only for a record that has a slot, a
//      price and a photo. A product that cannot be drawn costs no stock reads.
//   4. A slot with fewer than WANT_PER_SLOT eligible products (brand, website
//      name, price, photo, stock) gets another round of the next
//      READS_PER_SLOT, up to ROUNDS. It never scans to the end.
//
// /locations is the same ~10-row config read the reels already make (called
// out there).
"use strict";

const socialSelect = require("../lib/social-select.cjs");
const lookbook = require("../lib/social-lookbook.cjs");

const READ_BATCH = 20;
// Four rounds of READS_PER_SLOT: at most 6 x 8 x 4 = 192 product point reads,
// and only a slot short of WANT_PER_SLOT eligible products reads past the first.
const ROUNDS = 4;
const WANT_PER_SLOT = 3;

/**
 * @param db  an RTDB handle (admin.database() or a test fake)
 * @param opts.nowMs
 * @param opts.liveNodes optional: an already-fetched live query result
 * @returns { candidates, reads: { products, stock }, liveCount }
 */
async function loadLookbookCandidates(db, { nowMs = Date.now(), liveNodes = null, readsPerSlot = lookbook.READS_PER_SLOT } = {}) {
  const live = liveNodes || ((await db.ref("shopify_publish").orderByChild("state").equalTo("live").once("value")).val() || {});
  const queues = new Map(lookbook.SLOT_KEYS.map((k) => [k, []]));
  for (const [pid, n] of Object.entries(live)) {
    if (!n || n.state !== "live" || n.liveState !== "on" || !n.cleanName) continue;
    const g = lookbook.guessSlot(n.cleanName);
    if (g) queues.get(g).push({ pid, liveAt: Number(n.liveAt) || 0 });
  }
  // Newest first: the bias to new arrivals starts in what is read at all.
  for (const q of queues.values()) q.sort((a, b) => b.liveAt - a.liveAt || (a.pid < b.pid ? -1 : 1));

  const locSnap = await db.ref("locations").once("value");
  const locations = Object.keys(locSnap.val() || {}).filter((id) => !socialSelect.ONLINE_EXCLUDED_LOCATIONS.has(id));

  const products = {}, stockByPid = {}, liveSubset = {};
  const reads = { products: 0, stock: 0 };
  const seen = new Set();
  // Eligible products found per slot. The price band needs a choice in each
  // slot, so a slot keeps reading (a further round) until it has WANT_PER_SLOT.
  const haveSlot = new Map();

  const readPids = async (pids) => {
    for (let i = 0; i < pids.length; i += READ_BATCH) {
      await Promise.all(pids.slice(i, i + READ_BATCH).map(async (pid) => {
        reads.products++;
        const v = (await db.ref(`products/${pid}`).once("value")).val();
        if (!v) return;
        const node = live[pid];
        if (!lookbook.lookbookSlot(v) || lookbook.priceOf(v) === null || !lookbook.approvedPhoto(v, node)) return;
        // No brand, or no usable website name: never on a lookbook, so no stock reads.
        const brand = lookbook.posterBrand(v);
        if (!brand || !lookbook.panelName(node && node.cleanName, v, brand).name) return;
        const cells = await Promise.all(locations.map((loc) => db.ref(`stock/${loc}/${pid}`).once("value")));
        reads.stock += locations.length;
        const tree = {};
        locations.forEach((loc, j) => { const c = cells[j].val(); if (c) tree[loc] = c; });
        if (socialSelect.availableUnits(tree, v.sizes) <= 0) return;
        products[pid] = v; stockByPid[pid] = tree; liveSubset[pid] = node;
        const slot = lookbook.lookbookSlot(v);
        haveSlot.set(slot, (haveSlot.get(slot) || 0) + 1);
      }));
    }
  };

  for (let round = 0; round < ROUNDS; round++) {
    const batch = [];
    for (const [slot, q] of queues) {
      if (round > 0 && (haveSlot.get(slot) || 0) >= WANT_PER_SLOT) continue;
      let taken = 0;
      for (const r of q) {
        if (taken >= readsPerSlot) break;
        if (seen.has(r.pid)) continue;
        seen.add(r.pid); batch.push(r.pid); taken++;
      }
    }
    if (!batch.length) break;
    await readPids(batch);
    if (lookbook.SLOT_KEYS.every((k) => (haveSlot.get(k) || 0) >= WANT_PER_SLOT)) break;
  }

  // The lookbook keeps its own 14-lookbook memory, so the reels' 45-day
  // cooldown is not applied here (postedAtByPid empty). The day's `used` set
  // still keeps today's reel products out.
  const candidates = socialSelect.buildCandidates({
    liveNodes: liveSubset, products, stockByPid, salesByPid: {}, postedAtByPid: {}, nowMs,
  });
  return { candidates, reads, liveCount: Object.keys(live).length };
}

/** social_lookbook/history, the last HISTORY_DEPTH days by key. Bounded. */
async function loadRecentLookbookPids(db) {
  const snap = await db.ref("social_lookbook/history").orderByKey().limitToLast(lookbook.HISTORY_DEPTH).once("value");
  return lookbook.recentLookbookPids(snap.val());
}

module.exports = { loadLookbookCandidates, loadRecentLookbookPids };
