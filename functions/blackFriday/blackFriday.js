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
const callableOpts = { region: "europe-west1", memory: "512MiB", timeoutSeconds: 120, invoker: "public" };
const POSTING_PAUSE = "new_arrivals/pause/posting/paused";

function assertJunid(request) {
  if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The Black Friday card is Junid's.");
}

const val = async (db, path) => (await db.ref(path).once("value")).val();

/** One section, read narrowly: that section's products and the small decision nodes (never `decisions`). */
async function list(db, section = "main") {
  if (!core.SECTIONS.includes(section)) throw new HttpsError("invalid-argument", "main or under.");
  const parts = ["meta", `items/${section}`, "picks", "photos", "posted", "styles", "stats", "schedule"];
  const [vals, paused] = await Promise.all([
    Promise.all(parts.map((p) => val(db, `${core.ROOT}/${p}`))),
    val(db, POSTING_PAUSE).catch(() => null),
  ]);
  const node = { meta: vals[0], items: { [section]: vals[1] }, picks: vals[2], photos: vals[3], posted: vals[4], styles: vals[5], stats: vals[6], schedule: vals[7] };
  return core.viewSection(node, section, { postingPaused: paused === true });
}

/** A transaction safe on a Cloud Function's cold first callback (the node is never deleted: core.withRev). */
async function revTransaction(ref, mut, out) {
  const pre = (await ref.once("value")).val();
  return ref.transaction((cur) => {
    for (const k of Object.keys(out)) delete out[k];
    const base = cur === null ? pre : cur;
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

async function tap(db, { action, pid, section, use, genId }, uid, nowMs) {
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
    await revTransaction(pickRef, core.approveMutator({ item, section: sec, photo, uid, nowMs }, out), out);
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
  return { ok: true, pid, noop: !!out.noop, rejected: core.isRejected(pick), row: item ? core.viewItem(pid, item, { pick, photo, posted, styles: styles || {}, nowMs }) : null };
}

/** "Approve all 30+": every MAIN product with 30+ on hand still in To review (not rejected, not approved). */
async function approveBig(db, uid, nowMs) {
  const [items, picks, photos] = await Promise.all(["items/main", "picks", "photos"].map((p) => val(db, `${core.ROOT}/${p}`)));
  const todo = Object.entries(items || {}).filter(([pid, it]) => it && Number(it.qty) >= core.BIG_QTY && !(picks || {})[pid]?.state);
  const upd = {};
  for (const [pid, it] of todo) {
    upd[`picks/${pid}`] = core.withRev({ state: "approved", sig: core.sigOf((photos || {})[pid]), at: nowMs, by: uid || null, section: "main", price: it.price, kind: it.kind || "clothing", name: it.name || "", sizes: it.sizes || "" }, (picks || {})[pid]);
  }
  // One multi-path write over products nobody has touched; the plan re-checks each photo signature, so nothing posts unseen.
  if (todo.length) {
    await db.ref(core.ROOT).update(upd);
    await log(db, { at: nowMs, by: uid || null, action: "approveBig", count: todo.length });
    await replan(db, nowMs);
  }
  return { ok: true, approved: todo.length };
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
  if (d.action === "approveBig") return approveBig(db, uid, now);
  if (d.action === "approveStyle") return approveStyle(db, d.kind, uid, now);
  return tap(db, { action: d.action, pid: d.pid, section: d.section, use: d.use, genId: d.genId }, uid, now);
});

module.exports = { bfCampaignList, bfCampaignSet, _internals: { list, tap, approveBig, approveStyle, schedule, clearSchedule, replan, revTransaction, assertJunid } };
