// ─── THE TILL SILENCE ALARM: A LOG MARKER, A GOOGLE-OPERATED POLICY, AN EMAIL ─
//
// cardTillSilenceScan (functions/index.js) prints one line each morning when a
// till took card money on a day no batch report covers:
//
//     CARD_TILL_SILENT_ALARM Trophy Till 1 (trophy/till-1, terminal 67325636): 1 day with card money and NO batch recorded — 25 Oct (R6,870.00 on card). …
//
// This script creates the Cloud Monitoring machinery that turns that line into
// an EMAIL to Junid and, with --verify, proves it is still there. It is
// install-stock-alarm.mjs adapted — a LOG-MATCH policy, so the email carries
// the line's own text (which till, which terminal, how many days) instead of a
// fixed description — on the same email channel as the poller alarm
// (install-cardrecon-alarm.mjs): one recipient, one channel, found by address.
//
// WHY THIS EXISTS (Junid, 25 Oct 2026): "Two consecutive silent days on a till
// that took card money should never again be something Junid discovers
// himself." The poller alarm watches the mailbox; this watches the tills.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   node scripts/cardrecon/install-till-silence-alarm.mjs            # create / update
//   node scripts/cardrecon/install-till-silence-alarm.mjs --verify   # assert, change nothing
//   node scripts/cardrecon/install-till-silence-alarm.mjs --test     # emit a real test alarm
//
// Needs application-default credentials with permission to manage Monitoring
// and Logging in marathon-club. This is setup, not run-time.

import { createRequire } from "module";
// Resolved against functions/package.json — the same trick secrets.mjs uses,
// so scripts/ needs no dependency manifest of its own and the auth library can
// never be a different version here than the publisher runs.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { GoogleAuth } = require("google-auth-library");

const PROJECT = "marathon-club";
// THE MARKER. The same literal is functions/lib/till-silence.cjs's MARKER. If these two ever
// disagree the alarm is disconnected and every green check stays green, which
// is the exact failure the whole feature exists to prevent — so --verify reads
// the function source and asserts they match, rather than trusting a comment.
export const MARKER = "CARD_TILL_SILENT_ALARM";
const POLICY_NAME = "Card till silence alarm";
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

// ── 1. the log filter the policy matches ─────────────────────────────────────
// Scoped to the TWO functions that write the marker: cardTillSilenceScan (a
// silent till, or the check itself failing) and cardReconHealthScan (the
// morning check has stopped running — a scheduler that never fires prints
// nothing of its own). A project-wide filter would also match this script's
// own --test output and any future copy of the string in an unrelated
// service, and an alarm that can be tripped by something other than the
// thing it watches is not worth having.
const LOG_FILTER =
  `resource.type="cloud_run_revision" ` +
  `AND resource.labels.service_name=("cardtillsilencescan" OR "cardreconhealthscan") ` +
  `AND textPayload:"${MARKER}"`;

/** Every page of a Monitoring list call — a match on page two must not lead
 *  to a duplicate resource being created. (CodeRabbit, this PR.) */
async function listAll(base, field) {
  const out = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const res = await api(pageToken ? `${base}?pageToken=${encodeURIComponent(pageToken)}` : base);
    if (!res.ok) return { ok: false, res };
    out.push(...(res.data[field] || []));
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return { ok: true, items: out };
}

