// ─── NEW ARRIVALS — trigger + the card's three callables ─────────────────────
// newArrivalsEnqueue  onValueCreated products/{pid}: an upload lands in New.
// newArrivalsList     the card's read of one tab + group (bounded, no whole-node read).
// newArrivalsApprove  Junid's tap — any New-tab item with a photo → approved (one pid, or all Ready).
// newArrivalsRetry    (legacy, card no longer calls it) Rejected → New.
// newArrivalsGenerate Generate / Generate selected / Regenerate → generateRequest.
// newArrivalsSkip     Skip — don't advertise (new/ready/rejected → skipped; marked, never deleted).
// newArrivalsRestore  the card's Undo: skipped → back to the lane it came from (skippedFrom).
// newArrivalsReject   a photo → lane rejected with one reason chip (still on the New tab).
// newArrivalsSelect   "Use this one" — any generation becomes the main photo (lane kept).
// newArrivalsLove     ❤ / un-❤ one generation (any lane; never moves or approves).
// Every action Junid takes writes new_arrivals/decisions/{push}.
//
// The card never reads or writes /new_arrivals directly, so no database rule
// is needed for it: these callables use the Admin SDK behind their own gate.
// Everything after Approve is done by the Mac mini agents
// (marathon-group-poster + scripts/newArrivals/chain.mjs).
//
// Deploy BY NAME, never a bare --only functions (DEPLOY-TRACKER.md):
//   firebase deploy --only functions:newArrivalsEnqueue,functions:newArrivalsList,functions:newArrivalsApprove,functions:newArrivalsRetry,functions:newArrivalsGenerate,functions:newArrivalsSkip,functions:newArrivalsRestore,functions:newArrivalsReject,functions:newArrivalsSelect,functions:newArrivalsLove
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
async function productDetail(db, pid, locations, { withStock = true } = {}) {
  // Stock is read only when needed (the page's items, or the "1 size only" filter).
  const [product, ...cells] = await Promise.all([
    val(db, `products/${pid}`),
    ...(withStock ? locations : []).map((loc) => val(db, `stock/${loc}/${pid}`)),
  ]);
  if (!withStock) return { summary: core.productSummary(product), stock: null };
  const summary = core.productSummary(product);
  const tree = {};
  locations.forEach((loc, j) => { if (cells[j]) tree[loc] = cells[j]; });
  const stock = core.stockSummary(summary ? summary.sizes : [], tree);
  return { summary, stock };
}

// ── list ─────────────────────────────────────────────────────────────────────
// The card's group of each pid: products/{pid}/categoryKey and /category, two
// keyed scalar reads (never the product, never /products). Cached per process
// for GROUP_TTL_MS — a category edit shows on the card within minutes, and the
// 30-second refresh does not re-read a whole lane's categories every time.
const GROUP_TTL_MS = 5 * 60 * 1000;
const groupCache = new WeakMap(); // db → Map(pid → { g, at })
async function groupsOf(db, pids, nowMs = Date.now()) {
  let cache = groupCache.get(db);
  if (!cache) { cache = new Map(); groupCache.set(db, cache); }
  const out = new Map();
  await inBatches(pids, 50, async (pid) => {
    const hit = cache.get(pid);
    if (hit && nowMs - hit.at < GROUP_TTL_MS) { out.set(pid, hit.g); return; }
    const [categoryKey, category] = await Promise.all([val(db, `products/${pid}/categoryKey`), val(db, `products/${pid}/category`)]);
    const g = core.groupOf({ categoryKey, category });
    cache.set(pid, { g, at: nowMs });
    out.set(pid, g);
  });
  return out;
}

