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
import { ref, child, get, runTransaction, query, orderByChild, equalTo } from "firebase/database";
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

// A refused write must read as a plain sentence, not a stack trace. RTDB
// reports BOTH the identity gate and a .validate rejection as
// PERMISSION_DENIED, so the copy covers both without claiming which —
// blaming permissions alone would mislead the very admin the rule allows.
// Everything else keeps its raw message.
function writeError(err) {
  const msg = String(err?.message || err);
  if (/permission[_ ]denied/i.test(msg)) {
    return { ok: false, message: "Not saved — the database refused this write. Shopify publishing changes are limited to Junid or a stock admin; if that's you, check you're still signed in and try again." };
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
  // The ID token rides the documented `auth` query parameter — the RTDB REST
  // API accepts Firebase ID tokens ONLY there (Authorization: Bearer is for
  // OAuth2 access tokens). HTTPS covers it in transit and the URL is never
  // logged here. Timeout so a stalled read fails visibly instead of hanging.
  const res = await fetch(`${base}/shopify_publish.json?shallow=true&auth=${encodeURIComponent(token)}`,
    typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(15000) } : {});
  if (!res.ok) throw new Error(`shallow key read failed: HTTP ${res.status}`);
  const val = await res.json();
  const keys = new Set(val && typeof val === "object" ? Object.keys(val) : []);
  keysCache = { keys, at: Date.now() };
  return keys;
}

// Bounded fan-out: a large category would otherwise fire hundreds of
// concurrent get()s in one pass, and one rejection would sink them all.
// A small worker pool keeps the pipe civil, and failures are returned per
// pid so the caller keeps every body that DID load.
export async function loadNodesFor(pids) {
  const list = [...(pids || [])];
  const out = {};
  const failed = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const pid = list[i++];
      try {
        const snap = await get(child(ref(database), `shopify_publish/${safeSeg(pid)}`));
        out[pid] = snap.val();
      } catch {
        failed.push(pid);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  return { nodes: out, failed };
}

// ─── WRITES — ALWAYS TRANSACTIONS ────────────────────────────────────────────
// Every write runs as a transaction that rebuilds the node from the CURRENT
// server value: the owner-run publish script moves products to draft/live
// while Junid reviews, and a plain update() computed from the row's snapshot
// could stamp that stale state straight back over the script's. The mutator
// receives the server value; on the first (cold-cache) attempt that value is
// null even when the node exists, so mutators fall back to the row's snapshot
// and let the server's compare-and-retry supply the real one — never abort on
// a null `cur` (the classic RTDB transaction trap).
async function writeNode(productId, mutate) {
  try {
    const result = await runTransaction(ref(database, `shopify_publish/${safeSeg(productId)}`), mutate);
    if (!result.committed) return { ok: false, aborted: true };
    markSeen(productId);
    return { ok: true, node: result.snapshot.val() };
  } catch (err) {
    return writeError(err);
  }
}

/**
 * Approve a product's cleaned name — the review flow's core write. Stamps
 * `nameApprovedAt` (state stays whatever it CURRENTLY is on the server,
 * "none" for a first-touch node: the live rules' state enum has no
 * "approved" value). The same trigger check that runs live on the input
 * runs again here.
 */
export async function approveName(productId, node, name, source = "manual") {
  const verdict = checkCleanName(name);
  if (!verdict.ok) return { ok: false, message: verdict.problems.join("; ") };
  const cleanName = String(name).trim();
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || node || {};
    if (base.state === "live") {
      // A LIVE listing shows its name to customers — a rename here would
      // silently diverge from the storefront. Live edits are the update
      // slice's job, same rule as setCondition. Draft stays editable: the
      // next publish run reconciles it.
      refusal = "Listing is LIVE — name changes for live products aren't wired yet.";
      return undefined;
    }
    return { ...base, state: base.state || "none", cleanName, cleanNameSource: source,
             nameApprovedAt: serverNowMs(), ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res;
}

/**
 * Nominate a product for the Shopify push. Lands in state "nominated" when a
 * condition is already set (or given), "blocked" otherwise — condition has NO
 * default and a blocked product cannot be pushed.
 */
export async function nominateProduct(productId, existingNode, condition = undefined) {
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || existingNode || {};
    if (base.state === "draft" || base.state === "live") {
      // The publish script took this product while the row sat stale —
      // nominating now would overwrite the script's state. Checked against
      // the SERVER's value; re-queuing a draft is setCondition's job.
      refusal = "Already with the publish script — refresh the page to see its current state.";
      return undefined;
    }
    const cond = condition !== undefined ? condition : base.condition;
    return { ...base, ...(condition !== undefined ? { condition } : {}),
             state: nominationState(cond), ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res.ok ? { ok: true, state: res.node?.state, node: res.node } : res;
}

/** Withdraw a nomination (draft/live products keep their state — Shopify already has them). */
export async function withdrawNomination(productId, node) {
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || node || {};
    if (base.state === "draft" || base.state === "live") {
      refusal = "Already pushed to Shopify — withdrawing here would lie about that.";
      return undefined; // abort — checked against the SERVER's state, not the row's
    }
    return { ...base, state: "none", ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Nothing to withdraw." };
  return res;
}

/** Set the condition grade. Unblocks a blocked nomination (blocked → nominated). */
export async function setCondition(productId, node, condition) {
  if (!CONDITIONS.includes(condition)) return { ok: false, message: "Not one of the three condition grades." };
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || node || {};
    if (base.state === "live") {
      // A LIVE listing's description carries the old grade — changing it here
      // would make the page lie about what customers see. Live edits are the
      // update slice's job. Checked against the SERVER's state.
      refusal = "Listing is LIVE — condition changes for live products aren't wired yet.";
      return undefined;
    }
    // blocked/nominated → nominated (unblocks); draft → nominated too, which
    // RE-QUEUES the product so the next publish run reconciles the new grade
    // onto the Shopify draft and returns it to state draft. Anything else
    // keeps its state ("none" for a first-touch node — the $pid .validate
    // requires hasChildren(['state']), so a grade-first write on an
    // unreviewed product must still carry one).
    const st = (base.state === "blocked" || base.state === "nominated" || base.state === "draft")
      ? "nominated" : (base.state || "none");
    return { ...base, condition, state: st, ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res;
}