async function ensureChannel() {
  const base = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/notificationChannels`;
  const list = await listAll(base, "notificationChannels");
  if (!list.ok) return fail(`could not list notification channels: ${JSON.stringify(list.res.data)}`);
  const found = list.items
    .find((c) => c.type === "email" && c.labels?.email_address === RECIPIENT);
  if (found) {
    // A channel Google has told us is UNVERIFIED delivers nothing, so --verify
    // must FAIL on it rather than print a tick. Note the distinction from the
    // note below: a status that is absent is not a no — it is simply not
    // reported for a channel created through the API — and failing on an
    // absent status would make --verify permanently red for a channel that
    // works.
    if (VERIFY && found.verificationStatus && found.verificationStatus !== "VERIFIED") {
      // RECORDED, not returned. Failing out here would skip the policy
      // checks below and report one problem at a time, which turns a
      // single run of --verify into three. The exit code is already set; the
      // rest of the chain still gets checked.
      fail(`the email channel for ${RECIPIENT} is ${found.verificationStatus} — Google will deliver nothing until the address is confirmed. Open the verification email, or resend it from GCP console → Monitoring → Alerting → Notification channels.`);
    } else {
      log(`✓ email channel → ${RECIPIENT}${found.verificationStatus ? ` (${found.verificationStatus})` : ""}`);
    }
    // THE ONE THING THIS SCRIPT CANNOT PROVE. Every other link in the chain is
    // checkable from here — the marker is in the source, the policy matches
    // the test line, it is enabled and wired to this channel. Whether
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
      displayName: "Junid — card till silence",
      description: "Raised by cardTillSilenceScan when a till took card money and no batch report covers it.",
      labels: { email_address: RECIPIENT },
      enabled: true,
    },
  });
  if (!made.ok) return fail(`could not create the email channel: ${JSON.stringify(made.data)}`);
  log(`✓ email channel → ${RECIPIENT} (created)`);
  return made.data;
}

// ── 3. the alert policy ──────────────────────────────────────────────────────
// A LOG-MATCH condition on the presence of the sentence, not an absence
// condition: the silence is detected by cardTillSilenceScan, which has the
// data to say WHICH till. This policy's only job is to carry that sentence —
// verbatim, via the extracted label — to Junid's inbox.
function policyBody(channelName) {
  return {
    displayName: POLICY_NAME,
    documentation: {
      // ${log.extracted_label.detail} is the alarm line itself — the email
      // names the till, its terminal and the days, not just "something".
      content:
        "${log.extracted_label.detail}\n\n" +
        "Background: cardTillSilenceScan runs at 07:30 SAST and judges the last seven days. A till is " +
        "named when it took card payments on a day no /card_batches record covers. Its last verdict is in " +
        "Realtime Database at /card_till_silence. Run `node scripts/cardrecon/till-silence-report.mjs` for " +
        "the same answer read-only. The mailbox poller's own health is a separate alarm " +
        "(Card recon poller alarm).",
      mimeType: "text/markdown",
    },
    conditions: [{
      displayName: "cardTillSilenceScan named a silent till",
      conditionMatchedLog: {
        filter: LOG_FILTER,
        labelExtractors: { detail: `REGEXP_EXTRACT(textPayload, "${MARKER} (.*)")` },
      },
    }],
    combiner: "OR",
    enabled: true,
    notificationChannels: [channelName],
    alertStrategy: {
      // Log-match policies require a rate limit. Five minutes is the floor;
      // the scan prints ONE line per morning naming every silent till.
      notificationRateLimit: { period: "300s" },
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
  cmp("notificationRateLimit", live.alertStrategy?.notificationRateLimit?.period, want.alertStrategy.notificationRateLimit.period);
  const lc = live.conditions?.[0]?.conditionMatchedLog;
  const wc = want.conditions[0].conditionMatchedLog;
  if (!lc) {
    out.push("condition: live policy has no log-match condition at all");
    return out;
  }
  cmp("condition.filter", lc.filter, wc.filter);
  cmp("condition.labelExtractors", lc.labelExtractors, wc.labelExtractors);
  return out;
}

async function ensurePolicy(channelName) {
  const base = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`;
  const list = await listAll(base, "alertPolicies");
  if (!list.ok) return fail(`could not list alert policies: ${JSON.stringify(list.res.data)}`);
  const found = list.items.find((p) => p.displayName === POLICY_NAME);
  if (found) {
    if (VERIFY) {
      // EVERY field this script sets, not the three most obvious ones. A
      // drifted filter or label extractor can stop a line from ever opening
      // an incident or empty the email, and a drifted rate limit or autoClose
      // silently swallows the SECOND bad day — all while "enabled, wired"
      // stays true. Checking three fields and
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
  const lib = readFileSync(new URL("../../functions/lib/till-silence.cjs", import.meta.url), "utf8");
  const pins = [
    lib.includes(`const MARKER = "${MARKER}";`),
    lib.includes("return `${MARKER} ${parts.join("),
    lib.includes("return `${MARKER} The till silence check itself FAILED"),
    lib.includes("return `${MARKER} The 07:30 till silence check ${since}"),
    src.includes("console.error(tillSilence.alarmLine(verdict.silent));"),
    src.includes("console.error(tillSilence.failureLine(err));"),
    src.includes("console.error(tillStale);"),
  ];
  if (pins.includes(false)) {
    return fail(`cardTillSilenceScan no longer emits the ${MARKER} marker the alert policy matches`);
  }
  log("✓ functions/index.js + lib/till-silence.cjs still emit the marker (silent till, failed check, stale check)");
}

async function emitTestAlarm() {
  // Written straight to Cloud Logging under the same resource the real one
  // uses, so this exercises the policy and the email — the whole
  // chain — without waiting for a genuinely bad day.
  const res = await api(`https://logging.googleapis.com/v2/entries:write`, {
    method: "POST",
    body: {
      logName: `projects/${PROJECT}/logs/run.googleapis.com%2Fstderr`,
      resource: { type: "cloud_run_revision", labels: {
        service_name: "cardtillsilencescan", project_id: PROJECT, location: "europe-west1",
        // The full label set the resource type declares — an entries:write
        // with missing labels can be refused as invalid. The policy filter
        // only reads service_name; these two just make the entry legal.
        revision_name: "manual-test", configuration_name: "cardtillsilencescan",
      } },
      entries: [{
        severity: "ERROR",
        textPayload: `${MARKER} [test] This is install-till-silence-alarm.mjs --test proving the till silence alarm reaches Junid's inbox. Nothing is wrong.`,
      }],
    },
  });
  if (!res.ok) return fail(`could not write the test log entry: ${JSON.stringify(res.data)}`);
  log("✓ test alarm written to Cloud Logging — the email follows within a few minutes");
}

const channel = await ensureChannel();
if (channel) {
  await ensurePolicy(channel.name);
}
await verifyMarkerInSource();
if (TEST) await emitTestAlarm();

if (process.exitCode) {
  console.error("\n✗✗ the alarm is NOT fully installed — see above");
} else {
  log(`\n${VERIFY ? "The alarm is installed and wired." : "Done."} A silent till now emails ${RECIPIENT}.`);
}
