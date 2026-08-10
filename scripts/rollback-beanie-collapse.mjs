// ─── BEANIE ONE-SIZE COLLAPSE — ROLLBACK (DRY RUN BY DEFAULT) ────────────────
//
// Restores product identity from a rollback snapshot written by
// scripts/collapse-one-size-beanies.mjs: `sizes`, the `barcodes` map, every
// barcode index record, and the explicit /stock_targets rows the migration
// retired. Requires --execute; without it, prints exactly what it would write.
//
// ── WHAT THIS DOES NOT DO, AND WHY ───────────────────────────────────────────
// It does NOT move stock. After a collapse the units sit in the "_" cell, and
// restoring identity alone leaves them there while the product declares its old
// sizes again — the sized cell reads 0 and the "_" cell is invisible to a
// catalogue that no longer lists "_". That is a REAL half-state, so this script
// refuses to pretend otherwise: it prints the stock placement it is leaving
// behind and tells you the compensating movements needed.
//
// Stock is a ledger, not a snapshot. Overwriting cells from the snapshot file
// would erase every sale and receive since the run. Reversing the stock half
// means new paired movements in the opposite direction, with fresh ids.
//
// ── THE ACTIVITY CHECK (the reason this is a script and not a one-liner) ─────
// The verification step of the runbook SELLS at the till, deliberately — a scan
// that completes a real sale is the only proof the barcode index was repaired.
// So by the time anyone reaches for a rollback, later activity is not just
// possible, it is expected. Restoring identity under that activity can strand
// units that arrived in "_" after the collapse.
//
// This script therefore reads the ledger for movements against each product
// AFTER its migration instant and REFUSES by default when it finds any, naming
// them. --force proceeds anyway, and prints what it is overriding.
// (CodeRabbit, PR #343.)
//
// Usage:
//   node scripts/rollback-beanie-collapse.mjs <snapshot.json>
//   node scripts/rollback-beanie-collapse.mjs <snapshot.json> --execute
//   node scripts/rollback-beanie-collapse.mjs <snapshot.json> --execute --force
//   node scripts/rollback-beanie-collapse.mjs <snapshot.json> --only=pid1,pid2

import { createRequire } from "module";
import { readFileSync } from "fs";
import { hostname } from "os";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const io = {
  read: (p) => db.ref(p).once("value").then((s) => s.val()),
  update: (u) => db.ref().update(u),
};

// Module scope so EVERY exit path can reach it — including the outer .catch,
// which is a closure OUTSIDE the async IIFE and could not see a lock released
// inside it. An exception between acquisition and the end would otherwise leave
// the lock held and wedge the next run. (Kimi review, PR #344.)
let releaseLock = async () => {};

const args = process.argv.slice(2);
const SNAP_PATH = args.find((a) => !a.startsWith("--"));
const EXECUTE = args.includes("--execute");
const FORCE = args.includes("--force");
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);

// ── WHOSE MOVEMENTS ARE "MINE"? ──────────────────────────────────────────────
// Only the ids THIS snapshot's run applied, recorded in the snapshot itself.
// A prefix match on "onesize_" was a P0: it is global, so movements written by
// a LATER run of the same script were also discarded. The runbook's own
// multi-pass workflow (gated products cleared and re-run) produces exactly that
// — and a stale snapshot would then report "no later activity" and silently
// revert a product that a subsequent run had correctly migrated.
//
// A snapshot without the field (written before this was recorded) gets the
// fail-safe reading: nothing is excluded, so the migration's own movements
// count as later activity and the rollback refuses until a human looks.
// (Sonnet review of the rollback, PR #343.)
function ownMovementIds(snap) {
  const ids = snap.appliedMovementIds;
  return Array.isArray(ids) ? new Set(ids) : null;
}

