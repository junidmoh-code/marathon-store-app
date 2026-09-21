// ─── A LOG MARKER, A GOOGLE-OPERATED POLICY, AN EMAIL ───────────────────────
// The machinery behind every alarm in this estate: a function prints a marker
// line, a log-based metric counts it, an alert policy watches the metric, and
// Cloud Monitoring emails the owner. It runs on GOOGLE'S INFRASTRUCTURE and
// never on the machine it watches — an alarm that dies with the thing it is
// watching is not an alarm.
//
// ── WHY THIS IS A MODULE AND NOT A THIRD COPY ───────────────────────────────
// There were two installers before this (the social engine's silence alarm and
// the card recon poller's), and they were already near-identical copies. The
// third — the Gemini credit alarm — would have been the third copy of four
// hundred lines of retry rules, pagination, drift comparison and 404-versus-
// "don't know" reasoning, every line of which is load-bearing and none of which
// is obvious.
//
// This repo has already paid for that mistake once, in the card recon
// installer's own words: an installer that mirrored the poller's .env parser
// "drifted four times in one review cycle", and every drift had the same shape
// — the installer says fine and the failure appears in a log five minutes
// later. A verifier that has silently drifted from the thing it verifies is
// worse than no verifier, because it is trusted.
//
// So the machinery lives HERE, once, and each alarm is a small description of
// itself. What varies between alarms is only: the marker, the metric name, the
// policy name, which service writes the line, and what the email should say.

import { createRequire } from "module";
import { readFileSync } from "fs";
// Resolved against functions/package.json — the same trick secrets.mjs uses,
// so scripts/ needs no dependency manifest of its own and the auth library can
// never be a different version here than the functions runtime uses.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { GoogleAuth } = require("google-auth-library");

export const PROJECT = "marathon-club";

let client;

/**
 * One API call, retried through transient failures.
 *
 * THE RETRY IS NOT A NICETY. Without it the card recon installer reported
 * "log metric does not exist" on a dropped socket — a verifier crying wolf
 * about the alarm, which is the fastest way to teach someone to ignore it.
 */
const ATTEMPTS = 3;

/**
 * Is this worth trying again, given what the call would DO?
 *
 * A read can always be retried. A WRITE cannot, and the distinction matters:
 * status 0 means no response arrived, which does not mean nothing happened — a
 * create that timed out on the way back has still created. Retry that and the
 * script makes a SECOND notification channel for the same address. So a write
 * is retried only on 429, the one answer that says the server refused to
 * process it; everything else a write hits is reported, not repeated.
 */
export function worthRetrying(status, method) {
  if (status === 429) return true;
  if (method !== "GET") return false;
  return status === 0 || status >= 500;
}