// THE NEW TAB'S BUCKETS — cheap: the lane comes from the index, "generating"
// from the small requests/{pid} index (read once), and only for new- and
// rejected-lane pids the scalar items/{pid}/currentGen (plus, for a rejected
// one with none, the scalar generatedUrl) — keyed reads, batched like
// groupsOf, never the items node. Not cached: a photo landing must move the
// item up on the next refresh.
async function bucketsOf(db, pids, laneOf, requested) {
  const out = new Map();
  await inBatches(pids, 50, async (pid) => {
    const lane = laneOf.get(pid) || null;
    const base = { lane, requested: requested.has(pid) };
    if (base.requested || lane === "generating" || lane === "ready") { out.set(pid, core.photoBucket(base)); return; }
    const currentGen = await val(db, `${core.ITEMS}/${pid}/currentGen`);
    const generatedUrl = !currentGen && lane === "rejected" ? await val(db, `${core.ITEMS}/${pid}/generatedUrl`) : null;
    out.set(pid, core.photoBucket({ ...base, currentGen, generatedUrl }));
  });
  return out;
}

// One page of one tab. The index nodes are pid → number and are read BY KEY
// with a ceiling for the counts (they are the index — /products and
// /new_arrivals/items are never read whole).
// NEW (lanes new, generating, ready, rejected — merged): the lane's keys are
// split into Sneakers / Clothing by each pid's category (groupsOf: keyed
// scalar reads), ordered photo ready → generating → no photo yet (key order
// within a bucket), and the page is taken from that ordered list; the cursor
// is the last pid of the page. total = the group's count; groupCounts carries
// both. A legacy `filter` (an older card bundle) still works on New. An old
// bundle's "ready" / "rejected" tab is New.
// DONE / SKIPPED: PAGED BY KEY — by_status/{status} orderByKey()
// .startAfter(cursor).limitToFirst(n+1) per status, merged in key order.
async function listTab(db, tabAsked, { cursor = null, limit, filter = null, group = null } = {}) {
  const tab = core.normalizeTab(tabAsked);
  if (!tab) throw new HttpsError("invalid-argument", "Unknown tab.");
  const n = core.listLimit(limit);
  const after = cursor && core.PID_RE.test(String(cursor)) ? String(cursor) : null;
  const statuses = core.STATUSES_IN_TAB[tab];

  // Each status index is read BY KEY with a ceiling (never unbounded — Done
  // grows for ever); a lane past the ceiling shows "N+".
  const index = {};
  await Promise.all(core.STATUSES.map(async (s) => {
    const snap = await db.ref(`${core.BY_STATUS}/${s}`).orderByKey().limitToFirst(core.INDEX_CEILING + 1).once("value");
    index[s] = Object.keys(snap.val() || {});
  }));
  const tabCounts = {};
  for (const t of core.TABS) tabCounts[t] = core.STATUSES_IN_TAB[t].reduce((c, s) => c + index[s].length, 0);
  const laneOf = new Map();
  for (const s of statuses) for (const k of index[s]) if (!laneOf.has(k)) laneOf.set(k, s);
  const laneKeys = [...laneOf.keys()].sort(core.keyCmp);
  // What a "Select all" may act on: never an item mid-generation.
  const selectable = new Set(statuses.filter((s) => s !== "generating").flatMap((s) => index[s]));

  const f = tab === "new" ? core.normalizeFilter(filter) : null;
  const g = !f && core.GROUP_TABS.includes(tab) ? core.normalizeGroup(group) : null;
  const locations = await stockLocations(db);
  const details = new Map();
  let pageKeys, more, total, matching, groupCounts = null;

  if (tab === "new") {
    if (g) {
      const groups = await groupsOf(db, laneKeys);
      groupCounts = Object.fromEntries(core.GROUPS.map((x) => [x, 0]));
      for (const k of laneKeys) groupCounts[groups.get(k)] += 1;
      matching = laneKeys.filter((k) => groups.get(k) === g);
    } else if (f) {
      matching = [];
      // Only "1 size only" needs stock to match; the other filters match on the
      // product alone, and stock is then read just for the page's items.
      const needStock = !!f.oneSize;
      await inBatches(laneKeys, 20, async (pid) => {
        const d = await productDetail(db, pid, locations, { withStock: needStock });
        if (needStock) details.set(pid, d);
        if (core.matchesFilter(d.summary, d.stock || core.stockSummary(d.summary ? d.summary.sizes : [], {}), f)) matching.push(pid);
      });
    } else {
      matching = laneKeys;
    }
    // The order: photo ready → generating → no photo yet.
    const reqSnap = await db.ref(`${core.ROOT}/requests`).orderByKey().limitToFirst(core.INDEX_CEILING + 1).once("value");
    const requested = new Set(Object.keys(reqSnap.val() || {}));
    const buckets = await bucketsOf(db, matching, laneOf, requested);
    if (after && !buckets.has(after)) {
      // The cursor's item left this list since the last page (approved,
      // skipped, regrouped): place it by its bucket as it is now.
      const lane = laneOf.get(after) || await val(db, `${core.ITEMS}/${after}/status`);
      (await bucketsOf(db, [after], new Map([[after, lane]]), requested)).forEach((b, k) => buckets.set(k, b));
    }
    const cmp = core.bucketCmp((k) => buckets.get(k));
    matching = [...matching].sort(cmp);
    const rest = after ? matching.filter((k) => cmp(k, after) > 0) : matching;
    pageKeys = rest.slice(0, n);
    more = rest.length > n;
    total = matching.length;
  } else {
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
  }

  const items = (await inBatches(pageKeys, 10, async (pid) => {
    const item = await val(db, `${core.ITEMS}/${pid}`);
    const listedUnder = laneOf.get(pid) || statuses[0];
    const repair = core.indexRepair(pid, listedUnder, item);
    if (repair) await db.ref(core.ROOT).update(repair);
    if (!item || core.TAB_OF[item.status] !== tab) return null;
    const d = details.get(pid) || await productDetail(db, pid, locations);
    return { ...core.cardItem(item), product: d.summary, availableSizes: d.stock.availableSizes, totalUnits: d.stock.totalUnits, stockKnown: d.stock.stockKnown };
  })).filter(Boolean);

  const [stats, modes] = await Promise.all([val(db, `${core.ROOT}/stats`), val(db, `${core.ROOT}/config/mode`)]);
  const out = {
    tab, items, total, nextCursor: more && pageKeys.length ? pageKeys[pageKeys.length - 1] : null,
    tabCounts, stats: stats || null, modes: modes || {}, filter: f, group: g, groupCounts,
  };
  // Every pid the tab's multi-select can act on — the whole group (or
  // filtered lane), not just the loaded page ("Select all" then "Skip selected").
  if (tab === "new" || tab === "skipped") out.matchingPids = matching.filter((p) => selectable.has(p));
  return out;
}

