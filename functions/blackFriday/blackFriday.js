// ─── BLACK FRIDAY 2026 — the card's two callables (Junid only) ──────────────
// bfCampaignList  the whole campaign node (small: ~60 groups) as the card shows it.
// bfCampaignSet   one tap: approve (one key or several — Approve All), unapprove,
//                 untick / tick one item.
// The card never reads or writes /bf_campaign_2026 directly, so no database
// rule is needed: these use the Admin SDK behind the super-admin gate.
// Posting, pacing and the send-time stock re-check are the Mac mini's
// (marathon-group-poster bin/bf-post.mjs through the existing WhatsApp poster).
//
// Deploy BY NAME, never a bare --only functions (DEPLOY-TRACKER.md):
//   firebase deploy --only functions:bfCampaignList,functions:bfCampaignSet
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const core = require("./core.cjs");
const { isSuperAdminToken } = require("../lib/super-admins.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const callableOpts = { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 };

function assertJunid(request) {
  if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The Black Friday card is Junid's.");
}

async function list(db) {
  const node = (await db.ref(core.ROOT).once("value")).val();
  return core.viewCampaign(node);
}

async function setOne(db, { action, key, pid }, uid, nowMs) {
  if (!core.KEY_RE.test(String(key || ""))) throw new HttpsError("invalid-argument", "Which group?");
  const [group, post] = await Promise.all(["groups", "posts"].map((p) => db.ref(`${core.ROOT}/${p}/${key}`).once("value").then((s) => s.val())));
  if (!group) throw new HttpsError("not-found", `${key} is not in today's groups.`);
  const out = {};
  let mut;
  if (action === "approve") mut = core.approveMutator({ group, post, uid, nowMs }, out);
  else if (action === "unapprove") mut = core.unapproveMutator({ post }, out);
  else if (action === "exclude" || action === "include") {
    if (!core.PID_RE.test(String(pid || "")) || !(group.items || {})[pid]) throw new HttpsError("invalid-argument", "That item is not in this group.");
    mut = core.tickMutator({ pid, include: action === "include", group, post }, out);
  } else throw new HttpsError("invalid-argument", "approve, unapprove, exclude or include.");
  // A Cloud Function's first transaction callback sees null (no local cache):
  // that call works from a fresh read instead, so a refusal or no-op is never
  // decided on a phantom empty state; the server's CAS re-runs it on the real
  // value if they differ. `out` is reset on every call.
  const ref = db.ref(`${core.ROOT}/state/${key}`);
  const pre = (await ref.once("value")).val();
  const res = await ref.transaction((cur) => {
    for (const k of Object.keys(out)) delete out[k];
    return mut(cur === null ? pre : cur);
  });
  if (out.refusal) return { key, ok: false, refusal: out.refusal };
  if (res.committed && !out.noop) {
    await db.ref(`${core.ROOT}/decisions`).push().set({ at: nowMs, by: uid || null, action, key, ...(pid ? { pid } : {}), ...(out.lap ? { lap: out.lap } : {}) });
  }
  const state = res.snapshot ? res.snapshot.val() : null;
  return { key, ok: true, noop: !!out.noop, unapproved: !!out.unapproved, group: core.viewGroup(key, group, state, post) };
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
  if (d.action === "approve" && Array.isArray(d.keys)) {
    if (d.keys.length > 200) throw new HttpsError("invalid-argument", "Too many groups at once.");
    const results = [];
    // One at a time, a millisecond apart, so Approve All keeps price order in the queue.
    let t = Date.now();
    for (const key of d.keys) results.push(await setOne(db, { action: "approve", key }, uid, t++));
    return { ok: true, results };
  }
  return setOne(db, { action: d.action, key: d.key, pid: d.pid }, uid, Date.now());
});

module.exports = { bfCampaignList, bfCampaignSet, _internals: { list, setOne, assertJunid } };
