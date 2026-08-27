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
// This is the manual door onto the same module the reconciler now sweeps with
// every commit tick (see inventorySync.mjs). It exists for the one-off repair
// and for answering "what does Shopify think it has right now" without waiting
// for a tick.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { readAllPublishNodes } from "./publishNode.mjs";
import { syncProduct, sweepDirty } from "./inventorySync.mjs";

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
  const r = await sweepDirty(db, graphql, { commit: COMMIT, isLive: (p) => liveOn.has(p), log: console.log });
  console.log(`markers seen ${r.seen} · products pushed ${r.pushed} · markers cleared ${r.cleared}${r.remaining ? ` · ${r.remaining} left for the next run` : ""}`);
  process.exit(0);
}

const one = argOf("--pid");
const pids = one ? [one] : flags.includes("--all") ? [...liveOn] : null;
if (!pids) { console.error("usage: --all | --pid <id> | --dirty  [--commit]"); process.exit(2); }

console.log(`${COMMIT ? "CORRECTING" : "DRY RUN —"} ${pids.length} live product(s)\n`);
let drifted = 0, variants = 0, zeroed = 0;
const zeroRows = [];
for (const pid of pids) {
  let r;
  try { r = await syncProduct(db, graphql, pid, { commit: COMMIT }); }
  catch (e) { console.log(`✗ ${pid}: ${String(e?.message || e)}`); continue; }
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
process.exit(0);
