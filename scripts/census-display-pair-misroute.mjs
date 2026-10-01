// ── HOW MANY DISPLAY-PAIR LINES EXIST, AND HOW MANY WENT TO THE WRONG HUB ────
// READ-ONLY.
//   node --import ./scripts/lib/appModuleLoader.mjs scripts/census-display-pair-misroute.mjs
//
// A displayPairRequest order names an IDENTIFIED PHYSICAL PAIR on a named
// shop's floor, registered against Hub 1 — the display lane is hub1-scoped
// (slots, register, sneakerServedByHub1). Its hub is a fact, not a routing
// question.
//
// #568 (2026-09-06) made placement resolve EVERY sneaker line's hub from live
// stock. From that moment a display-pair line whose Hub 1 availability had hit
// zero between the request and checkout could be placed against HUB 2 — a hub
// with no display register and no slot for it, carrying "take it off the
// display" and a Hub 1 store name it cannot act on.
//
// This counts what is actually in /orders. NOTE THE WINDOW: #568 merged the
// morning of 2026-09-06, so anything before that could not have been misrouted
// by it and is reported separately.
import { adminRequire } from "./adminRequire.mjs";
const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const { DISPLAY_PAIR_HUB } = await import("../src/components/stock/availabilityCore.js");

// #568's merge commit, from git log.
const CUTOFF = "2026-09-06T00:00:00.000Z";

const orders = Object.values((await db.ref("orders").once("value")).val() || {})
  .filter((o) => o && typeof o === "object" && o.id);
const pairs = orders.filter((o) => o.displayPairRequest === true);

console.log(`/orders records: ${orders.length}`);
console.log(`display-pair lines: ${pairs.length}\n`);
if (!pairs.length) { console.log("nothing to check."); process.exit(0); }

const wrong = pairs.filter((o) => (o.hub || "hub1") !== DISPLAY_PAIR_HUB
  || (o.placedAtHub && o.placedAtHub !== DISPLAY_PAIR_HUB));
console.log(`routed somewhere other than ${DISPLAY_PAIR_HUB}: ${wrong.length}`);
const since = wrong.filter((o) => String(o.createdAt || "") >= CUTOFF);
console.log(`  ...of those, placed on or after ${CUTOFF.slice(0, 10)} (when #568 made placement stock-aware): ${since.length}`);

const byHub = {};
for (const o of pairs) { const k = `${o.hub || "-"}/${o.placedAtHub || "-"}`; byHub[k] = (byHub[k] || 0) + 1; }
console.log(`\nhub/placedAtHub distribution across all display-pair lines:`);
for (const [k, v] of Object.entries(byHub).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v}`);

if (wrong.length) {
  console.log(`\nthe misrouted lines:`);
  for (const o of wrong.slice(0, 25)) {
    console.log(`  ${String(o.id).padEnd(6)} ${String(o.createdAt || "?").slice(0, 19)}  ` +
      `${JSON.stringify(o.productName || "").slice(0, 40).padEnd(42)} size ${String(o.size).padEnd(5)} ` +
      `hub=${o.hub} placedAtHub=${o.placedAtHub} store=${o.displayPairStore || "-"} status=${o.status}`);
  }
}
// The other half of the risk: a line still OPEN and therefore still placeable
// wrong if it is re-placed, and one whose display store does not match its hub.
const openWrong = wrong.filter((o) => o.status !== "collected" && o.status !== "cancelled");
console.log(`\nstill open (not collected/cancelled): ${openWrong.length}`);
process.exit(0);
