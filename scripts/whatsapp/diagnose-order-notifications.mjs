// ─── "ARE CUSTOMER WHATSAPPS GOING OUT?" — one read-only answer ──────────────
//
// Written during the 26 Sep 2026 report that order notifications had stopped.
// It runs the same checks that answered that report, in the same order:
//
//   1. OUTBOX — the newest N whatsapp_outbox docs (ONE ordered, limited query;
//      never the whole collection): status, Meta code, reason, timestamps, and
//      the time of the last successful send.
//   2. FUNCTIONS — did anything in the window get refused by GCP ("billing is
//      disabled", "no available instance")? Per service, first/last seen.
//   3. META — the registered number (which one, CONNECTED?, quality), the
//      health_status entities (payment/verification blocks surface here), the
//      templates' approval, and daily sent/delivered for the last week.
//
// Then it prints a classification: GCP outage / Meta refusing / number or
// token / no failure found. It changes NOTHING and sends NOTHING.
//
//   ACCESS_TOKEN=$(…owner cloud-platform token…) node scripts/whatsapp/diagnose-order-notifications.mjs [--hours 6] [--limit 50]
//
// The Meta token is read from Secret Manager (meta-whatsapp-token) with the
// same access token; it is never printed.

const PROJECT = "marathon-club";
const WA_PHONE_ID = "1100352259829109";   // functions/index.js WA_PHONE_ID — the only number order messages use
const WABA_ID = "1625835505311366";
const GRAPH = "https://graph.facebook.com/v21.0";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const HOURS = arg("hours", 6);
const LIMIT = Math.min(arg("limit", 50), 200);

const TOKEN = process.env.ACCESS_TOKEN;
if (!TOKEN) {
  console.error("Set ACCESS_TOKEN to an owner OAuth access token with cloud-platform scope.");
  process.exit(2);
}

async function google(url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, "x-goog-user-project": PROJECT, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url.split("?")[0]} → HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const fsValue = (f) => (f == null ? null : Object.values(f)[0]);
const sast = (iso) => (iso ? new Date(new Date(iso).getTime() + 2 * 3600e3).toISOString().slice(5, 16).replace("T", " ") + " SAST" : "—");

// ── 1. OUTBOX ────────────────────────────────────────────────────────────────
async function outbox() {
  const rows = await google(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
    { structuredQuery: { from: [{ collectionId: "whatsapp_outbox" }], orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }], limit: LIMIT } },
  );
  const docs = rows.filter((r) => r.document).map((r) => {
    const f = r.document.fields;
    return {
      id: r.document.name.split("/").pop(),
      createdAt: fsValue(f.createdAt), sentAt: fsValue(f.sentAt), status: fsValue(f.status),
      template: fsValue(f.templateName), attempts: fsValue(f.attempts),
      metaCode: fsValue(f.lastMetaCode), reason: fsValue(f.lastFailureReason), error: fsValue(f.lastError),
    };
  });
  console.log(`\n1. OUTBOX — newest ${docs.length} docs`);
  const counts = {};
  for (const d of docs) counts[d.status] = (counts[d.status] || 0) + 1;
  console.log("   by status:", JSON.stringify(counts));
  for (const d of docs.slice(0, 15)) {
    console.log(`   ${sast(d.createdAt)}  ${String(d.status).padEnd(8)} ${String(d.template).padEnd(18)} ${d.metaCode != null ? `code ${d.metaCode} ` : ""}${d.status !== "sent" && d.error ? String(d.error).slice(0, 80) : ""}`);
  }
  const lastSent = docs.find((d) => d.status === "sent");
  console.log(`   last successful send: ${lastSent ? sast(lastSent.sentAt) : "none in this window"}`);
  // Gaps over an hour between consecutive docs — a quiet shop, or an outage.
  for (let i = 0; i + 1 < docs.length; i++) {
    const gap = (new Date(docs[i].createdAt) - new Date(docs[i + 1].createdAt)) / 60e3;
    if (gap > 60) console.log(`   gap: nothing enqueued ${sast(docs[i + 1].createdAt)} → ${sast(docs[i].createdAt)} (${Math.round(gap)} min)`);
  }
  return docs;
}

