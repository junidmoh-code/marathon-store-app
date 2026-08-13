// Rollback for customer-merge.mjs, driven by its disk snapshot.
//
//   node scripts/rollback-customer-merge.mjs <snapshot.json>            # dry
//   node scripts/rollback-customer-merge.mjs <snapshot.json> --execute
//   node scripts/rollback-customer-merge.mjs <snapshot.json> --execute --force
//   node scripts/rollback-customer-merge.mjs <snapshot.json> --only=<mergeId>
//
// Every path a merge touched is classified against BOTH recorded states:
//   alreadyRestored — current value equals the pre-merge value: no-op.
//   mergeOutput     — current value equals what the merge wrote: restore it.
//   DIVERGED        — something else happened after the merge (a redemption,
//                     an instalment, a new sale). REFUSED without --force,
//                     because blindly writing the pre-merge value would undo
//                     real money movement that happened since. --force sweeps
//                     every divergence through — read the list first.
// A merge whose paths are all alreadyRestored simply no-ops, so a snapshot
// from a crashed run (writes partially applied) restores cleanly without
// needing to know which groups landed.

import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const snapshotPath = process.argv[2];
const EXECUTE = process.argv.includes("--execute");
const FORCE = process.argv.includes("--force");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(",").map((s) => s.trim())) : null;

if (!snapshotPath || snapshotPath.startsWith("--")) {
  console.error("usage: node scripts/rollback-customer-merge.mjs <snapshot.json> [--execute] [--force] [--only=mergeId,…]");
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
if (!snapshot.executed) {
  console.error("ABORT: this snapshot came from a DRY RUN — there is nothing to roll back.");
  console.error("You almost certainly want the snapshot from the --execute run instead.");
  process.exit(1);
}

function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

const LOCK = "_migrations/customerPhoneMerge/runLock";

async function main() {
  console.log(`CUSTOMER MERGE ROLLBACK — ${EXECUTE ? "EXECUTE" : "DRY RUN"} (snapshot batch ${snapshot.batchId})\n`);

  const c = admin.app().options.credential;
  if (!c || typeof c.getAccessToken !== "function") {
    console.error("ABORT: not a privileged Admin SDK credential.");
    process.exit(1);
  }

  // Shared lock with the merge runner — a rollback racing a merge is the same
  // double-writer hazard as two merges.
  let lockHeld = false;
  if (EXECUTE) {
    const mine = { startedAt: new Date().toISOString(), pid: process.pid, host: hostname(), holder: "rollback", releasedAt: null };
    const { committed, snapshot: ls } = await db.ref(LOCK).transaction((cur) => {
      if (cur && cur.releasedAt == null) return;
      return mine;
    });
    if (!committed) {
      const held = ls.val() || {};
      console.error(`ABORT: run lock held (pid ${held.pid} on ${held.host}, started ${held.startedAt}).`);
      console.error(`If that run is dead:  firebase database:remove /${LOCK} --project marathon-club`);
      process.exit(1);
    }
    lockHeld = true;
  }
  const release = async () => {
    if (!lockHeld) return;
    lockHeld = false;
    try { await db.ref(`${LOCK}/releasedAt`).set(new Date().toISOString()); } catch { /* best effort */ }
  };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await release(); process.exit(130); });

  let restoredMerges = 0, noopMerges = 0, refusedMerges = 0;
  const divergences = [];

  for (const m of snapshot.merges) {
    if (ONLY && !ONLY.has(m.mergeId) && !ONLY.has(m.canonical)) continue;
    const paths = Object.keys(m.preState);
    const classes = {};
    let anyMergeOutput = false, anyDiverged = false;
    for (const path of paths) {
      const cur = (await db.ref(path).once("value")).val();
      const pre = m.preState[path];
      const out = m.updates[path] === undefined ? undefined : m.updates[path];
      if (stable(cur) === stable(pre)) classes[path] = "alreadyRestored";
      else if (out !== undefined && stable(cur) === stable(out)) { classes[path] = "mergeOutput"; anyMergeOutput = true; }
      else { classes[path] = "DIVERGED"; anyDiverged = true; divergences.push({ mergeId: m.mergeId, path, current: cur, preMerge: pre }); }
    }

    if (!anyMergeOutput && !anyDiverged) { noopMerges += 1; continue; }
    if (anyDiverged && !FORCE) {
      refusedMerges += 1;
      console.error(`  REFUSE ${m.mergeId} (${m.canonical}) — ${paths.filter((p) => classes[p] === "DIVERGED").length} path(s) diverged since the merge:`);
      for (const p of paths.filter((p) => classes[p] === "DIVERGED")) console.error(`      ${p}`);
      continue;
    }

    const restoreMap = {};
    for (const path of paths) {
      if (classes[path] === "alreadyRestored") continue;
      restoreMap[path] = m.preState[path]; // null = path did not exist pre-merge
    }
    console.log(`  ${EXECUTE ? "RESTORE" : "would restore"} ${m.mergeId} (${m.canonical}) — ${Object.keys(restoreMap).length} path(s)${anyDiverged ? " INCLUDING FORCED DIVERGENCES" : ""}`);
    if (EXECUTE) {
      await db.ref().update(restoreMap);
      // verify on fresh reads
      for (const path of Object.keys(restoreMap)) {
        const cur = (await db.ref(path).once("value")).val();
        if (stable(cur) !== stable(m.preState[path])) {
          console.error(`  VERIFY FAILED after restore at ${path} — STOP and inspect by hand.`);
          await release();
          process.exit(1);
        }
      }
    }
    restoredMerges += 1;
  }

  const reportPath = join(tmpdir(), `customer-merge-rollback-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(reportPath, JSON.stringify({ snapshotPath, batchId: snapshot.batchId, mode: EXECUTE ? "execute" : "dry-run", restoredMerges, noopMerges, refusedMerges, divergences }, null, 2));
  console.log(`\nrestored: ${restoredMerges}   already clean: ${noopMerges}   refused (diverged): ${refusedMerges}`);
  console.log(`report: ${reportPath}`);
  await release();
  process.exit(refusedMerges ? 1 : 0);
}

main().catch(async (e) => { console.error("ROLLBACK FAILED:", e); process.exit(1); });