const callableOpts = { region: "europe-west1", memory: "256MiB", timeoutSeconds: 120 };

const newArrivalsList = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  const d = request.data || {};
  return listTab(admin.database(), String(d.tab || "new"), { cursor: d.cursor || null, limit: d.limit, filter: d.filter || null, group: d.group || null });
});

// ── moves + the ledger ───────────────────────────────────────────────────────
/**
 * Move one item, then its index entry. `fields(cur)` builds the merge from the
 * item as it is; `guard(cur)` may refuse (a string) once the status is right.
 * Returns { item, prev } or { refusal }. `prev` is the item as Junid acted on
 * it — the decision row's generation snapshot comes from it.
 */
async function moveOne(db, pid, { from, to, at, fields = () => ({}), guard = null, decision = null, extra = null, uid = null }) {
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
  // ONE atomic multi-path write after the move: the index entry, Junid's
  // decision row and any request entry land together or not at all — and a
  // retry writes the very same paths (the decision key is fixed first).
  const paths = { ...core.indexMove(pid, out.from, to, item.enqueuedAt), ...(extra ? extra(prev) : {}) };
  if (decision) Object.assign(paths, await decisionPaths(db, pid, { at, uid, item: prev, ...decision(prev) }));
  await writeRoot(db, paths);
  return { item, prev };
}

// Junid's ledger row as a multi-path entry (decisions/{push}); the push key is
// fixed before the write, so a retry writes the very same path.
async function decisionPaths(db, pid, { at, uid, item, action, reason = null, genId = null }) {
  let categoryKey = item && item.categoryKey;
  if (!categoryKey) categoryKey = await val(db, `products/${pid}/categoryKey`);
  const key = db.ref(core.DECISIONS).push().key;
  return { [`decisions/${key}`]: core.decisionRecord({ pid, at, by: uid, action, reason, item, categoryKey, genId }) };
}
async function writeRoot(db, paths) {
  try { await db.ref(core.ROOT).update(paths); } catch { await db.ref(core.ROOT).update(paths); }
}

