// ─── SHELF CHECKS + CENTRAL'S WEBSITE STRIP — the callables ──────────────────
// Junid, 24 Nov 2026. lib.cjs has the rules; this is the IO.
//
//   webShelfList     { loc } → { webRows, checks, today }   what one place's screen shows
//   webShelfAnswer   { loc, id, result, count? }            Found / Not found / the number tapped
//   webShelfProgress {}      → per-place progress           Junid and Jafer only
//
// `webRows` is Central's website-orders strip (kind online_pick entries the
// poller wrote at /displayChecks_active/central); they are ANSWERED through
// the existing completeDisplayCheck, exactly like a shop's strip.
//
// WHAT AN ANSWER WRITES
//   found               the shelf is stamped touched (updatedAt + checkedAt; the
//                       count is not changed), a standing shelf hold is lifted,
//                       and a write-down still open on it is undone
//   not found (single)  the single-piece write-down (functions/lib/web-writedown.cjs)
//   a number (several)  an `adjustment` to that number, reason "shelf check"
// Nothing here reads or writes a policy, a target or a request.
//   firebase deploy --only functions:webShelfList,functions:webShelfAnswer,functions:webShelfProgress
"use strict";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const L = require("./lib.cjs");
const { isSuperAdmin } = require("../lib/super-admins.cjs");
const { saDateStringFromMs } = require("../lib/sa-time.cjs");
const { applyMovementAdmin } = require("../lib/admin-movement.cjs");
const { writeDownSingle, restoreFound, WRITEDOWNS_PATH } = require("../lib/web-writedown.cjs");
const { readOnTheWay } = require("../lib/on-the-way.cjs");
const { DIRTY_PATH, CONCRETE_DIRTY_PATH } = require("../lib/shopify-inventory-dirty.cjs");
const { readAccountSections, locationInSections } = require("../lib/section-access.cjs");
const { loadNetwork } = require("../lib/network-load.cjs");

// A person works only the places in the sections their account may act in (the Warehouse screen filters hubs the
// same way; this is the server's own check). Central is reachable from every section.
async function inMySection(c, loc) {
  if (c.isSuper) return true;
  const network = await loadNetwork(c.db);
  return locationInSections(network, await readAccountSections(c.db, network, c.uid, { isOwner: false }), loc);
}

const CELL_HOLDS_PATH = "online_cell_holds";
const val = async (db, path) => (await db.ref(path).get()).val();

async function caller(request) {
  const provider = request.auth && request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  if (!request.auth || provider === "anonymous") throw new HttpsError("unauthenticated", "Sign-in required.");
  const db = admin.database();
  const uid = request.auth.uid;
  const email = (request.auth.token && request.auth.token.email) || null;
  const userRec = (await val(db, `users/${uid}`)) || {};
  const isSuper = isSuperAdmin(email) && request.auth.token.email_verified === true;
  return { db, uid, email, userRec, isSuper, perms: Array.isArray(userRec.permissions) ? userRec.permissions : [], name: userRec.displayName || userRec.username || (email ? email.split("@")[0] : "staff") };
}

async function markDirty(db, pid) {
  for (const node of [DIRTY_PATH, CONCRETE_DIRTY_PATH]) {
    try { await db.ref(`${node}/${pid}`).set(admin.database.ServerValue.increment(1)); } catch (e) { console.warn(`shelf check: ${node}/${pid} not marked (${e && e.message})`); }
  }
}

