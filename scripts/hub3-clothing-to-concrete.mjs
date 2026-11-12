// ─── HUB 3 CLOTHING → CONCRETE — RUNNER (Junid, 12 Nov 2026) ─────────────────
// Everything at Hub 3 that is not footwear moves to Concrete in full; zero and
// negative cells are brought to zero (hub3_clothing_cleanup) and every
// non-footwear row is removed, so Hub 3 holds footwear only. See
// scripts/lib/hub3ClothingTransfer.mjs for the rules.
//
//   node scripts/hub3-clothing-to-concrete.mjs                 dry run (writes NOTHING)
//   node scripts/hub3-clothing-to-concrete.mjs --apply         live
//   --run-id <id>    default 20261112 (the movement ids derive from it)
//   --md <file>      also write the dry-run / result report as markdown
//
// Reads are scoped: /products and /stock/hub3 paged, seats and locks per
// location, the newest 6,000 requests by key. Before --apply writes anything it
// saves what it is about to change to ~/marathon-rollbacks/.
import { writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { adminRequire } from "./adminRequire.mjs";
import { readMapPaged } from "./lib/rtdbPaged.mjs";
import { planHub3ClothingTransfer, applyHub3ClothingTransfer, finishAndVerify, assertPlanScope, planRowAlign, applyRowAlign, HUB, DEST } from "./lib/hub3ClothingTransfer.mjs";
const req = adminRequire(import.meta.url);
const require = createRequire(import.meta.url);
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const { applyMovementAdmin } = require("../functions/lib/admin-movement.cjs");
const dv = require("../functions/lib/concrete-division.cjs");

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const APPLY = process.argv.includes("--apply");
const RUN_ID = arg("--run-id", "20261112");
const MD = arg("--md", null);
const ALLOW_NO_RECORD = process.argv.includes("--allow-no-record");
const db = admin.database();
const once = async (p) => (await db.ref(p).once("value")).val();

const products = await readMapPaged(db, "products");
const hub3Stock = await readMapPaged(db, `stock/${HUB}`);
const seats = {};
for (const loc of dv.DIVISION_LOCATIONS) seats[loc] = (await once(`${dv.SEATS_PATH}/${loc}`)) || {};
const locks = {};
for (const loc of dv.DIVISION_LOCATIONS) locks[loc] = (await once(`refill_engine/open/${loc}`)) || {};
// Push ids only ("-…"): website rows ("web_…") sort after them and would
// crowd the newest window out.
const requests = (await db.ref("refill_requests").orderByKey().endAt("-~").limitToLast(6000).once("value")).val() || {};
// A lock naming a request older than the window: read that one request.
for (const byPid of Object.values(locks)) for (const bySize of Object.values(byPid || {})) for (const e of Object.values(bySize || {})) {
  if (e?.refillId && !requests[e.refillId]) { const r = await once(`refill_requests/${e.refillId}`); if (r) requests[e.refillId] = r; }
}

const targets = {};
for (const loc of dv.DIVISION_SHOPS) targets[loc] = await readMapPaged(db, `stock_targets/${loc}`);
const plan = planHub3ClothingTransfer({ hub3Stock, products, seats, requests, locks, runId: RUN_ID });
const rows = planRowAlign({ targets, products });
assertPlanScope(plan, products, { allowNoRecord: ALLOW_NO_RECORD });
for (const w of plan.withdraw) if (!dv.DIVISION_LOCATIONS.includes(w.dest)) throw new Error(`REFUSED: a withdrawal outside the division (${w.dest})`);

const name = (pid) => products[pid]?.name || "(no product record)";
function report(extra = "") {
  const s = plan.summary;
  const L = [];
  L.push(`## Hub 3 → Concrete ${APPLY ? "— LIVE RUN" : "— DRY RUN"} (run ${RUN_ID})`, "");
  L.push(`- Move to Concrete: **${s.transferUnits} units** in ${s.transferCells} cells, **${s.transferProducts} products**`);
  L.push(`- By owning shop (no seat ever carried an owner; the shops each product is seated at today stand in): ${Object.entries(s.byOwner).map(([k, v]) => `${k === "marathon-pine" ? "Pine" : k === "concrete" ? "Concrete" : k} ${v.products} products / ${v.units} units`).join(", ")}`);
  L.push(`- Perfumes moved (no keep, no seat at Concrete): ${s.perfumeProducts} products, ${s.perfumeUnits} units${plan.perfumes.length ? ` — ${plan.perfumes.map(name).join("; ")}` : ""}`);
  L.push(`- Negative cells brought to zero (hub3_clothing_cleanup): ${s.cleanupCells} cells, ${-s.cleanupUnits} units${plan.cleanups.length ? ` — ${plan.cleanups.map((c) => `${c.pid} ${c.sizeKey} ${c.qty}`).join("; ")}` : ""}`);
  L.push(`- Zero cells removed: ${s.zeroCells}${plan.noRecord.length ? ` (incl. ${plan.noRecord.length} products with no record: ${plan.noRecord.join(", ")})` : ""}`);
  L.push(`- Seated at Concrete: ${s.seatOn}; Hub 3 non-footwear seats switched off: ${s.seatsOff}`);
  L.push(`- Requests withdrawn: ${s.withdraw}${plan.withdraw.length ? ` — ${plan.withdraw.map((w) => `${w.id} ${w.dest} ${w.pid} ${w.size ?? ""}`).join("; ")}` : ""}`);
  L.push(`- Explicit Pine/Concrete rows still at the retired from-Hub 3 keep, edited in place to 2 / 5: ${rows.align.length}${rows.align.length ? ` — ${rows.align.map((a) => `${a.loc} ${name(a.pid)} ${a.sizeKey} ${a.from.target}->${a.to.target}`).join("; ")}` : ""}`);
  L.push(`- Other explicit rows above 0 at Pine/Concrete (hand-set, left as they are): ${rows.left.length}`);
  L.push(`- Skipped: ${plan.skipped.length}${plan.skipped.length ? ` — ${JSON.stringify(plan.skipped)}` : ""}`);
  L.push("", "By category (units moved):", "");
  const byCat = {};
  for (const t of plan.transfers) { const b = (byCat[t.category] ||= { products: new Set(), units: 0 }); b.products.add(t.pid); b.units += t.qty; }
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1].units - a[1].units)) L.push(`- ${k}: ${v.products.size} products, ${v.units} units`);
  return L.join("\n") + "\n" + extra;
}

