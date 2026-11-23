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
import { ref, update, get } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { notePendingUpdate } from "../../offline/pendingWrites";
import { isConcreteProduct, buildConcreteUpdate, CONCRETE_INDEX_PATH, CONCRETE_PUBLISH_PATH } from "../../utils/concreteListing";
import { restoreMarathonListing } from "../concrete/concreteStore";
import { assertSafeSegment } from "../../utils/sizeKey";

export const MARATHON_INDEX_PATH = "settings/marathonOnlyIndex";
export { CONCRETE_INDEX_PATH };

/**
 * The product as the lists should see it. Once the two index nodes have
 * answered (`settled`), THEY are the truth on every device — a mark or an
 * unmark made on another phone applies here at once, whatever the mirrored
 * product record still says. Every writer of either mark writes its index in
 * the same update (buildConcreteUpdate, buildMarathonUpdate; the 98 markings
 * from before the rebuild all have their index entry). Before they answer,
 * the record fields are used. Records whose answer is unchanged keep their
 * identity, and the same array comes back when nothing changes.
 */
export function withDivisionMarks(products, concreteIdx, marathonIdx, settled = true) {
  const list = Array.isArray(products) ? products : [];
  if (!settled) return list;
  const c = concreteIdx || {};
  const m = marathonIdx || {};
  let changed = false;
  const out = list.map((p) => {
    if (!p || !p.id) return p;
    const wantC = c[p.id] === true;
    const wantM = !wantC && m[p.id] === true;
    if (isConcreteProduct(p) === wantC && (p.marathonProduct === true) === wantM) return p;
    changed = true;
    return { ...p, concreteProduct: wantC, listOnConcrete: wantC, marathonProduct: wantM };
  });
  return changed ? out : list;
}

/** "concrete" | "marathon" | null — the division a product is marked for. */
export function divisionMarkOf(product) {
  if (isConcreteProduct(product)) return "concrete";   // (Concrete wins if a record ever carried both)
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

// ONE multi-path update carries both marks, so a failure leaves nothing
// half-done: Concrete through the old button's own builder (verify:true — the
// flip is the brand check, as before), Marathon through buildMarathonUpdate.
// Returning a product from Concrete also turns a live Concrete listing off
// (asked of its node, now) and puts back a Marathon listing the mark took
// off — exactly what markConcreteProduct(…, false) does.
async function applyMarks(pid, want, prior) {
  const uid = auth.currentUser?.uid;
  if (!uid) return { ok: false, message: "Not signed in — nothing was saved." };
  const nowMs = serverNowMs();
  let updates = {};
  const unConcrete = prior.concrete && !want.concrete;
  if (want.concrete !== prior.concrete) {
    let live = null;
    if (unConcrete) {
      try {
        const node = (await get(ref(database, `${CONCRETE_PUBLISH_PATH}/${pid}`))).val();
        if (node?.state === "live") live = [pid];
      } catch { /* the Concrete reconciler's unmarked-product backstop turns it off */ }
    }
    updates = { ...updates, ...buildConcreteUpdate({ productIds: [pid], on: want.concrete, uid, nowMs, verify: true, liveOnConcrete: live }) };
  }
  if (want.marathon !== prior.marathon) updates = { ...updates, ...buildMarathonUpdate({ pid, on: want.marathon, uid, nowMs }) };
  if (!Object.keys(updates).length) return { ok: true };
  try {
    await update(ref(database), updates);
  } catch (e) {
    return { ok: false, message: e?.message || "error" };
  }
  try { notePendingUpdate(updates); } catch { /* the echo is a courtesy */ }
  if (unConcrete) {
    const back = await restoreMarathonListing(pid);
    if (!back.ok) return { ok: true, warning: `its Marathon listing was not switched back on (${back.message}) — switch it on from the Marathon publishing tab.` };
  }
  return { ok: true };
}

/** What a product carries now, as markDivision / Undo need it. */
export const marksOf = (product) => ({ concrete: isConcreteProduct(product), marathon: !isConcreteProduct(product) && product?.marathonProduct === true });

/**
 * Mark `product` for `division` ("concrete" | "marathon"): that mark on, the
 * other off, in one write. Returns { ok, msg?, prior } — `prior` is what Undo
 * puts back.
 */
export async function markDivision(product, division) {
  const pid = product?.id;
  if (!pid) return { ok: false, msg: "No product — nothing changed." };
  if (division !== "concrete" && division !== "marathon") return { ok: false, msg: "Unknown division — nothing changed." };
  const prior = marksOf(product);
  const r = await applyMarks(pid, { concrete: division === "concrete", marathon: division === "marathon" }, prior);
  if (!r.ok) return { ok: false, msg: `Not marked ${division === "concrete" ? "Concrete" : "Marathon"} — ${r.message}` };
  return { ok: true, prior, ...(r.warning ? { msg: `${division === "concrete" ? "Concrete" : "Marathon"} only — but ${r.warning}` } : {}) };
}

/**
 * Take a product's division mark OFF (both marks false, one write) — the
 * "Not listed" sheet's Unmark (Junid, 23 Nov 2026). Returns { ok, msg?, prior }.
 */
export async function clearDivision(product) {
  const pid = product?.id;
  if (!pid) return { ok: false, msg: "No product — nothing changed." };
  const prior = marksOf(product);
  if (!prior.concrete && !prior.marathon) return { ok: true, prior };
  const r = await applyMarks(pid, { concrete: false, marathon: false }, prior);
  if (!r.ok) return { ok: false, msg: `Not unmarked — ${r.message}` };
  return { ok: true, prior, ...(r.warning ? { msg: `Unmarked — but ${r.warning}` } : {}) };
}

/** Undo markDivision: put back exactly the marks that were there before, in one write. */
export async function undoDivision(pid, division, prior) {
  if (!prior || (division !== "concrete" && division !== "marathon")) return { ok: false, msg: "Nothing to undo." };
  const now = { concrete: division === "concrete", marathon: division === "marathon" };
  const r = await applyMarks(pid, { concrete: !!prior.concrete, marathon: !!prior.marathon }, now);
  if (!r.ok) return { ok: false, msg: `Not undone — ${r.message}` };   // one write: nothing changed, so a retry is safe
  return { ok: true, ...(r.warning ? { msg: `Back on the list — but ${r.warning}` } : {}) };
}

/**
 * The marks as the SERVER holds them now — asked at Solve, so a mark made on
 * another device a moment ago is never sent into the other division.
 */
export async function liveMarksOf(pid) {
  const [c, m] = await Promise.all([get(ref(database, `${CONCRETE_INDEX_PATH}/${pid}`)), get(ref(database, `${MARATHON_INDEX_PATH}/${pid}`))]);
  const concrete = c.val() === true;
  return { concrete, marathon: !concrete && m.val() === true };
}
