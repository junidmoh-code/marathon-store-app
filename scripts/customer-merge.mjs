// Guarded customer phone-duplicate merge runner. DRY-RUN BY DEFAULT — writes
// nothing without --execute, and --execute is a separate deliberate act that
// the operator (Junid) triggers, never this script's author.
//
//   node scripts/customer-merge.mjs                    # dry run, full report
//   node scripts/customer-merge.mjs --only=+27619467420
//   node scripts/customer-merge.mjs --execute          # THE data merge
//
// What a merge does (per SAFE pair, one atomic multi-path update each):
//   survivor = record with the most sale history (pickSurvivor's total order);
//   store credits / layby holdings / ledger txns / audit events MOVE verbatim;
//   customer_index pointers + pos/sales.customerId + laybys/laybyPulls
//   customerPhone + open orders re-point; ledger balances fold (sum, value
//   conserved); loser is tombstoned (mergedInto) with all identity fields
//   kept; a customer_merges/{mergeId} record holds the full reversal recipe.
//   REVIEW groups (names differ) are NEVER touched.
//
// Guard order (mirrors collapse-one-size-headwear.mjs, the house reference):
//   flags → privileged-credential assert → server-time anchor → global gates
//   (credit queue EMPTY, whole-base credit baseline) → rollback snapshot on
//   disk BEFORE any write, read back and validated → RTDB run lock by
//   transaction → per-group fresh reads → plan (pure core) → pre-write drift
//   re-read → single update() → per-group verify on fresh reads → run-wide
//   credit-total proof (paged re-read of /customers) → snapshot rewritten
//   with appliedMergeIds → exit contract (0 only when everything it did or
//   planned is provably safe).
//
// MONEY INVARIANT, proven not promised: the total store credit across the
// whole customer base (sum of every storeCredit child's remainingAmount) is
// computed from paged reads BEFORE any write and re-computed AFTER the last
// write. One cent of difference exits 1 and prints the rollback command.
// SCOPE: the proof assumes no concurrent till activity — a redemption landing
// in the ms between a pair's drift check and its update() is clobbered in a
// way that RESTORES a pre-spend amount, which this recount cannot see. That
// is why "tills closed" is a hard precondition, not advice (see runbook).
//
// The run lock has no lease/heartbeat: after a hard kill (SIGKILL, power
// loss) it must be cleared by hand with the printed firebase command — an
// accepted trade-off for a low-frequency operator-run tool; an auto-expiring
// lock is exactly the "other run looks old" reasoning that double-applies.

