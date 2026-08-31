// ─── THE POLLER ALARM: A LOG MARKER, A GOOGLE-OPERATED POLICY, AN EMAIL ──────
//
// cardReconHealthScan (functions/index.js) prints one line when the card recon
// mailbox poller on the Mac mini has stopped ticking:
//
//     CARD_RECON_ALARM The card recon mailbox poller has not ticked for 42 minutes. …
//
// This script creates the Cloud Monitoring machinery that turns that line into
// an email to the owner, and — with --verify — proves it is still there. It is
// the social engine's silence alarm (scripts/social/install-social-alarm.mjs),
// adapted: same channel choice for the same reasons (the alarm runs on
// Google's infrastructure, never on the mini it watches, and needs nothing
// that does not already exist), same idempotent create-or-update, same
// verify-the-marker-in-source pin. The email notification channel is SHARED
// with the social alarm — one recipient, one channel, found by address.
//
// WHY THIS EXISTS: on 2026-08-31 launchd silently stopped firing the poller at
// 01:16 and payments sat unread for nine hours, because the only witness was a
// heartbeat panel the owner has to open. KeepAlive in the plist makes that
// death unlikely; this alarm makes the next one LOUD.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   node scripts/cardrecon/install-cardrecon-alarm.mjs            # create / update
//   node scripts/cardrecon/install-cardrecon-alarm.mjs --verify   # assert, change nothing
//   node scripts/cardrecon/install-cardrecon-alarm.mjs --test     # emit a real test alarm
//
// Needs application-default credentials with permission to manage Monitoring
// and Logging in marathon-club — i.e. `gcloud auth application-default login`
// as an owner. This is setup, not run-time.

import { createRequire } from "module";
// Resolved against functions/package.json — the same trick secrets.mjs uses,
// so scripts/ needs no dependency manifest of its own and the auth library can
// never be a different version here than the publisher runs.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { GoogleAuth } = require("google-auth-library");

const PROJECT = "marathon-club";
// THE MARKER. The same literal appears in functions/index.js. If these two ever
// disagree the alarm is disconnected and every green check stays green, which
// is the exact failure the whole feature exists to prevent — so --verify reads
// the function source and asserts they match, rather than trusting a comment.
export const MARKER = "CARD_RECON_ALARM";
const METRIC = "card_recon_alarm";
const POLICY_NAME = "Card recon poller alarm";
const RECIPIENT = "junidmoh@gmail.com";

const args = process.argv.slice(2);
const VERIFY = args.includes("--verify");
const TEST = args.includes("--test");

let client;

/**
 * One API call, retried through transient failures.
 *
 * THE RETRY IS NOT A NICETY. Without it this script reported "log metric
 * card_recon_alarm does not exist" on a dropped socket — a verifier crying
 * wolf about the alarm, which is the fastest way to teach someone to ignore
 * it. Status 0 is a network failure with no response at all; 429 and 5xx are
 * Google asking to be asked again. A 404 is an answer and is never retried.
 */
const ATTEMPTS = 3;

/**
 * Is this worth trying again, given what the call would DO?
 *
 * A read can always be retried. A WRITE cannot, and the distinction matters
 * here: status 0 means no response arrived, which does not mean nothing
 * happened — a create that timed out on the way back has still created. Retry
 * that and this script makes a SECOND notification channel for the same
 * address. So a write is retried only on 429, the one answer that says the
 * server refused to process it; everything else a write hits is reported, not
 * repeated.
 */
function worthRetrying(status, method) {
  if (status === 429) return true;
  if (method !== "GET") return false;
  return status === 0 || status >= 500;
}

async function api(url, { method = "GET", body } = {}) {
  client ||= await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
  let last;
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500 * i));
    try {
      const res = await client.request({ url, method, data: body });
      return { ok: true, status: res.status, data: res.data };
    } catch (err) {
      const status = err?.response?.status ?? 0;
      last = { ok: false, status, data: err?.response?.data ?? { error: String(err?.message || err) } };
      if (!worthRetrying(status, method)) break;
    }
  }
  return last;
}

/**
 * Did this call say "not there", or did it fail to say anything?
 *
 * The difference is the whole reliability of --verify. Only a 404 means the
 * thing is absent; anything else — a network failure, a permissions error, a
 * Google 500 — means we DO NOT KNOW, and must say so in those words rather
 * than assert an absence the API never reported.
 */