// ── pick any generation ──────────────────────────────────────────────────────
// "Use this one": items/{pid} keeps its lane (new, ready or rejected — never
// while a generate request is pending); currentGen,
// generatedUrl/Path, verdict and framingFlag follow the chosen generation
// (core.selectFields) — a transaction, so a concurrent Regenerate / Approve
// is never overwritten. Then ONE atomic multi-path write, as every move
// makes: the item's index entry (re-asserted) and the "pick" ledger row with
// the generation's snapshot. Approve then uses this photo.
async function select(db, { pid, genId }, uid, nowMs) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  if (!core.GEN_ID_RE.test(String(genId || ""))) throw new HttpsError("invalid-argument", "Not a generation id.");
  pid = String(pid); genId = String(genId);
  const out = {};
  let prev = null;
  const res = await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => {
    out.same = false;
    // Cold-cache null: commit nothing; the server's compare-and-retry supplies the item.
    if (!cur) { out.refusal = "not in the New Arrivals queue"; return null; }
    const why = core.selectRefusal(cur, genId);
    if (why) { out.refusal = why; return undefined; }
    out.refusal = null;
    prev = cur;
    if (cur.currentGen === genId && cur.generatedUrl === cur.generations[genId].url) { out.same = true; return undefined; }
    const next = { ...cur, ...core.selectFields(cur.generations[genId], genId, nowMs, cur) };
    for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
    return next;
  });
  if (out.same) return { ok: true, unchanged: true };
  const item = res && res.committed && res.snapshot && res.snapshot.val();
  if (!item || item.currentGen !== genId || out.refusal) throw new HttpsError("failed-precondition", `Can't use that photo — ${out.refusal || "not saved"}.`);
  await writeRoot(db, {
    ...core.indexMove(pid, item.status, item.status, item.enqueuedAt),
    ...await decisionPaths(db, pid, { at: nowMs, uid, item: prev, action: "pick", genId }),
  });
  return { ok: true };
}

const newArrivalsSelect = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return select(admin.database(), request.data || {}, request.auth?.uid, Date.now());
});

// ── love one generation ──────────────────────────────────────────────────────
// ❤ on any generation, in any lane where it exists: a transaction on
// items/{pid} sets generations/{genId}/loved + lovedAt (this server's clock);
// un-love removes both. The item never moves and nothing is approved. Then
// ONE atomic multi-path write: the index entry (re-asserted) and the
// "love" / "unlove" ledger row with the generation's snapshot. Loving what is
// already loved (or un-loving what is not) writes and logs nothing.
async function love(db, { pid, genId, loved }, uid, nowMs) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  if (!core.GEN_ID_RE.test(String(genId || ""))) throw new HttpsError("invalid-argument", "Not a generation id.");
  if (typeof loved !== "boolean") throw new HttpsError("invalid-argument", "Say loved: true or false.");
  pid = String(pid); genId = String(genId);
  const item = (await db.ref(`${core.ITEMS}/${pid}`).once("value")).val();
  const why = core.loveRefusal(item, genId);
  if (why) throw new HttpsError("failed-precondition", `Can't ${loved ? "love" : "un-love"} that photo — ${why}.`);
  if (!core.lovedItem(item, genId, loved, nowMs)) return { ok: true, unchanged: true };
  // ONE atomic multi-path write: the two love fields on that generation AND the
  // decision row land together or not at all (a love never moves the item, and
  // a generation is never removed, so no transaction is needed — and the lane
  // index is left alone).
  const at = `items/${pid}/generations/${genId}`;
  await writeRoot(db, {
    [`${at}/loved`]: loved ? true : null,
    [`${at}/lovedAt`]: loved ? nowMs : null,
    ...await decisionPaths(db, pid, { at: nowMs, uid, item, action: loved ? "love" : "unlove", genId }),
  });
  return { ok: true };
}

