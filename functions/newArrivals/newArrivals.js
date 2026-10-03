// ─── NEW ARRIVALS — trigger + the card's three callables ─────────────────────
// newArrivalsEnqueue  onValueCreated products/{pid}: an upload lands in New.
// newArrivalsList     the card's read of one tab (bounded, no whole-node read).
// newArrivalsApprove  Junid's tap — Ready → approved (one pid, or all Ready).
// newArrivalsRetry    (legacy, card no longer calls it) Rejected → New.
// newArrivalsGenerate Generate / Generate selected / Regenerate → generateRequest.
// newArrivalsSkip     Skip — don't advertise (New/Rejected → Skipped).
// newArrivalsRestore  Skipped → New.
// newArrivalsReject   Ready → Rejected with one reason chip.
// Every action Junid takes writes new_arrivals/decisions/{push}.
//
// The card never reads or writes /new_arrivals directly, so no database rule
// is needed for it: these callables use the Admin SDK behind their own gate.
// Everything after Approve is done by the Mac mini agents
// (marathon-group-poster + scripts/newArrivals/chain.mjs).
//
// Deploy BY NAME, never a bare --only functions (DEPLOY-TRACKER.md):
//   firebase deploy --only functions:newArrivalsEnqueue,functions:newArrivalsList,functions:newArrivalsApprove,functions:newArrivalsRetry,functions:newArrivalsGenerate,functions:newArrivalsSkip,functions:newArrivalsRestore,functions:newArrivalsReject
"use strict";

const { onValueCreated } = require("firebase-functions/v2/database");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const core = require("./core.cjs");
const { ONLINE_EXCLUDED_LOCATIONS } = require("../lib/social-select.cjs");

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

// ── shared reads ─────────────────────────────────────────────────────────────
const val = async (db, path) => (await db.ref(path).once("value")).val();

// Run fn over xs, `width` at a time (bounded fan-out of keyed reads/moves).
async function inBatches(xs, width, fn) {
  const out = [];
  for (let i = 0; i < xs.length; i += width) out.push(...await Promise.all(xs.slice(i, i + width).map(fn)));
  return out;
}

// The stock locations to read per product. /locations is a ~10-row config
// node (the same bounded read productType/setProductType.js makes); the
// ONLINE_EXCLUDED ones are dropped before any per-pid read, since they never
// count (core.stockSummary).
async function stockLocations(db) {
  const snap = await db.ref("locations").orderByKey().limitToFirst(100).once("value");
  return Object.keys(snap.val() || {}).filter((l) => !ONLINE_EXCLUDED_LOCATIONS.has(l));
}

// One product's summary + sizes in stock + units: products/{pid} and
// stock/{loc}/{pid} per location — every read keyed, never a whole node.
async function productDetail(db, pid, locations) {
  const [product, ...cells] = await Promise.all([
    val(db, `products/${pid}`),
    ...locations.map((loc) => val(db, `stock/${loc}/${pid}`)),
  ]);
  const summary = core.productSummary(product);
  const tree = {};
  locations.forEach((loc, j) => { if (cells[j]) tree[loc] = cells[j]; });
  const stock = core.stockSummary(summary ? summary.sizes : [], tree);
  return { summary, stock };
}

