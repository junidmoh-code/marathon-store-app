// ─── INTRODUCE EXISTING PRODUCTS — migration, NOT a decision ──────────────────
// (owner architecture 2026-07-13 v8) A clothing product that already circulates
// at PE/Trophy/Hub 2 but has no targets anywhere is NOT a new product and NOT a
// business decision — the standard run is already the approved policy for it.
// This module holds the classification (LOCKSTEP with the v8 rules in
// functions/lib/refill-engine.cjs — change both together) and the one-tap bulk
// writer that applies the approved standard targets so the engine takes over.
//
// Scope decisions (mirrors the owner's 2026-07-12 standard-run seeding of the
// 816 active products exactly):
//   • targets are written FLAT at marathon-pe + trophy + hub2 — the same three
//     locations the approved seeding covered;
//   • per product, only the sizes STOCKED anywhere in the network that the
//     standard run defines (S–XXXL). Numeric sizes (jeans etc.) have no
//     approved quantity, so those products are NOT migratable — they stay in
//     the Decision Queue as genuine decisions;
//   • quantities come from /config/refillEngine.defaultRunByStore (fallback:
//     the hardcoded approved standard), minQty = ceil(target/2) — the same
//     convention every existing target cell uses.

import { ref, update, get } from "firebase/database";
import { database, auth } from "../../firebase";
import { encodeSizeKey } from "../../utils/sizeKey";
import { serverNowIso } from "../../utils/serverTime";
import { categoryPolicyLocs } from "./solvePlan";
import { isDeactivated } from "../../utils/deactivation.js";

// Approved standard runs — owner policy 2026-07-13 (corrected same day):
//   STORES (marathon-pe, trophy) — REDUCED run: both stores were full before
//   half the range was stocked, so shop targets dropped.
//   HUB 2 — keeps the ORIGINAL buffer quantities: it supplies BOTH shops, so
//   its buffer must stay deep enough to cover simultaneous store deficits.
// /config/refillEngine.defaultRunByStore must carry the SAME values —
// retarget script: scripts/targets/retarget-standard-policy.mjs.
export const STANDARD_RUN = { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 };
export const HUB2_RUN = { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 };
export const MIGRATION_DESTS = ["marathon-pe", "trophy", "hub2"];
// Managed destinations from live engine config when available (topology is
// config, never code); the constant is only the pre-load fallback.
export const destsFrom = (config) =>
  config?.routes && Object.keys(config.routes).length ? Object.keys(config.routes) : MIGRATION_DESTS;
const STANDARD_SIZE_RE = /^(S|M|L|XL|XXL|XXXL)$/i;
// A configured run is authoritative only if it defines a sane positive-integer
// quantity for every standard size — a partial or decimal map falls back to
// the approved constant instead of silently writing junk targets.
const validRun = (m) =>
  m && Object.keys(STANDARD_RUN).every((k) => Number.isInteger(m[k]) && m[k] >= 0) &&
  Object.values(m).some((v) => v > 0);
// The run the migration will actually apply for a location — exported so the
// UI previews exactly what gets written (validated config or the per-location
// fallback: hub2 keeps its deeper buffer, stores use the reduced run).
export const effectiveRun = (config, loc) =>
  (validRun(config?.defaultRunByStore?.[loc])
    ? config.defaultRunByStore[loc]
    : (loc === "hub2" ? HUB2_RUN : STANDARD_RUN));

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

const sumAt = (allStock, loc, pid) =>
  Object.values(allStock?.[loc]?.[pid] || {}).reduce((t, c) => t + Math.max(Number(c?.qty) || 0, 0), 0);

// Standard-run sizes with a cell ANYWHERE in the network — presence, not
// quantity (lockstep with the engine): a size that sold to zero still gets a
// target on migration so its proven demand is replenished or reordered.
export function stockedStandardSizes(allStock, pid) {
  const out = new Set();
  for (const loc of Object.keys(allStock || {})) {
    for (const size of Object.keys(allStock[loc]?.[pid] || {})) {
      if (STANDARD_SIZE_RE.test(String(size))) out.add(String(size));
    }
  }
  return [...out];
}

