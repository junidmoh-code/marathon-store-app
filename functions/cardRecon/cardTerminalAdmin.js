// ─── cardTerminalAdmin — THE TERMINAL SETTINGS SHEET'S ONLY WRITER ──────────
// Owner-only. Adds, edits, moves, retires, reinstates and replaces card terminals in
// /config/cardTerminals, through the Admin SDK — the client never writes the
// registry, so there is no client rule to get wrong and nothing to paste.
//
// Every decision about WHAT to write lives in lib/card-terminal-admin.cjs
// (pure, tested). This file reads, stamps the server clock, writes each row in
// its own transaction, and appends an audit line.
//
// PER-ROW TRANSACTIONS, NOT A READ OF THE WHOLE REGISTRY. Each action touches
// one row (replace touches two), and each row is decided against its own
// value at the moment of writing — so "refuse a TID already active" holds
// even if two phones add the same TID in the same second.
//
// THE NULL-FIRST TRAP. An RTDB transaction's first call often sees `null`
// (nothing cached) whatever the server holds. Aborting on that null would
// refuse every edit of a row that exists; so a refusal made against `null`
// commits null instead, which the server rejects if the row is really there
// and re-runs with the real value. Only a refusal against a REAL value aborts.
//
// Deploy by name, never bare:
//   firebase deploy --only functions:cardTerminalAdmin
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { randomUUID } = require("node:crypto");
const admin = require("firebase-admin");
const { CARD_TERMINALS_PATH } = require("../lib/card-recon.cjs");
const {
  planAdd, planEdit, planMove, planRetire, planReinstate, planReplace, readTypedTid,
} = require("../lib/card-terminal-admin.cjs");
const { posStores, posStoresOf } = require("../lib/pos-tills.cjs");
const { loadNetwork } = require("../lib/network-load.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// The same identity the card-recon reports are gated to.
const OWNER_EMAIL = "gunidmoh@gmail.com";
const AUDIT_PATH = "card_terminal_audit";

function assertOwner(request) {
  // A VERIFIED email, not just a matching string — an unverified account can
  // carry any address. Junid's is Google-verified (checked 21 Sept 2026).
  if (request.auth?.token?.email !== OWNER_EMAIL || request.auth?.token?.email_verified !== true) {
    throw new HttpsError("permission-denied", "Only Junid can change the card terminals.");
  }
}

// The POS's stores and tills. The STORES are the network registry's (one small
// cached node — lib/network-load.cjs), so Concrete and any store the owner adds
// can be given a terminal; each store's TILLS are its own RTDB list where one
// is seeded, the registry's where not (lib/pos-tills.cjs). One small read per
// store, never the /pos node.
async function readStores(db) {
  const registry = await loadNetwork(db);
  const configured = {};
  await Promise.all(posStoresOf(registry).map(async (s) => {
    configured[s.storeId] = (await db.ref(`pos/config/${s.storeId}/tills`).once("value")).val();
  }));
  return posStores(configured, registry);
}

// ── "IN USE FROM" — THE DAY A NEW TERMINAL ENTERED THE ESTATE ────────────────
// A terminal added today has activeFrom = now, which is right for a machine
// that arrives today. A machine that has been trading for a week before anyone
// registered it (Concrete's two tills, registered after the shop opened) needs
// the day it really started, or every batch before today reads as "this machine
// was not in the estate yet". So Add takes an optional picked DATE — a
// calendar pick, never a typed stamp — and the row's activeFrom becomes the
// start of that day in South Africa.
//
// Absent → exactly what Add always did. Malformed, impossible or in the future
// → refused, nothing written.
const SAST_OFFSET_MS = 2 * 3600e3;
function readActiveFromDate(raw, nowMs) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, ms: null };
  const m = typeof raw === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null;
  const bad = { ok: false, reason: "Pick the day this terminal came into use from the calendar." };
  if (!m) return bad;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  // Date.UTC rolls 31 Feb into March; a date that does not survive the round
  // trip is not a date.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return bad;
  const ms = utc - SAST_OFFSET_MS;
  if (ms > nowMs) return { ok: false, reason: "A terminal cannot come into use on a day that has not started yet. Pick today or an earlier day." };
  return { ok: true, ms };
}

/**
 * One row, decided and written in one transaction.
 * @returns {{ok:false, reason} | {ok:true, before, after}}
 */
async function writeRow(db, tid, decide) {
  let verdict = null;
  let before = null;
  const res = await db.ref(`${CARD_TERMINALS_PATH}/${tid}`).transaction((cur) => {
    before = cur;
    try {
      verdict = decide(cur);
    } catch (err) {
      // A bug in the planner would otherwise abort silently as "Nothing was
      // written" with no trace anywhere.
      console.error(`cardTerminalAdmin: planner threw for ${tid}:`, err && err.stack || err);
      verdict = { ok: false, reason: "That change could not be worked out — nothing was written. Tell Claude." };
    }
    if (!verdict.ok) return cur === null ? null : undefined;
    return verdict.row;
  });
  if (!verdict || !verdict.ok) return { ok: false, reason: verdict ? verdict.reason : "Nothing was written." };
  if (!res.committed) return { ok: false, reason: "The registry changed while this was saving. Nothing was written — try again." };
  return { ok: true, before, after: res.snapshot.val() };
}