import { createRequire } from "module";
import { writeFileSync, readFileSync, chmodSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import {
  collapseGroups, classifyGroup, pickSurvivor, creditBalance,
  totalCreditAcross, buildMergePlan, canonicalSA, extractLoserRefs,
} from "./lib/customerMergeCore.mjs";
import { readMapPaged, shallowKeys } from "./lib/rtdbPaged.mjs";
import { stable } from "./lib/stableStringify.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// ── flags ───────────────────────────────────────────────────────────────────
const EXECUTE = process.argv.includes("--execute");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg
  ? new Set(onlyArg.slice(7).split(",").map((s) => canonicalSA(s.trim())).filter(Boolean))
  : null;
if (onlyArg && (!ONLY || ONLY.size === 0)) {
  console.error("ABORT: --only given but no canonicalisable numbers in it.");
  process.exit(1);
}
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || join(tmpdir(), `customer-merge-snapshot-${STAMP}.json`);
const REPORT_JSON = process.env.REPORT_JSON || join(tmpdir(), `customer-merge-report-${STAMP}.json`);
const LOCK = "_migrations/customerPhoneMerge/runLock";

function hasPrivilegedCredential(app) {
  const c = app && app.options && app.options.credential;
  return !!c && typeof c.getAccessToken === "function";
}

async function readAt(path) {
  return (await db.ref(path).once("value")).val();
}


// Everything one group's plan rests on, freshly read. Also reused verbatim for
// the pre-write drift check: same reads, same shape, compared by stable() — so
// EVERY node the plan derives a write from is inside the drift fingerprint,
// including the loser's slices of laybys/laybyPulls/orders (a layby or order
// created for the loser after planning changes the slice and aborts the pair).
// The three small whole-node reads repeat per pair; this is a one-off
// migration in quiet hours and correctness of the fingerprint outranks the
// ~100 KB they cost.
async function readGroupInputs(survivorKey, loserKey, canonical) {
  const [survivor, loser, survivorLedger, loserLedger, survivorIndex, loserIndex, laybys, laybyPulls, orders] = await Promise.all([
    readAt(`customers/${survivorKey}`), readAt(`customers/${loserKey}`),
    readAt(`pos/creditLedger/${survivorKey}`), readAt(`pos/creditLedger/${loserKey}`),
    readAt(`customer_index/sales/${survivorKey}`), readAt(`customer_index/sales/${loserKey}`),
    readAt("laybys"), readAt("laybyPulls"), readAt("orders"),
  ]);
  const loserRefs = extractLoserRefs(loserKey, laybys || {}, laybyPulls || {}, orders || {}, { survivorKey, canonical });
  const loserCredits = (loser?.storeCredit && typeof loser.storeCredit === "object") ? Object.keys(loser.storeCredit) : [];
  const loserHoldings = (loser?.laybyHoldings && typeof loser.laybyHoldings === "object") ? Object.keys(loser.laybyHoldings) : [];
  const saleIds = [...new Set([...Object.keys(loserIndex || {}), ...loserHoldings, ...Object.keys(loserRefs.laybys)])];
  const loserSaleOwners = {};
  for (const sid of saleIds) loserSaleOwners[sid] = await readAt(`pos/sales/${sid}/customerId`);
  const loserCreditOwners = {};
  for (const cid of loserCredits) loserCreditOwners[cid] = await readAt(`pos/storeCredits/${cid}/customerId`);
  const auditSubtrees = async (key) => ({
    issued: await readAt(`pos/audit/store_credit_issued/${key}`) || {},
    removed: await readAt(`pos/audit/store_credit_removed/${key}`) || {},
    onAccount: await readAt(`pos/audit/on_account/${key}`) || {},
    onAccountConfig: await readAt(`pos/audit/on_account_config/${key}`) || {},
  });
  const loserAudit = await auditSubtrees(loserKey);
  const survivorAudit = await auditSubtrees(survivorKey);
  return { survivor, loser, survivorLedger, loserLedger, survivorIndex, loserIndex, loserSaleOwners, loserCreditOwners, loserRefs, loserAudit, survivorAudit };
}

async function main() {
  console.log(`CUSTOMER MERGE — ${EXECUTE ? "EXECUTE (writes live data)" : "DRY RUN (writes nothing)"}\n`);

  if (!hasPrivilegedCredential(admin.app())) {
    console.error("ABORT: not a privileged Admin SDK credential — pos/storeCredits.customerId,");
    console.error("pos/sales.customerId and the audit moves have no client-side write rule.");
    process.exit(1);
  }
  console.log(`credential: ${admin.app().options.credential.constructor.name} (privileged)`);

  // Server-time anchor: every timestamp this run stamps comes from the
  // server's clock, not this machine's (the order-counter TZ incident rule).
  const offset = (await readAt(".info/serverTimeOffset")) || 0;
  const nowIso = new Date(Date.now() + offset).toISOString();
  const batchId = `phone-merge-${nowIso.slice(0, 16).replace(/[:T]/g, "")}`;
  console.log(`server time: ${nowIso}   batchId: ${batchId}\n`);

  // ── global gate: the credit-issuance queue must be EMPTY ─────────────────
  // A pending claim carries a customerId; the 5-minute sweep would mint the
  // credit back onto a tombstoned loser (verifyAnchor never checks the
  // customer). Gate applies to dry runs too — a dry run rehearsing a state
  // the execute run must refuse is a lie.
  const queue = await readAt("pos/storeCreditQueue");
  if (queue && Object.keys(queue).length) {
    console.error(`ABORT: pos/storeCreditQueue holds ${Object.keys(queue).length} pending claim(s) — drain first.`);
    process.exit(1);
  }

  // ── baseline: whole-base credit total (paged) + groups ───────────────────
  const customersBefore = await readMapPaged(db, "customers");
  const creditBefore = totalCreditAcross(customersBefore);
  console.log(`baseline: ${Object.keys(customersBefore).length} customers, total credit R${(creditBefore.total / 100).toFixed(2)} in ${creditBefore.credits} records\n`);

  const { groups, tombstones } = collapseGroups(customersBefore);
  if (tombstones.length) console.log(`(${tombstones.length} already-merged tombstone(s) excluded from grouping)\n`);

  // Size gate before the whole reads inside readGroupInputs: these three nodes
  // are believed small; a surprise-large one aborts instead of downloading.
  const [laybyCount, pullCount, orderCount] = await Promise.all([
    shallowKeys(admin.app(), "laybys"), shallowKeys(admin.app(), "laybyPulls"), shallowKeys(admin.app(), "orders"),
  ].map((p) => p.then((k) => k.length)));
  if (laybyCount > 3000 || pullCount > 3000 || orderCount > 3000) {
    console.error(`ABORT: laybys=${laybyCount} laybyPulls=${pullCount} orders=${orderCount} — unexpectedly large, refusing whole reads.`);
    process.exit(1);
  }

  // ── plan every group from fresh reads (SAFE pairs only) ──────────────────
  const planned = [], refused = [], skipped = [];
  const saleCounts = {};
  for (const [canonical, members] of groups) {
    if (ONLY && !ONLY.has(canonical)) continue;
    const cls = classifyGroup(members);
    if (cls.classification !== "SAFE") { skipped.push({ canonical, why: `REVIEW (${cls.tag})` }); continue; }
    if (members.length !== 2) { skipped.push({ canonical, why: `group of ${members.length} — runner merges pairs; re-run after this pair merges` }); continue; }
    for (const m of members) {
      saleCounts[m.key] = Object.keys((await readAt(`customer_index/sales/${m.key}`)) || {}).length;
    }
    const { survivor: sv, losers } = pickSurvivor(members, saleCounts);
    const survivorKey = sv.key, loserKey = losers[0].key;
    const inputs = await readGroupInputs(survivorKey, loserKey, canonical);
    const mergeId = `${batchId}_${loserKey}`;
    const plan = buildMergePlan({
      canonical, survivorKey, loserKey, ...inputs,
      classification: cls.classification, nowIso, mergeId, batchId,
    });
    if (plan.refusals) { refused.push(...plan.refusals); continue; }
    planned.push({ canonical, survivorKey, loserKey, mergeId, plan, inputsHash: stable(inputs) });
  }

  // ── drifted tombstones: money that accrued on an already-merged record ───
  // The POS can still write onto a tombstone key until it ships mergedInto
  // awareness, and a tombstone never re-enters grouping (size 1 at its
  // canonical). Without this scan that money would be stranded invisibly —
  // hidden from store-app search by the index filter, hidden from this tool
  // by the membership filter (Sonnet architect review, #364). A drifted
  // tombstone is re-swept: same plan builder, resweep mode, into the ultimate
  // live survivor found by following the pointer chain.
  // Walk mergedInto to the first LIVE record; null on a cycle or a dangling
  // pointer (those tombstones are reported for hand-fixing, never guessed at).
  const followChain = (startKey) => {
    let key = startKey;
    const seen = new Set([key]);
    while (customersBefore[key]?.mergedInto) {
      const next = customersBefore[key].mergedInto;
      if (seen.has(next) || !customersBefore[next] || seen.size > 6) return null;
      seen.add(next);
      key = next;
    }
    return key;
  };
  for (const t of tombstones) {
    const canonical = canonicalSA(t.key);
    // --only scopes resweeps exactly like pairs — a scoped run must never
    // execute unrelated merges or fail on unrelated dead chains.
    if (ONLY && !ONLY.has(canonical)) continue;
    const bal = creditBalance(t.rec);
    const holdings = t.rec?.laybyHoldings && typeof t.rec.laybyHoldings === "object" ? Object.keys(t.rec.laybyHoldings).length : 0;
    const [ledger, idx] = await Promise.all([readAt(`pos/creditLedger/${t.key}`), readAt(`customer_index/sales/${t.key}`)]);
    const drifted = bal.total > 0 || bal.count > 0 || holdings > 0 || !!ledger || !!(idx && Object.keys(idx).length);
    if (!drifted) continue;
    // A tombstone whose key has no canonical SA identity should not exist
    // (only our merges write mergedInto, on canonical keys) — refuse rather
    // than plan on a sentinel identity (CodeRabbit, #364).
    if (!canonical) {
      refused.push({ canonical: `tombstone:${t.key}`, why: `drifted tombstone ${t.key} has no canonical SA identity — fix by hand` });
      continue;
    }
    const target = followChain(t.key);
    if (!target || target === t.key) {
      refused.push({ canonical, why: `tombstone ${t.key} drifted (credit R${(bal.total / 100).toFixed(2)}, ${holdings} holding(s)) but its mergedInto chain ends nowhere live — fix by hand` });
      continue;
    }
    const inputs = await readGroupInputs(target, t.key, canonical);
    // Names are RE-PROVED on the fresh reads. The original merge proved
    // agreement at merge time; drift invalidates that proof — a recycled
    // number means a DIFFERENT person may now be transacting on the tombstone
    // key, and folding their money into the old survivor is exactly the merge
    // the REVIEW system exists to block (delta review, PR #364).
    const cls = classifyGroup([
      { key: t.key, rec: inputs.loser }, { key: target, rec: inputs.survivor },
    ]);
    if (cls.classification !== "SAFE") {
      refused.push({ canonical, why: `RESWEEP ${t.key}: names no longer agree with survivor ${target} (${cls.tag}) — owner must judge` });
      continue;
    }
    const mergeId = `${batchId}_resweep_${t.key}`;
    // A marker at this mergeId means a same-minute run already applied this
    // exact resweep — planning it again would overwrite that run's reversal
    // recipe in customer_merges (delta review, PR #364).
    if (await readAt(`customer_merges/${mergeId}`)) {
      refused.push({ canonical, why: `RESWEEP ${t.key}: customer_merges/${mergeId} already exists (same-minute rerun) — wait a minute and re-run` });
      continue;
    }
    // cls.classification passes through so the core's REVIEW refusal (the
    // mutation-proven guard) also protects resweeps — the runner check above
    // exists only for the clearer operator message.
    const plan = buildMergePlan({
      canonical, survivorKey: target, loserKey: t.key, ...inputs,
      classification: cls.classification, resweep: true, nowIso, mergeId, batchId,
    });
    if (plan.refusals) { refused.push(...plan.refusals.map((r) => ({ ...r, why: `RESWEEP ${r.why}` }))); continue; }
    planned.push({ canonical, survivorKey: target, loserKey: t.key, mergeId, plan, inputsHash: stable(inputs), resweep: true });
    console.log(`  RESWEEP ${t.key} drifted since its merge (credit R${(bal.total / 100).toFixed(2)}, ${holdings} holding(s)) → re-folding into ${target}`);
  }

  console.log(`groups: ${planned.length} planned, ${skipped.length} skipped (REVIEW/size), ${refused.length} refused by guards`);
  for (const s of skipped) console.log(`  SKIP   ${s.canonical}: ${s.why}`);
  for (const r of refused) console.log(`  REFUSE ${r.canonical}: ${r.why}`);
  console.log("");
  for (const p of planned) {
    const c = p.plan.checks;
    console.log(`  ${p.canonical}  loser ${p.loserKey} → survivor ${p.survivorKey}`);
    console.log(`      credit moved: R${(c.creditCentsMoved / 100).toFixed(2)} in ${c.creditRecordsMoved} record(s) (VERBATIM), ledger fold R${(c.ledgerCentsMoved / 100).toFixed(2)}, ${c.ledgerTxnsMoved} txn(s)`);
    console.log(`      sales repointed: ${c.salesRepointed}, index pointers: ${c.indexPointersMoved}, holdings: ${c.holdingsMoved}, laybys: ${c.laybysRepointed.map((l) => `${l.invoiceNo}(${l.status})`).join(",") || "none"}`);
    console.log(`      paths touched: ${Object.keys(p.plan.updates).length}`);
  }

  // expected post-state (pure arithmetic — the run-wide proof target)
  const expectedAfterTotal = creditBefore.total; // moves conserve by construction
  console.log(`\ncredit total BEFORE: R${(creditBefore.total / 100).toFixed(2)}   expected AFTER: R${(expectedAfterTotal / 100).toFixed(2)} (identical — credits only MOVE)`);

  // ── snapshot to disk BEFORE any write, validated by read-back ────────────
  const snapshot = {
    batchId, nowIso, executed: EXECUTE, host: hostname(), pid: process.pid,
    creditBefore, appliedMergeIds: [],
    merges: planned.map((p) => ({
      mergeId: p.mergeId, canonical: p.canonical, survivorKey: p.survivorKey, loserKey: p.loserKey,
      preState: p.plan.preState, updates: p.plan.updates,
    })),
  };
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); chmodSync(SNAPSHOT_PATH, 0o600);
  const back = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  if (back.merges.length !== planned.length) {
    console.error("ABORT: snapshot read-back mismatch. Nothing has been written.");
    process.exit(1);
  }
  console.log(`\nrollback snapshot: ${SNAPSHOT_PATH}`);
  console.log(`restore command:   node scripts/rollback-customer-merge.mjs ${SNAPSHOT_PATH} --execute\n`);

  const report = {
    batchId, mode: EXECUTE ? "execute" : "dry-run", nowIso,
    creditBefore, planned: planned.map((p) => ({ canonical: p.canonical, survivorKey: p.survivorKey, loserKey: p.loserKey, checks: p.plan.checks })),
    skipped, refused, applied: [], aborted: [],
  };

  if (!EXECUTE) {
    report.expectedAfterTotal = expectedAfterTotal;
    writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), { mode: 0o600 }); chmodSync(REPORT_JSON, 0o600);
    console.log(`DRY RUN complete — no writes. Report: ${REPORT_JSON}`);
    // Exit contract: a dry run that found refusals exits 1, because the
    // execute run it rehearses would refuse the same groups.
    process.exit(refused.length ? 1 : 0);
  }

  // ── EXECUTE ONLY: run lock by transaction, never read-then-write ─────────
  console.log("⚠ EXECUTE MODE. 'Tills closed / quiet hours' is LOAD-BEARING, not advisory:");
  console.log("  a till redemption landing in the milliseconds between a pair's drift check");
  console.log("  and its atomic update would be clobbered by the verbatim credit move, and");
  console.log("  the base-wide total would NOT catch it (the clobber restores a pre-spend");
  console.log("  amount). The storeCreditQueue gate and run lock do not close that window —");
  console.log("  closed tills do.\n");
  let lockHeld = false;
  const mine = { startedAt: nowIso, pid: process.pid, host: hostname(), releasedAt: null };
  const { committed, snapshot: lockSnap } = await db.ref(LOCK).transaction((cur) => {
    if (cur && cur.releasedAt == null) return; // abort: held
    return mine;
  });
  if (!committed) {
    const held = lockSnap.val() || {};
    console.error(`ABORT: another --execute run holds the lock (pid ${held.pid} on ${held.host}, started ${held.startedAt}).`);
    console.error(`If that run is dead, clear it deliberately:\n  firebase database:remove /${LOCK} --project marathon-club`);
    process.exit(1);
  }
  lockHeld = true;
  const release = async () => {
    if (!lockHeld) return;
    lockHeld = false;
    try { await db.ref(`${LOCK}/releasedAt`).set(new Date().toISOString()); } catch { /* best effort */ }
  };
  releaseLockOnCrash = release;
  process.on("exit", () => { if (lockHeld) console.error(`\n⚠ run lock still held — clear it: firebase database:remove /${LOCK} --project marathon-club`); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await release(); process.exit(130); });

  // ── apply group by group ─────────────────────────────────────────────────
  for (const p of planned) {
    // pre-write drift check: identical fresh reads, compared byte-for-byte.
    // ANY concurrent activity on this pair since planning skips the group —
    // a plan built on stale reads must never be applied.
    const again = await readGroupInputs(p.survivorKey, p.loserKey, p.canonical);
    if (stable(again) !== p.inputsHash) {
      report.aborted.push({ canonical: p.canonical, why: "drift between plan and apply — group skipped" });
      console.error(`  DRIFT  ${p.canonical} — skipped (re-run to re-plan)`);
      continue;
    }
    await db.ref().update(p.plan.updates);

    // per-group verify on fresh reads
    const [sAfter, lAfter] = await Promise.all([readAt(`customers/${p.survivorKey}`), readAt(`customers/${p.loserKey}`)]);
    const sBalAfter = creditBalance(sAfter || {});
    const lBalAfter = creditBalance(lAfter || {});
    const ok = sBalAfter.total === p.plan.checks.expectedSurvivorCreditCents
      && lBalAfter.total === 0 && lBalAfter.count === 0
      && lAfter?.mergedInto === p.survivorKey;
    if (!ok) {
      console.error(`  VERIFY FAILED ${p.canonical} — survivor credit ${sBalAfter.total} (expected ${p.plan.checks.expectedSurvivorCreditCents}), loser credit ${lBalAfter.total}/${lBalAfter.count}, mergedInto=${lAfter?.mergedInto}`);
      console.error(`  STOP. Restore this batch:\n    node scripts/rollback-customer-merge.mjs ${SNAPSHOT_PATH} --execute`);
      report.aborted.push({ canonical: p.canonical, why: "post-write verify failed" });
      writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), { mode: 0o600 }); chmodSync(REPORT_JSON, 0o600);
      await release();
      process.exit(1);
    }
    snapshot.appliedMergeIds.push(p.mergeId);
    report.applied.push({ canonical: p.canonical, mergeId: p.mergeId, checks: p.plan.checks });
    console.log(`  MERGED ${p.canonical}  ${p.loserKey} → ${p.survivorKey}`);
  }

  // ── run-wide money proof: recompute the whole base, paged ────────────────
  const customersAfter = await readMapPaged(db, "customers");
  const creditAfter = totalCreditAcross(customersAfter);
  console.log(`\ncredit total AFTER: R${(creditAfter.total / 100).toFixed(2)} in ${creditAfter.credits} records (before: R${(creditBefore.total / 100).toFixed(2)} in ${creditBefore.credits})`);
  report.creditAfter = creditAfter;

  // snapshot rewritten with what actually applied
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); chmodSync(SNAPSHOT_PATH, 0o600);
  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), { mode: 0o600 }); chmodSync(REPORT_JSON, 0o600);
  console.log(`report: ${REPORT_JSON}`);

  if (creditAfter.total !== creditBefore.total || creditAfter.credits !== creditBefore.credits) {
    console.error(`\n✗ MONEY INVARIANT BROKEN — total credit changed. RESTORE NOW:`);
    console.error(`    node scripts/rollback-customer-merge.mjs ${SNAPSHOT_PATH} --execute`);
    await release();
    process.exit(1);
  }
  console.log(`\n✓ money invariant holds: total credit identical to the cent.`);
  await release();
  // Same exit contract as the dry run: refusals count as failures too —
  // an execute run that silently skipped refused groups must not read as
  // fully clean (CodeRabbit, #364).
  process.exit(report.aborted.length || refused.length ? 1 : 0);
}

// Set once the execute-mode lock is acquired, so a thrown error releases it
// (the exit-handler alone only warns).
let releaseLockOnCrash = async () => {};

main().catch(async (e) => {
  console.error("MERGE RUN FAILED:", e);
  await releaseLockOnCrash();
  process.exit(1);
});