const isAbsent = (res) => res.status === 404;
const undetermined = (what, res) =>
  fail(`could not determine whether ${what} exists (HTTP ${res.status || "no response"}): ${JSON.stringify(res.data).slice(0, 300)}`);

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };

// ── 1. the log-based metric ──────────────────────────────────────────────────
// Scoped to the one function that writes the marker. A project-wide filter
// would also match this script's own --test output and any future copy of the
// string in an unrelated service, and an alarm that can be tripped by
// something other than the thing it watches is not worth having.
const METRIC_FILTER =
  `resource.type="cloud_run_revision" ` +
  `AND resource.labels.service_name="cardreconhealthscan" ` +
  `AND textPayload:"${MARKER}"`;

async function ensureMetric() {
  const base = `https://logging.googleapis.com/v2/projects/${PROJECT}/metrics`;
  const body = {
    name: METRIC,
    description: "cardReconHealthScan raised the poller alarm — see scripts/cardrecon/install-cardrecon-alarm.mjs",
    filter: METRIC_FILTER,
  };
  const existing = await api(`${base}/${METRIC}`);
  if (!existing.ok && !isAbsent(existing)) return undetermined(`log metric ${METRIC}`, existing);
  if (existing.ok) {
    if (VERIFY) {
      if (existing.data.filter !== METRIC_FILTER) return fail(`metric ${METRIC} exists but its filter has drifted:\n  ${existing.data.filter}`);
      log(`✓ log metric ${METRIC}`);
      return existing.data;
    }
    const upd = await api(`${base}/${METRIC}`, { method: "PUT", body });
    if (!upd.ok) return fail(`could not update metric: ${JSON.stringify(upd.data)}`);
    log(`✓ log metric ${METRIC} (updated)`);
    return upd.data;
  }
  if (VERIFY) return fail(`log metric ${METRIC} does not exist — run this script without --verify`);
  const made = await api(base, { method: "POST", body });
  if (!made.ok) return fail(`could not create metric: ${JSON.stringify(made.data)}`);
  log(`✓ log metric ${METRIC} (created)`);
  return made.data;
}

