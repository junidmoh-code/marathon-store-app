// ─── "WRITTEN OFF AFTER REFUSAL" — THE DAILY DIGEST TO JUNID ─────────────────
//
// The scan (functions/lib/refusal-writeoff.cjs) queues every write-off it makes
// at /refill_engine/refusalWriteoffDigestQueue/{id}. Once a day this module
// reads that queue (small: only what is new since the last digest), builds one
// plain-English digest, and hands it to every CHANNEL. When at least one
// channel has delivered, the digest is archived at
// /refill_engine/refusalWriteoffDigests/{date} and the queue entries it carried
// are removed. A day with nothing new sends nothing.
//
// CHANNELS ARE THE ONLY EXTENSION POINT. A channel is
//
//     { name: "email", deliver: async (digest) => ({ ok: true, detail? }) }
//
// and the engine never knows they exist. The email channel is the existing
// report path: a log line with a fixed marker, which a Cloud Monitoring
// log-match policy turns into an email to Junid carrying the digest text
// (scripts/refill/install-writeoff-digest-alarm.mjs — the same Google-operated
// route as the card-recon and social alarms). A WhatsApp channel is added later
// by writing one more object with the same shape — e.g. enqueueing to
// whatsapp_outbox — and listing it in CHANNELS in functions/index.js. Nothing
// here, in the scan, or in the engine changes.

"use strict";

const MARKER = "REFUSAL_WRITEOFF_DIGEST";
const QUEUE = "refill_engine/refusalWriteoffDigestQueue";
const RECORDS = "refill_engine/refusalWriteoffs";
const ARCHIVE = "refill_engine/refusalWriteoffDigests";
// A log-match label value is bounded; keep the emailed line inside it. The full
// list is always on the Health card and in the archive.
const EMAIL_MAX_CHARS = 1000;

const LABEL = { hub1: "Hub 1", hub2: "Hub 2", central: "Central", "marathon-pe": "Marathon PE", trophy: "Trophy" };
const L = (l) => LABEL[l] || l || "?";
const shortDay = (d) => {
  const [, m, day] = String(d || "").split("-");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return m ? `${Number(day)} ${MON[Number(m) - 1]}` : String(d || "");
};
const refuserOf = (r) => r.byName || (r.byRole ? `${r.byRole} account` : null);

function sastDate(ms) {
  return new Date(ms + 2 * 3600e3).toISOString().slice(0, 10);
}

// One line per write-off, e.g.
//   Nike Tech Fleece Tracksuit Brown 2 · M · Hub 2 · 3 units · refused 12, 14, 16, 17 Sep (Hub 2 staff, no name recorded)
function lineFor(r) {
  const names = [...new Set((r.refusals || []).map(refuserOf).filter(Boolean))];
  const days = (r.days || []).map(shortDay).join(", ");
  const size = r.size && r.size !== "_" && r.size !== "Free Size" ? r.size : "one size";
  return `${r.productName || r.pid} · ${size} · ${L(r.loc)} · ${r.qty} unit${r.qty === 1 ? "" : "s"} · refused ${days}`
    + ` (${names.length ? `by ${names.join(", ")}` : `${L(r.loc)} staff, no name recorded`})`;
}

function buildDigest(records, { nowMs }) {
  const list = [...records].sort((a, b) => (a.loc || "").localeCompare(b.loc || "") || (a.productName || "").localeCompare(b.productName || ""));
  const perLocation = {};
  let units = 0;
  for (const r of list) {
    const p = (perLocation[L(r.loc)] ||= { sizes: 0, units: 0 });
    p.sizes++; p.units += Number(r.qty) || 0; units += Number(r.qty) || 0;
  }
  const head = `${list.length} size${list.length === 1 ? "" : "s"} / ${units} unit${units === 1 ? "" : "s"} written off after four refused days — `
    + Object.entries(perLocation).map(([l, p]) => `${l}: ${p.sizes} (${p.units}u)`).join(", ");
  const lines = list.map(lineFor);
  // The emailed line: the headline, then as many items as fit, then a pointer.
  let summary = `${head}.`;
  let shown = 0;
  for (const ln of lines) {
    const next = `${summary} | ${ln}`;
    const tail = ` | +${lines.length - shown - 1} more on Health → Written off after refusal`;
    if (next.length + (shown + 1 < lines.length ? tail.length : 0) > EMAIL_MAX_CHARS) break;
    summary = next; shown++;
  }
  if (shown < lines.length) summary += ` | +${lines.length - shown} more on Health → Written off after refusal`;
  return {
    date: sastDate(nowMs), count: list.length, units, perLocation,
    ids: list.map((r) => r.id), lines, summary: summary.replace(/[\r\n]+/g, " "),
    text: [head, "", ...lines].join("\n"),
  };
}

// The email channel: ONE log line carrying the marker. The Monitoring policy
// extracts everything after the marker into the email.
function emailViaAlertLog(log = console.error) {
  return {
    name: "email",
    deliver: async (digest) => {
      log(`${MARKER} ${digest.summary}`);
      return { ok: true, detail: "logged" };
    },
  };
}

