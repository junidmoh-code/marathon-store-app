// Customer phone census — READ ONLY. Writes nothing, ever.
//
// Step 1 of the phone-duplicate project: report every phone format in
// /customers, how many records collapse to each canonical +27 number, and for
// every collapse group the per-record detail (name, sale counts, open laybys,
// store credit, on-account state, dates) plus a SAFE / REVIEW classification.
// The classification rules live in scripts/lib/customerMergeCore.mjs so the
// census and the merge runner can never disagree about a group.
//
// Read discipline (live RTDB bandwidth is a real cost):
//   - /customers is read in orderByKey pages of 500 (~1.1 MB total — the same
//     bytes one app mount already downloads, just chunked and one-shot).
//   - /laybys and /laybyPulls are read whole ONLY after a shallow key-count
//     confirms they are small; a surprise-large node aborts instead of
//     downloading it.
//   - customer_index/sales/{key} and pos/creditLedger/{key} are POINT reads,
//     issued only for members of collapse groups.
//   - pos/storeCredits and pos/storeCreditQueue get a shallow key-count, then
//     point reads only for credit ids held by group members.
//   - Nothing else is read. Byte totals per node are printed at the end.
//
// Usage:  node scripts/customer-phone-census.mjs
//         CENSUS_JSON=/path/report.json node scripts/customer-phone-census.mjs

import { createRequire } from "module";
import { writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatClass, canonicalSA, collapseGroups, classifyGroup,
  pickSurvivor, creditBalance, totalCreditAcross,
} from "./lib/customerMergeCore.mjs";
import { readMapPaged, shallowKeys as sharedShallowKeys } from "./lib/rtdbPaged.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// ── metered reads ───────────────────────────────────────────────────────────
const bytesByNode = {};
function meter(node, val) {
  bytesByNode[node] = (bytesByNode[node] || 0) + Buffer.byteLength(JSON.stringify(val ?? null));
}
async function readAt(path, node) {
  const snap = await db.ref(path).once("value");
  const val = snap.val();
  meter(node, val);
  return val;
}
// Shallow key-count via the shared helper (Authorization header, no token in
// the URL). Metered by key count — shallow responses are keys-only.
async function shallowKeys(path, node) {
  const keys = await sharedShallowKeys(admin.app(), path);
  meter(node + " (shallow)", keys);
  return keys;
}

const readCustomersPaged = () =>
  readMapPaged(db, "customers", { meter: (v) => meter("customers", v) });

const fmtR = (cents) => `R${(cents / 100).toFixed(2)}`;
const OPEN_LAYBY_STATUSES = new Set([
  "created", "labelPrinted", "inTransitToStorage", "storedAtHub", "pullRequested", "sentToStore",
]);

