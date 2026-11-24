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
//   3. an EMAIL to Junid ONLY IF any figure differs, naming the products.
//      Email only — never WhatsApp. Nothing is written to the database.
//
//   node scripts/diag/missing-accuracy-daily.mjs            the real run
//   node scripts/diag/missing-accuracy-daily.mjs --dry-run  prints the mail it would send
//
// Mail: Gmail SMTP as the shop mailbox (CARD_RECON_IMAP_USER / _PASSWORD from
// MISSING_ACCURACY_ENV, default ~/marathon-store-app/.env), nodemailer from
// MISSING_ACCURACY_MAILER (default ~/marathon-store-app/scripts/cardrecon) —
// the route the write-off digest uses, the one that reaches Junid.
// launchd: scripts/diag/com.marathon.missingaccuracy.plist (07:15 daily).
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { createRequire } from "module";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry-run");
const MAIL_TO = "gunidmoh@gmail.com";              // Junid reads this one (with a G)
const MAIL_FROM = "marathon6631@gmail.com";
const OUT_DIR = process.env.MISSING_ACCURACY_DIR || join(homedir(), "missing-accuracy-runs");
const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#") || process.env[m[1]] !== undefined) continue;
    const q = m[2].match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    process.env[m[1]] = q ? q[2] : m[2].replace(/\s+#.*$/, "").trim();
  }
}

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
    const mail = { from: `"Missing Products check" <${MAIL_FROM}>`, to: MAIL_TO, subject: `[Missing Products] ${out.wrong + (out.notListed?.wrong || 0)} number(s) differ from live data`, text: lines.join("\n") };
    if (DRY) console.log(`WOULD MAIL ${MAIL_TO}\nSubject: ${mail.subject}\n\n${mail.text}`);
    else {
      loadEnv(process.env.MISSING_ACCURACY_ENV || join(homedir(), "marathon-store-app", ".env"));
      const user = process.env.CARD_RECON_IMAP_USER, pass = process.env.CARD_RECON_IMAP_PASSWORD;
      if (!user || !pass) throw new Error("CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD not set");
      if (String(user).trim().toLowerCase() !== MAIL_FROM) throw new Error("not sending as a different mailbox than the shop's");
      const nodemailer = createRequire(join(process.env.MISSING_ACCURACY_MAILER || join(homedir(), "marathon-store-app", "scripts", "cardrecon"), "package.json"))("nodemailer");
      const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
      const info = await t.sendMail(mail);
      console.log(`${stamp()}  mailed ${MAIL_TO} — ${info?.messageId || "no id"}`);
    }
  } else console.log(`${stamp()}  every number matches — no mail`);
} catch (e) {
  console.error(`${stamp()}  missing-accuracy-daily: ${e?.message || e}`);
  code = 1;
  // A check that could not run is not "every number matches": say so, once a day, by email.
  if (!DRY) {
    try {
      loadEnv(process.env.MISSING_ACCURACY_ENV || join(homedir(), "marathon-store-app", ".env"));
      const user = process.env.CARD_RECON_IMAP_USER, pass = process.env.CARD_RECON_IMAP_PASSWORD;
      if (user && pass && String(user).trim().toLowerCase() === MAIL_FROM) {
        const nodemailer = createRequire(join(process.env.MISSING_ACCURACY_MAILER || join(homedir(), "marathon-store-app", "scripts", "cardrecon"), "package.json"))("nodemailer");
        const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
        await t.sendMail({ from: `"Missing Products check" <${MAIL_FROM}>`, to: MAIL_TO, subject: "[Missing Products] the daily number check could not run", text: `The daily check of the Missing Products numbers did not complete today: ${String(e?.message || e).slice(0, 500)}\n\nNothing was changed. Log on the mini: ~/missing-accuracy-runs/daily.err.log` });
      }
    } catch { /* the log has it */ }
  }
} finally {
  await admin.app().delete().catch(() => {});
}
process.exit(code);
