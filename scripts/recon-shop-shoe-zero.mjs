// ─────────────────────────────────────────────────────────────────────────────
// Reconcile DEAD shop-shoe negatives to 0  (hardened, review-driven rewrite)
// ─────────────────────────────────────────────────────────────────────────────
// Supersedes the untracked root `_recon-shop-shoe-zero.mjs`. Committed so it can
// be reviewed (CodeRabbit + human) before it is ever run with --commit.
//
// DESIGN FACT: shops hold ZERO shoe (footwear) buffer — a shoe is dispatched
// hub→shop for a specific customer order and passes straight through to the
// customer (sold). So a SHOP footwear cell's true resting value is 0. A negative
// there is purely a missing dispatch +1 (the shop got the sale −1 but never the
// matching +1 — e.g. the cross-shop mis-route: the dispatch landed in the wrong
// shop's cell). This resets those dead negatives to their known-true value, 0.
//
// SCOPE — deliberately narrow, so it can NEVER make things worse:
//   • SHOPS ONLY. `central`/hubs are excluded — a hub footwear negative is a real
//     warehouse integrity signal (over-dispatch/miscount), NOT a zero-buffer
//     artifact, and must be counted, not silently zeroed. (Review finding #2.)
//   • FOOTWEAR ONLY (category === "Footwear"). Clothing/accessories/perfume carry
//     a real shop buffer, so their true value isn't 0 — they need a physical count.
//   • NEGATIVE ONLY. Positive shop-shoe cells are LEFT ALONE: this system has a
//     real layby/collection workflow (/laybys, /laybyPulls), so a +1 can be a
//     genuine parcel awaiting collection, not a phantom. (Review finding #3.)
//   • SELF-HEALING cells LEFT ALONE: any cell dispatched/received in the last
//     INBOUND_DAYS days will net out on the next sale — don't touch it.
//
// SAFETY:
//   • CAS via per-cell ref.transaction() — NOT a blind read-then-write. A sale
//     landing mid-run can't be silently clobbered: the txn aborts if the cell is
//     no longer negative (or vanished), and the set-to-0 is an ABSOLUTE target
//     (not a delta), so it stays correct under a concurrent dispatch/sale pair.
//     (Review finding #1 — the original's admin-SDK update() bypassed the version
//     rule and had no real concurrency guard.)
//   • Still: run in a QUIET WINDOW (shops closed, offline queues drained). The txn
//     is the backstop, not a licence to run mid-trade.
//   • PRECONDITION: the go-forward destShop fix (PR #188) must be DEPLOYED first —
//     don't reconcile a hole that's still filling. (Review finding #4.)
//   • Idempotent + safe to re-run: skips any cell already ≥ 0; deterministic,
//     date-scoped movementId; a post-commit verification pass re-reads every
//     written cell and fails loudly on any mismatch.
//
//   node scripts/recon-shop-shoe-zero.mjs            (DRY-RUN — prints + CSV, no writes)
//   node scripts/recon-shop-shoe-zero.mjs --commit   (applies, only after review + deploy + quiet window)
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from "module";
import { writeFileSync } from "fs";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const COMMIT = process.argv.includes("--commit");
// SHOPS ONLY — central/hubs deliberately excluded (see header, review #2).
const SHOPS = ["marathon-pe", "trophy", "marathon-pine"];
const INBOUND_DAYS = 21;                                   // "actively dispatched" self-heal window
const RECENT = new Date(Date.now() - INBOUND_DAYS * 864e5).toISOString().slice(0, 10);
const ACTOR = "recon-shop-shoe-zero";
const stamp = new Date().toISOString();

