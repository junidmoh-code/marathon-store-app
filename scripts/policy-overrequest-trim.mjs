// ─── SALE-ROW OVER-REQUEST TRIM (2026-10-24) ─────────────────────────────────
// Closes every OPEN sneaker sale-driven refill row at Hub 2 whose
// correct quantity under Junid's per-size policy is 0:
//
//   correct = max(0, keep(size) − on hand at the hub − open requests for the cell)
//
// keep is the explicit /stock_targets row when one exists, else the armed
// footwear-all group's per-size number. A cell with no resolvable keep is left
// alone (nothing to trim against). A row whose correct quantity is above 0 but
// below what it asks is REPORTED, not touched — sale rows carry no stored qty
// (it is a count of "ready" events), so the only honest partial trim is the
// queue's own policy cap (saleRowPolicyCap.js), not a faked "already sent".
//
// What a close writes, on restock_requests/{date}/{pid}/{sizeKey} (update, so a
// partial send's fulfilledQty survives): response "policy_trimmed" — any string
// response closes the cell for every reader (normalizeSourceResponse) — plus
// the trim evidence. Nothing touches /stock, /orders or /refill_requests.
//
//   node scripts/policy-overrequest-trim.mjs              # dry run (default)
//   node scripts/policy-overrequest-trim.mjs --execute    # snapshot, then write
//
// The snapshot of every leaf it changes lands in
// ~/marathon-rollbacks/policy-overrequest-<timestamp>/ BEFORE the first write.
import fs from "fs";
import os from "os";
import path from "path";
import { adminRequire } from "./adminRequire.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const EXECUTE = process.argv.includes("--execute");
// Hub 2 only: Hub 1 is engine-only (reactiveRefillHubs), so its sale events
// never become queue rows — there is nothing open there to trim. Hub 3 carries
// no per-size policy (the footwear-all group arms Hub 1 and Hub 2).
const HUBS = ["hub2"];
const RETENTION_DAYS = 5; // App.jsx HISTORY_RETENTION_DAYS

