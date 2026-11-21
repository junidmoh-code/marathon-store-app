// ─── BLACK FRIDAY 2026 — the card's callables (Junid only, v3) ───────────────
// bfCampaignList  one section of the card (main = 13+ on hand, under = the
//                 rest, loaded only when Junid flips "Show under 13").
// bfCampaignSet   one tap on one product: approve, reject, back to review,
//                 choose its photo; "Approve all 30+"; approve a category's
//                 AI look; the schedule (preview, confirm, clear).
//                 (view "head" / "pages": the precomputed list, cardIndex.js)
// bfGenerate      (generate.js) one AI photo for one product, on Junid's tap.
// Server-only node (no database rule): the Admin SDK behind the super-admin gate.
//
// NOTHING POSTS WITHOUT A SCHEDULE: schedule/plan (albums made from the
// approved products, by stock price and kind) exists only after Junid confirms
// a schedule, and is recomputed after every tap that changes what is approved.
//
// Deploy BY NAME:
//   firebase deploy --only functions:bfCampaignList,functions:bfCampaignSet,functions:bfGenerate
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const core = require("./core.cjs");
const naLib = require("./na.cjs");
const naCore = require("../newArrivals/core.cjs");
const { isSuperAdminToken } = require("../lib/super-admins.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

// invoker "public": a callable's Cloud Run service must allow allUsers to invoke (auth is checked in code).
const callableOpts = { region: "europe-west1", memory: "512MiB", timeoutSeconds: 300, invoker: "public" };
const POSTING_PAUSE = "new_arrivals/pause/posting/paused";

function assertJunid(request) {
  if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The Black Friday card is Junid's.");
}

const val = async (db, path) => (await db.ref(path).once("value")).val();
let naP = null;
const naMod = () => (naP ||= require("../newArrivals/newArrivals.js"));

/** The permanent approval record: approvals/{pid}/{at} (never overwritten, never cleared by the 05:00 build). */
async function ledger(db, pid, pick) {
  const r = core.approvalRecord(pid, pick);
  if (!r || !r.at) return;
  // Written once: a later write for the same approval never rewrites the record.
  const ref = db.ref(`${core.ROOT}/approvals/${pid}/${r.at}`);
  if ((await ref.once("value")).val()) return;
  await ref.set(r);
}

/** One section, read narrowly: that section's products and the small decision nodes (never `decisions`). */
async function list(db, section = "main", nowMs = Date.now()) {
  if (!core.SECTIONS.includes(section)) throw new HttpsError("invalid-argument", "main or under.");
  const parts = ["meta", `items/${section}`, "picks", "photos", "posted", "styles", "stats", "schedule", "idx", "brain/sent", "repost", "web"];
  const [vals, paused, lanes] = await Promise.all([
    Promise.all(parts.map((p) => val(db, `${core.ROOT}/${p}`))),
    val(db, POSTING_PAUSE).catch(() => null),
    naLib.windowLanes(db, nowMs),
  ]);
  const node = { meta: vals[0], items: { [section]: vals[1] }, picks: vals[2], photos: vals[3], posted: vals[4], styles: vals[5], stats: vals[6], schedule: vals[7], idx: vals[8], brain: { sent: vals[9] }, repost: vals[10], web: vals[11] };
  const picks = node.picks || {};
  const naSet = new Set(lanes.keys());
  // The Approved tab shows EVERY approval: on the main view, approvals with no main row (under-13, or a
  // New Arrival uploaded after the build) are read one by one — or made from the pick itself.
  const extraApproved = {};
  let naRows = [];
  if (section === "main") {
    const other = Object.entries(picks).filter(([pid, p]) => core.isApproved(p, (node.photos || {})[pid]) && !(node.items.main || {})[pid]);
    const rows = await Promise.all(other.map(([pid]) => val(db, `${core.ROOT}/items/under/${pid}`)));
    other.forEach(([pid, p], i) => {
      extraApproved[pid] = rows[i] || { name: p.name || pid, price: p.price, kind: p.kind || "clothing", sizes: p.sizes || "", photo: p.shown || null, qty: 0 };
    });
    naRows = await naLib.naTab(db, { lanes, items: { main: node.items.main || {} }, picks, photos: node.photos || {}, nowMs, na: naMod(), underRow: (pid) => val(db, `${core.ROOT}/items/under/${pid}`) });
  }
  return core.viewSection(node, section, { postingPaused: paused === true, extraApproved, naSet, naRows, nowMs });
}

// ── New Arrivals: their taps go through New Arrivals' own moves; the pick mirrors the item ──
/** Is this product handled as a New Arrival (in the New Arrivals queue, in the window or already mirrored)? → status | null */
async function naStatus(db, pid, nowMs) {
  const status = await val(db, `${naCore.ITEMS}/${pid}/status`);
  if (!status) return null;
  const pick = await val(db, `${core.ROOT}/picks/${pid}`);
  // A decision made on the Black Friday card before (not mirrored) stays a Black Friday decision: its taps go the old way.
  if (pick && pick.state && pick.src !== "na") return null;
  if (String(pid) >= naCore.windowStartKey(nowMs)) return status;
  return pick && pick.src === "na" ? status : null;
}
const naRefusal = (r) => {
  const why = (r && r.skipped && r.skipped[0] && r.skipped[0].why) || (r && r.why) || "not saved";
  return /price/i.test(String(why)) ? core.NO_PRICE : why; // one wording on every row: "No price, set price first"
};
/**
 * One New Arrivals tap. action: approve (sig: "current" = the app photo, a genId = that New Arrivals photo,
 * none = its main photo), reject (skip), reset (back to review). → { refusal } | { prev, pick, noop }
 */
async function naTap(db, pid, action, { sig = null, status }, uid, nowMs) {
  const na = naMod()._internals;
  const prev = await val(db, `${core.ROOT}/picks/${pid}`);
  let r = null;
  try {
    if (action === "approve") {
      if (naCore.APPROVED_LANES.includes(status)) {
        // Already approved in New Arrivals: make sure the pick (and its record) caught up, then nothing to do.
        const m = await naLib.mirror(db, pid, nowMs, { na: naMod(), ledger });
        return { noop: true, prev, pick: m.pick || prev };
      }
      if (sig === "current") { r = await na.useCurrent(db, { pid }, uid, nowMs); if (!r.approved.length) return { refusal: naRefusal(r) }; }
      else {
        r = await na.approve(db, { pids: [pid], ...(sig && core.GEN_RE.test(String(sig)) ? { genId: sig } : {}) }, uid, nowMs);
        if (!r.approved.length) {
          const why = naRefusal(r);
          return { refusal: /no generated photo/.test(why) ? "it has no AI photo yet — tap Use current photo, or Generate" : why };
        }
      }
    } else if (action === "reject") {
      if (status === "skipped") { const m = await naLib.mirror(db, pid, nowMs, { na: naMod(), ledger }); return { noop: true, prev, pick: m.pick || prev }; }
      if (naCore.APPROVED_LANES.includes(status)) { const u = await na.unapprove(db, { pid }, uid, nowMs); if (!u.ok) return { refusal: u.why }; }
      r = await na.skip(db, { pids: [pid] }, uid, nowMs);
      if (!r.skippedPids.length) return { refusal: naRefusal(r) };
    } else {
      if (naCore.APPROVED_LANES.includes(status)) { r = await na.unapprove(db, { pid }, uid, nowMs); if (!r.ok) return { refusal: r.why }; }
      else if (status === "skipped") { r = await na.restore(db, { pids: [pid] }, uid, nowMs); if (!r.restored.length) return { refusal: naRefusal(r) }; }
      else return { noop: true, prev, pick: prev };
    }
  } catch (e) { return { refusal: String((e && e.message) || e).replace(/^.*? — /, "") }; }
  const m = await naLib.mirror(db, pid, nowMs, { na: naMod(), ledger });
  return { prev, pick: m.pick, noop: false };
}
/** A New Arrival's row after a tap, for the card to patch in place. */
async function naRowAfter(db, pid, pick, nowMs) {
  if (pick && pick.state === "approved") {
    const built = (await val(db, `${core.ROOT}/items/main/${pid}`)) || (await val(db, `${core.ROOT}/items/under/${pid}`));
    const it = built || { name: pick.name, price: pick.price, kind: pick.kind, sizes: pick.sizes, photo: pick.shown, qty: 0 };
    const [sent, repost, web] = await Promise.all([val(db, `${core.ROOT}/brain/sent/${pid}`), val(db, `${core.ROOT}/repost/${pid}`), val(db, `${core.ROOT}/web/${pid}`)]);
    return core.viewItem(pid, it, { pick, photo: null, nowMs, sent, repost, na: true, web });
  }
  if (pick && pick.state === "rejected") return null;
  const built = (await val(db, `${core.ROOT}/items/main/${pid}`)) || (await val(db, `${core.ROOT}/items/under/${pid}`));
  const base = built || await naLib.liveRow(db, pid, nowMs, naMod());
  if (!base) return null;
  return naLib.viewNaRow(pid, base, await naLib.naFields(db, pid), { nowMs });
}

/** A transaction safe on a Cloud Function's cold first callback (the node is never deleted: core.withRev). */
async function revTransaction(ref, mut, out) {
  const pre = (await ref.once("value")).val();
  return ref.transaction((cur) => {
    for (const k of Object.keys(out)) delete out[k];
    const base = cur === null ? pre : cur;
    out.base = base; // what the node was, for Undo
    const next = mut(base);
    return next === undefined ? undefined : core.withRev(next, base);
  });
}

/** Recompute schedule/plan. No confirmed schedule → no plan → nothing posts. */
async function replan(db, nowMs) {
  const s = await val(db, `${core.ROOT}/schedule`);
  if (!s || !s.confirmedAt) return null;
  const [picks, photos, posted] = await Promise.all(["picks", "photos", "posted"].map((p) => val(db, `${core.ROOT}/${p}`)));
  const plan = core.planAlbums(core.albumsOf(core.toPost(picks, photos, posted)), s, nowMs, s.plan || {}, posted || {});
  await db.ref(`${core.ROOT}/schedule`).update({ plan: Object.keys(plan).length ? plan : null, planAt: nowMs });
  return plan;
}

const log = (db, row) => db.ref(`${core.ROOT}/decisions`).push().set(row);

/**
 * The product's row from main or under — or, for a New Arrival not in the
 * build, made from the product now (section "newArrivals"). → { item, section }
 */
async function findItem(db, pid, hint, nowMs = Date.now()) {
  const order = core.SECTIONS.includes(hint) ? [hint, ...core.SECTIONS.filter((s) => s !== hint)] : core.SECTIONS;
  for (const section of order) {
    const item = await val(db, `${core.ROOT}/items/${section}/${pid}`);
    if (item) return { item, section };
  }
  const na = await naLib.campaignRowOfNa(db, pid, nowMs, naMod()).catch(() => null);
  if (na) return { item: na, section: "newArrivals" };
  return { item: null, section: null };
}

/**
 * Is this the id of a Black Friday photo of the product (his own photo, or one made by Black Friday's
 * Generate)? Then an Approve of it is a Black Friday decision even on a New Arrival — New Arrivals'
 * own approve knows only its own photos. Pure on the photo node.
 */
const bfPhotoSig = (photo, sig) => !!sig && core.GEN_RE.test(String(sig)) && !!(photo && photo.gens && photo.gens[sig] && photo.gens[sig].url);
/** A New Arrival approved through Black Friday is still a New Arrival on the card and to the poster. */
const sectionFor = (sec, pid, status) => (status ? "newArrivals" : sec);

async function tap(db, { action, pid, section, use, genId, sig, app = false, approve = false }, uid, nowMs) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Which product?");
  if (!["approve", "reject", "reset", "use"].includes(action)) throw new HttpsError("invalid-argument", "approve, reject, reset or use.");
  const out = {};
  const pickRef = db.ref(`${core.ROOT}/picks/${pid}`);
  const photoNow = await val(db, `${core.ROOT}/photos/${pid}`);
  const bfOwn = action === "approve" && bfPhotoSig(photoNow, sig);
  const naNow = bfOwn || action === "use" ? await val(db, `${naCore.ITEMS}/${pid}/status`) : null;
  if (action !== "use" && !bfOwn) {
    const status = await naStatus(db, pid, nowMs);
    if (status) {
      const r = await naTap(db, pid, action, { sig, status }, uid, nowMs);
      if (r.refusal) return { ok: false, pid, refusal: r.refusal };
      if (!r.noop) await log(db, { at: nowMs, by: uid || null, action, pid, src: "na" });
      const undo = (action === "approve" || action === "reject") && !r.noop ? { [pid]: { prev: r.prev || null, expectAt: r.pick ? Number(r.pick.at) : nowMs } } : null;
      return { ok: true, pid, noop: !!r.noop, rejected: !!(r.pick && r.pick.state === "rejected"), undo, row: await naRowAfter(db, pid, r.pick, nowMs) };
    }
  }
  const { item, section: found } = await findItem(db, pid, section, nowMs);
  const sec = sectionFor(found, pid, naNow);
  if ((action === "use" || action === "approve") && !item) throw new HttpsError("not-found", "That product is not in the campaign.");
  let approvedToo = false;
  if (action === "use") {
    if (!["current", "generated"].includes(use)) throw new HttpsError("invalid-argument", "Use the current photo or a generated one.");
    if (genId !== undefined && genId !== null && !core.GEN_RE.test(String(genId))) throw new HttpsError("invalid-argument", "Which generated photo?");
    const res = await revTransaction(db.ref(`${core.ROOT}/photos/${pid}`), core.useMutator({ use, genId: genId || null, app: app === true }, out), out);
    // On the Approved tab "Use this photo" approves it in the same tap (the approved photo is what posts).
    if (approve === true && !out.refusal) {
      const photo = res && res.committed ? res.snapshot.val() : await val(db, `${core.ROOT}/photos/${pid}`);
      const o2 = {};
      const r2 = await revTransaction(pickRef, core.approveMutator({ item, section: sec, photo, uid, nowMs }, o2), o2);
      if (o2.refusal) return { ok: false, pid, refusal: o2.refusal };
      if (r2 && r2.committed && !o2.noop) { out.base = o2.base; out.noop = false; approvedToo = true; await ledger(db, pid, r2.snapshot.val()).catch(() => {}); }
    }
  } else if (action === "approve") {
    const photo = photoNow;
    if (sig !== undefined && sig !== null && !core.SIG_OK(sig)) throw new HttpsError("invalid-argument", "Which photo?");
    const res = await revTransaction(pickRef, core.approveMutator({ item, section: sec, photo, uid, nowMs, seenSig: sig || null }, out), out);
    // The record is of the approval as committed (a later tap may already have changed the pick).
    if (res && res.committed && !out.noop && !out.refusal) await ledger(db, pid, res.snapshot.val()).catch(() => {});
  } else if (action === "reject") {
    await revTransaction(pickRef, core.rejectMutator({ item, section: sec, uid, nowMs }, out), out);
  } else {
    await revTransaction(pickRef, core.resetMutator(out), out);
  }
  if (out.refusal) return { ok: false, pid, refusal: out.refusal };
  if (!out.noop) {
    await log(db, { at: nowMs, by: uid || null, action, pid, ...(use ? { use } : {}), ...(genId ? { genId } : {}) });
    await replan(db, nowMs);
  }
  const [pick, photo, posted, styles, sent, repost, web] = await Promise.all([`picks/${pid}`, `photos/${pid}`, `posted/${pid}`, "styles", `brain/sent/${pid}`, `repost/${pid}`, `web/${pid}`].map((p) => val(db, `${core.ROOT}/${p}`)));
  const undo = (action === "approve" || action === "reject" || approvedToo) && !out.noop ? { [pid]: { prev: out.base || null, expectAt: nowMs } } : null;
  // A New Arrival still waiting (no Black Friday decision): its row is the New Arrivals row, with the photo layer.
  if (naNow && naCore.NEW_LANES.includes(naNow) && !(pick && pick.state)) {
    const f = await naLib.naFields(db, pid);
    return { ok: true, pid, noop: !!out.noop, rejected: false, undo, row: naLib.viewNaRow(pid, item, f, { nowMs, photo }) };
  }
  return { ok: true, pid, noop: !!out.noop, rejected: core.isRejected(pick), undo, row: item ? core.viewItem(pid, item, { pick, photo, posted, styles: styles || {}, nowMs, sent, repost, na: !!naNow, web }) : null };
}

