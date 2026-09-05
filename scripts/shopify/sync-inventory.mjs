// ─── PUSH APP STOCK TO SHOPIFY — dry by default ─────────────────────────────
//
//   node scripts/shopify/sync-inventory.mjs --all            # show the drift
//   node scripts/shopify/sync-inventory.mjs --all --commit   # correct it
//   node scripts/shopify/sync-inventory.mjs --pid p123 --commit
//   node scripts/shopify/sync-inventory.mjs --dirty --commit # drain the markers
//
// WITHOUT --commit NOTHING IS WRITTEN. It reads both sides and prints what
// differs, which is how the 2026-08-27 drift was found in the first place.
//
// ── WHAT IS AUTOMATIC AND WHAT IS NOT ───────────────────────────────────────
// This file is the MANUAL door. The automatic half is the pair that landed with
// it: the `shopifyInventoryDirty` Cloud Function marks a product when its stock
// moves, and reconcile.mjs drains those markers on every COMMIT tick (the Mac
// mini, every two minutes). So ordinary day-to-day drift corrects itself.
//
// Until PR #559 this comment claimed the sweep already existed when nothing on
// main imported the module at all — an operator reading it would have believed
// inventory was being corrected while 564 products sat drifted. It is spelled
// out here because that is the failure mode of a comment about a wiring.
//
// The manual door still earns its place, for the one-off repair (`--all
// --commit`, which is what closed the 2026-09-05 oversell), and for answering
// "what does Shopify think it has right now" without waiting for a tick.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { readAllPublishNodes } from "./publishNode.mjs";
import { syncProduct, sweepDirty, locationNames } from "./inventorySync.mjs";
import { requireSingleLocation } from "./inventory.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");
const argOf = (n) => { const i = flags.indexOf(n); return i >= 0 ? flags[i + 1] : null; };

const nodes = await readAllPublishNodes(db);
const liveOn = new Set(Object.entries(nodes)
  .filter(([, n]) => n?.state === "live" && n?.liveState === "on")
  .map(([pid]) => pid));

if (flags.includes("--dirty")) {
  // A manual run takes the WHOLE queue in one go — no rotation, because there
  // is no next tick to carry a cursor to and a person running this by hand is
  // asking for all of it. The per-run cap exists to keep a scheduled tick
  // short, which is not what this is.
  const r = await sweepDirty(db, graphql, {
    commit: COMMIT, isLive: (p) => liveOn.has(p), max: Number.MAX_SAFE_INTEGER, log: console.log,
  });
  // `remaining` counts markers that are demonstrably still on the node — the
  // ones past the per-run cap AND the ones deliberately kept because their push
  // did not happen. A dry run clears nothing, so it reports the whole queue.
  console.log(`markers seen ${r.seen} · products pushed ${r.pushed} · markers cleared ${r.cleared}` +
    `${r.kept ? ` · ${r.kept} kept (not pushed — they retry)` : ""}` +
    `${r.remaining ? ` · ${r.remaining} still marked` : ""}` +
    `${COMMIT ? "" : "  [dry run — no marker was cleared]"}`);
  process.exit(0);
}

const one = argOf("--pid");
const pids = one ? [one] : flags.includes("--all") ? [...liveOn] : null;
if (!pids) { console.error("usage: --all | --pid <id> | --dirty  [--commit]"); process.exit(2); }

console.log(`${COMMIT ? "CORRECTING" : "DRY RUN —"} ${pids.length} live product(s)\n`);
// ── THE LOCATION IS LOOKED UP ONCE, NOT ONCE PER PRODUCT ────────────────────
// syncProduct resolves it itself when not given one, which is right for a
// single call and wrong for 866 of them: it turned a 2-query product into a
// 3-query product and put an extra 866 calls through a leaky bucket that
// throttles. The first full run was on course for hours.
const locationId = await requireSingleLocation(graphql);
// The location NAMES too — desiredFor would otherwise re-read them per product.
const locNames = await locationNames(db);
let drifted = 0, variants = 0, zeroed = 0;
const zeroRows = [];
// Products the app calls live that Shopify no longer has. Collected separately
// because it is the OPPOSITE failure from an oversell, and would otherwise be
// seven lines lost inside a report about quantities.
const gone = [];
for (const pid of pids) {
  let r;
  try { r = await syncProduct(db, graphql, pid, { commit: COMMIT, locationId, locNames }); }
  catch (e) { console.log(`✗ ${pid}: ${String(e?.message || e)}`); continue; }
  if (r.ok === false) { console.log(`✗ ${pid}: ${r.why}`); if (r.productGone) gone.push(pid); continue; }
  if (r.staleVariants?.length) console.log(`  ⚠ ${pid}: ${r.staleVariants.length} variant(s) point at inventory items Shopify does not know — id map stale, the rest were still corrected`);
  if (r.skipped || !r.drift?.length) continue;
  drifted++; variants += r.drift.length;
  console.log(`${COMMIT ? "✓" : "·"} ${pid}`);
  for (const d of r.drift) {
    // The dangerous direction, called out by name: Shopify offering stock the
    // app does not have. Everything else is a display error; this one sells
    // something that cannot be shipped.
    const danger = d.shopify > d.quantity;
    const zero = d.quantity === 0 && d.shopify > 0;
    if (zero) { zeroed++; zeroRows.push({ pid, ...d }); }
    console.log(`    ${d.sizeKey.padEnd(7)} app=${String(d.quantity).padStart(3)}  shopify=${String(d.shopify).padStart(3)}` +
      `${danger ? "   ← OVERSELLABLE" : ""}${zero ? " (app has NONE)" : ""}`);
  }
}
console.log(`\n${drifted} product(s), ${variants} variant(s) drifted · ${zeroed} sellable at zero stock`);
if (zeroRows.length) {
  console.log(`\nSELLABLE AT ZERO — these could be bought and not shipped:`);
  for (const z of zeroRows) console.log(`  ${z.pid} ${z.sizeKey}  shopify was offering ${z.shopify}`);
  console.log(COMMIT ? "  ↑ all now set to 0 on Shopify — off the shop." : "  ↑ run again with --commit to take them off the shop.");
}
if (gone.length) {
  console.log(`\nDELETED FROM SHOPIFY — the app still records these as live and on:`);
  for (const p of gone) console.log(`  ${p}`);
  console.log(`  ↑ NOT an oversell — the opposite. Nothing here can correct them:`);
  console.log(`    the product must be re-published, or its publish node taken off.`);
}
process.exit(0);
