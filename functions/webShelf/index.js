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
const { writeDownSingle, restoreFound } = require("../lib/web-writedown.cjs");
const { DIRTY_PATH, CONCRETE_DIRTY_PATH } = require("../lib/shopify-inventory-dirty.cjs");

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
  return { id, pid: item.pid, sizeKey: item.sizeKey, size: item.sizeKey === "_" ? null : String(item.sizeKey).replace(/_/g, "."), shown: Number(item.shown), why: item.why, lastMoved: item.lastMoved ?? null, addedDay: item.addedDay || null, name: name || item.pid, photoUrl: photoUrl || null, barcode: barcodeOfSize || barcode || null };
}

async function listFor(db, loc, nowMs) {
  const cfg = L.configFrom(await val(db, L.SHELF_CONFIG_PATH));
  const saDate = saDateStringFromMs(nowMs);
  const open = cfg.on ? (await val(db, `${L.SHELF_CHECKS_PATH}/${loc}/open`)) || {} : {};
  // "wrong by more than one" first, then the oldest single pieces; never more than the day's number on screen.
  const ids = Object.keys(open).sort((a, b) => (open[a].why === open[b].why ? (Number(open[a].lastMoved) || 0) - (Number(open[b].lastMoved) || 0) : open[a].why === L.WHY.MORE ? -1 : 1)).slice(0, cfg.perDay);
  const checks = (await Promise.all(ids.map((id) => showItem(db, loc, id, open[id])))).filter(Boolean);
  const today = (await val(db, `${L.SHELF_CHECKS_PATH}/${loc}/days/${saDate}`)) || {};
  let webRows = [];
  if (loc === "central") {
    const active = (await val(db, "displayChecks_active/central")) || {};
    webRows = Object.entries(active).filter(([, r]) => r && r.status === "open" && (r.kind === "online_pick" || r.kind === "online_return"))
      .map(([key, r]) => ({ key, checkId: r.checkId, kind: r.kind, productId: r.productId, productName: r.productName, size: r.size, qty: r.qty || 1, orderNumber: r.orderNumber ?? null, ref: r.ref || null, photoUrl: r.photoUrl || null, checkProperly: r.checkProperly === true, createdAt: r.createdAt || r.activatedAt || null }))
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  }
  return { ok: true, loc, saDate, webRows, checks, today: { found: Number(today.found) || 0, notFound: Number(today.notFound) || 0, counted: Number(today.counted) || 0, corrected: Number(today.corrected) || 0, listed: Number(today.listed) || 0 }, left: Object.keys(open).length };
}

exports.webShelfList = onCall({ region: "europe-west1", timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const c = await caller(request);
  const loc = request.data && request.data.loc;
  if (!L.shelfAccess({ isSuper: c.isSuper, perms: c.perms, loc })) throw new HttpsError("permission-denied", "You can't work this place's list.");
  return listFor(c.db, loc, Date.now());
});

