// ─── ONE TILL, ONE IDENTITY — the read-only audit ───────────────────────────
// Junid, 18 Oct 2026: Card Recon showed two "PE · Till 2" cards. The cause
// was the POS drawing a staff slip as its own card (fixed in the POS), not a
// second key — but the question "is anything filed under a till/terminal key
// Card Recon cannot place?" deserves a standing answer. This prints one.
//
// READS ONLY, all bounded: the registry (/config/cardTerminals), the POS
// tills (/network), the staff-slip log and Unread markers (small owner
// nodes), each terminal's last 40 batch records, the read jobs of the last
// N days (by push-key range), shallow key lists of /card_batches, and the
// slip scope of every person who ever sent a staff slip.
//
//   node scripts/cardrecon/audit-till-identity.mjs [--days 30]
//
// Exit 0 = every key resolves to a registered terminal on a POS till; 1 = a
// finding (printed). Nothing is written, ever.

import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const req = adminRequire(import.meta.url);
const admin = req("firebase-admin");
const { GoogleAuth } = req("google-auth-library");
const restAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/firebase.database"] });
const local = createRequire(import.meta.url);
const { tillAt, terminalPlacements } = local("../../functions/lib/card-terminal-placements.cjs");
const { readSlipScope } = local("../../functions/lib/card-slip-scope.cjs");
const { loadNetwork } = local("../../functions/lib/network-load.cjs");
const { tillsFor } = local("../../functions/lib/network-registry.cjs");

const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 30;

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club", databaseURL: DB_URL });
const db = admin.database();
const val = async (p) => (await db.ref(p).once("value")).val();
const nowMs = Date.now() + ((await val(".info/serverTimeOffset")) || 0);
const sinceMs = nowMs - DAYS * 24 * 60 * 60 * 1000;

