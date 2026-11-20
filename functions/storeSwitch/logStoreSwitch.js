// ─── STORE SWITCH AUDIT — logStoreSwitch (callable) ─────────────────────────
// Junid, 20 Nov 2026: every staff user may work in all four shops; every
// switch of the active shop (src/utils/activeStore.js) is written here, once,
// append-only:
//
//   /store_switch_log/{saDate}/{pushId} =
//     { uid, name, from, to, home, reason, deviceId, at, clientAtMs }
//   /store_switch_log_count/{saDate}/{uid} = n   (cap MAX_PER_DAY)
//
// The CLIENT never writes this path (no rule grants it): the server takes the
// uid from the auth token and the name + home shop from /users/{uid} (two leaf
// reads), so the audit line cannot be forged. `at` is the server's clock
// (ServerValue.TIMESTAMP); `clientAtMs` is the device's serverNowMs() at the
// tap, kept for queued lines that are flushed later. Bounded: one push per
// call, every string clipped, nothing read beyond two leaves and the registry.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { storesOf } = require("../lib/network-registry.cjs");
const { loadNetwork } = require("../lib/network-load.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const REASONS = ["switch", "back-home", "daily-reset", "fresh-login", "sign-out", "rehomed"];
// Per account per SA day. A person switches a handful of times a day; this
// only stops a runaway or hostile client from filling the log.
const MAX_PER_DAY = 200;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
const saDateOf = (ms) => new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);
const clip = (v, n) => (typeof v === "string" && v ? v.slice(0, n) : null);

// Pure: validate and shape one entry. Returns { ok, entry } or { ok:false, code }.
function buildSwitchEntry({ uid, userRec, data, shopIds, nowMs }) {
  const d = data && typeof data === "object" ? data : {};
  const shop = (v) => (v == null ? null : (typeof v === "string" && shopIds.includes(v) ? v : undefined));
  const from = shop(d.from);
  const to = shop(d.to);
  if (from === undefined || to === undefined) return { ok: false, code: "unknown-shop" };
  if (from === to) return { ok: false, code: "no-change" };
  if (!REASONS.includes(d.reason)) return { ok: false, code: "bad-reason" };
  const home = typeof userRec?.destShop === "string" && userRec.destShop ? userRec.destShop : null;
  const clientAtMs = Number.isFinite(d.clientAtMs) ? Math.round(d.clientAtMs) : null;
  // A queued line is filed under the day it happened (its clientAtMs), unless
  // that claims a day more than 2 days away from the server's — then today.
  const dayMs = clientAtMs && Math.abs(nowMs - clientAtMs) < 2 * 86400000 ? clientAtMs : nowMs;
  return {
    ok: true,
    saDate: saDateOf(dayMs),
    entry: {
      uid,
      name: clip(userRec?.displayName, 80) || clip(userRec?.username, 80) || null,
      from, to, home,
      reason: d.reason,
      deviceId: clip(d.deviceId, 64),
      clientAtMs,
    },
  };
}

exports.buildSwitchEntry = buildSwitchEntry;

// IO: two leaf reads + the registry, then ONE push. `at` is injected so the
// callable passes ServerValue.TIMESTAMP and tests pass a number.
async function runLogStoreSwitch(db, { uid, email, data, nowMs, at }) {
  const leaf = (k) => db.ref(`users/${uid}/${k}`).once("value").then((s) => s.val());
  const [displayName, username, destShop, network] = await Promise.all([
    leaf("displayName"), leaf("username"), leaf("destShop"), loadNetwork(db),
  ]);
  const shopIds = storesOf(network).map((l) => l.id);
  const built = buildSwitchEntry({ uid, userRec: { displayName, username, destShop }, data, shopIds, nowMs });
  if (!built.ok) return built;
  // Bounded: one counter leaf per account per day, claimed in a transaction.
  const tx = await db.ref(`store_switch_log_count/${built.saDate}/${uid}`)
    .transaction((n) => ((Number(n) || 0) >= MAX_PER_DAY ? undefined : (Number(n) || 0) + 1));
  if (!tx.committed) return { ok: false, code: "rate-limited" };
  const entry = { ...built.entry, name: built.entry.name || clip(email, 80), at };
  // A client id makes a resend of a queued line idempotent: written once,
  // never overwritten. No (or a malformed) id → a fresh push key.
  const ref = ID_RE.test(String(data?.id || ""))
    ? db.ref(`store_switch_log/${built.saDate}/${data.id}`)
    : db.ref(`store_switch_log/${built.saDate}`).push();
  const res = await ref.transaction((cur) => (cur ? undefined : entry));
  return { ok: true, id: ref.key, saDate: built.saDate, duplicate: !res.committed };
}
exports.runLogStoreSwitch = runLogStoreSwitch;

exports.logStoreSwitch = onCall(
  { region: "europe-west1", timeoutSeconds: 20, memory: "256MiB" },
  async (request) => {
    const provider = request.auth?.token?.firebase?.sign_in_provider;
    if (!request.auth || provider === "anonymous") {
      throw new HttpsError("unauthenticated", "Sign-in required.");
    }
    const out = await runLogStoreSwitch(admin.database(), {
      uid: request.auth.uid,
      email: request.auth.token?.email || null,
      data: request.data,
      nowMs: Date.now(),
      at: admin.database.ServerValue.TIMESTAMP,
    });
    if (!out.ok) throw new HttpsError(out.code === "rate-limited" ? "resource-exhausted" : "invalid-argument", out.code);
    return { ok: true, id: out.id };
  }
);
