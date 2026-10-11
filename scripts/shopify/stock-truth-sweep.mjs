// ─── THE NIGHTLY STOCK-TRUTH SWEEP — and the one-off correction ──────────────
//
//   node scripts/shopify/stock-truth-sweep.mjs              # dry run: report only
//   node scripts/shopify/stock-truth-sweep.mjs --commit     # correct + rollback file
//   node scripts/shopify/stock-truth-sweep.mjs --commit --pids p1,p2
//   node scripts/shopify/stock-truth-sweep.mjs --rollback ~/marathon-rollbacks/<file>.json
//
// WHAT IT DOES. Every product with a Shopify listing (/shopify_publish
// state "live", on OR off — an "off" product can still be on Facebook &
// Instagram) is compared size by size with the app, and anything wrong is
// corrected: quantities SET to the app's online pool (inventory.mjs
// networkTotals, the one definition), tracking switched on, policy DENY.
// Shopify products that are ACTIVE and published with no app product behind
// them are set to 0 — the app holds none of them. Then it re-reads what it
// corrected and records the outcome at /shopify_inventory_health/lastSweep,
// which shopifyInventoryHealthScan (functions/index.js) turns into an email to
// Junid when anything oversellable was found.
//
// It is the floor under the per-tick paths (markers + the movement ledger):
// whatever they missed — a row later than the lookback, a trigger that never
// fired, a hand edit in the Shopify admin — is put right here every night.
//
// HOW IT READS. One query on /shopify_publish's `state` index for the listed
// set, then per product: its id map and one /stock cell set per counted
// location — never a whole node. Shopify is read ONCE, as a bulk operation
// (bulkSnapshot.mjs) — per-product queries are throttled to ~2 s each — and
// judged with the same planProduct the per-tick push uses. Every WRITE goes
// through syncProduct, which re-reads that product and compare-and-sets
// against the fresh read, so a sale landing mid-sweep fails the write rather
// than being overwritten. The bytes it read are printed and recorded.
//
// GUARDS. A commit is refused when the correction would take more than 25% of
// the units Shopify is offering off sale (stockTruth.mjs MAX_ZERO_SHARE) —
// that pattern means the quantity definition is wrong, not the website — or
// when more than 10% of listings could not be read (the 25% guard would be
// measuring a sample). The refusal is recorded, so the watchdog emails Junid.
//
// ROLLBACK. Every committed run writes ~/marathon-rollbacks/stock-truth-<ts>.json
// first: the quantity and tracking state of every item it is about to change.
// --rollback puts those numbers back (compare-and-set against what this sweep
// wrote, so a sale since then is not overwritten).
import { createRequire } from "module";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { graphql } from "./client.mjs";
import {
  syncProduct, zeroUnmanagedListing, locationNames, isListedOnShopify, HEALTH_PATH, planProduct, desiredFor,
} from "./inventorySync.mjs";
import { readShopSnapshot } from "./bulkSnapshot.mjs";
import { shallowKeys } from "../lib/rtdbPaged.mjs";
import { requireSingleLocation, readAvailable, setAvailable, enforceTracking } from "./inventory.mjs";
import { summarize, exceedsZeroGuard, exceedsFailureGuard, rollbackEntries, MAX_ZERO_SHARE } from "./stockTruth.mjs";
import { serverNowMs } from "./publishNode.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const rawDb = admin.database();

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const argOf = (n) => { const i = flags.indexOf(n); return i >= 0 ? flags[i + 1] : null; };
const ONLY = argOf("--pids") ? new Set(argOf("--pids").split(",").map((s) => s.trim()).filter(Boolean)) : null;
const ROLLBACK = argOf("--rollback");
const ROLLBACK_DIR = argOf("--rollback-dir") || join(homedir(), "marathon-rollbacks");
const CONCURRENCY = 8;
const log = (s) => console.log(s);

