// ─── THE WRITE-OFF DIGEST EMAIL: A LOG LINE, A GOOGLE-OPERATED POLICY, AN EMAIL
//
// refusalWriteoffDigest (functions/index.js → functions/lib/writeoff-digest.cjs)
// prints ONE line a day when the scan wrote something off:
//
//     REFUSAL_WRITEOFF_DIGEST 3 sizes / 5 units written off after four refused days — Hub 2: 1 (3u), … | Nike Tech …
//
// This script creates the Cloud Monitoring policy that turns that line into an
// email to Junid WITH the text in it — the existing report path (the card-recon
// and social alarms), except it is a log-MATCH condition, not a metric
// threshold: a threshold can only say "it fired", a log match can carry the
// line itself (label extractor → ${log.extracted_label.digest} in the email).
// The email channel for junidmoh@gmail.com is SHARED with those alarms and is
// found by address, never duplicated.
//
//   node scripts/refill/install-writeoff-digest-alarm.mjs            # create / update
//   node scripts/refill/install-writeoff-digest-alarm.mjs --verify   # assert, change nothing
//   node scripts/refill/install-writeoff-digest-alarm.mjs --test     # emit a real test digest
//
// Credentials: application-default (gcloud auth application-default login as an
// owner), or ACCESS_TOKEN in the environment (an owner OAuth access token with
// cloud-platform scope — how it is run from a machine without ADC).

import { createRequire } from "module";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));

const PROJECT = "marathon-club";
export const MARKER = "REFUSAL_WRITEOFF_DIGEST";
const POLICY_NAME = "Written off after refusal — daily digest";
const RECIPIENT = "junidmoh@gmail.com";
const SERVICE = "refusalwriteoffdigest";

const args = process.argv.slice(2);
const VERIFY = args.includes("--verify");
const TEST = args.includes("--test");

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };

let client;
async function api(url, { method = "GET", body } = {}) {
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500 * i));
    try {
      if (process.env.ACCESS_TOKEN) {
        const res = await fetch(url, {
          method, headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return { ok: true, status: res.status, data };
        if (!(res.status === 429 || (method === "GET" && res.status >= 500))) return { ok: false, status: res.status, data };
        continue;
      }
      const { GoogleAuth } = require("google-auth-library");
      client ||= await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
      const res = await client.request({ url, method, data: body });
      return { ok: true, status: res.status, data: res.data };
    } catch (err) {
      const status = err?.response?.status ?? 0;
      const last = { ok: false, status, data: err?.response?.data ?? { error: String(err?.message || err) } };
      if (!(status === 429 || (method === "GET" && (status === 0 || status >= 500)))) return last;
      if (i === 2) return last;
    }
  }
  return { ok: false, status: 0, data: { error: "retries exhausted" } };
}

const FILTER = `resource.type="cloud_run_revision" AND resource.labels.service_name="${SERVICE}" AND textPayload:"${MARKER}"`;

function policyBody(channelName) {
  return {
    displayName: POLICY_NAME,
    documentation: {
      mimeType: "text/markdown",
      content:
        "**Written off after refusal.** ${log.extracted_label.digest}\n\n" +
        "Each size was refused on four different days by the location named, with no fulfilment in between, so its " +
        "pre-refusal count was erased and the size flows again. Full list, with every refusal date and who refused: " +
        "Inventory Health → Written off after refusal (super admin only).",
    },
    conditions: [{
      displayName: "refusalWriteoffDigest sent a digest",
      conditionMatchedLog: {
        filter: FILTER,
        labelExtractors: { digest: `REGEXP_EXTRACT(textPayload, "${MARKER} (.*)")` },
      },
    }],
    combiner: "OR",
    enabled: true,
    notificationChannels: [channelName],
    alertStrategy: { notificationRateLimit: { period: "300s" }, autoClose: "1800s" },
  };
}

