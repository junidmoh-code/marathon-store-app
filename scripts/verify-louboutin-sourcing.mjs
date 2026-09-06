// ─── BEFORE/AFTER FOR THE 2026-09-06 REPORT, AGAINST LIVE DATA ───────────────
// Drives the SHIPPED modules (availabilityCore.resolveSneakerSourcingHub and
// cellAvailability — the same functions App.jsx sneakerHubOf/sneakerOut call)
// over the live /stock rows, so this is the sheet's own code path, not a
// re-implementation of it. Reads /products/{pid}, /stock/{hub}/{pid} and
// /orders by key range — bounded, the kiosk's own pattern.
import { adminRequire } from "./adminRequire.mjs";
const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const { resolveSneakerSourcingHub, cellAvailability, readyPromisedByCell, gatedSneakerHub } =
  await import("../src/components/stock/availabilityCore.js");
const { decodeSizeKey } = await import("../src/utils/sizeKey.js");

const PID = process.argv[2] || "p1788276348886";
// REPLAYING A TAG THAT HAS SINCE BEEN CORRECTED. The reported product's `hubs`
// read ["hub1"] at 10:59 on 2026-09-06 and ["hub2"] two minutes later — someone
// re-tagged it by hand while this was being diagnosed, which fixes that ONE
// product and none of the other 30. `--as-tagged hub1` replays the tag as it
// was, against today's real cells, so the exact reported configuration can
// still be proved. Nothing is written; this is a read-only report.
const TAG_OVERRIDE = process.argv.includes("--as-tagged")
  ? process.argv[process.argv.indexOf("--as-tagged") + 1] : null;
const prod = (await db.ref(`products/${PID}`).once("value")).val();
const tag = TAG_OVERRIDE
  || (prod?.hubs || (prod?.hub ? [prod.hub] : [])).find(h => h === "hub1" || h === "hub2") || "hub1";

// useStockCellsState's shape: stored keys decoded on the way in.
const loadCells = async (hub) => {
  const raw = (await db.ref(`stock/${hub}/${PID}`).once("value")).val();
  const out = { [PID]: {} };
  if (raw) for (const k of Object.keys(raw)) if (raw[k] != null) out[PID][decodeSizeKey(k)] = raw[k];
  return out;
};
const orders = Object.values((await db.ref("orders").orderByKey().startAt("0").endAt("9").once("value")).val() || {});
const productsById = { [PID]: prod };
const hubData = {};
for (const h of ["hub1", "hub2"]) hubData[h] = {
  cells: await loadCells(h), promised: readyPromisedByCell(orders, h, productsById), ready: true,
};

const sizes = (Array.isArray(prod?.sizes) ? prod.sizes : []).filter(x => x && String(x).trim() && x !== "_");
console.log(`${prod?.name}\n  pid=${PID}  hubs tag=${JSON.stringify(prod?.hubs ?? prod?.hub)}${TAG_OVERRIDE ? ` (REPLAYED as ${TAG_OVERRIDE})` : ""}  ->  tag-routed hub = ${tag}\n`);
console.log("size   BEFORE (tag hub)                     AFTER (stock-aware)");
console.log("────   ─────────────────────────────────    ──────────────────────────────────");
for (const size of sizes) {
  const beforeHub = tag;
  const beforeAvail = cellAvailability({ ...hubData[beforeHub], productId: PID, size });
  const afterHub = resolveSneakerSourcingHub({
    product: prod, taggedHub: gatedSneakerHub(prod, tag), size, hubData }) || tag;
  const afterAvail = cellAvailability({ ...hubData[afterHub], productId: PID, size });
  const mark = (n) => n > 0 ? `${n} unit${n === 1 ? "" : "s"} — ORDERABLE` : "0 — ✕ BLOCKED";
  console.log(`${String(size).padEnd(6)} ${beforeHub}: ${mark(beforeAvail).padEnd(30)} ${afterHub}: ${mark(afterAvail)}`);
}
process.exit(0);