const sizeLabel = (k) => (k === "_" ? "(none)" : /^\d+_\d+$/.test(k) ? k.replace("_", ".") : k);
const scrubId = (s) => s.replace(/[.#$[\]/\s:]/g, "_");

(async () => {
  const [products, movements, ...shopStocks] = await Promise.all([
    db.ref("products").once("value").then(s => s.val() || {}),
    db.ref("stock_movements").once("value").then(s => s.val() || {}),
    ...SHOPS.map(loc => db.ref(`stock/${loc}`).once("value").then(s => s.val() || {})),
  ]);

  // last inbound (received or the +to leg of a transfer) per `${loc}|${pid}`
  const lastInbound = {};
  for (const m of Object.values(movements)) {
    if (!m || (m.type !== "received" && m.type !== "transfer_out" && m.type !== "transfer_in")) continue;
    if (!m.to || !m.productId) continue;
    const key = `${m.to}|${m.productId}`;
    const ts = m.ts || "";
    if (ts > (lastInbound[key] || "")) lastInbound[key] = ts;
  }

  const targets = [];       // dead shop-shoe negatives -> 0
  let skippedActive = 0, skippedNonShoe = 0, skippedNonNeg = 0;

  SHOPS.forEach((loc, i) => {
    const stock = shopStocks[i];
    for (const [pid, sizes] of Object.entries(stock)) {
      if (!sizes || typeof sizes !== "object") continue;
      const cat = (products[pid]?.category || "").trim();
      const name = products[pid]?.name || products[pid]?.productName || "(unknown)";
      for (const [sizeKey, cell] of Object.entries(sizes)) {
        if (!cell || typeof cell.qty !== "number") continue;
        if (cell.qty >= 0) { skippedNonNeg++; continue; }          // idempotent: already fine
        if (cat !== "Footwear") { skippedNonShoe++; continue; }     // clothing/acc = buffer, needs a count
        const inbound = (lastInbound[`${loc}|${pid}`] || "").slice(0, 10);
        if (inbound >= RECENT) { skippedActive++; continue; }       // self-heals via next sale — leave alone
        targets.push({ loc, pid, name, sizeKey, size: sizeLabel(sizeKey), before: cell.qty });
      }
    }
  });

  // ── report ──
  targets.sort((a, b) => a.loc.localeCompare(b.loc) || a.name.localeCompare(b.name));
  console.log(`\nDEAD shop-shoe negatives -> 0 : ${targets.length} cells | ${targets.reduce((s, t) => s + t.before, 0)} units`);
  console.log(`(left alone: ${skippedActive} self-healing shoe cells | skipped: ${skippedNonShoe} non-shoe buffer, ${skippedNonNeg} already>=0)`);
  console.log(`RECENT/self-heal cutoff = ${RECENT} (last ${INBOUND_DAYS}d)\n`);
  console.log("loc         size   before -> after   product");
  for (const t of targets) console.log(`${t.loc.padEnd(11)} ${t.size.padEnd(6)} ${String(t.before).padStart(5)}  -> 0        ${t.name.slice(0, 44)}`);
  const csv = ["loc,productId,product,size,before,after",
    ...targets.map(t => `${t.loc},${t.pid},"${(t.name || "").replace(/"/g, "''")}",${t.size},${t.before},0`)].join("\n");
  writeFileSync("recon-shop-shoe-zero.preview.csv", csv);
  console.log(`\nwrote recon-shop-shoe-zero.preview.csv (${targets.length} rows)`);

  if (!COMMIT) { console.log("\nDRY-RUN only — nothing written. Re-run with --commit (after review + deploy + quiet window)."); process.exit(0); }

  // ── COMMIT: per cell, a real CAS transaction (abort if no longer a dead
  // negative), then the audit movement. Absolute set-to-0 stays correct even if a
  // dispatch/sale pair races us; a lone concurrent sale just makes the txn re-run. ──
  let done = 0, racedSkipped = 0;
  const written = [];
  for (const t of targets) {
    const cellPath = `stock/${t.loc}/${t.pid}/${t.sizeKey}`;
    const mvId = scrubId(`adjzero_${t.loc}_${t.pid}_${t.sizeKey}_${stamp.slice(0, 10)}`);
    let beforeQty = null;
    const res = await db.ref(cellPath).transaction((cur) => {
      if (!cur || typeof cur.qty !== "number") return;   // vanished — abort
      if (cur.qty >= 0) return;                            // no longer a dead negative — abort
      beforeQty = cur.qty;
      return { ...cur, qty: 0, v: (typeof cur.v === "number" ? cur.v : 0) + 1, mv: mvId, lastType: "adjustment", updatedAt: stamp, updatedBy: ACTOR };
    });
    if (!res.committed || beforeQty === null) { racedSkipped++; continue; }   // aborted: someone else fixed it since the dry-run
    // Audit movement (idempotent id; harmless to re-set on a same-day re-run).
    await db.ref(`stock_movements/${mvId}`).set({
      type: "adjustment", productId: t.pid, size: t.size, qty: Math.abs(beforeQty),
      from: t.loc, actor: ACTOR, actorRole: "admin",
      before: { [t.loc]: beforeQty }, after: { [t.loc]: 0 },
      reason: "recon: dead shop shoe -> 0 (missing dispatch +1; shop holds no shoe buffer)",
      ts: stamp, appliedAt: stamp, link: { recon: "shop-shoe-zero" },
    });
    written.push({ cellPath, mvId });
    if (++done % 25 === 0) console.log(`  ...${done}/${targets.length}`);
  }
  console.log(`\nCOMMITTED ${done} cells to 0 (+ ${done} adjustment audit movements). Raced/aborted: ${racedSkipped}.`);

  // ── post-commit verification: re-read every written cell, assert it's really 0 ──
  let bad = 0;
  for (const w of written) {
    const q = (await db.ref(`${w.cellPath}/qty`).get()).val();
    if (q !== 0) { bad++; console.error(`  VERIFY FAIL ${w.cellPath} = ${q} (expected 0)`); }
  }
  if (bad) { console.error(`\n❌ VERIFY: ${bad} cell(s) not 0 after commit — investigate before re-running.`); process.exit(2); }
  console.log(`✅ VERIFY: all ${written.length} written cells confirmed at 0.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