/**
 * "Approve all 30+": every MAIN product with 30+ on hand still in To review,
 * each with the photo the card showed (sigs: { pid: sig }). One transaction per
 * product: a product rejected or re-photographed meanwhile is left alone.
 */
async function approveBig(db, sigs, uid, nowMs) {
  const items = (await val(db, `${core.ROOT}/items/main`)) || {};
  const asked = sigs && typeof sigs === "object" ? sigs : {};
  const todo = Object.entries(items).filter(([pid, it]) => it && Number(it.qty) >= core.BIG_QTY && core.PID_RE.test(pid) && Object.prototype.hasOwnProperty.call(asked, pid));
  const approved = [], undo = {};
  for (let i = 0; i < todo.length; i += 25) {
    await Promise.all(todo.slice(i, i + 25).map(async ([pid, it]) => {
      const out = {};
      const photo = await val(db, `${core.ROOT}/photos/${pid}`);
      const res = await revTransaction(db.ref(`${core.ROOT}/picks/${pid}`), core.approveMutator({ item: it, section: "main", photo, uid, nowMs, seenSig: String(asked[pid] || "current"), onlyIfUntouched: true }, out), out);
      if (res && res.committed && !out.noop && !out.refusal) { approved.push(pid); undo[pid] = { prev: out.base || null, expectAt: nowMs }; await ledger(db, pid, res.snapshot.val()).catch(() => {}); }
    }));
  }
  if (approved.length) {
    await log(db, { at: nowMs, by: uid || null, action: "approveBig", count: approved.length });
    await replan(db, nowMs);
  }
  // The pids, so the card's Undo can take exactly these back.
  return { ok: true, approved: approved.length, pids: approved, undo };
}

