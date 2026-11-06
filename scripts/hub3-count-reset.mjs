// ─── HUB 3 COUNT RESET (Junid, 6 Nov 2026) ───────────────────────────────────
// Zero every Hub 3 stock cell so staff can recount from nothing, with a
// recoverable trail. Logic + guards: scripts/lib/hub3CountReset.mjs.
//
//   node scripts/hub3-count-reset.mjs                 # DRY RUN (default) — reads /stock/hub3 once, writes nothing
//   node scripts/hub3-count-reset.mjs --apply         # writes: before-file, resets record, one adjustment per non-zero cell,
//                                                     #         clears counted/sessions/register for hub3, count mode ON
//   node scripts/hub3-count-reset.mjs --verify <file> # PASS/FAIL: every reset cell reads 0 (or moved on since), ledger sums match
//
// Credentials: Application Default Credentials (gcloud auth application-default login).
// Writes only: stock/hub3/** cells, their stock_movements/h3reset_* ledger rows (applyMovementAdmin),
// settings/hubSneakerCount/{resets,counted,sessions,register,countMode,countModeMeta}/hub3
// and config/refillEngine/pausedLocations/hub3. Never in_transit, never settings/stockHold.
// --apply REFUSES when a reset of Hub 3 is already recorded (a second run would zero what
// staff have counted since and wipe their markers) unless --force is given.
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "./adminRequire.mjs";
import { HUB, planReset, assertOnlyHub3, applyReset, markerClearUpdate, verifyReset, COUNT_ROOT } from "./lib/hub3CountReset.mjs";

