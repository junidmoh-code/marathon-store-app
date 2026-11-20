// ─── BAGS ONE-SIZE — THE UNATTENDED RUN (Junid, 20 Nov 2026: "tonight at 20:30, after the shops close") ─
//
// One shot, run by launchd at 20:30 SAST on 2026-11-20 (and never again: a marker in RTDB
// _migrations/bagsOneSizeCollapse/tonight stops any second run). Per the runbook
// (scripts/HEADWEAR-COLLAPSE-RUNBOOK.md, applied to the 105 approved bags):
//   1. pause the refill engine  (/receiving_session/active = true; its previous value is remembered)
//   2. barcode write-back probe (scripts/bags-preflight-probe.mjs) — nothing moves unless it passes
//   3. dry run                  (scripts/collapse-one-size-bags.mjs)
//   4. execute                  (… --execute) — a gated / unreconciled bag is skipped and listed
//   5. verify: stock per location per bag identical before and after (units summed over every size cell)
//   6. resume the engine        — ALWAYS, in finally, back to its previous value
//   7. email Junid the result
// Usage: node scripts/bags-onesize-tonight.mjs [--force-now]   (--force-now skips the date/time guard; never used by launchd)
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import os from "os";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const g = async (p) => (await db.ref(p).once("value")).val();
const PIDS = JSON.parse(readFileSync(join(HERE, "bags-onesize-2026-11-20.json"), "utf8")).pids;
const OUT = join(os.homedir(), "marathon-bags-onesize-2026-11-20");
mkdirSync(OUT, { recursive: true });
const log = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); writeFileSync(join(OUT, "run.log"), l + "\n", { flag: "a" }); };

/** Units per location per bag, every size cell added (the check that nothing was gained or lost). */
async function stockOf() {
  const out = {};
  // Every location under /stock (one shallow listing), so no location's units can be missed.
  const res = await fetch(`${db.app.options.databaseURL}/stock.json?shallow=true&access_token=${(await admin.app().options.credential.getAccessToken()).access_token}`);
  const locations = Object.keys((await res.json()) || {});
  if (!locations.length) throw new Error("could not list the stock locations");
  for (const pid of PIDS) {
    out[pid] = {};
    for (const loc of locations) {
      const cells = await g(`stock/${loc}/${pid}`);
      if (!cells) continue;
      let n = 0;
      for (const c of Object.values(cells)) n += Number(c !== null && typeof c === "object" ? c.qty : c) || 0;
      if (n) out[pid][loc] = n;
    }
  }
  return out;
}
const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: join(HERE, ".."), env: { ...process.env, REPORT_JSON: join(OUT, `${args.includes("--execute") ? "execute" : "dryrun"}.json`), SNAPSHOT_PATH: join(OUT, `rollback-${Date.now()}.json`) }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(OUT, `${args.map((a) => a.replace(/\W+/g, "_")).join("-")}.log`), (r.stdout || "") + (r.stderr || ""));
  return r;
};

async function main() {
  const force = process.argv.includes("--force-now");
  const sast = new Date(Date.now() + 2 * 3600_000);
  const day = sast.toISOString().slice(0, 10), mins = sast.getUTCHours() * 60 + sast.getUTCMinutes();
  if (!force && (day !== "2026-11-20" || mins < 20 * 60 + 30)) return { skipped: `not the approved window (${day} ${sast.toISOString().slice(11, 16)} SAST)` };
  const marker = db.ref("_migrations/bagsOneSizeCollapse/tonight");
  const claimed = await marker.transaction((cur) => (cur ? undefined : { startedAt: Date.now(), host: os.hostname() }));
  if (!claimed.committed) return { skipped: "already run (marker set)" };

  const prevActive = await g("receiving_session/active");
  const before = await stockOf();
  let result = {};
  try {
    await db.ref("receiving_session/active").set(true);
    log(`refill engine paused (was ${JSON.stringify(prevActive)})`);
    const probe = run([join(HERE, "bags-preflight-probe.mjs")]);
    log(`probe exit ${probe.status}`);
    if (probe.status !== 0) { result = { status: "stopped", why: "the barcode write-back probe did not pass — nothing was moved", probe: (probe.stdout || "").slice(-1500) }; return result; }
    const dry = run([join(HERE, "collapse-one-size-bags.mjs")]);
    log(`dry run exit ${dry.status}`);
    const exe = run([join(HERE, "collapse-one-size-bags.mjs"), "--execute"]);
    log(`execute exit ${exe.status}`);
    let report = null;
    try { report = JSON.parse(readFileSync(join(OUT, "execute.json"), "utf8")); } catch { report = null; }
    const after = await stockOf();
    const mismatched = PIDS.filter((pid) => JSON.stringify(Object.entries(before[pid] || {}).sort()) !== JSON.stringify(Object.entries(after[pid] || {}).sort()));
    result = { status: "done", dryExit: dry.status, executeExit: exe.status, report, stockMismatch: mismatched.map((pid) => ({ pid, before: before[pid], after: after[pid] })), tail: (exe.stdout || "").slice(-3000) };
    return result;
  } catch (e) {
    result = { status: "failed", error: String(e && e.stack || e) };
    return result;
  } finally {
    await db.ref("receiving_session/active").set(prevActive === undefined ? null : prevActive).catch((e) => log(`ENGINE RESUME FAILED: ${e.message}`));
    log(`refill engine resumed (back to ${JSON.stringify(prevActive)})`);
    await marker.update({ endedAt: Date.now(), status: result.status || "?" }).catch(() => {});
    writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 1));
  }
}

const res = await main().catch((e) => ({ status: "failed", error: String(e) }));
console.log(JSON.stringify(res).slice(0, 2000));
if (!res.skipped) {
  // The result to Junid, through the Mac poster's mailer (gunidmoh@ path).
  const { emailJunid } = await import(join(os.homedir(), "marathon-group-poster", "src", "mail.mjs"));
  const rows = (res.report && (res.report.results || res.report.products)) || [];
  const by = (s) => rows.filter((r) => String(r.status || "").toUpperCase().startsWith(s));
  const done = by("DONE").length + by("ALREADY").length, skipped = rows.filter((r) => /GATED|FAIL|SKIP/i.test(String(r.status)));
  const body = res.status === "done"
    ? `Junid,\n\nBags one-size, tonight's run: ${done} of ${PIDS.length} bags are one size now.\nStock per location before vs after: ${res.stockMismatch.length ? `${res.stockMismatch.length} MISMATCH(ES) — listed below` : "identical for every bag"}.\nBarcode index repaired in the same step as each bag (probe passed first).\nRefill engine paused for the run and resumed after it.\n\nSkipped (not reconciled, left as they were): ${skipped.length}\n${skipped.map((r) => `- ${r.name || r.pid}: ${(r.detail || []).join("; ").slice(0, 300)}`).join("\n") || "none"}\n${res.stockMismatch.length ? `\nStock mismatches:\n${res.stockMismatch.map((m) => `- ${m.pid}: before ${JSON.stringify(m.before)} after ${JSON.stringify(m.after)}`).join("\n")}` : ""}\n\nFull logs: ~/marathon-bags-onesize-2026-11-20/\n`
    : `Junid,\n\nThe bags one-size run did not complete: ${res.why || res.error || res.status}.\nThe refill engine was resumed. Nothing else to do tonight; logs in ~/marathon-bags-onesize-2026-11-20/.\n`;
  await emailJunid({ subject: `Bags one-size: ${res.status === "done" ? `${done}/${PIDS.length} done` : res.status}`, body }).catch((e) => log(`email failed: ${e.message}`));
}
process.exit(0);