// Any real selection goes through in one call (Junid ticked 574; the old 500 cap refused it): the writes are
// chunked here, one transaction per product, CHUNK at a time. The cap only stops a malformed request.
const MANY_MAX = 20000;
const CHUNK = 50;
/**
 * The card's multi-select: approve (each with the photo the card showed), reject,
 * or back to review (Undo) — one transaction per product. → { ok, done: [pid], refused: [{ pid, refusal }] }
 */
async function many(db, action, list, uid, nowMs) {
  const entries = Array.isArray(list) ? list.map((pid) => [pid, null]) : Object.entries(list && typeof list === "object" ? list : {});
  if (entries.length > MANY_MAX) throw new HttpsError("invalid-argument", "Too many at once.");
  for (const [pid, sig] of entries) {
    if (!core.PID_RE.test(String(pid))) throw new HttpsError("invalid-argument", "Which product?");
    if (action === "approve" && (sig === null || sig === "")) throw new HttpsError("invalid-argument", "Approve needs the photo the card showed.");
    if (sig !== null && !core.SIG_OK(sig)) throw new HttpsError("invalid-argument", "Which photo?");
  }
  const done = [], refused = [], undo = {};
  for (let i = 0; i < entries.length; i += CHUNK) {
    await Promise.all(entries.slice(i, i + CHUNK).map(async ([pid, sig]) => {
      const out = {};
      const ref = db.ref(`${core.ROOT}/picks/${pid}`);
      const photoNow = action === "approve" ? await val(db, `${core.ROOT}/photos/${pid}`) : null;
      const bfOwn = action === "approve" && bfPhotoSig(photoNow, sig);
      const status = bfOwn ? null : await naStatus(db, pid, nowMs);
      if (status) {
        const r = await naTap(db, pid, action, { sig, status }, uid, nowMs);
        if (r.refusal) refused.push({ pid, refusal: r.refusal });
        else if (!r.noop) { done.push(pid); if (action !== "reset") undo[pid] = { prev: r.prev || null, expectAt: r.pick ? Number(r.pick.at) : nowMs }; }
        return;
      }
      let res = null;
      if (action === "reset") await revTransaction(ref, core.resetMutator(out), out);
      else {
        const { item, section: found } = await findItem(db, pid, null, nowMs);
        if (!item && action === "approve") { refused.push({ pid, refusal: "not in the campaign" }); return; }
        const section = bfOwn ? sectionFor(found, pid, await val(db, `${naCore.ITEMS}/${pid}/status`)) : found;
        if (action === "approve") {
          const photo = photoNow;
          res = await revTransaction(ref, core.approveMutator({ item, section, photo, uid, nowMs, seenSig: sig || null }, out), out);
        } else await revTransaction(ref, core.rejectMutator({ item, section, uid, nowMs }, out), out);
      }
      if (res && res.committed && !out.noop && !out.refusal) await ledger(db, pid, res.snapshot.val()).catch(() => {});
      if (out.refusal) refused.push({ pid, refusal: out.refusal });
      else if (!out.noop) { done.push(pid); if (action !== "reset") undo[pid] = { prev: out.base || null, expectAt: nowMs }; }
    }));
  }
  if (done.length) {
    await log(db, { at: nowMs, by: uid || null, action: `${action}Many`, count: done.length });
    await replan(db, nowMs);
  }
  return { ok: true, done, refused, undo };
}

