// ── BEFORE/AFTER THROUGH THE ORDER SHEET'S OWN CODE PATH ─────────────────────
// READ-ONLY. Drives the SHIPPED modules — resolveSneakerSourcing and
// cellAvailability, the exact functions App.jsx sneakerSourcing/sneakerOut call
// — over live /stock and /orders. Not a re-implementation.
//
//   node --import ./scripts/lib/appModuleLoader.mjs scripts/verify-sourcing-cart-fix.mjs [pid]
//
// BEFORE is the shipped-at-#568 behaviour, reconstructed exactly:
//     hub      = the resolver, deciding from stock ALONE
//     blocked  = cellAvailability(that hub) <= cartDepth      (cart applied after)
// AFTER drives the REAL allocation: `cartDepth` ordinary lines are allocated
// through allocateSneakerCart exactly as the screen allocates them, and the
// next line's answer is what the chip would show.
//
// The cart depth is the point. With an EMPTY cart the two agree everywhere —
// which is why #568's own before/after report showed nothing wrong. The fault
// only appears once the device holds units the resolver could not see.
import { adminRequire } from "./adminRequire.mjs";
const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const { resolveSneakerSourcing, allocateSneakerCart, cellAvailability, readyPromisedByCell, gatedSneakerHub, GATED_SNEAKER_HUBS } =
  await import("../src/components/stock/availabilityCore.js");
const { decodeSizeKey } = await import("../src/utils/sizeKey.js");

const PID = process.argv[2] || "p1788276348886";
const DEPTHS = [0, 1, 2, 3];

const prod = (await db.ref(`products/${PID}`).once("value")).val();
const tag = (prod?.hubs || (prod?.hub ? [prod.hub] : [])).find((h) => GATED_SNEAKER_HUBS.includes(h)) || "hub1";
const loadCells = async (hub) => {
  const raw = (await db.ref(`stock/${hub}/${PID}`).once("value")).val();
  const out = { [PID]: {} };
  if (raw) for (const k of Object.keys(raw)) if (raw[k] != null) out[PID][decodeSizeKey(k)] = raw[k];
  return out;
};
// ALL of /orders, paged. The ranged read this was copied from carries a
// \uf8ff sentinel that is INVISIBLE in sed, grep and JSON.stringify alike, so a
// hand-typed copy silently becomes endAt("9") — which returns 8 of 565 customer
// orders on live data and leaves the promise map nearly empty. A verification
// script that overstates availability cannot verify anything (independent
// review, 2026-09-06).
const { readMapPaged } = await import("./lib/rtdbPaged.mjs");
const orders = Object.values(await readMapPaged(db, "orders", { pageSize: 500 }));
const productsById = { [PID]: prod };
const hubData = {};
for (const h of GATED_SNEAKER_HUBS) hubData[h] = {
  cells: await loadCells(h), promised: readyPromisedByCell(orders, h, productsById), ready: true,
};

const sizes = (Array.isArray(prod?.sizes) ? prod.sizes : []).filter((x) => x && String(x).trim() && x !== "_");
const taggedHub = gatedSneakerHub(prod, tag);
console.log(`${prod?.name}`);
console.log(`  pid=${PID}  hubs tag=${JSON.stringify(prod?.hubs ?? prod?.hub)}  ->  routing tag = ${tag}`);
console.log(`  raw availability now: ` + GATED_SNEAKER_HUBS.map((h) =>
  `${h} [` + sizes.map((sz) => `${sz}:${cellAvailability({ ...hubData[h], productId: PID, size: sz })}`).join(" ") + `]`).join("  "));

let changed = 0;
for (const depth of DEPTHS) {
  console.log(`\n── cart already holds ${depth} of that size ──────────────────────────────`);
  console.log("size   BEFORE (#568 as shipped)              AFTER (cart in the resolver)");
  console.log("────   ───────────────────────────────────   ───────────────────────────────────");
  for (const size of sizes) {
    // BEFORE: resolver blind to the cart, cart applied afterwards.
    const beforeHub = resolveSneakerSourcing({ product: prod, taggedHub, size, hubData, consumed: 0 }).hub || tag;
    const beforeAvail = cellAvailability({ ...hubData[beforeHub], productId: PID, size });
    const beforeBlocked = beforeAvail <= depth;
    // AFTER: the real allocation of `depth` lines, then the next line's answer.
    const lines = Array.from({ length: depth }, () => ({ product: prod, size }));
    const { consumed } = allocateSneakerCart({
      lines, hubData, taggedHubFor: () => taggedHub,
    });
    const after = resolveSneakerSourcing({
      product: prod, taggedHub, size, hubData,
      consumedByHub: consumed.get(`${PID}::${size}`) || null,
    });
    const afterBlocked = !(Number.isFinite(after.available) && after.available > 0);
    if (beforeBlocked !== afterBlocked) changed += 1;
    const say = (hub, blocked, n) => `${hub}: ${blocked ? "✕ BLOCKED" : `${n} more — ORDERABLE`}`;
    const flag = beforeBlocked && !afterBlocked ? "   <-- FIXED" : "";
    console.log(`${String(size).padEnd(6)} ${say(beforeHub, beforeBlocked, Math.max(beforeAvail - depth, 0)).padEnd(37)} ` +
                `${say(after.hub, afterBlocked, after.available)}${flag}`);
  }
}
console.log(`\n${changed} size/depth combination(s) changed answer for this product.`);
process.exit(0);