// ── list ─────────────────────────────────────────────────────────────────────
// One page of one tab. PAGED BY KEY: by_status/{status} orderByKey()
// .startAfter(cursor).limitToFirst(n+1) per status in the tab, merged in key
// order ("p<ms>" keys → oldest upload first). The index nodes are pid → number
// and are read whole for the counts (they are the index — /products and
// /new_arrivals/items are never read whole). With a New-tab filter, the lane's
// keys are scanned and each pid's product (and stock, for "1 size only") read
// keyed; total = the filtered count.
async function listTab(db, tab, { cursor = null, limit, filter = null } = {}) {
  if (!core.TABS.includes(tab)) throw new HttpsError("invalid-argument", "Unknown tab.");
  const n = core.listLimit(limit);
  const after = cursor && core.PID_RE.test(String(cursor)) ? String(cursor) : null;
  const statuses = core.STATUSES_IN_TAB[tab];

  const index = {};
  await Promise.all(core.STATUSES.map(async (s) => { index[s] = Object.keys((await val(db, `${core.BY_STATUS}/${s}`)) || {}); }));
  const tabCounts = {};
  for (const t of core.TABS) tabCounts[t] = core.STATUSES_IN_TAB[t].reduce((c, s) => c + index[s].length, 0);
  const laneKeys = [...new Set(statuses.flatMap((s) => index[s]))].sort(core.keyCmp);
  // What a "Select all" may act on: never an item mid-generation.
  const selectable = new Set(statuses.filter((s) => s !== "generating").flatMap((s) => index[s]));

  const f = tab === "new" ? core.normalizeFilter(filter) : null;
  const locations = await stockLocations(db);
  const details = new Map();
  let pageKeys, more, total, matching;
  if (!f) {
    const pages = await Promise.all(statuses.map(async (s) => {
      let q = db.ref(`${core.BY_STATUS}/${s}`).orderByKey();
      if (after) q = q.startAfter(after);
      return Object.keys((await q.limitToFirst(n + 1).once("value")).val() || {});
    }));
    const merged = [...new Set(pages.flat())].sort(core.keyCmp);
    pageKeys = merged.slice(0, n);
    more = merged.length > n;
    total = tabCounts[tab];
    matching = laneKeys;
  } else {
    matching = [];
    await inBatches(laneKeys, 20, async (pid) => {
      const d = await productDetail(db, pid, locations);
      details.set(pid, d);
      if (core.matchesFilter(d.summary, d.stock, f)) matching.push(pid);
    });
    matching.sort(core.keyCmp);
    const rest = after ? matching.filter((k) => core.keyCmp(k, after) > 0) : matching;
    pageKeys = rest.slice(0, n);
    more = rest.length > n;
    total = matching.length;
  }

  const items = (await inBatches(pageKeys, 10, async (pid) => {
    const item = await val(db, `${core.ITEMS}/${pid}`);
    const listedUnder = statuses.find((s) => index[s].includes(pid)) || statuses[0];
    const repair = core.indexRepair(pid, listedUnder, item);
    if (repair) await db.ref(core.ROOT).update(repair);
    if (!item || core.TAB_OF[item.status] !== tab) return null;
    const d = details.get(pid) || await productDetail(db, pid, locations);
    return { ...item, product: d.summary, availableSizes: d.stock.availableSizes, totalUnits: d.stock.totalUnits, stockKnown: d.stock.stockKnown };
  })).filter(Boolean);

  const [stats, modes] = await Promise.all([val(db, `${core.ROOT}/stats`), val(db, `${core.ROOT}/config/mode`)]);
  const out = {
    tab, items, total, nextCursor: more && pageKeys.length ? pageKeys[pageKeys.length - 1] : null,
    tabCounts, stats: stats || null, modes: modes || {}, filter: f,
  };
  // Every pid the tab's multi-select can act on — the whole filtered lane,
  // not just the loaded page ("Select all" then "Skip selected").
  if (tab === "new" || tab === "skipped") out.matchingPids = matching.filter((p) => selectable.has(p));
  return out;
}

const callableOpts = { region: "europe-west1", memory: "256MiB", timeoutSeconds: 120 };

const newArrivalsList = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  const d = request.data || {};
  return listTab(admin.database(), String(d.tab || "ready"), { cursor: d.cursor || null, limit: d.limit, filter: d.filter || null });
});

// ── moves + the ledger ───────────────────────────────────────────────────────
/**
 * Move one item, then its index entry. `fields(cur)` builds the merge from the
 * item as it is; `guard(cur)` may refuse (a string) once the status is right.
 * Returns { item, prev } or { refusal }. `prev` is the item as Junid acted on
 * it — the decision row's generation snapshot comes from it.
 */
async function moveOne(db, pid, { from, to, at, fields = () => ({}), guard = null }) {
  const allowed = Array.isArray(from) ? from : [from];
  const out = {};
  let prev = null;
  const res = await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => {
    if (cur && allowed.includes(cur.status) && guard) {
      const why = guard(cur);
      if (why) { out.refusal = why; return undefined; }
    }
    if (cur) prev = cur;
    return core.moveMutator({ from: allowed, to, at, fields: cur ? fields(cur) : {} }, out)(cur);
  });
  const item = core.moved(res, to);
  if (!item) return { refusal: out.refusal || "not saved" };
  await db.ref(core.ROOT).update(core.indexMove(pid, out.from, to, item.enqueuedAt));
  return { item, prev };
}