async function findChannel() {
  const list = await api(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/notificationChannels`);
  if (!list.ok) return fail(`could not list notification channels (HTTP ${list.status}): ${JSON.stringify(list.data).slice(0, 300)}`);
  const found = (list.data.notificationChannels || []).find((c) => c.type === "email" && c.labels?.email_address === RECIPIENT);
  if (!found) return fail(`no email channel for ${RECIPIENT} — run scripts/social/install-social-alarm.mjs first (it owns the shared channel)`);
  log(`✓ email channel → ${RECIPIENT}${found.verificationStatus ? ` (${found.verificationStatus})` : ""}`);
  return found;
}

async function ensurePolicy(channelName) {
  const base = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`;
  const list = await api(base);
  if (!list.ok) return fail(`could not list alert policies: ${JSON.stringify(list.data).slice(0, 300)}`);
  const found = (list.data.alertPolicies || []).find((p) => p.displayName === POLICY_NAME);
  const want = policyBody(channelName);
  if (found) {
    const live = found.conditions?.[0]?.conditionMatchedLog;
    const drift = [];
    if (live?.filter !== FILTER) drift.push(`filter: ${live?.filter}`);
    if (live?.labelExtractors?.digest !== want.conditions[0].conditionMatchedLog.labelExtractors.digest) drift.push("label extractor");
    if (!(found.notificationChannels || []).includes(channelName)) drift.push("notification channel");
    if (found.enabled === false) drift.push("disabled");
    if (VERIFY) {
      if (drift.length) return fail(`policy "${POLICY_NAME}" has drifted: ${drift.join("; ")}`);
      log(`✓ alert policy "${POLICY_NAME}"`);
      return found;
    }
    const upd = await api(`https://monitoring.googleapis.com/v3/${found.name}`, { method: "PATCH", body: want });
    if (!upd.ok) return fail(`could not update the policy: ${JSON.stringify(upd.data).slice(0, 400)}`);
    log(`✓ alert policy "${POLICY_NAME}" (updated)`);
    return upd.data;
  }
  if (VERIFY) return fail(`alert policy "${POLICY_NAME}" does not exist`);
  const made = await api(base, { method: "POST", body: want });
  if (!made.ok) return fail(`could not create the policy: ${JSON.stringify(made.data).slice(0, 400)}`);
  log(`✓ alert policy "${POLICY_NAME}" (created)`);
  return made.data;
}

async function verifyMarkerInSource() {
  const { readFileSync } = await import("fs");
  const src = readFileSync(new URL("../../functions/lib/writeoff-digest.cjs", import.meta.url), "utf8");
  if (!src.includes(`const MARKER = "${MARKER}";`) || !src.includes("log(`${MARKER} ${digest.summary}`);")) {
    return fail("functions/lib/writeoff-digest.cjs no longer emits the marker this policy matches");
  }
  log("✓ writeoff-digest.cjs still emits the marker");
}

async function emitTest() {
  const res = await api("https://logging.googleapis.com/v2/entries:write", {
    method: "POST",
    body: {
      logName: `projects/${PROJECT}/logs/run.googleapis.com%2Fstderr`,
      resource: { type: "cloud_run_revision", labels: { service_name: SERVICE, project_id: PROJECT, location: "europe-west1" } },
      entries: [{ severity: "ERROR", textPayload: `${MARKER} TEST — install-writeoff-digest-alarm.mjs --test proving the digest reaches your inbox. Nothing was written off.` }],
    },
  });
  if (!res.ok) return fail(`could not write the test entry: ${JSON.stringify(res.data).slice(0, 300)}`);
  log("✓ test digest written to Cloud Logging — the email follows within a few minutes");
}

const channel = await findChannel();
if (channel) await ensurePolicy(channel.name);
await verifyMarkerInSource();
if (TEST) await emitTest();
if (process.exitCode) console.error("\n✗✗ the digest email is NOT fully installed — see above");
else log(`\n${VERIFY ? "Installed and wired." : "Done."} Each day's write-offs now email ${RECIPIENT}.`);
