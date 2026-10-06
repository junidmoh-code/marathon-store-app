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
import { ref, child, get, runTransaction, query, orderByChild, equalTo, startAt, endAt, limitToFirst } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { OFFERED_CONDITIONS } from "./shopifyPublishCore";
import { APP_STORAGE_PREFIX, publishPhotoListProblem, precheck, approveNameMutator, applyProposalMutator,
         dismissProposalMutator, publishMutator, desiredStateMutator, photosMutator, conditionMutator,
         mediaMutator, appendMediaMutator } from "./publishMutators";
import { storedMediaKey } from "./publishShared";

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
  //
  // "awaiting" is deliberately NOT here. It was, and it was wrong: once the
  // runner and the backfill stamp state:"awaiting" on every proposal-carrying
  // node, that query returns ~1,400 bodies today and grows toward one per
  // catalogue product — so every open of this page would pull the whole node
  // through the index. That passes the letter of the read rule and breaks the
  // thing the rule protects (reviewer finding). The proposed-names lane loads
  // its own page of awaiting nodes, on demand and bounded — see
  // loadProposalPage below.
  const states = ["live", "blocked", "nominated", "draft"];
  const snaps = await Promise.all(states.map((s) =>
    get(query(ref(database, "shopify_publish"), orderByChild("state"), equalTo(s)))));
  const merged = {};
  for (const snap of snaps) Object.assign(merged, snap.val() || {});
  return merged;
}

// ─── THE PROPOSED-NAMES LANE'S OWN READ ──────────────────────────────────────
// Bounded and lazy, and both words are load-bearing.
//
// LAZY: nothing here runs until Junid actually selects the lane. The page's
// other filters are answered by loadPipelineNodes (live + blocked — the
// products actually on the shop, a small set) and by the shallow key list.
// Awaiting nodes are neither small nor needed until someone is reviewing
// names, so they are not fetched until then.
//
// BOUNDED: `limitToFirst` on an INDEXED query is applied by the server, so a
// page costs one page, not the whole node. The index exists (.indexOn
// ["state"]) — this is the one query shape that can be bounded without a new
// rule. Ordering inside `state == "awaiting"` is by key, which for
// "p<epoch-ms>" ids is oldest product first; the lane re-sorts what it holds
// by when the proposal was made.
//
// ORDERING NOTE: inside an equal set RTDB orders by KEY, lexicographically.
// Product ids are "p" + epoch-ms, which is a fixed 13-digit decimal today, so
// lexicographic and chronological order coincide — and will until the year
// 2286 adds a digit. The lane does not depend on the order being chronological
// (it re-sorts what it holds by proposedAt); it depends only on the order being
// STABLE between pages, which key order is regardless of digit width.
//
// PAGING IS startAt(value, key) + endAt(value). NOT equalTo with a key, and
// the difference is the whole correctness of the lane.
//
// `equalTo(v, k)` looks like a cursor and is not one: the SDK expands it to
// startAt(v, k) + endAt(v, k), which pins BOTH ends to the same key — a range
// of exactly one record. Paging with it returned page 1, then a page holding
// only the cursor, then reported the end. Measured against the live node:
// 300 of 1,375 rows walked, and the lane would have told Junid there were no
// more names while a thousand waited.
//
// `startAt(v, key) + endAt(v)` is the real cursor: from this key to the END of
// the equal set. startAt is INCLUSIVE, so a continued page asks for one extra
// record and drops the overlap — the same treatment scripts/lib/rtdbPaged.mjs
// gives its cursor, for the same reason.
//
// Verified against the live database, not a fake: 5 pages, 1,375 of 1,375
// rows, zero duplicates, zero missing.
export const PROPOSAL_PAGE_SIZE = 300;