// ── 2. FUNCTIONS ─────────────────────────────────────────────────────────────
async function refusals() {
  const since = new Date(Date.now() - HOURS * 3600e3).toISOString();
  const filter = `timestamp>="${since}" AND (textPayload:"billing is disabled" OR textPayload:"no available instance")`;
  const seen = {};
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const data = await google("https://logging.googleapis.com/v2/entries:list", {
      resourceNames: [`projects/${PROJECT}`], filter, orderBy: "timestamp asc", pageSize: 500, pageToken,
    });
    for (const e of data.entries || []) {
      const key = `${e.resource?.labels?.service_name || e.resource?.type} · ${/billing/.test(e.textPayload) ? "billing disabled" : "no instance"}`;
      const s = (seen[key] ||= { n: 0, first: e.timestamp, last: e.timestamp });
      s.n++; s.last = e.timestamp;
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  console.log(`\n2. FUNCTIONS — GCP refusals in the last ${HOURS}h`);
  const keys = Object.keys(seen).sort();
  if (!keys.length) console.log("   none");
  for (const k of keys) console.log(`   ${k}: ${seen[k].n}× ${sast(seen[k].first)} → ${sast(seen[k].last)}`);
  return keys;
}

// ── 3. META ──────────────────────────────────────────────────────────────────
async function meta() {
  const secret = await google(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/meta-whatsapp-token/versions/latest:access`);
  const token = Buffer.from(secret.payload.data, "base64").toString("utf8").trim();
  const graph = async (path) => {
    const res = await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
    return res.json();
  };
  console.log("\n3. META");
  const num = await graph(`${WA_PHONE_ID}?fields=display_phone_number,verified_name,status,quality_rating,platform_type,account_mode,health_status`);
  if (num.error) {
    console.log(`   phone number lookup REFUSED: (#${num.error.code}) ${num.error.message}`);
    return { tokenBad: num.error.code === 190 || num.error.code === 0, numberBad: true };
  }
  console.log(`   number: ${num.display_phone_number} "${num.verified_name}" status=${num.status} quality=${num.quality_rating} ${num.platform_type} ${num.account_mode}`);
  const blocks = [];
  for (const e of num.health_status?.entities || []) {
    const errs = (e.errors || []).map((x) => `${x.error_code} ${x.error_description}`).join("; ");
    console.log(`   health ${e.entity_type.padEnd(12)} can_send=${e.can_send_message}${errs ? `  (${errs})` : ""}`);
    if (e.can_send_message === "BLOCKED") blocks.push(`${e.entity_type}: ${errs}`);
  }
  const tpl = await graph(`${WABA_ID}/message_templates?fields=name,status&limit=100`);
  const notApproved = (tpl.data || []).filter((t) => t.status !== "APPROVED");
  console.log(`   templates: ${(tpl.data || []).map((t) => `${t.name}=${t.status}`).join(", ") || JSON.stringify(tpl.error || tpl)}`);
  const start = Math.floor(Date.now() / 1000) - 7 * 86400;
  const an = await graph(`${WABA_ID}?fields=analytics.start(${start}).end(${Math.floor(Date.now() / 1000)}).granularity(DAY)`);
  for (const p of an.analytics?.data_points || []) {
    console.log(`   ${new Date(p.start * 1000).toISOString().slice(5, 10)} sent ${p.sent} delivered ${p.delivered}`);
  }
  return { blocks, notApproved, connected: num.status === "CONNECTED" };
}

const docs = await outbox();
const refused = await refusals();
const m = await meta();

console.log("\nVERDICT");
const metaFailures = docs.filter((d) => d.status !== "sent" && (d.metaCode != null || d.error));
if (m.tokenBad) console.log("   • Meta token rejected — rotate meta-whatsapp-token.");
if (m.blocks?.length) console.log(`   • Meta BLOCKS sending: ${m.blocks.join(" | ")} — fix in WhatsApp Manager / Meta Business billing.`);
if (m.connected === false) console.log("   • The Meta number is not CONNECTED — re-register it in WhatsApp Manager.");
if (m.notApproved?.length) console.log(`   • Templates not approved: ${m.notApproved.map((t) => t.name).join(", ")}`);
if (metaFailures.length) console.log(`   • ${metaFailures.length} of the newest ${docs.length} outbox docs are not sent — see codes above.`);
if (refused.length) console.log("   • GCP refused functions in the window (above) — sends in that window never ran; check which orders changed then.");
if (m.numberBad && !m.tokenBad) console.log("   • Meta refused the phone-number lookup (above) — the number's state is UNKNOWN.");
// "Healthy" needs POSITIVE evidence: a refused lookup leaves connected
// undefined, which must never read as fine (CodeRabbit, PR #655).
if (!m.tokenBad && !m.numberBad && m.connected === true && !m.blocks?.length && !m.notApproved?.length
    && !metaFailures.length && !refused.length) {
  console.log("   • No failure found: Meta is healthy and every recent outbox doc was sent.");
}
