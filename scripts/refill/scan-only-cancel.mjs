// ─── ONE-OFF: cancel what the on-hold and website paths raised (Junid, 1 Nov 2026) ─
//
// Junid ruled the refill scan the ONLY requester. The on-hold path
// (createdFrom.via "on_hold") and the website-order escalation ("online_escalation")
// no longer write requests (App.jsx, scripts/shopify/onlineOrders/escalate.mjs).
// This cancels the OPEN rows they already wrote — the ones the scan would NOT
// have raised — and lists the rest.
//
// "The scan would have raised it" = the engine's own resolveTarget gives the
// requesting cell a target above zero AND on hand + every OTHER open request to
// that cell is below it. Those are left open (cancelling one would only make
// the next scan raise the same units again) and listed as kept.
//
// A cancel happens by transaction, only while the row is untouched (open, no
// sentQty, no pick claimed, no fulfil). cancelReason:
//   online_escalation → "no_longer_needed"  (what onlinePiece.mjs writes, so the
//                        website poller's chain-stop reads it as already withdrawn)
//   on_hold           → "hold_released"     (what releasing a hold writes)
// plus scanOnlyCancelled {at, run}. The escalation's Hub 2 → shop "Shop Refill
// cards" (/orders R###-1 carrying onlineEscalationKey) get the same test; an
// untouched one the scan would not have raised is REMOVED, exactly as
// onlinePiece.mjs removes an untouched card (a card has no "cancelled" state).
// The website poller's chain-stop never touches either — this script decides.
//
//   node scripts/refill/scan-only-cancel.mjs            dry run: the before list
//   node scripts/refill/scan-only-cancel.mjs --apply    cancel (refuses above 50)
//
// Rollback: ~/marathon-rollbacks/scan-only-<date>.json holds every row as it
// was; --rollback FILE puts back the ones still cancelled by THIS run.

import { createRequire } from "module";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const engine = require(join(ROOT, "functions/lib/refill-engine.cjs"));
const { stockCellKey } = require(join(ROOT, "functions/lib/admin-movement.cjs"));
const { loadNetwork } = require(join(ROOT, "functions/lib/network-load.cjs"));

export const MAX_CANCELS = 50;   // Junid's stop line
const VIAS = new Set(["on_hold", "online_escalation"]);
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const RB = argv.includes("--rollback") ? argv[argv.indexOf("--rollback") + 1] : null;