/** Write decisions/{push} — one row per action Junid took. */
async function logDecision(db, { pid, action, reason = null, prev, uid, nowMs }) {
  let categoryKey = prev && prev.categoryKey;
  if (!categoryKey) categoryKey = await val(db, `products/${pid}/categoryKey`);
  const rec = core.decisionRecord({ pid, at: nowMs, by: uid, action, reason, item: prev, categoryKey });
  await db.ref(core.DECISIONS).push().set(rec);
  return rec;
}

const MAX_PIDS = 300;
function pidList(pids) {
  const list = Array.isArray(pids) ? [...new Set(pids.map(String).filter((p) => core.PID_RE.test(p)))] : [];
  if (!list.length) throw new HttpsError("invalid-argument", "No items given.");
  if (list.length > MAX_PIDS) throw new HttpsError("invalid-argument", "Too many at once.");
  return list;
}

// ── approve ──────────────────────────────────────────────────────────────────
// Ready → approved. With `anyway`, a Rejected item too ("Approve anyway":
// straight into the approved chain). A stock price is required either way.
async function approve(db, { pids, all, anyway }, uid, nowMs) {
  let targets = [];
  if (all === true) {
    targets = Object.keys((await db.ref(`${core.BY_STATUS}/ready`).once("value")).val() || {});
  } else if (Array.isArray(pids)) {
    targets = pids.map(String).filter((p) => core.PID_RE.test(p));
  }
  if (!targets.length) throw new HttpsError("invalid-argument", "Nothing to approve.");
  if (targets.length > MAX_PIDS) throw new HttpsError("invalid-argument", "Too many at once.");
  const from = anyway === true ? ["ready", "rejected"] : ["ready"];
  const approved = [];
  const skipped = [];
  for (const pid of targets) {
    // The groups are priced at the STOCK price (Junid sells to traders): no
    // stock price, no approve — said now, in the card. Retail is Shopify's
    // business: the chain lets Shopify wait for it; the groups do not.
    const listed = (await db.ref(`${core.ITEMS}/${pid}/status`).once("value")).val();
    if (from.includes(listed)) {
      const price = Number((await db.ref(`products/${pid}/stockPrice`).once("value")).val());
      if (!(price > 0)) { skipped.push({ pid, why: "no stock price yet — enter it on the card, then approve" }); continue; }
    }
    const r = await moveOne(db, pid, {
      from, to: "approved", at: nowMs,
      // Approve only what has a generated photo — never an original.
      guard: (cur) => (cur.generatedUrl ? null : "it has no generated photo"),
      fields: (cur) => ({
        approvedAt: nowMs, approvedBy: uid || "unknown",
        ...(cur.status === "rejected" ? { lastRejection: cur.rejection || null, rejection: null } : {}),
      }),
    });
    if (!r.item) { skipped.push({ pid, why: r.refusal }); continue; }
    await logDecision(db, { pid, action: r.prev.status === "rejected" ? "approve-anyway" : "approve", prev: r.prev, uid, nowMs });
    approved.push(pid);
  }
  return { approved, skipped };
}

const newArrivalsApprove = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return approve(admin.database(), request.data || {}, request.auth?.uid, Date.now());
});

