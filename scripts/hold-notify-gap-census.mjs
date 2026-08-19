// ─── THE GAP — holds fulfilled while the customer notification was off ───────
// READ ONLY. Writes nothing, ever. Sends nothing, ever. Rewrites nothing.
//
// The customer WhatsApp for held items was deleted in e115cde (2026-08-08
// 21:31 SA, "Refill unification") and restored at FULFIL on 2026-08-19. Between
// those two instants, every customer whose held item actually arrived was told
// nothing. This counts them and names them so the owner knows who they are.
//
// It does NOT message them and it does NOT backfill a notifiedAt stamp — the
// restored notifier only ever fires on a live fulfil transition, so a stamp
// written here would change nothing except the truth of the record.
//
// ── WHY THIS WINDOW ──────────────────────────────────────────────────────────
// The /refill_requests row a hold raises (key onhold_{saDate}_{orderNumber})
// was introduced by the SAME work that deleted the message — 07a9bfc raised the
// row, e115cde removed the send, both in PR #337. So the set of onhold_ rows
// that have ever existed IS, near enough, the notification-off era. Rows
// created before the removal COMMIT instant are reported separately rather than
// dropped, because the removal reached production on a deploy that landed some
// time after the commit and this script cannot know when — an over-count that
// is visible beats a silent under-count of people we owe a message.
//
// ── WHERE THE CUSTOMER COMES FROM ────────────────────────────────────────────
// Not from /orders: order numbers reset daily and that node is ephemeral, so by
// now most of these rows point at a recycled or deleted order. The durable
// source is /insights_log — the "tomorrow" event logged at hold time carries
// refillRequestId alongside customerName, customerPhone and orderNumber. (This
// is exactly the gap the restored feature closes by storing holdLink ON the
// request; rows created from 2026-08-19 onward carry it and need no join.)
//
// ── READ DISCIPLINE ──────────────────────────────────────────────────────────
//   - /refill_requests is read ONCE, key-ranged to the onhold_ prefix. Key
//     ordering is free — no index, no full-node download.
//   - /insights_log is paged BACKWARDS in orderByKey() chunks (push ids are
//     chronological) and stops as soon as a page predates the window. Nothing
//     older is ever downloaded.
//   - Nothing else is read. Byte totals are printed at the end.
//
// Usage:  node scripts/hold-notify-gap-census.mjs
//         GAP_FROM=2026-08-08T19:31:25.000Z node scripts/hold-notify-gap-census.mjs
//         GAP_JSON=/path/report.json node scripts/hold-notify-gap-census.mjs