// The card's multi-select, kept on the server as Junid ticks (he lost a 574-product selection to a failed
// bulk Approve once): a refresh, a crash or a deploy never loses it. { pid: sig } per admin; empty clears it.
const selPath = (uid) => `${core.ROOT}/selection/${String(uid).replace(/[.#$\[\]/]/g, "_")}`;
async function saveSelection(db, uid, sigs, nowMs, label = null) {
  if (!uid) throw new HttpsError("unauthenticated", "Sign in.");
  const entries = Object.entries(sigs && typeof sigs === "object" ? sigs : {});
  if (entries.length > MANY_MAX) throw new HttpsError("invalid-argument", "Too many at once.");
  for (const [pid, sig] of entries) {
    if (!core.PID_RE.test(String(pid))) throw new HttpsError("invalid-argument", "Which product?");
    if (!core.SIG_OK(sig)) throw new HttpsError("invalid-argument", "Which photo?");
  }
  if (!entries.length) { await db.ref(selPath(uid)).remove(); return { ok: true, saved: 0 }; }
  // label: a selection put back for him (e.g. "Recovered selection") keeps its name while he works through it.
  const name = typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : null;
  await db.ref(selPath(uid)).set({ at: nowMs, sigs: Object.fromEntries(entries), ...(name ? { label: name } : {}) });
  return { ok: true, saved: entries.length };
}
async function loadSelection(db, uid) {
  if (!uid) return null;
  const s = await val(db, selPath(uid));
  return s && s.sigs ? { at: s.at || null, sigs: s.sigs, label: s.label || null } : null;
}