(async () => {
  if (!SNAP_PATH) {
    console.error("usage: node scripts/rollback-beanie-collapse.mjs <snapshot.json> [--execute] [--force] [--only=pid,…]");
    process.exit(1);
  }
  const snap = JSON.parse(readFileSync(SNAP_PATH, "utf8"));
  console.log(`\n${"═".repeat(78)}\n  BEANIE COLLAPSE ROLLBACK — ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n  snapshot: ${SNAP_PATH}\n  captured ${snap.capturedAt} · run ${snap.runId || "(unrecorded)"} · mode ${snap.mode || "(unknown)"}\n${"═".repeat(78)}`);
  // A dry-run snapshot describes a state nothing ever changed — restoring from
  // it is a no-op at best and a way to undo someone else's work at worst.
  if (snap.mode === "dry-run") {
    console.log(`\n  ⚠ THIS IS A DRY-RUN SNAPSHOT — the run that wrote it changed nothing.`);
    console.log(`  You almost certainly want the snapshot from the --execute run instead.`);
  }

  let pids = Object.keys(snap.products || {});
  if (ONLY.length) pids = pids.filter((p) => ONLY.includes(p));
  console.log(`  products in snapshot: ${Object.keys(snap.products || {}).length}${ONLY.length ? ` (restoring ${pids.length})` : ""}`);

  const capturedMs = Date.parse(snap.capturedAt);
  if (!Number.isFinite(capturedMs)) {
    console.error("ABORT: snapshot has no readable capturedAt — cannot tell later activity from earlier.");
    process.exit(1);
  }

  // EXECUTE ONLY. A dry run writes nothing, so it must not take a lock — and
  // it exits before the write, so it would never release one either.
  let LOCK = "_migrations/beanieOneSizeCollapse/runLock";
  if (EXECUTE) {
    // ── TAKE THE MIGRATION'S OWN LOCK — do not merely peek at it ──────────────
    // A rollback --execute overlapping a migration --execute produces interleaved
    // writes that are each atomic and jointly wrong: the rollback restores
    // sizes ["M"] for a product the migration is a moment from collapsing, and
    // step 2 lands over it, both reporting success.
    //
    // READING the lock only blocks a migration that was ALREADY running. It does
    // nothing about one that starts a second later. Nothing on the migration side
    // knows a rollback is in progress, either.
    //
    // AND IT IS TAKEN FIRST, before the activity read and the divergence loop —
    // those do one sequential read per path, and a migration running DURING them
    // would finish before a later acquisition, leaving the plan built from
    // classifications that were already stale. The lock has to cover the reads
    // the decision rests on, not just the write. (Kimi review, PR #344.)
    //
    // So the rollback ACQUIRES the same lock, by the same transaction, for the
    // duration of its run. That makes the exclusion symmetric: a migration
    // starting mid-rollback is refused by the lock the rollback is holding, which
    // a stale read could never do. (Sonnet review, PR #344.)
    LOCK = "_migrations/beanieOneSizeCollapse/runLock";
    const { committed, snapshot: lockSnap } = await db.ref(LOCK).transaction((cur) => {
      if (cur && cur.releasedAt == null) return;              // abort: someone holds it
      return { startedAt: new Date().toISOString(), pid: process.pid, host: hostname(), releasedAt: null, holder: "rollback" };
    });
    if (!committed) {
      const held = lockSnap.val() || {};
      console.error(`\nABORT: a ${held.holder === "rollback" ? "rollback" : "migration"} run holds the lock (pid ${held.pid} on ${held.host}, started ${held.startedAt}).`);
      console.error("A rollback interleaved with a live migration writes over it. Wait for that run");
      console.error("to finish (or confirm it is dead and clear the lock), then re-run this:");
      console.error(`  firebase database:remove /${LOCK} --project marathon-club`);
      process.exit(1);
    }
    let lockHeld = true;
    releaseLock = async () => {
      if (!lockHeld) return;
      // Clear the flag ONLY on a successful release. Clearing it first meant a
      // failed release silenced the exit warning too, leaving a stale lock with
      // nothing on screen to say so. (Kimi review, PR #344.)
      try {
        await io.update({ [`${LOCK}/releasedAt`]: new Date().toISOString() });
        lockHeld = false;
      } catch (e) {
        console.error(`  ⚠ could not release the lock (${e.message}) — clear it by hand.`);
      }
    };
    process.on("exit", () => { if (lockHeld) console.error(`\n⚠ lock still held — clear it: firebase database:remove /${LOCK} --project marathon-club`); });
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await releaseLock(); process.exit(130); });
  }

  // ── activity check ────────────────────────────────────────────────────────
  const movements = (await io.read("stock_movements")) || {};
  const own = ownMovementIds(snap);
  if (!own) {
    console.log(`\n  NOTE — this snapshot does not record which movement ids its run applied.`);
    console.log(`  Every movement after its capture instant therefore counts as later activity,`);
    console.log(`  including the migration's own. That is deliberate: without the record there`);
    console.log(`  is no way to tell this run's writes from a later run's.`);
  }
  const laterActivity = new Map();
  for (const [id, m] of Object.entries(movements)) {
    if (!m || !pids.includes(m.productId) || (own && own.has(id))) continue;
    const ts = Date.parse(m.appliedAt || m.ts);
    const list = laterActivity.get(m.productId) || [];
    // An UNREADABLE stamp counts as later activity, matching the migration's own
    // recency gate. Skipping it was the fail-open reading — a movement that
    // cannot be placed in time cannot be shown to predate the snapshot, and this
    // check exists precisely to refuse when it cannot be sure. (Kimi review of
    // the rollback, PR #343.)
    if (!Number.isFinite(ts)) {
      list.push(`${id} (${m.type} ${m.qty} ${m.size}, UNREADABLE timestamp — cannot be shown to predate the snapshot)`);
      laterActivity.set(m.productId, list);
      continue;
    }
    if (ts <= capturedMs) continue;
    list.push(`${id} (${m.type} ${m.qty} ${m.size} ${new Date(ts).toISOString()})`);
    laterActivity.set(m.productId, list);
  }

  // ── current stock placement, so the half-state is stated, not hidden ───────
  const stock = (await io.read("stock")) || {};
  const placement = {};
  for (const [loc, byPid] of Object.entries(stock)) {
    for (const pid of pids) {
      for (const [sizeKey, cell] of Object.entries(byPid?.[pid] || {})) {
        const q = typeof cell?.qty === "number" ? cell.qty : 0;
        if (q !== 0) (placement[pid] = placement[pid] || []).push(`${loc}/${sizeKey}=${q}`);
      }
    }
  }

  // ── the write plan ────────────────────────────────────────────────────────
  const updates = {};
  const unattributed = [];
  for (const pid of pids) {
    const p = snap.products[pid];
    updates[`products/${pid}/sizes`] = p.sizes ?? null;
    updates[`products/${pid}/barcodes`] = p.barcodes ?? null;
  }
  // WHOLE index records, not just `size` — a record may carry more than that,
  // and a snapshot entry of null means the record did NOT exist before the run
  // and must be REMOVED, not left behind. (CodeRabbit, PR #343.)
  //
  // OWNERSHIP COMES FROM THE SNAPSHOT'S PRODUCT MAPS, not from the record. A
  // null entry has no productId to filter on, so filtering on the record alone
  // meant `--only=pA` planned `barcodes/<pB's code> = null` and DELETED an
  // unrelated product's barcode — reproduced before fixing. The snapshot knows
  // which product listed each code; ask it.
  const snapPids = new Set(pids);
  const ownerOfCode = new Map();
  for (const [pid, p] of Object.entries(snap.products || {})) {
    for (const code of Object.values(p?.barcodes || {})) ownerOfCode.set(String(code), pid);
  }
  for (const [code, rec] of Object.entries(snap.barcodeIndex || {})) {
    const owner = rec?.productId || ownerOfCode.get(String(code));
    // Unknown owner (a null record for a code no snapshot product lists) is not
    // ours to touch — deleting a record we cannot attribute is the one
    // irreversible thing this script could do by accident.
    if (!owner) { unattributed.push(code); continue; }
    if (!snapPids.has(owner)) continue;                       // another product's code
    updates[`barcodes/${code}`] = rec ?? null;
  }
  // Target rows the migration retired to 0 — restoring identity without them
  // leaves the product with its old sizes and no refill policy.
  for (const [loc, byPid] of Object.entries(snap.stockTargets || {})) {
    for (const [pid, rows] of Object.entries(byPid)) {
      if (!snapPids.has(pid)) continue;
      updates[`stock_targets/${loc}/${pid}`] = rows ?? null;
    }
  }

  // ── DIVERGENCE CHECK — is the live value still the one this rollback expects?
  // The activity check watches /stock_movements only, so it is blind to drift in
  // IDENTITY and POLICY. Two real cases:
  //   • a barcode legitimately reassigned to another product since the collapse
  //     (merge, re-tag) — a blind restore steals it back and breaks scanning for
  //     whoever owns it now;
  //   • explicit "_" target rows added after the collapse to arm the new policy
  //     — the snapshot has no "_" row, so a blind restore of the whole node
  //     DELETES the policy the owner just approved.
  // So every path is compared against the live value first, and classified:
  //   already-restored → dropped from the plan (nothing to do)
  //   post-migration   → the expected rollback target, written
  //   diverged         → someone changed it since; refuse without --force
  // (Sonnet review of the rollback, PR #343.)
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const diverged = [], alreadyRestored = [];
  for (const path of Object.keys(updates)) {
    const live = await io.read(path);
    const want = updates[path];
    if (same(live, want)) { alreadyRestored.push(path); delete updates[path]; continue; }
    let expected = false;
    if (/^products\/[^/]+\/sizes$/.test(path)) expected = same(live, ["_"]);
    else if (/^products\/[^/]+\/barcodes$/.test(path)) {
      // KEY SHAPE IS NOT ENOUGH. A single "_" key whose CODE is not one this
      // snapshot recorded means the product was re-tagged since the collapse —
      // restoring the old map would silently drop the new code and orphan its
      // index record. Check the value too. (Sonnet review, PR #344.)
      const keys = Object.keys(live || {});
      // From the product map AND the codes the snapshot attributes to this pid.
      // planStep2 picks its keepCode from the UNION of the map and the reverse
      // index, so a product whose map "forgot" a code gets a keepCode that is
      // index-only — and checking the map alone would classify the migration's
      // OWN output as diverged. That false positive is worse than it looks: it
      // trains the operator to reach for --force, which then sweeps every
      // genuine divergence through unnoticed. (Kimi review, PR #344.)
      const thisPid = path.split("/")[1];
      const snapCodes = new Set([
        ...Object.values(snap.products[thisPid]?.barcodes || {}).map(String),
        ...Object.entries(snap.barcodeIndex || {}).filter(([, r]) => r?.productId === thisPid).map(([c]) => String(c)),
      ]);
      expected = keys.length === 1 && keys[0] === "_" && snapCodes.has(String(live["_"]));
    }
    else if (/^barcodes\//.test(path)) expected = !!live && live.size === "_" && (!want || live.productId === want.productId);
    else if (/^stock_targets\//.test(path)) {
      // A row is "as the migration left it" only if the WHOLE row matches what
      // Step 3 writes — target 0, minQty 0, source "excluded". Comparing only
      // `target` let a later edit to minQty or source read as untouched and be
      // silently overwritten by the pre-collapse values. (Sonnet review, PR #344.)
      const keys = Object.keys(live || {});
      expected = keys.length > 0 && !keys.includes("_") && keys.every((k) => {
        const row = live[k] || {};
        // minQty ?? 0 — planStep3 skips a row already retired by other tooling
        // ({target:0, source:"excluded"} with no minQty), so requiring an
        // explicit 0 would flag a row the migration deliberately left alone.
        return row.target === 0 && (row.minQty ?? 0) === 0 && row.source === "excluded";
      });
    }
    if (!expected) diverged.push({ path, live, want });
  }

  if (alreadyRestored.length) console.log(`\n  ${alreadyRestored.length} path(s) already match the snapshot — nothing to do for those.`);
  if (diverged.length) {
    console.log(`\n── LIVE STATE HAS DIVERGED (${diverged.length} path(s)) ─────────────────────────`);
    console.log(`  These are neither the snapshot value nor what the migration left behind —`);
    console.log(`  something changed them since. Overwriting would destroy that change.`);
    for (const d of diverged.slice(0, 10)) {
      console.log(`  ${d.path}\n     live: ${JSON.stringify(d.live)?.slice(0, 90)}\n     would write: ${JSON.stringify(d.want)?.slice(0, 90)}`);
    }
    if (diverged.length > 10) console.log(`  … and ${diverged.length - 10} more`);
  }

  if (unattributed.length) {
    console.log(`\n  NOTE — ${unattributed.length} snapshot index entr(ies) name no product in this snapshot`);
    console.log(`  and are left ALONE rather than deleted: ${unattributed.slice(0, 6).join(", ")}${unattributed.length > 6 ? ", …" : ""}`);
  }
  console.log(`\n── WRITE PLAN (${Object.keys(updates).length} paths) ─────────────────────────────────`);
  for (const [path, v] of Object.entries(updates).slice(0, 12)) console.log(`  ${path.padEnd(52)} = ${JSON.stringify(v)?.slice(0, 60)}`);
  if (Object.keys(updates).length > 12) console.log(`  … and ${Object.keys(updates).length - 12} more`);

  console.log(`\n── STOCK PLACEMENT THIS ROLLBACK DOES NOT CHANGE ──────────────────────────`);
  console.log(`  Restoring identity does NOT move stock. Units that the collapse merged into`);
  console.log(`  the "_" cell STAY there, while the product will again declare its old sizes —`);
  console.log(`  so those units read as 0 on the sized cell and are invisible to the app.`);
  const placed = Object.entries(placement);
  if (!placed.length) console.log("  (no product in scope holds stock anywhere)");
  for (const [pid, cells] of placed.slice(0, 15)) console.log(`  ${pid}  ${cells.join("  ")}`);
  if (placed.length > 15) console.log(`  … and ${placed.length - 15} more products`);
  console.log(`  To finish a rollback, move each "_" balance back with FRESH paired movements`);
  console.log(`  (new ids — the migration's own ids are spent and would no-op).`);

  console.log(`\n── LATER ACTIVITY SINCE THE SNAPSHOT ──────────────────────────────────────`);
  if (!laterActivity.size) {
    console.log("  none — no non-migration movement for these products after the snapshot instant");
  } else {
    for (const [pid, list] of laterActivity) {
      console.log(`  ${pid}: ${list.length} movement(s)`);
      for (const l of list.slice(0, 4)) console.log(`     ${l}`);
      if (list.length > 4) console.log(`     … and ${list.length - 4} more`);
    }
  }

  if (!EXECUTE) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --execute to apply.`);
    process.exit(0);
  }
  if (diverged.length && !FORCE) {
    console.error(`\nABORT: ${diverged.length} path(s) have diverged from what this rollback expects.`);
    console.error("Restoring them would overwrite a change made after the migration — a barcode");
    console.error("reassigned to another product, or a target policy armed since. Reconcile them,");
    console.error("or re-run with --force if you have decided the snapshot value is what you want.");
    await releaseLock();
    process.exit(1);
  }
  if (laterActivity.size && !FORCE) {
    console.error(`\nABORT: ${laterActivity.size} product(s) have moved since the snapshot.`);
    console.error("Restoring identity now can strand units that arrived in the \"_\" cell after");
    console.error("the collapse. Reconcile the stock placement above first, or re-run with");
    console.error("--force if you have decided the identity restore is what you want anyway.");
    await releaseLock();
    process.exit(1);
  }
  if (laterActivity.size && FORCE) {
    console.log(`\n  --force: proceeding over later activity on ${laterActivity.size} product(s), listed above.`);
  }

  // ── LAST-MOMENT RE-CHECK ──────────────────────────────────────────────────
  // The activity read above happened before the write plan was printed and
  // before a human read it. A sale landing in that gap would strand units under
  // a freshly restored identity with no refusal, so the ledger is read again
  // here, immediately before the write. Same reasoning as the migration's own
  // recency gate: the check is worth little if it is minutes stale.
  // (Kimi review of the rollback, PR #343 follow-up.)
  const movementsNow = (await io.read("stock_movements")) || {};
  const appeared = [];
  for (const [id, m] of Object.entries(movementsNow)) {
    if (!m || !pids.includes(m.productId) || (own && own.has(id)) || movements[id]) continue;
    appeared.push(`${id} (${m.type} ${m.qty} ${m.size} ${m.appliedAt || m.ts})`);
  }
  if (appeared.length && !FORCE) {
    console.error(`\nABORT: ${appeared.length} movement(s) landed while this plan was being read:`);
    for (const a of appeared.slice(0, 6)) console.error(`     ${a}`);
    console.error("Someone is trading against these products right now. Re-run when it is quiet.");
    await releaseLock();
    process.exit(1);
  }
  if (appeared.length) console.log(`\n  --force: proceeding over ${appeared.length} movement(s) that landed during this run.`);

  await io.update(updates);
  console.log(`\n  RESTORED ${Object.keys(updates).length} paths.`);

  // verify on fresh reads
  const problems = [];
  for (const pid of pids) {
    const p = await io.read(`products/${pid}`);
    if (JSON.stringify(p?.sizes ?? null) !== JSON.stringify(snap.products[pid].sizes ?? null)) problems.push(`${pid} sizes = ${JSON.stringify(p?.sizes)}`);
    if (JSON.stringify(p?.barcodes ?? null) !== JSON.stringify(snap.products[pid].barcodes ?? null)) problems.push(`${pid} barcodes = ${JSON.stringify(p?.barcodes)}`);
  }
  for (const [code, rec] of Object.entries(snap.barcodeIndex || {})) {
    const owner = rec?.productId || ownerOfCode.get(String(code));
    if (!owner || !snapPids.has(owner)) continue;
    const live = await io.read(`barcodes/${code}`);
    if (JSON.stringify(live ?? null) !== JSON.stringify(rec ?? null)) problems.push(`barcodes/${code} = ${JSON.stringify(live)}`);
  }
  // TARGET ROWS — the verify claimed to cover these and did not. A claim in the
  // success message that nothing checks is worse than no claim.
  // (Sonnet review of the rollback, PR #343.)
  for (const [loc, byPid] of Object.entries(snap.stockTargets || {})) {
    for (const [pid, rows] of Object.entries(byPid)) {
      if (!snapPids.has(pid)) continue;
      const live = await io.read(`stock_targets/${loc}/${pid}`);
      if (JSON.stringify(live ?? null) !== JSON.stringify(rows ?? null)) problems.push(`stock_targets/${loc}/${pid} = ${JSON.stringify(live)?.slice(0, 80)}`);
    }
  }
  await releaseLock();
  console.log(problems.length ? `\n  VERIFY FAILED:\n${problems.map((p) => `     ${p}`).join("\n")}` : "  verified on fresh reads: sizes, barcodes map, index records AND target rows all match the snapshot");
  process.exit(problems.length ? 1 : 0);
})().catch(async (e) => { console.error(e); await releaseLock(); process.exit(1); });