// ─── DID THE EMAIL LEAVE GOOGLE? (2026-09-23) ──────────────────────────────────
// The 23 Sep digest was logged as "sent" and never reached Junid. "Sent" only
// ever meant "the marker line was logged" — every hop after that (the log-match
// policy, the alert, the email) was invisible to us. Google publishes NO inbox
// receipt for Monitoring email (no delivery, bounce or spam record in any API),
// so what CAN be proven is checked and recorded instead:
//   1. the policy exists, is enabled, and its email channel is enabled and
//      addressed to Junid;
//   2. Google raised an alert on that policy for THIS digest (Alerts API: an
//      alert opened after the send whose extracted label is this summary).
// The best verdict is therefore "alert_raised" — NOT "delivered": on 23 Sep
// the alert WAS raised and the email still never arrived (second review,
// #644). Everything short of that is named: not_sent (red) or unchecked.
// The verdict is stored on the archived digest and at STATUS, and the
// "Written off after refusal" card shows it — red when the email did not
// leave, instead of failing silently.
const STATUS = "refill_engine/refusalWriteoffDigestStatus";
const POLICY_NAME = "Written off after refusal — daily digest";
const RECIPIENT = "junidmoh@gmail.com";

// Pure: the verdict from what the Monitoring API answered.
//   policy   the alert policy (or null)       channel  its email channel (or null)
//   alerts   alerts on the policy             digest   { summary }   sentAtMs
function judgeDelivery({ policy, channel, alerts, digest, sentAtMs, recipient = RECIPIENT }) {
  if (!policy) return { state: "not_sent", why: "the email alert policy is missing" };
  if (policy.enabled === false) return { state: "not_sent", why: "the email alert policy is switched off" };
  if (!channel) return { state: "not_sent", why: "the alert policy has no email channel" };
  if (channel.enabled === false) return { state: "not_sent", why: "the email channel is switched off" };
  const to = channel.labels?.email_address || null;
  if (to !== recipient) return { state: "not_sent", why: `the email channel sends to ${to || "nobody"}, not ${recipient}`, to };
  const head = String(digest?.summary || "").trim().slice(0, 200);
  const hit = (alerts || []).find((a) => Date.parse(a?.openTime || "") >= sentAtMs - 60e3
    && String(a?.log?.extractedLabels?.digest || "").trim().slice(0, 200) === head);
  if (hit) return { state: "alert_raised", to, alert: hit.name, alertRaisedAt: hit.openTime };
  // An EARLIER alert on this policy still open (autoClose is 30 min): Google
  // may fold this digest into it rather than raise — and email — a new one.
  // That is not proof of failure, so it is not reported red. (Sonnet, #644)
  const stillOpen = (alerts || []).find((a) => a?.state === "OPEN" && Date.parse(a?.openTime || "") < sentAtMs - 60e3);
  if (stillOpen) return { state: "unchecked", why: `an earlier digest alert (${stillOpen.openTime}) was still open, so Google may have folded this one into it`, to };
  return { state: "not_sent", why: "Google raised no alert for this digest, so no email left", to };
}

