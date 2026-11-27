#!/usr/bin/env node
// ─── MISSING PRODUCTS — DAILY ACCURACY CHECK (Mac mini, Junid 24 Nov 2026) ───
// "The numbers on Missing Products must be 100% accurate." Once a day:
//   1. a READ-ONLY snapshot of what the screen reads (paged reads; the one
//      large read is /refill_requests in pages, the same node the screen
//      itself listens to — its size is printed);
//   2. the REAL screen code run over it (src/components/stock/
//      missingAccuracy.harness.test.jsx): every card on both divisions and
//      both kinds, and every "Not listed" row, against the true figure
//      computed from the raw nodes;
//   3. ONLY IF any figure differs, a held line for Fable's daily review
//      (Junid's quiet rule, 26 Nov 2026 — it used to email Junid). Nothing is
//      written to the database.
//
//   node scripts/diag/missing-accuracy-daily.mjs            the real run
//   node scripts/diag/missing-accuracy-daily.mjs --dry-run  prints the line it would hold
//
// No mail (Junid's quiet rule, 26 Nov 2026): a mismatch or a failed run is one
// line in ~/marathon-dm-agent/data/quiet-held.jsonl (scripts/lib/quietHeld.mjs).
// launchd: scripts/diag/com.marathon.missingaccuracy.plist (07:15 daily).
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { appendQuietHeld } from "../lib/quietHeld.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry-run");
const OUT_DIR = process.env.MISSING_ACCURACY_DIR || join(homedir(), "missing-accuracy-runs");
const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });

