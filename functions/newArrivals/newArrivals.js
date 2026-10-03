// ─── NEW ARRIVALS — trigger + the card's three callables ─────────────────────
// newArrivalsEnqueue  onValueCreated products/{pid}: an upload lands in New.
// newArrivalsList     the card's read of one tab (bounded, no whole-node read).
// newArrivalsApprove  Junid's tap — Ready → approved (one pid, or all Ready).
// newArrivalsRetry    Rejected → New for a completely fresh generation.
//
// The card never reads or writes /new_arrivals directly, so no database rule
// is needed for it: these callables use the Admin SDK behind their own gate.
// Everything after Approve is done by the Mac mini agents
// (marathon-group-poster + scripts/newArrivals/chain.mjs).
//
// Deploy BY NAME, never a bare --only functions (DEPLOY-TRACKER.md):
//   firebase deploy --only functions:newArrivalsEnqueue,functions:newArrivalsList,functions:newArrivalsApprove,functions:newArrivalsRetry
"use strict";

const { onValueCreated } = require("firebase-functions/v2/database");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const core = require("./core.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const ADMIN_EMAIL = "gunidmoh@gmail.com"; // the super-admin, as in functions/index.js

// Junid, or anyone holding the Shopify Publishing grant — Approve ends in a
// Shopify publish, so it takes the same grant the publishing card does. Read
// from the permFlags scalar the rules read. FAIL CLOSED on a read error.
async function assertNewArrivalsAccess(request, db = admin.database()) {
  if (request.auth?.token?.email === ADMIN_EMAIL) return;
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("permission-denied", "Sign in required.");
  let granted = false;
  try {
    granted = (await db.ref(`users/${uid}/permFlags/shopify_publish`).once("value")).val() === true;
  } catch (err) {
    console.error("assertNewArrivalsAccess: permission read failed:", err.message);
    throw new HttpsError("unavailable", "Could not check permissions. Try again.");
  }
  if (!granted) throw new HttpsError("permission-denied", "New Arrivals needs the Shopify Publishing permission.");
}

// ── enqueue ──────────────────────────────────────────────────────────────────
async function enqueue(db, pid, product, nowMs) {
  // An item already queued is repaired FIRST, whatever the eligibility window
  // says now: a late redelivery must still restore a lost index entry.
  if (core.PID_RE.test(String(pid || ""))) {
    const existing = (await db.ref(`${core.ITEMS}/${pid}`).once("value")).val();
    if (existing && existing.status) {
      await db.ref(core.ROOT).update(core.indexMove(pid, null, existing.status, existing.enqueuedAt));
      return { enqueued: false, why: "already queued" };
    }
  }
  const verdict = core.enqueueDecision(pid, product, nowMs);
  if (!verdict.ok) return { enqueued: false, why: verdict.why };
  const item = core.buildItem(pid, product, nowMs);
  // Idempotent under redelivery: an existing item is never overwritten.
  const res = await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => (cur ? undefined : item));
  if (!res.committed) {
    // A crash between the item write and the index write would otherwise
    // leave an item no reader can find (readers only walk by_status). The
    // redelivered trigger lands here, so it re-asserts the index entry.
    const cur = res.snapshot && res.snapshot.val();
    if (cur && cur.status) await db.ref(core.ROOT).update(core.indexMove(pid, null, cur.status, cur.enqueuedAt));
    return { enqueued: false, why: "already queued" };
  }
  await db.ref(core.ROOT).update(core.indexMove(pid, null, "new", item.enqueuedAt));
  return { enqueued: true };
}

const newArrivalsEnqueue = onValueCreated(
  { ref: "/products/{pid}", instance: "marathon-club-default-rtdb", region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (event) => {
    const pid = event.params.pid;
    const out = await enqueue(admin.database(), pid, event.data.val(), Date.now());
    if (out.enqueued) console.log(`newArrivalsEnqueue: ${pid} queued`);
  },
);

// ── list ─────────────────────────────────────────────────────────────────────
async function listTab(db, tab, limit) {
  if (!core.TABS.includes(tab)) throw new HttpsError("invalid-argument", "Unknown tab.");
  const n = core.listLimit(limit);
  const counts = {};
  const rows = [];
  for (const status of core.STATUSES_IN_TAB[tab]) {
    // orderByKey + limitToLast: the newest n pids ("p<ms>" keys sort by time).
    const snap = await db.ref(`${core.BY_STATUS}/${status}`).orderByKey().limitToLast(n).once("value");
    const pids = Object.keys(snap.val() || {});
    counts[status] = pids.length;
    for (const pid of pids) rows.push({ pid, listedUnder: status });
  }
  const items = [];
  for (const { pid, listedUnder } of rows) {
    const item = (await db.ref(`${core.ITEMS}/${pid}`).once("value")).val();
    const repair = core.indexRepair(pid, listedUnder, item);
    if (repair) await db.ref(core.ROOT).update(repair);
    if (!item || core.TAB_OF[item.status] !== tab) continue;
    const product = core.productSummary((await db.ref(`products/${pid}`).once("value")).val());
    items.push({ ...item, product });
  }
  items.sort((a, b) => (b.statusAt || 0) - (a.statusAt || 0));
  // Tab counts for the chips: the small statuses in full, Done bounded.
  const tabCounts = {};
  for (const t of core.TABS) {
    let c = 0;
    for (const s of core.STATUSES_IN_TAB[t]) {
      const ref = db.ref(`${core.BY_STATUS}/${s}`);
      const snap = t === "done" ? await ref.orderByKey().limitToLast(core.LIST_LIMIT_MAX).once("value") : await ref.once("value");
      c += Object.keys(snap.val() || {}).length;
    }
    tabCounts[t] = c;
  }
  return { tab, items: items.slice(0, n), tabCounts };
}

const callableOpts = { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 };

const newArrivalsList = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return listTab(admin.database(), String(request.data?.tab || "ready"), request.data?.limit);
});

