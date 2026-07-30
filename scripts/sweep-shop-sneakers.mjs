// ─── SWEEP SNEAKERS OUT OF THE SHOPS ──────────────────────────────────────────
// Owner decision 2026-07-29: Marathon PE and Trophy hold NO sneaker stock. The
// shops become order-and-collect points; the POS will sell sneakers straight off
// the hubs' inventory. So every sneaker cell at those two shops must go to zero,
// and the units must land back at the hub that holds that product.
//
// TWO DISTINCT OPERATIONS, both ledger-paired via real movements — never a raw
// qty write:
//   1. POSITIVE cells  → transfer_out shop→hub. Real goods going back.
//   2. NEGATIVE cells  → adjustment up to 0. These are not goods; they are the
//      accumulated error of selling from a shop cell that was never really
//      stocked (361 cells at PE, 47 at Trophy). Owner: heal to zero; the hubs
//      get a manual recount later.
//
// DESTINATION RULE (resolution order, most-trusted first):
//   1. The hub that PHYSICALLY holds stock for this product — verified 99.6%
//      unambiguous per product+size. This is the truth, not the metadata.
//   2. Failing that, product.hubs if it names exactly one hub.
//   3. Otherwise UNRESOLVED — reported, never guessed. Nothing is written for it.
// `product.hubs` is deliberately NOT the primary key: it is a multi-select
// ("which hubs may carry this") and 633 products name two or three.
//
//   node scripts/sweep-shop-sneakers.mjs --dry-run    # full plan, writes nothing
//   node scripts/sweep-shop-sneakers.mjs --commit     # apply
//   node scripts/sweep-shop-sneakers.mjs --dry-run --csv > sweep.csv
//
// Re-runnable: it reads live state each time, so a second run after a successful
// sweep finds nothing to do.

import { createRequire } from "module";
const require = createRequire("file:///Users/junidmohammed/Documents/marathon-store-app/functions/package.json");
const admin = require("firebase-admin");
const { productIsFootwear } = await import(new URL("../src/utils/footwearLine.js", import.meta.url));

const DRY = !process.argv.includes("--commit");
const CSV = process.argv.includes("--csv");

// ── The two ISOLATED networks (owner, 2026-07-29) ────────────────────────────
// Pine is linked ONLY to hub3, and that pair does not interact with Marathon PE,
// Trophy, hub1 or hub2. Stock is therefore never swept ACROSS networks: a
// sneaker sitting at Pine goes back to hub3, never to hub1, even if hub1
// happens to hold the same product. Crossing them would move real goods between
// buildings that do not trade with each other.
const NETWORKS = {
  main: { shops: ["marathon-pe", "trophy"], hubs: ["hub1", "hub2"] },
  pine: { shops: ["marathon-pine"],         hubs: ["hub3"] },
};
const SHOPS = Object.values(NETWORKS).flatMap((n) => n.shops);
const HUBS = ["hub1", "hub2", "hub3"];
const networkOf = (shop) => Object.values(NETWORKS).find((n) => n.shops.includes(shop));
// Sneaker hub of last resort per network, used only when nothing else resolves.
const FALLBACK_HUB = { "marathon-pe": "hub1", trophy: "hub1", "marathon-pine": "hub3" };
// Only sweep Pine when explicitly asked — its numbers are inverted (the shop
// holds the stock, the hub is deeply negative), so it is opted into separately.
const INCLUDE_PINE = process.argv.includes("--include-pine");
const REASON_RETURN = "shop_sneaker_sweep";
const REASON_HEAL = "shop_sneaker_negative_heal";

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const pad = (s, n) => String(s).padEnd(n);

// ── "Is this footwear?" — a POSITIVE test, deliberately ──────────────────────
// The direction of failure is everything. A false NEGATIVE leaves a pair of
// shoes at the shop: annoying, visible, fixable by re-running. A false POSITIVE
// sweeps CLOTHING out of a shop and into a hub, corrupting stock the refill
// engine actively manages. So nothing is footwear unless the catalogue says so.
//
// productType is NOT consulted: 12 live products are clothing (jackets, jeans,
// jerseys, tracksuits) carrying productType "sneaker". A negative test like
// `productType !== "clothing"` also treats any product MISSING productType as
// footwear — the failure that must be impossible.
// Uses the SHARED predicate, not a local copy — the app, the POS and this script
// must agree on what a sneaker is, and a fourth definition drifting quietly is
// exactly how stock ends up in the wrong place. productIsFootwear is the
// catalogue half of the same gate the deduction uses. (CodeRabbit, Major.)
const isFootwear = (p) => productIsFootwear(p);