// ── generate / regenerate ────────────────────────────────────────────────────
// Sets generateRequest; the poster takes it, clears it, generates ONCE and
// puts the result in Ready. From New (Generate), or — only with `regenerate`
// — from Ready or Rejected: a FRESH attempt from the original photo, never a
// fix-up edit. The lap's photo, verdict, name and chain stamps are cleared;
// every earlier generation stays in `generations` (kept for ever).
const NEW_LAP = Object.freeze({
  generatedUrl: null, generatedPath: null, currentGen: null, verdict: null, framingFlag: null,
  checker: null, namePending: null, chain: null, suggestedName: null, suggestedNameSource: null,
  nameProposedAt: null, destinations: null, approvedAt: null, approvedBy: null, rejection: null,
});
async function generate(db, { pids, regenerate }, uid, nowMs) {
  const list = pidList(pids);
  const from = regenerate === true ? ["new", "ready", "rejected"] : ["new"];
  const requested = [];
  const skipped = [];
  await inBatches(list, 10, async (pid) => {
    const r = await moveOne(db, pid, {
      from, to: "new", at: nowMs,
      guard: (cur) => (cur.status === "new" && cur.generateRequest ? "already requested — the generator will take it" : null),
      fields: (cur) => ({
        generateRequest: { at: nowMs, by: uid || "unknown" },
        ...(cur.status === "new" ? {} : { ...NEW_LAP, attemptsSinceRetry: 0, lastRejection: cur.rejection || cur.lastRejection || null }),
      }),
    });
    if (!r.item) { skipped.push({ pid, why: r.refusal }); return; }
    await logDecision(db, { pid, action: r.prev.status === "new" ? "generate" : "regenerate", prev: r.prev, uid, nowMs });
    requested.push(pid);
  });
  return { requested, skipped };
}

const newArrivalsGenerate = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return generate(admin.database(), request.data || {}, request.auth?.uid, Date.now());
});

// ── skip / restore ───────────────────────────────────────────────────────────
// Skip — don't advertise: New or Rejected → skipped. Never generated, posted
// or published; nothing moves it back but Restore (enqueue only repairs the
// index of an item already queued, whatever its status).
async function skip(db, { pids }, uid, nowMs) {
  const list = pidList(pids);
  const done = [];
  const skipped = [];
  await inBatches(list, 10, async (pid) => {
    const r = await moveOne(db, pid, {
      from: ["new", "rejected"], to: "skipped", at: nowMs,
      fields: () => ({ skippedAt: nowMs, skippedBy: uid || "unknown", generateRequest: null }),
    });
    if (!r.item) { skipped.push({ pid, why: r.refusal }); return; }
    await logDecision(db, { pid, action: "skip", prev: r.prev, uid, nowMs });
    done.push(pid);
  });
  return { skippedPids: done, skipped };
}

async function restore(db, { pids }, uid, nowMs) {
  const list = pidList(pids);
  const done = [];
  const skipped = [];
  await inBatches(list, 10, async (pid) => {
    const r = await moveOne(db, pid, {
      from: "skipped", to: "new", at: nowMs,
      fields: () => ({ skippedAt: null, skippedBy: null }),
    });
    if (!r.item) { skipped.push({ pid, why: r.refusal }); return; }
    await logDecision(db, { pid, action: "restore", prev: r.prev, uid, nowMs });
    done.push(pid);
  });
  return { restored: done, skipped };
}

const newArrivalsSkip = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return skip(admin.database(), request.data || {}, request.auth?.uid, Date.now());
});
const newArrivalsRestore = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return restore(admin.database(), request.data || {}, request.auth?.uid, Date.now());
});

// ── reject ───────────────────────────────────────────────────────────────────
// Ready → Rejected with ONE of the reason chips (no typing).
async function reject(db, { pid, reason }, uid, nowMs) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  if (!core.REJECT_CHIPS.includes(reason)) throw new HttpsError("invalid-argument", "Pick one of the reasons.");
  const r = await moveOne(db, String(pid), {
    from: "ready", to: "rejected", at: nowMs,
    fields: () => ({ rejection: { code: "junid", reason, at: nowMs } }),
  });
  if (!r.item) throw new HttpsError("failed-precondition", `Can't reject — ${r.refusal}.`);
  await logDecision(db, { pid: String(pid), action: "reject", reason, prev: r.prev, uid, nowMs });
  return { ok: true };
}

const newArrivalsReject = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return reject(admin.database(), request.data || {}, request.auth?.uid, Date.now());
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
  newArrivalsGenerate, newArrivalsSkip, newArrivalsRestore, newArrivalsReject,
  // for tests
  _internals: { enqueue, listTab, approve, retry, generate, skip, restore, reject, assertNewArrivalsAccess },
};