async function auditOnce(tag = "") {
  const day = new Date().toISOString().slice(0, 10);
  const snapFile = join(OUT_DIR, `snap-${day}${tag}.json`), outFile = join(OUT_DIR, `accuracy-${day}${tag}.json`);
  // ── 1. THE SNAPSHOT ──
  const LOCS = ["central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "concrete"];
  const snap = { readAt: new Date().toISOString() };
  snap.config = (await once("config/refillEngine")) || {};
  snap.network = await once("network");
  snap.products = await readMapPaged(db, "products");
  snap.stock = {}; for (const l of LOCS) snap.stock[l] = await readMapPaged(db, `stock/${l}`);
  snap.targets = {}; for (const l of LOCS) if (l !== "central") snap.targets[l] = await readMapPaged(db, `stock_targets/${l}`);
  snap.seats = { "marathon-pine": await once("refill_engine/seats/marathon-pine"), concrete: await once("refill_engine/seats/concrete") };
  snap.held = (await once("settings/stockHold/held")) || {};
  snap.hidden = await once("settings/missingProductsHidden");
  snap.concreteIdx = await once("settings/concreteOnlyIndex");
  snap.marathonIdx = await once("settings/marathonOnlyIndex");
  snap.recentRequests = await readMapPaged(db, "refill_requests");
  // keep a week of runs on the mini, no more
  for (const f of (await import("fs")).readdirSync(OUT_DIR)) {
    const m = /^(snap|accuracy)-(\d{4}-\d{2}-\d{2})(-again)?\.json$/.exec(f);
    if (m && Date.now() - Date.parse(m[2]) > 7 * 86400000) (await import("fs")).unlinkSync(join(OUT_DIR, f));
  }
  const json = JSON.stringify(snap);
  writeFileSync(snapFile, json);
  console.log(`${stamp()}  snapshot ${(json.length / 1e6).toFixed(1)} MB (refill_requests: ${Object.keys(snap.recentRequests).length} records, ${(JSON.stringify(snap.recentRequests).length / 1e6).toFixed(1)} MB)`);
  // ── 2. THE REAL SCREEN, OVER IT ──
  if (existsSync(outFile)) (await import("fs")).unlinkSync(outFile);   // never read an earlier run's result
  const run = spawnSync("npx", ["vitest", "run", "src/components/stock/missingAccuracy.harness.test.jsx"], {
    cwd: ROOT, env: { ...process.env, ACCURACY_SNAPSHOT: snapFile, ACCURACY_OUT: outFile }, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  if (!existsSync(outFile)) throw new Error(`the audit produced no result (exit ${run.status}): ${String(run.stderr || run.stdout).slice(-600)}`);
  const out = JSON.parse(readFileSync(outFile, "utf8"));
  out.file = outFile;
  console.log(`${stamp()}  ${tag || "first"} pass: cards checked ${out.checked}, wrong ${out.wrong}; Not listed checked ${out.notListed?.checked}, wrong ${out.notListed?.wrong}`);
  return out;
}

const admin = adminRequire(import.meta.url)("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const once = async (p) => (await db.ref(p).once("value")).val();
let code = 0;
try {
  mkdirSync(OUT_DIR, { recursive: true });
  let out = await auditOnce();
  if (!out.ok) {
    // A write landing between two of the snapshot's reads can look like a
    // mismatch: read everything again in two minutes and keep only what is
    // wrong BOTH times.
    await new Promise((r) => setTimeout(r, 120000));
    const again = await auditOnce("-again");
    out = { ...again, rows: again.rows.filter((r) => out.rows.some((x) => x.key === r.key)), notListed: { ...again.notListed, rows: (again.notListed?.rows || []).filter((r) => (out.notListed?.rows || []).some((x) => x.pid === r.pid)) } };
    out.wrong = out.rows.length; out.notListed.wrong = out.notListed.rows.length; out.ok = !out.wrong && !out.notListed.wrong;
  }
  // ── 3. MAIL ONLY IF ANYTHING DIFFERS (re-checked once on a fresh read: a
  //      write landing between two of the snapshot's reads must not mail) ──
  if (!out.ok) {
    const lines = [
      `Missing Products — ${out.wrong} card${out.wrong === 1 ? "" : "s"} and ${out.notListed?.wrong || 0} "Not listed" row${out.notListed?.wrong === 1 ? "" : "s"} show a number that differs from live data (checked ${out.checked} cards, ${out.notListed?.checked || 0} rows; data read ${out.readAt}).`,
      "",
      ...out.rows.slice(0, 60).map((r) => `• ${r.name} — card shows ${r.shown}, true ${r.truth} (${r.diff > 0 ? "+" : ""}${r.diff})  [${r.key}]`),
      ...(out.notListed?.rows || []).slice(0, 40).map((r) => `• Not listed ${r.pid}: shows "${r.shown}", true "${r.truth}"`),
      "",
      "Nothing was changed. Full result on the mini: " + out.file,
    ];
    // JUNID'S QUIET RULE (26 Nov 2026): a daily check's result is a report, not
    // an outage — held for Fable's daily review (recordOnly), never emailed.
    const subject = `[Missing Products] ${out.wrong + (out.notListed?.wrong || 0)} number(s) differ from live data`;
    if (DRY) console.log(`WOULD HOLD for Fable\nSubject: ${subject}\n\n${lines.join("\n")}`);
    else {
      appendQuietHeld({ channel: "email", source: "marathon-store-app:scripts/diag/missing-accuracy-daily.mjs", subject, text: lines.join("\n"), needsDecision: false });
      console.log(`${stamp()}  held for Fable's review (quiet rule): ${subject}`);
    }
  } else console.log(`${stamp()}  every number matches — no mail`);
} catch (e) {
  console.error(`${stamp()}  missing-accuracy-daily: ${e?.message || e}`);
  code = 1;
  // A check that could not run is not "every number matches" — but one failed
  // run is not an outage either (Junid's quiet rule, 26 Nov 2026): held for
  // Fable's review, never emailed.
  if (!DRY) {
    try { appendQuietHeld({ channel: "email", source: "marathon-store-app:scripts/diag/missing-accuracy-daily.mjs", subject: "[Missing Products] the daily number check could not run", text: `The daily check of the Missing Products numbers did not complete today: ${String(e?.message || e).slice(0, 500)}\n\nNothing was changed. Log on the mini: ~/missing-accuracy-runs/daily.err.log`, needsDecision: false }); }
    catch { /* the log has it */ }
  }
} finally {
  await admin.app().delete().catch(() => {});
}
process.exit(code);
