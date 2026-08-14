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
//   state (awaiting|live|blocked), liveState (on|off, reconciler-confirmed),
//   desiredState (on|off, the page's INTENT — the ONLY publish-related field
//   this file writes; the browser never calls Shopify), blockedReason,
//   cleanName, cleanNameSource (lexicon|ai|manual), nameApprovedAt,
//   condition, updatedAt, updatedBy
import { ref, child, get, runTransaction, query, orderByChild, equalTo } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { CONDITIONS, checkCleanName, isOn, canGoLive, normalizedState, normalizedFields } from "./shopifyPublishCore";
import { MAX_PUBLISH_PHOTOS, normalizePhotoList } from "./publishShared";

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
//   1. loadPipelineNodes() — server-filtered queries on the published
//      `state` index (live/blocked, plus the legacy values until migration).
//      These sets stay small: they are the products actually on the shop.
//   2. loadPublishKeys()   — a REST ?shallow=true read: the KEY LIST only, no
//      bodies (~10 bytes per reviewed product). A node's existence means the
//      product has been seen; absence is what "awaiting review" means, so
//      this one cheap read prices the home badge and every section count.
//   3. loadNodesFor(pids)  — bodies for exactly the pids a category section
//      is about to display, fetched when that section expands.

export async function loadPipelineNodes() {
  // The four legacy states ride along until every node is migrated — an
  // unmigrated draft/nominated node must not vanish from the page. Each is
  // one cheap indexed query returning at most a handful of rows.
  const states = ["live", "blocked", "nominated", "draft"];
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
 * `nameApprovedAt` (state stays "awaiting"; "approved" is a review marker,
 * not a stored state). The same trigger check that runs live on the input
 * runs again here. Refused for a product that is ON the storefront — a
 * rename there would silently diverge from what customers see; an OFF
 * product stays editable, the reconciler re-syncs its fields at turn-on.
 */
export async function approveName(productId, node, name, source = "manual") {
  const verdict = checkCleanName(name);
  if (!verdict.ok) return { ok: false, message: verdict.problems.join("; ") };
  const cleanName = String(name).trim();
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || node || {};
    if (isOn(base)) {
      refusal = "Listing is ON the storefront — switch it off before renaming.";
      return undefined;
    }
    return { ...base, ...normalizedFields(base), cleanName, cleanNameSource: source,
             nameApprovedAt: serverNowMs(), ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res;
}

/**
 * THE publish action — the single step that used to be Approve → Nominate →
 * Live. Records the reviewed name and the INTENT to go on the storefront
 * (desiredState "on"); the owner-run reconciler creates/validates/publishes
 * and confirms. The row shows pending until it does. Two refusals, both
 * checked against the SERVER's node: already on, and the unbreakable
 * condition gate (a product cannot reach live with condition unset).
 */
export async function publishProduct(productId, node, name, source = "manual") {
  const verdict = checkCleanName(name);
  if (!verdict.ok) return { ok: false, message: verdict.problems.join("; ") };
  const cleanName = String(name).trim();
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || node || {};
    if (isOn(base)) {
      refusal = "Already ON the storefront — refresh the page to see its current state.";
      return undefined;
    }
    if (!canGoLive(base)) {
      refusal = "Condition not set — a product cannot go live without one of the three grades.";
      return undefined;
    }
    // A blocked product re-publishing clears its recorded refusal — the
    // reconciler re-validates everything at apply time anyway.
    return { ...base, ...normalizedFields(base),
             cleanName, cleanNameSource: source, nameApprovedAt: serverNowMs(),
             desiredState: "on", blockedReason: null, ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res;
}

/**
 * The on/off switch (and the pending-publish cancel): write the INTENT only.
 * "on" re-checks the condition gate; "off" is always allowed — it only
 * reduces exposure. State stays whatever the reconciler last confirmed.
 */
export async function setDesiredState(productId, node, want) {
  if (want !== "on" && want !== "off") return { ok: false, message: "Switch must be on or off." };
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || node || {};
    if (want === "on" && !canGoLive(base)) {
      refusal = "Condition not set — a product cannot go live without one of the three grades.";
      return undefined;
    }
    return { ...base, ...normalizedFields(base), desiredState: want,
             ...(want === "on" ? { blockedReason: null } : {}), ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res;
}

// What a publishing photo list may contain — the client-side mirror of the
// media.mjs guards: a URL the page accepts here but the reconciler would
// refuse at push time would be a delayed, confusing failure. Pinned to THIS
// app's bucket, not just the Firebase Storage host — any-bucket acceptance
// would let a pasted URL from a stranger's project ride the push. Exported
// for tests.
export const APP_STORAGE_PREFIX = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";
export function publishPhotoListProblem(photos) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return "The photo set can't be empty — a product never ships imageless.";
  }
  if (photos.length > MAX_PUBLISH_PHOTOS) {
    return `At most ${MAX_PUBLISH_PHOTOS} photos per product.`;
  }
  const trimmed = photos.map((u) => (typeof u === "string" ? u.trim() : u));
  if (new Set(trimmed).size !== trimmed.length) return "The photo set has a duplicate.";
  for (const u of trimmed) {
    if (typeof u !== "string" || u === "") return "The photo set has an empty entry.";
    try { new URL(u); } catch { return "The photo set has an invalid URL."; }
    if (!u.startsWith(APP_STORAGE_PREFIX)) {
      return "Photos must be this app's own Firebase Storage URLs.";
    }
  }
  return null;
}

/**
 * Set the PUBLISHING photo list — ordered, first = primary, stored at
 * /shopify_publish/{pid}/photos and NOWHERE else (/products and Storage are
 * never touched; removing a photo here only removes it from what a publish
 * would ship). `photos === null` clears the custom set back to the record's
 * own photoUrl + gallery. Refused while the listing is ON — customers are
 * looking at the current set; the reconciler re-syncs media at turn-on.
 *
 * The list write is OPTIMISTICALLY CONCURRENT, not last-write-wins: `node` is
 * the snapshot this edit was computed FROM, and the mutator refuses when the
 * server's current photos differ from that basis — two sessions editing the
 * same strip must not silently drop each other's changes (a reorder computed
 * over a stale 2-item list would otherwise erase a 3rd photo the other
 * session just added).
 */
export async function setPublishPhotos(productId, node, photos) {
  if (photos !== null) {
    const problem = publishPhotoListProblem(photos);
    if (problem) return { ok: false, message: problem };
  }
  const basis = JSON.stringify(normalizePhotoList(node?.photos));
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || node || {};
    if (isOn(base)) {
      refusal = "Listing is ON the storefront — switch it off before changing its photos.";
      return undefined;
    }
    if (JSON.stringify(normalizePhotoList(base.photos)) !== basis) {
      refusal = "The photo set changed in another session — reopen the strip and redo the edit.";
      return undefined;
    }
    return { ...base, ...normalizedFields(base), photos: photos === null ? null : [...photos], ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res;
}

/** Set the condition grade. Unblocks a blocked product (blocked → awaiting). */
export async function setCondition(productId, node, condition) {
  if (!CONDITIONS.includes(condition)) return { ok: false, message: "Not one of the three condition grades." };
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const base = cur || node || {};
    if (isOn(base)) {
      // The ON listing's description carries the old grade — changing it here
      // would make the page lie about what customers see. Switch it off
      // first; the reconciler re-syncs the description at the next turn-on.
      refusal = "Listing is ON the storefront — switch it off before changing the condition.";
      return undefined;
    }
    // blocked → awaiting (unblocks, refusal reason cleared); live-off and
    // awaiting keep their state. Every write carries `state` — the $pid
    // .validate requires hasChildren(['state']), so a grade-first write on an
    // unreviewed product must still include one.
    const unblocking = normalizedState(base) === "blocked";
    return { ...base, ...normalizedFields(base), condition,
             ...(unblocking ? { state: "awaiting", blockedReason: null } : {}), ...stamp() };
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res;
}