/** Undo: { pid: { prev, expectAt } } — each pick back to exactly what it was, if unchanged since. */
async function restore(db, items, uid, nowMs) {
  const entries = Object.entries(items && typeof items === "object" ? items : {});
  if (entries.length > MANY_MAX) throw new HttpsError("invalid-argument", "Too many at once.");
  for (const [pid, e] of entries) if (!core.PID_RE.test(String(pid)) || !e || !Number.isFinite(Number(e.expectAt))) throw new HttpsError("invalid-argument", "Which product?");
  const done = [], refused = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    await Promise.all(entries.slice(i, i + CHUNK).map(async ([pid, e]) => {
      const out = {};
      const cur = await val(db, `${core.ROOT}/picks/${pid}`);
      if (cur && cur.src === "na") {
        // A New Arrival: undone through New Arrivals (unapprove / restore), if still what the action wrote.
        if (Number(cur.at) !== Number(e.expectAt)) { refused.push({ pid, refusal: "it changed since — not undone" }); return; }
        const status = await val(db, `${naCore.ITEMS}/${pid}/status`);
        const r = await naTap(db, pid, "reset", { status }, uid, nowMs);
        if (r.refusal) { refused.push({ pid, refusal: r.refusal }); return; }
        // It was approved before (e.g. a Reject is undone): approved again, with the same kind of photo.
        const prev = e.prev && typeof e.prev === "object" ? e.prev : null;
        if (prev && prev.state === "approved" && prev.src === "na") {
          const back = await naTap(db, pid, "approve", { sig: prev.useCurrent ? "current" : "na", status: await val(db, `${naCore.ITEMS}/${pid}/status`) }, uid, nowMs);
          if (back.refusal) { refused.push({ pid, refusal: back.refusal }); return; }
        }
        done.push(pid);
        return;
      }
      const prev = e.prev && typeof e.prev === "object" ? e.prev : null;
      if (prev && prev.state && !["approved", "rejected"].includes(prev.state)) { refused.push({ pid, refusal: "bad state" }); return; }
      await revTransaction(db.ref(`${core.ROOT}/picks/${pid}`), core.restoreMutator({ prev, expectAt: Number(e.expectAt) }, out), out);
      if (out.refusal) refused.push({ pid, refusal: out.refusal }); else done.push(pid);
    }));
  }
  if (done.length) {
    await log(db, { at: nowMs, by: uid || null, action: "undo", count: done.length });
    await replan(db, nowMs);
  }
  return { ok: true, done, refused };
}

