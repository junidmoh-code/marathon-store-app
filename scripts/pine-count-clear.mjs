// ─── PINE SHOP COUNT CLEAR (Junid, 11 Nov 2026) ──────────────────────────────
// Junid is physically counting the Marathon Pine SHOP. Every stock cell held at
// the Pine shop (location `marathon-pine`) goes to 0 so the count starts from a
// clean baseline — the same reset as the Hub 3 clear of 6 Nov 2026, through the
// same library (scripts/lib/hub3CountReset.mjs, PINE_SCOPE): one guarded
// `adjustment` per non-zero cell via functions/lib/admin-movement.cjs, ledger
// reason "pine-count-clear", timestamps from serverNowMs().
//
//   node scripts/pine-count-clear.mjs                     # DRY RUN — cells + units to zero, writes nothing
//   node scripts/pine-count-clear.mjs --apply             # backup file FIRST, then the clear
//   node scripts/pine-count-clear.mjs --verify  <file>    # PASS/FAIL: every cleared cell reads 0 (or moved on since)
//   node scripts/pine-count-clear.mjs --restore <file>    # DRY RUN of the reversal
//   node scripts/pine-count-clear.mjs --restore <file> --apply
//        # REVERSAL: adds back to each cell exactly what the clear removed
//        # (one `adjustment` per cell, reason "pine-count-clear-reversal",
//        # idempotent by movement id). It ADDS — anything counted since stays
//        # on top of it.
//
// Run it ON THE MAC MINI: the backup is written to ~/marathon-rollbacks there
// (override with --backup-dir) and read back before a single write; --apply is
// refused on any other machine unless --any-host is given.
//
// What this does NOT do (Junid's constraints):
//   • never countMode for Pine — the never-below-zero sale rule at Pine stays
//     exactly as it is (a sale on a cleared cell floors at 0 with a shortfall);
//   • never the refill-engine pause — that is its own toggle
//     (/config/refillEngine/pausedLocations/marathon-pine, Hub Count card);
//     --apply REFUSES while Pine is not paused, so the hourly scan cannot raise
//     requests for the zeroed cells;
//   • never another location, never in_transit, never settings/stockHold;
//   • never a whole-node read: /locations is read SHALLOW (keys only) to prove
//     the Pine key is unique, and the only stock read is /stock/marathon-pine.
import { mkdirSync, readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from "fs";
import { dirname, join } from "path";
import { homedir, hostname } from "os";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { adminRequire } from "./adminRequire.mjs";
import { PINE_SCOPE, planReset, assertOnlyLocation, applyReset, verifyReset, decodeSizeKey, COUNT_ROOT } from "./lib/hub3CountReset.mjs";

const LOC = PINE_SCOPE.loc;
const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

if (process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error(`FIREBASE_DATABASE_EMULATOR_HOST is set (${process.env.FIREBASE_DATABASE_EMULATOR_HOST}) — unset it to run against the live database.`);
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
const { applyMovementAdmin } = require(join(ROOT, "functions/lib/admin-movement.cjs"));
const registry = require(join(ROOT, "functions/lib/network-registry.cjs"));

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = flag("--apply"), FORCE = flag("--force"), ANY_HOST = flag("--any-host");
const VERIFY_FILE = opt("--verify"), RESTORE_FILE = opt("--restore");
const BACKUP_DIR = opt("--backup-dir") || join(homedir(), "marathon-rollbacks");

const credential = admin.credential.applicationDefault();
admin.initializeApp({ credential, databaseURL: DB_URL });
const db = admin.database();
const val = async (p) => (await db.ref(p).once("value")).val();

/** Every registry location whose id, name or alias says "pine" (retired ones too). */
function pineCandidatesInRegistry(reg) {
  return Object.values(reg.locations || {}).filter((l) =>
    [l.id, l.name, ...(l.aliases || [])].some((s) => /pine/i.test(String(s || ""))),
  ).map((l) => l.id);
}

async function shallowKeys(path) {
  const { access_token } = await credential.getAccessToken();
  const res = await fetch(`${DB_URL}/${path}.json?shallow=true`, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!res.ok) throw new Error(`shallow read of /${path} failed: HTTP ${res.status}`);
  return Object.keys((await res.json()) || {});
}

/** STOP if the Pine key is ambiguous: exactly one registry match and one live /locations key. */
async function resolvePine() {
  const reg = pineCandidatesInRegistry(registry.DEFAULT_NETWORK);
  const live = (await shallowKeys("locations")).filter((k) => /pine/i.test(k));
  const stockKeys = (await shallowKeys("stock")).filter((k) => /pine/i.test(k));
  const ok = reg.length === 1 && reg[0] === LOC && live.length === 1 && live[0] === LOC && stockKeys.every((k) => k === LOC);
  return { ok, reg, live, stockKeys };
}

// Durable + atomic: write a temp file, fsync it, rename over the target — a
// failed or interrupted write never truncates a backup already on disk.
function writeDurable(file, body) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sastDate = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(0, 10);

async function restore(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  if (saved.hub !== LOC || !saved.plan || saved.plan.scope?.loc !== LOC) throw new Error(`${file} is not a Pine clear backup — refusing.`);
  const offset = (await val(".info/serverTimeOffset")) || 0;
  const nowIso = new Date(Date.now() + offset).toISOString();
  // Add back exactly what each cell lost to the clear — taken from the clear's
  // OWN ledger row (read by id), never from the plan, so an interrupted run
  // gives back only the cells it really zeroed.
  const rows = [], negativesNotRestored = [];
  for (const c of saved.plan.cells) {
    const row = (await db.ref(`stock_movements/${c.movementId}`).once("value")).val();
    if (!row || row.reason !== PINE_SCOPE.reason) continue;
    const give = row.from === LOC ? Number(row.qty) : row.to === LOC ? -Number(row.qty) : 0;
    if (give > 0) rows.push({ ...c, give });
    // A cell the clear raised from below zero is NOT pushed back negative:
    // Pine never goes below zero. Listed for a person to judge.
    else if (give < 0) negativesNotRestored.push(`${c.path} (was ${give})`);
  }
  const units = rows.reduce((t, c) => t + c.give, 0);
  console.log(JSON.stringify({ restoreFrom: file, resetId: saved.resetId, cells: rows.length, unitsBack: units, negativesNotRestored, apply: APPLY }, null, 2));
  if (!APPLY) { console.log("Dry run only. Re-run with --restore <file> --apply to write."); return; }
  let done = 0; const refused = [];
  for (const c of rows) {
    if (!c.path.startsWith(`stock/${LOC}/`)) { refused.push([c.path, "outside_pine"]); continue; }
    const r = await applyMovementAdmin(db, {
      type: "adjustment", productId: c.pid, size: decodeSizeKey(c.sizeKey), sizeKey: c.sizeKey,
      qty: c.give, from: null, to: LOC,
      reason: "pine-count-clear-reversal", movementId: `pineundo_${saved.resetId}_${c.pid}_${c.sizeKey}`,
      actor: "system:pine-count-clear", actorRole: "admin", ts: nowIso,
      link: { deviceId: null, countResetId: saved.resetId, countLocation: LOC, reversalOf: c.movementId },
    }, { nowIso });
    if (r.ok) done++; else refused.push([c.path, r.reason]);
  }
  console.log(JSON.stringify({ restored: done, refused: refused.length }, null, 2));
  if (refused.length) { console.log("REFUSED:", JSON.stringify(refused.slice(0, 20))); process.exitCode = 1; }
}

async function main() {
  const offset = (await val(".info/serverTimeOffset")) || 0;
  const serverNowMs = () => Date.now() + offset;

  if (VERIFY_FILE) {
    const saved = JSON.parse(readFileSync(VERIFY_FILE, "utf8"));
    const r = await verifyReset({ db, plan: saved.plan });
    console.log(JSON.stringify({ ...r, problems: r.problems.slice(0, 40) }, null, 2));
    console.log(r.pass ? "PASS" : "FAIL");
    process.exitCode = r.pass ? 0 : 1;
    return;
  }
  if (RESTORE_FILE) return restore(RESTORE_FILE);

  const who = await resolvePine();
  if (!who.ok) {
    console.error(`STOP: the Pine location key is ambiguous — registry ${JSON.stringify(who.reg)}, /locations ${JSON.stringify(who.live)}, /stock ${JSON.stringify(who.stockKeys)}. Nothing written.`);
    process.exitCode = 4; return;
  }
  const loc = await val(`locations/${LOC}`);
  if (!loc) throw new Error(`/locations/${LOC} does not exist — refusing.`);

  const resetId = String(serverNowMs());               // epoch-ms key
  const pineStock = (await val(`stock/${LOC}`)) || {};  // THE one read of Pine's stock
  const plan = planReset(pineStock, { resetId, scope: PINE_SCOPE });
  assertOnlyLocation(plan);
  const paused = (await val(`config/refillEngine/pausedLocations/${LOC}`)) === true;
  const toZeroUnits = plan.cells.reduce((t, c) => t + Math.max(0, c.before), 0);

  console.log("═".repeat(78));
  console.log(`  PINE SHOP COUNT CLEAR — ${APPLY ? "APPLY" : "DRY RUN (nothing written)"}   location: ${LOC} (${loc.label || loc.name || "?"})`);
  console.log("═".repeat(78));
  console.log(JSON.stringify({ resetId, cellsToZero: plan.cells.length, unitsToZero: toZeroUnits, ...plan.summary, skipped: plan.skipped.length, enginePausedForPine: paused, host: hostname() }, null, 2));
  if (plan.skipped.length) console.log("skipped:", JSON.stringify(plan.skipped.slice(0, 20)));
  console.log("largest:", plan.cells.filter((c) => c.before > 0).sort((a, b) => b.before - a.before).slice(0, 5).map((c) => `${c.pid}/${c.sizeKey}=${c.before}`).join(", "));
  const earlier = await db.ref(`${COUNT_ROOT}/resets/${LOC}`).orderByKey().limitToLast(1).once("value");
  if (earlier.exists()) {
    console.log(`\nA Pine clear is already recorded (${Object.keys(earlier.val())[0]}). A second --apply zeroes everything counted since.`);
    if (APPLY && !FORCE) { console.log("REFUSED. Re-run with --apply --force only if that is really wanted."); process.exitCode = 3; return; }
  }
  if (!APPLY) { console.log("\nDry run only. Re-run with --apply to write."); return; }
  if (!paused) { console.log(`REFUSED: the refill engine is not paused for Pine. Set /config/refillEngine/pausedLocations/${LOC} = true (Hub Count card toggle) first.`); process.exitCode = 5; return; }
  if (!ANY_HOST && !/mini/i.test(hostname())) { console.log(`REFUSED: run this on the Mac mini (host is ${hostname()}), or pass --any-host.`); process.exitCode = 6; return; }

  // 1. the backup, BEFORE any write — written, then read back and checked
  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = join(BACKUP_DIR, `pine-before-${sastDate(serverNowMs())}-${resetId}.json`);
  const nowIso = new Date(serverNowMs()).toISOString();
  const cellsFlat = [];
  for (const [pid, sizes] of Object.entries(pineStock)) for (const [sizeKey, c] of Object.entries(sizes || {})) {
    if (c != null) cellsFlat.push({ pid, sizeKey, qty: c && typeof c.qty === "number" ? c.qty : null });
  }
  const saved = { resetId, at: nowIso, hub: LOC, summary: plan.summary, cells: cellsFlat, stock: pineStock, plan };
  const body = JSON.stringify(saved);
  try {
    writeDurable(file, body);
    const back = readFileSync(file, "utf8");
    if (!existsSync(file) || sha(back) !== sha(body) || JSON.parse(back).cells.length !== cellsFlat.length) throw new Error("read-back mismatch");
  } catch (e) {
    console.error(`STOP: the backup failed to write (${file}): ${e.message}. Nothing written to the database.`);
    process.exitCode = 7; return;
  }
  console.log(`BACKUP written + read back: ${file}  (${cellsFlat.length} cells, sha256 ${sha(body).slice(0, 16)}…)`);
  await db.ref(`${COUNT_ROOT}/resets/${LOC}/${resetId}`).set({
    at: nowIso, by: PINE_SCOPE.actor, ...plan.summary, nonZero: plan.nonZero, file: `${hostname()}:${file}`,
  });

  // 2. one guarded adjustment per non-zero cell
  const r = await applyReset({ db, plan, applyMovementAdmin, nowMs: serverNowMs(), log: console.log });
  const applied = new Map(r.done.map((d) => [d.movementId, d.applied]));
  for (const c of plan.cells) if (applied.has(c.movementId)) c.applied = applied.get(c.movementId);
  saved.plan = plan; saved.result = { removed: r.removed, added: r.added, done: r.done.length, refused: r.refused };
  writeDurable(file, JSON.stringify(saved));
  await db.ref(`${COUNT_ROOT}/resets/${LOC}/${resetId}/applied`).set({
    at: new Date(serverNowMs()).toISOString(), zeroed: r.done.length, unitsRemoved: r.removed, negativeUnitsCleared: r.added,
    refused: r.refused.length ? r.refused.map((x) => ({ path: x.path, reason: x.reason })) : null,
  });
  console.log(JSON.stringify({ zeroed: r.done.length, unitsRemoved: r.removed, negativeUnitsCleared: r.added, refused: r.refused.length }, null, 2));
  if (r.refused.length) { console.log("REFUSED:", JSON.stringify(r.refused.slice(0, 20).map((x) => [x.path, x.reason]))); process.exitCode = 1; }
  console.log(`\nVerify:   node scripts/pine-count-clear.mjs --verify ${file}`);
  console.log(`Reverse:  node scripts/pine-count-clear.mjs --restore ${file} --apply`);
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
