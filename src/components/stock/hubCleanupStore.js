// ─── HUB STOCK CLEANUP — DATA LAYER ──────────────────────────────────────────
// Every read and write behind the combined card, in one file, under the same
// two rules as hubCountStore.js:
//
//   1. NO onValue. One-shot get()s only — the biggest node touched here is a
//      whole hub's /stock subtree, and a live subscription over that would
//      re-render under the operator's thumb on every POS sale.
//   2. NO NEW STOCK WRITE PATH. A display registration is a `received` movement
//      through applyMovement — the single writer to /stock — with a
//      DETERMINISTIC movement id, which is what makes it idempotent: the same
//      display scanned twice produces the same id, and applyMovement no-ops the
//      second one. (`received` and not `adjustment`, deliberately: the live
//      rules let stockRole "warehouse" write received movements, and the people
//      doing this walk are hub staff.)
//
// Session state lives under /settings/hubSneakerCount (HUB_COUNT_ROOT) beside
// the count session it merges with:
//   register/{hub}/{pid__sizeKey}   { productId, sizeKey, size, qty, at, by,
//                                     movementId, productName }
//   unresolved/{hub}/{codeKey}      { code, at, by, context }

import { ref, child, get, update, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { stockSizeKey } from "../../utils/sizeKey";
import { serverNowIso } from "../../utils/serverTime";
import { getDeviceId } from "../../device/deviceId";
import { HUB_COUNT_ROOT } from "../../config/hubSneakerCount";
import { forgivingBarcodeCandidates } from "./scanResolve";
import {
  isCleanupHub, registerKey, registerMovementId, extraUnitMovementId,
} from "./hubCleanupCore";

const one = async (path) => (await get(child(ref(database), path))).val();

const registerPath = (hub) => `${HUB_COUNT_ROOT}/register/${hub}`;
const unresolvedPath = (hub) => `${HUB_COUNT_ROOT}/unresolved/${hub}`;

export const REGISTER_REASON = "display_registration";

/** Everything registered at this hub so far → { "pid__sizeKey": record }. */
export async function loadRegister(hub) {
  return (await one(registerPath(hub))) || {};
}

export async function loadUnresolved(hub) {
  return (await one(unresolvedPath(hub))) || {};
}

/**
 * Register one display unit: +qty onto the hub's cell for that size, then the
 * registration record. Idempotent per (hub, product, size):
 *   • the movement id is deterministic, so a double-write of the SAME slot
 *     collapses inside applyMovement;
 *   • an existing record returns { already: true } WITHOUT writing anything —
 *     the UI shows the registered state and offers "+1 more" deliberately.
 */
export async function registerDisplayUnit({ hub, product, size, qty = 1 }) {
  if (!isCleanupHub(hub)) return { ok: false, message: "Only Hub 1 and Hub 2 are in scope." };
  if (!product || !product.id) return { ok: false, message: "No product." };
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 1) return { ok: false, message: "Quantity must be a whole number, 1 or more." };
  const rawSize = String(size ?? "").trim();
  // Refuse anything that ENCODES to the "_" one-size sentinel — not just the
  // literal "_". This is the chokepoint that once let the "Free Size" display
  // label mint a phantom "_" cell; a display always has a real size.
  const sizeKey = stockSizeKey(rawSize);
  if (!rawSize || sizeKey === "_") return { ok: false, message: "Pick the size on the display." };
  const key = registerKey(product.id, sizeKey);
  const recPath = `${registerPath(hub)}/${key}`;

  const existing = await one(recPath);
  if (existing) return { ok: true, already: true, record: existing };

  const res = await applyMovement({
    type: "received",
    productId: product.id,
    size: rawSize,                       // RAW size — applyMovement owns the key encoding
    qty: n,
    to: hub,
    reason: REGISTER_REASON,
    actorRole: "warehouse",
    movementId: registerMovementId(hub, product.id, sizeKey),
    link: { deviceId: getDeviceId(), displayRegisterHub: hub },
  });
  if (!res.ok) {
    return { ok: false, message: `Could not add the unit: ${res.reason || "write failed"}` };
  }

  const user = auth.currentUser;
  const rec = {
    productId: product.id,
    productName: product.name || "",
    sizeKey,
    size: rawSize,
    qty: n,
    at: serverNowIso(),
    by: user ? user.uid : null,
    movementId: res.movementId,
  };
  // Create-once: if another device registered the same slot in the race window,
  // their record stands (the movement was shared anyway — one id, one unit).
  try {
    const txn = await runTransaction(ref(database, recPath), (cur) => (cur === null ? rec : undefined));
    const committed = txn && txn.committed;
    return { ok: true, record: committed ? rec : (txn.snapshot ? txn.snapshot.val() : rec), already: !committed, idempotent: !!res.idempotent };
  } catch (err) {
    return {
      ok: true, record: rec,
      warning: `The unit WAS added to stock (movement ${res.movementId}), but the progress record could not be saved: ${String(err?.message || err)}. Do not scan it again — the movement id protects against a double add.`,
    };
  }
}

