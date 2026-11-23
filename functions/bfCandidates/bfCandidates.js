// ─── BF CANDIDATES — the card's callables and the expiry job (Junid, 23 Nov 2026) ──
// bfSaleList      the card: candidates (one tab, one page), counts, what is on sale. Junid only.
// bfSaleSet       one tap: sale (ONE price, several products), extend, end, remove ("Not for
//                 sale"), restore, removed (the undo list), photo (which photo posts). Junid only. Nothing changes price,
//                 alerts a store or queues a post without this tap.
// bfSaleStoreList the staff re-tag list: what is on sale at each location (any signed-in staff).
// bfSaleExpire    every 10 minutes: a sale past its end is closed — its till mirror removed
//                 (the till already stopped charging it at the end time by itself), the record
//                 moved to ended/, the stores told. The base prices were never touched, so
//                 "revert" is only the removal of the sale.
//
// ADDITIVE: sales live on bf_sales_2026/sales/{pid}; the only write to a product is the
// additive field products/{pid}/bfSale = { price, start, end } that the till reads with the
// product it already loads. stockPrice / retailPrice are never written. IN-STORE ONLY:
// nothing here reads or writes Shopify.
//
// Server-only node (no database rule): the Admin SDK behind the super-admin gate.
// Deploy BY NAME (functions are shared with marathon-pos-app):
//   firebase deploy --only functions:bfSaleList,functions:bfSaleSet,functions:bfSaleStoreList,functions:bfSaleExpire
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const core = require("./core.cjs");
const { sendStoreAlerts } = require("./alerts.cjs");
const { isSuperAdminToken } = require("../lib/super-admins.cjs");
const { loadNetwork } = require("../lib/network-load.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}
const callableOpts = { region: "europe-west1", memory: "512MiB", timeoutSeconds: 300, invoker: "public" };
const R = core.ROOT;

function assertJunid(request) {
  if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The BF Candidates card is Junid's.");
}
/** Staff only: Junid, or an account with a staff record (/users/{uid}/role — one leaf, never the record). */
async function assertStaff(db, request) {
  const t = request.auth && request.auth.token;
  if (!t || (t.firebase && t.firebase.sign_in_provider === "anonymous")) throw new HttpsError("unauthenticated", "Sign in first.");
  if (isSuperAdminToken(t)) return;
  const role = await db.ref(`users/${request.auth.uid}/role`).once("value").then((s) => s.val()).catch(() => null);
  if (!role) throw new HttpsError("permission-denied", "The re-tag list is for staff.");
}
const val = async (db, path) => (await db.ref(path).once("value")).val();
async function inBatches(xs, width, fn) {
  const out = [];
  for (let i = 0; i < xs.length; i += width) out.push(...await Promise.all(xs.slice(i, i + width).map(fn)));
  return out;
}
function pidsOf(data) {
  const pids = [...new Set(Array.isArray(data && data.pids) ? data.pids : [])];
  if (!pids.length || pids.length > core.MAX_PIDS || !pids.every((p) => typeof p === "string" && core.PID_RE.test(p))) throw new HttpsError("invalid-argument", `Choose 1 to ${core.MAX_PIDS} products.`);
  return pids;
}

/** The locations that can hold stock (registry ids, not retired, not in transit) with their names. */
async function locations(db) {
  const reg = await loadNetwork(db);
  return Object.values(reg.locations || {}).filter((l) => l && l.retired !== true).map((l) => ({ id: l.id, name: l.name, type: l.type }));
}
/** One product's on hand per location now: { loc: qty } (per-product reads of /stock/{loc}/{pid}). */
async function stockOf(db, pid, locs) {
  const rows = await Promise.all(locs.map((l) => val(db, `stock/${l.id}/${pid}`)));
  const out = {};
  rows.forEach((cells, i) => {
    let n = 0;
    for (const c of Object.values(cells || {})) n += Number(c !== null && typeof c === "object" ? c.qty : c) || 0;
    if (n > 0) out[locs[i].id] = n;
  });
  return out;
}
/** The product now: the five fields a sale needs, read one by one (never the whole record). */
async function productNow(db, pid) {
  const f = ["name", "stockPrice", "retailPrice", "photoUrl", "categoryKey", "mergedInto"];
  const v = await Promise.all(f.map((k) => val(db, `products/${pid}/${k}`)));
  return Object.fromEntries(f.map((k, i) => [k, v[i]]));
}

/** Tells each holding location once (several products of one tap = one notification per store). Never throws. */
async function alertStores(db, type, entries, nowMs) {
  // entries: [{ pid, name, sale }]
  try {
    const locs = (await locations(db)).filter((l) => l.type === "store" || l.type === "hub");
    const held = await inBatches(entries, 20, (e) => stockOf(db, e.pid, locs));
    const byLoc = {};
    entries.forEach((e, i) => { for (const loc of core.holders(held[i])) (byLoc[loc] ||= []).push(e); });
    const msgs = Object.fromEntries(Object.entries(byLoc).map(([loc, es]) => [loc, core.alertBurst(type, es.map((e) => e.name), es[0].sale)]));
    const sent = await sendStoreAlerts({ db, messaging: admin.messaging(), nowMs }, msgs);
    const stores = Object.fromEntries(Object.entries(byLoc).map(([loc, es]) => [loc, { n: es.length, ...(sent[loc] || {}) }]));
    await db.ref(`${R}/alerts`).push({ at: nowMs, type, products: entries.length, stores });
    return stores;
  } catch (e) {
    console.error("BF_SALE_ALERT failed (the sale itself is saved):", e && e.message);
    return { error: String((e && e.message) || e).slice(0, 160) };
  }
}

// ── the taps ─────────────────────────────────────────────────────────────────
async function putOnSale(db, data, uid, nowMs) {
  const pids = pidsOf(data);
  const price = core.parsePrice(data.price);
  if (price === null) throw new HttpsError("invalid-argument", "Enter the sale price in rands.");
  const end = core.saleEnd(data.endDay || null, nowMs);
  if (!end) throw new HttpsError("invalid-argument", "The sale's end date must be today or later.");
  const [rows, chosen, removed, live] = await Promise.all([
    inBatches(pids, 25, (p) => val(db, `${R}/candidates/items/${p}`)),
    inBatches(pids, 25, (p) => val(db, `${R}/photos/${p}`)),
    inBatches(pids, 25, (p) => val(db, `${R}/removed/${p}`)),
    inBatches(pids, 25, (p) => productNow(db, p)),
  ]);
  const ok = [], refused = [];
  pids.forEach((pid, i) => {
    const p = live[i];
    if (!p || (!p.name && !p.stockPrice) || p.mergedInto) { refused.push({ pid, refusal: "no longer in the catalogue" }); return; }
    if (removed[i]) { refused.push({ pid, refusal: "marked Not for sale" }); return; }
    // The prices are the product's own, read now (the list is a night old); the list supplies kind and photo.
    const row = { ...(rows[i] || { kind: core.kindOfCat(p.categoryKey) }), pid, name: p.name || (rows[i] && rows[i].name) || pid, stockPrice: p.stockPrice, retailPrice: p.retailPrice, cat: p.categoryKey || (rows[i] && rows[i].cat) || null, photo: (rows[i] && rows[i].photo) || p.photoUrl || null };
    ok.push({ pid, row, photo: core.photoOf(row, chosen[i]) });
  });
  // The warning comes BEFORE anything is saved: a sale price at or above the stock price means resellers pay more than usual.
  const above = core.aboveStock(ok.map((x) => x.row), price);
  // The confirmation is OF the products the warning showed: one that came to need it since is warned about first.
  const confirmed = new Set(Array.isArray(data.confirmAbove) ? data.confirmAbove : []);
  if (above.some((a) => !confirmed.has(a.pid))) return { ok: false, needConfirm: above, price, refused };
  if (!ok.length) return { ok: false, refused, done: [] };
  const upd = {};
  const entries = [];
  // "Change price" on a product already on sale: the sale it replaces is kept on record (ended/), never lost.
  const before = await inBatches(ok.map((x) => x.pid), 25, (p) => val(db, `${R}/sales/${p}`));
  ok.forEach((x, i) => { const old = before[i]; if (old && Number(old.setAt) && Number(old.setAt) !== nowMs) upd[`${R}/ended/${x.pid}/${Number(old.setAt)}`] = { ...old, endedAt: nowMs, endedBy: uid, why: "replaced" }; });
  for (const x of ok) {
    const rec = core.saleRecord({ row: x.row, price, start: nowMs, end, uid, photo: x.photo });
    upd[`${R}/sales/${x.pid}`] = rec;
    upd[`products/${x.pid}/bfSale`] = core.tillMirror(rec);
    entries.push({ pid: x.pid, name: rec.name, sale: rec });
  }
  upd[`${R}/log/${db.ref(`${R}/log`).push().key}`] = { at: nowMs, by: uid, action: "sale", price, end, pids: ok.map((x) => x.pid), ...(above.length ? { aboveStock: above.map((a) => a.pid) } : {}) };
  await db.ref().update(upd);
  // Marked Not for sale in this same instant: the sale does not stand.
  const gone = await inBatches(ok.map((x) => x.pid), 25, (p) => val(db, `${R}/removed/${p}`));
  const late = ok.filter((_, i) => gone[i]).map((x) => [x.pid, null]);
  if (late.length) await closeSales(db, late, { uid, why: "not_for_sale", nowMs });
  const stores = await alertStores(db, "start", entries.filter((e) => !late.some(([p]) => p === e.pid)), nowMs);
  return { ok: true, done: ok.map((x) => x.pid), refused, price, end, until: core.endLabel(end), stores };
}

/** The till's mirror is always made from the sale as it IS (never from a value read earlier): gone when there is no sale. */
async function syncMirror(db, pid) {
  const s = await val(db, `${R}/sales/${pid}`);
  await db.ref(`products/${pid}/bfSale`).set(s && Number(s.salePrice) > 0 && Number(s.end) > 0 ? core.tillMirror(s) : null);
}

/** The sales a tap names: its pids, or every active sale (all: true). → [[pid, sale]] */
async function salesFor(db, data, nowMs) {
  if (data.all === true) return Object.entries((await val(db, `${R}/sales`)) || {}).filter(([, s]) => core.saleActive(s, nowMs));
  const pids = pidsOf(data);
  const got = await inBatches(pids, 25, (p) => val(db, `${R}/sales/${p}`));
  return pids.map((p, i) => [p, got[i]]).filter(([, s]) => core.saleActive(s, nowMs));
}

async function extend(db, data, uid, nowMs) {
  const end = core.saleEnd(data.endDay, nowMs);
  if (!end) throw new HttpsError("invalid-argument", "Pick a new end date, today or later.");
  // Extend only ever moves the end LATER (an earlier date would be an "extended" alert for a shortened sale).
  const named = await salesFor(db, data, nowMs);
  const list = named.filter(([, s]) => Number(s.end) < end);
  const done = [], entries = [];
  for (const [pid] of list) {
    // One transaction per sale: a sale ended (or expired) between the read and this write is NOT brought back
    // as a half record, and the till's mirror is only ever written from the record that was really saved.
    const t = await db.ref(`${R}/sales/${pid}`).transaction((cur) => {
      if (cur === null) return null;
      if (!core.saleActive(cur, nowMs) || !(Number(cur.end) < end)) return undefined;
      return { ...cur, end, extendedAt: nowMs, extendedBy: uid, prevEnd: cur.end };
    });
    const next = t.committed ? t.snapshot.val() : null;
    if (!next || Number(next.end) !== end) continue;
    await syncMirror(db, pid);
    done.push(pid);
    entries.push({ pid, name: next.name, sale: next });
  }
  if (!done.length) return { ok: true, done: [], end, until: core.endLabel(end), notLater: named.length - list.length };
  await db.ref(`${R}/log`).push({ at: nowMs, by: uid, action: "extend", end, pids: done });
  const stores = await alertStores(db, "extend", entries, nowMs);
  return { ok: true, done, end, until: core.endLabel(end), notLater: named.length - list.length, stores };
}

/** Closes sales: the till mirror goes, the record moves to ended/{pid}/{setAt}. The base prices were never changed. */
async function closeSales(db, list, { uid = null, why, nowMs }) {
  const done = [], entries = [];
  for (const [pid, seen] of list) {
    // One transaction per sale: only the sale that was read is closed. A sale Junid set again (or extended) in the
    // meantime is left alone — the expiry job never wipes a sale that is running.
    let closed = null;
    const t = await db.ref(`${R}/sales/${pid}`).transaction((cur) => {
      closed = null;
      if (cur === null) return null;
      if (seen && Number(cur.setAt) !== Number(seen.setAt)) return undefined;
      if (why === "expired" && Number(cur.end) > nowMs) return undefined;
      closed = cur;
      return null;
    });
    if (!t.committed || !closed) continue;
    await db.ref(`${R}/ended/${pid}/${Number(closed.setAt) || nowMs}`).set({ ...closed, endedAt: nowMs, endedBy: uid, why });
    await syncMirror(db, pid); // a sale Junid set again in this instant keeps its mirror
    done.push(pid);
    entries.push({ pid, name: closed.name, sale: closed });
  }
  if (!done.length) return { done: [] };
  await db.ref(`${R}/log`).push({ at: nowMs, by: uid, action: why, pids: done });
  const stores = await alertStores(db, "end", entries, nowMs);
  return { done, stores };
}

/** "Not for sale": off the candidates list for good (the nightly finder skips it). A sale on it is closed first. */
async function remove(db, data, uid, nowMs) {
  const pids = pidsOf(data);
  const [rows, sales] = await Promise.all([
    inBatches(pids, 25, (p) => val(db, `${R}/candidates/items/${p}`)),
    inBatches(pids, 25, (p) => val(db, `${R}/sales/${p}`)),
  ]);
  // The marker FIRST: from here the product cannot be put on sale again; then any sale on it is closed (and only
  // then are the stores told). A close that fails leaves the marker, and the same tap again finishes it.
  const upd = {};
  pids.forEach((pid, i) => { upd[`${R}/removed/${pid}`] = { at: nowMs, by: uid, name: String((rows[i] && rows[i].name) || (sales[i] && sales[i].name) || pid).slice(0, 200), kind: core.tabOf(rows[i] || sales[i]), photo: (rows[i] && rows[i].photo) || null }; });
  await db.ref().update(upd);
  const onSale = pids.map((p, i) => [p, sales[i]]).filter(([, s]) => s);
  if (onSale.length) await closeSales(db, onSale, { uid, why: "not_for_sale", nowMs });
  return { ok: true, done: pids };
}
async function restore(db, data) {
  const pids = pidsOf(data);
  await db.ref().update(Object.fromEntries(pids.map((p) => [`${R}/removed/${p}`, null])));
  return { ok: true, done: pids };
}

/**
 * The photo a product posts with (Junid, 23 Nov: the same options as the Black Friday card). The photos themselves
 * are made and kept by the Black Friday card's own callables (bfGenerate = the shared New Arrivals generator at full
 * resolution; bfPhotoSource = Replace photo), in bf_campaign_2026/photos/{pid}/gens. This records WHICH one this card
 * posts — on this card's own node, so a product's approval on the Black Friday card is never changed from here.
 * use: "current" (the product's own photo) | "generated" + genId (an AI photo or his own upload).
 */
const BF_PHOTOS = "bf_campaign_2026/photos";
const GEN_RE = /^g\d{10,16}$/;
async function choosePhoto(db, data, uid, nowMs) {
  const pid = String(data.pid || "");
  if (!core.PID_RE.test(pid)) throw new HttpsError("invalid-argument", "Which product?");
  let url = null;
  if (data.use === "generated") {
    if (!GEN_RE.test(String(data.genId || ""))) throw new HttpsError("invalid-argument", "Which photo?");
    url = await val(db, `${BF_PHOTOS}/${pid}/gens/${data.genId}/url`);
    if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new HttpsError("not-found", "That photo is not there any more. Generate again.");
  } else if (data.use !== "current") throw new HttpsError("invalid-argument", "Use the current photo or a generated one.");
  const own = url ? null : await val(db, `products/${pid}/photoUrl`);
  const upd = { [`${R}/photos/${pid}`]: url ? { use: "generated", genId: data.genId, url, at: nowMs, by: uid } : null };
  // On sale already: the sale posts with the photo chosen now (a post that has gone out is not changed).
  const sale = await val(db, `${R}/sales/${pid}/setAt`);
  const photo = url || (typeof own === "string" && /^https:\/\//.test(own) ? own : null);
  if (sale && photo) upd[`${R}/sales/${pid}/photo`] = photo;
  await db.ref().update(upd);
  return { ok: true, pid, photo, use: url ? "generated" : "current" };
}

// ── the card ─────────────────────────────────────────────────────────────────
const bfSaleList = onCall(callableOpts, async (request) => {
  assertJunid(request);
  const db = admin.database();
  const nowMs = Date.now();
  const d = request.data || {};
  // The card's own small nodes (the finder's list is the largest: one slim row per product that is not moving).
  const [items, removed, sales, photos, posted, meta] = await Promise.all(["candidates/items", "removed", "sales", "photos", "posted", "candidates/meta"].map((p) => val(db, `${R}/${p}`)));
  const windowDays = core.windowOf(d.windowDays);
  const locNames = Object.fromEntries((await locations(db)).map((l) => [l.id, l.name]));
  const view = core.viewList({ items: items || {}, removed: removed || {}, sales: sales || {}, photos: photos || {}, posted: posted || {} }, { tab: d.tab, windowDays, from: d.from, n: d.n, nowMs });
  return { ...view, locNames, tab: core.TABS.includes(d.tab) ? d.tab : "clothing", windowDays, windows: core.WINDOWS, defaultEndDay: core.DEFAULT_END_DAY, defaultUntil: core.endLabel(core.endOfDayMs(core.DEFAULT_END_DAY)), today: core.sastDay(nowMs), now: nowMs, meta: meta || null };
});

const bfSaleSet = onCall(callableOpts, async (request) => {
  assertJunid(request);
  const db = admin.database();
  const nowMs = Date.now();
  const uid = request.auth.uid;
  const d = request.data || {};
  switch (d.action) {
    case "sale": return putOnSale(db, d, uid, nowMs);
    case "extend": return extend(db, d, uid, nowMs);
    case "end": { const r = await closeSales(db, await salesFor(db, d, nowMs), { uid, why: "ended_by_junid", nowMs }); return { ok: true, ...r }; }
    case "remove": return remove(db, d, uid, nowMs);
    case "restore": return restore(db, d);
    case "photo": return choosePhoto(db, d, uid, nowMs);
    case "removed": {
      const v = (await val(db, `${R}/removed`)) || {};
      return { ok: true, removed: Object.entries(v).map(([pid, r]) => ({ pid, name: r.name || pid, at: r.at || null, kind: r.kind || "clothing", photo: r.photo || null })).sort((a, b) => (b.at || 0) - (a.at || 0)) };
    }
    default: throw new HttpsError("invalid-argument", "Unknown action.");
  }
});

/** The staff re-tag list: every product on sale, by the location that holds it now. */
const bfSaleStoreList = onCall(callableOpts, async (request) => {
  const db = admin.database();
  await assertStaff(db, request);
  const nowMs = Date.now();
  const sales = Object.fromEntries(Object.entries((await val(db, `${R}/sales`)) || {}).filter(([, s]) => core.saleActive(s, nowMs)));
  const locs = await locations(db);
  const pids = Object.keys(sales);
  const held = await inBatches(pids, 20, (p) => stockOf(db, p, locs));
  const stock = Object.fromEntries(pids.map((p, i) => [p, held[i]]));
  return { now: nowMs, stores: core.storeList(sales, stock, Object.fromEntries(locs.map((l) => [l.id, l.name])), nowMs), onSale: pids.length };
});

// The till stops charging a sale at its end time by itself (it checks the dates); this job tidies the record
// and tells the stores. Every 10 minutes, one read of the small sales node.
const bfSaleExpire = onSchedule(
  { schedule: "every 10 minutes", timeZone: "Africa/Johannesburg", region: "europe-west1", memory: "256MiB", timeoutSeconds: 120, retryCount: 0 },
  async () => {
    const db = admin.database();
    const nowMs = Date.now();
    const sales = (await val(db, `${R}/sales`)) || {};
    const over = Object.entries(sales).filter(([, s]) => !s || !(Number(s.end) > nowMs));
    if (!over.length) return;
    const r = await closeSales(db, over, { why: "expired", nowMs });
    console.log(`bfSaleExpire: closed ${r.done.length} sale(s) past their end`);
  },
);

module.exports = { bfSaleList, bfSaleSet, bfSaleStoreList, bfSaleExpire, _internals: { choosePhoto, putOnSale, extend, closeSales, remove, restore, salesFor, stockOf, locations } };