export async function loadProposalPage({ after = null, pageSize = PROPOSAL_PAGE_SIZE } = {}) {
  const want = after ? pageSize + 1 : pageSize; // +1 covers the inclusive overlap
  const snap = await get(query(
    ref(database, "shopify_publish"),
    orderByChild("state"),
    ...(after ? [startAt("awaiting", after)] : [startAt("awaiting")]),
    endAt("awaiting"),
    limitToFirst(want),
  ));
  const nodes = {};
  let lastKey = null;
  let seen = 0;
  snap.forEach((child) => {
    seen += 1;
    lastKey = child.key;
    if (child.key === after) return; // the overlap record, already delivered
    nodes[child.key] = child.val();
  });
  // `done` is judged on RECORDS RETURNED, not on the new ones kept: a final
  // page holding only the overlap is still the end, and counting the kept
  // records would read a full page of duplicates as "more to come".
  //
  // A DONE PAGE RETURNS NO CURSOR. Returning the last key on a finished walk
  // is a footgun rather than a fact: a caller that loops on "there is a
  // lastKey" instead of on "not done" would re-request the same single-record
  // page for ever. Today's caller checks `done`, so this is prevention, not a
  // fix (reviewer finding).
  //
  // AND `done` MEANS "nothing further in THIS pass", not "nothing left". The
  // cursor only moves forward through keys, and a product's key is its
  // CREATION time — so a product the naming runner stamps `awaiting` while a
  // reviewer is paging can land BEHIND the cursor and go unseen until the next
  // walk. That is why the lane offers to look again rather than declaring the
  // queue permanently empty.
  const finished = seen < want;
  return { nodes, lastKey: finished ? null : lastKey, done: finished };
}

// Session cache for the shallow key set — the home badge asks on every visit
// to the home screen and must not re-fetch each time. Writes below add the
// pid locally so counts stay honest between refreshes.
let keysCache = null; // { keys: Set<pid>, at: epoch-ms }
const KEYS_TTL_MS = 60_000;
const markSeen = (pid) => { if (keysCache) keysCache.keys.add(pid); };

export async function loadPublishKeys({ fresh = false } = {}) {
  if (!fresh && keysCache && Date.now() - keysCache.at < KEYS_TTL_MS) return keysCache.keys;
  const keys = await shallowKeys("shopify_publish");
  keysCache = { keys, at: Date.now() };
  return keys;
}

/**
 * The key list of one node, via the RTDB REST `?shallow=true` read — keys
 * only, no bodies, authenticated as the signed-in user. Rejects on failure.
 */
async function shallowKeys(path) {
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
  const res = await fetch(`${base}/${path}.json?shallow=true&auth=${encodeURIComponent(token)}`,
    typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(15000) } : {});
  if (!res.ok) throw new Error(`shallow key read failed: HTTP ${res.status}`);
  const val = await res.json();
  return new Set(val && typeof val === "object" ? Object.keys(val) : []);
}

// ─── HIDDEN FROM REVIEW: NO SELLABLE STOCK ONLINE ────────────────────────────
// docs/SHOPIFY-REVIEW-INSTOCK.md. The Mac mini's reconcile tick keeps
// /config/shopifyReviewHidden/{pid} for every product with no unit the website
// could sell (the same networkTotals the storefront is pushed). That node is
// readable by any signed-in staff account under the existing /config rule, so
// no rules paste is needed. Only the KEYS are read (~20 bytes per product), and
// before the list renders, because the list's window must not shift when rows
// load. FAIL-OPEN: if the read fails, nothing is hidden and the page behaves as
// it did before this existed.
export const REVIEW_HIDDEN_PATH = "config/shopifyReviewHidden";
let hiddenCache = null; // { keys: Set<pid>, at }
/**
 * Pids hidden from review for having no sellable stock online. By default it
 * never rejects: a failed read answers an empty set, so nothing is hidden
 * (fail-open). `throwOnError` is for refreshes that already hold an answer.
 */