// Shallow key list over REST (the Admin SDK has no shallow read).
async function shallowKeys(path) {
  const token = await restAuth.getAccessToken();
  const res = await fetch(`${DB_URL}/${path}.json?shallow=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`shallow ${path}: HTTP ${res.status}`);
  return Object.keys((await res.json()) || {});
}

const findings = [];
const flag = (msg) => { findings.push(msg); console.log(`  ✗ ${msg}`); };

const terminals = (await val("config/cardTerminals")) || {};
const network = await loadNetwork(db, { fresh: true });
const posHasTill = (s, t) => tillsFor(network, s).some((x) => x.tillId === t);

console.log(`Registry: ${Object.keys(terminals).length} terminals. POS tills checked against /network.`);
for (const [tid, row] of Object.entries(terminals)) {
  const pl = terminalPlacements(row);
  const here = tillAt(row, nowMs);
  console.log(`  ${tid} filed ${row.storeId}/${row.tillId}; stands at ${here.storeId}/${here.tillId} "${here.label}"${row.retiredAt ? " (retired)" : ""}`);
  for (const p of [{ storeId: row.storeId, tillId: row.tillId }, ...pl]) {
    if (!posHasTill(p.storeId, p.tillId)) flag(`${tid}: ${p.storeId}/${p.tillId} is not a POS till`);
  }
}
// Two live machines standing at one till now = two cards for one till.
const standing = new Map();
for (const [tid, row] of Object.entries(terminals)) {
  if (row.retiredAt) continue;
  const h = tillAt(row, nowMs);
  const k = `${h.storeId}/${h.tillId}`;
  if (standing.has(k)) flag(`${k}: ${standing.get(k)} and ${tid} both stand here now`);
  standing.set(k, tid);
}

console.log("\n/card_batches keys:");
for (const store of await shallowKeys("card_batches")) {
  for (const tid of await shallowKeys(`card_batches/${store}`)) {
    const row = terminals[tid];
    if (!row) { flag(`card_batches/${store}/${tid}: no such terminal in the registry`); continue; }
    if (row.storeId !== store) { flag(`card_batches/${store}/${tid}: the registry files ${tid} under ${row.storeId}`); continue; }
    const recent = (await db.ref(`card_batches/${store}/${tid}`).orderByKey().limitToLast(40).once("value")).val() || {};
    let n = 0;
    for (const [key, rec] of Object.entries(recent)) {
      const at = rec?.slip?.closedAt ?? rec?.submittedAt;
      if (!Number.isFinite(at) || at < sinceMs) continue;
      n++;
      if (rec.tid && rec.tid !== tid) flag(`card_batches/${store}/${tid}/${key}: record says tid ${rec.tid}`);
      if (rec.storeId && rec.storeId !== store) flag(`card_batches/${store}/${tid}/${key}: record says store ${rec.storeId}`);
      if (rec.tillId && !posHasTill(tillAt(row, at).storeId, rec.tillId)) flag(`card_batches/${store}/${tid}/${key}: till ${rec.tillId} is not a POS till`);
    }
    console.log(`  ${store}/${tid}: ${n} record(s) in the last ${DAYS} days`);
  }
}

console.log("\nStaff-slip log and Unread markers:");
const slipUids = new Set();
for (const [node, label] of [["card_batch_overrides/staff_slips", "staff slip"], ["card_batch_overrides/unread", "unread"]]) {
  const tree = (await val(node)) || {};
  for (const [store, byTid] of Object.entries(tree)) {
    for (const [tid, byDay] of Object.entries(byTid || {})) {
      const row = terminals[tid];
      if (!row || row.storeId !== store) flag(`${node}/${store}/${tid}: not a registered terminal filed under ${store}`);
      for (const [day, v] of Object.entries(byDay || {})) {
        const entries = label === "staff slip" ? Object.values(v || {}) : [v];
        for (const e of entries) {
          if (!e || typeof e !== "object") continue;
          if (e.byUid) slipUids.add(e.byUid);
          const place = e.placeStoreId || store;
          if (e.tillId && !posHasTill(place, e.tillId)) flag(`${node}/${store}/${tid}/${day}: till ${place}/${e.tillId} is not a POS till`);
        }
        console.log(`  ${label} ${store}/${tid}/${day}`);
      }
    }
  }
}

console.log(`\nRead jobs since ${new Date(sinceMs).toISOString().slice(0, 10)}:`);
// A push key's first 8 characters are its time; this is the key of `sinceMs`.
const PUSH = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
let t = sinceMs, startKey = "";
for (let i = 0; i < 8; i++) { startKey = PUSH[t % 64] + startKey; t = Math.floor(t / 64); }
const jobs = (await db.ref("card_batch_jobs").orderByKey().startAt(startKey).once("value")).val() || {};
for (const [id, j] of Object.entries(jobs)) {
  const row = terminals[j.pickedTid];
  if (!row || row.storeId !== j.storeId) flag(`job ${id}: ${j.storeId}/${j.pickedTid} is not a registered terminal`);
  if (!posHasTill(j.placeStoreId || j.storeId, j.placeTillId || j.tillId)) flag(`job ${id}: till ${j.placeStoreId}/${j.placeTillId} is not a POS till`);
}
console.log(`  ${Object.keys(jobs).length} job(s) checked`);

console.log("\nSlip scopes of everyone who sent a staff slip:");
for (const uid of slipUids) {
  const scope = readSlipScope(await val(`users/${uid}/cardSlipTills`));
  for (const key of scope) {
    const [s, tl] = key.split("/");
    if (!posHasTill(s, tl)) flag(`users/${uid}: ${key} is not a POS till`);
    else if (![...standing.keys()].includes(key)) flag(`users/${uid}: ${key} has no card machine standing at it`);
  }
  console.log(`  ${uid}: ${scope.join(", ") || "(none)"}`);
}

console.log(findings.length ? `\n${findings.length} finding(s).` : "\nNo orphan keys: every record, slip, job and scope resolves to one registered terminal on one POS till.");
process.exit(findings.length ? 1 : 0);
