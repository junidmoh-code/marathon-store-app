// The naming worklist: publishable today, NOT gated by the shared-photo check,
// and not already carrying a proposal. Written to /tmp/naming-scope.json for
// name-remaining.sh to chunk through. Read-only, writes nothing to RTDB.
// The naming scope: publishable today, MINUS every product in a shared-photo
// group where the photo cannot be trusted to describe it.
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const { readMapPaged } = await import("../lib/rtdbPaged.mjs");
const { isPriceRecord } = await import("../../src/utils/productCategory.js");
const { mayProposeFor } = await import("../../src/utils/visionNaming.js");

// ── THE GATE FILE IS CHECKED, NOT ASSUMED ────────────────────────────────────
// A missing or malformed gate file used to throw, and name-remaining.sh reads
// ANY non-zero exit from this script as a network problem: it sleeps 30
// seconds and retries, 200 times. So a bad gate file produced about 100
// minutes of silent no-op instead of a stop (reviewer finding) — and moving
// the file out of /tmp, which run-naming.sh does, exists precisely because
// this class of failure survives a reboot.
const GATE_PATH = process.env.PHOTO_GATE || "/tmp/groupkind2.json";
let kinds;
try {
  kinds = JSON.parse(readFileSync(GATE_PATH, "utf8"));
} catch (e) {
  console.error(`STOP: the shared-photo gate at ${GATE_PATH} could not be read (${e?.message || e}).`);
  console.error(`This is not a network problem and retrying will not fix it. Point PHOTO_GATE at a`);
  console.error(`readable groupkind2.json, or regenerate it, then start the run again.`);
  process.exit(3);
}
if (!Array.isArray(kinds?.differentProducts) || !Array.isArray(kinds?.crossBrand)) {
  console.error(`STOP: ${GATE_PATH} is missing the "differentProducts" and/or "crossBrand" arrays.`);
  console.error(`Without them every shared-photo product would be treated as ungated and named`);
  console.error(`from a photo that does not describe it. Refusing to guess.`);
  process.exit(3);
}
// Gate: different-products-one-photo AND cross-brand. The 2 genuine
// one-style groups are NOT gated.
const gated = new Set([...kinds.differentProducts.flat(), ...kinds.crossBrand.flat()]);

// PAGED, all three. This script runs before EVERY chunk of the backlog — about
// twenty times in a full run — so a whole-node read here is not paid once, it
// is paid twenty times (reviewer finding). /shopify_publish is ~1,500 nodes
// and /stock is larger still.
const products = await readMapPaged(db, "products", { pageSize: 500 });
const publish = await readMapPaged(db, "shopify_publish", { pageSize: 400 });
const stock = await readMapPaged(db, "stock", { pageSize: 50 });
const UNSELLABLE = new Set(["in_transit"]);
const units = (pid) => {
  let u = 0;
  for (const [loc, per] of Object.entries(stock)) {
    if (UNSELLABLE.has(loc)) continue;
    for (const c of Object.values(per?.[pid] || {})) {
      const q = c !== null && typeof c === "object" ? c.qty : c;
      u += Math.max(0, Number(q) || 0);
    }
  }
  return u;
};
const run = (p) => (Array.isArray(p.sizes) ? p.sizes : Object.values(p.sizes || {})).map(String).length;
const isLive = (pid) => publish[pid]?.state === "live" && publish[pid]?.liveState === "on";

const scope = [], skipped = { gated: 0, manual: 0, alreadyProposed: 0 };
for (const [pid, p] of Object.entries(products)) {
  if (!p?.id || p.mergedInto || isPriceRecord(p)) continue;
  if (isLive(pid)) continue;
  if (!(units(pid) > 0 && String(p.photoUrl || "").trim() && Number(p.retailPrice) > 0 && run(p) > 0)) continue;
  if (gated.has(pid)) { skipped.gated += 1; continue; }
  if (!mayProposeFor(publish[pid])) { skipped.manual += 1; continue; }
  if (publish[pid]?.nameProposal) { skipped.alreadyProposed += 1; continue; }
  scope.push(pid);
}
scope.sort();
console.log(`publishable, ungated, unnamed : ${scope.length}`);
console.log(`  skipped — shared-photo gate  : ${skipped.gated}`);
console.log(`  skipped — manual name        : ${skipped.manual}`);
console.log(`  skipped — already proposed   : ${skipped.alreadyProposed}`);
writeFileSync("/tmp/naming-scope.json", JSON.stringify(scope));
console.log(`wrote /tmp/naming-scope.json`);
process.exit(0);