/** One open item with what the screen needs to show it; null (and removed) when its shelf moved since. */
async function showItem(db, loc, id, item) {
  const cell = await val(db, `stock/${loc}/${item.pid}/${item.sizeKey}`);
  if (L.itemStale(item, cell)) { await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/open/${id}`).remove(); return null; }
  const [name, photoUrl, barcodeOfSize, barcode] = await Promise.all([
    val(db, `products/${item.pid}/name`), val(db, `products/${item.pid}/photoUrl`),
    val(db, `products/${item.pid}/barcodes/${item.sizeKey}`), val(db, `products/${item.pid}/barcode`),
  ]);
  return { id, pid: item.pid, sizeKey: item.sizeKey, size: item.sizeKey === "_" ? null : String(item.sizeKey).replace(/_/g, "."), shown: Number(item.shown), why: item.why, lastMoved: item.lastMoved ?? null, at: item.at ?? null, addedDay: item.addedDay || null, ref: item.ref || null, src: item.src || null, confirm: item.why === L.WHY.WEB && !!item.mvId, name: name || item.pid, photoUrl: photoUrl || null, barcode: barcodeOfSize || barcode || null };
}

async function listFor(db, loc, nowMs) {
  const cfg = L.configFrom(await val(db, L.SHELF_CONFIG_PATH));
  const saDate = saDateStringFromMs(nowMs);
  // A shop's list shows only once Junid has turned that shop on (/config/onlineOrders/shelfChecks/shops/<loc>/on).
  const on = L.placeOn(cfg, loc);
  const open = on ? (await val(db, `${L.SHELF_CHECKS_PATH}/${loc}/open`)) || {} : {};
  // In the day's order (website rejections, other rejections, wrong by more, not selling, old single pieces), oldest
  // first inside each; never more than the day's number on screen.
  const sortAt = (it) => (Number.isFinite(Number(it.at)) ? Number(it.at) : Number(it.lastMoved) || 0);
  const ids = Object.keys(open).sort((a, b) => L.rankOf(open[a].why) - L.rankOf(open[b].why) || sortAt(open[a]) - sortAt(open[b])).slice(0, L.perDayFor(cfg, loc));
  const checks = (await Promise.all(ids.map((id) => showItem(db, loc, id, open[id])))).filter(Boolean);
  const today = (await val(db, `${L.SHELF_CHECKS_PATH}/${loc}/days/${saDate}`)) || {};
  let webRows = [];
  if (loc === "central") {
    const active = (await val(db, "displayChecks_active/central")) || {};
    webRows = Object.entries(active).filter(([, r]) => r && r.status === "open" && (r.kind === "online_pick" || r.kind === "online_return"))
      .map(([key, r]) => ({ key, checkId: r.checkId, kind: r.kind, productId: r.productId, productName: r.productName, size: r.size, qty: r.qty || 1, orderNumber: r.orderNumber ?? null, ref: r.ref || null, photoUrl: r.photoUrl || null, checkProperly: r.checkProperly === true, createdAt: r.createdAt || r.activatedAt || null }))
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  }
  return { ok: true, loc, saDate, on, webRows, checks, today: { found: Number(today.found) || 0, notFound: Number(today.notFound) || 0, counted: Number(today.counted) || 0, corrected: Number(today.corrected) || 0, listed: Number(today.listed) || 0, units: Number(today.units) || 0 }, left: Object.keys(open).length };
}

exports.webShelfList = onCall({ region: "europe-west1", timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const c = await caller(request);
  const loc = request.data && request.data.loc;
  if (!L.shelfAccess({ isSuper: c.isSuper, perms: c.perms, loc }) || !(await inMySection(c, loc))) throw new HttpsError("permission-denied", "You can't work this place's list.");
  return listFor(c.db, loc, Date.now());
});

exports.webShelfAnswer = onCall({ region: "europe-west1", timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const c = await caller(request);
  const { loc, id, result, count } = request.data || {};
  if (!L.shelfAccess({ isSuper: c.isSuper, perms: c.perms, loc }) || !(await inMySection(c, loc))) throw new HttpsError("permission-denied", "You can't work this place's list.");
  if (typeof id !== "string" || !id || /[.#$[\]/]/.test(id)) throw new HttpsError("invalid-argument", "id is required.");
  const out = await runAnswer(c.db, { loc, id, result, count, uid: c.uid, name: c.name, nowMs: Date.now() });
  if (out.error) return { ...(await listFor(c.db, loc, Date.now())), ok: false, reason: out.error };
  return { ...(await listFor(c.db, loc, Date.now())), answered: out.outcome };
});

/** The answer itself; exported for the tests. → { outcome } | { error } */
async function runAnswer(db, { loc, id, result, count, uid, name, nowMs }) {
  const openPath = `${L.SHELF_CHECKS_PATH}/${loc}/open/${id}`;
  const item = await val(db, openPath);
  if (!item) return { error: "gone" };
  const cellPath = `stock/${loc}/${item.pid}/${item.sizeKey}`;
  const cell = await val(db, cellPath);
  // Stock sent here that has not landed yet: a person counts only what is ON the shelf (functions/lib/on-the-way.cjs).
  const otw = (await readOnTheWay(db, { loc, pid: item.pid, sizeKey: item.sizeKey, cell, nowMs })).qty;
  const plan = L.answerPlan({ item, cell, result, count, onTheWay: otw });
  if (plan.error) { if (plan.error === "stale") await db.ref(openPath).remove(); return { error: plan.error }; }
  const nowIso = new Date(nowMs).toISOString();
  const saDate = saDateStringFromMs(nowMs);
  const shown = Number(item.shown);
  let unitsCorrected = 0;
  if (plan.kind === "write_down") {
    const res = await writeDownSingle(db, { pid: item.pid, sizeKey: item.sizeKey, size: item.sizeKey, loc, kind: "shelf_check_not_found", by: uid, at: nowMs, idTag: `check_${loc}_${id}_${saDate}`, onTheWay: otw }, { nowIso });
    if (!res.ok) return { error: res.reason || "not_written" };
    if (!res.wroteDown) { await db.ref(openPath).remove(); return { error: "stale" }; }
    unitsCorrected = 1;
  } else if (plan.kind === "adjust") {
    const res = await applyMovementAdmin(db, {
      type: "adjustment", productId: item.pid, size: item.sizeKey, sizeKey: item.sizeKey, qty: Math.abs(plan.delta), ...(plan.delta < 0 ? { from: loc } : { to: loc }), expectQty: shown,
      movementId: `shelf_check_${loc}_${id}_${saDate}`.replace(/[.#$/\[\]\s]/g, "_"), actor: uid, actorRole: "admin",
      reason: otw > 0
        ? `shelf check: counted ${Number(count)} + ${otw} on the way = ${plan.target}, the app showed ${shown}`
        : `shelf check: counted ${Number(count)}, the app showed ${shown}`, link: {},
    }, { nowIso });
    if (!res.ok) { if (res.reason === "cell_changed") { await db.ref(openPath).remove(); return { error: "stale" }; } return { error: res.reason || "not_written" }; }
    unitsCorrected = Math.abs(plan.delta);
  } else if (plan.kind === "restore") {
    // A website write-down, and the piece is there after all: put it back (only the write-down this item was listed for).
    const r = await restoreFound(db, { pid: item.pid, sizeKey: item.sizeKey, loc, why: "found_on_check", by: uid, expectMvId: item.mvId || undefined }, { nowIso });
    if (!r.ok) return { error: r.reason || "not_written" };
    if (!r.restored) { await db.ref(openPath).remove(); return { error: "stale" }; }
    unitsCorrected = 1;
  } else {
    // Found / counted right: the shelf has been looked at by a person. Only if it still is the shelf that was listed.
    const touched = await db.ref(cellPath).transaction((cur) => {
      if (cur == null) return null; // the cold-cache pass (never abort on it); a shelf truly gone commits nothing and reads as stale below
      if (L.cellQty(cur) !== shown) return undefined;
      return { ...(typeof cur === "object" ? cur : { qty: Number(cur) || 0 }), updatedAt: nowIso, checkedAt: nowIso, checkedBy: uid };
    });
    if (!touched.committed || !touched.snapshot.val()) { await db.ref(openPath).remove(); return { error: "stale" }; }
    // Found on a shelf that shows nothing that should be there (a write-down left it at what is on the way): the
    // piece the write-down took is back, so it is undone. Any other agreeing answer — a count equal to what the shelf
    // shows — already includes every piece: nothing is added, and an open write-down on it is simply settled.
    if (result === "found" && shown - otw <= 0) await restoreFound(db, { pid: item.pid, sizeKey: item.sizeKey, loc, why: "found_on_check", by: uid }, { nowIso });
    else if (plan.outcome !== "notFound") await db.ref(`${WRITEDOWNS_PATH}/${item.pid}/${item.sizeKey}/${loc}`).remove();
  }
  // The shelf has been settled by a person: a hold on it from an older rejection ends here.
  await db.ref(`${CELL_HOLDS_PATH}/${item.pid}/${item.sizeKey}/${loc}`).transaction((cur) => (cur == null ? null : Number(cur.at) <= nowMs ? null : undefined));
  await markDirty(db, item.pid);
  await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/done/${saDate}/${id}`).set(L.doneRow({ item, plan, result, count, otw, uid, name, nowMs, unitsCorrected }));
  // When this shelf was last settled by a person: it is not asked again for the recheck window unless a NEW rejection arrives.
  await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/checked/${id}`).set(nowMs);
  await db.ref(openPath).remove();
  await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/days/${saDate}`).transaction((d) => L.bumpDay(d, { outcome: plan.outcome, why: item.why, units: unitsCorrected }));
  return { outcome: plan.outcome, unitsCorrected };
}
exports._runAnswer = runAnswer;

exports.webShelfProgress = onCall({ region: "europe-west1", timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const c = await caller(request);
  if (!c.isSuper) throw new HttpsError("permission-denied", "Junid and Jafer only.");
  const cfg = L.configFrom(await val(c.db, L.SHELF_CONFIG_PATH));
  const places = [];
  for (const loc of L.CHECK_LOCATIONS) {
    // Eight weeks of day counters (a few hundred bytes each), so the counts can be seen healing week by week.
    const [days, open] = await Promise.all([
      c.db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/days`).orderByKey().limitToLast(56).get().then((s) => s.val()),
      val(c.db, `${L.SHELF_CHECKS_PATH}/${loc}/open`),
    ]);
    const more = Object.values(open || {}).filter((o) => o && o.why === L.WHY.MORE).length;
    places.push({ loc, on: L.placeOn(cfg, loc), perDay: L.perDayFor(cfg, loc), ...L.progressOf(days, open), wrongByMoreOpen: more });
  }
  return { ok: true, saDate: saDateStringFromMs(Date.now()), perDay: cfg.perDay, places };
});
