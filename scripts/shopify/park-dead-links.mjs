#!/usr/bin/env node
// ─── PARK SHOPIFY LISTINGS WHOSE APP PRODUCT WAS DELETED (Junid, 25 Oct 2026) ─
//
//   node scripts/shopify/park-dead-links.mjs --pids p1,p2              dry run
//   node scripts/shopify/park-dead-links.mjs --pids p1,p2 --commit     unlink + zero
//   node scripts/shopify/park-dead-links.mjs --rollback <ledger.json>  put the links back
//
// A listing whose app product was hard-deleted (the admin product page's
// Delete button removed /products/{pid} and nothing else) keeps its
// /shopify_sync map and /shopify_publish node — so the nightly sweep and the
// inventory paths keep pushing the ORPHANED /stock cells under that dead id to
// Shopify, and the website sells pairs no till can ring.
//
// Junid's order for these: re-link to the current app product with the same
// SKU; where there is none, set the listing's Shopify stock to 0 and keep the
// listing (title, images and variant ids untouched). This script does the
// second half and REFUSES the first: when a live product carries the SKU it
// prints it and stops for that pid, because re-linking is a decision about
// which record owns the listing, not a clean-up.
//
// PER PID, all checks before any write:
//   • /products/{pid} must hold no name, id or sku (a stray single field left
//     by a save racing the delete is still a dead product).
//   • the listing's SKU (the variants' "<sku>-<size>" prefix) must be on no
//     live product — read from one /products read.
//   • /shopify_sync/_claims/{numeric id} must name this pid (or be empty).
//
// --commit, per pid: the ledger is written FIRST (~/marathon-rollbacks/
// park-dead-links-<ts>.json: the three link records and Shopify's quantities
// before), then ONE multi-path update removes /shopify_sync/{pid},
// /shopify_sync/_claims/{id} and /shopify_publish/{pid}, then the listing is
// zeroed through zeroUnmanagedListing — the nightly sweep's own write for a
// listing with no app product, compare-and-set, tracking enforced — and
// re-read. Unlinking BEFORE zeroing means no tick in between can push the
// orphaned cells back; once unlinked, the sweep keeps it at 0 every night.
//
// NEVER touches /stock: the orphaned cells stay exactly as they are (stock
// leaves a location only through a sale). They are listed for Junid.
//
// --rollback restores the three link records (refusing any that exist again)
// and leaves Shopify to the next sweep, which pushes the app's numbers.
import { createRequire } from "module";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { graphql } from "./client.mjs";
import { zeroUnmanagedListing } from "./inventorySync.mjs";
import { requireSingleLocation } from "./inventory.mjs";
import { claimKeyFor } from "./idMap.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const flags = process.argv.slice(2);
const argOf = (n) => { const i = flags.indexOf(n); return i >= 0 ? flags[i + 1] : null; };
const COMMIT = flags.includes("--commit");
const ROLLBACK = argOf("--rollback");
const PIDS = (argOf("--pids") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ROLLBACK_DIR = join(homedir(), "marathon-rollbacks");
const log = (s) => console.log(s);
const val = async (path) => (await db.ref(path).get()).val();

// "0815-6" → "0815"; the pusher writes `${product.sku}-${encodeSizeKey(size)}`.
export function skuOfVariants(variants) {
  const prefixes = new Set(variants.map((v) => String(v.sku || "").replace(/-[^-]*$/, "")).filter(Boolean));
  return prefixes.size === 1 ? [...prefixes][0] : null;
}

// The listing's variant SKUs (readProductVariants does not carry them).
async function readSkus(gid) {
  const d = await graphql(`query ($id: ID!) { product(id: $id) { variants(first: 100) { nodes { sku } } } }`, { id: gid });
  return d?.product ? d.product.variants.nodes : null;
}

// A dead product: no node, or only stray fields a racing save left behind.
export const isDeadProduct = (node) => !node || (node.name == null && node.id == null && node.sku == null);

async function rollback(file) {
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  for (const e of ledger.entries) {
    const paths = {
      [`shopify_sync/${e.pid}`]: e.sync,
      [`shopify_sync/_claims/${e.claimKey}`]: e.claim,
      [`shopify_publish/${e.pid}`]: e.publish,
    };
    const present = [];
    for (const p of Object.keys(paths)) if ((await val(p)) != null) present.push(p);
    if (present.length) { log(`✗ ${e.pid}: not restored — already present again: ${present.join(", ")}`); continue; }
    await db.ref().update(paths);
    log(`✓ ${e.pid}: link restored (${e.gid}); the next sweep pushes the app's numbers`);
  }
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);
  if (!PIDS.length) throw new Error("--pids p1,p2,… is required");
  const products = (await val("products")) || {};
  const liveBySku = new Map();
  for (const [id, p] of Object.entries(products)) {
    if (!p || p.mergedInto || p.sku == null) continue;
    const k = String(p.sku);
    if (!liveBySku.has(k)) liveBySku.set(k, []);
    liveBySku.get(k).push(`${id} ${p.name || ""}`.trim());
  }
  const locId = await requireSingleLocation(graphql);

  const plans = [];
  for (const pid of PIDS) {
    const node = products[pid] ?? null;
    if (!isDeadProduct(node)) { log(`✗ ${pid}: the app product exists (${node.name || node.id}) — not dead, skipped`); continue; }
    const sync = await val(`shopify_sync/${pid}`);
    const publish = await val(`shopify_publish/${pid}`);
    const gid = sync?.shopifyProductId;
    if (!gid) { log(`✗ ${pid}: no /shopify_sync map — nothing to park`); continue; }
    const claimKey = claimKeyFor(gid);
    const claim = await val(`shopify_sync/_claims/${claimKey}`);
    if (claim != null && claim !== pid) { log(`✗ ${pid}: claim ${claimKey} names ${claim}, not this pid — skipped`); continue; }
    const variants = await readSkus(gid);
    if (!variants) { log(`✗ ${pid}: Shopify has no product ${gid} — skipped`); continue; }
    const sku = skuOfVariants(variants);
    const live = sku ? liveBySku.get(sku) || [] : [];
    if (live.length) { log(`✗ ${pid}: SKU ${sku} is on a live product (${live.join("; ")}) — re-link by hand, not parked`); continue; }
    const dry = await zeroUnmanagedListing(graphql, gid, { commit: false, locationId: locId });
    if (!dry.ok) { log(`✗ ${pid}: ${dry.why}`); continue; }
    log(`• ${pid} → ${gid} · SKU ${sku ?? "?"} · no live product has it · Shopify holds ${dry.shopifyUnits} unit(s)` +
      (node ? ` · stray product fields: ${Object.keys(node).join(",")}` : ""));
    plans.push({ pid, gid, claimKey, sku, sync, publish, claim, shopifyBefore: dry.drift.map((d) => ({ size: d.sizeKey, inventoryItemId: d.inventoryItemId, quantity: d.shopify })), dry });
  }
  if (!COMMIT) { log(`dry run: ${plans.length} of ${PIDS.length} would be unlinked and zeroed`); return 0; }
  if (!plans.length) return 0;

  mkdirSync(ROLLBACK_DIR, { recursive: true });
  const file = join(ROLLBACK_DIR, `park-dead-links-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind: "park-dead-links",
    entries: plans.map(({ dry, ...e }) => e) }, null, 1));
  log(`ledger: ${file}`);

  let bad = 0;
  for (const p of plans) {
    await db.ref().update({
      [`shopify_sync/${p.pid}`]: null,
      [`shopify_sync/_claims/${p.claimKey}`]: null,
      [`shopify_publish/${p.pid}`]: null,
    });
    const res = await zeroUnmanagedListing(graphql, p.gid, { commit: true, locationId: locId });
    const after = await zeroUnmanagedListing(graphql, p.gid, { commit: false, locationId: locId });
    const ok = res.ok && after.ok && after.shopifyUnits === 0 && !after.drift.length;
    if (!ok) bad++;
    log(`${ok ? "✓" : "✗"} ${p.pid}: unlinked; Shopify ${p.dry.shopifyUnits} → ${after.shopifyUnits} unit(s)${res.why ? ` (${res.why})` : ""}`);
  }
  return bad ? 1 : 0;
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  console.error(`✗ park-dead-links failed: ${String(e?.message || e)}`);
  process.exit(1);
});