// ── 2. the email channel ─────────────────────────────────────────────────────
async function ensureChannel() {
  const base = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/notificationChannels`;
  const list = await api(base);
  if (!list.ok) return fail(`could not list notification channels: ${JSON.stringify(list.data)}`);
  const found = (list.data.notificationChannels || [])
    .find((c) => c.type === "email" && c.labels?.email_address === RECIPIENT);
  if (found) {
    // A channel Google has told us is UNVERIFIED delivers nothing, so --verify
    // must FAIL on it rather than print a tick. Note the distinction from the
    // note below: a status that is absent is not a no — it is simply not
    // reported for a channel created through the API — and failing on an
    // absent status would make --verify permanently red for a channel that
    // works.
    if (VERIFY && found.verificationStatus && found.verificationStatus !== "VERIFIED") {
      // RECORDED, not returned. Failing out here would skip the metric and
      // policy checks below and report one problem at a time, which turns a
      // single run of --verify into three. The exit code is already set; the
      // rest of the chain still gets checked.
      fail(`the email channel for ${RECIPIENT} is ${found.verificationStatus} — Google will deliver nothing until the address is confirmed. Open the verification email, or resend it from GCP console → Monitoring → Alerting → Notification channels.`);
    } else {
      log(`✓ email channel → ${RECIPIENT}${found.verificationStatus ? ` (${found.verificationStatus})` : ""}`);
    }
    // THE ONE THING THIS SCRIPT CANNOT PROVE. Every other link in the chain is
    // checkable from here — the marker is in the source, the metric counted
    // the test line, the policy is enabled and wired to this channel. Whether
    // Google's mail actually lands in the inbox is only knowable from the
    // inbox. `verificationStatus` comes back undefined for a channel created
    // through the API, which is neither a yes nor a no, so it is reported as
    // the open question it is rather than assumed either way.
    if (!found.verificationStatus || found.verificationStatus === "UNVERIFIED") {
      log(`  ↳ delivery to ${RECIPIENT} is the one link only the inbox can confirm.`);
      log("    Run --test and look. If nothing arrives, verify the channel once in");
      log("    GCP console → Monitoring → Alerting → Notification channels.");
    }
    return found;
  }
  if (VERIFY) return fail(`no email notification channel for ${RECIPIENT}`);
  const made = await api(base, {
    method: "POST",
    body: {
      type: "email",
      displayName: "Junid — card recon poller",
      description: "Raised by cardReconHealthScan when the mailbox poller on the Mac mini stops ticking.",
      labels: { email_address: RECIPIENT },
      enabled: true,
    },
  });
  if (!made.ok) return fail(`could not create the email channel: ${JSON.stringify(made.data)}`);
  log(`✓ email channel → ${RECIPIENT} (created)`);
  return made.data;
}

// ── 3. the alert policy ──────────────────────────────────────────────────────
// A COUNT condition on the log metric, not an absence condition. "Absence of a
// healthy signal" sounds like the right shape for a silence detector and is
// the wrong one here: the silence is detected by cardReconHealthScan, which has
// the whole day's data and can say WHY. This policy's only job is to carry
// that sentence to an inbox, so it fires on the presence of the sentence.
function policyBody(channelName) {
  return {
    displayName: POLICY_NAME,
    documentation: {
      content:
        "The card recon mailbox poller on the Mac mini has stopped ticking — card slips AND EFT payment " +
        "notifications are not being read until it is back. Check the mini is on and on the network, then: " +
        "`launchctl kickstart -k gui/501/com.marathon.cardreconpoll` and read " +
        "~/marathon-store-app/logs/card-recon-poll.log. The watchdog's verdict is in Realtime Database at " +
        "/card_batch_poll_health; the poller's own heartbeat at /card_batch_poll_status.",
      mimeType: "text/markdown",
    },
    conditions: [{
      displayName: "cardReconHealthScan raised the alarm",
      conditionThreshold: {
        filter: `metric.type="logging.googleapis.com/user/${METRIC}" AND resource.type="cloud_run_revision"`,
        comparison: "COMPARISON_GT",
        thresholdValue: 0,
        // The scan runs hourly at most, so the shortest legal window is fine:
        // there is no burst to smooth out, and every extra minute here is a
        // minute of delay on an alarm.
        duration: "0s",
        aggregations: [{
          alignmentPeriod: "300s",
          perSeriesAligner: "ALIGN_COUNT",
          crossSeriesReducer: "REDUCE_SUM",
        }],
        trigger: { count: 1 },
      },
    }],
    combiner: "OR",
    enabled: true,
    notificationChannels: [channelName],
    alertStrategy: {
      // ── 30 MINUTES, THE SHORTEST GOOGLE ALLOWS, AND FOR A REASON ──────────
      // An open incident does not notify again. A LONG autoClose therefore
      // silences the alarm exactly when it matters most: a bad night at 22:25
      // and a bad morning at 07:25 are nine hours apart, so anything above
      // that folds the second day into the first day's still-open incident and
      // sends no email — two silent days reported once. Thirty minutes means
      // every bad day opens its own incident and sends its own email.
      //
      // This does NOT re-send per check: cardReconHealthScan dedupes on the
      // outage's signature (the heartbeat it stranded) and re-alarms a
      // continuing outage every six hours, so the metric increments once per
      // outage plus a six-hourly reminder — never once per ten-minute check.
      autoClose: "1800s",
    },
  };
}

/**
 * Which fields of the live policy no longer match what this script would
 * write? Returns a list of human-readable differences, empty when it matches.
 *
 * Compares only the fields THIS SCRIPT SETS — the API decorates a policy with
 * `name`, `creationRecord`, `mutationRecord` and per-condition names that we
 * never author, and a naive deep-equal would report those as drift forever.
 */
function policyDrift(live, want) {
  const out = [];
  const cmp = (label, a, b) => {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) out.push(`${label}: live ${A} — expected ${B}`);
  };
  cmp("enabled", live.enabled !== false, want.enabled);
  cmp("combiner", live.combiner, want.combiner);
  cmp("autoClose", live.alertStrategy?.autoClose, want.alertStrategy.autoClose);
  cmp("notificationChannels", (live.notificationChannels || []).slice().sort(), want.notificationChannels.slice().sort());
  cmp("conditions", (live.conditions || []).length, want.conditions.length);

  const lt = live.conditions?.[0]?.conditionThreshold;
  const wt = want.conditions[0].conditionThreshold;
  if (!lt) {
    out.push("condition: live policy has no threshold condition at all");
    return out;
  }
  for (const k of ["filter", "comparison", "thresholdValue", "duration"]) {
    // thresholdValue comes back absent when it is 0, and duration absent when
    // it is "0s" — the API omits defaults rather than echoing them, so an
    // absent field that we asked to be the default is NOT drift.
    const liveV = lt[k] ?? (k === "thresholdValue" ? 0 : k === "duration" ? "0s" : undefined);
    cmp(`condition.${k}`, liveV, wt[k]);
  }
  cmp("condition.aggregations", lt.aggregations, wt.aggregations);
  cmp("condition.trigger", lt.trigger, wt.trigger);
  return out;
}

async function ensurePolicy(channelName) {
  const base = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`;
  const list = await api(base);
  if (!list.ok) return fail(`could not list alert policies: ${JSON.stringify(list.data)}`);
  const found = (list.data.alertPolicies || []).find((p) => p.displayName === POLICY_NAME);
  if (found) {
    if (VERIFY) {
      // EVERY field this script sets, not the three most obvious ones. A
      // drifted comparison, threshold, duration, aggregation or trigger can
      // stop one log line from ever opening an incident, and a drifted
      // autoClose silently swallows the SECOND bad day — all while "enabled,
      // wired, watching the metric" stays true. Checking three fields and
      // reporting a tick is how a verifier ends up certifying a dead alarm.
      const drift = policyDrift(found, policyBody(channelName));
      if (drift.length) {
        return fail(`alert policy "${POLICY_NAME}" has drifted:\n    ${drift.join("\n    ")}`);
      }
      log(`✓ alert policy "${POLICY_NAME}"`);
      return found;
    }
    const upd = await api(`https://monitoring.googleapis.com/v3/${found.name}`, {
      method: "PATCH", body: policyBody(channelName),
    });
    if (!upd.ok) return fail(`could not update the alert policy: ${JSON.stringify(upd.data)}`);
    log(`✓ alert policy "${POLICY_NAME}" (updated)`);
    return upd.data;
  }
  if (VERIFY) return fail(`alert policy "${POLICY_NAME}" does not exist`);
  const made = await api(base, { method: "POST", body: policyBody(channelName) });
  if (!made.ok) return fail(`could not create the alert policy: ${JSON.stringify(made.data)}`);
  log(`✓ alert policy "${POLICY_NAME}" (created)`);
  return made.data;
}

