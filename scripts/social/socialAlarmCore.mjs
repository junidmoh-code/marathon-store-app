// ── What the social alarm mailer says, and when it stays quiet ───────────────
// Pure: every input is handed in, so the 5–10 Nov 2026 outage replays in
// socialAlarmCore.test.mjs. The mailer (social-alarm-mail.mjs) does the reading
// and the sending.
//
// Why it exists: SOCIAL-OUTAGE-2026-11-05.md. socialHealthScan raised the
// alarm on time every day, but its only email went to junidmoh@gmail.com,
// which Junid does not read. This sends over Gmail SMTP from the shop mailbox
// to gunidmoh@gmail.com, the route that reaches him.
//
// ONE EMAIL PER CAUSE PER DAY. Each alert has a stable key; the mailer
// remembers the keys it sent. A cause still there tomorrow mails again
// tomorrow (one reminder a day), and a new cause mails at once.

export const MAIL_TO = "gunidmoh@gmail.com";       // Junid reads this one (with a G)
export const SHOP_MAILBOX = "marathon6631@gmail.com";
export const SUBJECT_PREFIX = "[Social engine]";
export const TOKEN_WARN_MS = 7 * 86400000;          // warn 7 days before any Meta expiry
export const HEALTH_STALE_MS = 45 * 60000;          // the scan runs every 15 min from 07:10
export const KEEP_SENT_MS = 21 * 86400000;

const SA_OFFSET_MS = 2 * 3600000;
export const saDate = (ms) => new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);
const saMinutes = (ms) => { const d = new Date(ms + SA_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const saStamp = (ms) => new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") + " SAST";

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []).filter(Boolean).map(String);

// A reason line that is a CONSEQUENCE ("the 15:30 feed post has not landed")
// rather than a cause. When a cause line is present, the consequences do not
// make a new email: the 07:10 email already said the day would be empty.
const CONSEQUENCE = /has not landed|have not landed/i;

/** The fix line for a cause, so the email says what to do, not only what broke. */
export function fixFor(text) {
  const t = String(text || "");
  if (/credits depleted|prepaid|HTTP 402|\(402\)/i.test(t)) return "Top up the Gemini prepaid balance (and turn on auto-reload): https://aistudio.google.com/app/billing (project marathon-club). Posting resumes by itself the same day once it answers.";
  if (/rate-limited|over quota|HTTP 429|\(429\)/i.test(t)) return "Gemini is rate-limiting or over quota. Check https://aistudio.google.com/app/billing; retries run by themselves.";
  if (/publisher|ticking|heartbeat/i.test(t)) return "The Mac mini publisher has stopped. The watchdog restarts it every 15 minutes; if this repeats, check the mini is on and awake.";
  if (/\b(page|access|meta) token\b|^token$|OAuth|code 190|session has expired/i.test(t)) return "The Meta token needs re-authorising: run node scripts/social/meta-token.mjs (see scripts/social/SOCIAL-SETUP.md).";
  return null;
}

// A reason line with its moving numbers taken out, so the same problem keeps
// the same key across the day's 15-minute scans ("not ticked for 17 minutes",
// "3 post(s) are in failed"). Slot times (HH:MM) are kept: a new slot missed is
// a new email (architect review, S4).
export function stableReason(r) {
  return String(r)
    .replace(/\b\d+ (minutes?|mins?)\b/gi, "# min")
    .replace(/\b\d+(?= (approved )?post\(s\))/gi, "#")
    .replace(/\ball \d+ skipped/gi, "all # skipped")
    .replace(/\s+/g, " ").trim();
}

/**
 * The day's health record → alert, or null.
 * day: social_health/days/{date} as socialHealthScan writes it.
 */
export function healthAlert(day, date) {
  if (!day || day.ok || day.severity !== "silent") return null;
  const reasons = asList(day.reasons);
  if (!reasons.length) return null;
  const causes = reasons.filter((r) => !CONSEQUENCE.test(r));
  const keyed = (causes.length ? causes : reasons)
    .map(stableReason)
    .sort();
  const fixes = [...new Set(reasons.map(fixFor).filter(Boolean))];
  return {
    key: `health:${date}:${JSON.stringify(keyed)}`,
    subject: `${SUBJECT_PREFIX} Nothing is posting on ${date}`,
    body: [
      `The social engine is not publishing today (${date}).`,
      "",
      "What the health check found:",
      ...reasons.map((r) => `  - ${r}`),
      ...(fixes.length ? ["", "What fixes it:", ...fixes.map((f) => `  - ${f}`)] : []),
    ].join("\n"),
  };
}

/** The cloud health check itself has stopped writing today's record. */
export function healthStaleAlert(day, nowMs) {
  const mins = saMinutes(nowMs);
  if (mins < 7 * 60 + 40) return null;              // first scan 07:10; allow it time
  const checkedAt = Number(day && day.checkedAt) || 0;
  if (nowMs - checkedAt < HEALTH_STALE_MS) return null;
  const date = saDate(nowMs);
  return {
    key: `health-stale:${date}`,
    subject: `${SUBJECT_PREFIX} The social health check has stopped running`,
    body: [
      `socialHealthScan has not written its record for ${date} since ${checkedAt ? saStamp(checkedAt) : "the day began"}.`,
      "Without it, a missed post would go unnoticed. Check the Cloud Functions logs for socialHealthScan (project marathon-club, europe-west1).",
    ].join("\n"),
  };
}

/** A generator run that threw (not a skip: a crash) → alert. kind: "06:00 reel run" | "07:00 still run". */
export function runErrorAlert(log, kind, date) {
  if (!log || !log.error) return null;
  const err = String(log.error).slice(0, 400);
  const fix = fixFor(err);
  return {
    key: `run-error:${date}:${kind}`,
    subject: `${SUBJECT_PREFIX} The ${kind} failed on ${date}`,
    body: [`The ${kind} on ${date} stopped with an error:`, `  ${err}`, ...(fix ? ["", fix] : [])].join("\n"),
  };
}

/**
 * Publisher runs on the Mac mini that failed a post, from logs/social-publish.log.
 * Returns alerts for "done: N posted, M failed" lines with M > 0, keyed by the
 * run's timestamp, and for the runner's own consecutive-failure counter.
 */
export function publisherAlerts(logText, state, date) {
  const out = [];
  const lines = String(logText || "").split("\n");
  const prefix = date.replace(/-/g, "/");
  let runStart = null, runLines = [];
  for (const line of lines) {
    if (!line.startsWith(prefix)) { if (runStart) runLines.push(line); continue; }
    if (/── run start ──/.test(line)) { runStart = line.slice(0, 20); runLines = []; continue; }
    if (runStart) runLines.push(line);
    const m = /done: (\d+) posted, (\d+) failed/.exec(line);
    if (m && Number(m[2]) > 0 && runStart) {
      const detail = runLines.filter((l) => /fail|error|✗|refused/i.test(l)).slice(0, 8).map((l) => `  ${l.trim()}`);
      const firstFail = (detail[0] || "").replace(/^\s*\d{4}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2}\s*/, "").trim();
      out.push({
        // Per day and failure, not per run: a post that errors mid-send goes
        // back to approved and fails again on every 2-minute tick (S6).
        key: `publish-failed:${date}:${firstFail || m[2]}`,
        subject: `${SUBJECT_PREFIX} ${m[2]} post(s) failed to publish (${runStart.slice(12, 17)})`,
        body: [`The publisher run at ${runStart} posted ${m[1]} and failed ${m[2]}.`, "", ...detail].join("\n"),
      });
    }
  }
  const fails = Number(state && state.consecutiveFailures) || 0;
  if (fails >= 2) {
    out.push({
      key: `publisher-failing:${date}`,
      subject: `${SUBJECT_PREFIX} The publisher has failed ${fails} runs in a row`,
      body: `logs/social-publish.state.json on the Mac mini reports ${fails} consecutive failed runs. The last lines of logs/social-publish.log say why.`,
    });
  }
  return out;
}

