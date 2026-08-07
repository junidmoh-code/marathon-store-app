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
import { httpsCallable } from "firebase/functions";
import { database, auth, functions } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { stockSizeKey } from "../../utils/sizeKey";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { getDeviceId } from "../../device/deviceId";
import { HUB_COUNT_ROOT } from "../../config/hubSneakerCount";
import { forgivingBarcodeCandidates } from "./scanResolve";
import { normaliseStyleCode, formatStyleCodeForDisplay } from "../../utils/styleCode";
import { enqueueStyleCodeCapture } from "../../utils/styleCodeCapture";
import {
  isCleanupHub, registerKey, registerMovementId, extraUnitMovementId,
  STYLE_SKIP_REASONS,
} from "./hubCleanupCore";

const one = async (path) => (await get(child(ref(database), path))).val();

const registerPath = (hub) => `${HUB_COUNT_ROOT}/register/${hub}`;
const unresolvedPath = (hub) => `${HUB_COUNT_ROOT}/unresolved/${hub}`;

export const REGISTER_REASON = "display_registration";

// The alias store's ONE write path — the labelAlias callable on the Admin SDK
// (no client rules for /label_aliases exist or are needed).
const labelAliasFn = httpsCallable(functions, "labelAlias");
export async function addLabelAlias({ productId, tokens }) {
  const { data } = await labelAliasFn({ action: "add", productId, tokens });
  return data;
}
export async function matchLabelAlias(tokens) {
  const { data } = await labelAliasFn({ action: "match", tokens });
  return data;
}

// ── THE COLLISION QUESTION'S ONE WRITE PATH ─────────────────────────────────
// styleCodeSibling (Admin SDK) records how the operator answered "same shoe,
// or a different colourway?". differentColourway registers the product as a
// SIBLING owner of the code (both keep it, neither is flagged); sameShoe
// records the answer and upserts the duplicate pair so the existing merge flow
// takes over. Neither is ever resolved silently — this is only ever called
// from a screen where the operator tapped an answer.
const styleCodeSiblingFn = httpsCallable(functions, "styleCodeSibling");
export async function answerStyleCodeSibling({ action, code, productId, otherId }) {
  const { data } = await styleCodeSiblingFn({ action, code, productId, otherId });
  return data;
}

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
 *
 * ── STYLE CODE — the second fact, same action (owner correction 2026-08-06) ──
 * Registration attaches TWO facts to an existing product: the manufacturer
 * style number off the INNER TONGUE LABEL, and the size on display. Both are
 * saved by this ONE call. `styleCode` is one of:
 *   { code, source: "label" | "manual", labelPhoto? }     a read or typed code
 *                                                         (labelPhoto is the
 *                                                         prepareLabelPhoto
 *                                                         result; the enqueue
 *                                                         uploads .blob and
 *                                                         mints the URL itself)
 *   { aliasTokens: [...] }                                a label READING with
 *                                                         no printed article
 *                                                         number — filed as an
 *                                                         ALIAS in
 *                                                         /label_aliases,
 *                                                         NEVER written into
 *                                                         styleCodeNormalised
 *                                                         (aliases, not keys —
 *                                                         so a product that
 *                                                         already carries a
 *                                                         code just gains a
 *                                                         further alias, and
 *                                                         immutability can
 *                                                         never dead-end a
 *                                                         registration)
 *   { skipped: "label_unreadable" | "label_missing" | "no_code_exists" }
 *   null / undefined                                      product already has
 *                                                         a code on file
 * A NEW code (product has none on file, or a different one) is enqueued to
 * /style_code_captures — the same server-decided queue the style-code gate and
 * display checks use — so claiming, collision detection and pending-field
 * writes stay the server's job, exactly as everywhere else. The enqueue rides
 * the same save: a failure is reported as a warning, never a lost registration
 * (the stock unit is the fact that must not be dropped).
 */
