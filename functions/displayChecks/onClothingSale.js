// ─── DISPLAY CHECKS — onClothingSale TRIGGER (writes only, no UI) ─────────────
// Gen-2 RTDB onCreate on /stock_movements/{movementId}. A clothing `sold`
// movement at an enabled store becomes (or bumps) a display check. DORMANT:
// nothing staff-facing reads these namespaces yet.
//
// SALE SOURCE — PROVEN: /stock_movements `type === "sold"`, one movement per
// (sale, product, size) cell, `from` = selling shop, `qty` = units
// (docs/display-checks-sale-source.md).
//
// ── ACTIVE INDEX (the never-null model) ──────────────────────────────────────
// A check lives at ONE address for its whole active life:
//   /displayChecks_active/{store}/{dedupeKey}   held → open → completed(tombstone)
// One record per SKU. It NEVER moves and is NEVER deleted while active — the
// next sale OVERWRITES a completed tombstone, the sweep flips held→open IN
// PLACE. Because the record is never null during active life, a sale bump's
// cold-safe `cur ?? preRead` transaction can never resurrect a deleted ghost
// (the class that bit this module repeatedly), and the bumpTxn checkId fence
// stops a stale bump from crediting an overwritten slot.
//   /displayChecks/{store}/{saDate}/{checkId}   COMPLETED archive (day node,
//                                               keyed by checkId; written by
//                                               PR-7 completion + the overwrite)
//   /displayChecks_log/{store}/{YYYY-MM}/{eventId}   append-only audit
//   /displayChecks_meta/{store}/processed/{movementId}   idempotency lease
// Reads existing data only (/products, /stock, /displayChecks_settings).
// NOTHING in POS / warehouse / refill / inventory changes.
//
// IDEMPOTENCY — leased state record (movement-global, survives midnight):
// …processed/{movementId} = { at, saDate, done }. Claimed done:false before any
// write; saDate FROZEN on first claim; done:true only after every write lands; a
// stale (PROCESS_LEASE_MS) lease is stealable so a crash retries. Bumps are
// transactions (bumpTxn): status re-validated, checkId fenced, movement fenced,
// lastSoldAt monotonic.
//
// CREATE serialization is the active-record transaction itself (create-if-empty-
// or-completed) — no separate mutex needed: one record per dedupeKey, so a
// concurrent create loses the CAS and re-resolves into a bump.
//
// DEPLOY (Junid only; scoped): firebase deploy --only functions:onClothingSale

"use strict";

const { onValueCreated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const { isTriggerStoreEnabled, isDisplaySale, normStoreSettings, isRegistryStore } = require("./lib.cjs");
const { loadNetwork } = require("../lib/network-load.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// The create/bump logic lives in processSale.js (shared with onDisplaySale).
const { processDisplaySale, bumpCheck } = require("./processSale.js");
const { loadStoreSettings } = require("./settings.cjs");

// Exported for the cold-cache / checkId-fence regression tests.
exports.bumpCheck = bumpCheck;

exports.onClothingSale = onValueCreated(
  {
    ref: "/stock_movements/{movementId}",
    instance: "marathon-club-default-rtdb",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const m = event.data.val();
    if (!m || typeof m !== "object") return;

    // ── Early returns, cheapest first (fires on EVERY stock movement) ──
    const store = m.from;
    if (m.type !== "sold") return;                  // sale-type only
    if (!m.productId) return;
    // Store flag (also drops hubs): a LIVE store in the network registry —
    // one small node, cached per instance for a minute, read for sales only.
    // …or this store's own display-check switch (/displayChecks_settings/{store}
    // enabled), when Junid has set one. Scope: clothing (default) or
    // everything but sneakers.
    const network = await loadNetwork(admin.database());
    if (!isRegistryStore(store, network)) return;   // hubs, Central: no settings read at all
    const settings = await loadStoreSettings(admin.database(), store);
    if (!isTriggerStoreEnabled(store, network, settings)) return;
    const product = (await admin.database().ref(`products/${m.productId}`).get()).val();
    if (!isDisplaySale(product, m.size, normStoreSettings(settings).scope, m.productId)) return;   // one product get

    const db = admin.database();
    await processDisplaySale(db, {
      store, movementId: event.params.movementId,
      m: { productId: m.productId, size: m.size, qty: m.qty, ts: m.ts, saleId: (m.link && m.link.saleId) || null },
      product,
    });
  }
);