/**
 * Repost: approved products Junid picks go to the next slot again (the brain posts a product once,
 * and again only after a Repost). repost/{pid} = { at, by }. Nothing reposts by itself.
 */
async function repost(db, pids, uid, nowMs) {
  const list = Array.isArray(pids) ? [...new Set(pids.map(String))] : [];
  if (!list.length) throw new HttpsError("invalid-argument", "Nothing selected.");
  if (list.length > MANY_MAX) throw new HttpsError("invalid-argument", "Too many at once.");
  for (const pid of list) if (!core.PID_RE.test(pid)) throw new HttpsError("invalid-argument", "Which product?");
  const done = [], refused = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    await Promise.all(list.slice(i, i + CHUNK).map(async (pid) => {
      const [pick, photo] = await Promise.all([val(db, `${core.ROOT}/picks/${pid}`), val(db, `${core.ROOT}/photos/${pid}`)]);
      if (!core.isApproved(pick, photo)) { refused.push({ pid, refusal: "not approved" }); return; }
      await db.ref(`${core.ROOT}/repost/${pid}`).set({ at: nowMs, by: uid || null });
      done.push(pid);
    }));
  }
  if (done.length) await log(db, { at: nowMs, by: uid || null, action: "repost", count: done.length });
  return { ok: true, done, refused };
}

async function approveStyle(db, kind, uid, nowMs) {
  if (!core.KIND_RE.test(String(kind || ""))) throw new HttpsError("invalid-argument", "Which category?");
  await db.ref(`${core.ROOT}/styles/${kind}`).set({ approvedAt: nowMs, by: uid || null });
  await log(db, { at: nowMs, by: uid || null, action: "approveStyle", kind });
  return { ok: true, kind };
}

