// ─── WHICH MACHINE IS ON WHICH TILL? — READ-ONLY EVIDENCE (31 Oct 2026) ───────
// Concrete's two Standard Bank machines were labelled by hand, and the label
// may be backwards. This lays the evidence side by side for a pair of
// terminals in one store, per trading day, and says which way it points:
//
//   1. THE PAPER — the TID the background reader saw on each staff slip's
//      photo (photoRead.readTid, Standard Bank checks only). A slip filed
//      on 00000F2Y whose photo prints F1Y is the strongest single sign.
//   2. THE MONEY — each recorded batch's total against BOTH tills' POS card
//      legs over the same window: a total that matches the other till's
//      takings, day after day, and not its own.
//   3. THE LINES — when a report or photo listed transactions, how many of
//      them pair (amount, within 10 minutes) with each till's legs.
//
// It never writes. A swap, if the evidence shows one, is entered as a
// "Moved" in Card machines → settings (or by the planner, planMove), from the
// moment it took effect — never by editing a row's till in place.
//
//   node scripts/cardrecon/check-terminal-assignment.mjs                 # Concrete, last 14 days
//   node scripts/cardrecon/check-terminal-assignment.mjs --days 30
//   node scripts/cardrecon/check-terminal-assignment.mjs --store concrete --tids 00000F2Y,00000F1Y

import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const admin = adminRequire(import.meta.url)("firebase-admin");
const local = createRequire(import.meta.url);
const { canonicalTid } = local("../../functions/lib/card-terminals.cjs");
const { tillAt } = local("../../functions/lib/card-terminal-placements.cjs");

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const STORE = arg("store", "concrete");
const TIDS = arg("tids", "00000F2Y,00000F1Y").split(",").map((s) => s.trim()).filter(Boolean);
const DAYS = Math.max(1, Math.min(60, Number(arg("days", 14)) || 14));
const PAIR_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
const nowMs = Date.now() + offset;
const fromMs = nowMs - DAYS * DAY_MS;
const sast = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const rands = (c) => `R${(c / 100).toFixed(2)}`;

// One row per terminal, never the registry.
const rows = {};
for (const tid of TIDS) {
  rows[tid] = (await db.ref(`config/cardTerminals/${tid}`).once("value")).val();
  if (!rows[tid]) { console.error(`✗ ${tid} is not registered`); process.exit(1); }
}
const tills = TIDS.map((t) => tillAt(rows[t], nowMs).tillId);

// The store's POS card legs, in bounded slices of the indexed `at`.
const legs = [];
for (let s = fromMs; s < nowMs; s += 3 * DAY_MS) {
  const v = (await db.ref("pos/paymentEvents").orderByChild("at").startAt(s).endAt(Math.min(nowMs, s + 3 * DAY_MS) - 1).once("value")).val() || {};
  for (const e of Object.values(v)) if (e && e.storeId === STORE && e.method === "card") legs.push(e);
}
const legsOn = (tillId, a, b) => legs.filter((e) => e.tillId === tillId && e.at >= a && e.at < b);
const sum = (xs) => xs.reduce((n, e) => n + (Number(e.amount) || 0), 0);
console.log(`${STORE}: ${legs.length} POS card legs in the last ${DAYS} days — ${tills.map((t) => `${t} ${legs.filter((e) => e.tillId === t).length}`).join(", ")}`);

let pointsSwap = 0, pointsAsIs = 0, evidence = 0;
for (const tid of TIDS) {
  const row = rows[tid];
  const own = tillAt(row, nowMs).tillId;
  const other = tills.find((t) => t !== own);
  const otherTid = TIDS.find((t) => t !== tid);
  console.log(`\n${tid} — registered on ${row.storeId}/${own} (${row.label})`);
  const recs = (await db.ref(`card_batches/${row.storeId}/${tid}`).orderByChild("slip/closedAt").startAt(fromMs).once("value")).val() || {};
  const list = Object.entries(recs).sort((a, b) => (a[1].slip?.closedAt || 0) - (b[1].slip?.closedAt || 0));
  if (!list.length) console.log("  no batches recorded in the window");
  for (const [key, rec] of list) {
    const a = rec.slip?.openedAt, b = rec.slip?.closedAt, total = rec.slip?.totalCents;
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isInteger(total)) continue;
    const ownC = sum(legsOn(own, a, b)), otherC = other ? sum(legsOn(other, a, b)) : null;
    const notes = [];
    const paper = rec.photoRead && rec.photoRead.readTid;
    if (paper) {
      const c = canonicalTid(paper);
      if (c === canonicalTid(tid)) { notes.push(`photo prints its own TID (${paper})`); pointsAsIs++; evidence++; }
      else if (otherTid && c === canonicalTid(otherTid)) { notes.push(`PHOTO PRINTS ${otherTid}'s TID (${paper})`); pointsSwap++; evidence++; }
      else notes.push(`photo TID ${paper} is neither`);
    }
    // Money: only when the two tills' takings differ enough to tell apart.
    if (otherC !== null && Math.abs(ownC - otherC) > 500 && total > 0) {
      if (Math.abs(total - ownC) <= 500 && Math.abs(total - otherC) > 500) { notes.push("total matches its own till"); pointsAsIs++; evidence++; }
      else if (Math.abs(total - otherC) <= 500 && Math.abs(total - ownC) > 500) { notes.push(`TOTAL MATCHES ${other}`); pointsSwap++; evidence++; }
    }
    // Lines, when there are any.
    const lines = Array.isArray(rec.lines) ? rec.lines : Object.values(rec.lines || {});
    if (lines.length) {
      const pairs = (tillId) => lines.filter((l) => legsOn(tillId, a - PAIR_MS, b + PAIR_MS)
        .some((e) => e.amount === l.amountCents && Math.abs(e.at - (l.at || 0)) <= PAIR_MS)).length;
      notes.push(`lines pair: ${pairs(own)} on ${own}${other ? `, ${pairs(other)} on ${other}` : ""} of ${lines.length}`);
    }
    console.log(`  ${key}  ${sast(a)} → ${sast(b)}  slip ${rands(total)}  POS ${own} ${rands(ownC)}${other ? ` · ${other} ${rands(otherC)}` : ""}  ${notes.join("; ")}`);
  }
}
console.log(`\nVERDICT: ${evidence === 0 ? "NO EVIDENCE YET — no slip photo read and no day where the two tills' takings could be told apart."
  : pointsSwap > pointsAsIs ? `POINTS TO A SWAP (${pointsSwap} for, ${pointsAsIs} against). Enter it as a Move from the day it began.`
    : `AS REGISTERED (${pointsAsIs} for, ${pointsSwap} against a swap).`}`);
process.exit(0);
