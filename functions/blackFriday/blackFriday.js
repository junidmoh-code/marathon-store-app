// ─── BLACK FRIDAY 2026 — the card's callables (Junid only) ──────────────────
// bfCampaignList  the whole campaign node (small: ~80 groups) as the card shows it.
// bfCampaignSet   one tap: approve (an item, a group, or several groups — Approve
//                 All), unapprove, untick / tick one item, choose an item's photo
//                 (current / generated), and the schedule (preview, confirm, clear).
// bfGenerate      (generate.js) one Gemini photo for one item, on Junid's tap.
// The card never reads or writes /bf_campaign_2026 directly, so no database
// rule is needed: these use the Admin SDK behind the super-admin gate.
//
// NOTHING POSTS WITHOUT A SCHEDULE (Junid, 19 Nov): the poster on the Mac mini
// posts only groups in schedule/plan, and schedule/plan exists only after
// Junid confirms a schedule here. It is recomputed after every tap that can
// change what is queued.
//
// Deploy BY NAME, never a bare --only functions (DEPLOY-TRACKER.md):
//   firebase deploy --only functions:bfCampaignList,functions:bfCampaignSet,functions:bfGenerate
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const core = require("./core.cjs");
const { isSuperAdminToken } = require("../lib/super-admins.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

// invoker "public": a callable's Cloud Run service must allow allUsers to
// invoke (auth is checked in code — assertJunid). The first deploy of these
// two failed at create and left the service with no invoker binding, so every
// call was refused at the door and the card showed only "internal" (19 Nov).
const callableOpts = { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60, invoker: "public" };
const POSTING_PAUSE = "new_arrivals/pause/posting/paused";

function assertJunid(request) {
  if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The Black Friday card is Junid's.");
}

const val = async (db, path) => (await db.ref(path).once("value")).val();

async function list(db) {
  const [node, paused] = await Promise.all([val(db, core.ROOT), val(db, POSTING_PAUSE).catch(() => null)]);
  return core.viewCampaign(node, { postingPaused: paused === true });
}

/**
 * A transaction that is safe on a Cloud Function's cold first callback: that
 * call works from a fresh read (`pre`) so a refusal or no-op is never decided
 * on a phantom empty state. Safe ONLY because the node, once written, is never
 * deleted again (every write carries `rev`): the cold write goes out expecting
 * null, so if the node exists (or changed after `pre`) the server's CAS
 * mismatches and re-runs the callback on the REAL value — a stale `pre` can
 * never bring back an undone approval. `out` is reset on every call.
 */
async function revTransaction(ref, mut, out) {
  const pre = (await ref.once("value")).val();
  return ref.transaction((cur) => {
    for (const k of Object.keys(out)) delete out[k];
    const base = cur === null ? pre : cur;
    const next = mut(base);
    return next === undefined ? undefined : core.withRev(next, base);
  });
}

/** Recompute schedule/plan from the node as it is now. No schedule → no plan → nothing posts. */
async function replan(db, nowMs) {
  const node = await val(db, core.ROOT);
  const s = node && node.schedule;
  if (!s || !s.confirmedAt) return null;
  const plan = core.planSchedule(core.queueOf(node), s, nowMs);
  await db.ref(`${core.ROOT}/schedule`).update({ plan: Object.keys(plan).length ? plan : null, planAt: nowMs });
  return plan;
}

async function groupPhotos(db, group) {
  const pids = Object.keys((group && group.items) || {});
  const rows = await Promise.all(pids.map((pid) => val(db, `${core.ROOT}/photos/${pid}`)));
  return Object.fromEntries(pids.map((pid, i) => [pid, rows[i]]).filter(([, v]) => v));
}

const log = (db, row) => db.ref(`${core.ROOT}/decisions`).push().set(row);

async function setOne(db, { action, key, pid, use, genId }, uid, nowMs, { replanAfter = true } = {}) {
  if (!core.KEY_RE.test(String(key || ""))) throw new HttpsError("invalid-argument", "Which group?");
  const [group, post] = await Promise.all(["groups", "posts"].map((p) => val(db, `${core.ROOT}/${p}/${key}`)));
  if (!group) throw new HttpsError("not-found", `${key} is not in today's groups.`);
  const needsPid = ["approveItem", "exclude", "include", "use"].includes(action);
  if (needsPid && (!core.PID_RE.test(String(pid || "")) || !(group.items || {})[pid])) throw new HttpsError("invalid-argument", "That item is not in this group.");
  const out = {};

  if (action === "use") {
    if (!["current", "generated"].includes(use)) throw new HttpsError("invalid-argument", "Use the current photo or a generated one.");
    if (genId !== undefined && genId !== null && !core.GEN_RE.test(String(genId))) throw new HttpsError("invalid-argument", "Which generated photo?");
    const res = await revTransaction(db.ref(`${core.ROOT}/photos/${pid}`), core.useMutator({ use, genId: genId || null }, out), out);
    if (out.refusal) return { key, ok: false, refusal: out.refusal };
    if (res.committed && !out.noop) await log(db, { at: nowMs, by: uid || null, action, key, pid, use, ...(genId ? { genId } : {}) });
  } else {
    const photos = await groupPhotos(db, group);
    let mut;
    if (action === "approve") mut = core.approveMutator({ group, post, uid, nowMs, photos }, out);
    else if (action === "approveItem") mut = core.approveMutator({ group, post, uid, nowMs, photos, pid }, out);
    else if (action === "unapprove") mut = core.unapproveMutator({ post }, out);
    else if (action === "exclude" || action === "include") mut = core.tickMutator({ pid, include: action === "include", post }, out);
    else throw new HttpsError("invalid-argument", "approve, approveItem, unapprove, exclude, include or use.");
    const res = await revTransaction(db.ref(`${core.ROOT}/state/${key}`), mut, out);
    if (out.refusal) return { key, ok: false, refusal: out.refusal };
    if (res.committed && !out.noop) {
      await log(db, { at: nowMs, by: uid || null, action, key, ...(pid ? { pid } : {}), ...(out.lap ? { lap: out.lap } : {}) });
    }
  }
  if (replanAfter && !out.noop) await replan(db, nowMs);
  const [state, photos, plan] = await Promise.all([val(db, `${core.ROOT}/state/${key}`), groupPhotos(db, group), val(db, `${core.ROOT}/schedule/plan/${key}`)]);
  return { key, ok: true, noop: !!out.noop, unapproved: !!out.unapproved, group: core.viewGroup(key, group, state, post, photos, plan) };
}

/** The schedule: preview (nothing written) or confirm (written, plan computed). */
async function schedule(db, raw, { confirm }, uid, nowMs) {
  const s = core.cleanSchedule(raw, nowMs);
  if (s.error) return { ok: false, refusal: s.error };
  const node = await val(db, core.ROOT);
  const plan = core.planSchedule(core.queueOf(node), s, nowMs);
  const queued = core.queueOf(node).length;
  if (!confirm) return { ok: true, preview: true, schedule: s, plan, queued };
  await db.ref(`${core.ROOT}/schedule`).set({ ...s, confirmedAt: nowMs, confirmedBy: uid || null, plan: Object.keys(plan).length ? plan : null, planAt: nowMs });
  await log(db, { at: nowMs, by: uid || null, action: "schedule", mode: s.mode });
  return { ok: true, schedule: s, plan, queued };
}

async function clearSchedule(db, uid, nowMs) {
  await db.ref(`${core.ROOT}/schedule`).remove();
  await log(db, { at: nowMs, by: uid || null, action: "clearSchedule" });
  return { ok: true, cleared: true };
}

const bfCampaignList = onCall(callableOpts, async (request) => {
  assertJunid(request);
  return list(admin.database());
});

const bfCampaignSet = onCall(callableOpts, async (request) => {
  assertJunid(request);
  const d = request.data || {};
  const db = admin.database();
  const uid = request.auth && request.auth.uid;
  if (d.action === "schedule") return schedule(db, d.schedule, { confirm: d.confirm === true }, uid, Date.now());
  if (d.action === "clearSchedule") return clearSchedule(db, uid, Date.now());
  if (d.action === "approve" && Array.isArray(d.keys)) {
    if (d.keys.length > 200) throw new HttpsError("invalid-argument", "Too many groups at once.");
    const results = [];
    // One at a time, a millisecond apart, so Approve All keeps price order in the queue; one replan at the end.
    let t = Date.now();
    for (const key of d.keys) results.push(await setOne(db, { action: "approve", key }, uid, t++, { replanAfter: false }));
    await replan(db, Date.now());
    return { ok: true, results };
  }
  return setOne(db, { action: d.action, key: d.key, pid: d.pid, use: d.use, genId: d.genId }, uid, Date.now());
});

module.exports = { bfCampaignList, bfCampaignSet, _internals: { list, setOne, schedule, clearSchedule, replan, revTransaction, assertJunid } };