/** The schedule: preview (nothing written) or confirm (written with a fresh plan). */
async function schedule(db, raw, { confirm }, uid, nowMs) {
  const s = core.cleanSchedule(raw, nowMs);
  if (s.error) return { ok: false, refusal: s.error };
  const [picks, photos, posted] = await Promise.all(["picks", "photos", "posted"].map((p) => val(db, `${core.ROOT}/${p}`)));
  const albums = core.albumsOf(core.toPost(picks, photos, posted));
  const plan = core.planAlbums(albums, s, nowMs);
  const label = (a) => `${core.priceLabel(a.price)} ${core.KIND_LABEL[a.kind] || a.kind}${a.parts > 1 ? ` – ${a.part} of ${a.parts}` : ""}`;
  const preview = core.planView(plan).map((p) => { const a = albums.find((x) => x.key === p.album); return { ...p, label: a ? label(a) : p.album }; });
  if (!confirm) return { ok: true, preview: true, schedule: s, plan: preview, albums: albums.length };
  await db.ref(`${core.ROOT}/schedule`).set({ ...s, confirmedAt: nowMs, confirmedBy: uid || null, plan: Object.keys(plan).length ? plan : null, planAt: nowMs });
  await log(db, { at: nowMs, by: uid || null, action: "schedule", mode: s.mode });
  return { ok: true, schedule: s, plan: preview, albums: albums.length };
}

async function clearSchedule(db, uid, nowMs) {
  await db.ref(`${core.ROOT}/schedule`).remove();
  await log(db, { at: nowMs, by: uid || null, action: "clearSchedule" });
  return { ok: true, cleared: true };
}

// ── THE POSTING BRAIN (the Mac's bin/bf-brain.mjs) ──────────────────────────
// It writes brain/view (the plan, posted/remaining, best times); the card reads it and writes only
// brain/control: the Pause switch and a slot time Junid moves.
async function brainView(db) {
  const [view, control] = await Promise.all([val(db, `${core.ROOT}/brain/view`), val(db, `${core.ROOT}/brain/control`)]);
  return view ? { ...view, paused: !!(control && control.paused), overrides: (control && control.slots) || {} } : null;
}
async function brainPause(db, paused, uid, nowMs) {
  await db.ref(`${core.ROOT}/brain/control`).update({ paused: paused === true, pausedAt: nowMs, pausedBy: uid || null });
  await log(db, { at: nowMs, by: uid || null, action: paused === true ? "brainPause" : "brainResume" });
  return { ok: true, paused: paused === true };
}
async function brainSlot(db, { day, i, at }, uid, nowMs) {
  // Ongoing daily plan (Junid, 20 Nov): any day from the start on (no end date); slot ids 0–7.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) || String(day) < "2026-11-19") throw new HttpsError("invalid-argument", "A day of the plan (YYYY-MM-DD).");
  if (!Number.isInteger(i) || i < 0 || i > 7) throw new HttpsError("invalid-argument", "Slot 0–7.");
  if (at !== null) {
    if (!/^\d{2}:\d{2}$/.test(String(at))) throw new HttpsError("invalid-argument", "A time like 09:30.");
    const [h, m] = String(at).split(":").map(Number);
    if (h < 7 || h > 21 || m > 59 || (h === 21 && m > 30)) throw new HttpsError("invalid-argument", "Slots run from 07:00 to 21:30 (never 22:00–07:00).");
  }
  await db.ref(`${core.ROOT}/brain/control/slots/${day}/${i}`).set(at);
  await log(db, { at: nowMs, by: uid || null, action: "brainSlot", day, i, time: at });
  return { ok: true, day, i, at };
}

// ONE CATEGORY PER DAY (Junid, 20 Nov evening): Junid sets a day's category (a categoryKey) or gives it back to
// the rotation (null). The Mac's brain reads brain/control/dayCats/{day}.
async function brainDayCat(db, { day, cat }, uid, nowMs) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) || String(day) < "2026-11-19") throw new HttpsError("invalid-argument", "A day of the plan (YYYY-MM-DD).");
  if (cat !== null && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(cat))) throw new HttpsError("invalid-argument", "A category key like soccer-boots.");
  await db.ref(`${core.ROOT}/brain/control/dayCats/${day}`).set(cat);
  await log(db, { at: nowMs, by: uid || null, action: "brainDayCat", day, cat });
  return { ok: true, day, cat };
}