const hubsField = (p) => {
  const h = p && (p.hubs || (p.hub ? [p.hub] : []));
  const a = Array.isArray(h) ? h : (h && typeof h === "object" ? Object.values(h) : []);
  return [...new Set(a.map(String).filter((x) => HUBS.includes(x)))];
};

(async () => {
  const [stock, products] = await Promise.all([
    db.ref("stock").once("value").then((s) => s.val() || {}),
    db.ref("products").once("value").then((s) => s.val() || {}),
  ]);

  // Units of this product AT THIS SIZE held at a hub. Size-exact, deliberately:
  // totalling every size would let unrelated depth decide the destination — hub1
  // holding twenty size 8s would pull a size 9 away from the hub that actually
  // stocks size 9. The whole premise of the routing is that a product+size sits
  // in exactly one hub (verified: 3,250 of 3,263 cells), and that premise only
  // holds per SIZE. (CodeRabbit, Critical.)
  const heldAt = (hub, pid, sizeKey) => Math.max(0, Number(stock[hub]?.[pid]?.[sizeKey]?.qty) || 0);

  // Hubs IN THIS SHOP'S NETWORK that hold this exact product+size.
  const holdingHubs = (pid, sizeKey, shop) => networkOf(shop).hubs.filter((h) => heldAt(h, pid, sizeKey) > 0);

  const returns = [], heals = [], unresolved = [];
  let posUnits = 0, negUnits = 0;

  const activeShops = SHOPS.filter((s) => INCLUDE_PINE || s !== "marathon-pine");
  for (const shop of activeShops) {
    for (const [pid, bySize] of Object.entries(stock[shop] || {})) {
      const p = products[pid];
      if (!isFootwear(p)) continue;
      for (const [sizeKey, cell] of Object.entries(bySize || {})) {
        const qty = Number(cell && cell.qty) || 0;
        if (qty === 0) continue;
        const name = (p && p.name) || "(unnamed)";

        if (qty < 0) {
          heals.push({ shop, pid, name, sizeKey, qty, delta: -qty });
          negUnits += qty;
          continue;
        }

        const net = networkOf(shop);
        const held = holdingHubs(pid, sizeKey, shop);
        // The hubs field is only usable if it names a hub in THIS network.
        const field = hubsField(p).filter((h) => net.hubs.includes(h));

        // Resolution order, most-trusted first. Owner-approved tie-break
        // (2026-07-29): deepest holding wins, then the network's sneaker hub.
        let dest = null, basis = null;
        if (held.length === 1) { dest = held[0]; basis = "holds-stock"; }
        else if (held.length > 1) {
          const sorted = [...held].sort((a, b) => heldAt(b, pid, sizeKey) - heldAt(a, pid, sizeKey) || a.localeCompare(b));
          if (heldAt(sorted[0], pid, sizeKey) > heldAt(sorted[1], pid, sizeKey)) { dest = sorted[0]; basis = "deepest-holding"; }
          else { dest = null; basis = "tie-unresolved"; }
        }
        else if (field.length === 1) { dest = field[0]; basis = "hubs-field"; }
        else { dest = null; basis = "unresolved"; }

        // NO GUESSING. A blanket fallback hub used to live here, and it moved real
        // goods on no evidence at all — an exact tie, or a product no hub holds,
        // would be shipped to hub1 simply because hub1 is the sneaker room. A
        // wrong hub is worse than a shoe left on the shop shelf: the shelf is
        // visible and re-runnable, a mis-filed pair is neither. Unresolved cells
        // are REPORTED and left alone. (CodeRabbit, Major.)
        if (!dest || !net.hubs.includes(dest)) {
          unresolved.push({ shop, pid, name, sizeKey, qty, why: `no hub in this network holds ${sizeKey} (${basis})` });
          continue;
        }

        returns.push({ shop, pid, name, sizeKey, qty, dest, basis });
        posUnits += qty;
      }
    }
  }

  if (CSV) {
    console.log("op,shop,productId,name,size,qty,destination,basis");
    returns.forEach((r) => console.log(`return,${r.shop},${r.pid},"${String(r.name).replace(/"/g, "'")}",${r.sizeKey},${r.qty},${r.dest},${r.basis}`));
    heals.forEach((h) => console.log(`heal,${h.shop},${h.pid},"${String(h.name).replace(/"/g, "'")}",${h.sizeKey},${h.qty},-,negative-to-zero`));
    unresolved.forEach((u) => console.log(`UNRESOLVED,${u.shop},${u.pid},"${String(u.name).replace(/"/g, "'")}",${u.sizeKey},${u.qty},-,"${u.why}"`));
    process.exit(0);
  }

  console.log("═══ SWEEP PLAN ═══", DRY ? "(DRY RUN — nothing will be written)" : "(COMMIT)");
  console.log(`\n1. RETURN TO HUBS — ${returns.length} cells, ${posUnits} units`);
  const byDest = {};
  returns.forEach((r) => { byDest[`${r.shop} -> ${r.dest}`] = (byDest[`${r.shop} -> ${r.dest}`] || 0) + r.qty; });
  Object.entries(byDest).sort().forEach(([k, v]) => console.log("   ", pad(k, 30), v, "units"));
  const byBasis = {};
  returns.forEach((r) => { byBasis[r.basis] = (byBasis[r.basis] || 0) + 1; });
  console.log("    resolved by:", JSON.stringify(byBasis));

  console.log(`\n2. HEAL NEGATIVES TO ZERO — ${heals.length} cells, ${negUnits} units`);
  const byShopNeg = {};
  heals.forEach((h) => { byShopNeg[h.shop] = (byShopNeg[h.shop] || 0) + h.qty; });
  Object.entries(byShopNeg).forEach(([k, v]) => console.log("   ", pad(k, 30), v, "units"));

  console.log(`\n3. UNRESOLVED — ${unresolved.length} cells (NOTHING will be written for these)`);
  unresolved.slice(0, 25).forEach((u) => console.log("   ", pad(u.shop, 13), pad(String(u.name).slice(0, 38), 40),
    "size", pad(u.sizeKey, 6), "qty", pad(u.qty, 4), u.why));
  if (unresolved.length > 25) console.log(`    … +${unresolved.length - 25} more`);

  console.log("\nAFTER THIS RUN, sneaker units remaining at the shops:",
    unresolved.reduce((a, u) => a + u.qty, 0), "(the unresolved ones only)");

  if (DRY) {
    console.log("\n--dry-run: nothing written. Re-run with --commit to apply.");
    process.exit(0);
  }

  // ── COMMIT ────────────────────────────────────────────────────────────────
  const ts = new Date().toISOString();
  const backup = await db.ref("reports/stock_corrections").push();
  await backup.set({ at: ts, op: "shop-sneaker-sweep", returns, heals, unresolved });
  console.log(`\nbackup: /reports/stock_corrections/${backup.key}`);

  let done = 0, failed = 0;
  // WRITE-TIME PRECONDITION. The plan is computed from ONE snapshot read at the
  // start; a sale or transfer landing between that read and a given write would
  // be silently overwritten by a qty derived from stale state. This is not
  // theoretical — during the first live run six units and a fresh negative
  // appeared mid-sweep. Each cell is re-read immediately before its write and the
  // cell is SKIPPED if it moved, so a concurrent change is never clobbered.
  // (CodeRabbit, Major.)
  const cellChanged = async (loc, pid, sizeKey, expected) => {
    const live = await db.ref(`stock/${loc}/${pid}/${sizeKey}/qty`).once("value").then((x) => x.val());
    const cur = Number(live) || 0;
    return cur !== expected ? cur : null;
  };

  const writeMovement = async (mv, cells) => {
    const mvId = db.ref("stock_movements").push().key;
    const updates = { [`stock_movements/${mvId}`]: { ...mv, appliedAt: ts, actor: "script:sweep-shop-sneakers", actorRole: "admin" } };
    for (const c of cells) {
      updates[`stock/${c.loc}/${c.pid}/${c.sizeKey}/qty`] = c.newQty;
      updates[`stock/${c.loc}/${c.pid}/${c.sizeKey}/v`] = c.v + 1;
      updates[`stock/${c.loc}/${c.pid}/${c.sizeKey}/mv`] = mvId;
      updates[`stock/${c.loc}/${c.pid}/${c.sizeKey}/lastType`] = mv.type;
      updates[`stock/${c.loc}/${c.pid}/${c.sizeKey}/updatedAt`] = ts;
      updates[`stock/${c.loc}/${c.pid}/${c.sizeKey}/updatedBy`] = "script:sweep-shop-sneakers";
    }
    await db.ref().update(updates);
  };
  const vOf = (loc, pid, sk) => Number(stock[loc]?.[pid]?.[sk]?.v) || 0;
  const qOf = (loc, pid, sk) => Number(stock[loc]?.[pid]?.[sk]?.qty) || 0;

  let skippedStale = 0;
  for (const r of returns) {
    try {
      const moved = await cellChanged(r.shop, r.pid, r.sizeKey, r.qty);
      if (moved !== null) {
        console.warn(`  skip (changed under us): ${r.shop} ${r.name} ${r.sizeKey} expected ${r.qty}, found ${moved}`);
        skippedStale++;
        continue;
      }
      await writeMovement(
        { type: "transfer_out", productId: r.pid, size: r.sizeKey, qty: r.qty, from: r.shop, to: r.dest,
          before: { [r.shop]: r.qty, [r.dest]: qOf(r.dest, r.pid, r.sizeKey) },
          after: { [r.shop]: 0, [r.dest]: qOf(r.dest, r.pid, r.sizeKey) + r.qty },
          ts, reason: REASON_RETURN, link: null },
        [{ loc: r.shop, pid: r.pid, sizeKey: r.sizeKey, newQty: 0, v: vOf(r.shop, r.pid, r.sizeKey) },
         { loc: r.dest, pid: r.pid, sizeKey: r.sizeKey, newQty: qOf(r.dest, r.pid, r.sizeKey) + r.qty, v: vOf(r.dest, r.pid, r.sizeKey) }],
      );
      done++;
    } catch (e) { failed++; console.error("return failed", r.pid, r.sizeKey, String(e?.message || e)); }
  }

  for (const h of heals) {
    try {
      const moved = await cellChanged(h.shop, h.pid, h.sizeKey, h.qty);
      if (moved !== null) {
        console.warn(`  skip (changed under us): ${h.shop} ${h.name} ${h.sizeKey} expected ${h.qty}, found ${moved}`);
        skippedStale++;
        continue;
      }
      await writeMovement(
        { type: "adjustment", productId: h.pid, size: h.sizeKey, qty: h.delta, from: null, to: h.shop,
          before: { [h.shop]: h.qty }, after: { [h.shop]: 0 }, ts,
          reason: `${REASON_HEAL}: shop no longer holds sneaker stock; negative cleared to zero. Owner-authorised 2026-07-29. Hubs to be recounted manually.`,
          link: null },
        [{ loc: h.shop, pid: h.pid, sizeKey: h.sizeKey, newQty: 0, v: vOf(h.shop, h.pid, h.sizeKey) }],
      );
      done++;
    } catch (e) { failed++; console.error("heal failed", h.pid, h.sizeKey, String(e?.message || e)); }
  }

  console.log(`\nwritten: ${done} movements, ${failed} failed, ${skippedStale} skipped (changed mid-run).`);

  // Verify.
  const after = await db.ref("stock").once("value").then((s) => s.val() || {});
  for (const shop of SHOPS) {
    let left = 0, cells = 0;
    for (const [pid, bySize] of Object.entries(after[shop] || {})) {
      if (!isFootwear(products[pid])) continue;
      for (const c of Object.values(bySize || {})) {
        const q = Number(c && c.qty) || 0;
        if (q !== 0) { left += q; cells++; }
      }
    }
    console.log(`  ${shop}: ${cells} non-zero sneaker cells remaining (${left} units)`);
  }
  // A partial run must NOT look like a clean one — an operator reading "done"
  // after 3 of 200 writes landed would move on and leave the rest. Non-zero exit
  // on any failure; skips are re-runnable and reported, not failures.
  // (CodeRabbit, Minor.)
  if (failed) {
    console.error(`\nFAILED: ${failed} movement(s) did not write. Re-run to finish — the plan is recomputed from live state each time.`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
