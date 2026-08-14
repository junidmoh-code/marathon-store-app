// ─── SHOPIFY PUBLISHING — CLIENT DATA LAYER ──────────────────────────────────
// Every client read and write of /shopify_publish, in one file: partial
// on-demand reads for the full-page review tab (see PAGE-SCALE PARTIAL READS
// below) and merge-only update()s for writes. The page writes ONLY
// /shopify_publish — never /products, /stock or /shopify_sync (those belong
// to the Admin-SDK push scripts).
//
// Console rules (pasted by the owner, not in database.rules.json): read = any
// non-anonymous user; write = Junid or stockRole admin. A denied write is
// returned as { ok:false, message } and shown — never swallowed.
//
// Node shape (scripts/shopify/publishNode.mjs is the Admin-SDK twin):
//   state (none|nominated|draft|live|blocked), cleanName,
//   cleanNameSource (lexicon|ai|manual), condition, updatedAt, updatedBy
import { ref, child, get, update, query, orderByChild, equalTo } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { CONDITIONS, nominationState, checkCleanName } from "./shopifyPublishCore";

// REJECT, never repair: silently rewriting an illegal key could make the card
// and the Admin-SDK scripts (which use assertSafeSegment) address DIFFERENT
// /shopify_publish nodes for the same product. Product ids are "p<digits>",
// so this never fires in practice — it exists to fail loudly if that changes.
const safeSeg = (s) => {
  const seg = String(s ?? "");
  if (seg === "" || /[.#$/\[\]\s]/.test(seg)) {
    throw new Error(`illegal /shopify_publish key: "${seg}"`);
  }
  return seg;
};
const stamp = () => ({ updatedAt: serverNowMs(), updatedBy: auth.currentUser ? auth.currentUser.uid : null });

// A denied write must read as a permission problem, not a stack trace. The
// live rule limits /shopify_publish writes to Junid or a stockRole admin —
// say exactly that. Everything else keeps its raw message.
function writeError(err) {
  const msg = String(err?.message || err);
  if (/permission[_ ]denied/i.test(msg)) {
    return { ok: false, message: "Not saved — Shopify publishing changes are limited to Junid or a stock admin." };
  }
  return { ok: false, message: msg };
}

// ─── PAGE-SCALE PARTIAL READS ────────────────────────────────────────────────
// The full-page tab must NEVER pull the whole /shopify_publish node (or the
// catalogue) in one read — the review record grows toward one node per product,
// and eager loads here are the class of read that spiked the Firebase
// bandwidth bill. Three complementary partial reads cover every screen state:
//   1. loadPipelineNodes() — four server-filtered queries on the published
//      `state` index (nominated/draft/live/blocked). These sets stay small:
//      they are the products actually headed to (or on) the shop.
//   2. loadPublishKeys()   — a REST ?shallow=true read: the KEY LIST only, no
//      bodies (~10 bytes per reviewed product). A node's existence means the
//      product has been seen; absence is what "awaiting review" means, so
//      this one cheap read prices the home badge and every section count.
//   3. loadNodesFor(pids)  — bodies for exactly the pids a category section
//      is about to display, fetched when that section expands.

export async function loadPipelineNodes() {
  const states = ["nominated", "draft", "live", "blocked"];
  const snaps = await Promise.all(states.map((s) =>
    get(query(ref(database, "shopify_publish"), orderByChild("state"), equalTo(s)))));
  const merged = {};
  for (const snap of snaps) Object.assign(merged, snap.val() || {});
  return merged;
}

// Session cache for the shallow key set — the home badge asks on every visit
// to the home screen and must not re-fetch each time. Writes below add the
// pid locally so counts stay honest between refreshes.
let keysCache = null; // { keys: Set<pid>, at: epoch-ms }
const KEYS_TTL_MS = 60_000;
const markSeen = (pid) => { if (keysCache) keysCache.keys.add(pid); };

export async function loadPublishKeys({ fresh = false } = {}) {
  if (!fresh && keysCache && Date.now() - keysCache.at < KEYS_TTL_MS) return keysCache.keys;
  const user = auth.currentUser;
  if (!user) throw new Error("not signed in");
  // The SDK has no shallow read — this is the documented RTDB REST parameter,
  // authenticated with the CURRENT user's ID token (same identity, same rules).
  const token = await user.getIdToken();
  const base = database.app?.options?.databaseURL;
  if (!base) throw new Error("no databaseURL configured");
  const res = await fetch(`${base}/shopify_publish.json?shallow=true&auth=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`shallow key read failed: HTTP ${res.status}`);
  const val = await res.json();
  const keys = new Set(val && typeof val === "object" ? Object.keys(val) : []);
  keysCache = { keys, at: Date.now() };
  return keys;
}

export async function loadNodesFor(pids) {
  const entries = await Promise.all((pids || []).map(async (pid) => {
    const snap = await get(child(ref(database), `shopify_publish/${safeSeg(pid)}`));
    return [pid, snap.val()];
  }));
  const out = {};
  for (const [pid, node] of entries) if (node) out[pid] = node;
  return out;
}

/**
 * Approve a product's cleaned name — the review flow's core write. Stamps
 * `nameApprovedAt` (state stays whatever it was, "none" for a first-touch
 * node: the live rules' state enum has no "approved" value). The same trigger
 * check that runs live on the input runs again here.
 */
export async function approveName(productId, node, name, source = "manual") {
  const verdict = checkCleanName(name);
  if (!verdict.ok) return { ok: false, message: verdict.problems.join("; ") };
  try {
    await update(ref(database, `shopify_publish/${safeSeg(productId)}`), {
      state: node?.state || "none",
      cleanName: String(name).trim(),
      cleanNameSource: source,
      nameApprovedAt: serverNowMs(),
      ...stamp(),
    });
    markSeen(productId);
    return { ok: true };
  } catch (err) {
    return writeError(err);
  }
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
    markSeen(productId);
    return { ok: true, state: patch.state };
  } catch (err) {
    return writeError(err);
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
    return writeError(err);
  }
}

/** Set the condition grade. Unblocks a blocked nomination (blocked → nominated). */
export async function setCondition(productId, node, condition) {
  if (!CONDITIONS.includes(condition)) return { ok: false, message: "Not one of the three condition grades." };
  if (node?.state === "live") {
    // A LIVE listing's description carries the old grade — changing it here
    // would make the card lie about what customers see. Live edits are the
    // update slice's job.
    return { ok: false, message: "Listing is LIVE — condition changes for live products aren't wired yet." };
  }
  const patch = { condition, ...stamp() };
  // blocked/nominated → nominated (unblocks); draft → nominated too, which
  // RE-QUEUES the product so the next publish run reconciles the new grade
  // onto the Shopify draft and returns it to state draft.
  if (node?.state === "blocked" || node?.state === "nominated" || node?.state === "draft") {
    patch.state = "nominated";
  }
  try {
    await update(ref(database, `shopify_publish/${safeSeg(productId)}`), patch);
    markSeen(productId);
    return { ok: true };
  } catch (err) {
    return writeError(err);
  }
}

