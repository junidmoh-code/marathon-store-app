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

import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { encodeSizeKey } from "../../utils/sizeKey";

export const STANDARD_RUN = { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 };
export const MIGRATION_DESTS = ["marathon-pe", "trophy", "hub2"];
const STANDARD_SIZE_RE = /^(S|M|L|XL|XXL|XXXL)$/i;

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

const sumAt = (allStock, loc, pid) =>
  Object.values(allStock?.[loc]?.[pid] || {}).reduce((t, c) => t + Math.max(Number(c?.qty) || 0, 0), 0);

// Sizes stocked (>0) ANYWHERE in the network that the standard run covers.
export function stockedStandardSizes(allStock, pid) {
  const out = new Set();
  for (const loc of Object.keys(allStock || {})) {
    for (const [size, c] of Object.entries(allStock[loc]?.[pid] || {})) {
      if ((Number(c?.qty) || 0) > 0 && STANDARD_SIZE_RE.test(String(size))) out.add(String(size));
    }
  }
  return [...out];
}

// Every zero-target circulating clothing product, one entry each:
//   { pid, standardSizes, byLoc, units, migratable }
// migratable=false → numeric-size product: shown in the Decision Queue instead.
export function computeUnintroduced(allStock, allTargets, productsById) {
  const out = [];
  const seen = new Set();
  for (const loc of MIGRATION_DESTS) {
    for (const pid of Object.keys(allStock?.[loc] || {})) {
      if (seen.has(pid)) continue;
      if (!isClothing(productsById.get(pid))) continue;
      if (MIGRATION_DESTS.some((d) => allTargets?.[d]?.[pid])) continue; // introduced somewhere
      if (sumAt(allStock, loc, pid) <= 0) continue;
      seen.add(pid);
      const standardSizes = stockedStandardSizes(allStock, pid);
      out.push({
        pid, standardSizes, migratable: standardSizes.length > 0,
        units: MIGRATION_DESTS.reduce((t, d) => t + sumAt(allStock, d, pid), 0),
        byLoc: Object.fromEntries(["central", ...MIGRATION_DESTS].map((l) => [l, sumAt(allStock, l, pid)])),
      });
    }
  }
  return out.sort((a, b) => b.units - a.units);
}

// Bulk-apply the approved standard targets. Chunked so one huge multi-path
// update can never trip RTDB limits; each chunk is atomic, and re-running after
// a partial failure is safe (writing the same target twice is idempotent).
export async function migrateToEngine(items, { config, approvedBy, onProgress } = {}) {
  const now = new Date().toISOString();
  const batchId = `introduce-existing-${now.slice(0, 10)}`;
  const runFor = (loc) => config?.defaultRunByStore?.[loc] || STANDARD_RUN;
  const migratable = items.filter((i) => i.migratable);
  let done = 0, cells = 0;
  const failed = [];
  const CHUNK = 100;
  for (let i = 0; i < migratable.length; i += CHUNK) {
    const chunk = migratable.slice(i, i + CHUNK);
    const upd = {};
    for (const item of chunk) {
      for (const loc of MIGRATION_DESTS) {
        const run = runFor(loc);
        for (const size of item.standardSizes) {
          const t = Number(run[String(size).toUpperCase()]) || 0;
          if (t <= 0) continue;
          upd[`stock_targets/${loc}/${item.pid}/${encodeSizeKey(size)}`] = {
            target: t, minQty: Math.ceil(t / 2),
            source: "standard_policy_migration", batchId, approvedBy: approvedBy || "introduce-existing", approvedAt: now,
          };
          cells++;
        }
      }
    }
    try {
      await update(ref(database), upd);
      done += chunk.length;
    } catch (e) {
      failed.push(`${chunk.length} products (batch ${i / CHUNK + 1}): ${String(e?.message || e)}`);
    }
    onProgress?.({ done, total: migratable.length });
  }
  return { done, total: migratable.length, cells, failed, batchId };
}