exports.webShelfAnswer = onCall({ region: "europe-west1", timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const c = await caller(request);
  const { loc, id, result, count } = request.data || {};
  if (!L.shelfAccess({ isSuper: c.isSuper, perms: c.perms, loc })) throw new HttpsError("permission-denied", "You can't work this place's list.");
  if (typeof id !== "string" || !id || /[.#$[\]/]/.test(id)) throw new HttpsError("invalid-argument", "id is required.");
  const out = await runAnswer(c.db, { loc, id, result, count, uid: c.uid, name: c.name, nowMs: Date.now() });
  if (out.error) return { ok: false, reason: out.error, ...(await listFor(c.db, loc, Date.now())) };
  return { ...(await listFor(c.db, loc, Date.now())), answered: out.outcome };
});

/** The answer itself; exported for the tests. → { outcome } | { error } */
async function runAnswer(db, { loc, id, result, count, uid, name, nowMs }) {
  const openPath = `${L.SHELF_CHECKS_PATH}/${loc}/open/${id}`;
  const item = await val(db, openPath);
  if (!item) return { error: "gone" };
  const cellPath = `stock/${loc}/${item.pid}/${item.sizeKey}`;
  const cell = await val(db, cellPath);
  const plan = L.answerPlan({ item, cell, result, count });
  if (plan.error) { if (plan.error === "stale") await db.ref(openPath).remove(); return { error: plan.error }; }
  const nowIso = new Date(nowMs).toISOString();
  const saDate = saDateStringFromMs(nowMs);
  const shown = Number(item.shown);
  if (plan.kind === "write_down") {
    const res = await writeDownSingle(db, { pid: item.pid, sizeKey: item.sizeKey, size: item.sizeKey, loc, kind: "shelf_check_not_found", by: uid, at: nowMs, idTag: `check_${loc}_${id}_${saDate}` }, { nowIso });
    if (!res.ok) return { error: res.reason || "not_written" };
    if (!res.wroteDown) { await db.ref(openPath).remove(); return { error: "stale" }; }
  } else if (plan.kind === "adjust") {
    const res = await applyMovementAdmin(db, {
      type: "adjustment", productId: item.pid, size: item.sizeKey, sizeKey: item.sizeKey, qty: Math.abs(plan.delta), ...(plan.delta < 0 ? { from: loc } : { to: loc }), expectQty: shown,
      movementId: `shelf_check_${loc}_${id}_${saDate}`.replace(/[.#$/\[\]\s]/g, "_"), actor: uid, actorRole: "admin",
      reason: `shelf check: counted ${Number(count)}, the app showed ${shown}`, link: {},
    }, { nowIso });
    if (!res.ok) { if (res.reason === "cell_changed") { await db.ref(openPath).remove(); return { error: "stale" }; } return { error: res.reason || "not_written" }; }
  } else {
    // Found / counted right: the shelf has been looked at by a person. Only if it still is the shelf that was listed.
    const touched = await db.ref(cellPath).transaction((cur) => {
      if (cur == null) return null; // the cold-cache pass (never abort on it); a shelf truly gone commits nothing and reads as stale below
      if (L.cellQty(cur) !== shown) return undefined;
      return { ...(typeof cur === "object" ? cur : { qty: Number(cur) || 0 }), updatedAt: nowIso, checkedAt: nowIso, checkedBy: uid };
    });
    if (!touched.committed || !touched.snapshot.val()) { await db.ref(openPath).remove(); return { error: "stale" }; }
    await restoreFound(db, { pid: item.pid, sizeKey: item.sizeKey, loc, why: "found_on_check", by: uid }, { nowIso });
  }
  // The shelf has been settled by a person: a hold on it from an older rejection ends here.
  await db.ref(`${CELL_HOLDS_PATH}/${item.pid}/${item.sizeKey}/${loc}`).transaction((cur) => (cur == null ? null : Number(cur.at) <= nowMs ? null : undefined));
  await markDirty(db, item.pid);
  await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/done/${saDate}/${id}`).set({ result: plan.outcome, shown, ...(result === "count" ? { counted: Number(count) } : {}), by: uid, byName: name || null, at: nowMs, why: item.why || null });
  await db.ref(openPath).remove();
  await db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/days/${saDate}/${plan.outcome}`).transaction((n) => (Number(n) || 0) + 1);
  return { outcome: plan.outcome };
}
exports._runAnswer = runAnswer;

exports.webShelfProgress = onCall({ region: "europe-west1", timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const c = await caller(request);
  if (!c.isSuper) throw new HttpsError("permission-denied", "Junid and Jafer only.");
  const places = [];
  for (const loc of L.CHECK_LOCATIONS) {
    const [days, open] = await Promise.all([
      c.db.ref(`${L.SHELF_CHECKS_PATH}/${loc}/days`).orderByKey().limitToLast(14).get().then((s) => s.val()),
      val(c.db, `${L.SHELF_CHECKS_PATH}/${loc}/open`),
    ]);
    const more = Object.values(open || {}).filter((o) => o && o.why === L.WHY.MORE).length;
    places.push({ loc, ...L.progressOf(days, open), wrongByMoreOpen: more });
  }
  return { ok: true, perDay: L.configFrom(await val(c.db, L.SHELF_CONFIG_PATH)).perDay, places };
});