if (process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error(`FIREBASE_DATABASE_EMULATOR_HOST is set (${process.env.FIREBASE_DATABASE_EMULATOR_HOST}) — unset it to run against the live database.`);
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
const { applyMovementAdmin } = require(join(ROOT, "functions/lib/admin-movement.cjs"));

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const vi = process.argv.indexOf("--verify");
const VERIFY_FILE = vi > 0 ? process.argv[vi + 1] : null;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const val = async (p) => (await db.ref(p).once("value")).val();

async function main() {
  const offset = (await val(".info/serverTimeOffset")) || 0;
  const serverNowMs = () => Date.now() + offset;

  if (VERIFY_FILE) {
    const saved = JSON.parse(readFileSync(VERIFY_FILE, "utf8"));
    const r = await verifyReset({ db, plan: saved.plan });
    console.log(JSON.stringify({ ...r, problems: r.problems.slice(0, 40) }, null, 2));
    console.log(r.pass ? "PASS" : "FAIL");
    process.exit(r.pass ? 0 : 1);
  }

  const loc = await val(`locations/${HUB}`);
  if (!loc) throw new Error(`/locations/${HUB} does not exist — refusing.`);
  const resetId = String(serverNowMs());   // epoch-ms key (never an ISO string in a key)
  const hubStock = (await val(`stock/${HUB}`)) || {};    // THE one read of /stock/hub3
  const plan = planReset(hubStock, { resetId });
  assertOnlyHub3(plan);
  const [mode, paused] = await Promise.all([val(`${COUNT_ROOT}/countMode/${HUB}`), val(`config/refillEngine/pausedLocations/${HUB}`)]);

  console.log("═".repeat(78));
  console.log(`  HUB 3 COUNT RESET — ${APPLY ? "APPLY" : "DRY RUN (nothing written)"}   location: ${HUB} (${loc.label || loc.name || "?"})`);
  console.log("═".repeat(78));
  console.log(JSON.stringify({ resetId, ...plan.summary, skipped: plan.skipped.length, countModeNow: mode === true, pausedNow: paused === true }, null, 2));
  if (plan.skipped.length) console.log("skipped:", JSON.stringify(plan.skipped.slice(0, 20)));
  console.log("largest positives:", plan.cells.filter((c) => c.before > 0).sort((a, b) => b.before - a.before).slice(0, 5).map((c) => `${c.pid}/${c.sizeKey}=${c.before}`).join(", "));
  console.log("largest negatives:", plan.cells.filter((c) => c.before < 0).sort((a, b) => a.before - b.before).slice(0, 5).map((c) => `${c.pid}/${c.sizeKey}=${c.before}`).join(", "));
  const earlier = await db.ref(`${COUNT_ROOT}/resets/${HUB}`).orderByKey().limitToLast(1).once("value");
  if (earlier.exists()) {
    const k = Object.keys(earlier.val())[0];
    console.log(`\nA reset of ${HUB} is already recorded (${k}). A second --apply zeroes every cell counted since and wipes the count markers.`);
    if (APPLY && !FORCE) { console.log("REFUSED. Re-run with --apply --force only if that is really wanted."); process.exitCode = 3; return; }
  }
  if (!APPLY) { console.log("\nDry run only. Re-run with --apply to write."); return; }

  // 1. the before-state, BEFORE any write — local file, then RTDB
  const [counted, sessions, register] = await Promise.all([
    val(`${COUNT_ROOT}/counted/${HUB}`), val(`${COUNT_ROOT}/sessions/${HUB}`), val(`${COUNT_ROOT}/register/${HUB}`),
  ]);
  mkdirSync(join(ROOT, "scripts/out"), { recursive: true });
  const file = join(ROOT, "scripts/out", `hub3-before-${resetId}.json`);
  const nowIso = new Date(serverNowMs()).toISOString();
  const saved = { resetId, at: nowIso, hub: HUB, summary: plan.summary, stock: hubStock, markers: { counted, sessions, register }, plan };
  writeFileSync(file, JSON.stringify(saved));
  console.log(`before-state written: ${file}`);
  await db.ref(`${COUNT_ROOT}/resets/${HUB}/${resetId}`).set({
    at: nowIso, by: "system:hub3-count-reset", ...plan.summary, nonZero: plan.nonZero, file: `scripts/out/hub3-before-${resetId}.json`,
  });

  // 2. count mode ON first, so the POS stops deducting uncounted cells before they reach 0
  await db.ref().update({
    [`${COUNT_ROOT}/countMode/${HUB}`]: true,
    [`config/refillEngine/pausedLocations/${HUB}`]: true,
  });

  // 3. one guarded adjustment per non-zero cell
  const r = await applyReset({ db, plan, applyMovementAdmin, nowMs: serverNowMs(), log: console.log });
  const applied = new Map(r.done.map((d) => [d.movementId, d.applied]));
  for (const c of plan.cells) if (applied.has(c.movementId)) c.applied = applied.get(c.movementId);
  saved.plan = plan; saved.result = { removed: r.removed, added: r.added, done: r.done.length, refused: r.refused };
  writeFileSync(file, JSON.stringify(saved));

  // 4. markers cleared + both flags confirmed, one update
  await db.ref().update(markerClearUpdate({ nowIso: new Date(serverNowMs()).toISOString() }));
  await db.ref(`${COUNT_ROOT}/resets/${HUB}/${resetId}/applied`).set({
    at: new Date(serverNowMs()).toISOString(), zeroed: r.done.length, unitsRemoved: r.removed, negativeUnitsCleared: r.added,
    refused: r.refused.length ? r.refused.map((x) => ({ path: x.path, reason: x.reason })) : null,
  });
  const after = await Promise.all([val(`${COUNT_ROOT}/countMode/${HUB}`), val(`config/refillEngine/pausedLocations/${HUB}`)]);
  console.log(JSON.stringify({ zeroed: r.done.length, unitsRemoved: r.removed, negativeUnitsCleared: r.added, refused: r.refused.length, countMode: after[0] === true, paused: after[1] === true }, null, 2));
  if (r.refused.length) console.log("REFUSED:", JSON.stringify(r.refused.slice(0, 20).map((x) => [x.path, x.reason])));
  console.log(`\nVerify:  node scripts/hub3-count-reset.mjs --verify ${file}`);
  if (r.refused.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