// FAST OPEN (Junid, 21 Nov 2026): one instance is kept warm (no cold start when he opens the card), and
// the card reads the precomputed list (cardIndex.js): view "head" = counts + the first page of every tab,
// view "pages" = more rows of one tab as he scrolls. No view = the whole section computed now (Show under 13).
const listOpts = { ...callableOpts, minInstances: 1 };
const bfCampaignList = onCall(listOpts, async (request) => {
  assertJunid(request);
  const db = admin.database();
  const d = request.data || {};
  const cardIndex = require("./cardIndex.js");
  if (d.view === "pages") {
    try { return await cardIndex.readPages(db, d.tab, d.from, d.n); }
    catch (e) { throw new HttpsError(e.code === "invalid-argument" ? "invalid-argument" : "internal", e.message); }
  }
  if (d.view === "head") {
    const [h, selection, brain] = await Promise.all([cardIndex.readHead(db), loadSelection(db, request.auth && request.auth.uid), brainView(db)]);
    return { ...h, selection, brain };
  }
  const [v, selection, brain] = await Promise.all([
    list(db, d.section || "main", Date.now()),
    loadSelection(db, request.auth && request.auth.uid),
    brainView(db),
  ]);
  return { ...v, selection, brain };
});

const bfCampaignSet = onCall(callableOpts, async (request) => {
  assertJunid(request);
  const d = request.data || {};
  const db = admin.database();
  const uid = request.auth && request.auth.uid;
  const now = Date.now();
  if (d.action === "brainPause") return brainPause(db, d.paused, uid, now);
  if (d.action === "brainDayCat") return brainDayCat(db, { day: d.day, cat: d.cat === undefined ? null : d.cat }, uid, now);
  if (d.action === "brainSlot") return brainSlot(db, { day: d.day, i: d.i, at: d.at === undefined ? null : d.at }, uid, now);
  if (d.action === "schedule") return schedule(db, d.schedule, { confirm: d.confirm === true }, uid, now);
  if (d.action === "clearSchedule") return clearSchedule(db, uid, now);
  if (d.action === "approveBig") return approveBig(db, d.sigs, uid, now);
  if (d.action === "approveMany") return many(db, "approve", d.sigs, uid, now);
  if (d.action === "rejectMany") return many(db, "reject", d.pids, uid, now);
  if (d.action === "resetMany") return many(db, "reset", d.pids, uid, now);
  if (d.action === "selSave") return saveSelection(db, uid, d.sigs, now, d.label);
  if (d.action === "undo") return restore(db, d.items, uid, now);
  if (d.action === "approveStyle") return approveStyle(db, d.kind, uid, now);
  if (d.action === "repost") return repost(db, d.pids, uid, now);
  return tap(db, { action: d.action, pid: d.pid, section: d.section, use: d.use, genId: d.genId, sig: d.sig, app: d.app === true, approve: d.approve === true }, uid, now);
});

// A tap on the NEW ARRIVALS card (approve, use current photo, un-approve, skip, restore) moves the item's
// status; its Black Friday pick follows here, so approving in either place is one approval.
const bfNaMirror = onValueWritten(
  { ref: "/new_arrivals/items/{pid}/status", instance: "marathon-club-default-rtdb", region: "europe-west1", memory: "256MiB", timeoutSeconds: 60, retry: false },
  async (event) => {
    const pid = event.params.pid;
    if (!core.PID_RE.test(String(pid || ""))) return;
    const before = event.data.before.val(), after = event.data.after.val();
    if (before === after) return;
    try { await naLib.mirror(admin.database(), pid, Date.now(), { na: naMod(), ledger }); }
    catch (e) { console.error(`bfNaMirror: ${pid} not mirrored — ${e.message}`); }
  },
);

// ALL NEW ARRIVALS ARE POSTED (Junid, 21 Nov 2026): every 10 minutes, each new arrival on the card's New Arrivals
// tab is approved through the same bulk Approve (naAuto.cjs has the rules: never R0, no photo, paper bags, out of
// stock, rejected or taken back; an upload settles 15 minutes first).
const bfNaAutoApprove = onSchedule(
  { schedule: "every 10 minutes", timeZone: "Africa/Johannesburg", region: "europe-west1", memory: "512MiB", timeoutSeconds: 300, retryCount: 0 },
  async () => {
    const out = await require("./naAuto.cjs").run(admin.database(), { apply: true, list, many });
    console.log(`bfNaAutoApprove: ${out.approved || 0} approved of ${out.onTab} on the tab; skipped ${JSON.stringify(out.skipped)}${out.refused && out.refused.length ? `; refused ${JSON.stringify(out.refused.slice(0, 10))}` : ""}`);
  },
);

module.exports = { bfCampaignList, bfCampaignSet, bfNaMirror, bfNaAutoApprove, _internals: { bfPhotoSig, findItem, repost, naTap, naStatus, ledger, brainView, brainPause, brainSlot, brainDayCat, list, tap, saveSelection, loadSelection, approveBig, many, restore, approveStyle, schedule, clearSchedule, replan, revTransaction, assertJunid } };