const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
const pushKeyFor = (ms) => { let s = ""; for (let i = 0; i < 8; i++) { s = PUSH_CHARS[ms % 64] + s; ms = Math.floor(ms / 64); } return s; };
const enc = (s) => String(s).replace(/[.#$/[\]\s]/g, "_");
const saDate = (iso) => new Date(Date.parse(iso) + 2 * 3600e3).toISOString().slice(0, 10);
const isSneakerEvent = (e) => (e.productType || (/^(S|M|L|XL|XXL|XXXL)$/i.test(e.size || "") ? "clothing" : "sneaker")) === "sneaker";

// Admin writes bypass the rules, and the only stored timestamp that matters
// (trimmedAtMs) is ServerValue.TIMESTAMP; the local clock only picks the day.
const nowMs = Date.now();
const today = saDate(new Date(nowMs).toISOString());
const pastDays = Array.from({ length: RETENTION_DAYS }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - (i + 1) * 864e5).toISOString().slice(0, 10));
const windowStartMs = Date.parse(`${pastDays[RETENTION_DAYS - 1]}T00:00:00Z`) - 2 * 3600e3;

// ── demand, exactly as the queue builds it ───────────────────────────────────
// Past days: "ready" sneaker events per (date, hub, product, size), one per
// order number (restockCountsFromLog). Today: one per /restock_log entry.
const demand = new Map();
const add = (date, hub, pid, size, token) => {
  const k = `${date}|${hub}|${pid}|${size}`;
  if (!demand.has(k)) demand.set(k, { date, hub, pid, size: String(size), tokens: new Set(), name: null });
  demand.get(k).tokens.add(token);
  return demand.get(k);
};
// Key-range read: push keys sort by creation time, so this is bounded to the
// retention window with no index and no whole-node download.
const insights = (await db.ref("insights_log").orderByKey().startAt(pushKeyFor(windowStartMs - 3600e3)).get()).val() || {};
for (const e of Object.values(insights)) {
  if (!e || e.action !== "ready" || typeof e.timestamp !== "string" || !e.productId || !e.size || !isSneakerEvent(e)) continue;
  const d = saDate(e.timestamp);
  if (!pastDays.includes(d) || !HUBS.includes(e.placedAtHub)) continue;
  add(d, e.placedAtHub, e.productId, e.size, `o:${e.orderNumber}`).name = e.productName || null;
}
const todayLog = (await db.ref(`restock_log/${today}`).get()).val() || {};
for (const [key, e] of Object.entries(todayLog)) {
  const hub = e?.hub || e?.placedAtHub;
  if (!e || !e.productId || !e.size || !HUBS.includes(hub)) continue;
  add(today, hub, e.productId, e.size, `l:${key}`).name = e.productName || null;
}

// ── the policy inputs, read by key ───────────────────────────────────────────
const config = (await db.ref("config/refillEngine").get()).val() || {};
const group = config.policyGroups?.["footwear-all"];
const pids = [...new Set([...demand.values()].map((d) => d.pid))];
const get = async (p) => (await db.ref(p).get()).val();
const product = {}, cells = {}, targets = {}, responses = {}, openReq = {};
await Promise.all(pids.map(async (pid) => {
  product[pid] = { name: await get(`products/${pid}/name`), categoryKey: await get(`products/${pid}/categoryKey`), category: await get(`products/${pid}/category`) };
  for (const h of HUBS) {
    cells[`${h}|${pid}`] = await get(`stock/${h}/${pid}`);
    targets[`${h}|${pid}`] = await get(`stock_targets/${h}/${pid}`);
  }
  for (const d of [today, ...pastDays]) responses[`${d}|${pid}`] = await get(`restock_requests/${d}/${pid}`);
}));
// Open requests for these cells: the refill_requests push-key range since the
// oldest demand day (a request is never older than the row it would cover by
// much; anything older is already in the engine's own inbound math).
const reqs = (await db.ref("refill_requests").orderByKey().startAt(pushKeyFor(windowStartMs - 14 * 864e5)).get()).val() || {};
for (const r of Object.values(reqs)) {
  if (!r || r.status !== "open" || !HUBS.includes(r.requestingLocation) || !pids.includes(r.productId)) continue;
  const k = `${r.requestingLocation}|${r.productId}|${enc(r.size)}`;
  openReq[k] = (openReq[k] || 0) + Math.max(1, Number(r.qty) || 1);
}

// The queue's footwear gate (saleRowPolicyCap isPolicyFootwearLine): an
// explicit row only caps a footwear line, never anything else.
const FOOTWEAR_KEYS = ["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes", "designer-shoes"];
const isFootwearLine = (p, size) => /^\d+(\.\d+)?$/.test(String(size).trim())
  && (p?.categoryKey ? FOOTWEAR_KEYS.includes(p.categoryKey) : p?.category === "Footwear");
const keepFor = (hub, pid, size) => {
  if (!isFootwearLine(product[pid], size)) return null;
  const row = targets[`${hub}|${pid}`]?.[enc(size)];
  if (row && typeof row.target === "number") return { keep: row.target, source: "explicit" };
  if (group?.armed && group.memberCategoryKeys?.includes(product[pid]?.categoryKey)) {
    const t = group.policy?.[hub]?.sizes?.[enc(size)]?.target;
    if (typeof t === "number" && t > 0) return { keep: t, source: "footwear-all" };
  }
  return null;
};

const rows = [];
for (const d of demand.values()) {
  const leaf = responses[`${d.date}|${d.pid}`]?.[enc(d.size)] || null;
  if (leaf && typeof leaf.response === "string") continue;              // already closed
  const asked = d.tokens.size;
  const sent = Number(leaf?.fulfilledQty) || 0;
  const remaining = asked - sent;
  if (remaining <= 0) continue;
  const k = keepFor(d.hub, d.pid, d.size);
  if (!k) continue;
  const onHand = Math.max(0, Number(cells[`${d.hub}|${d.pid}`]?.[enc(d.size)]?.qty) || 0);
  const inbound = openReq[`${d.hub}|${d.pid}|${enc(d.size)}`] || 0;
  const correct = Math.min(remaining, Math.max(0, k.keep - onHand - inbound));
  if (correct >= remaining) continue;
  rows.push({ ...d, tokens: undefined, name: product[d.pid]?.name || d.name, asked, sent, remaining, keep: k.keep, keepSource: k.source, onHand, inbound, correct, leaf });
}

const toClose = rows.filter((r) => r.correct === 0);
const partial = rows.filter((r) => r.correct > 0);
console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} — today ${today}, window ${pastDays[RETENTION_DAYS - 1]}..${today}, hubs ${HUBS.join("/")}`);
console.log(`over-policy open rows: ${rows.length} (close ${toClose.length}, partial ${partial.length}); units over: ${rows.reduce((a, r) => a + r.remaining - r.correct, 0)}`);
for (const r of rows) {
  console.log(`  ${r.date} ${r.hub} ${String(r.name || r.pid).slice(0, 40).padEnd(40)} size ${String(r.size).padEnd(4)} asks ${r.remaining} (of ${r.asked}, ${r.sent} sent) keep ${r.keep} [${r.keepSource}] on hand ${r.onHand} inbound ${r.inbound} → ${r.correct}${r.correct > 0 ? "  (partial — left to the queue cap)" : "  CLOSE"}`);
}
if (!EXECUTE || toClose.length === 0) process.exit(0);

// ── snapshot, then write ─────────────────────────────────────────────────────
const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
const dir = path.join(os.homedir(), "marathon-rollbacks", `policy-overrequest-${stamp}`);
fs.mkdirSync(dir, { recursive: true });
const snapshot = Object.fromEntries(toClose.map((r) => [`restock_requests/${r.date}/${r.pid}/${enc(r.size)}`, r.leaf]));
fs.writeFileSync(path.join(dir, "restock_requests-before.json"), JSON.stringify(snapshot, null, 2));
console.log(`snapshot: ${path.join(dir, "restock_requests-before.json")}`);

const respondedOn = new Date(nowMs).toISOString();
const log = [];
// Open requests re-read right before the writes: one cancelled since the
// census would otherwise leave inbound too high and close a row that needs
// a refill (CodeRabbit #783).
const liveInbound = {};
{
  const fresh = (await db.ref("refill_requests").orderByKey().startAt(pushKeyFor(windowStartMs - 14 * 864e5)).get()).val() || {};
  for (const q of Object.values(fresh)) {
    if (!q || q.status !== "open" || !HUBS.includes(q.requestingLocation)) continue;
    const k = `${q.requestingLocation}|${q.productId}|${enc(q.size)}`;
    liveInbound[k] = (liveInbound[k] || 0) + Math.max(1, Number(q.qty) || 1);
  }
}
for (const r of toClose) {
  const p = `restock_requests/${r.date}/${r.pid}/${enc(r.size)}`;
  // Re-read the leaf: a picker may have answered it since the census above.
  const live = (await db.ref(p).get()).val();
  if (live && typeof live.response === "string") { log.push({ path: p, skipped: "answered meanwhile", live }); continue; }
  if ((Number(live?.fulfilledQty) || 0) !== r.sent) { log.push({ path: p, skipped: "sent count moved meanwhile", live }); continue; }
  // Re-check the shelf too: a sale since the census can reopen room.
  const liveOnHand = Math.max(0, Number((await db.ref(`stock/${r.hub}/${r.pid}/${enc(r.size)}/qty`).get()).val()) || 0);
  const inboundNow = liveInbound[`${r.hub}|${r.pid}|${enc(r.size)}`] || 0;
  if (Math.max(0, r.keep - liveOnHand - inboundNow) > 0) { log.push({ path: p, skipped: "room reopened meanwhile", liveOnHand, inboundNow }); continue; }
  await db.ref(p).update({
    response: "policy_trimmed",
    respondedOn,
    trimmedAtMs: admin.database.ServerValue.TIMESTAMP,
    trimmedBy: "policy-overrequest-trim-20261024",
    trimmedFrom: r.remaining,
    trimmedTo: 0,
    trimEvidence: { keep: r.keep, keepSource: r.keepSource, onHand: r.onHand, inbound: r.inbound, asked: r.asked, sent: r.sent },
  });
  const after = (await db.ref(p).get()).val();
  log.push({ path: p, product: r.name, hub: r.hub, size: r.size, oldQty: r.remaining, newQty: 0, verified: after?.response === "policy_trimmed" });
}
fs.writeFileSync(path.join(dir, "trim-log.json"), JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 1));
console.log(`log: ${path.join(dir, "trim-log.json")}`);
process.exit(0);
