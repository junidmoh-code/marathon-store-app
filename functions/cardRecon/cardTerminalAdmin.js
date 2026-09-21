// ─── cardTerminalAdmin — THE TERMINAL SETTINGS SHEET'S ONLY WRITER ──────────
// Owner-only. Adds, edits, retires, reinstates and replaces card terminals in
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
const admin = require("firebase-admin");
const { CARD_TERMINALS_PATH } = require("../lib/card-recon.cjs");
const {
  planAdd, planEdit, planRetire, planReinstate, planReplace, readTypedTid,
} = require("../lib/card-terminal-admin.cjs");
const { posStores, POS_STORES } = require("../lib/pos-tills.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// The same identity the card-recon reports are gated to.
const OWNER_EMAIL = "gunidmoh@gmail.com";
const AUDIT_PATH = "card_terminal_audit";

function assertOwner(request) {
  if (request.auth?.token?.email !== OWNER_EMAIL) {
    throw new HttpsError("permission-denied", "Only Junid can change the card terminals.");
  }
}

// The POS's stores and tills — its own RTDB list per store where one is
// seeded, its shipped fallback where not (lib/pos-tills.cjs). Three small
// reads, never the /pos node.
async function readStores(db) {
  const configured = {};
  await Promise.all(POS_STORES.map(async (s) => {
    configured[s.storeId] = (await db.ref(`pos/config/${s.storeId}/tills`).once("value")).val();
  }));
  return posStores(configured);
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
    verdict = decide(cur);
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

async function handle(db, request) {
  const data = request.data || {};
  const now = admin.database.ServerValue.TIMESTAMP;
  const action = data.action;

  if (action === "options") return { ok: true, stores: await readStores(db) };

  const stores = await readStores(db);
  const input = data.terminal || {};

  if (action === "add" || action === "edit" || action === "retire" || action === "reinstate") {
    const tid = readTypedTid(input.tid);
    if (!tid) return { ok: false, reason: "A TID is 4 to 16 letters and digits, exactly as printed after TID: on the slip." };
    const plan = {
      add: (cur) => planAdd({ ...input, tid }, cur, { stores, now }),
      edit: (cur) => planEdit({ ...input, tid }, cur, { stores, now }),
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
    // 1. The NEW row first, created only if its TID is free.
    let planned = null;
    const created = await writeRow(db, newTid, (cur) => {
      planned = planReplace({ ...input, oldTid, newTid }, oldNow, cur, { stores, now });
      return planned.ok ? { ok: true, row: planned.newRow } : planned;
    });
    if (!created.ok) return created;
    // 2. Then retire the OLD row, decided against its value at that moment.
    const retired = await writeRow(db, oldTid, (cur) => {
      if (!cur || cur.retiredAt !== undefined) return { ok: false, reason: `${oldTid} was retired or removed while this was saving.` };
      return { ok: true, row: { ...cur, retiredAt: now, retiredReason: "replaced", replacedBy: newTid } };
    });
    if (!retired.ok) {
      // Undo step 1 — and ONLY the row this call created a moment ago, which
      // has no batches: removed if it is still exactly ours, left alone if
      // anything else has touched it since.
      // Null-first here too: returning undefined on the first (uncached) null
      // would abort without ever seeing the row, and leave it behind.
      const mine = created.after;
      await db.ref(`${CARD_TERMINALS_PATH}/${newTid}`).transaction((cur) => {
        if (cur === null) return null;
        return cur.replaces === oldTid && cur.activeFrom === mine.activeFrom ? null : undefined;
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
