// ─── THE DEVICE ENROLMENT EMAIL: A LOG LINE, A GOOGLE-OPERATED POLICY, AN EMAIL
//
// deviceEnrolmentEmail (functions/deviceEnrolment/deviceEnrolment.js) prints
// ONE line whenever something is queued — at most every 31 minutes, so Google
// never folds one email into another:
//
//     DEVICE_ENROLMENT_ALERT NEW DEVICE: Sipho · code 4821 · Android phone · Chrome · 25 Sep 17:42 · 1 of 2 | CODE FULL: …
//
// This script creates the Cloud Monitoring log-MATCH policy that turns that
// line into an email to Junid with the line in it — the same route as the
// write-off digest, card-recon and social alarms. The email channel for
// junidmoh@gmail.com is SHARED with those and found by address, never
// duplicated. Its own policy, so an open alert on another alarm can never
// swallow an enrolment email.
//
//   node scripts/device-enrolment/install-enrolment-alarm.mjs            # create / update
//   node scripts/device-enrolment/install-enrolment-alarm.mjs --verify   # assert, change nothing
//   node scripts/device-enrolment/install-enrolment-alarm.mjs --test     # emit a real test line
//
// Credentials: application-default (gcloud auth application-default login as an
// owner), or ACCESS_TOKEN in the environment (an owner OAuth access token with
// cloud-platform scope). Node on Junid's Mac cannot reach Google — run it on
// the Mac mini (reference_local_node_cannot_reach_google).
//
// NEVER import this file to test it — importing RUNS it. Use `node --check`.

import { createRequire } from "module";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));

const PROJECT = "marathon-club";
// One source for the names — the function's own lib, never a second copy.
const lib = require("./lib/device-enrolment.cjs");
export const MARKER = lib.MARKER;
const POLICY_NAME = lib.POLICY_NAME;
const RECIPIENT = lib.RECIPIENT;
const SERVICE = "deviceenrolmentemail";

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
        "**Store app — device codes.** ${log.extracted_label.events}\n\n" +
        "Every phone on MC's login needs its own 4-digit code. To see every device, or to revoke one: " +
        "the store app → Device Codes (#admin/devices).",
    },
    conditions: [{
      displayName: "deviceEnrolmentEmail printed an enrolment line",
      conditionMatchedLog: {
        filter: FILTER,
        labelExtractors: { events: `REGEXP_EXTRACT(textPayload, "${MARKER} (.*)")` },
      },
    }],
    combiner: "OR",
    enabled: true,
    notificationChannels: [channelName],
    alertStrategy: { notificationRateLimit: { period: "300s" }, autoClose: "1800s" },
  };
}

// Every page of a Monitoring list — a resource on page 2 is not "absent".
// (CodeRabbit, PR #647.)
async function listAll(url, field) {
  const out = [];
  let token = "";
  for (let i = 0; i < 50; i++) {
    const page = await api(`${url}${token ? `${url.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(token)}` : ""}`);
    if (!page.ok) return { ok: false, status: page.status, data: page.data };
    out.push(...(page.data[field] || []));
    token = page.data.nextPageToken || "";
    if (!token) return { ok: true, items: out };
  }
  return { ok: false, status: 0, data: { error: "more than 50 pages" } };
}

async function findChannel() {
  const list = await listAll(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/notificationChannels`, "notificationChannels");
  if (!list.ok) return fail(`could not list notification channels (HTTP ${list.status}): ${JSON.stringify(list.data).slice(0, 300)}`);
  const found = list.items.find((c) => c.type === "email" && c.labels?.email_address === RECIPIENT);
  if (!found) return fail(`no email channel for ${RECIPIENT} — run scripts/social/install-social-alarm.mjs first (it owns the shared channel)`);
  // An unverified or disabled channel sends nothing — never report it as wired.
  if (found.enabled === false) return fail(`the email channel for ${RECIPIENT} is DISABLED — enable it in Cloud Monitoring`);
  if (found.verificationStatus === "UNVERIFIED") return fail(`the email channel for ${RECIPIENT} is UNVERIFIED — it sends nothing until verified`);
  log(`✓ email channel → ${RECIPIENT}${found.verificationStatus ? ` (${found.verificationStatus})` : ""}`);
  return found;
}

async function ensurePolicy(channelName) {
  const base = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`;
  const list = await listAll(base, "alertPolicies");
  if (!list.ok) return fail(`could not list alert policies: ${JSON.stringify(list.data).slice(0, 300)}`);
  const found = list.items.find((p) => p.displayName === POLICY_NAME);
  const want = policyBody(channelName);
  if (found) {
    const live = found.conditions?.[0]?.conditionMatchedLog;
    const drift = [];
    if (live?.filter !== FILTER) drift.push(`filter: ${live?.filter}`);
    if (live?.labelExtractors?.events !== want.conditions[0].conditionMatchedLog.labelExtractors.events) drift.push("label extractor");
    if (!(found.notificationChannels || []).includes(channelName)) drift.push("notification channel");
    if (found.enabled === false) drift.push("disabled");
    // The email text carries the enrolment line itself; a changed or missing
    // one would still "fire" with nothing useful in it.
    if (found.documentation?.content !== want.documentation.content) drift.push("email text");
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
  const libSrc = readFileSync(new URL("../../functions/lib/device-enrolment.cjs", import.meta.url), "utf8");
  const fnSrc = readFileSync(new URL("../../functions/deviceEnrolment/deviceEnrolment.js", import.meta.url), "utf8");
  if (!libSrc.includes(`const MARKER = "${MARKER}";`) || !fnSrc.includes("log(`${E.MARKER} ${line}`);")) {
    return fail("the function no longer emits the marker this policy matches");
  }
  log("✓ deviceEnrolmentEmail still emits the marker");
}

async function emitTest() {
  const res = await api("https://logging.googleapis.com/v2/entries:write", {
    method: "POST",
    body: {
      logName: `projects/${PROJECT}/logs/run.googleapis.com%2Fstderr`,
      resource: { type: "cloud_run_revision", labels: { service_name: SERVICE, project_id: PROJECT, location: "europe-west1" } },
      entries: [{ severity: "ERROR", textPayload: `${MARKER} TEST — install-enrolment-alarm.mjs --test proving device-code emails reach your inbox. No device was enrolled.` }],
    },
  });
  if (!res.ok) return fail(`could not write the test entry: ${JSON.stringify(res.data).slice(0, 300)}`);
  log("✓ test line written to Cloud Logging — the email follows within a few minutes");
}

const channel = await findChannel();
if (channel) await ensurePolicy(channel.name);
await verifyMarkerInSource();
if (TEST) await emitTest();
if (process.exitCode) console.error("\n✗✗ the device enrolment email is NOT fully installed — see above");
else log(`\n${VERIFY ? "Installed and wired." : "Done."} New devices and full codes now email ${RECIPIENT}.`);