const newArrivalsLove = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return love(admin.database(), request.data || {}, request.auth?.uid, Date.now());
});

const MAX_PIDS = 300;
function pidList(pids) {
  const list = Array.isArray(pids) ? [...new Set(pids.map(String).filter((p) => core.PID_RE.test(p)))] : [];
  if (!list.length) throw new HttpsError("invalid-argument", "No items given.");
  if (list.length > MAX_PIDS) throw new HttpsError("invalid-argument", "Too many at once.");
  return list;
}

// ── approve ──────────────────────────────────────────────────────────────────
// APPROVE WHEREVER A PHOTO EXISTS (3 Oct night): new, ready or rejected →
// approved, for an item with a generated photo and no pending generate
// request. A stock price is required. Logged "approve-anyway" (with
// checkerWrong) when the photo's verdict failed or the lane was rejected,
// otherwise "approve" (core.approveAction). The old `anyway` flag is still
// accepted (it changes nothing now).
async function approve(db, { pids, all, genId }, uid, nowMs) {
  // ONE generation of one item may be named: THAT photo is approved (it
  // becomes the main one in the same transaction); none named = the main one.
  const pickGen = genId === undefined || genId === null ? null : String(genId);
  if (pickGen !== null) {
    if (!Array.isArray(pids) || pids.length !== 1) throw new HttpsError("invalid-argument", "A generation is approved one item at a time.");
    if (!core.GEN_ID_RE.test(pickGen)) throw new HttpsError("invalid-argument", "Not a generation id.");
  }
  let targets = [];
  if (all === true) {
    targets = Object.keys((await db.ref(`${core.BY_STATUS}/ready`).once("value")).val() || {});
  } else if (Array.isArray(pids)) {
    targets = pids.map(String).filter((p) => core.PID_RE.test(p));
  }
  if (!targets.length) throw new HttpsError("invalid-argument", "Nothing to approve.");
  if (targets.length > MAX_PIDS) throw new HttpsError("invalid-argument", "Too many at once.");
  const from = ["new", "ready", "rejected"];
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
      from, to: "approved", at: nowMs, uid,
      decision: (prev) => ({ action: core.approveAction(prev, pickGen), ...(pickGen ? { genId: pickGen } : {}) }),
      // Approve only what has a generated photo — never an original — and
      // never while a new photo is being generated (it would replace this one).
      guard: (cur) => {
        if (cur.generateRequest) return "a new photo is being generated — approve when it lands";
        if (!pickGen) return cur.generatedUrl ? null : "it has no generated photo";
        const g = cur.generations && cur.generations[pickGen];
        return g && typeof g === "object" && g.url ? null : "that generation has no photo on this item";
      },
      fields: (cur) => ({
        ...(pickGen && cur.currentGen !== pickGen ? core.selectFields(cur.generations[pickGen], pickGen, nowMs) : {}),
        approvedAt: nowMs, approvedBy: uid || "unknown",
        ...(cur.status === "rejected" ? { lastRejection: cur.rejection || null, rejection: null } : {}),
      }),
    });
    if (!r.item) { skipped.push({ pid, why: r.refusal }); continue; }
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
// puts the result on the same card (lane ready / rejected). From New
// (Generate), or — only with `regenerate` — from Ready or Rejected: a FRESH
// attempt from the original photo, never a fix-up edit. REGENERATE KEEPS THE
// PHOTOS VISIBLE (3 Oct night): generatedUrl/Path, currentGen, verdict and
// framingFlag stay (Approve and Use this one wait while the request is
// pending); the approval, chain, names and destinations are cleared. Every
// generation stays in `generations` (kept for ever).
const NEW_LAP = Object.freeze({
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
      from, to: "new", at: nowMs, uid,
      decision: (prev) => ({ action: prev.status === "new" && !prev.currentGen ? "generate" : "regenerate" }),
      // The poster reads ONLY this small index each minute (never a scan of New).
      // A stray entry (e.g. Skip racing Generate) is harmless: the poster takes a
      // request only for an item still in New WITH generateRequest, and clears
      // any other entry it finds.
      extra: () => ({ [`requests/${pid}`]: nowMs }),
      guard: (cur) => (cur.status === "new" && cur.generateRequest ? "already requested — the generator will take it" : null),
      fields: (cur) => {
        const fresh = cur.status === "new" && !cur.currentGen;
        return {
          generateRequest: { at: nowMs, by: uid || "unknown", ...(fresh ? {} : { regenerate: true }) },
          ...(fresh ? {} : { ...NEW_LAP, attemptsSinceRetry: 0, lastRejection: cur.rejection || cur.lastRejection || null }),
        };
      },
    });
    if (!r.item) { skipped.push({ pid, why: r.refusal }); return; }
    requested.push(pid);
  });
  return { requested, skipped };
}