// Every zero-target circulating clothing product, one entry each:
//   { pid, standardSizes, byLoc, units, migratable }
// migratable=false → numeric-size product: shown in the Decision Queue instead.
export function computeUnintroduced(allStock, allTargets, productsById, dests = MIGRATION_DESTS, categoryPolicy = null) {
  const out = [];
  const seen = new Set();
  for (const loc of dests) {
    for (const pid of Object.keys(allStock?.[loc] || {})) {
      if (seen.has(pid)) continue;
      if (!isClothing(productsById.get(pid))) continue;
      // A DEACTIVATED product is a finished line: introducing it would write
      // standard-run targets and hand it straight back to the engine, which is
      // the one thing deactivation exists to stop. (Owner spec 2026-08-31.)
      if (isDeactivated(productsById.get(pid))) continue;
      if (dests.some((d) => allTargets?.[d]?.[pid])) continue; // introduced somewhere
      // CATEGORY-MAPPED = ALREADY GOVERNED (2026-08-13). The category policy
      // arms a product with no row at all, so "no explicit row" no longer
      // means "unintroduced". Listing a mapped product here would offer a
      // one-tap write of generic standard-run rows that OUTRANK the map
      // forever and quietly disable its off switch. (Sonnet review, PR #352.)
      if (categoryPolicyLocs(categoryPolicy, productsById.get(pid)?.categoryKey).length) continue;
      // Cell PRESENCE, not quantity: a sold-to-zero cell still proves the
      // product circulated (lockstep with the engine) — it migrates too, so
      // its proven demand gets redistributed the moment targets exist.
      if (!Object.keys(allStock?.[loc]?.[pid] || {}).length) continue;
      seen.add(pid);
      const standardSizes = stockedStandardSizes(allStock, pid);
      out.push({
        // categoryKey rides along so migrateToEngine can re-apply the mapped
        // suppression against ITS OWN fresh config read — the on-screen list
        // may predate an arming, and a write that outranks the map forever
        // must not slip through a stale render. (Sonnet review, PR #352.)
        pid, categoryKey: productsById.get(pid)?.categoryKey ?? null,
        standardSizes, migratable: standardSizes.length > 0,
        units: dests.reduce((t, d) => t + sumAt(allStock, d, pid), 0),
        byLoc: Object.fromEntries(["central", ...dests].map((l) => [l, sumAt(allStock, l, pid)])),
        // ASSORTMENT EVIDENCE (owner rule 2026-07-13): which STORES carry this
        // product. Cell presence covers every evidence source — POS sales
        // decrement a cell (so sold ⇒ cell), and transfers/receives create
        // cells — so presence ≡ (sold ∪ stocked ∪ distributed) for the ledger
        // era every unintroduced product belongs to. The migration writes
        // store targets ONLY where the store carries the product; the
        // quantity policy says how much, never WHERE a product belongs.
        carries: Object.fromEntries(dests.map((l) => [l, !!allStock?.[l]?.[pid] && Object.keys(allStock[l][pid]).length > 0])),
      });
    }
  }
  return out.sort((a, b) => b.units - a.units);
}