// ── Bytes read, measured rather than estimated ───────────────────────────────
let rtdbBytes = 0;
const measure = (v) => { rtdbBytes += Buffer.byteLength(JSON.stringify(v ?? null)); return v; };
const db = {
  ref: (path) => {
    const r = rawDb.ref(path);
    return new Proxy(r, {
      get(target, prop) {
        if (prop === "get") return async () => { const s = await target.get(); measure(s.val()); return s; };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  },
};

async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const safe = (fn) => async (x) => { try { return await fn(x); } catch (e) { return { pid: x?.pid ?? x, gid: x?.gid ?? null, ok: false, why: String(e?.message || e) }; } };

// Every Shopify product that is ACTIVE and published somewhere, as gid → title.
async function activePublishedGids() {
  const out = new Map();
  let after = null;
  do {
    const d = await graphql(`query ($after: String) { products(first: 250, after: $after, query: "status:active") {
      pageInfo { hasNextPage endCursor } nodes { id title resourcePublicationsCount(onlyPublished: true) { count } } } }`, { after });
    for (const p of d.products.nodes) if (p.resourcePublicationsCount?.count > 0) out.set(p.id, p.title);
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function rollback(file) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const locId = await requireSingleLocation(graphql);
  const byProduct = new Map();
  for (const e of doc.entries) {
    const k = e.gid || e.pid;
    if (!byProduct.has(k)) byProduct.set(k, []);
    byProduct.get(k).push(e);
  }
  let restored = 0;
  for (const [gid, entries] of byProduct) {
    const baseline = await readAvailable(graphql, locId, entries.map((e) => e.inventoryItemId));
    // Only items still holding what the sweep wrote — a sale since then wins.
    const items = entries.filter((e) => baseline.get(e.inventoryItemId) === e.after && e.before != null)
      .map((e) => ({ inventoryItemId: e.inventoryItemId, quantity: e.before }));
    if (items.length) { await setAvailable(graphql, locId, items, baseline); restored += items.length; }
    const untrack = entries.filter((e) => e.trackedBefore === false && e.variantId);
    if (untrack.length) {
      // Deliberately the inverse of enforceTracking, used ONLY by a rollback.
      await graphql(`mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`,
      { productId: gid, variants: untrack.map((e) => ({ id: e.variantId, inventoryItem: { tracked: false }, ...(e.policyBefore ? { inventoryPolicy: e.policyBefore } : {}) })) },
      { mutation: true });
    }
  }
  log(`rollback: ${restored} quantity(ies) restored from ${file}`);
}

// ── Pass 1 for one listed product, from the bulk snapshot ────────────────────
// The SAME comparison syncProduct makes (planProduct), fed by the snapshot
// instead of two live queries. Nothing here is a write baseline.
async function judgeFromSnapshot(pid, snapshot, locNames) {
  const desired = await desiredFor(db, pid, locNames);
  if (!desired) return { pid, skipped: "no shopify_sync id map", permanent: true };
  const { map, totals } = desired;
  const gid = map.shopifyProductId ?? null;
  const shop = gid ? snapshot.get(gid) : null;
  // Not in the snapshot = not ACTIVE on Shopify (draft, archived or deleted):
  // nothing can be bought from it, so there is nothing to correct.
  if (!shop) return { pid, gid, ok: true, inactive: true, drift: [], untracked: [], shopifyUnits: 0, appUnits: 0 };
  const plan = planProduct({ map, variants: shop.variants, baseline: shop.baseline, totals });
  const base = { pid, gid, drift: plan.drift, untracked: plan.untracked, ...plan.meta, ...plan.stale };
  if (plan.allUnknown && !shop.variants.length) return { ...base, ok: false, permanent: true, why: "the listing has no variants" };
  if (plan.allUnknown) return { ...base, ok: false, permanent: true, why: "every mapped inventory item is unknown to Shopify — the id map is stale" };
  return { ...base, ok: true };
}

// Every Shopify product gid ANY app product maps to — not only the listed set.
// A product mid-publish, or one whose publish failed and left a listing
// behind, has an id map but no "live" publish node; it must never be mistaken
// for a listing the app does not know and zeroed (reviewer finding, PR #718).
// Shallow keys (one small REST read), then one small read per id map.
async function everyMappedGid(knownGids) {
  const out = new Set(knownGids);
  const keys = (await shallowKeys(admin.app(), "shopify_sync")).filter((k) => !k.startsWith("_"));
  const rest = keys.filter((k) => !listedPidSet.has(k));
  await pool(rest, async (pid) => {
    const g = measure((await rawDb.ref(`shopify_sync/${pid}/shopifyProductId`).get()).val());
    if (g) out.add(g);
  });
  return out;
}
let listedPidSet = new Set();

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);
  const startedAt = await serverNowMs(rawDb);
  const t0 = Date.now();

  // ── The listed set ──────────────────────────────────────────────────────────
  // One query on /shopify_publish's `state` index (the reconciler's own
  // readLivePids uses it); a --pids run reads only its own nodes.
  const listedNodes = ONLY
    ? Object.fromEntries((await Promise.all([...ONLY].map(async (p) => [p, measure((await rawDb.ref(`shopify_publish/${p}`).get()).val())])))
      .filter(([, n]) => isListedOnShopify(n)))
    : measure((await rawDb.ref("shopify_publish").orderByChild("state").equalTo("live").get()).val() || {});
  const pids = Object.keys(listedNodes).sort();
  listedPidSet = new Set(pids);
  const liveOn = pids.filter((p) => listedNodes[p]?.liveState === "on").length;
  log(`listed on Shopify: ${pids.length} (${liveOn} on the Online Store, ${pids.length - liveOn} switched off)`);

  const locId = await requireSingleLocation(graphql);
  const locNames = await locationNames(db);
  const check = (commit) => safe((pid) => syncProduct(db, graphql, pid, { commit, locationId: locId, locNames }));

  // ── Pass 1: measure, from one bulk snapshot of every active listing ────────
  const snapshot = await readShopSnapshot(graphql, locId, { log });
  log(`Shopify snapshot: ${snapshot.size} active product(s) in ${Math.round((Date.now() - t0) / 1000)} s`);
  const dry = await pool(pids, safe((pid) => judgeFromSnapshot(pid, snapshot, locNames)));
  const inactive = dry.filter((r) => r?.inactive).length;

  // Listings with no app product behind them (skipped for a --pids run).
  let unmanagedGids = [];
  if (!ONLY) {
    const published = await activePublishedGids();
    const candidates = [...published.keys()].filter((g) => !dry.some((r) => r?.gid === g));
    if (candidates.length) {
      const mapped = await everyMappedGid(dry.map((r) => r?.gid).filter(Boolean));
      unmanagedGids = candidates.filter((g) => !mapped.has(g));
    }
  }
  const dryUnmanaged = unmanagedGids.map((gid) => {
    const shop = snapshot.get(gid);
    if (!shop) return { gid, ok: true, unmanaged: true, drift: [], untracked: [], shopifyUnits: 0, appUnits: 0 };
    const plan = planProduct({ map: { shopifyProductId: gid, variants: {} }, variants: shop.variants, baseline: shop.baseline, totals: {} });
    return { gid, ok: true, unmanaged: true, drift: plan.drift, untracked: plan.untracked, ...plan.meta };
  });
  const before = summarize([...dry, ...dryUnmanaged]);
  log(`checked ${before.checked} · ${before.drifted} drifted · ${before.oversellableUnits} oversellable unit(s) · ` +
    `${before.unlimitedVariants} size(s) Shopify was not limiting · ${before.gone} deleted from Shopify · ` +
    `${before.permanent} with a stale or missing id map · ${before.failed} could not be read · ${inactive} not active on Shopify · ` +
    `${unmanagedGids.length} listing(s) with no app product`);
  log(`Shopify holds ${before.shopifyUnits} unit(s) on hand; the app's online pool holds ${before.appUnits}; the correction takes ${before.removedUnits} off sale (${(before.zeroShare * 100).toFixed(1)}%)`);
  for (const w of before.worst) log(`  ${w.pid || w.gid}: ${w.unlimitedVariants ? `${w.unlimitedVariants} unlimited size(s)` : ""}${w.units ? ` ${w.units} unit(s) over` : ""} — ${w.sizes.join("; ")}`);
  for (const f of before.failures) log(`  ⚠ ${f}`);

  let after = null, corrected = 0, refused = null, rollbackFile = null, commitFailures = [];
  if (COMMIT) {
    if (exceedsZeroGuard(before)) {
      refused = `the correction would take ${(before.zeroShare * 100).toFixed(1)}% of Shopify's units off sale (limit ${MAX_ZERO_SHARE * 100}%) — the quantity definition is suspect, nothing was written`;
    } else if (exceedsFailureGuard(before)) {
      refused = `${before.failed} of ${pids.length} listings could not be read — too many to trust the 25% guard, nothing was written`;
    }
    if (refused) {
      log(`✗ REFUSED: ${refused}`);
    } else {
      const todo = dry.filter((r) => (r?.ok === true || r?.permanent) && (r.drift?.length || r.untracked?.length));
      const todoUnmanaged = dryUnmanaged.filter((r) => r.drift?.length || r.untracked?.length);
      if (todo.length || todoUnmanaged.length) {
        mkdirSync(ROLLBACK_DIR, { recursive: true });
        rollbackFile = join(ROLLBACK_DIR, `stock-truth-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        writeFileSync(rollbackFile, JSON.stringify({ at: new Date().toISOString(), kind: "shopify-stock-truth", entries: rollbackEntries([...todo, ...todoUnmanaged]) }, null, 1));
        log(`rollback file: ${rollbackFile}`);
      }
      // Every write re-reads the product first (syncProduct) and
      // compare-and-sets against that fresh read, never the snapshot.
      const done = await pool(todo.map((r) => r.pid), check(true));
      const doneUnmanaged = await pool(todoUnmanaged.map((r) => r.gid), safe((gid) => zeroUnmanagedListing(graphql, gid, { commit: true, locationId: locId })));
      corrected = [...done, ...doneUnmanaged].filter((r) => r?.changed).length;
      commitFailures = [...done, ...doneUnmanaged].filter((r) => r?.ok !== true && !r?.permanent).map((r) => `${r.pid || r.gid}: ${r.why}`);
      for (const f of commitFailures) log(`  ⚠ not corrected: ${f}`);
      // ── Verify by reading back, product by product, what was corrected ─────
      const reread = await pool(todo.map((r) => r.pid), check(false));
      const rereadUnmanaged = await pool(todoUnmanaged.map((r) => r.gid), safe((gid) => zeroUnmanagedListing(graphql, gid, { commit: false, locationId: locId })));
      after = summarize([...reread, ...rereadUnmanaged]);
      log(`corrected ${corrected} listing(s); re-read: ${after.oversellableUnits} oversellable unit(s), ${after.unlimitedVariants} unlimited size(s) remain`);
    }
  }

  const report = {
    at: startedAt,
    durationMs: Date.now() - t0,
    rtdbBytes,
    commit: COMMIT,
    scope: ONLY ? "pids" : "all",
    listed: pids.length,
    liveOn,
    inactive,
    unmanagedListings: unmanagedGids.length,
    found: { ...before, worst: before.worst.slice(0, 20), failures: before.failures.slice(0, 20) },
    corrected,
    residual: after ? { oversellableUnits: after.oversellableUnits, unlimitedVariants: after.unlimitedVariants, worst: after.worst.slice(0, 5) } : null,
    commitFailures: commitFailures.slice(0, 20),
    refused,
    rollbackFile,
  };
  log(`rtdb read: ${rtdbBytes.toLocaleString()} B in ${Math.round((Date.now() - t0) / 1000)} s`);
  // A --pids run is a surgical human command: it must not tell the watchdog
  // the whole shop was checked. A DRY run is recorded under its own key and
  // never as lastSweep — the watchdog judges sweeps that could have corrected.
  if (!ONLY) {
    const day = new Date(startedAt + 2 * 3600e3).toISOString().slice(0, 10);
    const stored = JSON.parse(JSON.stringify(report)); // drop undefined
    if (COMMIT) await rawDb.ref(`${HEALTH_PATH}/lastSweep`).set(stored);
    await rawDb.ref(`shopify_inventory_sweeps/${day}${COMMIT ? "" : "-dry"}`).set(stored);
  }
  return refused || commitFailures.length || before.failed ? 1 : 0;
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  console.error(`✗ stock-truth sweep failed: ${String(e?.message || e)}`);
  process.exit(1);
});