export async function registerDisplayUnit({ hub, product, size, qty = 1, styleCode = null }) {
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

  // ── THE STYLE-NUMBER FACT — required before anything writes ────────────────
  // On file, captured, or deliberately skipped with a reason. Anything else
  // refuses the whole save: the two facts are one action, and a registration
  // without its style number is exactly the half-record this rework removes.
  const codeOnFile = product.styleCodeNormalised || null;
  const capturedNormalised = styleCode && typeof styleCode.code === "string" ? normaliseStyleCode(styleCode.code) : "";
  const aliasTokens = styleCode && Array.isArray(styleCode.aliasTokens) && styleCode.aliasTokens.length >= 2
    ? styleCode.aliasTokens : null;
  const skipReason = styleCode && STYLE_SKIP_REASONS.includes(styleCode.skipped) ? styleCode.skipped : null;
  if (!codeOnFile && !capturedNormalised && !aliasTokens && !skipReason) {
    return { ok: false, message: "Read the style number off the tongue label (or type it) before saving." };
  }

  const key = registerKey(product.id, sizeKey);
  const recPath = `${registerPath(hub)}/${key}`;

  const existing = await one(recPath);
  if (existing) {
    // The slot is already registered — but a freshly captured READING still
    // files as an alias. This IS the retry path for a filing that failed on
    // the first save: open the product, save again, the alias re-attempts.
    if (aliasTokens) {
      try {
        await addLabelAlias({ productId: product.id, tokens: aliasTokens });
      } catch (err) {
        return { ok: true, already: true, record: existing, warning: `Already registered, and the label reading STILL could not be filed (${String(err?.message || err)}) — save once more to retry.` };
      }
    }
    return { ok: true, already: true, record: existing };
  }

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
    // The style-number fact, alongside the size — both from the same save.
    styleCodeNormalised: codeOnFile || capturedNormalised || null,
    styleCode: codeOnFile
      ? (product.styleCode || formatStyleCodeForDisplay(codeOnFile))
      : (capturedNormalised ? formatStyleCodeForDisplay(capturedNormalised) : null),
    styleCodeFrom: codeOnFile ? "on_file"
      : capturedNormalised ? (styleCode?.source === "label" ? "label" : "manual")
      : aliasTokens ? "label_alias"
      : null,
    aliasTokenCount: aliasTokens ? aliasTokens.length : null,
    styleCodeSkipReason: skipReason,
  };

  // A code the product does not carry yet goes to /style_code_captures — the
  // same server-decided queue every other capture surface uses, so claiming,
  // collision handling and pending-field writes stay the server's job. Rides
  // the SAME save; a failure downgrades to a warning because the stock unit
  // must never be lost to a queue hiccup.
  let captureWarning = null;
  // A label READING becomes an alias — never a capture, never a claim on
  // styleCodeNormalised. If the product already carries a code (or gains one
  // later), the reading is simply a further way to find it: registration can
  // never fail on the immutability rule.
  if (aliasTokens) {
    try {
      const res = await addLabelAlias({ productId: product.id, tokens: aliasTokens });
      if (!res || (!res.ok && !res.deduped)) captureWarning = "Registered, but the label reading could not be filed — open this product and save again to retry.";
    } catch (err) {
      captureWarning = `Registered, but the label reading could not be filed (${String(err?.message || err)}) — open this product and save again to retry.`;
    }
  }
  if (capturedNormalised && capturedNormalised !== codeOnFile) {
    try {
      const q = await enqueueStyleCodeCapture({
        code: capturedNormalised,
        productId: product.id,
        uid: user ? user.uid : null,
        origin: "displayCheck",
        labelPhoto: styleCode?.labelPhoto || null,
        nowMs: serverNowMs(),
      });
      if (!q || !q.ok) captureWarning = `Registered, but the style number could not be queued (${q?.error || "write failed"}) — capture it again from the panel.`;
    } catch (err) {
      captureWarning = `Registered, but the style number could not be queued (${String(err?.message || err)}) — capture it again from the panel.`;
    }
  }

  // Create-once: if another device registered the same slot in the race window,
  // their record stands (the movement was shared anyway — one id, one unit).
  try {
    const txn = await runTransaction(ref(database, recPath), (cur) => (cur === null ? rec : undefined));
    const committed = txn && txn.committed;
    return { ok: true, record: committed ? rec : (txn.snapshot ? txn.snapshot.val() : rec), already: !committed, idempotent: !!res.idempotent, warning: captureWarning || undefined };
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
 * The ownership claim for a style number — /style_code_index is THE authority
 * on which product owns a code. Fail-soft: the node's live read rule is
 * console-managed and may not grant clients access, and a denied read must
 * degrade to the local catalogue match, never to a broken count. (If reads are
 * denied, the console rule to add is: /style_code_index `.read`:
 * `auth != null && auth.token.firebase.sign_in_provider !== 'anonymous'`.)
 */
export async function lookupStyleClaim(normalised) {
  const key = String(normalised ?? "").replace(/[.#$/\[\]\s]/g, "");
  if (!key) return null;
  try {
    return await one(`style_code_index/${key}`);
  } catch {
    return null;
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