// Bulk-apply the approved standard targets. Chunked so one huge multi-path
// update can never trip RTDB limits; each chunk is atomic, and re-running after
// a partial failure is safe (writing the same target twice is idempotent).
export async function migrateToEngine(items, { config, approvedBy, onProgress } = {}) {
  const now = serverNowIso();
  const batchId = `introduce-existing-${now.slice(0, 10)}`;
  const dests = destsFrom(config);
  const runFor = (loc) => effectiveRun(config, loc);
  // FRESH conflict check (review 2026-07-13): the on-screen list may be stale —
  // another admin, a wizard introduction, or an earlier partial run may have
  // written targets since. Re-read /stock_targets once and skip any product
  // that now has targets ANYWHERE, so the migration never overwrites a
  // human-set target with the standard run.
  let liveTargets = {};
  let livePolicy = null;
  try {
    liveTargets = (await get(ref(database, "stock_targets"))).val() || {};
    // The category policy is re-read in the SAME pre-write stage, for the same
    // reason: an operator can arm a category between this screen rendering and
    // the tap, and a row written past a stale config outranks the map forever.
    // (CodeRabbit, PR #352.) The union below refuses everything EITHER source
    // maps, so a failed policy read inside this same try degrades to abort.
    livePolicy = (await get(ref(database, "config/refillEngine/categoryPolicy"))).val();
  } catch (e) {
    return { done: 0, total: 0, cells: 0, batchId, failed: [`could not re-check current targets — nothing written (${String(e?.message || e)})`] };
  }
  // Category-mapped products are ALREADY GOVERNED — writing standard-run rows
  // onto one would outrank the map forever and disable its off switch.
  // computeUnintroduced filters them, but this writer re-applies the rule
  // against BOTH the config it was handed AND the live node it just read:
  // a stale list or a stale config must never become a stray row.
  const migratable = items.filter((i) => i.migratable
    && !dests.some((d) => liveTargets?.[d]?.[i.pid])
    && !categoryPolicyLocs(config?.categoryPolicy, i.categoryKey).length
    && !categoryPolicyLocs(livePolicy, i.categoryKey).length);
  const skippedTaken = items.filter((i) => i.migratable).length - migratable.length;
  let done = 0, cells = 0;
  const failed = [];
  const CHUNK = 100;
  for (let i = 0; i < migratable.length; i += CHUNK) {
    const chunk = migratable.slice(i, i + CHUNK);
    const upd = {};
    let chunkCells = 0;
    for (const item of chunk) {
      for (const loc of dests) {
        // Stores follow their own assortment (evidence: the store carries the
        // product). Hub 2 is the buffer for BOTH shops, so it targets every
        // migrated product regardless — the union of the network's assortment.
        if (loc !== "hub2" && item.carries && !item.carries[loc]) continue;
        const run = runFor(loc);
        for (const size of item.standardSizes) {
          const t = Number(run[String(size).toUpperCase()]) || 0;
          // A deliberate 0 in the configured run is a real business state
          // ("we don't stock XXXL here") — write the explicit target:0 the
          // Exclude flow writes, never silently omit the cell (three target
          // states, never conflated: >0 maintain, 0 excluded, absent unmanaged).
          upd[`stock_targets/${loc}/${item.pid}/${encodeSizeKey(size)}`] = {
            target: t, minQty: t > 0 ? Math.ceil(t / 2) : 0,
            source: "standard_policy_migration", batchId, approvedBy: approvedBy || "introduce-existing", approvedAt: now,
          };
          chunkCells++;
        }
      }
    }
    try {
      await update(ref(database), upd);
      done += chunk.length;
      cells += chunkCells;   // only cells that actually landed
    } catch (e) {
      failed.push(`${chunk.length} products (batch ${i / CHUNK + 1}): ${String(e?.message || e)}`);
    }
    onProgress?.({ done, total: migratable.length });
  }
  // MIGRATION COMPLETE record (owner request 2026-07-13): a durable audit row —
  // date, policy version, products onboarded, operator — for troubleshooting
  // or rollback months later. Lives under stock_targets_decisions/_migrations
  // ("_migrations" is never a real location key, so the engine and Decision
  // Queue, which only read configured destination keys, never see it).
  if (done > 0) {
    // Both runs in the label — shops and hub2 differ by design (split policy).
    const label = (m) => Object.keys(STANDARD_RUN).map((s) => `${s}${Number(m[s]) ?? 0}`).join("-");
    const policyVersion = `shops:${label(runFor("marathon-pe"))}|hub2:${label(runFor("hub2"))}`;
    await update(ref(database), {
      [`stock_targets_decisions/_migrations/${batchId.replace(/[.#$/\[\]]/g, "_")}`]: {
        kind: "introduce_existing_complete", completedAt: serverNowIso(),
        policyVersion, productsOnboarded: done, cellsWritten: cells,
        skippedAlreadyTargeted: skippedTaken || 0, failedBatches: failed.length,
        operator: auth.currentUser?.uid || null, operatorLabel: approvedBy || "introduce-existing",
      },
    }).catch(() => {});   // best-effort: the audit row must never fail the migration
  }
  return { done, total: migratable.length, cells, failed, batchId, skippedTaken };
}