/**
 * Meta debug_token data → alerts. Expiry fields are epoch SECONDS; 0 means never.
 */
export function tokenAlerts(data, nowMs) {
  const date = saDate(nowMs);
  if (!data) return [];
  if (data.is_valid === false) {
    return [{
      key: `token-invalid:${date}`,
      subject: `${SUBJECT_PREFIX} The Meta page token is no longer valid`,
      body: [`Meta reports the page token as invalid${data.error && data.error.message ? `: ${data.error.message}` : ""}.`, "Nothing can post until it is re-authorised.", "", fixFor("token")].join("\n"),
    }];
  }
  const out = [];
  for (const [field, label] of [["expires_at", "expires"], ["data_access_expires_at", "loses data access"]]) {
    const s = Number(data[field]) || 0;
    if (!s) continue;
    const at = s * 1000;
    if (at - nowMs > TOKEN_WARN_MS) continue;
    const days = Math.max(0, Math.ceil((at - nowMs) / 86400000));
    out.push({
      key: `token-expiry:${field}:${s}`,
      subject: `${SUBJECT_PREFIX} The Meta token ${label} in ${days} day(s)`,
      body: [
        `The Meta page token ${label} on ${saStamp(at)} (${days} day(s) from now). After that, Instagram and Facebook posting stops.`,
        "",
        "To renew it, open the Graph API Explorer as the page admin, generate a user token for the Marathon Social app, and run:",
        "  node scripts/social/meta-token.mjs --short-lived <TOKEN>",
        "on the Mac mini (scripts/social/SOCIAL-SETUP.md has the steps). Logging in to the app at https://developers.facebook.com/tools/explorer/ renews data access.",
      ].join("\n"),
    });
  }
  return out;
}

/** The same-day retry could not run: its probe is broken or the scheduler refused. */
export function retryAlert(retry, date) {
  if (!retry) return null;
  const why = retry.fireError ? `re-firing the run failed: ${retry.fireError}` : retry.probeBroken ? `the Gemini probe answers ${retry.probeBroken} (expected 200, or 402/429 while credits are out)` : null;
  if (!why) return null;
  return {
    key: `retry-broken:${date}:${retry.fireError ? "fire" : "probe"}`,
    subject: `${SUBJECT_PREFIX} The automatic same-day retry cannot run (${date})`,
    body: [`socialAutopilotRetry could not win today back: ${why}.`, "Today's reel and photo will not be remade automatically. See the socialAutopilotRetry logs (Cloud Functions, europe-west1)."].join("\n"),
  };
}

/** Drop alerts already sent; prune old keys. → { toSend, sent } */
export function dedupe(alerts, sent, nowMs) {
  const kept = {};
  for (const [k, at] of Object.entries(sent || {})) if (nowMs - Number(at) < KEEP_SENT_MS) kept[k] = at;
  const seen = new Set();
  const toSend = [];
  for (const a of alerts) {
    if (!a || kept[a.key] || seen.has(a.key)) continue;
    seen.add(a.key);
    toSend.push(a);
  }
  return { toSend, sent: kept };
}

export function mailFor(alert, from) {
  return {
    from: `Marathon social engine <${from}>`,
    to: MAIL_TO,
    subject: alert.subject,
    text: `${alert.body}\n\n(Sent by the social alarm mailer on the Mac mini: scripts/social/social-alarm-mail.mjs.)\n`,
  };
}