export async function loadReviewHidden({ fresh = false, throwOnError = false } = {}) {
  if (!fresh && hiddenCache && Date.now() - hiddenCache.at < KEYS_TTL_MS) return hiddenCache.keys;
  try {
    const keys = await shallowKeys(REVIEW_HIDDEN_PATH);
    hiddenCache = { keys, at: Date.now() };
    return keys;
  } catch (e) {
    // A REFRESH asks to see the failure, so that one blip does not
    // un-hide everything the page already knows is hidden.
    if (throwOnError) throw e;
    return new Set();
  }
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

// The DECISIONS behind every button live in publishMutators.js (no Firebase),
// so the New Arrivals chain on the Mac mini runs exactly the same code through
// an Admin SDK transaction. This file binds them to the browser: server time,
// the signed-in uid, and runTransaction via writeNode. Each mutator receives
// the SERVER's node — or, on the cold-cache first call, the row's snapshot —
// and every gate is evaluated inside the transaction against that value.
const ctx = () => ({ now: serverNowMs(), uid: auth.currentUser ? auth.currentUser.uid : null });

async function decide(productId, node, mutator, args) {
  let refusal = null;
  const res = await writeNode(productId, (cur) => {
    const out = mutator(cur || node || {}, args, ctx());
    if (out.refusal) { refusal = out.refusal; return undefined; }
    return out.next;
  });
  if (res.aborted) return { ok: false, message: refusal || "Not saved." };
  return res;
}

/**
 * Approve a product's cleaned name — the review flow's core write. Stamps
 * `nameApprovedAt` (state stays "awaiting"). Refused for a product that is ON
 * the storefront — a rename there would silently diverge from what customers see.
 */
export async function approveName(productId, node, name, source = "manual") {
  const problem = precheck.approveName(name);
  if (problem) return { ok: false, message: problem };
  return decide(productId, node, approveNameMutator, { name, source });
}

/**
 * Take the proposed name (cleanName + cleanNameSource "ai", proposal stamped
 * applied and KEPT). `seenProposedAt` is the proposal the caller actually
 * DISPLAYED — it is what stops a re-run's newer proposal being approved
 * sight unseen.
 */
export async function applyNameProposal(productId, node, seenProposedAt = null) {
  return decide(productId, node, applyProposalMutator, { seenProposedAt });
}

/** Keep the name the product already has. The proposal is marked rejected and KEPT. */
export async function dismissNameProposal(productId, node, seenProposedAt = null) {
  return decide(productId, node, dismissProposalMutator, { seenProposedAt });
}

/**
 * THE publish action: records the reviewed name and the INTENT to go on the
 * storefront (desiredState "on"); the owner-run reconciler does the rest.
 * Refused when already on, and without a condition grade.
 */
export async function publishProduct(productId, node, name, source = "manual") {
  const problem = precheck.publish(name);
  if (problem) return { ok: false, message: problem };
  // EXCELLENT BY DEFAULT (owner, 2026-10-03: Excellent is the only grade). A
  // product without it gets it first, through the same condition write the
  // chip makes, so a publish never stops to ask for a grade.
  if (node?.condition !== OFFERED_CONDITIONS[0]) {
    const graded = await decide(productId, node, conditionMutator, { condition: OFFERED_CONDITIONS[0] });
    if (!graded.ok) return graded;
    node = graded.node;
  }
  return decide(productId, node, publishMutator, { name, source });
}

/**
 * The on/off switch: write the INTENT only. "on" re-checks the condition gate;
 * "off" is always allowed and EVERY off records WHY (publishAudit.js,
 * docs/PUBLISH-AUTO-OFF.md).
 */
export async function setDesiredState(productId, node, want, { reasonCode = "switched_off", detail = null } = {}) {
  const problem = precheck.desiredState(want);
  if (problem) return { ok: false, message: problem };
  return decide(productId, node, desiredStateMutator, { want, reasonCode, detail });
}

export { APP_STORAGE_PREFIX, publishPhotoListProblem };

/**
 * Set the PUBLISHING photo list — ordered, first = primary, stored at
 * /shopify_publish/{pid}/photos and NOWHERE else. `photos === null` clears the
 * custom set. Optimistically concurrent: `node` is the snapshot this edit was
 * computed FROM, and a different server list refuses.
 */
export async function setPublishPhotos(productId, node, photos) {
  const problem = precheck.photos(photos);
  if (problem) return { ok: false, message: problem };
  return decide(productId, node, photosMutator, { photos, basisPhotos: node?.photos });
}

/**
 * Save the product's whole ordered MEDIA list (photos and videos; first = the
 * primary photo) to /shopify_publish/{pid}/media, with `photos` rewritten as
 * its photo projection in the same transaction. Allowed while the listing is
 * ON — the reconciler carries it to Shopify on its next tick. Optimistically
 * concurrent against `node` (the snapshot this edit was computed from).
 * `basisPhotos` = the photo list the page showed before this edit.
 */
export async function setPublishMedia(productId, node, items, { basisPhotos = null } = {}) {
  const problem = precheck.media(items);
  if (problem) return { ok: false, message: problem };
  return decide(productId, node, mediaMutator, { media: items, basisKey: storedMediaKey(node), basisPhotos });
}

/**
 * Append finished uploads (bytes already in Storage) to the product's media
 * list, computed from the server's current list inside the transaction.
 * `product` supplies the record photo for a product with no list yet.
 */
export async function appendPublishMedia(productId, node, items, product) {
  return decide(productId, node, appendMediaMutator,
    { items, product: { photoUrl: product?.photoUrl ?? null, gallery: product?.gallery ?? null } });
}

/** Set the condition grade. Unblocks a blocked product (blocked → awaiting). */
export async function setCondition(productId, node, condition) {
  const problem = precheck.condition(condition);
  if (problem) return { ok: false, message: problem };
  return decide(productId, node, conditionMutator, { condition });
}
