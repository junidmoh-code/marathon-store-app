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
  return { sent: true, digest, results };
}

module.exports = { buildDigest, runDigest, emailViaAlertLog, lineFor, MARKER, QUEUE, RECORDS, ARCHIVE, EMAIL_MAX_CHARS };