export async function api(url, { method = "GET", body } = {}) {
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
export const isAbsent = (res) => res.status === 404;

/** Every page of a Monitoring list call — a match on page two must not lead to
 *  a duplicate resource being created. */
export async function listAll(base, field) {
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

/**
 * Which fields of the live policy no longer match what we would write?
 *
 * Compares only the fields WE SET — the API decorates a policy with `name`,
 * `creationRecord`, `mutationRecord` and per-condition names we never author,
 * and a naive deep-equal would report those as drift forever.
 *
 * EVERY field, not the three most obvious ones. A drifted comparison,
 * threshold, duration, aggregation or trigger can stop one log line from ever
 * opening an incident, and a drifted autoClose silently swallows the SECOND
 * bad day — all while "enabled, wired, watching the metric" stays true.
 * Checking three fields and reporting a tick is how a verifier ends up
 * certifying a dead alarm.
 */
export function policyDrift(live, want) {
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

/**
 * The alert policy body.
 *
 * A COUNT condition on the log metric, not an absence condition. "Absence of a
 * healthy signal" sounds like the right shape for a silence detector and is the
 * wrong one: the silence is detected by the scan function, which has the whole
 * picture and can say WHY. This policy's only job is to carry that sentence to
 * an inbox, so it fires on the PRESENCE of the sentence.
 */
export function buildPolicy({ policyName, metric, conditionLabel, documentation, channelName }) {
  return {
    displayName: policyName,
    documentation: { content: documentation, mimeType: "text/markdown" },
    conditions: [{
      displayName: conditionLabel,
      conditionThreshold: {
        filter: `metric.type="logging.googleapis.com/user/${metric}" AND resource.type="cloud_run_revision"`,
        comparison: "COMPARISON_GT",
        thresholdValue: 0,
        // The scans run hourly at most, so the shortest legal window is fine:
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
      // This does NOT re-send per check: each scan dedupes on its own alarm
      // signature and re-alarms a continuing problem every six hours, so the
      // metric increments once per outage plus a six-hourly reminder — never
      // once per check.
      autoClose: "1800s",
    },
  };
}

/**
 * Install (or verify) one alarm end to end.
 *
 * @param {object} spec
 * @param {string} spec.marker         the literal the function prints
 * @param {string} spec.markerPin      a longer substring that must still be in the source
 * @param {string} spec.sourceFile     URL of the file that must contain it
 * @param {string} spec.metric         log-based metric name
 * @param {string} spec.service        Cloud Run service (lowercased function name)
 * @param {string} spec.policyName     alert policy display name
 * @param {string} spec.conditionLabel
 * @param {string} spec.documentation  what the email body should explain
 * @param {string} spec.recipient      email address
 * @param {string} spec.channelName    display name for the channel
 * @param {string} spec.channelDescription
 * @param {string} spec.testLine       the --test payload
 * @param {{verify:boolean, test:boolean}} mode
 */
export async function installAlarm(spec, { verify = false, test = false } = {}) {
  let failed = false;
  const log = (...a) => console.log(...a);
  const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };
  const undetermined = (what, res) =>
    fail(`could not determine whether ${what} exists (HTTP ${res.status || "no response"}): ${JSON.stringify(res.data).slice(0, 300)}`);

  // ── 1. the email channel ───────────────────────────────────────────────────
  const channel = await (async () => {
    const base = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/notificationChannels`;
    const list = await listAll(base, "notificationChannels");
    if (!list.ok) return fail(`could not list notification channels: ${JSON.stringify(list.res.data)}`);
    // FOUND BY ADDRESS, not by display name. One recipient, one channel,
    // SHARED with every other alarm in the estate — a second channel for the
    // same inbox is how one alarm ends up wired to a channel nobody verified.
    const found = list.items.find((c) => c.type === "email" && c.labels?.email_address === spec.recipient);
    if (found) {
      // A channel Google has told us is UNVERIFIED delivers nothing, so
      // --verify must FAIL on it rather than print a tick. Note the
      // distinction below: a status that is ABSENT is not a no — it is simply
      // not reported for a channel created through the API — and failing on an
      // absent status would make --verify permanently red for a channel that
      // works.
      if (verify && found.verificationStatus && found.verificationStatus !== "VERIFIED") {
        // RECORDED, not returned. Failing out here would skip the metric and
        // policy checks and report one problem at a time, turning a single run
        // of --verify into three.
        fail(`the email channel for ${spec.recipient} is ${found.verificationStatus} — Google will deliver nothing until the address is confirmed.`);
      } else {
        log(`✓ email channel → ${spec.recipient}${found.verificationStatus ? ` (${found.verificationStatus})` : ""}`);
      }
      if (!found.verificationStatus || found.verificationStatus === "UNVERIFIED") {
        // THE ONE THING THIS CANNOT PROVE. Every other link is checkable from
        // here. Whether Google's mail lands in the inbox is only knowable from
        // the inbox, so it is reported as the open question it is.
        log(`  ↳ delivery to ${spec.recipient} is the one link only the inbox can confirm.`);
      }
      return found;
    }
    if (verify) return fail(`no email notification channel for ${spec.recipient}`);
    const made = await api(base, {
      method: "POST",
      body: {
        type: "email",
        displayName: spec.channelName,
        description: spec.channelDescription,
        labels: { email_address: spec.recipient },
        enabled: true,
      },
    });
    if (!made.ok) return fail(`could not create the email channel: ${JSON.stringify(made.data)}`);
    log(`✓ email channel → ${spec.recipient} (created)`);
    return made.data;
  })();

  // ── 2. the log-based metric ────────────────────────────────────────────────
  // Scoped to the ONE service that writes the marker. A project-wide filter
  // would also match a --test line from another alarm and any future copy of
  // the string in an unrelated service, and an alarm that can be tripped by
  // something other than the thing it watches is not worth having.
  const metricFilter =
    `resource.type="cloud_run_revision" ` +
    `AND resource.labels.service_name="${spec.service}" ` +
    `AND textPayload:"${spec.marker}"`;

  if (channel) {
    await (async () => {
      const base = `https://logging.googleapis.com/v2/projects/${PROJECT}/metrics`;
      const body = { name: spec.metric, description: spec.channelDescription, filter: metricFilter };
      const existing = await api(`${base}/${spec.metric}`);
      if (!existing.ok && !isAbsent(existing)) return undetermined(`log metric ${spec.metric}`, existing);
      if (existing.ok) {
        if (verify) {
          if (existing.data.filter !== metricFilter) return fail(`metric ${spec.metric} exists but its filter has drifted:\n  ${existing.data.filter}`);
          // A DISABLED metric generates no points — every green field above
          // with this flag set is a dead alarm wearing a tick.
          if (existing.data.disabled === true) return fail(`metric ${spec.metric} exists but is DISABLED — no log line can ever open an incident`);
          return log(`✓ log metric ${spec.metric}`);
        }
        const upd = await api(`${base}/${spec.metric}`, { method: "PUT", body });
        if (!upd.ok) return fail(`could not update metric: ${JSON.stringify(upd.data)}`);
        return log(`✓ log metric ${spec.metric} (updated)`);
      }
      if (verify) return fail(`log metric ${spec.metric} does not exist — run this script without --verify`);
      const made = await api(base, { method: "POST", body });
      if (!made.ok) return fail(`could not create metric: ${JSON.stringify(made.data)}`);
      log(`✓ log metric ${spec.metric} (created)`);
    })();

    // ── 3. the alert policy ──────────────────────────────────────────────────
    await (async () => {
      const base = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`;
      const want = buildPolicy({ ...spec, channelName: channel.name });
      const list = await listAll(base, "alertPolicies");
      if (!list.ok) return fail(`could not list alert policies: ${JSON.stringify(list.res.data)}`);
      const found = list.items.find((p) => p.displayName === spec.policyName);
      if (found) {
        if (verify) {
          const drift = policyDrift(found, want);
          if (drift.length) return fail(`alert policy "${spec.policyName}" has drifted:\n    ${drift.join("\n    ")}`);
          return log(`✓ alert policy "${spec.policyName}"`);
        }
        const upd = await api(`https://monitoring.googleapis.com/v3/${found.name}`, { method: "PATCH", body: want });
        if (!upd.ok) return fail(`could not update the alert policy: ${JSON.stringify(upd.data)}`);
        return log(`✓ alert policy "${spec.policyName}" (updated)`);
      }
      if (verify) return fail(`alert policy "${spec.policyName}" does not exist`);
      const made = await api(base, { method: "POST", body: want });
      if (!made.ok) return fail(`could not create the alert policy: ${JSON.stringify(made.data)}`);
      log(`✓ alert policy "${spec.policyName}" (created)`);
    })();
  }

  // ── 4. the pin ─────────────────────────────────────────────────────────────
  // The one check that cannot be done from the API: does the code still EMIT
  // the string the policy matches? Renaming the marker without re-running the
  // installer disconnects the alarm while every green check stays green.
  try {
    const src = readFileSync(spec.sourceFile, "utf8");
    if (!src.includes(spec.markerPin)) {
      fail(`${spec.sourceFile.pathname || spec.sourceFile} no longer emits the ${spec.marker} marker the alert policy matches`);
    } else {
      log(`✓ the source still emits the ${spec.marker} marker`);
    }
  } catch (err) {
    fail(`could not read the source to pin the marker: ${err.message}`);
  }

  // ── 5. the optional live test ──────────────────────────────────────────────
  if (test) {
    // Written straight to Cloud Logging under the same resource the real one
    // uses, so this exercises the metric, the policy and the email — the whole
    // chain — without waiting for a genuinely bad day.
    const res = await api(`https://logging.googleapis.com/v2/entries:write`, {
      method: "POST",
      body: {
        logName: `projects/${PROJECT}/logs/run.googleapis.com%2Fstderr`,
        resource: { type: "cloud_run_revision", labels: {
          service_name: spec.service, project_id: PROJECT, location: "europe-west1",
          // The full label set the resource type declares — an entries:write
          // with missing labels can be refused as invalid. The metric filter
          // only reads service_name; these two just make the entry legal.
          revision_name: "manual-test", configuration_name: spec.service,
        } },
        entries: [{ severity: "ERROR", textPayload: spec.testLine }],
      },
    });
    if (!res.ok) fail(`could not write the test log entry: ${JSON.stringify(res.data)}`);
    else log("✓ test alarm written to Cloud Logging — the email follows within a few minutes");
  }

  return !failed;
}