const admin = adminRequire(import.meta.url)("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const val = async (p) => (await db.ref(p).once("value")).val() || {};
const nowMs = Date.now();
const runId = `scan-only-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}`;

const untouched = (r) => r && r.status === "open" && !(Number(r.sentQty) > 0) && !r.picking && !r.fulfilledBy;

try {
  if (RB) {
    const saved = JSON.parse(readFileSync(RB, "utf8"));
    let n = 0;
    for (const [id, before] of Object.entries(saved.rows || {})) {
      const res = await db.ref(`refill_requests/${id}`).transaction((cur) => {
        if (cur == null) return null;
        if (cur.scanOnlyCancelled?.run !== saved.runId) return undefined;   // someone else changed it since
        return before;
      });
      if (res.committed && res.snapshot.val()?.status === before.status) n++;
    }
    let m = 0;
    for (const [k, card] of Object.entries(saved.cards || {})) {
      const res = await db.ref(`orders/${k}`).transaction((cur) => (cur == null ? card : undefined));
      if (res.committed) m++;
    }
    console.log(`rolled back ${n} of ${Object.keys(saved.rows || {}).length} request(s), ${m} of ${Object.keys(saved.cards || {}).length} card(s)`);
  } else {
    const [config, products, targets, refillRequests, orders] = await Promise.all([
      val("config/refillEngine"), val("products"), val("stock_targets"), val("refill_requests"), val("orders"),
    ]);
    const network = await loadNetwork(db, { nowMs });
    const stockOf = new Map();
    const stockAt = async (loc) => { if (!stockOf.has(loc)) stockOf.set(loc, await val(`stock/${loc}`)); return stockOf.get(loc); };
    const name = (pid) => products[pid]?.name || pid;
    const rows = [];
    for (const [id, r] of Object.entries(refillRequests)) {
      const via = r?.createdFrom?.via;
      if (!r || r.status !== "open" || !VIAS.has(via)) continue;
      const dest = r.requestingLocation, ck = stockCellKey(r.size);
      const stock = { [dest]: await stockAt(dest) };
      let t = null;
      try { t = engine.resolveTarget({ targets, config, products, stock, network }, dest, r.productId, r.size); } catch { t = null; }
      const onHand = Math.max(0, Number(stock[dest]?.[r.productId]?.[ck]?.qty) || 0);
      const otherInbound = Object.entries(refillRequests)
        .filter(([k, x]) => k !== id && x && x.status === "open" && x.requestingLocation === dest && x.productId === r.productId && stockCellKey(x.size) === ck)
        .reduce((s, [, x]) => s + (Number(x.qty) || 0), 0);
      const target = t ? Number(t.target) || 0 : 0;
      const scanWould = target > 0 && onHand + otherInbound < target;
      rows.push({ id, via, dest, from: r.createdFrom?.source || null, product: name(r.productId), size: r.size, qty: Number(r.qty) || 0,
        createdAt: r.createdAt, target: t ? target : null, onHand, otherInbound, scanWould, untouched: untouched(r),
        ref: r.createdFrom?.ref || r.onlineRef || (r.createdFrom?.orderId ? `hold #${r.createdFrom.orderId}` : null) });
    }
    const cardUntouched = (o) => o && o.status === "incoming" && o.clothingRefillStatus == null && o.clothingPlanGen == null;
    const cards = [];
    for (const [k, o] of Object.entries(orders)) {
      if (!o || !o.onlineEscalationKey) continue;
      const dest = o.destShop, ck = stockCellKey(o.size);
      const stock = { [dest]: await stockAt(dest) };
      let t = null;
      try { t = engine.resolveTarget({ targets, config, products, stock, network }, dest, o.productId, o.size); } catch { t = null; }
      const onHand = Math.max(0, Number(stock[dest]?.[o.productId]?.[ck]?.qty) || 0);
      const otherInbound = Object.values(refillRequests).filter((x) => x && x.status === "open" && x.requestingLocation === dest && x.productId === o.productId && stockCellKey(x.size) === ck).reduce((s2, x) => s2 + (Number(x.qty) || 0), 0)
        + Object.entries(orders).filter(([k2, x]) => k2 !== k && x && x.customerName === "Shop Refill" && x.status === "incoming" && x.clothingRefillStatus == null && x.destShop === dest && x.productId === o.productId && stockCellKey(x.size) === ck).reduce((s2, [, x]) => s2 + (Number(x.qty) || 0), 0);
      const target = t ? Number(t.target) || 0 : 0;
      cards.push({ key: k, product: o.productName || name(o.productId), size: o.size, qty: Number(o.qty) || 0, from: o.hub, to: dest, status: o.status,
        answered: o.clothingRefillStatus ?? null, ref: o.onlineRef || null, target: t ? target : null, onHand, otherInbound,
        scanWould: target > 0 && onHand + otherInbound < target, untouched: cardUntouched(o) });
    }
    const toCancel = rows.filter((r) => !r.scanWould && r.untouched);
    const cardsToRemove = cards.filter((c) => !c.scanWould && c.untouched);
    const table = (list) => list.map((r) => `  ${r.id.padEnd(24)} ${r.via.padEnd(18)} ${String(r.from)}→${r.dest} ${r.product} · ${r.size} ×${r.qty} · target ${r.target ?? "none"} · on hand ${r.onHand} + inbound ${r.otherInbound} · ${r.scanWould ? "SCAN WOULD RAISE → kept" : r.untouched ? "cancel" : "being worked → left"} · ${r.ref || ""}`).join("\n");
    console.log(`BEFORE — ${rows.length} open request(s) from the on-hold / website paths:\n${table(rows) || "  (none)"}`);
    console.log(`BEFORE — ${cards.length} website Shop Refill card(s) on /orders:\n${cards.map((c) => `  ${c.key.padEnd(10)} ${c.from}→${c.to} ${c.product} · ${c.size} ×${c.qty} · ${c.status}${c.answered ? ` (${c.answered})` : ""} · target ${c.target ?? "none"} · on hand ${c.onHand} + inbound ${c.otherInbound} · ${c.scanWould ? "SCAN WOULD RAISE → kept" : c.untouched ? "remove" : "answered/being worked → left"} · ${c.ref || ""}`).join("\n") || "  (none)"}`);
    const total = toCancel.length + cardsToRemove.length;
    console.log(`to cancel: ${toCancel.length} request(s) + ${cardsToRemove.length} card(s)`);
    if (total > MAX_CANCELS) { console.log(`STOP: ${total} is above Junid's ${MAX_CANCELS}. Nothing written.`); process.exitCode = 3; }
    else if (!APPLY) console.log("dry run — nothing written (add --apply)");
    else if (total) {
      const dir = join(homedir(), "marathon-rollbacks");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `scan-only-${new Date(nowMs + 2 * 3600e3).toISOString().slice(0, 10)}.json`);
      const saved = { runId, at: new Date(nowMs).toISOString(), rows: Object.fromEntries(toCancel.map((r) => [r.id, refillRequests[r.id]])),
        cards: Object.fromEntries(cardsToRemove.map((c) => [c.key, orders[c.key]])) };
      writeFileSync(file, JSON.stringify(saved, null, 2));
      const nowIso = new Date(nowMs).toISOString();
      const done = [];
      for (const r of toCancel) {
        const res = await db.ref(`refill_requests/${r.id}`).transaction((cur) => {
          if (cur == null) return null;
          if (!untouched(cur)) return undefined;
          return { ...cur, status: "cancelled", cancelReason: r.via === "on_hold" ? "hold_released" : "no_longer_needed", resolvedAt: nowIso,
            scanOnlyCancelled: { at: nowIso, run: runId } };
        });
        done.push({ ...r, cancelled: !!(res.committed && res.snapshot.val()?.scanOnlyCancelled?.run === runId) });
      }
      for (const c of cardsToRemove) {
        const res = await db.ref(`orders/${c.key}`).transaction((cur) => {
          if (cur == null) return null;
          if (!cardUntouched(cur) || cur.onlineEscalationKey !== orders[c.key].onlineEscalationKey) return undefined;
          return null;
        });
        console.log(`  card ${c.key}: ${res.committed && res.snapshot.val() == null ? "removed" : "left (changed since)"}`);
      }
      console.log(`rollback file: ${file}`);
      const after = (await Promise.all(toCancel.map(async (r) => [r.id, (await db.ref(`refill_requests/${r.id}/status`).once("value")).val()])));
      console.log(`AFTER:\n${after.map(([id, st]) => `  ${id} → ${st}`).join("\n")}`);
      console.log(`cancelled ${done.filter((d) => d.cancelled).length} of ${toCancel.length}`);
    }
  }
} finally {
  await admin.app().delete().catch(() => {});
}