async function main() {
  console.log("CUSTOMER PHONE CENSUS — read-only, no writes\n");

  const customers = await readCustomersPaged();
  const allKeys = Object.keys(customers);
  console.log(`records in /customers: ${allKeys.length}`);

  // ── format census: keys and phone fields ─────────────────────────────────
  const keyFormats = {}, fieldFormats = {};
  let fieldKeyMismatch = 0;
  const mismatches = [];
  for (const [key, rec] of Object.entries(customers)) {
    keyFormats[formatClass(key)] = (keyFormats[formatClass(key)] || 0) + 1;
    const f = rec?.phone;
    fieldFormats[formatClass(f)] = (fieldFormats[formatClass(f)] || 0) + 1;
    const ck = canonicalSA(key), cf = canonicalSA(f);
    if (ck && cf && ck !== cf) { fieldKeyMismatch += 1; mismatches.push({ key, phone: f }); }
  }

  // ── collapse groups ──────────────────────────────────────────────────────
  const { groups, byCanon, unmergeable, tombstones } = collapseGroups(customers);

  // Drifted tombstones: an already-merged record that accrued NEW money or
  // history since its merge (the POS can still write onto tombstone keys).
  // The merge runner re-sweeps these; the census makes them visible.
  const driftedTombstones = [];
  for (const t of tombstones) {
    const bal = creditBalance(t.rec);
    const holdings = t.rec?.laybyHoldings && typeof t.rec.laybyHoldings === "object" ? Object.keys(t.rec.laybyHoldings).length : 0;
    const ledger = await readAt(`pos/creditLedger/${t.key}`, "pos/creditLedger");
    const idxKeys = await shallowKeys(`customer_index/sales/${t.key}`, "customer_index/sales");
    if (bal.total > 0 || bal.count > 0 || holdings > 0 || ledger || idxKeys.length) {
      driftedTombstones.push({ key: t.key, mergedInto: t.rec.mergedInto, creditCents: bal.total, creditRecords: bal.count, holdings, ledger: !!ledger, salePointers: idxKeys.length });
    }
  }

  // laybys / laybyPulls — shallow count gate, then whole read
  const laybyKeys = await shallowKeys("laybys", "laybys");
  if (laybyKeys.length > 3000) {
    throw new Error(`laybys=${laybyKeys.length} — unexpectedly large, refusing whole read`);
  }
  const laybys = (await readAt("laybys", "laybys")) || {};
  const laybysByCanon = new Map();
  for (const [id, l] of Object.entries(laybys)) {
    const c = canonicalSA(l?.customerPhone);
    if (!c) continue;
    if (!laybysByCanon.has(c)) laybysByCanon.set(c, []);
    laybysByCanon.get(c).push({ id, ...l });
  }

  // per-member point reads, group members only
  const memberKeys = [...groups.values()].flat().map((m) => m.key);
  const saleCounts = {}, ledgers = {};
  for (const key of memberKeys) {
    const saleIds = await shallowKeys(`customer_index/sales/${key}`, "customer_index/sales");
    saleCounts[key] = saleIds.length;
    ledgers[key] = await readAt(`pos/creditLedger/${key}`, "pos/creditLedger");
  }

  // credit-queue backlog (must be ~empty before any merge ever runs)
  const queueKeys = await shallowKeys("pos/storeCreditQueue", "pos/storeCreditQueue");
  const storeCreditIds = await shallowKeys("pos/storeCredits", "pos/storeCredits");

  // ── per-group detail + classification ────────────────────────────────────
  const groupReports = [];
  for (const [canon, members] of groups) {
    const cls = classifyGroup(members);
    // Laybys canonically in this group whose stored digits match NO member
    // key (third-dialect strings). The merge runner re-points these to the
    // survivor; the census must show them, not silently exclude them.
    // Both sides digit-normalised: member keys are digit strings today, but a
    // "+"-bearing key would otherwise mislabel its own laybys as unattributed.
    const digitsOf = (v) => String(v || "").replace(/\D/g, "");
    const memberKeySet = new Set(members.map((m) => digitsOf(m.key)));
    const unattributedLaybys = (laybysByCanon.get(canon) || [])
      .filter((l) => !memberKeySet.has(digitsOf(l.customerPhone)))
      .map((l) => ({ invoiceNo: l.invoiceNo, status: l.status, customerPhone: l.customerPhone }));
    const detail = members.map((m) => {
      const bal = creditBalance(m.rec);
      const led = ledgers[m.key];
      const holdings = m.rec?.laybyHoldings && typeof m.rec.laybyHoldings === "object"
        ? Object.keys(m.rec.laybyHoldings).length : 0;
      const openLaybys = (laybysByCanon.get(canon) || [])
        .filter((l) => OPEN_LAYBY_STATUSES.has(l.status) && digitsOf(l.customerPhone) === digitsOf(m.key));
      return {
        key: m.key,
        name: m.rec?.name || "",
        code: m.rec?.code || null,
        posSales: saleCounts[m.key] || 0,
        orderCount: Number(m.rec?.orderCount) || 0,
        openLaybyCount: openLaybys.length,
        openLaybyInvoices: openLaybys.map((l) => l.invoiceNo),
        laybyHoldings: holdings,
        creditCents: bal.total,
        creditRecords: bal.count,
        legacyNumberCredit: bal.legacyNumber ?? null,
        badCredits: bal.bad,
        onAccount: led
          ? { balance: led.balance ?? 0, creditLimit: led.creditLimit ?? 0, accountType: led.accountType ?? null, txns: led.txns ? Object.keys(led.txns).length : 0 }
          : null,
        firstOrderAt: m.rec?.firstOrderAt || null,
        lastOrderAt: m.rec?.lastOrderAt || null,
        optedIn: !!m.rec?.optedIn,
      };
    });
    const { survivor } = pickSurvivor(members, saleCounts);
    groupReports.push({ canonical: canon, size: members.length, ...cls, survivorKey: survivor.key, unattributedLaybys, members: detail });
  }
  groupReports.sort((a, b) => b.size - a.size || (a.canonical < b.canonical ? -1 : 1));

  const safe = groupReports.filter((g) => g.classification === "SAFE");
  const review = groupReports.filter((g) => g.classification === "REVIEW");
  const baseCredit = totalCreditAcross(customers);

  // ── report ───────────────────────────────────────────────────────────────
  console.log("\n== KEY FORMATS ==");
  for (const [k, v] of Object.entries(keyFormats).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log("\n== PHONE FIELD FORMATS ==");
  for (const [k, v] of Object.entries(fieldFormats).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`\nfield↔key canonical mismatches: ${fieldKeyMismatch}`);
  for (const m of mismatches.slice(0, 20)) console.log(`  key=${m.key} phone=${JSON.stringify(m.phone)}`);

  console.log(`\n== COLLAPSE ==`);
  console.log(`canonical numbers with 1 record : ${[...byCanon.values()].filter((v) => v.length === 1).length}`);
  console.log(`canonical numbers with 2+ records: ${groups.size}`);
  const sizes = {};
  for (const g of groupReports) sizes[g.size] = (sizes[g.size] || 0) + 1;
  for (const [s, n] of Object.entries(sizes)) console.log(`  groups of ${s}: ${n}`);
  console.log(`largest group: ${groupReports[0]?.size ?? 0} records (${groupReports[0]?.canonical ?? "-"})`);
  console.log(`already-merged tombstones: ${tombstones.length}${driftedTombstones.length ? `  ⚠ ${driftedTombstones.length} DRIFTED (accrued money/history since merge — runner will re-sweep)` : ""}`);
  for (const d of driftedTombstones) console.log(`  DRIFTED ${d.key} → ${d.mergedInto}  credit=${fmtR(d.creditCents)}/${d.creditRecords}rec holdings=${d.holdings} ledger=${d.ledger} salePtrs=${d.salePointers}`);
  console.log(`records with no canonical SA identity (never grouped/merged): ${unmergeable.length}`);
  for (const u of unmergeable.slice(0, 25)) console.log(`  ${u.key}  name=${JSON.stringify(u.rec?.name || "")} phone=${JSON.stringify(u.rec?.phone ?? null)}`);

  console.log(`\n== CLASSIFICATION ==  SAFE: ${safe.length}   REVIEW: ${review.length}`);

  const printGroup = (g) => {
    console.log(`\n  ${g.canonical}  [${g.classification}/${g.tag}]  survivor→${g.survivorKey}`);
    for (const u of g.unattributedLaybys || []) {
      console.log(`    ⚠ layby ${u.invoiceNo} (${u.status}) carries ${JSON.stringify(u.customerPhone)} — in this group, matches no member key (runner re-points it)`);
    }
    for (const m of g.members) {
      const led = m.onAccount ? ` onAcct=${fmtR(m.onAccount.balance)}(${m.onAccount.accountType || "?"},${m.onAccount.txns}txn)` : "";
      console.log(
        `    ${m.key.padEnd(12)} ${JSON.stringify(m.name).padEnd(28)} sales=${m.posSales} orders=${m.orderCount}` +
        ` openLaybys=${m.openLaybyCount}${m.openLaybyInvoices.length ? "(" + m.openLaybyInvoices.join(",") + ")" : ""}` +
        ` credit=${fmtR(m.creditCents)}/${m.creditRecords}rec${m.legacyNumberCredit ? " LEGACY-NUM " + m.legacyNumberCredit : ""}${led}` +
        ` first=${(m.firstOrderAt || "-").slice(0, 10)} last=${(m.lastOrderAt || "-").slice(0, 10)}`,
      );
    }
  };
  console.log("\n== SAFE GROUPS ==");
  for (const g of safe) printGroup(g);
  console.log("\n== REVIEW GROUPS (owner judges every one) ==");
  for (const g of review) printGroup(g);

  console.log(`\n== MONEY BASELINE ==`);
  console.log(`total store credit across /customers mirror: ${fmtR(baseCredit.total)} over ${baseCredit.credits} credit records on ${baseCredit.records} customers`);
  console.log(`pos/storeCredits canonical records: ${storeCreditIds.length}`);
  console.log(`pos/storeCreditQueue pending claims: ${queueKeys.length}${queueKeys.length ? "  ⚠ must be drained before any merge" : ""}`);

  console.log(`\n== BYTES READ ==`);
  let total = 0;
  for (const [k, v] of Object.entries(bytesByNode)) { total += v; console.log(`  ${k.padEnd(28)} ${(v / 1024).toFixed(1)} KB`); }
  console.log(`  TOTAL ${" ".repeat(22)} ${(total / 1024).toFixed(1)} KB`);

  const reportPath = process.env.CENSUS_JSON
    || join(tmpdir(), `customer-phone-census-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  // The report carries customer PII (names + numbers) — owner-only mode,
  // chmod too because writeFileSync only sets mode on newly created files.
  writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    recordCount: allKeys.length,
    keyFormats, fieldFormats, fieldKeyMismatch, mismatches,
    unmergeable: unmergeable.map((u) => ({ key: u.key, name: u.rec?.name || "", phone: u.rec?.phone ?? null })),
    tombstoneCount: tombstones.length, driftedTombstones,
    safeCount: safe.length, reviewCount: review.length,
    baseCredit, storeCreditQueuePending: queueKeys.length,
    groups: groupReports,
  }, null, 2), { mode: 0o600 });
  chmodSync(reportPath, 0o600);
  console.log(`\nJSON report: ${reportPath}`);
  process.exit(0);
}

main().catch((e) => { console.error("CENSUS FAILED:", e); process.exit(1); });