import { createRequire } from "module";
import { writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// e115cde — "Refill unification": the commit that deleted the hold WhatsApp.
const REMOVED_AT = process.env.GAP_FROM || "2026-08-08T19:31:25.000Z";
// The highest code point RTDB will order a key by — written as an escape, never
// as a raw private-use character, so the range bound is reviewable in a diff.
const PREFIX_CEIL = "\uf8ff";
const PAGE = 4000;
const OUT = process.env.GAP_JSON || join(homedir(), `hold-notify-gap-${new Date().toISOString().slice(0, 10)}.json`);

const bytesByNode = {};
const meter = (node, val) => {
  bytesByNode[node] = (bytesByNode[node] || 0) + Buffer.byteLength(JSON.stringify(val ?? null));
};

/** Every request a hold has ever raised. Key-ranged, so no index is consulted. */
async function readHoldRequests() {
  const snap = await db.ref("refill_requests").orderByKey().startAt("onhold_").endAt("onhold_" + PREFIX_CEIL).once("value");
  const val = snap.val() || {};
  meter("refill_requests (onhold_ range)", val);
  return val;
}

/**
 * The hold-time "tomorrow" events, keyed by refillRequestId. Paged backwards
 * from newest; stops at the first page whose newest entry already predates the
 * window, so nothing older than the gap is ever downloaded.
 */
async function readTomorrowEvents(fromIso) {
  const byRequestId = new Map();
  let endBeforeKey = null;
  let pages = 0;
  for (;;) {
    let q = db.ref("insights_log").orderByKey();
    q = endBeforeKey ? q.endAt(endBeforeKey).limitToLast(PAGE + 1) : q.limitToLast(PAGE);
    const val = (await q.once("value")).val() || {};
    meter("insights_log", val);
    pages++;
    const keys = Object.keys(val).sort();
    if (endBeforeKey) {
      const i = keys.indexOf(endBeforeKey);
      if (i >= 0) keys.splice(i, 1);          // the cursor row was already counted
    }
    if (keys.length === 0) break;

    let newest = "";
    for (const k of keys) {
      const e = val[k];
      if (!e || typeof e !== "object") continue;
      if (e.timestamp && e.timestamp > newest) newest = e.timestamp;
      if (e.action !== "tomorrow") continue;
      const id = e.refillRequestId;
      if (!id || byRequestId.has(id)) continue;   // newest wins; we page newest-first
      byRequestId.set(id, e);
    }
    // Every entry on this page is older than the window → nothing older matters.
    if (newest && newest < fromIso) break;
    endBeforeKey = keys[0];
    if (keys.length < PAGE) break;              // reached the start of the node
    if (pages > 40) {                            // bounded: 160k entries is far past the gap
      console.warn("insights_log paging hit its bound — the join may be incomplete for the oldest rows.");
      break;
    }
  }
  return { byRequestId, pages };
}

const fmtPhone = (p) => (p ? String(p) : "—");

async function main() {
  console.log("HOLD NOTIFICATION GAP CENSUS — read-only, nothing is sent, nothing is written to RTDB\n");
  console.log(`Window opens at the removal commit e115cde: ${REMOVED_AT}\n`);

  const requests = await readHoldRequests();
  const ids = Object.keys(requests);
  console.log(`/refill_requests rows raised by a hold (onhold_*): ${ids.length}`);

  const byStatus = {};
  for (const id of ids) byStatus[requests[id].status || "?"] = (byStatus[requests[id].status || "?"] || 0) + 1;
  console.log(`  by status: ${JSON.stringify(byStatus)}`);

  // THE GAP: raised by a hold, actually FULFILLED (the stock reached the hub),
  // and carrying no evidence that a message went out.
  const gap = ids
    .filter((id) => {
      const r = requests[id];
      if (r.status !== "fulfilled") return false;         // nothing arrived → nothing was owed
      if (r.holdLink && (r.holdLink.notifiedAt || r.holdLink.notifyFailedAt)) return false;  // handled by the restored notifier
      return true;
    })
    .sort((a, b) => String(requests[a].resolvedAt || "").localeCompare(String(requests[b].resolvedAt || "")));

  // THE TAIL. Rows raised before this PR deployed carry no holdLink, so when
  // they are fulfilled the restored notifier reads them as not-hold-origin and
  // sends nothing. They are not part of the gap yet — but they will be.
  const openLegacy = ids.filter((id) => requests[id].status === "open" && !requests[id].holdLink);
  if (openLegacy.length) {
    console.log(`\nCARRY-OVER: ${openLegacy.length} hold(s) still OPEN were raised before the re-link shipped.`);
    console.log(`  They carry no holdLink, so fulfilling them will notify nobody. Deliberately NOT`);
    console.log(`  backfilled here — this script rewrites nothing. Order numbers: ${openLegacy.map((id) => requests[id].createdFrom?.orderId ?? id).join(", ")}`);
  }

  console.log(`\nFULFILLED holds with no notification on record: ${gap.length}\n`);
  if (gap.length === 0) {
    console.log("Nobody is owed a message.");
    return { gap: [], requests: ids.length };
  }

  const { byRequestId, pages } = await readTomorrowEvents(REMOVED_AT);
  console.log(`/insights_log: ${pages} page(s) read, ${byRequestId.size} hold events carrying a request id\n`);

  const rows = gap.map((id) => {
    const r = requests[id];
    const e = byRequestId.get(id) || {};
    const orderId = r.createdFrom?.orderId ?? e.orderNumber ?? null;
    return {
      requestId: id,
      orderNumber: orderId,
      saDate: r.createdFrom?.orderDate ?? null,
      hub: r.requestingLocation ?? null,
      customerName: e.customerName ?? null,
      customerPhone: e.customerPhone ?? null,
      productId: r.productId ?? null,
      productName: e.productName ?? null,
      size: r.size ?? null,
      qty: r.qty ?? null,
      raisedAt: r.createdAt ?? null,
      fulfilledAt: r.resolvedAt ?? null,
      // A row raised before the removal COMMIT may have had its message sent by
      // the still-live old bundle — flagged, not dropped.
      beforeRemovalCommit: !!(r.createdAt && r.createdAt < REMOVED_AT),
      customerResolved: !!e.customerPhone,
    };
  });

  const w = (s, n) => String(s ?? "—").slice(0, n).padEnd(n);
  console.log(`${w("order", 7)}${w("SA date", 12)}${w("hub", 6)}${w("customer", 18)}${w("phone", 15)}${w("size", 6)}${w("fulfilled", 21)}flag`);
  console.log("-".repeat(96));
  for (const r of rows) {
    console.log(
      w(r.orderNumber, 7) + w(r.saDate, 12) + w(r.hub, 6) +
      w(r.customerName, 18) + w(fmtPhone(r.customerPhone), 15) +
      w(r.size, 6) + w(r.fulfilledAt, 21) +
      (r.beforeRemovalCommit ? "pre-commit " : "") + (r.customerResolved ? "" : "NO-CONTACT")
    );
  }

  const contactable = rows.filter((r) => r.customerResolved && !r.beforeRemovalCommit);
  const preCommit = rows.filter((r) => r.beforeRemovalCommit);
  const unresolved = rows.filter((r) => !r.customerResolved);
  console.log(`\n${rows.length} customers whose held item arrived and who were never messaged.`);
  console.log(`  ${contactable.length} with a phone number on record, raised after the removal commit`);
  if (preCommit.length) console.log(`  ${preCommit.length} raised BEFORE the removal commit — the old bundle may still have messaged them`);
  if (unresolved.length) console.log(`  ${unresolved.length} with no hold event left in /insights_log — no contact details recoverable`);

  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    windowFrom: REMOVED_AT,
    holdRequestsTotal: ids.length,
    byStatus,
    gapCount: rows.length,
    openLegacyCount: openLegacy.length,
    openLegacyOrders: openLegacy.map((id) => ({ requestId: id, orderNumber: requests[id].createdFrom?.orderId ?? null })),
    rows,
  }, null, 2));
  chmodSync(OUT, 0o600);   // contains customer phone numbers
  console.log(`\nDetail (contains phone numbers, mode 600): ${OUT}`);
  console.log(`\nbytes read: ${JSON.stringify(bytesByNode)}`);
  console.log("\nNo message was sent and no record was changed. Contacting these customers is the owner's call.");
  return { gap: rows, requests: ids.length };
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
