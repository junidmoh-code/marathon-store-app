// ─── ONE-OFF: RELEASE THE CONCRETE DIVISION NOW (Junid, 10 Nov 2026) ─────────
// Runs the deployed scan's own code (functions/refill-scan.cjs) in its
// division-only mode: it plans exactly as the hourly scan does, then applies
// ONLY Hub 3 / Pine / Concrete work. No Marathon line is raised, closed or
// moved early; no refusal write-off, shadow sync, exceptions snapshot or audit
// write. It takes the engine lock like any run, so it can never overlap one.
// The run record lands at refill_engine/runs/<runId>-division.
//   node scripts/run-division-release.mjs            (refuses: nothing written)
//   node scripts/run-division-release.mjs --apply
// Run it from a checkout at the deployed commit, so the code is the live code.
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

if (!process.argv.includes("--apply")) {
  console.error("Refusing: pass --apply to run the division-only release against the live database.");
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "functions", "package.json"));
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const scan = require(join(ROOT, "functions", "refill-scan.cjs"));
const t0 = Date.now();
await scan._runDivisionRelease();
const runs = (await admin.database().ref("refill_engine/runs").orderByKey().limitToLast(3).once("value")).val() || {};
const mine = Object.entries(runs).filter(([k]) => k.endsWith("-division")).pop();
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`, mine ? JSON.stringify({ runId: mine[0], counts: mine[1].counts, policy: mine[1].policy }) : "no division run record found (lock held by another run? re-run after it finishes)");
process.exit(0);
