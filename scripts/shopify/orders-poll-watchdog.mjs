#!/usr/bin/env node
// ── Watchdog for the website-orders poller (Mac mini) ───────────────────────
// launchd com.marathon.orderspollwatchdog runs this every 10 minutes. It reads
// logs/orders-poll.log (and its rotated .1 when the current file is short),
// asks ordersPollWatch.mjs whether the poller is down, and emails Junid ONCE
// when an outage starts and ONCE when it is over. Outside 07:00–19:00 SAST it
// sends nothing.
//
//   node scripts/shopify/orders-poll-watchdog.mjs            the real check
//   node scripts/shopify/orders-poll-watchdog.mjs --dry-run  prints the verdict
//                                                            and any mail; sends
//                                                            nothing, saves nothing
//
// Mail goes from the shop mailbox (CARD_RECON_IMAP_USER / _PASSWORD in the
// git-ignored .env, the same sender as orders-poll.mjs) to gunidmoh@gmail.com,
// the inbox Junid reads. ORDERS_WATCHDOG=0 in the environment switches it off.
// State: logs/orders-poll-watchdog.json. Its own log: logs/orders-poll-watchdog.log.
import { createRequire } from "node:module";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.mjs";
import { decide, parseLog, FAIL_RUNS } from "./ordersPollWatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(HERE, "..", "..", "logs");
const POLL_LOG = join(LOG_DIR, "orders-poll.log");
const STATE_FILE = join(LOG_DIR, "orders-poll-watchdog.json");
const OWN_LOG = join(LOG_DIR, "orders-poll-watchdog.log");
const NOTIFY_TO = "gunidmoh@gmail.com"; // Junid reads this one (with a G), never junidmoh
const DRY = process.argv.includes("--dry-run");

function stamp() {
  return new Date().toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function log(line) {
  if (DRY) { console.log(line); return; }
  try {
    try { if (statSync(OWN_LOG).size > 512 * 1024) renameSync(OWN_LOG, `${OWN_LOG}.1`); } catch { /* none yet */ }
    appendFileSync(OWN_LOG, `${stamp()}  ${line}\n`);
  } catch (e) { console.error(`orders-poll-watchdog: cannot write its log: ${e?.message || e}`); }
}
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

function readLines() {
  let lines = parseLog(read(POLL_LOG));
  // Just rotated: the runs that decide "the last N failed" may be in .1.
  const runCount = lines.filter((l) => /^(orders: |✗ )/.test(l.text)).length;
  if (runCount < FAIL_RUNS && existsSync(`${POLL_LOG}.1`)) lines = [...parseLog(read(`${POLL_LOG}.1`)), ...lines];
  return lines;
}

function mailer() {
  const user = process.env.CARD_RECON_IMAP_USER;
  const pass = process.env.CARD_RECON_IMAP_PASSWORD;
  if (!user || !pass) throw new Error("CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD not set (.env)");
  const nodemailer = createRequire(new URL("../cardrecon/package.json", import.meta.url))("nodemailer");
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  return (mail) => transport.sendMail({ from: user, to: NOTIFY_TO, subject: mail.subject, text: mail.text });
}

if (process.env.ORDERS_WATCHDOG === "0") process.exit(0);

let state = {};
try { state = JSON.parse(read(STATE_FILE) || "{}"); } catch { state = {}; }
const now = Date.now();
const verdict = decide({ lines: readLines(), now, state });

if (DRY) {
  console.log(`verdict: ${verdict.note}`);
  console.log(JSON.stringify({ ...verdict.assessment, runs: verdict.assessment.runs.length }, null, 2));
  if (verdict.mail) console.log(`\nWOULD MAIL ${NOTIFY_TO}\nSubject: ${verdict.mail.subject}\n\n${verdict.mail.text}`);
  process.exit(0);
}

if (verdict.mail) {
  try {
    await mailer()(verdict.mail);
    log(`${verdict.note}: sent "${verdict.mail.subject}" to ${NOTIFY_TO}`);
  } catch (e) {
    // State NOT saved: the next run (10 minutes) tries the same mail again.
    log(`✗ ${verdict.note}: the mail did not go: ${String(e?.message || e).slice(0, 200)}`);
    console.error(`orders-poll-watchdog: mail failed: ${e?.message || e}`);
    process.exit(1);
  }
} else if (verdict.note !== "ok" && !verdict.note.startsWith("outside")) {
  log(verdict.note);
}
// One heartbeat line an hour, so the log shows the watchdog itself is alive.
const hour = stamp().slice(0, 14);
if (state.heartbeat !== hour) log(`alive: ${verdict.note}`);
writeFileSync(STATE_FILE, JSON.stringify({ ...verdict.state, heartbeat: hour, checkedAt: now }, null, 2));
