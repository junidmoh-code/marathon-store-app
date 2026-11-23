// ─── MISSING PRODUCTS — WHICH DIVISION A PRODUCT BELONGS TO (Junid, 23 Nov 2026)
// The small button on a Missing Products card, where "Hide" used to be:
//   on a Marathon card  "Concrete"  — this product belongs to Concrete only
//   on a Concrete card  "Marathon"  — this product belongs to Marathon only
//
// CONCRETE reuses the pre-rebuild button's mechanism and data exactly
// (markConcreteProduct → /products/{pid}.concreteProduct +
// /settings/concreteOnlyIndex/{pid}, src/utils/concreteListing.js), so every
// product marked before the rebuild is still Concrete-only.
//
// MARATHON is the mirror image, stored the same way:
//   /products/{pid}.marathonProduct (+SetBy / SetAt)   true = Marathon-only
//   /settings/marathonOnlyIndex/{pid}                  true while Marathon-only
// The two marks exclude each other: setting one clears the other in the same
// tap, and Undo puts back exactly what was there.
//
// A MARK DECIDES ONE THING: which division's Missing Products list may show
// the product. It never seats anything, moves stock, or raises a request —
// these functions write only the paths above (and markConcreteProduct's own
// Shopify listing intent, unchanged from the old button). Whether a product
// shows on its division's list is still the normal missing rule.
import { ref, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { notePendingUpdate } from "../../offline/pendingWrites";
import { isConcreteProduct, CONCRETE_INDEX_PATH } from "../../utils/concreteListing";
import { markConcreteProduct } from "../concrete/concreteStore";
import { assertSafeSegment } from "../../utils/sizeKey";

export const MARATHON_INDEX_PATH = "settings/marathonOnlyIndex";
export { CONCRETE_INDEX_PATH };

/** Is this product marked Marathon-only (record field or the live index)? */
export function isMarathonProduct(product, marathonIdx) {
  if (product && marathonIdx && marathonIdx[product.id] === true) return true;
  return !!product && product.marathonProduct === true;
}

/**
 * The product as the lists should see it: the live indexes (one listener each,
 * on every device) win over a product record the mirror has not refreshed yet,
 * so a mark made on another device applies at once. Only records whose answer
 * changes are copied; the rest keep their identity.
 *   concreteIdx / marathonIdx   /settings/{concrete,marathon}OnlyIndex values
 */
export function withDivisionMarks(products, concreteIdx, marathonIdx) {
  const list = Array.isArray(products) ? products : [];
  const c = concreteIdx || {};
  const m = marathonIdx || {};
  if (!Object.keys(c).length && !Object.keys(m).length) return list;
  return list.map((p) => {
    if (!p || !p.id) return p;
    const needC = c[p.id] === true && !isConcreteProduct(p);
    const needM = m[p.id] === true && p.marathonProduct !== true;
    if (!needC && !needM) return p;
    return { ...p, ...(needC ? { concreteProduct: true } : {}), ...(needM ? { marathonProduct: true } : {}) };
  });
}

/** "concrete" | "marathon" | null — the division a product is marked for. */
export function divisionMarkOf(product) {
  if (isConcreteProduct(product)) return "concrete";
  if (product && product.marathonProduct === true) return "marathon";
  return null;
}

/**
 * May this product be listed (and solved) on the list of a division whose
 * kind is `listKind` ("marathon" | "concrete")? A product marked for the other
 * division never is.
 */
export function listedForDivision(product, listKind) {
  const mark = divisionMarkOf(product);
  return !mark || mark === listKind;
}

/** The multi-path update that sets / clears the Marathon mark. PURE. */
export function buildMarathonUpdate({ pid, on, uid, nowMs }) {
  assertSafeSegment(pid, "productId");
  if (typeof on !== "boolean") throw new Error("buildMarathonUpdate: `on` must be a boolean");
  if (typeof uid !== "string" || !uid) throw new Error("buildMarathonUpdate: `uid` is required");
  if (!(Number.isFinite(nowMs) && nowMs > 0)) throw new Error("buildMarathonUpdate: `nowMs` must be server epoch ms");
  return {
    [`products/${pid}/marathonProduct`]: on,
    [`products/${pid}/marathonProductSetBy`]: uid,
    [`products/${pid}/marathonProductSetAt`]: nowMs,
    [`${MARATHON_INDEX_PATH}/${pid}`]: on ? true : null,
  };
}

async function setMarathon(pid, on) {
  const uid = auth.currentUser?.uid;
  if (!uid) return { ok: false, message: "Not signed in — nothing was saved." };
  try {
    const updates = buildMarathonUpdate({ pid, on, uid, nowMs: serverNowMs() });
    await update(ref(database), updates);
    try { notePendingUpdate(updates); } catch { /* the echo is a courtesy */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e?.message || "error" };
  }
}

/**
 * Mark `product` for `division` ("concrete" | "marathon"). Returns
 * { ok, msg?, prior } — `prior` is what Undo needs to put back.
 */
export async function markDivision(product, division) {
  const pid = product?.id;
  if (!pid) return { ok: false, msg: "No product — nothing changed." };
  const prior = { concrete: isConcreteProduct(product), marathon: product.marathonProduct === true };
  if (division === "concrete") {
    const r = await markConcreteProduct(pid, true);
    if (!r.ok) return { ok: false, msg: `Not marked Concrete — ${r.message || "nothing changed."}` };
    if (prior.marathon) {
      const m = await setMarathon(pid, false);
      if (!m.ok) return { ok: true, prior, msg: `Marked Concrete, but its Marathon mark stayed (${m.message}).` };
    }
    return { ok: true, prior };
  }
  if (division === "marathon") {
    const m = await setMarathon(pid, true);
    if (!m.ok) return { ok: false, msg: `Not marked Marathon — ${m.message}` };
    if (prior.concrete) {
      const r = await markConcreteProduct(pid, false);
      if (!r.ok) {
        await setMarathon(pid, false);
        return { ok: false, msg: `Not marked Marathon — ${r.message || "its Concrete mark could not be cleared."}` };
      }
    }
    return { ok: true, prior };
  }
  return { ok: false, msg: "Unknown division — nothing changed." };
}

/** Undo markDivision: put back exactly the marks that were there before. */
export async function undoDivision(pid, division, prior) {
  if (division === "concrete") {
    if (!prior?.concrete) {
      const r = await markConcreteProduct(pid, false);
      if (!r.ok) return { ok: false, msg: `Not undone — ${r.message || "error"}` };
    }
    if (prior?.marathon) {
      const m = await setMarathon(pid, true);
      if (!m.ok) return { ok: false, msg: `Not undone — ${m.message}` };
    }
    return { ok: true };
  }
  if (division === "marathon") {
    if (!prior?.marathon) {
      const m = await setMarathon(pid, false);
      if (!m.ok) return { ok: false, msg: `Not undone — ${m.message}` };
    }
    if (prior?.concrete) {
      const r = await markConcreteProduct(pid, true);
      if (!r.ok) return { ok: false, msg: `Not undone — ${r.message || "error"}` };
    }
    return { ok: true };
  }
  return { ok: false, msg: "Nothing to undo." };
}
