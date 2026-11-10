#!/usr/bin/env node
// ── Social alarm mailer (Mac mini), 10 Nov 2026 ──────────────────────────────
// launchd com.marathon.socialalarmmail runs this every 5 minutes (KeepAlive +
// ThrottleInterval, the pattern that survived the 31 Aug StartInterval wedge).
// It emails Junid (gunidmoh@gmail.com) ONCE per cause per day when:
//   · socialHealthScan says the day is SILENT: a slot owed was not published
//     20 minutes after its time, a generator made nothing, or the publisher
//     stopped ticking (social_health/days/{date});
//   · socialHealthScan itself has stopped writing (45 minutes stale);
//   · the 06:00 reel run or the 07:00 still run threw;
//   · a publisher run on this machine failed a post, or failed twice running;
//   · the Meta page token is invalid, or any of its expiries is within 7 days
//     (checked every 6 hours with debug_token).
// The judgement is socialAlarmCore.mjs (pure, tested). Why this exists:
// SOCIAL-OUTAGE-2026-11-05.md (the Monitoring alarm emailed junidmoh, which
// Junid does not read; the alarm fired daily for five days, unseen).
//
//   node scripts/social/social-alarm-mail.mjs            the real run
//   node scripts/social/social-alarm-mail.mjs --dry-run  prints what it would
//                                                        send; sends and saves nothing
//
// Credentials: CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD in the
// git-ignored .env (sends only AS the shop mailbox). RTDB and Secret Manager
// through GOOGLE_APPLICATION_CREDENTIALS (the publisher's service account).
// SOCIAL_ALARM_MAIL=0 switches it off. State: logs/social-alarm-mail.json.
import { createRequire } from "node:module";
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "../shopify/env.mjs";
import { adminRequire } from "../adminRequire.mjs";
import { readSecret } from "./secrets.mjs";
import {
  MAIL_TO, SHOP_MAILBOX, dedupe, healthAlert, healthStaleAlert, mailFor, publisherAlerts, runErrorAlert, saDate, tokenAlerts,
} from "./socialAlarmCore.mjs";

if (process.env.SOCIAL_ALARM_MAIL === "0") process.exit(0);
const DRY = process.argv.includes("--dry-run");
const HERE = dirname(fileURLToPath(import.meta.url));
const LOGS = join(HERE, "..", "..", "logs");
const STATE_FILE = join(LOGS, "social-alarm-mail.json");
const OWN_LOG = join(LOGS, "social-alarm-mail.log");
const TOKEN_CHECK_EVERY_MS = 6 * 3600000;

const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });
function log(line) {
  if (DRY) { console.log(line); return; }
  try {
    try { if (statSync(OWN_LOG).size > 512 * 1024) renameSync(OWN_LOG, `${OWN_LOG}.1`); } catch { /* none yet */ }
    appendFileSync(OWN_LOG, `${stamp()}  ${line}\n`);
  } catch (e) { console.error(`social-alarm-mail: cannot write its log: ${e?.message || e}`); }
}
const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; } };
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

const admin = adminRequire(import.meta.url)("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

let code = 0;
const state = readJson(STATE_FILE, { sent: {} });
try {
  const nowMs = Date.now();
  const date = saDate(nowMs);
  const val = async (path) => (await db.ref(path).once("value")).val();
  const [day, daily, still] = await Promise.all([
    val(`social_health/days/${date}`), val(`social_autopilot_log/${date}`), val(`social_still_log/${date}`),
  ]);

  const alerts = [
    healthAlert(day, date),
    healthStaleAlert(day, nowMs),
    runErrorAlert(daily, "06:00 reel run", date),
    runErrorAlert(still, "07:00 still run", date),
    ...publisherAlerts(readText(join(LOGS, "social-publish.log")), readJson(join(LOGS, "social-publish.state.json"), {}), date),
  ];

  // The token, every 6 hours. A failure to ASK is logged, not mailed: the
  // publisher's own preflight fails loudly if the token really is dead.
  if (DRY || nowMs - (Number(state.lastTokenCheckAt) || 0) > TOKEN_CHECK_EVERY_MS) {
    try {
      const token = await readSecret("meta-page-access-token");
      if (token) {
        const res = await fetch(`https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(20000) });
        const body = await res.json().catch(() => ({}));
        const data = body.data || (body.error ? { is_valid: false, error: body.error } : null);
        alerts.push(...tokenAlerts(data, nowMs));
        state.token = data ? { is_valid: data.is_valid, expires_at: data.expires_at ?? null, data_access_expires_at: data.data_access_expires_at ?? null } : null;
      }
      state.lastTokenCheckAt = nowMs;
    } catch (e) { log(`token check could not run: ${String(e?.message || e).slice(0, 160)}`); }
  }

  const { toSend, sent } = dedupe(alerts.filter(Boolean), state.sent, nowMs);
  state.sent = sent;
  if (toSend.length) {
    const user = process.env.CARD_RECON_IMAP_USER;
    const pass = process.env.CARD_RECON_IMAP_PASSWORD;
    if (!DRY && (!user || !pass)) throw new Error("CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD not set (.env)");
    if (!DRY && String(user).trim().toLowerCase() !== SHOP_MAILBOX) throw new Error(`not sending as anything but the shop mailbox (${SHOP_MAILBOX})`);
    const transport = DRY ? null : createRequire(new URL("../cardrecon/package.json", import.meta.url))("nodemailer").createTransport({
      host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    for (const a of toSend) {
      const mail = mailFor(a, user || SHOP_MAILBOX);
      if (DRY) { console.log(`WOULD MAIL ${MAIL_TO}\nSubject: ${mail.subject}\n\n${mail.text}\n`); continue; }
      try {
        const info = await transport.sendMail(mail);
        state.sent[a.key] = Date.now();
        log(`sent "${a.subject}" to ${MAIL_TO}: ${info?.messageId || "no id"}`);
      } catch (e) {
        code = 1;   // not marked sent, so the next tick tries again
        log(`NOT sent "${a.subject}": ${String(e?.message || e).slice(0, 200)}`);
      }
    }
  } else if (DRY) console.log(`${stamp()}  nothing to send`);
} catch (e) {
  log(`social-alarm-mail: ${e?.message || e}`);
  code = 1;
} finally {
  if (!DRY) { try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch (e) { console.error(`cannot save state: ${e?.message || e}`); } }
  await admin.app().delete().catch(() => {});
}
process.exit(code);