/**
 * A SECOND physical display of the same product+size. Deliberate, separate
 * action — never the accidental path. The movement id is derived from the
 * quantity already registered, so two devices adding onto the same base build
 * the same id and only one unit lands; the record moves qty by a guarded
 * transaction against that same base.
 */
export async function addExtraDisplayUnit({ hub, product, size }) {
  if (!isCleanupHub(hub)) return { ok: false, message: "Only Hub 1 and Hub 2 are in scope." };
  if (!product || !product.id) return { ok: false, message: "No product." };
  const rawSize = String(size ?? "").trim();
  const sizeKey = stockSizeKey(rawSize);
  if (!rawSize || sizeKey === "_") return { ok: false, message: "Pick the size on the display." };
  const recPath = `${registerPath(hub)}/${registerKey(product.id, sizeKey)}`;
  const existing = await one(recPath);
  if (!existing || !Number.isInteger(Number(existing.qty))) {
    return { ok: false, message: "Register the first unit before adding another." };
  }
  const base = Number(existing.qty);

  const res = await applyMovement({
    type: "received",
    productId: product.id,
    size: rawSize,
    qty: 1,
    to: hub,
    reason: REGISTER_REASON,
    actorRole: "warehouse",
    movementId: extraUnitMovementId(hub, product.id, sizeKey, base),
    link: { deviceId: getDeviceId(), displayRegisterHub: hub },
  });
  if (!res.ok) return { ok: false, message: `Could not add the unit: ${res.reason || "write failed"}` };

  // Guarded bump: only the writer whose movement actually counted moves the
  // record from `base` to `base+1`; the race loser's transaction aborts.
  try {
    await runTransaction(ref(database, `${recPath}/qty`), (cur) => (cur === base ? base + 1 : undefined));
  } catch { /* movement carries the truth; the next load shows it */ }
  return { ok: true, idempotent: !!res.idempotent };
}

/**
 * A scan nothing owns. NOT an error — in pass two it is exactly how we learn an
 * item was never registered. Keyed by the (sanitised) code so re-scanning the
 * same mystery item updates one row instead of piling up.
 */
export async function recordUnresolvedScan({ hub, code, context }) {
  const codeKey = String(code ?? "").replace(/[.#$/\[\]\s]/g, "_").slice(0, 64) || "_";
  const user = auth.currentUser;
  try {
    await update(ref(database, `${unresolvedPath(hub)}/${codeKey}`), {
      code: String(code ?? ""),
      at: serverNowIso(),
      by: user ? user.uid : null,
      context: context || null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

export async function clearUnresolvedScan({ hub, codeKey }) {
  try {
    await update(ref(database, unresolvedPath(hub)), { [codeKey]: null });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * Fetch a product straight from /products, following any `mergedInto` chain to
 * its survivor (bounded, cycle-safe). This is how a HISTORICAL barcode row —
 * one pointing at a product merged away before this session's catalogue was
 * loaded, or merged on another device minutes ago — still resolves to the
 * record that answers for it today. Returns the live survivor, or null.
 */
export async function fetchProductFollowingMerge(productId) {
  let id = productId;
  for (let hops = 0; hops < 5 && id; hops++) {
    const p = await one(`products/${String(id).replace(/[.#$/\[\]\s]/g, "_")}`);
    if (!p) return null;
    if (!p.mergedInto || p.mergedInto === id) return p.mergedInto ? null : p;
    id = p.mergedInto;
  }
  return null;
}

/**
 * /barcodes lookup with the POS-forgiving typed-entry fallback: an exact scan
 * matches exactly; a hand-typed "1385" also tries its zero-padded variants.
 */
export async function lookupBarcode(code) {
  const exact = await one(`barcodes/${String(code).trim()}`);
  if (exact) return exact;
  for (const cand of forgivingBarcodeCandidates(code)) {
    const row = await one(`barcodes/${cand}`);
    if (row) return row;
  }
  return null;
}

/** One-shot /stock/{loc} for each location, for the Leftovers and Merge views. */
export async function loadAllStock(locationIds) {
  const out = {};
  for (const loc of locationIds || []) {
    out[loc] = (await one(`stock/${loc}`)) || {};
  }
  return out;
}

/**
 * Open duplicate rows, one shot, for the duplicate banner. The live rules for
 * this node are console-managed and may not grant client reads — a denial
 * degrades to "no banner" (scan resolution still surfaces two live products
 * claiming one code without this node), never to a broken screen.
 */
export async function loadDuplicateCandidates() {
  try {
    return (await one("duplicate_candidates")) || {};
  } catch {
    return {};
  }
}