// ── approve ──────────────────────────────────────────────────────────────────
async function approve(db, { pids, all }, uid, nowMs) {
  let targets = [];
  if (all === true) {
    targets = Object.keys((await db.ref(`${core.BY_STATUS}/ready`).once("value")).val() || {});
  } else if (Array.isArray(pids)) {
    targets = pids.map(String).filter((p) => core.PID_RE.test(p));
  }
  if (!targets.length) throw new HttpsError("invalid-argument", "Nothing to approve.");
  if (targets.length > 300) throw new HttpsError("invalid-argument", "Too many at once.");
  const approved = [];
  const skipped = [];
  for (const pid of targets) {
    const out = {};
    // The groups are priced at the STOCK price (Junid sells to traders): no
    // stock price, no approve — said now, in the card. Retail is Shopify's
    // business: the chain lets Shopify wait for it; the groups do not.
    const listed = (await db.ref(`${core.ITEMS}/${pid}/status`).once("value")).val();
    if (listed === "ready") {
      const price = Number((await db.ref(`products/${pid}/stockPrice`).once("value")).val());
      if (!(price > 0)) { skipped.push({ pid, why: "no stock price yet — enter it on the card, then approve" }); continue; }
    }
    const ref = db.ref(`${core.ITEMS}/${pid}`);
    const res = await ref.transaction((cur) => {
      // Approve only what has a checked, generated photo — never an original.
      if (cur && cur.status === "ready" && !cur.generatedUrl) { out.refusal = "it has no generated photo"; return undefined; }
      return core.moveMutator({ from: "ready", to: "approved", at: nowMs,
        fields: { approvedAt: nowMs, approvedBy: uid || "unknown" } }, out)(cur);
    });
    const item = core.moved(res, "approved");
    if (!item) { skipped.push({ pid, why: out.refusal || "not saved" }); continue; }
    await db.ref(core.ROOT).update(core.indexMove(pid, "ready", "approved", item.enqueuedAt));
    approved.push(pid);
  }
  return { approved, skipped };
}

const newArrivalsApprove = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return approve(admin.database(), request.data || {}, request.auth?.uid, Date.now());
});

// ── retry ────────────────────────────────────────────────────────────────────
async function retry(db, pid, uid, nowMs) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  const out = {};
  const res = await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => core.moveMutator({
    from: "rejected", to: "new", at: nowMs,
    // A FRESH generation: the next run starts from the original photo again,
    // with a new automatic-attempt budget. The rejection is kept as history.
    fields: {
      attemptsSinceRetry: 0, retryRequestedAt: nowMs, retryRequestedBy: uid || "unknown",
      lastRejection: cur && cur.rejection ? cur.rejection : null, rejection: null,
      generatedUrl: null, generatedPath: null, checker: null, namePending: null,
      // A retry is a NEW lap: the previous lap's chain stamps, name and
      // destinations must not let the chain skip steps with stale values.
      chain: null, suggestedName: null, suggestedNameSource: null, nameProposedAt: null,
      destinations: null, approvedAt: null, approvedBy: null,
    },
  }, out)(cur));
  const item = core.moved(res, "new");
  if (!item) throw new HttpsError("failed-precondition", `Can't retry — ${out.refusal || "not saved"}.`);
  await db.ref(core.ROOT).update(core.indexMove(pid, "rejected", "new", item.enqueuedAt));
  return { ok: true };
}

const newArrivalsRetry = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return retry(admin.database(), request.data?.pid, request.auth?.uid, Date.now());
});

module.exports = {
  newArrivalsEnqueue, newArrivalsList, newArrivalsApprove, newArrivalsRetry,
  // for tests
  _internals: { enqueue, listTab, approve, retry, assertNewArrivalsAccess },
};
