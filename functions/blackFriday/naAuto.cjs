// ─── ALL NEW ARRIVALS ARE POSTED (Junid, 21 Nov 2026) ────────────────────────
// Every product on the Black Friday card's New Arrivals tab (past 20 days) is approved with the photo the card
// shows — its generated photo if it has one, else its current photo — through the card's own bulk Approve
// (bfCampaignSet approveMany → New Arrivals' approve / useCurrent, the pick mirrored, the website queue).
// Never approved: no price / R0, no photo, paper bags, out of stock, anything Junid rejected, anything Junid
// approved once and took back, and an upload younger than SETTLE_MS (staff still entering price, stock, photo).
// bfNaAutoApprove runs it every 10 minutes; scripts/blackFriday/naApproveAll.cjs runs it by hand (dry run first).
"use strict";

const core = require("./core.cjs");
const naLib = require("./na.cjs");
const naCore = require("../newArrivals/core.cjs");

const SETTLE_MS = 15 * 60 * 1000;
const PAPER = /paper\s*-?\s*bag/i;
const BY = "auto-new-arrivals";
const val = async (db, p) => (await db.ref(p).once("value")).val();

/** Why a New Arrivals row is not approved (null = approve it). Pure. */
function skipWhy(r, { nowMs = Date.now(), takenBack = false } = {}) {
  if (r.noPrice || !(Number(r.price) > 0)) return "no price (R0)";
  if (!r.shown) return "no photo";
  if (PAPER.test(String(r.name || ""))) return "paper bag";
  if (!(Number(r.qty) > 0)) return "out of stock";
  if (takenBack) return "approved before and taken back by Junid";
  if (r.generating) return "AI photo still being made (next run)";
  const up = Number(r.uploadedAt) || Number(String(r.pid).replace(/^p/, "")) || 0;
  if (up && nowMs - up < SETTLE_MS) return "just uploaded (next run)";
  return null;
}

/** One pass. apply: false = report only. → { onTab, toApprove, photoOf, skipped, notOnTab, approved?, refused? } */
async function run(db, { apply = false, nowMs = Date.now(), by = BY, list, many, detail = false } = {}) {
  const lanes = await naLib.windowLanes(db, nowMs);
  const v = await list(db, "main", nowMs);
  const rows = v.newArrivals || [];
  const ledgerPids = rows.length ? await Promise.all(rows.map((r) => db.ref(`${core.ROOT}/approvals/${r.pid}`).limitToFirst(1).once("value").then((s) => s.exists()))) : [];
  const sigs = {}, skipped = {};
  rows.forEach((r, i) => {
    const why = skipWhy(r, { nowMs, takenBack: ledgerPids[i] });
    if (why) { (skipped[why] ||= []).push(`${r.pid} ${r.name} R${r.price ?? 0}`); return; }
    sigs[r.pid] = r.sig || "current";
  });
  const out = {
    window: lanes.size, onTab: rows.length, toApprove: Object.keys(sigs).length,
    photoOf: { generated: Object.values(sigs).filter((s) => s !== "current").length, current: Object.values(sigs).filter((s) => s === "current").length },
    skipped: Object.fromEntries(Object.entries(skipped).map(([k, l]) => [k, detail ? l : l.length])),
  };
  if (detail) {
    const onTab = new Set(rows.map((r) => r.pid));
    const picks = (await val(db, `${core.ROOT}/picks`)) || {};
    const other = { "already approved": 0, "rejected by Junid": 0, "not on the tab (out of stock, paper bag, no photo, deleted)": [] };
    for (const [pid, lane] of lanes) {
      if (onTab.has(pid)) continue;
      const p = picks[pid];
      if ((p && p.state === "approved") || naCore.APPROVED_LANES.includes(lane)) other["already approved"]++;
      else if ((p && p.state === "rejected") || lane === "skipped" || lane === "rejected") other["rejected by Junid"]++;
      else other["not on the tab (out of stock, paper bag, no photo, deleted)"].push(pid);
    }
    out.notOnTab = other;
  }
  if (apply && out.toApprove) {
    const r = await many(db, "approve", sigs, by, nowMs);
    out.approved = r.done.length;
    out.refused = r.refused;
  }
  return out;
}

module.exports = { run, skipWhy, SETTLE_MS, BY };
