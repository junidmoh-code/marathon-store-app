// ─── SHOPIFY PUBLISHING — CLIENT DATA LAYER ──────────────────────────────────
// Every client read and write of /shopify_publish, in one file, same
// discipline as the other home-card stores (hubCountStore, stockHoldStore):
// one-shot get()s for the card, merge-only update()s for writes. The card
// writes ONLY /shopify_publish — never /products, /stock or /shopify_sync
// (those belong to the Admin-SDK push scripts).
//
// Console rules (pasted by the owner, not in database.rules.json): read = any
// non-anonymous user; write = Junid or stockRole admin. A denied write is
// returned as { ok:false, message } and shown — never swallowed.
//
// Node shape (scripts/shopify/publishNode.mjs is the Admin-SDK twin):
//   state (none|nominated|draft|live|blocked), cleanName,
//   cleanNameSource (lexicon|ai|manual), condition, updatedAt, updatedBy
import { ref, child, get, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { CONDITIONS, nominationState, checkCleanName } from "./shopifyPublishCore";

const safeSeg = (s) => String(s ?? "").replace(/[.#$/\[\]\s]/g, "_");
const stamp = () => ({ updatedAt: serverNowMs(), updatedBy: auth.currentUser ? auth.currentUser.uid : null });

export async function loadPublishNodes() {
  return (await get(child(ref(database), "shopify_publish"))).val() || {};
}

/**
 * Nominate a product for the Shopify push. Lands in state "nominated" when a
 * condition is already set (or given), "blocked" otherwise — condition has NO
 * default and a blocked product cannot be pushed.
 */
export async function nominateProduct(productId, existingNode, condition = undefined) {
  const cond = condition !== undefined ? condition : existingNode?.condition;
  const patch = {
    state: nominationState(cond),
    ...(condition !== undefined ? { condition } : {}),
    ...stamp(),
  };
  try {
    await update(ref(database, `shopify_publish/${safeSeg(productId)}`), patch);
    return { ok: true, state: patch.state };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/** Withdraw a nomination (draft/live products keep their state — Shopify already has them). */
export async function withdrawNomination(productId, node) {
  if (node?.state === "draft" || node?.state === "live") {
    return { ok: false, message: "Already pushed to Shopify — withdrawing here would lie about that." };
  }
  try {
    await update(ref(database, `shopify_publish/${safeSeg(productId)}`), { state: "none", ...stamp() });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/** Set the condition grade. Unblocks a blocked nomination (blocked → nominated). */
export async function setCondition(productId, node, condition) {
  if (!CONDITIONS.includes(condition)) return { ok: false, message: "Not one of the three condition grades." };
  const patch = { condition, ...stamp() };
  if (node?.state === "blocked" || node?.state === "nominated") patch.state = "nominated";
  try {
    await update(ref(database, `shopify_publish/${safeSeg(productId)}`), patch);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * Save an inline-edited clean name. The SAME trigger check that runs live on
 * the input runs again here — a non-compliant name is never written, even if
 * the UI somehow let it through.
 */
export async function setCleanName(productId, cleanName) {
  const verdict = checkCleanName(cleanName);
  if (!verdict.ok) return { ok: false, message: verdict.problems.join("; ") };
  try {
    await update(ref(database, `shopify_publish/${safeSeg(productId)}`), {
      cleanName: String(cleanName).trim(),
      cleanNameSource: "manual",
      ...stamp(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}
