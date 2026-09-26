// ─── PUTTING A SNEAKER BACK — THE DECISIONS, PURE ────────────────────────────
//
// 25 Sep 2026: the Nike Air Force 1 White (315122-111) was switched to Type
// Clothing on a shop phone. The edit page's Clothing path strips Hub 1 (and
// falls back to Hub 2 when nothing is left), clears the shoebox flag, and the
// refill engine stops arming it as a shoe. This works out, from EVIDENCE only,
// what a product switched to Clothing by mistake should be put back to, and
// is shared by the one-product restore and the catalogue audit
// (restore-sneaker-type.mjs, audit-clothing-sneakers.mjs).
//
// Evidence, never guesses:
//   · sizes — a size is kept only if the product ever held a stock cell in it
//     or an order/sale was logged in it (the insights rollup). A size someone
//     toggled on with no history (the AF1's 12 and 13) is dropped.
//   · hubs  — Hub 1 comes back when the product has Hub 1 cells or Hub 1 orders;
//     every hub it has now is kept. The legacy `hub` field is aligned.
//   · the shoebox flag is NOT restored: nothing records what it was.
//   · Hub 2 seats (qty-0 "seed" cells, the shape Missing Sneakers' Solve
//     writes) only when asked for — they move no stock.
// Nothing here deletes a stock cell or changes a quantity, so a restore can
// never lose stock.

export const SIZE_ORDER_NOTE = "numeric ascending, halves in place (5, 5.5, 6)";

const decodeSize = (k) => String(k).replace(/_/g, ".");

// Adult 1–16 (halves allowed) or kids 26–35 (whole). Waist sizes (28–40,
// even) overlap the kids run; auditCore only counts a run as shoes when it is
// not a pure even 28–40 waist set.
export function isShoeSize(s) {
  const str = String(s);
  const n = Number(str);
  if (!Number.isFinite(n)) return false;
  if (/^\d{1,2}(\.5)?$/.test(str) && n >= 1 && n <= 16) return true;
  return /^\d{2}$/.test(str) && n >= 26 && n <= 35;
}

export function sortShoeSizes(sizes) {
  return [...new Set(sizes.map(String))].sort((a, b) => Number(a) - Number(b));
}

/**
 * @param {object} p           the product record
 * @param {object} cellsByLoc  { loc: { sizeKey: cell } } — every /stock cell of this product
 * @param {object} history     { sizes: {size: count}, hubs: {hub: count} } from the order log
 * @param {object} opts        { seatHub2: boolean, keepSizes: boolean, nowMs, by }
 * @returns {{ ok:true, patch, seeds, before, after, notes } | { ok:false, reason }}
 */
export function planSneakerRestore(p, cellsByLoc = {}, history = {}, opts = {}) {
  if (!p || typeof p !== "object") return { ok: false, reason: "no such product" };
  const notes = [];

  // ── sizes from evidence ─────────────────────────────────────────────────
  const evidence = new Set();
  for (const cells of Object.values(cellsByLoc || {})) {
    for (const k of Object.keys(cells || {})) {
      const s = decodeSize(k);
      if (isShoeSize(s)) evidence.add(s);
    }
  }
  for (const [s, n] of Object.entries(history.sizes || {})) if (n > 0 && isShoeSize(s)) evidence.add(String(s));
  const current = Array.isArray(p.sizes) ? p.sizes.map(String) : [];
  // keepSizes: only ever ADD sizes (the catalogue audit). Dropping a size with
  // no history is right for a product somebody just toggled sizes on (the AF1's
  // 12), and a guess anywhere else.
  const sizes = sortShoeSizes(opts.keepSizes ? [...current.filter(isShoeSize), ...evidence] : [...evidence]);
  const dropped = current.filter((s) => !sizes.includes(s));
  if (dropped.length) notes.push(`sizes ${dropped.join(", ")} dropped — never stocked, sold or ordered`);
  const added = sizes.filter((s) => !current.includes(s));
  if (added.length) notes.push(`sizes ${added.join(", ")} restored from stock/order history`);
  if (!sizes.length) return { ok: false, reason: "no shoe-size evidence — not restoring blind" };

  // ── hubs ───────────────────────────────────────────────────────────────
  const hubsNow = Array.isArray(p.hubs) ? p.hubs.slice() : (p.hub ? [p.hub] : []);
  const hub1Evidence = !!(cellsByLoc.hub1 && Object.keys(cellsByLoc.hub1).length) || (history.hubs?.hub1 || 0) > 0;
  const hubs = hubsNow.slice();
  if (hub1Evidence && !hubs.includes("hub1")) { hubs.unshift("hub1"); notes.push("Hub 1 re-enabled (Hub 1 stock/orders on record)"); }
  if (opts.seatHub2 && !hubs.includes("hub2")) hubs.push("hub2");
  const orderedHubs = ["hub1", "hub2", "hub3"].filter((h) => hubs.includes(h)).concat(hubs.filter((h) => !["hub1", "hub2", "hub3"].includes(h)));

  // ── the patch ──────────────────────────────────────────────────────────
  const patch = {};
  if (p.productType !== "sneaker") patch.productType = "sneaker";
  if (JSON.stringify(current) !== JSON.stringify(sizes)) patch.sizes = sizes;
  if (JSON.stringify(hubsNow) !== JSON.stringify(orderedHubs)) patch.hubs = orderedHubs;
  if (orderedHubs.length && p.hub !== orderedHubs[0]) patch.hub = orderedHubs[0];

  // ── Hub 2 seats ────────────────────────────────────────────────────────
  const seeds = {};
  if (opts.seatHub2) {
    const have = cellsByLoc.hub2 || {};
    for (const s of sizes) {
      const key = s.replace(/\./g, "_");
      if (have[key] !== undefined && have[key] !== null) continue;
      seeds[`stock/hub2/${p.id}/${key}`] = {
        qty: 0, v: 0, mv: "seed", lastType: "count", state: "live",
        updatedAt: new Date(opts.nowMs).toISOString(), updatedBy: opts.by?.uid || "restore",
      };
    }
    if (Object.keys(seeds).length) notes.push(`seated at Hub 2 in ${Object.keys(seeds).length} sizes (qty 0 — no stock moved)`);
  }

  if (p.hasShoeBoxOption === false) notes.push("shoebox flag left off — nothing records what it was before");

  return {
    ok: true, patch, seeds, notes,
    before: { productType: p.productType ?? null, hubs: hubsNow, hub: p.hub ?? null, sizes: current },
    after: { productType: "sneaker", hubs: orderedHubs, hub: orderedHubs[0] ?? null, sizes },
  };
}

/** The audit entry written on the product itself, under typeLog. */
export function typeLogEntry({ from, to, atMs, by, reason, before, after }) {
  return {
    from: from ?? null, to, atMs,
    personName: by?.personName ?? null, deviceId: by?.deviceId ?? null, uid: by?.uid ?? null,
    reason: reason ?? null,
    // Same shape as setProductType's entries: a script run by the owner is a
    // manager, and has no device.
    deviceVerified: false, manager: true,
    hubsBefore: before?.hubs ?? null, hubsAfter: after?.hubs ?? null,
    sizesBefore: before?.sizes ?? null, sizesAfter: after?.sizes ?? null,
  };
}