// ── the pin ──────────────────────────────────────────────────────────────────
// The one check that cannot be done from the API: does the code still emit the
// string the policy matches?
async function verifyMarkerInSource() {
  const { readFileSync } = await import("fs");
  const src = readFileSync(new URL("../../functions/index.js", import.meta.url), "utf8");
  if (!src.includes("CARD_RECON_ALARM The card recon mailbox poller")) {
    return fail("functions/index.js no longer emits the CARD_RECON_ALARM marker the alert policy matches");
  }
  log("✓ functions/index.js still emits the marker");
}

async function emitTestAlarm() {
  // Written straight to Cloud Logging under the same resource the real one
  // uses, so this exercises the metric, the policy and the email — the whole
  // chain — without waiting for a genuinely bad day.
  const res = await api(`https://logging.googleapis.com/v2/entries:write`, {
    method: "POST",
    body: {
      logName: `projects/${PROJECT}/logs/run.googleapis.com%2Fstderr`,
      resource: { type: "cloud_run_revision", labels: { service_name: "cardreconhealthscan", project_id: PROJECT, location: "europe-west1" } },
      entries: [{
        severity: "ERROR",
        textPayload: `${MARKER} TEST — this is install-cardrecon-alarm.mjs --test proving the alarm reaches an inbox. Nothing is wrong.`,
      }],
    },
  });
  if (!res.ok) return fail(`could not write the test log entry: ${JSON.stringify(res.data)}`);
  log("✓ test alarm written to Cloud Logging — the email follows within a few minutes");
}

const channel = await ensureChannel();
if (channel) {
  await ensureMetric();
  await ensurePolicy(channel.name);
}
await verifyMarkerInSource();
if (TEST) await emitTestAlarm();

if (process.exitCode) {
  console.error("\n✗✗ the alarm is NOT fully installed — see above");
} else {
  log(`\n${VERIFY ? "The alarm is installed and wired." : "Done."} A bad day now emails ${RECIPIENT}.`);
}