const newArrivalsGenerate = onCall(callableOpts, async (request) => {
  await assertNewArrivalsAccess(request);
  return generate(admin.database(), request.data || {}, request.auth?.uid, Date.now());
});

// ── skip / restore ───────────────────────────────────────────────────────────
// Skip — don't advertise: new, ready or rejected → skipped. Never generated,
// posted or published; marked in the data (status "skipped", skippedFrom), never
// deleted. The card has no Skipped tab any more: Restore is its 8-second Undo,
// which puts the item back where it was (skippedFrom: its lane), in its
// place (the index value is its enqueuedAt; the order is the pid key).
// Nothing else moves it back (enqueue only repairs the index of an item
// already queued, whatever its status).
async function skip(db, { pids }, uid, nowMs) {
  const list = pidList(pids);
  const done = [];
  const skipped = [];
  await inBatches(list, 10, async (pid) => {
    const r = await moveOne(db, pid, {
      from: ["new", "ready", "rejected"], to: "skipped", at: nowMs, uid,
      decision: () => ({ action: "skip" }),
      extra: () => ({ [`requests/${pid}`]: null }),
      fields: (cur) => ({ skippedAt: nowMs, skippedBy: uid || "unknown", skippedFrom: cur.status, generateRequest: null }),
    });
    if (!r.item) { skipped.push({ pid, why: r.refusal }); return; }
    done.push(pid);
  });
  return { skippedPids: done, skipped };
}

async function restore(db, { pids }, uid, nowMs) {
  const list = pidList(pids);
  const done = [];
  const skipped = [];
  await inBatches(list, 10, async (pid) => {
    // Back to the lane it was skipped from (an older skip, with no
    // skippedFrom, came from New). The move itself still checks "skipped".
    const was = await val(db, `${core.ITEMS}/${pid}/skippedFrom`);
    const r = await moveOne(db, pid, {
      from: "skipped", to: was === "rejected" || was === "ready" ? was : "new", at: nowMs, uid,
      decision: () => ({ action: "restore" }),
      fields: () => ({ skippedAt: null, skippedBy: null, skippedFrom: null }),
    });
    if (!r.item) { skipped.push({ pid, why: r.refusal }); return; }
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
// Junid's reject-reason signal: ONE of the chips (no typing) on any item with
// a photo and no pending request → lane rejected. The item stays on the New
// tab, with its photos; Approve stays available (it then logs approve-anyway).
async function reject(db, { pid, reason }, uid, nowMs) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  if (!core.REJECT_CHIPS.includes(reason)) throw new HttpsError("invalid-argument", "Pick one of the reasons.");
  const r = await moveOne(db, String(pid), {
    from: ["new", "ready", "rejected"], to: "rejected", at: nowMs, uid,
    guard: (cur) => (cur.generateRequest ? "a new photo is being generated" : cur.generatedUrl ? null : "it has no generated photo"),
    decision: () => ({ action: "reject", reason }),
    fields: () => ({ rejection: { code: "junid", reason, at: nowMs } }),
  });
  if (!r.item) throw new HttpsError("failed-precondition", `Can't reject — ${r.refusal}.`);
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
  newArrivalsGenerate, newArrivalsSkip, newArrivalsRestore, newArrivalsReject, newArrivalsSelect, newArrivalsLove,
  // for tests
  _internals: { enqueue, listTab, approve, retry, generate, skip, restore, reject, select, love, assertNewArrivalsAccess },
};