async function audit(db, request, entry) {
  try {
    await db.ref(AUDIT_PATH).push({
      at: admin.database.ServerValue.TIMESTAMP,
      by: request.auth.uid, byEmail: request.auth.token.email || null,
      ...JSON.parse(JSON.stringify(entry)),
    });
  } catch (err) {
    // The registry write has landed; a missing audit line is logged, not fatal.
    console.error("cardTerminalAdmin: audit write failed:", err.message);
  }
}

async function handle(db, request, { nowMs = Date.now() } = {}) {
  const data = request.data || {};
  const now = admin.database.ServerValue.TIMESTAMP;
  const action = data.action;

  if (action === "options") return { ok: true, stores: await readStores(db) };

  // Retire and reinstate never look at a till; only the others read the POS.
  const stores = action === "retire" || action === "reinstate" ? [] : await readStores(db);
  const input = data.terminal || {};

  // nowMs (the parameter, Date.now() unless a test injects it) is the server's
  // own clock, for the decisions that compare times: a move's effective-from
  // and an Add's picked day. Never the phone's.

  if (action === "add" || action === "edit" || action === "move" || action === "retire" || action === "reinstate") {
    const tid = readTypedTid(input.tid);
    if (!tid) return { ok: false, reason: "A TID is 4 to 16 letters and digits, exactly as printed after TID: on the slip." };
    // Only Add reads the picked day; an edit never moves activeFrom.
    const from = action === "add" ? readActiveFromDate(input.activeFromDate, nowMs) : { ok: true, ms: null };
    if (!from.ok) return from;
    const plan = {
      add: (cur) => {
        const p = planAdd({ ...input, tid }, cur, { stores, now });
        return p.ok && from.ms !== null ? { ...p, row: { ...p.row, activeFrom: from.ms } } : p;
      },
      edit: (cur) => planEdit({ ...input, tid }, cur, { stores, now, nowMs }),
      move: (cur) => planMove({ ...input, tid }, cur, { stores, now, nowMs, by: request.auth?.uid }),
      retire: (cur) => planRetire({ tid }, cur, { now }),
      reinstate: (cur) => planReinstate({ tid }, cur),
    }[action];
    const out = await writeRow(db, tid, plan);
    if (!out.ok) return out;
    await audit(db, request, { action, tid, before: out.before, after: out.after });
    return { ok: true, tid, row: out.after };
  }

  if (action === "replace") {
    const oldTid = readTypedTid(data.oldTid);
    const newTid = readTypedTid(input.tid);
    if (!oldTid) return { ok: false, reason: "Pick the terminal being replaced." };
    if (!newTid) return { ok: false, reason: "The new TID is 4 to 16 letters and digits, exactly as printed after TID: on the new machine's slip." };
    const oldNow = (await db.ref(`${CARD_TERMINALS_PATH}/${oldTid}`).once("value")).val();
    // 1. The NEW row first, created only if its TID is free. It carries this
    //    call's own id, which is what the rollback below recognises it by —
    //    NOT activeFrom: a ServerValue stamp reads back from a transaction as
    //    the instance's local ESTIMATE, never the server's value, so comparing
    //    the two would miss in production and strand the row.
    const replaceId = randomUUID();
    let planned = null;
    const created = await writeRow(db, newTid, (cur) => {
      planned = planReplace({ ...input, oldTid, newTid }, oldNow, cur, { stores, now });
      return planned.ok ? { ok: true, row: { ...planned.newRow, replaceId } } : planned;
    });
    if (!created.ok) return created;
    // 2. Then retire the OLD row, decided against its value at that moment.
    //    A THROWN failure (network, timeout) is compensated exactly like a
    //    refusal — otherwise the new TID would be left active beside the old.
    let retired;
    try {
      retired = await writeRow(db, oldTid, (cur) => {
        if (!cur || cur.retiredAt !== undefined) return { ok: false, reason: `${oldTid} was retired or removed while this was saving.` };
        return { ok: true, row: { ...cur, retiredAt: now, retiredReason: "replaced", replacedBy: newTid } };
      });
    } catch (err) {
      console.error(`cardTerminalAdmin: retiring ${oldTid} failed:`, err && err.message);
      retired = { ok: false, reason: `Retiring ${oldTid} failed (${err && err.message ? err.message : "no reason"}).` };
    }
    if (!retired.ok) {
      // Undo step 1 — and ONLY the row this call created a moment ago, which
      // has no batches: removed if it is still exactly ours, left alone if
      // anything else has touched it since.
      // Null-first here too: returning undefined on the first (uncached) null
      // would abort without ever seeing the row, and leave it behind.
      await db.ref(`${CARD_TERMINALS_PATH}/${newTid}`).transaction((cur) => {
        if (cur === null) return null;
        return cur.replaceId === replaceId && cur.replaces === oldTid ? null : undefined;
      });
      return { ok: false, reason: `${retired.reason} The new terminal was not added. Nothing changed.` };
    }
    await audit(db, request, {
      action, oldTid, tid: newTid,
      before: { [oldTid]: retired.before }, after: { [oldTid]: retired.after, [newTid]: created.after },
    });
    return { ok: true, tid: newTid, oldTid, row: created.after };
  }

  throw new HttpsError("invalid-argument", "Unknown action.");
}

exports.cardTerminalAdmin = onCall(
  { region: "europe-west1", timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    assertOwner(request);
    return handle(admin.database(), request);
  },
);

// Test seam: the whole handler against an injected database.
exports._handle = handle;
exports._assertOwner = assertOwner;
exports._readActiveFromDate = readActiveFromDate;
