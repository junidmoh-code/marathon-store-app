// ─── DISPLAY CHECKS — onDisplaySale TRIGGER (a sale that wrote no movement) ──
// Gen-2 RTDB onCreate on /pos/sales/{saleId}. At a store whose shelf does not
// deduct yet (Concrete, Pine — not fully live), the till writes no `sold`
// movement for an untrusted line, so onClothingSale never hears of it. This
// trigger reads the sale itself and puts each such line on the display check
// — the SAME create/bump/held/roster logic (processSale.js), keyed by a
// synthetic "sale_<saleId>_<lineId>" so a re-fire never counts twice. A line
// that DID write a movement (a trusted line, a live store) is left to
// onClothingSale: saleLinesForDisplay never returns it.
//
// Runs only where the store's display check is ON (/displayChecks_settings/
// {store}/enabled, or the live rule) — and for the scope that store has.
//
// DEPLOY (scoped): firebase deploy --only functions:onDisplaySale
"use strict";

const { onValueCreated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const { isTriggerStoreEnabled, isDisplaySale, normStoreSettings, saleLinesForDisplay, saleLineLeaseId } = require("./lib.cjs");
const { processDisplaySale } = require("./processSale.js");
const { loadStoreSettings } = require("./settings.cjs");
const { loadNetwork } = require("../lib/network-load.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// Core — injectable db + now so the test drives it without admin.
async function handleDisplaySale({ db, saleId, sale, nowMs = null }) {
  const network = await loadNetwork(db);
  const lines = saleLinesForDisplay({ sale, network });
  if (!lines.length) return { lines: 0, checked: 0 };
  const store = lines[0].loc;
  const settings = await loadStoreSettings(db, store);
  if (!isTriggerStoreEnabled(store, network, settings)) return { lines: lines.length, checked: 0, off: true };
  const scope = normStoreSettings(settings).scope;
  let checked = 0;
  for (const l of lines) {
    const product = (await db.ref(`products/${l.productId}`).once("value")).val();
    if (!isDisplaySale(product, l.size, scope, l.productId)) continue;
    await processDisplaySale(db, {
      store, movementId: saleLineLeaseId(saleId, l.lineId),
      m: { productId: l.productId, size: l.size, qty: l.qty, ts: sale.createdAt ?? null, saleId },
      product, nowMs,
    });
    checked += 1;
  }
  return { lines: lines.length, checked };
}

exports.handleDisplaySale = handleDisplaySale;

exports.onDisplaySale = onValueCreated(
  {
    ref: "/pos/sales/{saleId}",
    instance: "marathon-club-default-rtdb",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const sale = event.data.val();
    if (!sale || typeof sale !== "object") return;
    await handleDisplaySale({ db: admin.database(), saleId: event.params.saleId, sale });
  }
);