// The Monitoring REST API with the function's own identity (metadata server
// token — no library, no key). Injected into confirmDelivery so tests fake it.
function monitoringApi({ project = "marathon-club", fetchImpl = globalThis.fetch, callTimeoutMs = 20e3 } = {}) {
  // Every call is bounded, so a hung request can never outlive the function
  // and leave the run unrecorded (Sonnet, #644).
  const bounded = (url, opts) => fetchImpl(url, { ...opts, signal: AbortSignal.timeout(callTimeoutMs) });
  let token = null;
  const auth = async () => {
    if (token) return token;
    const r = await bounded("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } });
    if (!r.ok) throw new Error(`metadata token HTTP ${r.status}`);
    token = (await r.json()).access_token;
    return token;
  };
  const get = async (url) => {
    const r = await bounded(url, { headers: { Authorization: `Bearer ${await auth()}` } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${url.split("?")[0].split("/v3/")[1]} HTTP ${r.status}: ${body?.error?.message || ""}`.slice(0, 300));
    return body;
  };
  const base = `https://monitoring.googleapis.com/v3/projects/${project}`;
  return {
    policies: async () => (await get(`${base}/alertPolicies?pageSize=200`)).alertPolicies || [],
    channel: async (name) => get(`https://monitoring.googleapis.com/v3/${name}`),
    // Newest first, explicitly (the API's default happens to be the same;
    // verified live 2026-09-23 — it accepts orderBy but no open_time filter).
    alerts: async (policyName) => (await get(`${base}/alerts?pageSize=20&orderBy=${encodeURIComponent("open_time desc")}&filter=${encodeURIComponent(`policy.name="${policyName}"`)}`)).alerts || [],
  };
}

// Poll until Google has raised the alert (it took 63 s on 23 Sep) or give up.
async function confirmDelivery({ api, digest, sentAtMs, waitMs = 240e3, everyMs = 20e3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = Date.now }) {
  try {
    const policy = (await api.policies()).find((p) => p.displayName === POLICY_NAME) || null;
    const chName = policy?.notificationChannels?.[0] || null;
    const channel = chName ? await api.channel(chName) : null;
    const deadline = clock() + waitMs;
    for (;;) {
      const alerts = policy ? await api.alerts(policy.name) : [];
      const v = judgeDelivery({ policy, channel, alerts, digest, sentAtMs });
      if (v.state === "alert_raised" || !policy || !channel || v.to !== RECIPIENT || channel.enabled === false || policy.enabled === false || clock() >= deadline) {
        return { ...v, checkedAtMs: clock() };
      }
      await sleep(everyMs);
    }
  } catch (e) {
    return { state: "unchecked", why: `could not ask Google whether the email left: ${String(e?.message || e)}`.slice(0, 300), checkedAtMs: clock() };
  }
}

// One small node the card reads: the last run, whatever happened.
async function recordStatus(db, status) {
  await db.ref(STATUS).set(status);
}

async function runDigest({ db, nowMs, channels }) {
  const queue = (await db.ref(QUEUE).once("value")).val() || {};
  const ids = Object.keys(queue);
  if (!ids.length) return { sent: false, reason: "nothing_new" };
  const records = [];
  const missing = [];
  for (const id of ids) {
    const r = (await db.ref(`${RECORDS}/${id}`).once("value")).val();
    if (r) records.push({ ...r, id }); else missing.push(id);
  }
  const clearMissing = Object.fromEntries(missing.map((id) => [`${QUEUE}/${id}`, null]));
  if (!records.length) {
    if (missing.length) await db.ref().update(clearMissing);
    return { sent: false, reason: "no_records" };
  }
  const digest = buildDigest(records, { nowMs });
  const results = {};
  for (const ch of channels || []) {
    try { results[ch.name] = await ch.deliver(digest); } catch (e) { results[ch.name] = { ok: false, detail: String(e?.message || e) }; }
  }
  const delivered = Object.values(results).some((r) => r && r.ok);
  if (!delivered) return { sent: false, reason: "no_channel_delivered", results };
  const patch = { ...clearMissing };
  for (const id of digest.ids) patch[`${QUEUE}/${id}`] = null;
  // Keyed by date + time so a second digest on one day (a manual re-run) never overwrites the first.
  patch[`${ARCHIVE}/${digest.date}_${nowMs}`] = {
    sentAtMs: nowMs, date: digest.date, count: digest.count, units: digest.units, ids: digest.ids, text: digest.text,
    channels: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ok: !!v?.ok, detail: v?.detail || null }])),
  };
  await db.ref().update(patch);
  return { sent: true, digest, results, archiveKey: `${digest.date}_${nowMs}` };
}

// The whole scheduled run: digest → ask Google → record the verdict. The
// function in index.js only wires the real db and API into this (so this, the
// real entry point, is what the tests drive). A run that throws is recorded
// before it rethrows, so a crash shows on the card too.
async function runDigestAndConfirm({ db, nowMs, channels, api, confirm = confirmDelivery, log = console.log, warn = console.error }) {
  let res;
  try {
    res = await runDigest({ db, nowMs, channels });
  } catch (e) {
    await recordStatus(db, { atMs: nowMs, outcome: "error", why: String(e?.message || e).slice(0, 300) }).catch(() => {});
    throw e;
  }
  if (!res.sent) {
    await recordStatus(db, { atMs: nowMs, outcome: res.reason });
    log(`refusalWriteoffDigest: ${res.reason}`);
    return { ...res };
  }
  // "checking" first: if the run is cut off mid-check, the card shows a check
  // that never finished — never yesterday's verdict (second review, #644).
  const base = { atMs: nowMs, outcome: "sent", count: res.digest.count, units: res.digest.units, archiveKey: res.archiveKey };
  await recordStatus(db, { ...base, delivery: { state: "checking" } });
  const delivery = await confirm({ api, digest: res.digest, sentAtMs: nowMs });
  await db.ref().update({ [`${ARCHIVE}/${res.archiveKey}/delivery`]: delivery });
  await recordStatus(db, { ...base, delivery });
  const line = `refusalWriteoffDigest: ${res.digest.count} write-off(s) — email ${delivery.state}${delivery.why ? ` (${delivery.why})` : ""}`;
  (delivery.state === "alert_raised" ? log : warn)(line);
  return { ...res, delivery };
}

module.exports = {
  buildDigest, runDigest, runDigestAndConfirm, emailViaAlertLog, lineFor, judgeDelivery, monitoringApi, confirmDelivery, recordStatus,
  MARKER, QUEUE, RECORDS, ARCHIVE, STATUS, POLICY_NAME, RECIPIENT, EMAIL_MAX_CHARS,
};
