// ─── BLACK FRIDAY 2026 — the card's callables (Junid only, v3) ───────────────
// bfCampaignList  one section of the card (main = 13+ on hand, under = the
//                 rest, loaded only when Junid flips "Show under 13").
// bfCampaignSet   one tap on one product: approve, reject, back to review,
//                 choose its photo; "Approve all 30+"; approve a category's
//                 AI look; the schedule (preview, confirm, clear).
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
const admin = require("firebase-admin");
const core = require("./core.cjs");
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

/** One section, read narrowly: that section's products and the small decision nodes (never `decisions`). */
async function list(db, section = "main") {
  if (!core.SECTIONS.includes(section)) throw new HttpsError("invalid-argument", "main or under.");
  const parts = ["meta", `items/${section}`, "picks", "photos", "posted", "styles", "stats", "schedule", "idx"];
  const [vals, paused] = await Promise.all([
    Promise.all(parts.map((p) => val(db, `${core.ROOT}/${p}`))),
    val(db, POSTING_PAUSE).catch(() => null),
  ]);
  const node = { meta: vals[0], items: { [section]: vals[1] }, picks: vals[2], photos: vals[3], posted: vals[4], styles: vals[5], stats: vals[6], schedule: vals[7], idx: vals[8] };
  // The Approved tab shows EVERY approval: on the main view, the under-13 products Junid approved are read one by one.
  const extraApproved = {};
  if (section === "main") {
    const other = Object.entries(node.picks || {}).filter(([pid, p]) => p && p.state === "approved" && p.section === "under" && !(node.items.main || {})[pid]);
    const rows = await Promise.all(other.map(([pid]) => val(db, `${core.ROOT}/items/under/${pid}`)));
    other.forEach(([pid], i) => { if (rows[i]) extraApproved[pid] = rows[i]; });
  }
  return core.viewSection(node, section, { postingPaused: paused === true, extraApproved });
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

/** The product's row from main or under. → { item, section } */
async function findItem(db, pid, hint) {
  const order = core.SECTIONS.includes(hint) ? [hint, ...core.SECTIONS.filter((s) => s !== hint)] : core.SECTIONS;
  for (const section of order) {
    const item = await val(db, `${core.ROOT}/items/${section}/${pid}`);
    if (item) return { item, section };
  }
  return { item: null, section: null };
}

async function tap(db, { action, pid, section, use, genId, sig }, uid, nowMs) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Which product?");
  if (!["approve", "reject", "reset", "use"].includes(action)) throw new HttpsError("invalid-argument", "approve, reject, reset or use.");
  const out = {};
  const pickRef = db.ref(`${core.ROOT}/picks/${pid}`);
  const { item, section: sec } = await findItem(db, pid, section);
  if ((action === "use" || action === "approve") && !item) throw new HttpsError("not-found", "That product is not in the campaign.");
  if (action === "use") {
    if (!["current", "generated"].includes(use)) throw new HttpsError("invalid-argument", "Use the current photo or a generated one.");
    if (genId !== undefined && genId !== null && !core.GEN_RE.test(String(genId))) throw new HttpsError("invalid-argument", "Which generated photo?");
    await revTransaction(db.ref(`${core.ROOT}/photos/${pid}`), core.useMutator({ use, genId: genId || null }, out), out);
  } else if (action === "approve") {
    const photo = await val(db, `${core.ROOT}/photos/${pid}`);
    if (sig !== undefined && sig !== null && sig !== "current" && !core.GEN_RE.test(String(sig))) throw new HttpsError("invalid-argument", "Which photo?");
    await revTransaction(pickRef, core.approveMutator({ item, section: sec, photo, uid, nowMs, seenSig: sig || null }, out), out);
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
  const [pick, photo, posted, styles] = await Promise.all([`picks/${pid}`, `photos/${pid}`, `posted/${pid}`, "styles"].map((p) => val(db, `${core.ROOT}/${p}`)));
  const undo = (action === "approve" || action === "reject") && !out.noop ? { [pid]: { prev: out.base || null, expectAt: nowMs } } : null;
  return { ok: true, pid, noop: !!out.noop, rejected: core.isRejected(pick), undo, row: item ? core.viewItem(pid, item, { pick, photo, posted, styles: styles || {}, nowMs }) : null };
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
      if (res && res.committed && !out.noop && !out.refusal) { approved.push(pid); undo[pid] = { prev: out.base || null, expectAt: nowMs }; }
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
    if (sig !== null && sig !== "current" && !core.GEN_RE.test(String(sig))) throw new HttpsError("invalid-argument", "Which photo?");
  }
  const done = [], refused = [], undo = {};
  for (let i = 0; i < entries.length; i += CHUNK) {
    await Promise.all(entries.slice(i, i + CHUNK).map(async ([pid, sig]) => {
      const out = {};
      const ref = db.ref(`${core.ROOT}/picks/${pid}`);
      if (action === "reset") await revTransaction(ref, core.resetMutator(out), out);
      else {
        const { item, section } = await findItem(db, pid, null);
        if (!item && action === "approve") { refused.push({ pid, refusal: "not in the campaign" }); return; }
        if (action === "approve") {
          const photo = await val(db, `${core.ROOT}/photos/${pid}`);
          await revTransaction(ref, core.approveMutator({ item, section, photo, uid, nowMs, seenSig: sig || null }, out), out);
        } else await revTransaction(ref, core.rejectMutator({ item, section, uid, nowMs }, out), out);
      }
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

/** Undo: { pid: { prev, expectAt } } — each pick back to exactly what it was, if unchanged since. */
async function restore(db, items, uid, nowMs) {
  const entries = Object.entries(items && typeof items === "object" ? items : {});
  if (entries.length > MANY_MAX) throw new HttpsError("invalid-argument", "Too many at once.");
  for (const [pid, e] of entries) if (!core.PID_RE.test(String(pid)) || !e || !Number.isFinite(Number(e.expectAt))) throw new HttpsError("invalid-argument", "Which product?");
  const done = [], refused = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    await Promise.all(entries.slice(i, i + CHUNK).map(async ([pid, e]) => {
      const out = {};
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

const bfCampaignList = onCall(callableOpts, async (request) => {
  assertJunid(request);
  return list(admin.database(), (request.data && request.data.section) || "main");
});

const bfCampaignSet = onCall(callableOpts, async (request) => {
  assertJunid(request);
  const d = request.data || {};
  const db = admin.database();
  const uid = request.auth && request.auth.uid;
  const now = Date.now();
  if (d.action === "schedule") return schedule(db, d.schedule, { confirm: d.confirm === true }, uid, now);
  if (d.action === "clearSchedule") return clearSchedule(db, uid, now);
  if (d.action === "approveBig") return approveBig(db, d.sigs, uid, now);
  if (d.action === "approveMany") return many(db, "approve", d.sigs, uid, now);
  if (d.action === "rejectMany") return many(db, "reject", d.pids, uid, now);
  if (d.action === "resetMany") return many(db, "reset", d.pids, uid, now);
  if (d.action === "undo") return restore(db, d.items, uid, now);
  if (d.action === "approveStyle") return approveStyle(db, d.kind, uid, now);
  return tap(db, { action: d.action, pid: d.pid, section: d.section, use: d.use, genId: d.genId, sig: d.sig }, uid, now);
});

module.exports = { bfCampaignList, bfCampaignSet, _internals: { list, tap, approveBig, many, restore, approveStyle, schedule, clearSchedule, replan, revTransaction, assertJunid } };