if (!APPLY) {
  const md = report();
  process.stdout.write(md);
  if (MD) writeFileSync(MD, md);
  process.exit(0);
}

// ── LIVE ────────────────────────────────────────────────────────────────────
const nowMs = Date.now();
const dir = join(homedir(), "marathon-rollbacks");
mkdirSync(dir, { recursive: true });
const touched = new Set([...plan.transfers, ...plan.cleanups, ...plan.zeros].map((c) => c.pid));
const backup = {
  runId: RUN_ID, at: new Date(nowMs).toISOString(), plan,
  hub3: Object.fromEntries([...touched].map((pid) => [pid, hub3Stock[pid] ?? null])),
  concrete: Object.fromEntries(await Promise.all([...touched].map(async (pid) => [pid, await once(`stock/${DEST}/${pid}`)]))),
  seats: { hub3: Object.fromEntries(plan.seatsOff.map((pid) => [pid, seats.hub3[pid]])), concrete: Object.fromEntries(plan.seatOn.map((pid) => [pid, seats.concrete[pid] ?? null])) },
  requests: Object.fromEntries(plan.withdraw.map((w) => [w.id, requests[w.id] ?? null])),
  targetRows: Object.fromEntries(rows.align.map((a) => [a.path, a.from])),
};
const backupPath = join(dir, `hub3-clothing-before-${RUN_ID}-${nowMs}.json`);
writeFileSync(backupPath, JSON.stringify(backup));
console.log("backup:", backupPath);
const record = `settings/hub3ClothingTransfer/${RUN_ID}`;
await db.ref(record).update({ startedAt: new Date(nowMs).toISOString(), by: "script:hub3-clothing-to-concrete", status: "running", planned: plan.summary });

const log = (m) => console.log(m);
const res = await applyHub3ClothingTransfer({ db, plan, products, applyMovementAdmin, nowMs, log, allowNoRecord: ALLOW_NO_RECORD });
const fin = await finishAndVerify({ db, products, applyMovementAdmin, nowMs: Date.now(), runId: RUN_ID, log, readHub3: () => readMapPaged(db, `stock/${HUB}`), allowNoRecord: ALLOW_NO_RECORD });
const aligned = await applyRowAlign({ db, align: rows.align, nowIso: new Date().toISOString() });
const movedUnits = res.moved.reduce((t, m) => t + (m.moved || 0), 0);
const refused = [...res.moved.filter((m) => m.refused), ...res.cleaned.filter((c) => c.refused)];
const result = {
  movedUnits, movedCells: res.moved.filter((m) => m.moved > 0).length,
  idempotent: res.moved.filter((m) => m.idempotent).length,
  changedSinceRead: res.moved.filter((m) => m.plannedQty !== undefined && m.plannedQty !== m.qty).map((m) => ({ pid: m.pid, sizeKey: m.sizeKey, planned: m.plannedQty, moved: m.qty })),
  drainedBeforeMove: res.moved.filter((m) => m.note).map((m) => ({ pid: m.pid, sizeKey: m.sizeKey, note: m.note, now: m.now ?? null })),
  cleanedUnits: res.cleaned.reduce((t, c) => t + (c.applied || 0), 0),
  refused: refused.map((r) => ({ pid: r.pid, sizeKey: r.sizeKey, why: r.refused })),
  withdrawn: res.withdrawn.map((w) => ({ id: w.id, outcome: w.outcome })),
  rowsAligned: aligned.map((a) => ({ path: a.path, outcome: a.outcome })),
  verify: fin,
};
const claimed = res.withdrawn.filter((w) => w.outcome === "touched");
if (claimed.length) console.log(`\n!!! ${claimed.length} request(s) a picker has claimed were NOT withdrawn — they may still deliver non-footwear to Hub 3 or name Hub 3 as a source; re-run this script once they close:\n${claimed.map((w) => `  ${w.id} ${w.dest} ${w.pid} ${w.size ?? ""}`).join("\n")}\n`);
await db.ref(record).update({ finishedAt: new Date().toISOString(), status: fin.clean && !refused.length && !claimed.length ? "done" : "done_with_issues", result: JSON.parse(JSON.stringify(result)), removedCells: fin.removedCells || [] });
const md = report(`\n### Result\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
process.stdout.write(md);
if (MD) writeFileSync(MD, md);
process.exit(fin.clean && !claimed.length ? 0 : 2);
