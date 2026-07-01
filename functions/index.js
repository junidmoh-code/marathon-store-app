const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const { toAuthPassword, usernameToEmail } = require("./lib/auth-utils.cjs");
const reorderDemand = require("./lib/reorder-demand.cjs");

// Initialise the admin SDK once at module scope. Required for Phase 13A's
// analyzeReorderNeeds, which reads /products, /orders, /insights_log and writes
// to /aiAssistant/usage. The databaseURL must be explicit because the runtime
// project defaults don't include the regional RTDB host for this app.
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const WA_PHONE_ID = "1100352259829109";
const metaToken   = defineSecret("meta-whatsapp-token");

// ── Meta fallback sweep config ──────────────────────────────────────────────
// The self-hosted gateway is the primary sender; this fallback delivers via
// Meta only when the gateway hasn't sent a doc in time (e.g. the mini is down).
const META_FALLBACK_ENABLED  = process.env.META_FALLBACK_ENABLED !== "false";        // default true
const FALLBACK_GRACE_SECONDS = parseInt(process.env.FALLBACK_GRACE_SECONDS, 10) || 60; // gateway's head start
const META_MAX_ATTEMPTS      = parseInt(process.env.META_MAX_ATTEMPTS, 10) || 2;       // Meta tries before "failed"

// Set CORS headers on every response — must happen before any early return.
function setCORSHeaders(res) {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

// Normalise a South African number to E.164: +27XXXXXXXXX
function normaliseSAPhone(raw) {
  let digits = (raw || "").replace(/[^\d]/g, "");
  if (digits.startsWith("0"))   digits = "27" + digits.slice(1);
  if (!digits.startsWith("27")) digits = "27" + digits;
  return "+" + digits;
}

// Approved WhatsApp templates: the exact Meta body text plus the number of
// params each expects. renderedText (built here) is what the self-hosted
// gateway sends as free text — the primary path now; templateName + variables
// are still stored for the Meta fallback. {{n}} maps to templateParams[n-1].
// NOTE: the out-of-stock template is genuinely named "rder_out_of_stock" in
// Meta (typo baked in) — keep it.
const TEMPLATE_BODIES = {
  order_placed:      { params: 4, render: (p) => `Hi ${p[0]}! Your order #${p[1]} has been placed. ${p[2]} Size ${p[3]}. We'll notify you when it's ready! 👟` },
  order_ready:       { params: 2, render: (p) => `Hi ${p[0]}, your order #${p[1]} is ready to collect at Marathon Club. See you soon!` },
  rder_out_of_stock: { params: 1, render: (p) => `Sorry, #${p[0]} is out of stock. Please speak to our assistant 😔` },
  order_tomorrow:    { params: 1, render: (p) => `Your Marathon order ${p[0]} is scheduled for tomorrow. We will notify you when it is ready for collection.` },
};

// Mask a phone number for logging — keep only the last 4 digits, never the full
// number (PII).
function maskPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

// Validate the template + param arity, then render the message. Returns
// { ok: true, text } on success, or { ok: false, error } when the template is
// unknown or the param count is wrong — callers must NOT send on failure. We
// deliberately fail loudly rather than render a generic fallback, so a caller
// bug can't ship a broken ("undefined") message to a customer.
function renderWhatsAppText(templateName, params = []) {
  const entry = TEMPLATE_BODIES[templateName];
  if (!entry) {
    return { ok: false, error: `Unknown templateName "${templateName}"` };
  }
  if (params.length !== entry.params) {
    return { ok: false, error: `Template "${templateName}" expects ${entry.params} param(s) but got ${params.length}` };
  }
  return { ok: true, text: entry.render(params.map(String)) };
}

// Send a WhatsApp template via the Meta Graph API. This is the fallback send
// path, driven by metaFallbackSweep when the self-hosted gateway hasn't
// delivered an outbox doc in time. `to` must already be E.164-normalized (the
// producer stores it that way). Returns { ok: true, messageId } on success, or
// { ok: false, error, metaCode } on failure — it never throws for Meta errors,
// so the caller can decide whether to retry or fail the doc.
// NOTE: token handling (metaToken secret + hardcoded WA_PHONE_ID) is unchanged;
// moving the token to Secret Manager properly is a separate follow-up.
async function sendViaMetaTemplate(to, templateName, templateParams = []) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      components: templateParams.length
        ? [{ type: "body", parameters: templateParams.map(p => ({ type: "text", text: String(p) })) }]
        : [],
    },
  };

  console.log("Meta API payload:", JSON.stringify({ ...payload, to: maskPhone(to) }));

  let waRes, json;
  try {
    waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${metaToken.value()}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(payload),
    });
    json = await waRes.json();
  } catch (err) {
    return { ok: false, error: `Could not reach WhatsApp API: ${err.message}` };
  }

  if (!waRes.ok) {
    const metaCode    = json?.error?.code;
    const metaMessage = json?.error?.message || "WhatsApp API call failed";
    if (metaCode === 190) {
      console.error("TOKEN EXPIRED — rotate Meta token in Business Manager, then: gcloud secrets versions add meta-whatsapp-token --data-file=<file> --project=marathon-club && firebase deploy --only functions");
    }
    return { ok: false, error: metaMessage, metaCode };
  }

  const messageId = json.messages?.[0]?.id ?? null;
  return { ok: true, messageId };
}

// Primary send path: enqueue a doc to the whatsapp_outbox collection (default
// database) for the self-hosted gateway to consume. Same request contract as
// before ({ templateName, recipientPhone, templateParams }) so callers are
// unchanged — this no longer calls Meta directly.
async function handlePost(req, res) {
  const body = req.body || {};
  const { templateName, recipientPhone, templateParams = [] } = body;

  console.log("sendWhatsApp enqueue:", JSON.stringify({
    templateName,
    recipient:  maskPhone(recipientPhone),
    paramCount: templateParams.length,
  }));

  if (!templateName || !recipientPhone) {
    console.warn("Missing required fields:", { templateName, recipientPhone: maskPhone(recipientPhone) });
    return res.status(400).json({ error: "templateName and recipientPhone are required" });
  }

  // Strict validation: reject unknown templates or wrong param counts rather
  // than rendering a generic fallback — a caller bug should fail loudly, not
  // ship a customer a broken message.
  const rendered = renderWhatsAppText(templateName, templateParams);
  if (!rendered.ok) {
    console.error("sendWhatsApp rejected invalid template request:", JSON.stringify({
      templateName,
      paramCount: templateParams.length,
      error:      rendered.error,
    }));
    return res.status(400).json({ error: rendered.error });
  }

  const to           = normaliseSAPhone(recipientPhone);
  const renderedText = rendered.text;

  // Server-side dedupe: the frontend sendWhatsAppTemplate is fire-and-forget
  // with no double-tap guard, so an accidental double-tap can fire two
  // identical requests. Look for an identical message enqueued in the last 90s
  // and reuse it instead of creating a duplicate. We filter ONLY on createdAt
  // (single-field, auto-indexed) and match to/templateName/renderedText/status
  // in memory — a composite where() would require a manual index.
  const DEDUPE_WINDOW_MS = 90 * 1000;
  const ACTIVE_STATUSES  = ["pending", "sending", "sent"];
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - DEDUPE_WINDOW_MS);
    const recent = await admin.firestore()
      .collection("whatsapp_outbox")
      .where("createdAt", ">=", cutoff)
      .get();
    const dup = recent.docs.find((d) => {
      const x = d.data();
      return x.to === to
        && x.templateName === templateName
        && x.renderedText === renderedText
        && ACTIVE_STATUSES.includes(x.status);
    });
    if (dup) {
      const status = dup.data().status;
      console.log("sendWhatsApp deduped:", JSON.stringify({
        templateName,
        recipient: maskPhone(to),
        outboxId:  dup.id,
        status,
      }));
      return res.json({ success: true, outboxId: dup.id, status, deduped: true });
    }
  } catch (err) {
    // Never drop a real message because the lookup failed — log and fall
    // through to creating the doc.
    console.warn("sendWhatsApp dedupe lookup failed; proceeding to enqueue:", err.message);
  }

  const outboxDoc = {
    to,
    renderedText,
    templateName,
    variables:  templateParams,
    status:     "pending",
    provider:   null,
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    sentAt:     null,
    messageId:  null,
    attempts:   0,
    lastError:  null,
  };

  try {
    const ref = await admin.firestore().collection("whatsapp_outbox").add(outboxDoc);
    console.log("WhatsApp enqueued:", JSON.stringify({ templateName, recipient: maskPhone(to), outboxId: ref.id }));
    return res.json({ success: true, outboxId: ref.id, status: "pending" });
  } catch (err) {
    console.error("Failed to enqueue WhatsApp outbox doc:", err.message);
    return res.status(500).json({ error: "Could not enqueue WhatsApp message", detail: err.message });
  }
}

exports.sendWhatsApp = onRequest(
  { region: "europe-west1", secrets: [metaToken] },
  (req, res) => {
    // Stamp CORS headers on every response — OPTIONS, errors, and success alike.
    setCORSHeaders(res);

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Max-Age", "3600");
      return res.status(204).send("");
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Wrap in try/catch so an unexpected throw still gets CORS headers.
    handlePost(req, res).catch(err => {
      console.error("sendWhatsApp unhandled error:", err.stack || err.message);
      res.status(500).json({ error: err.message || "Internal server error" });
    });
  }
);

// Claim a single stale outbox doc and deliver it via Meta. The claim is a
// Firestore transaction acting as a mutex against the gateway: it proceeds only
// if the doc is still "pending", so we can never double-send a doc the gateway
// already grabbed. Resolves quietly (no throw) so one bad doc can't abort the sweep.
async function processFallbackDoc(db, docRef, docId) {
  let claimed;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return null;
      const data = snap.data();
      if (data.status !== "pending") return null;   // gateway grabbed it (or it failed) — skip
      const attempts = (data.attempts || 0) + 1;
      tx.update(docRef, {
        status:    "sending",
        provider:  "meta",
        attempts,
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ...data, attempts };
    });
  } catch (err) {
    console.error("metaFallbackSweep claim failed:", JSON.stringify({ docId, error: err.message }));
    return;
  }
  if (!claimed) return;  // no longer pending — the gateway won the race

  const to           = claimed.to;
  const templateName = claimed.templateName;
  const templateParams = claimed.variables || claimed.templateParams || [];

  const result = await sendViaMetaTemplate(to, templateName, templateParams);

  if (result.ok) {
    await docRef.update({
      status:    "sent",
      provider:  "meta",
      sentAt:    admin.firestore.FieldValue.serverTimestamp(),
      messageId: result.messageId,
    });
    console.log("metaFallbackSweep meta-send:", JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "sent", messageId: result.messageId,
    }));
    return;
  }

  // Meta send failed. The fallback is the last resort, so it's the only path
  // that ever sets "failed" — but only once we've exhausted META_MAX_ATTEMPTS.
  if (claimed.attempts >= META_MAX_ATTEMPTS) {
    await docRef.update({
      status:    "failed",
      lastError: result.error || "Meta send failed",
    });
    console.error("metaFallbackSweep meta-send:", JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "failed",
      attempts: claimed.attempts, error: result.error,
    }));
  } else {
    // Revert to pending so a later sweep retries — or the gateway sends it if
    // it recovers. Clearing provider hands it back to whoever claims next.
    await docRef.update({
      status:    "pending",
      provider:  null,
      lastError: result.error || "Meta send failed",
    });
    console.warn("metaFallbackSweep meta-send:", JSON.stringify({
      docId, recipient: maskPhone(to), templateName, outcome: "retry",
      attempts: claimed.attempts, error: result.error,
    }));
  }
}

// Scheduled Meta fallback for the WhatsApp outbox. Runs every minute and
// delivers via Meta any "pending" doc the gateway hasn't sent within the grace
// window. Equality-only query (no composite index); age is filtered in memory.
exports.metaFallbackSweep = onSchedule(
  {
    schedule:       "every 1 minutes",
    region:         "europe-west1",
    timeoutSeconds: 120,
    memory:         "256MiB",
    secrets:        [metaToken],
  },
  async () => {
    if (!META_FALLBACK_ENABLED) {
      console.log("metaFallbackSweep: disabled (META_FALLBACK_ENABLED=false)");
      return;
    }

    const db = admin.firestore();
    // 1. Equality-only query — no composite where() on createdAt (that would
    //    need a manual index). Cap the batch so one run stays bounded.
    const snap = await db.collection("whatsapp_outbox")
      .where("status", "==", "pending")
      .limit(50)
      .get();

    // 2. Filter age in memory so the gateway gets first dibs on fresh docs.
    const cutoffMs = Date.now() - FALLBACK_GRACE_SECONDS * 1000;
    const stale = snap.docs.filter((d) => {
      const ca = d.data().createdAt;
      // createdAt is a Firestore Timestamp; skip docs whose serverTimestamp
      // hasn't resolved yet (toMillis unavailable) — they're brand new anyway.
      return ca && typeof ca.toMillis === "function" && ca.toMillis() <= cutoffMs;
    });

    if (stale.length === 0) {
      console.log("metaFallbackSweep: nothing to do", { scanned: snap.size });
      return;
    }
    console.log("metaFallbackSweep: claiming stale pending docs", { stale: stale.length, scanned: snap.size });

    for (const docSnap of stale) {
      await processFallbackDoc(db, docSnap.ref, docSnap.id);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp broadcast proxy (Phase 1)
// ─────────────────────────────────────────────────────────────────────────────
// Two Gen 2 callable functions that act as an authenticated proxy between the
// PWA and the broadcast service VM at http://34.59.92.37.
//
//   getBroadcastGroups → GET  /api/groups     (list available WhatsApp groups)
//   sendBroadcast      → POST /api/broadcast  (send caption + media to groups)
//
// Only the admin (gunidmoh@gmail.com) may invoke these. The VM's bearer token
// is read from Secret Manager (secret name: broadcast-service-token) and is
// never logged, returned, or otherwise exposed to the caller.
// ─────────────────────────────────────────────────────────────────────────────

const broadcastToken   = defineSecret("broadcast-service-token");
const BROADCAST_VM_URL = "http://34.59.92.37";
const ADMIN_EMAIL      = "gunidmoh@gmail.com";

function assertAdmin(request) {
  if (request.auth?.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Admin only.");
  }
}

exports.getBroadcastGroups = onCall(
  { region: "us-central1", secrets: [broadcastToken] },
  async (request) => {
    assertAdmin(request);

    let res, body;
    try {
      res  = await fetch(`${BROADCAST_VM_URL}/api/groups`, {
        headers: { Authorization: `Bearer ${broadcastToken.value()}` },
      });
      body = await res.json();
    } catch (err) {
      console.error("getBroadcastGroups: VM unreachable:", err.message);
      throw new HttpsError("unavailable", "Broadcast service unreachable.");
    }

    if (!res.ok) {
      console.error("getBroadcastGroups: VM returned", res.status);
      throw new HttpsError("internal", `Broadcast service error (HTTP ${res.status}).`);
    }

    return body;
  }
);

exports.sendBroadcast = onCall(
  { region: "us-central1", secrets: [broadcastToken], timeoutSeconds: 540 },
  async (request) => {
    assertAdmin(request);

    const { groupIds, caption, mediaUrls } = request.data || {};

    if (!Array.isArray(groupIds) || groupIds.length === 0) {
      throw new HttpsError("invalid-argument", "groupIds must be a non-empty array.");
    }
    const hasCaption = typeof caption === "string" && caption.trim().length > 0;
    const hasMedia   = Array.isArray(mediaUrls) && mediaUrls.length > 0;
    if (!hasCaption && !hasMedia) {
      throw new HttpsError("invalid-argument", "Provide a caption, media, or both.");
    }

    console.log("sendBroadcast:", {
      groupCount:  groupIds.length,
      captionLen:  (caption || "").length,
      mediaCount:  (mediaUrls || []).length,
      by:          request.auth.token.email,
    });

    let res, body;
    try {
      res  = await fetch(`${BROADCAST_VM_URL}/api/broadcast`, {
        method:  "POST",
        headers: {
          Authorization:  `Bearer ${broadcastToken.value()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ groupIds, caption, mediaUrls }),
      });
      body = await res.json();
    } catch (err) {
      console.error("sendBroadcast: VM unreachable:", err.message);
      throw new HttpsError("unavailable", "Broadcast service unreachable.");
    }

    if (!res.ok) {
      console.error("sendBroadcast: VM returned", res.status);
      throw new HttpsError("internal", `Broadcast service error (HTTP ${res.status}).`);
    }

    return body;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AI Reorder Planner — backend (Phase 13A + Phase 1 UI prep)
// ─────────────────────────────────────────────────────────────────────────────
// analyzeReorderNeeds is a Gen 2 admin-only callable that produces a structured
// reorder plan and writes it to /insights/reorderPlan for the dashboard. Since
// Phase 3 it runs in one of two modes:
//
//   • DEMAND-DRIVEN (primary, pure reasoner) — the client sends
//     request.data.demand: TRUE DEMAND (sold + out-of-stock, per product AND per
//     size) pre-computed by marathon-ai's shared demand engine and slimmed by
//     buildReorderPayload. The function reasons over those aggregates and never
//     re-derives demand. No catalog cap, OOS counted in every quantity, cycle =
//     the real catalog window (demand.cycleDays). See lib/reorder-demand.cjs for
//     the input contract and buildDemandDrivenPlan above.
//   • LEGACY (fallback) — no `demand` supplied (cron / old client / unknown
//     schema). The function reads /products, /orders, /insights_log itself and
//     runs the old internal aggregation (aggregatePerProduct), capped at
//     REORDER_TOP_N. Kept only as a safety net during rollout.
//
// Shared by both modes:
//   1. Gate the call:
//      a) /insights/reorderPlan/status — reject if state === "running" within
//         REORDER_CONCURRENT_LOCK_MS (concurrent-run protection).
//      b) /insights/reorderPlan/latest — reject if generatedAt is within
//         REORDER_RATE_LIMIT_MS, unless the super-admin passes { force: true }.
//   2. Write state = "running" to /insights/reorderPlan/status so the UI can
//      reflect progress without holding the callable open for the full run.
//   3. Read the admin's businessContext memory and include it in the prompt.
//   4. Call Claude (strict JSON, one parse retry per call/batch).
//   5. persistReorderPlan → /insights/reorderPlan/latest (UI renders from cache,
//      survives the 70 s callable client-timeout: fire-and-forget + poll RTDB).
//   6. logReorderUsage → /aiAssistant/usage/{YYYY-MM-DD}/{pushKey}: token counts
//      + cost only, no API key, no prompt.
//   7. Write state = "idle" (or "error") to status in a finally block so the UI
//      is never left thinking a run is still active.
//
// The callable still returns { plan, meta } on success for the rare awaited
// caller — the UI doesn't await, but the contract is preserved.
//
// Sizing: heavy-compute, owner-triggered. 1 GiB memory and 900 s timeout cover
// batched demand reasoning / full-history aggregation for typical catalogs.
// ─────────────────────────────────────────────────────────────────────────────

const anthropicApiKey = defineSecret("anthropic-api-key");

// Model + sizing. Switched from Sonnet 4.6 to Haiku 4.5: the reorder analysis
// is structured-JSON output with a tight schema and clear instructions —
// exactly the workload Haiku handles well at ~3-5x the speed of Sonnet.
// Sonnet stays reserved for the chat interface (marathon-ai) where
// conversational quality matters. REORDER_TOP_N dropped from 200 to 50 per
// set (active + dormant) because output generation time is dominated by
// per-product reasoning, and the long tail beyond the top 50 produces
// recommendations the owner wouldn't action anyway. Combined effect: 4–5 min
// runs are expected to drop to ~20–25 s.
const REORDER_MODEL          = "claude-haiku-4-5";
const REORDER_MAX_TOKENS     = 24000;
const REORDER_CYCLE_DAYS     = 45;
const REORDER_RECENT_DAYS    = 60;
const REORDER_TOP_N          = 50;
const PRICE_INPUT_PER_MTOK   = 1;    // USD per 1M input tokens (Haiku 4.5)
const PRICE_OUTPUT_PER_MTOK  = 5;    // USD per 1M output tokens (Haiku 4.5)

// RTDB paths for the UI handshake. The UI reads from these so it can
// fire-and-forget the callable (the full run is ~5 min, well past the 70 s
// httpsCallable client timeout).
//   /insights/reorderPlan/status — { state, startedAt, startedBy, ... }
//   /insights/reorderPlan/latest — most recent successful { plan, meta }
const REORDER_STATUS_PATH = "insights/reorderPlan/status";
const REORDER_LATEST_PATH = "insights/reorderPlan/latest";

// Gating windows for the run.
//   CONCURRENT_LOCK_MS — how long a "running" status blocks a fresh start.
//   Set under the 900 s server timeout so a crashed or stuck run can be
//   retried without manual cleanup.
//   RATE_LIMIT_MS — minimum gap between fresh runs. Super-admin can bypass
//   with payload.force === true; non-super-admin force is ignored.
const REORDER_CONCURRENT_LOCK_MS = 15 * 60 * 1000;
const REORDER_RATE_LIMIT_MS      = 60 * 60 * 1000;

function isoToMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function saDateStringFromMs(ms) {
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Phase 14C: mirror src/App.jsx getProductHubs. Products may carry either the
// new `hubs: [...]` array or the legacy `hub` string; this helper unifies
// the two shapes so call sites stay agnostic. Used by buildProductPayload to
// pick the primary hub for the planner payload.
function getProductHubs(product) {
  if (product && Array.isArray(product.hubs) && product.hubs.length) return product.hubs;
  if (product && product.hub) return [product.hub];
  return [];
}

// Build a productName → product index so we can attach insights_log entries
// (which only carry productName) back to a real product record. Collisions
// are recorded so the model can be warned via dataQualityNotes.
function indexProductsByName(products) {
  const byName = new Map();
  const collisions = new Set();
  for (const p of products) {
    if (!p || !p.name) continue;
    if (byName.has(p.name)) collisions.add(p.name);
    else byName.set(p.name, p);
  }
  return { byName, collisions: Array.from(collisions) };
}

// Two read-time corrections — must match the App.jsx Insights helpers so the
// planner sees the exact same numbers the owner sees in Internal Insights.
//
// IMPORTANT: orderNumber is daily-scoped at Marathon — staff write a 3-digit
// number (001–999) on each product and the counter RESETS every morning.
// Two unrelated orders on different days can share orderNumber "001".
// Therefore every uniqueness key here is the composite
// `${SA-date}::${orderNumber}`, NOT orderNumber alone. SA-date is derived
// via the existing isoToMs + saDateStringFromMs helpers above.
//
// dedupeByOrderNumber: keep the earliest event per (date, orderNumber). An
// order whose ready/oos/placed transition was flipped (Undo → re-do) writes
// multiple log entries with the same orderNumber on the same day; without
// dedupe, historical counts inflate beyond reality.
//
// excludeReturnedOrderNumbers: drop every event whose (date, orderNumber)
// composite is in the returns set. Returns may carry their own `date` field;
// fall back to deriving from timestamp if absent. Applied to ready/oos but
// NOT to placed (placed measures demand at checkout — a later return doesn't
// erase the customer's intent).
function eventCompositeKey(e) {
  return `${saDateStringFromMs(isoToMs(e.timestamp))}::${e.orderNumber}`;
}

function returnCompositeKey(r) {
  const date = r.date || saDateStringFromMs(isoToMs(r.timestamp));
  return `${date}::${r.orderNumber}`;
}

function dedupeByOrderNumber(events) {
  const earliest = new Map();
  for (const e of events) {
    if (!e || e.orderNumber == null) continue;
    const key = eventCompositeKey(e);
    const ex = earliest.get(key);
    if (!ex || (e.timestamp || "") < (ex.timestamp || "")) {
      earliest.set(key, e);
    }
  }
  return Array.from(earliest.values());
}

function excludeReturnedOrderNumbers(events, returnsSet) {
  if (!returnsSet || returnsSet.size === 0) return events;
  return events.filter(e => !returnsSet.has(eventCompositeKey(e)));
}

function buildReturnedOrderNumberSet(returnsLog) {
  const s = new Set();
  for (const r of returnsLog) {
    if (r && r.orderNumber) s.add(returnCompositeKey(r));
  }
  return s;
}

// Aggregate lifetime + recent stats per product. Returns a Map keyed by
// productId. Products that never appear in any order or log get a zeroed
// entry so the pre-filter can drop them cleanly.
//
// Canonical event mapping (matches App.jsx Insights · Phase 13A integrity):
//   totalSales / recentSales / sale dates → action === "ready"
//   stockoutCount / recentStockoutCount   → action === "out_of_stock"
//   sizePopularity numerator              → action === "placed" (demand)
// All log queries are deduped by orderNumber first; ready/oos are also
// pruned of returned orderNumbers. Placed events keep returns in (demand
// signal is unaffected by what happened post-fulfilment).
function aggregatePerProduct({ products, orders, logs, returnsLog, nowMs }) {
  const recentCutoffMs = nowMs - REORDER_RECENT_DAYS * 24 * 60 * 60 * 1000;
  const { byName: productByName, collisions } = indexProductsByName(products);
  const returnedNums = buildReturnedOrderNumberSet(returnsLog);

  const stats = new Map();
  const getEntry = (product) => {
    let e = stats.get(product.id);
    if (!e) {
      e = {
        product,
        totalSales:           0,
        recentSales:          0,
        stockoutCount:        0,
        recentStockoutCount:  0,
        depletionCount:       0,
        substitutionCount:    0,
        displayRefillCount:   0,
        firstSaleMs:          0,
        lastSaleMs:           0,
        bySize:               Object.create(null),
        placedTotal:          0,
      };
      stats.set(product.id, e);
    }
    return e;
  };

  // Initialise an entry for every catalog product so the response shape is
  // stable even when a product has zero activity (those will be pre-filtered
  // later, but downstream code can still safely look any product up).
  for (const p of products) getEntry(p);

  // ── Bucket the log by action, then dedupe + (optionally) exclude returns.
  const readyEventsClean  = excludeReturnedOrderNumbers(
    dedupeByOrderNumber(logs.filter(l => l && l.action === "ready")),
    returnedNums
  );
  const oosEventsClean    = excludeReturnedOrderNumbers(
    dedupeByOrderNumber(logs.filter(l => l && l.action === "out_of_stock")),
    returnedNums
  );
  const placedEventsClean = dedupeByOrderNumber(
    logs.filter(l => l && l.action === "placed")
  );

  // Sales (ready events): drive totalSales, recentSales, first/last sale.
  for (const entry of readyEventsClean) {
    const product = productByName.get(entry.productName);
    if (!product) continue;
    const ms = isoToMs(entry.timestamp);
    const e = getEntry(product);
    e.totalSales += 1;
    if (ms >= recentCutoffMs) e.recentSales += 1;
    if (ms) {
      if (!e.firstSaleMs || ms < e.firstSaleMs) e.firstSaleMs = ms;
      if (ms > e.lastSaleMs) e.lastSaleMs = ms;
    }
  }

  // Stockouts.
  for (const entry of oosEventsClean) {
    const product = productByName.get(entry.productName);
    if (!product) continue;
    const ms = isoToMs(entry.timestamp);
    const e = getEntry(product);
    e.stockoutCount += 1;
    if (ms >= recentCutoffMs) e.recentStockoutCount += 1;
  }

  // Size popularity from PLACED events (demand). Sized by checkout intent,
  // not by what was eventually sold — gives a truer reorder split since
  // dormant sizes the customer asked for but we couldn't fill still show up.
  for (const entry of placedEventsClean) {
    if (!entry.size) continue;
    const product = productByName.get(entry.productName);
    if (!product) continue;
    const e = getEntry(product);
    e.bySize[entry.size] = (e.bySize[entry.size] || 0) + 1;
    e.placedTotal += 1;
  }

  // ── Orders: state-only signals that don't exist in the log.
  //   • substitutionCount  — warehouse picked a different size than requested
  //   • displayRefillCount — partner display refilled
  //   • depletionCount     — partner display refill couldn't be done (stock gone)
  for (const o of orders) {
    if (!o) continue;
    // Returned orders shouldn't count their post-checkout operational signals.
    if (o.id && returnedNums.has(o.id)) continue;
    // Prefer productId match (orders carry it); fall back to productName.
    let product = null;
    if (o.productId) {
      product = products.find(p => p.id === o.productId) || null;
    }
    if (!product && o.productName) product = productByName.get(o.productName) || null;
    if (!product) continue;
    const e = getEntry(product);

    if (o.sentSize && o.size && o.sentSize !== o.size) e.substitutionCount += 1;
    if (o.displayRefillStatus === "refilled")          e.displayRefillCount += 1;
    if (o.displayRefillStatus === "stockDepleted")     e.depletionCount     += 1;
  }

  return { stats, collisions };
}

function dataConfidence(totalSales, daysOfData) {
  if (totalSales >= 20 && daysOfData >= 60) return "high";
  if (totalSales >= 5) return "medium";
  return "low";
}

// Size popularity = share of demand by size. Denominator is total placed
// events for this product (across all sizes), NOT total sales — matches the
// Internal Insights · Size Popularity tab definition.
function sizePopularityPct(bySize, denominator) {
  if (!denominator) return {};
  const out = {};
  for (const sz of Object.keys(bySize)) {
    out[sz] = Math.round((bySize[sz] / denominator) * 1000) / 10; // 1dp
  }
  return out;
}

// Composite activity rank used when the active-product list exceeds REORDER_TOP_N.
// Weighted toward sales but counts every signal so dormant-but-eventful items
// (lots of stockouts, no sales) still rank well.
function activityScore(e) {
  return (e.totalSales         * 3)
       + (e.stockoutCount      * 2)
       + (e.depletionCount     * 2)
       + (e.substitutionCount  * 1)
       + (e.displayRefillCount * 1);
}

function isActive(e) {
  return e.totalSales > 0
      || e.stockoutCount > 0
      || e.depletionCount > 0
      || e.substitutionCount > 0
      || e.displayRefillCount > 0;
}

// ── Product schema is dual-shaped across the catalog:
//   • Sneakers (admin form) write `sizes` as an array of size strings.
//   • Clothing and older records write `sizes` as an object map
//     { sizeKey: count } and/or carry `stock` as { sizeKey: count }.
// These helpers normalise both shapes so downstream code stays oblivious
// to the difference. stockBySize/totalOnHand are returned only when a
// numeric quantity is actually present — never fabricated.
function getAvailableSizes(p) {
  if (!p) return [];
  if (Array.isArray(p.sizes)) return p.sizes;
  if (p.sizes && typeof p.sizes === "object") return Object.keys(p.sizes);
  if (p.stock && typeof p.stock === "object" && !Array.isArray(p.stock)) return Object.keys(p.stock);
  return [];
}

function extractStockBySize(p) {
  const candidate =
    (p && p.stock && typeof p.stock === "object" && !Array.isArray(p.stock)) ? p.stock :
    (p && p.sizes && typeof p.sizes === "object" && !Array.isArray(p.sizes)) ? p.sizes :
    null;
  if (!candidate) return { hasStockData: false };
  let total = 0;
  let anyNumeric = false;
  const out = {};
  for (const [size, count] of Object.entries(candidate)) {
    if (typeof count === "number" && Number.isFinite(count)) {
      out[size] = count;
      total += count;
      anyNumeric = true;
    }
  }
  if (!anyNumeric) return { hasStockData: false };
  return { stockBySize: out, totalOnHand: total, hasStockData: true };
}

// Build the per-product payload object sent to Claude. Lean: photo bytes are
// excluded, only productPhotoUrl (a Firebase Storage URL) is passed if present.
// Two shapes are emitted from this module:
//   • type: "active"  — full stats (sales, stockouts, etc). Used for reorder/
//     review/skip decisions. Built by buildProductPayload.
//   • type: "dormant" — no activity in the data window; still in the catalog.
//     Used for slow_mover decisions only. Built by buildDormantPayload.
function buildProductPayload(e, nowMs) {
  const p = e.product;
  const daysOfData = e.firstSaleMs
    ? Math.max(1, Math.round((nowMs - e.firstSaleMs) / (24 * 60 * 60 * 1000)))
    : 0;
  const recentDays = Math.min(daysOfData || REORDER_RECENT_DAYS, REORDER_RECENT_DAYS);
  const salesPerDay = daysOfData ? +(e.totalSales / daysOfData).toFixed(3) : 0;
  const recentSalesPerDay = recentDays ? +(e.recentSales / recentDays).toFixed(3) : 0;

  const stock = extractStockBySize(p);
  const payload = {
    type:          "active",
    productId:     p.id,
    productName:   p.name,
    productType:   p.productType || "sneaker",
    hub:           getProductHubs(p)[0] || "hub1",
    category:      p.category || "",
    availableSizes: getAvailableSizes(p),
    sizePopularity: sizePopularityPct(e.bySize, e.placedTotal),
    stats: {
      totalSales:          e.totalSales,
      recentSales:         e.recentSales,
      salesPerDay,
      recentSalesPerDay,
      stockoutCount:       e.stockoutCount,
      recentStockoutCount: e.recentStockoutCount,
      depletionCount:      e.depletionCount,
      substitutionCount:   e.substitutionCount,
      displayRefillCount:  e.displayRefillCount,
      firstSaleDate:       e.firstSaleMs ? saDateStringFromMs(e.firstSaleMs) : null,
      lastSaleDate:        e.lastSaleMs  ? saDateStringFromMs(e.lastSaleMs)  : null,
    },
    daysOfData,
    dataConfidence: dataConfidence(e.totalSales, daysOfData),
  };
  if (stock.hasStockData) {
    payload.stockBySize  = stock.stockBySize;
    payload.totalOnHand  = stock.totalOnHand;
  }
  return payload;
}

// Lean dormant-product payload. No activity stats — by definition there are
// none. The model uses this to issue action:"slow_mover" entries. Stock
// fields are included only when the catalog actually records numeric
// per-size quantities for this product.
function buildDormantPayload(product) {
  const stock = extractStockBySize(product);
  const payload = {
    type:           "dormant",
    productId:      product.id,
    productName:    product.name,
    productType:    product.productType || "sneaker",
    hub:            getProductHubs(product)[0] || "hub1",
    category:       product.category || "",
    availableSizes: getAvailableSizes(product),
    dataConfidence: "low",
  };
  if (stock.hasStockData) {
    payload.stockBySize = stock.stockBySize;
    payload.totalOnHand = stock.totalOnHand;
  }
  return payload;
}

function systemPrompt(businessContext) {
  const ctxBlock = businessContext
    ? `\n\nOWNER-PROVIDED BUSINESS CONTEXT:\n${JSON.stringify(businessContext, null, 2)}\n`
    : "";
  return `CRITICAL OUTPUT CONTRACT — read this before anything else:
Your ENTIRE response must be one single JSON object and nothing else. The first character must be { and the last character must be }. No preamble like "Here is..." or "Sure,". No closing remarks. No markdown code fences (no \`\`\`json, no \`\`\`). No commentary outside the JSON. No multiple JSON objects. If you cannot fit a complete JSON response within the token budget, truncate the recommendations array rather than adding explanatory prose — but the JSON must remain syntactically valid (close all brackets and braces). Violations cause the entire response to be discarded.

You are the AI Reorder Planner for Marathon Club, a sneaker and clothing store in South Africa. Your job is to recommend what the owner should reorder for the upcoming ${REORDER_CYCLE_DAYS}-day cycle. Real shipping from suppliers typically takes 45–60 days, so the owner reorders roughly every ${REORDER_CYCLE_DAYS} days.

DATA WINDOW: Data spans the full product lifetime, not a fixed window. Each product carries totalSales (all-time) and recentSales (last ${REORDER_RECENT_DAYS} days), plus salesPerDay velocities for both.

PRIORITIES:
1. Weight RECENT trends (last ${REORDER_RECENT_DAYS} days) more heavily for restock urgency — recent demand is the strongest signal of what will sell next cycle.
2. ALSO flag products with strong all-time patterns that may have gone dormant. Surface dormant-but-promising items the owner may have forgotten about — recommend "review" (not auto-reorder) so they can decide.
3. When dataConfidence is "low" (totalSales < 5 or short history), recommend conservatively. Prefer "review" over "reorder" and explain the uncertainty.
4. Use sizePopularity percentages to split suggestedQuantity across sizes. Round to whole units.
5. Stockouts and substitutions are demand signals — products with frequent stockouts likely need higher reorder quantities than sales alone suggest.
6. Display refill activity reflects shelf presence in partner stores; depletionCount is a strong negative signal (couldn't restock the display).

PRODUCT CATEGORIES: The products array carries entries with a "type" field:
- type: "active"  — products with recorded sales / stockout / depletion / substitution / display-refill activity in the data window. Apply the reorder/review/skip logic above ONLY to these.
- type: "dormant" — products in the catalog with ZERO recorded activity in the data window. Use these as slow-mover candidates ONLY.
Some entries (both active and dormant) carry stockBySize (per-size on-hand) and totalOnHand. Others do not — the catalog records per-size quantities for some product types and not others. When stock data is absent, do not infer or fabricate it.

SLOW MOVERS: For each dormant product, emit an entry in the recommendations array with:
- action: "slow_mover"
- priority: "high" | "medium" | "low" — base priority on how confidently the item appears inactive (e.g. number of available sizes still listed, broad catalog presence, no recent activity). When stockBySize/totalOnHand IS provided, also weight higher dormant stock as higher priority. When stock data is absent, base priority on dormancy signals alone — do NOT assume a stock level.
- totalSuggested: 0 (no reorder)
- suggestedQuantity: {} (empty)
- reasoning: explain why this item appears slow and suggest a next action (review pricing, transfer between stores, discount, or remove from catalog). If stockBySize is provided you may reference the unsold quantities; otherwise do not invent numbers.

Do NOT issue reorder/review/skip actions for type:"dormant" entries — those are out of scope for the reorder cycle. Do NOT issue slow_mover actions for type:"active" entries.

OUTPUT FORMAT: Respond with STRICT JSON only. Forbidden: any text before the opening {, any text after the closing }, markdown code fences (\`\`\`json or \`\`\`), prose explanations, apologies, headings, bullet lists outside JSON values, multiple JSON objects, trailing commas. The JSON must match this shape exactly:
{
  "summary": "string — 2-4 sentences of headline findings",
  "recommendations": [
    {
      "productId": "string",
      "productName": "string",
      "action": "reorder" | "review" | "skip" | "slow_mover",
      "priority": "high" | "medium" | "low",
      "suggestedQuantity": { "<size>": <integer>, ... },
      "totalSuggested": <integer>,
      "reasoning": "string — 1-2 sentences"
    }
  ],
  "topSellers": [{ "productName": "string", "totalSales": <integer> }],
  "sleepers": [{ "productName": "string", "lastSaleDate": "YYYY-MM-DD or null", "totalSales": <integer>, "note": "string" }],
  "dataQualityNotes": ["string", ...]
}

Include every product in recommendations (one entry per productId). If a product should be skipped, still emit an entry with action:"skip" and a brief reason.${ctxBlock}

FINAL REMINDER: Your output must start with { and end with }. Nothing else. No "Here is the plan:", no \`\`\`json fences, no remarks after the closing brace. The parser is strict and will reject anything that is not a single valid JSON object.`;
}

function buildUserPayload({ products, activeAll, dormantAll, sent, paginatedActive, paginatedDormant, businessContextPresent }) {
  return JSON.stringify({
    reportDate: saDateStringFromMs(Date.now()),
    cycleDays: REORDER_CYCLE_DAYS,
    totalProductsInCatalog: products.length,
    activeProductsTotal: activeAll,
    dormantProductsTotal: dormantAll,
    productsAnalyzed: sent.length,
    paginatedActive,
    paginatedDormant,
    businessContextPresent,
    products: sent,
  });
}

async function callClaude({ client, system, user, retryHint }) {
  const messages = [{ role: "user", content: user }];
  if (retryHint) {
    messages.push({
      role: "assistant",
      content: "I will respond with strict JSON only, no markdown or commentary.",
    });
    messages.push({ role: "user", content: retryHint });
  }
  return client.messages.create({
    model: REORDER_MODEL,
    max_tokens: REORDER_MAX_TOKENS,
    system,
    messages,
  });
}

// RTDB rejects keys containing ".", "#", "$", "/", "[", or "]". Claude
// emits sneaker sizes like "5.5", "6.5" as keys in suggestedQuantity —
// valid JSON, but unwritable. This sanitizer walks the parsed plan and
// rewrites every forbidden character in every key to "_". The frontend
// display layer reverses the mapping for size labels (e.g. "5_5" → "5.5"
// for sneakers). Applied only at the persist boundary; the in-memory
// `parsed` object that we return to the caller is left unchanged so any
// awaiting client still gets the natural-keys version.
const RTDB_KEY_FORBIDDEN = /[.#$/\[\]]/g;
function deepSanitizeRtdbKeys(value) {
  if (Array.isArray(value)) return value.map(deepSanitizeRtdbKeys);
  if (value && typeof value === "object" && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const safeKey = String(k).replace(RTDB_KEY_FORBIDDEN, "_");
      out[safeKey] = deepSanitizeRtdbKeys(v);
    }
    return out;
  }
  return value;
}

function extractJSON(text) {
  if (!text) return null;
  let trimmed = text.trim();

  // Fast path: clean JSON.
  try { return JSON.parse(trimmed); } catch (_) {}

  // Strip leading + trailing markdown fences independently. Haiku 4.5 tends
  // to wrap output in ```json ... ``` despite the prompt forbidding it, and
  // when output is also truncated by max_tokens the closing fence may be
  // missing entirely. Older balanced-fences regex only worked when both
  // fences were present, so a leading-only fence (the common Haiku case)
  // fell through to the last-ditch span extraction and failed.
  if (/^```(?:json)?\s*/i.test(trimmed)) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "");
  }
  if (/\s*```\s*$/.test(trimmed)) {
    trimmed = trimmed.replace(/\s*```\s*$/, "");
  }
  try { return JSON.parse(trimmed); } catch (_) {}

  // Last-ditch: grab the largest {...} span.
  const first = trimmed.indexOf("{");
  const last  = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

// ── Shared persist / usage-log helpers (used by BOTH the demand-driven and the
//    legacy paths so the /latest cache and /aiAssistant/usage writes have one
//    implementation). persistReorderPlan returns the persistFailed flag the
//    finally block reads to choose status idle vs error.
async function persistReorderPlan(db, { plan, meta, callerUid, durationMs }) {
  try {
    await db.ref(REORDER_LATEST_PATH).set({
      plan: deepSanitizeRtdbKeys(plan),
      meta,
      generatedAt: Date.now(),
      generatedBy: callerUid,
      durationMs,
    });
    console.log(`analyzeReorderNeeds: Result cache written to /${REORDER_LATEST_PATH}`);
    return { persistFailed: false, persistError: null };
  } catch (err) {
    const persistError = (err && err.message) || String(err);
    console.warn("analyzeReorderNeeds: result cache write failed:", persistError);
    return { persistFailed: true, persistError };
  }
}

async function logReorderUsage(db, today, payload) {
  try {
    await db.ref(`aiAssistant/usage/${today}`).push(payload);
  } catch (err) {
    console.warn("analyzeReorderNeeds: usage log write failed:", err.message);
  }
}

function estimateCostUSD(usage) {
  const inputTokens  = (usage && usage.input_tokens)  || 0;
  const outputTokens = (usage && usage.output_tokens) || 0;
  return +(
    (inputTokens  / 1e6) * PRICE_INPUT_PER_MTOK +
    (outputTokens / 1e6) * PRICE_OUTPUT_PER_MTOK
  ).toFixed(6);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMAND-DRIVEN reasoner (Phase 3). Invoked when the client supplies
// request.data.demand (schema v1, built by marathon-ai's buildReorderPayload).
// This is the PURE-REASONER path: it never re-aggregates sales — it reasons over
// the supplied true demand. The legacy internal-discovery path below remains as
// the fallback for callers that don't send `demand` (cron, old client).
//
// Flow:
//   1. Partition the supplied rows: active (has demand) / dormant (listed, no
//      demand) / ignored (no demand, no sizes).
//   2. Batch active+dormant across the WHOLE catalog (no TOP_N) and ask Claude
//      for per-product recommendations only — quantities built from per-size
//      true demand (OOS included), projected over demand.cycleDays.
//   3. Compute summary / topSellers / sleepers / dataQualityNotes
//      deterministically from the aggregates (never re-derived by the model).
//   4. Merge → the same plan shape the dashboard already renders.
// ─────────────────────────────────────────────────────────────────────────────
const DEMAND_BATCH_CONCURRENCY = 3;

// One Claude call for a batch, with a single parse-retry (mirrors the legacy
// path's discipline). Returns { parsed, usage, retried }. Throws on API error so
// the caller can record the batch as unanalysed without killing the whole run.
async function callDemandBatch({ client, system, user }) {
  let resp = await callClaude({ client, system, user });
  let usage = resp.usage || { input_tokens: 0, output_tokens: 0 };
  let parsed = extractJSON((resp.content || []).map(c => c.text || "").join(""));
  let retried = false;
  if (!parsed) {
    retried = true;
    const retryHint = "Your previous response was not valid JSON. Re-emit the entire response as a single JSON object with a `recommendations` array. No prose, no markdown, no code fences.";
    resp = await callClaude({ client, system, user, retryHint });
    const u2 = resp.usage || { input_tokens: 0, output_tokens: 0 };
    usage = {
      input_tokens:  (usage.input_tokens  || 0) + (u2.input_tokens  || 0),
      output_tokens: (usage.output_tokens || 0) + (u2.output_tokens || 0),
    };
    parsed = extractJSON((resp.content || []).map(c => c.text || "").join(""));
  }
  return { parsed, usage, retried };
}

async function buildDemandDrivenPlan({ client, demand, businessContext }) {
  const rows       = Array.isArray(demand.rows) ? demand.rows : [];
  const coverage   = demand.coverage || {};
  const totals     = demand.totals   || {};
  const window     = demand.window ?? "all";
  // cycleDays is the real catalog window from the engine; fall back defensively.
  const cycleDays  = Number(demand.cycleDays)  > 0 ? Number(demand.cycleDays)  : REORDER_CYCLE_DAYS;
  const recentDays = Number(demand.recentDays) > 0 ? Number(demand.recentDays) : REORDER_RECENT_DAYS;

  const { active, dormant, ignored } = reorderDemand.partitionDemandRows(rows);

  // Build homogeneous batches: all active first, then all dormant. Whole catalog,
  // no cap — output token budget is bounded per batch, not by dropping the tail.
  const activeSlim  = active.map(reorderDemand.slimActiveRow);
  const dormantSlim = dormant.map(reorderDemand.slimDormantRow);
  const batches = [
    ...reorderDemand.chunk(activeSlim,  reorderDemand.DEMAND_BATCH_SIZE),
    ...reorderDemand.chunk(dormantSlim, reorderDemand.DEMAND_BATCH_SIZE),
  ];

  const system = reorderDemand.demandSystemPrompt({ businessContext, cycleDays, recentDays, window });

  let usage = { input_tokens: 0, output_tokens: 0 };
  let parseRetries = 0;

  const batchOutputs = await reorderDemand.mapWithConcurrency(
    batches,
    DEMAND_BATCH_CONCURRENCY,
    async (batchRows, i) => {
      const user = reorderDemand.buildBatchUserPayload({
        cycleDays, recentDays, window,
        batchIndex: i, batchCount: batches.length, rows: batchRows,
      });
      try {
        const { parsed, usage: u, retried } = await callDemandBatch({ client, system, user });
        usage = {
          input_tokens:  usage.input_tokens  + (u.input_tokens  || 0),
          output_tokens: usage.output_tokens + (u.output_tokens || 0),
        };
        if (retried) parseRetries += 1;
        if (!parsed) {
          console.warn(`analyzeReorderNeeds(demand): batch ${i} unparseable after retry (${batchRows.length} products) — flagged via post-merge diff`);
          return null;
        }
        return parsed;
      } catch (err) {
        // API error on this batch — keep going. Its products surface as
        // unanalysed via the post-merge diff (unanalyzedFromBatches), never
        // silently dropped.
        console.warn(`analyzeReorderNeeds(demand): batch ${i} failed (${err && err.message}); ${batchRows.length} products unanalysed`);
        return null;
      }
    }
  );

  const recommendations = reorderDemand.mergeRecommendations(batchOutputs.filter(Boolean));

  // Within-batch truncation guard: surface EVERY sent product that came back
  // without a recommendation — a failed/unparsed batch OR a batch that parsed but
  // returned fewer recs than its inputs (the model dropping the tail to fit the
  // token budget). Diffing the full sent set against the merged recs is the single
  // authoritative source, so the tail can never be silently dropped; it flows into
  // dataQualityNotes below.
  const unanalyzedProductIds = reorderDemand.unanalyzedFromBatches(batches.flat(), recommendations);

  // If every batch failed (e.g. provider outage) and there was work to do, treat
  // it as a hard failure so status flips to error rather than persisting an empty
  // plan over a previously-good one.
  if (batches.length > 0 && recommendations.length === 0) {
    throw new HttpsError("internal", "Reorder analysis produced no recommendations (all batches failed).");
  }

  const plan = {
    summary: reorderDemand.buildSummary({
      totals, coverage, cycleDays,
      activeCount: active.length, dormantCount: dormant.length,
    }),
    recommendations,
    topSellers: reorderDemand.buildTopSellers(active),
    sleepers:   reorderDemand.buildSleepers(active, recentDays),
    dataQualityNotes: reorderDemand.buildDataQualityNotes({
      coverage, ignoredCount: ignored.length, unanalyzedProductIds, window,
    }),
  };

  return {
    plan,
    usage,
    parseRetries,
    cycleDays,
    counts: {
      catalogTotal:         coverage.catalogTotal ?? rows.length,
      activeProductsTotal:  active.length,
      dormantProductsTotal: dormant.length,
      productsAnalyzed:     recommendations.length,
      ignored:              ignored.length,
      unanalyzed:           unanalyzedProductIds.length,
    },
  };
}

/**
 * analyzeReorderNeeds — AI-powered reorder analysis Cloud Function.
 *
 * Reads sales / depletion / stockout / order history from RTDB, packages
 * it for Anthropic Claude, and writes a structured recommendation plan
 * back to RTDB for the frontend to consume.
 *
 * RTDB paths (writes only — Admin SDK bypasses security rules):
 *   /insights/reorderPlan/status   — { state, startedAt, startedBy,
 *                                      completedAt | erroredAt,
 *                                      errorMessage? }
 *   /insights/reorderPlan/latest   — { plan, meta, generatedAt,
 *                                      generatedBy, durationMs }
 *
 * Status state machine:
 *   idle    → running   (acquired atomically via transaction)
 *   running → idle      (successful completion)
 *   running → error     (Anthropic call failed, persist write failed,
 *                        or any uncaught exception)
 *
 * Concurrent-run protection: 15-minute window. A new caller is rejected
 * with failed-precondition if status.state === "running" AND startedAt
 * is within the last 15 minutes.
 *
 * Rate limit: 1 hour between fresh runs for non-super-admin callers.
 * Super-admin (gunidmoh@gmail.com) can override with { force: true }
 * in the payload; force is ignored for non-super-admin.
 *
 * Returns: { plan, meta } directly to the caller for backwards
 * compatibility. Frontend should subscribe to /insights/reorderPlan/*
 * instead of awaiting the return value — function execution can exceed
 * the 70s client-side callable timeout.
 */
exports.analyzeReorderNeeds = onCall(
  {
    region: "europe-west1",
    secrets: [anthropicApiKey],
    memory: "1GiB",
    timeoutSeconds: 900,
  },
  async (request) => {
    assertAdmin(request);
    const startedAt = Date.now();
    const callerEmail = request.auth.token.email;
    const callerUid   = request.auth.uid;
    const isSuperAdmin = callerEmail === ADMIN_EMAIL;
    // payload.force is honoured only for the super-admin. Any other caller
    // that passes force: true falls back to the normal rate-limit path.
    const requestedForce = !!(request.data && request.data.force);
    const force = requestedForce && isSuperAdmin;

    // ── 0a. Rate-limit gate. Reads /insights/reorderPlan/latest only.
    //     This check is intentionally non-atomic — the running-lock
    //     transaction below is the authoritative serialisation point. Two
    //     callers that slip past the rate-limit window will both reach the
    //     transaction, and only the winner acquires the lock.
    const db = admin.database();
    let latestSnap;
    try {
      latestSnap = await db.ref(REORDER_LATEST_PATH).once("value");
    } catch (err) {
      console.error("analyzeReorderNeeds: latest read failed:", err.message);
      throw new HttpsError("unavailable", "Could not check planner state.");
    }
    const latestCached = latestSnap.val() || {};

    if (
      latestCached.generatedAt &&
      (Date.now() - latestCached.generatedAt) < REORDER_RATE_LIMIT_MS &&
      !force
    ) {
      const ageMin  = Math.max(1, Math.round((Date.now() - latestCached.generatedAt) / 60000));
      const waitMin = Math.max(1, Math.round(REORDER_RATE_LIMIT_MS / 60000) - ageMin);
      console.warn(`analyzeReorderNeeds: Rate-limit hit for ${callerUid}, last gen ${ageMin} min ago`);
      throw new HttpsError(
        "resource-exhausted",
        `Rate limited. Last analysis was ${ageMin} minute${ageMin === 1 ? "" : "s"} ago. Wait ${waitMin} more minute${waitMin === 1 ? "" : "s"} or set force: true (super-admin only).`,
      );
    }

    // ── 0b. Acquire the running-lock atomically. RTDB transaction reads the
    //     current status, decides whether to commit, and writes the new
    //     state in a single round-trip — closing the TOCTOU window that a
    //     read-then-set sequence would leave open. If another invocation
    //     holds an unexpired "running" status, the transaction aborts.
    const statusRef = db.ref(REORDER_STATUS_PATH);
    let blockingStatus = null;
    let txnResult;
    try {
      txnResult = await statusRef.transaction((current) => {
        if (
          current &&
          current.state === "running" &&
          current.startedAt &&
          (Date.now() - current.startedAt) < REORDER_CONCURRENT_LOCK_MS
        ) {
          blockingStatus = current;
          return; // abort — another run holds the lock
        }
        return {
          state: "running",
          startedAt,
          startedBy: callerUid,
        };
      });
    } catch (err) {
      console.error("analyzeReorderNeeds: status transaction failed:", err.message);
      throw new HttpsError("unavailable", "Could not acquire planner lock.");
    }

    if (!txnResult.committed) {
      const minsAgo = blockingStatus && blockingStatus.startedAt
        ? Math.max(1, Math.round((Date.now() - blockingStatus.startedAt) / 60000))
        : 1;
      console.warn(`analyzeReorderNeeds: Concurrent run rejected for ${callerUid}`);
      throw new HttpsError(
        "failed-precondition",
        `A reorder analysis is already running. Started ${minsAgo} minute${minsAgo === 1 ? "" : "s"} ago.`,
      );
    }
    console.log("analyzeReorderNeeds: Status -> running");

    let lastError = null;
    // Tracks whether the /latest cache write succeeded. The finally block
    // checks this to decide between "idle" and "error" — if the plan was
    // never persisted, transitioning to "idle" would leave the UI reading
    // stale or empty /latest after a successful run (CodeRabbit #3).
    let persistFailed = false;
    let persistError  = null;
    try {
      // ── Phase 3 branch: demand-driven (pure reasoner) vs legacy discovery.
      //     When the client supplies request.data.demand at the recognised
      //     schema version, reason over that true demand and skip ALL internal
      //     aggregation. Otherwise fall through to the legacy path below
      //     (cron / old client / unknown schema) — unchanged.
      const suppliedDemand = request.data && request.data.demand;
      const useDemand =
        suppliedDemand &&
        suppliedDemand.schemaVersion === reorderDemand.REORDER_DEMAND_SCHEMA_VERSION;

      if (useDemand) {
        // Only one RTDB read here (owner business context) — demand itself is
        // supplied, so /products /orders /insights_log /returns_log are NOT read.
        let businessContext = null;
        try {
          const ctxSnap = await db.ref("aiAssistant/memory/gunidmoh/businessContext").once("value");
          businessContext = ctxSnap.val() || null;
        } catch (err) {
          console.warn("analyzeReorderNeeds(demand): businessContext read failed:", err.message);
        }

        const AnthropicCtor = Anthropic.default || Anthropic;
        const client = new AnthropicCtor({ apiKey: anthropicApiKey.value() });

        const { plan, usage, parseRetries, cycleDays, counts } =
          await buildDemandDrivenPlan({ client, demand: suppliedDemand, businessContext });

        const durationMs = Date.now() - startedAt;
        const today = saDateStringFromMs(Date.now());
        const inputTokens  = usage.input_tokens  || 0;
        const outputTokens = usage.output_tokens || 0;
        const estimatedCostUSD = estimateCostUSD(usage);

        await logReorderUsage(db, today, {
          timestamp: new Date().toISOString(),
          callerEmail,
          model: REORDER_MODEL,
          source: "demand-engine",
          demandSchemaVersion: reorderDemand.REORDER_DEMAND_SCHEMA_VERSION,
          inputTokens,
          outputTokens,
          estimatedCostUSD,
          productsAnalyzed: counts.productsAnalyzed,
          activeProductsTotal: counts.activeProductsTotal,
          dormantProductsTotal: counts.dormantProductsTotal,
          catalogTotal: counts.catalogTotal,
          unanalyzed: counts.unanalyzed,
          parseRetries,
          durationMs,
        });

        const meta = {
          reportDate: today,
          source: "demand-engine",
          demandSchemaVersion: reorderDemand.REORDER_DEMAND_SCHEMA_VERSION,
          cycleDays,
          window: suppliedDemand.window ?? "all",
          catalogTotal: counts.catalogTotal,
          activeProductsTotal: counts.activeProductsTotal,
          dormantProductsTotal: counts.dormantProductsTotal,
          productsAnalyzed: counts.productsAnalyzed,
          // No TOP_N cap anymore — the whole catalog is analysed. Kept (false) so
          // the dashboard's existing meta reads stay defined.
          paginatedActive: false,
          paginatedDormant: false,
          unanalyzedProducts: counts.unanalyzed,
          coveragePct: (suppliedDemand.coverage && suppliedDemand.coverage.coveragePct) ?? null,
          parseRetries,
          durationMs,
          inputTokens,
          outputTokens,
          estimatedCostUSD,
        };

        const pr = await persistReorderPlan(db, { plan, meta, callerUid, durationMs });
        persistFailed = pr.persistFailed;
        persistError  = pr.persistError;

        return { plan, meta };
      }

      // ── 2. Load full operational history in parallel.
      let productsSnap, ordersSnap, logsSnap, returnsSnap, contextSnap;
      try {
        [productsSnap, ordersSnap, logsSnap, returnsSnap, contextSnap] = await Promise.all([
          db.ref("products").once("value"),
          db.ref("orders").once("value"),
          db.ref("insights_log").once("value"),
          db.ref("returns_log").once("value"),
          db.ref("aiAssistant/memory/gunidmoh/businessContext").once("value"),
        ]);
      } catch (err) {
        console.error("analyzeReorderNeeds: RTDB read failed:", err.message);
        throw new HttpsError("unavailable", "Could not load store data.");
      }

      const productsRaw = productsSnap.val() || {};
      const ordersRaw   = ordersSnap.val()   || {};
      const logsRaw     = logsSnap.val()     || {};
      const returnsRaw  = returnsSnap.val()  || {};
      const businessContext = contextSnap.val() || null;

      const products = Object.values(productsRaw)
        .filter(v => v && typeof v === "object" && v.id && v.name);
      const orders     = Object.values(ordersRaw).filter(Boolean);
      const logs       = Object.values(logsRaw).filter(Boolean);
      const returnsLog = Object.values(returnsRaw).filter(Boolean);

      if (!products.length) {
        throw new HttpsError("failed-precondition", "No products in catalog.");
      }

      // ── 3. Aggregate, then split the catalog into two candidate sets:
      //     • active  — products with any recorded activity in the window.
      //                 Drives reorder/review/skip decisions.
      //     • dormant — products in the catalog with zero recorded activity
      //                 but at least one listed size. Drives slow_mover
      //                 decisions only (CodeRabbit #2: previously these were
      //                 filtered out before reaching the prompt, so the
      //                 model had nothing to flag).
      const { stats, collisions } = aggregatePerProduct({
        products, orders, logs, returnsLog, nowMs: Date.now(),
      });

      const allEntries    = Array.from(stats.values());
      const activeEntries = allEntries.filter(isActive);
      const dormantEntries = allEntries.filter(
        e => !isActive(e) && getAvailableSizes(e.product).length > 0
      );
      const activeAll  = activeEntries.length;
      const dormantAll = dormantEntries.length;

      // Active: sort by composite activity score, cap at REORDER_TOP_N.
      activeEntries.sort((a, b) => activityScore(b) - activityScore(a));
      let activeToSend = activeEntries;
      let paginatedActive = false;
      if (activeToSend.length > REORDER_TOP_N) {
        activeToSend = activeToSend.slice(0, REORDER_TOP_N);
        paginatedActive = true;
      }

      // Dormant: sort stocked items first (highest totalOnHand wins when
      // numeric stock data is available), then alphabetically by name for
      // a stable order. Cap at REORDER_TOP_N to keep prompt size bounded.
      const dormantWithStock = dormantEntries.map(e => {
        const stock = extractStockBySize(e.product);
        return { entry: e, totalOnHand: stock.hasStockData ? stock.totalOnHand : -1 };
      });
      dormantWithStock.sort((a, b) => {
        if (b.totalOnHand !== a.totalOnHand) return b.totalOnHand - a.totalOnHand;
        return (a.entry.product.name || "").localeCompare(b.entry.product.name || "");
      });
      let dormantToSend = dormantWithStock.map(d => d.entry);
      let paginatedDormant = false;
      if (dormantToSend.length > REORDER_TOP_N) {
        dormantToSend = dormantToSend.slice(0, REORDER_TOP_N);
        paginatedDormant = true;
      }

      if (!activeToSend.length && !dormantToSend.length) {
        throw new HttpsError(
          "failed-precondition",
          "No products with any sales activity or listed sizes — nothing to plan.",
        );
      }

      const productPayload = [
        ...activeToSend.map(e => buildProductPayload(e, Date.now())),
        ...dormantToSend.map(e => buildDormantPayload(e.product)),
      ];
      if (collisions.length) {
        console.warn("analyzeReorderNeeds: productName collisions:", collisions);
      }

      // ── 4. Call Claude (strict JSON, one parse retry).
      const system = systemPrompt(businessContext);
      const user = buildUserPayload({
        products,
        activeAll,
        dormantAll,
        sent: productPayload,
        paginatedActive,
        paginatedDormant,
        businessContextPresent: !!businessContext,
      });

      const AnthropicCtor = Anthropic.default || Anthropic;
      const client = new AnthropicCtor({ apiKey: anthropicApiKey.value() });

      let parseRetries = 0;
      let usage = { input_tokens: 0, output_tokens: 0 };
      let parsed = null;
      let lastRawText = "";

      try {
        let resp = await callClaude({ client, system, user });
        usage = resp.usage || usage;
        lastRawText = (resp.content || []).map(c => c.text || "").join("");
        parsed = extractJSON(lastRawText);

        if (!parsed) {
          parseRetries = 1;
          const retryHint = "Your previous response was not valid JSON. Re-emit the entire response as a single JSON object that matches the schema. No prose, no markdown, no code fences.";
          resp = await callClaude({ client, system, user, retryHint });
          const u2 = resp.usage || { input_tokens: 0, output_tokens: 0 };
          usage = {
            input_tokens:  (usage.input_tokens  || 0) + (u2.input_tokens  || 0),
            output_tokens: (usage.output_tokens || 0) + (u2.output_tokens || 0),
          };
          lastRawText = (resp.content || []).map(c => c.text || "").join("");
          parsed = extractJSON(lastRawText);
        }
      } catch (err) {
        const status = err && err.status;
        console.error("analyzeReorderNeeds: Anthropic call failed:", status, err.message);
        if (status === 429) {
          throw new HttpsError("resource-exhausted", "AI service is rate-limited. Try again in a few minutes.");
        }
        if (status === 401 || status === 403) {
          throw new HttpsError("internal", "AI service authentication failed. Check the anthropic-api-key secret.");
        }
        if (!status) {
          throw new HttpsError("unavailable", "Could not reach the AI service.");
        }
        throw new HttpsError("internal", `AI service error (HTTP ${status}).`);
      }

      if (!parsed) {
        // TEMP DEBUG: dump head/tail snippets so we can see *why* the parse
        // fails — historically the code logged only .length, which hid the
        // shape of the failure (preamble? markdown fences? truncation?
        // multiple JSON objects?). Bounded: 800 head chars + 300 tail chars
        // keeps the log line under ~1.5 KB and never includes whole plans.
        // Remove after Haiku JSON discipline is dialed in.
        const head = lastRawText.slice(0, 800);
        const tail = lastRawText.length > 1100 ? lastRawText.slice(-300) : "";
        console.error("analyzeReorderNeeds: JSON parse failed after retry. Raw length:", lastRawText.length);
        console.error("analyzeReorderNeeds: rawText HEAD (first 800 chars):\n" + head);
        if (tail) console.error("analyzeReorderNeeds: rawText TAIL (last 300 chars):\n" + tail);
        throw new HttpsError("internal", "AI service returned unparseable output.");
      }

      // ── 5. Log usage (token counts + cost only — never the prompt or key).
      const inputTokens  = usage.input_tokens  || 0;
      const outputTokens = usage.output_tokens || 0;
      const estimatedCostUSD = estimateCostUSD(usage);

      const durationMs = Date.now() - startedAt;
      const today = saDateStringFromMs(Date.now());
      await logReorderUsage(db, today, {
        timestamp: new Date().toISOString(),
        callerEmail,
        model: REORDER_MODEL,
        source: "legacy-internal",
        inputTokens,
        outputTokens,
        estimatedCostUSD,
        productsAnalyzed: productPayload.length,
        activeProductsTotal: activeAll,
        dormantProductsTotal: dormantAll,
        catalogTotal: products.length,
        paginatedActive,
        paginatedDormant,
        parseRetries,
        durationMs,
      });

      const meta = {
        reportDate: today,
        source: "legacy-internal",
        cycleDays: REORDER_CYCLE_DAYS,
        catalogTotal: products.length,
        activeProductsTotal: activeAll,
        dormantProductsTotal: dormantAll,
        productsAnalyzed: productPayload.length,
        paginatedActive,
        paginatedDormant,
        parseRetries,
        durationMs,
        inputTokens,
        outputTokens,
        estimatedCostUSD,
        productNameCollisions: collisions,
      };

      // ── 6. Cache the result BEFORE the finally block flips status to idle.
      //     The UI polls status and reads latest, so writing latest first
      //     means the reader never sees idle without a fresh result. Persist
      //     failure is recorded (not rethrown) so the finally block can write
      //     status:"error" instead of "idle" and the polling UI never reads
      //     stale /latest after seeing idle.
      const pr = await persistReorderPlan(db, { plan: parsed, meta, callerUid, durationMs });
      persistFailed = pr.persistFailed;
      persistError  = pr.persistError;

      // ── 7. Return the parsed plan + meta. UI uses /insights/reorderPlan
      //     for the long-running case; this direct return covers awaited
      //     callers and keeps the existing callable contract intact.
      return { plan: parsed, meta };
    } catch (err) {
      lastError = err;
      throw err;
    } finally {
      // Status must always transition out of "running". Writes here are
      // best-effort — a failure logs but does not change what the caller
      // sees (the HttpsError, if any, was already thrown). Three branches:
      //   • lastError set       → status:"error" with the thrown message
      //   • persistFailed set   → status:"error" — the run succeeded but
      //                           /latest wasn't written, so leaving status
      //                           "idle" would point the UI at stale data
      //   • otherwise           → status:"idle"
      try {
        if (lastError) {
          const errorMessage = String((lastError && lastError.message) || lastError).slice(0, 500);
          await db.ref(REORDER_STATUS_PATH).set({
            state: "error",
            startedAt,
            startedBy: callerUid,
            erroredAt: Date.now(),
            errorMessage,
          });
          console.log("analyzeReorderNeeds: Status -> error");
        } else if (persistFailed) {
          const errorMessage = `Result persist failed: ${String(persistError || "unknown").slice(0, 460)}`;
          await db.ref(REORDER_STATUS_PATH).set({
            state: "error",
            startedAt,
            startedBy: callerUid,
            erroredAt: Date.now(),
            errorMessage,
          });
          console.log("analyzeReorderNeeds: Status -> error (persist failure)");
        } else {
          await db.ref(REORDER_STATUS_PATH).set({
            state: "idle",
            startedAt,
            startedBy: callerUid,
            completedAt: Date.now(),
          });
          console.log("analyzeReorderNeeds: Status -> idle");
        }
      } catch (e) {
        console.warn("analyzeReorderNeeds: status write failed:", e.message);
      }
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AI PHOTO-NAMING (cleanProductNames)
// ─────────────────────────────────────────────────────────────────────────────
// Merges a product's PHOTO (vision) with its staff-typed name into ONE clean
// "[Brand] [Model] [Colorway]" name. Reuses the SAME Anthropic Claude connection as
// the reorder planner (claude-haiku-4-5, vision-capable) — no new model/provider.
//
// SAFETY: writes PROPOSALS to /aiAssistant/nameProposals/{id} ONLY; it NEVER edits
// /products/{id}.name. The catalogue name changes solely when an admin approves in the
// review screen. Admin-gated, batched (bounded concurrency), and cost-logged to
// /aiAssistant/usage exactly like analyzeReorderNeeds.
//
// request.data (all optional): { limit=20, productIds:[...], all:false, reprocess:false }
//   - productIds → process exactly these ids (ignores limit/all).
//   - all:true   → every photo'd product still missing a proposal (ignores limit).
//   - limit      → otherwise the first `limit` photo'd products missing a proposal
//                  (default 20 — a small sample to eyeball quality before the full run).
//   - reprocess  → also include products that already have a proposal.
// Returns { processed, failed, total, totalCostUSD, sample:[{id,current,suggested,confidence}] }.

const NAMING_MODEL          = REORDER_MODEL;        // claude-haiku-4-5 — vision-capable, cheap
const NAMING_MAX_TOKENS     = 300;                  // one short name + a confidence number
const NAMING_CONCURRENCY    = 6;                    // photo'd products processed in parallel
const NAMING_DEFAULT_LIMIT  = 20;                   // default sample size
const NAMING_PROPOSALS_PATH = "aiAssistant/nameProposals";

const NAMING_SYSTEM = [
  "You clean up product names for a sneaker & clothing store catalogue.",
  "You are given a PRODUCT PHOTO and the staff-typed name. Identify the product from the",
  "photo and merge it with the typed name into ONE clean, consistent name.",
  "",
  'FORMAT (exact): "[Brand] [Model] [Colorway]"',
  '- Brand ALWAYS first, full and correctly spelled, NO abbreviations ("Jordan" not "J",',
  '  "Nike" not "Nke", "Air Force 1" not "AF1").',
  "- Use the PHOTO to fix/confirm the brand and the model.",
  "- Use the TYPED NAME to preserve the colorway and any detail the photo can't confirm.",
  "- If unsure of a detail, KEEP the typed wording rather than invent it.",
  "- If you CANNOT confidently identify the brand/model from the photo, DO NOT guess and DO NOT",
  '  write any placeholder ("Unable to determine", "Insufficient information", "Unknown", etc.).',
  "  Instead return the staff-typed name as the suggestion (tidy the capitalization only) with a",
  "  LOW confidence (<= 0.3).",
  '- State the brand ONCE only — never repeat it ("Jordan Air Jordan 4" is WRONG; use',
  '  "Air Jordan 4" or "Jordan 4").',
  "- Keep model codes and acronyms UPPERCASE (FG, SG, TF, AG, IC, OG, SE, GS, TD, SL, XXV, etc.)",
  '  — do not Title-Case them to "Fg".',
  '- The Nike Air Max Plus is known as the "TN". If the shoe is a TN / Air Max Plus, OR the typed',
  '  name contains "TN", KEEP "TN" in the name (e.g. "Nike Air Max Plus TN Black" or "Nike TN',
  '  Black"). NEVER drop a "TN" the typed name used, and never rename a TN to just "Air Max".',
  "- Title Case the rest. No size, price, quantity, SKU, barcode, emoji or extra words.",
  "",
  "Respond with STRICT JSON ONLY (no markdown, no commentary):",
  '{"suggested":"<one clean name>","confidence":<number 0-1>}',
  "confidence = how sure you are the suggested name is correct (1 = brand/model clearly visible).",
].join("\n");

// Belt-and-suspenders: if the model still emits a refusal/placeholder instead of a name,
// we keep the typed name at low confidence (never store these strings as a product name).
const NAMING_REFUSAL_RE = /unable to (?:determine|identify)|insufficient|cannot (?:determine|identify)|can'?t (?:determine|identify)|not enough info|unidentif|unknown product|indeterminate|no (?:clear )?product|placeholder|^n\/?a$/i;

// Fetch a product image and return { base64, mediaType } for an Anthropic image block.
async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const mediaType =
    ct.includes("png")  ? "image/png"  :
    ct.includes("webp") ? "image/webp" :
    ct.includes("gif")  ? "image/gif"  : "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mediaType };
}

// One product → { suggested, confidence, usage }. Falls back to the typed name if the
// model returns nothing usable (so a parse miss never blanks a name).
async function proposeOneName(client, product) {
  const { base64, mediaType } = await fetchImageAsBase64(product.photoUrl);
  const resp = await client.messages.create({
    model: NAMING_MODEL,
    max_tokens: NAMING_MAX_TOKENS,
    system: NAMING_SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: `Staff-typed name: "${product.name || ""}".\nProduct type: ${product.productType || "unknown"}.\nIdentify the product from the photo and return the cleaned name as JSON.` },
      ],
    }],
  });
  const text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = extractJSON(text) || {};
  let suggested = typeof parsed.suggested === "string" ? parsed.suggested.trim() : "";
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  // Never store a blank or a refusal/placeholder — keep the typed name, low confidence.
  if (!suggested || NAMING_REFUSAL_RE.test(suggested)) {
    suggested = (product.name || "").trim();
    confidence = Math.min(confidence, 0.2);
  }
  return { suggested, confidence, usage: resp.usage || {} };
}

exports.cleanProductNames = onCall(
  {
    region: "europe-west1",
    secrets: [anthropicApiKey],
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    assertAdmin(request);
    const db = admin.database();
    const data = request.data || {};
    const limit = Number.isFinite(+data.limit) && +data.limit > 0 ? Math.floor(+data.limit) : NAMING_DEFAULT_LIMIT;

    const [prodSnap, propSnap] = await Promise.all([
      db.ref("products").once("value"),
      db.ref(NAMING_PROPOSALS_PATH).once("value"),
    ]);
    const products = prodSnap.val() || {};
    const existing = propSnap.val() || {};

    // Build the work list.
    let ids;
    if (Array.isArray(data.productIds) && data.productIds.length) {
      ids = data.productIds.filter((id) => products[id] && products[id].photoUrl);
    } else {
      ids = Object.keys(products).filter((id) => {
        const p = products[id];
        if (!p || !p.photoUrl) return false;
        if (!data.reprocess && existing[id]) return false;
        return true;
      });
      ids.sort(); // stable order so repeated sample runs advance through the catalogue
      if (!data.all) ids = ids.slice(0, limit);
    }

    const AnthropicCtor = Anthropic.default || Anthropic;
    const client = new AnthropicCtor({ apiKey: anthropicApiKey.value() });

    let processed = 0, failed = 0, totalIn = 0, totalOut = 0;
    const sample = [];

    // Bounded-concurrency pass over the work list.
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        const p = products[id];
        try {
          const { suggested, confidence, usage } = await proposeOneName(client, p);
          totalIn  += usage.input_tokens  || 0;
          totalOut += usage.output_tokens || 0;
          await db.ref(`${NAMING_PROPOSALS_PATH}/${id}`).set({
            current: p.name || "",
            suggested,
            confidence,
            photoUrl: p.photoUrl,
            productType: p.productType || null,
            status: "pending",         // pending | approved | rejected (set by the review UI)
            at: Date.now(),
            by: request.auth.uid,
          });
          processed++;
          if (sample.length < 25) sample.push({ id, current: p.name || "", suggested, confidence });
        } catch (err) {
          failed++;
          console.warn(`cleanProductNames: ${id} failed:`, err && err.message);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(NAMING_CONCURRENCY, ids.length || 1) }, worker));

    const usage = { input_tokens: totalIn, output_tokens: totalOut };
    const totalCostUSD = estimateCostUSD(usage);
    const today = new Date().toISOString().slice(0, 10);
    await logReorderUsage(db, today, {
      at: Date.now(), kind: "cleanProductNames", by: request.auth.uid,
      productsProcessed: processed, failed, usage, estimatedCostUSD: totalCostUSD,
    });

    return { processed, failed, total: ids.length, totalCostUSD, sample };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AI PRODUCT PHOTOS (generateProductPhotos)
// ─────────────────────────────────────────────────────────────────────────────
// Re-shoots each product photo on a pure-white studio background via an image-EDIT
// model (keeps the REAL product), and saves it as a PROPOSAL — it NEVER overwrites
// the product's real photoUrl. Separate from cleanProductNames / analyzeReorderNeeds /
// chatStream. Admin-gated, bounded concurrency, cost-logged to /aiAssistant/usage.
//
// Provider is isolated behind generateWhiteBgImage() so the image model can be swapped
// later without touching the orchestration. Today: OpenAI gpt-image-1 (images.edit).
//
// Per product: server-fetch photoUrl → image edit → upload to
// products/{id}/photo_proposal.jpg (with a Firebase download token) → write
// /aiAssistant/photoProposals/{id} = { originalUrl, proposedUrl, status:"pending", ... }.
//
// request.data (all optional): { limit=12, productIds:[...], category, reprocess=false }.
// Returns { processed, failed, total, estCostUSD, sample }.

const openaiApiKey = defineSecret("OPENAI_API_KEY");
const geminiApiKey = defineSecret("GEMINI_API_KEY");

const PHOTO_MODEL          = "gpt-image-1";   // OpenAI image-edit model (vision in/out)
const PHOTO_SIZE           = "auto";          // match each product's aspect → no top/bottom crop
const PHOTO_DEFAULT_QUALITY = "medium";       // low|medium|high (request param overrides); cost ↑ with quality
const PHOTO_CONCURRENCY    = 3;               // image gen is slow + heavy → keep it low
const PHOTO_DEFAULT_LIMIT  = 12;              // small first batch to eyeball quality + cost
const PHOTO_MAX_BATCH      = 200;            // hard ceiling per call (cost / timeout safety)
const PHOTO_PROPOSALS_PATH = "aiAssistant/photoProposals";
const STORAGE_BUCKET       = "marathon-club.firebasestorage.app";

// gpt-image-1 token pricing (USD per 1M tokens) — used only for an ESTIMATE; the
// authoritative number is the OpenAI bill.
const OAI_TEXT_IN_PER_MTOK  = 5;
const OAI_IMAGE_IN_PER_MTOK = 10;
const OAI_IMAGE_OUT_PER_MTOK = 40;

const PHOTO_PROMPT = [
  "Reshoot this as a HIGH-END, PROFESSIONAL STUDIO product photograph, expertly retouched and",
  "colour-graded to premium e-commerce standard — the polished, flawless look of a Nike, adidas,",
  "SSENSE or Farfetch product listing shot by a commercial product photographer.",
  "Place the COMPLETE product on a pure white #FFFFFF seamless studio background.",
  "Orient the product STRAIGHT, upright and LEVEL in a clean, centred e-commerce catalogue pose.",
  "Footwear: show the OUTER (lateral) display side — the side carrying the main branding and logo",
  "(e.g. the Nike swoosh / adidas stripes) — facing the camera in a flat, level side profile. Keep",
  "the SAME side and the SAME left/right facing as the original photo; NEVER flip, mirror or rotate",
  "the shoe to reveal the plain inner (medial) side.",
  "Clothing & garments: present like a premium fashion e-commerce listing — a clean, symmetrical",
  "FLAT-LAY or invisible/ghost-mannequin look, fully STEAMED and wrinkle-free, with natural even fabric",
  "drape, squared shoulders and straight hems, the WHOLE garment shown front-on and centred. Smooth out",
  "creases, folds and bunching; no hanger marks. Keep the true fabric texture, colour, print and fit.",
  "Do NOT tilt, skew, mirror or angle the product awkwardly, even if the source photo is angled.",
  "The ENTIRE product must stay fully visible — nothing cropped, cut off, or touching any edge.",
  "Frame it LARGE and centred: the product fills as much of the frame as possible (about 90%) while",
  "keeping a small, even white margin all around so nothing is cut.",
  "Show ONLY the single main product. COMPLETELY remove the entire original background and EVERYTHING",
  "in it — shelving, racks, pegboard, displays, boxes, packaging, props, hands, mannequins, HANGERS,",
  "clips, hooks, rails, swing tags, hang tags, price tickets/stickers, labels, reflections and clutter.",
  "Nothing from the original background or packaging may remain — NO hanger and NO tags of any kind.",
  "Present the product in PRISTINE, brand-new condition: fix lighting problems (harsh glare, hot-spots,",
  "colour casts, uneven or dim exposure, blown highlights, dark muddy shadows) and clean off dust,",
  "smudges, fingerprints, scuffs, scratches, lint, stray threads and creases.",
  "CRITICAL — TRUE COLOUR & CRISP EDGES: keep the product's REAL, accurate, full-saturation colours",
  "exactly; do NOT wash out, fade, lighten, desaturate or over-expose them. The white background must",
  "STOP cleanly at the product's outline and must NEVER bleed, spill, glow or blend over the product —",
  "keep pale, white, cream or light-coloured items clearly separated from the background with sharp,",
  "well-defined edges.",
  "Keep DARK products DARK: black, charcoal, graphite, navy and other deep colours must stay RICH, DEEP",
  "and full-strength — do NOT lift, grey-out, fade or wash them lighter against the white; they must read",
  "as strong, true, bold dark tones that stand out clearly.",
  "Keep the product's DESIGN EXACTLY — identical shape, proportions, colour, materials, patterns, logos",
  "and text. NEVER redesign, restyle, recolour, add or remove real product features, or invent any detail.",
  "Render every brand wordmark, logo and label CRISPLY and CORRECTLY — correctly spelled, properly",
  "letter-formed and legible, matching the real brand's exact lettering. NEVER produce garbled, warped,",
  "misspelled, blurry or fake-looking text.",
  "TACK-SHARP focus and fine detail throughout — absolutely no blur, softness or smudging.",
  "Light the PRODUCT with soft, even, professional studio lighting (softbox quality) so it keeps natural",
  "depth, gentle highlights and soft form — it must look genuinely THREE-DIMENSIONAL and real, NOT a flat",
  "paper cut-out. But cast NO shadow, reflection, gradient or vignette onto the background: the background",
  "stays perfectly flat, uniform pure #FFFFFF edge to edge with a crisp, clean outline around the product.",
  "Finish to PREMIUM e-commerce standard — professionally retouched and immaculately clean, with balanced",
  "exposure, accurate white balance, rich true-to-life contrast and tack-sharp, high-resolution detail: a",
  "flawless, photorealistic catalogue hero image.",
].join(" ");

// Prepend product IDENTITY so the model RECOGNISES the exact item (from its saved
// name) and reproduces its genuine design — using the source photo + its knowledge
// of that exact product together to correct blur / missing detail, while NEVER
// substituting a different model, colourway or design. Reviewed before approval.
function buildPhotoPrompt(productName, note) {
  const name = String(productName || "").trim();
  const base = name
    ? `This product is: "${name}". Recognise this EXACT product and reproduce its GENUINE, accurate design ` +
      `— the real product's correct logos, branding, colourway, patterns, materials, text and proportions. ` +
      `Use the source photo as the primary reference TOGETHER with your knowledge of this exact product; ` +
      `sharpen, complete and correct anything blurry, low-quality, partial or unclear so it matches the ` +
      `authentic product. Do NOT substitute a different model, colour or design, and do NOT invent details ` +
      `the real product does not have. ` + PHOTO_PROMPT
    : PHOTO_PROMPT;
  // Per-run fix instruction (studio note / fix chips). Put it FIRST and flag it as
  // the priority so the engine focuses on exactly what to fix this time, while all
  // the standard rules below still apply.
  const hint = String(note || "").trim();
  if (!hint) return base;
  return `PRIORITY FIX FOR THIS REGENERATION — ${hint}. Apply this above all else, then: ${base}`;
}

// PROVIDER BOUNDARY: given image bytes + the per-product prompt, return { buffer,
// usage } of a white-bg re-shoot. Swap the body to change image providers.
async function generateWhiteBgImage(client, OpenAINS, imageBuffer, contentType, quality, size, prompt) {
  const toFile = OpenAINS.toFile || (OpenAINS.default && OpenAINS.default.toFile);
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const file = await toFile(imageBuffer, `product.${ext}`, { type: contentType });
  const res = await client.images.edit({
    model: PHOTO_MODEL,
    image: file,
    prompt: prompt || PHOTO_PROMPT,
    size: size || PHOTO_SIZE,
    quality,
    output_format: "jpeg",   // match the .jpg/image-jpeg upload (gpt-image-1 defaults to PNG)
  });
  const b64 = res && res.data && res.data[0] && res.data[0].b64_json;
  if (!b64) throw new Error("image model returned no image");
  return { buffer: Buffer.from(b64, "base64"), usage: res.usage || {} };
}

function estimateImageCostUSD(usage) {
  const d = (usage && usage.input_tokens_details) || {};
  const textIn  = d.text_tokens  || 0;
  const imageIn = d.image_tokens || ((usage && usage.input_tokens) || 0); // fall back to total input
  const out     = (usage && usage.output_tokens) || 0;
  return +(
    (textIn  / 1e6) * OAI_TEXT_IN_PER_MTOK +
    (imageIn / 1e6) * OAI_IMAGE_IN_PER_MTOK +
    (out     / 1e6) * OAI_IMAGE_OUT_PER_MTOK
  ).toFixed(6);
}

// ── GEMINI engine — "Nano Banana" (gemini-2.5-flash-image, NOT Pro) ────────────
// Cheap image-edit workhorse (~$0.039/image). Same job as the OpenAI engine: takes
// the product photo + the white-bg "keep the product EXACTLY" prompt, returns the
// edited image. Raw REST (Node-22 global fetch — no SDK dependency). The image
// comes back as base64 inline_data SOMEWHERE in candidates[0].content.parts — we
// ITERATE the parts (don't assume an index), since a response may also carry text.
const GEMINI_MODEL          = "gemini-2.5-flash-image";
const GEMINI_OUT_PER_MTOK   = 30;      // $/1M image-output tokens (Nano Banana)
const GEMINI_FLAT_IMAGE_USD = 0.039;   // fallback per-image when usageMetadata is absent
async function generateWhiteBgImageGemini(apiKey, imageBuffer, contentType, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt || PHOTO_PROMPT },
            { inline_data: { mime_type: contentType, data: imageBuffer.toString("base64") } },
          ],
        }],
      }),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`gemini HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const parts = ((((json.candidates || [])[0] || {}).content) || {}).parts || [];
  let b64 = null, mime = "image/png";
  for (const part of parts) {                       // image lives in inline_data among the parts
    const inl = part.inlineData || part.inline_data; // REST returns camelCase; accept both
    if (inl && inl.data) { b64 = inl.data; mime = inl.mimeType || inl.mime_type || mime; break; }
  }
  if (!b64) throw new Error("gemini returned no image");
  // Cost: image-output tokens × Nano-Banana rate, else the documented flat per-image.
  const um = json.usageMetadata || {};
  const outTok = um.candidatesTokenCount || 0;
  const costUSD = outTok ? +((outTok / 1e6) * GEMINI_OUT_PER_MTOK).toFixed(6) : GEMINI_FLAT_IMAGE_USD;
  return { buffer: Buffer.from(b64, "base64"), costUSD, mime };
}

// ── Pluggable engine adapter ───────────────────────────────────────────────────
// One interface, two providers. generate(buffer, contentType, { quality, size }) →
// { buffer, costUSD, mime }. Add an engine here; the orchestration never special-
// cases a provider. `makeEngine` is lazy + cached per call.
function makeEngine(name, openaiClient, OpenAINS) {
  if (name === "gemini") {
    const key = geminiApiKey.value();
    return { name: "gemini", generate: (buf, ct, { prompt } = {}) => generateWhiteBgImageGemini(key, buf, ct, prompt) };
  }
  return {
    name: "openai",
    async generate(buf, ct, { quality, size, prompt } = {}) {
      const { buffer, usage } = await generateWhiteBgImage(openaiClient, OpenAINS, buf, ct, quality, size, prompt);
      return { buffer, costUSD: estimateImageCostUSD(usage), mime: "image/jpeg" };
    },
  };
}

// DEFAULT engine per product, by category (overridable per call via data.engine):
//   Footwear + Clothing → Gemini (clean edges, strong professional studio look).
//   Accessories / Perfume default OpenAI for now.
function defaultEngineFor(product) {
  const c = product && product.category;
  return c === "Footwear" || c === "Clothing" ? "gemini" : "openai";
}

const PHOTO_MAX_BYTES = 15 * 1024 * 1024; // 15 MB cap on a product image
async function fetchImageBuffer(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error("invalid image url"); }
  // SSRF guard: only https Google Storage hosts (where our photoUrls live); no redirects.
  if (u.protocol !== "https:" || !/\.googleapis\.com$/.test(u.hostname)) throw new Error("untrusted image host");
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > PHOTO_MAX_BYTES) throw new Error("image too large");
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > PHOTO_MAX_BYTES) throw new Error("image too large");
  const ct = (res.headers.get("content-type") || "image/jpeg").toLowerCase();
  return { buffer, contentType: ct.startsWith("image/") ? ct : "image/jpeg" };
}

// Upload a buffer to Storage with a Firebase download token; return the public-style
// URL. `mime` matches the engine's output (OpenAI → jpeg; Gemini → usually png) so
// the stored object + content-type are honest and the browser renders it correctly.
async function uploadProposalImage(id, buffer, mime = "image/jpeg") {
  const token = require("crypto").randomUUID();
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  // Unique per generation so a later reprocess can't mutate an already-approved live
  // image (which points at this object) before its own approval.
  const path = `products/${id}/photo_proposal_${token}.${ext}`;
  await admin.storage().bucket(STORAGE_BUCKET).file(path).save(buffer, {
    resumable: false,
    contentType: mime,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// Trim the white border then CENTRE the product on a uniform white SQUARE canvas
// with a consistent margin — so every catalogue image is the same size + scale and
// a grid of them looks even (fixes "some zoomed in, some further back, some cut
// off"). Best-effort: on any failure, return the engine's raw output unchanged.
const CATALOGUE_CANVAS = 1500;   // output square, px
const CATALOGUE_FILL   = 0.86;   // product fills ~86% of the canvas
const CATALOGUE_TRIM   = 15;     // trim tolerance from pure white (handles near-white 252-254 the model can emit)
// Gentle contrast applied as out = in*slope + intercept (clamped 0-255), tuned so
// the FIXED POINT sits high (~240): pure white (255) clamps back to 255 → the
// background stays perfectly white, and pale/off-white products (~235+, e.g. the
// Edge Runner Off-White reference) barely move and stay separated from the bg —
// while everything below deepens, so black/charcoal/navy products read RICH and
// DARK instead of washing out to grey on white.
const DARK_SLOPE = 1.10, DARK_INTERCEPT = -24;

// Place an (already-cropped) product image CENTRED on a uniform white square at the
// fixed fill ratio + run the dark-strengthen pass. Every catalogue image goes
// through this, so they all share the SAME canvas size, scale and margin → an even grid.
async function placeOnWhiteSquare(sharp, innerBuffer) {
  const white = { r: 255, g: 255, b: 255 };
  const box = Math.round(CATALOGUE_CANVAS * CATALOGUE_FILL);
  const fit = await sharp(innerBuffer).resize(box, box, { fit: "inside", withoutEnlargement: false }).toBuffer({ resolveWithObject: true });
  return sharp({ create: { width: CATALOGUE_CANVAS, height: CATALOGUE_CANVAS, channels: 3, background: white } })
    .composite([{ input: fit.data, left: Math.round((CATALOGUE_CANVAS - fit.info.width) / 2), top: Math.round((CATALOGUE_CANVAS - fit.info.height) / 2) }])
    .linear(DARK_SLOPE, DARK_INTERCEPT)
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function normalizeForCatalogue(buffer, fallbackMime) {
  const sharp = require("sharp");
  const white = { r: 255, g: 255, b: 255 };
  // 1. Flatten alpha onto white + trim the near-white border to a tight crop, so
  //    every product fills the SAME proportion of the canvas (fixes "some zoomed,
  //    some further back"). If trim fails, fall back to the flattened raw — we
  //    still square it below, so the output is NEVER a raw rectangle.
  let inner = null;
  try {
    inner = await sharp(buffer).flatten({ background: white }).trim({ background: white, threshold: CATALOGUE_TRIM }).toBuffer();
  } catch (e) {
    console.warn("normalizeForCatalogue trim failed, squaring untrimmed:", e && e.message);
  }
  // 2. Always emit a uniform 1500² square (this is what keeps the grid even — a raw
  //    1024×1536 passthrough was what made it look uneven and wasted generations).
  try {
    const src = inner || await sharp(buffer).flatten({ background: white }).toBuffer();
    const out = await placeOnWhiteSquare(sharp, src);
    return { buffer: out, mime: "image/jpeg" };
  } catch (e) {
    console.warn("normalizeForCatalogue failed, using raw output:", e && e.message);
    return { buffer, mime: fallbackMime || "image/jpeg" };
  }
}

exports.generateProductPhotos = onCall(
  {
    region: "europe-west1",
    secrets: [openaiApiKey, geminiApiKey],
    memory: "1GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    assertAdmin(request);
    const db = admin.database();
    const data = request.data || {};
    // Hard cap so a large/duplicated request can't fan out a huge, expensive run.
    const wanted = Number.isFinite(+data.limit) && +data.limit > 0 ? Math.floor(+data.limit) : PHOTO_DEFAULT_LIMIT;
    const limit = Math.min(wanted, PHOTO_MAX_BATCH);
    const quality = ["low", "medium", "high"].includes(data.quality) ? data.quality : PHOTO_DEFAULT_QUALITY;
    // Per-call engine OVERRIDE (studio "compare" / per-product re-run). When absent,
    // each product is auto-routed by category (defaultEngineFor): Footwear → Gemini,
    // everything else → OpenAI.
    const engineOverride = ["openai", "gemini"].includes(data.engine) ? data.engine : null;
    // Optional per-run instruction (the studio "regenerate note" / fix chips) — a
    // short, sanitised hint appended to the prompt so the engine knows what to fix.
    const note = typeof data.note === "string"
      ? data.note.replace(/[^\x20-\x7E\u00A0-\uFFFF]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240)
      : "";

    const [prodSnap, propSnap] = await Promise.all([
      db.ref("products").once("value"),
      db.ref(PHOTO_PROPOSALS_PATH).once("value"),
    ]);
    const products = prodSnap.val() || {};
    const existing = propSnap.val() || {};

    let ids;
    if (Array.isArray(data.productIds) && data.productIds.length) {
      ids = [...new Set(data.productIds)].filter((id) => products[id] && products[id].photoUrl).slice(0, PHOTO_MAX_BATCH);
    } else {
      ids = Object.keys(products).filter((id) => {
        const p = products[id];
        if (!p || !p.photoUrl) return false;
        // Match either the new `category` (e.g. "Footwear") OR the legacy productType
        // (e.g. "clothing"), so old and new callers both work.
        if (data.category && p.category !== data.category && (p.productType || "") !== data.category) return false;
        if (!data.reprocess && existing[id]) return false;
        return true;
      });
      ids.sort();
      ids = ids.slice(0, limit);
    }

    const OpenAINS = require("openai");
    const OpenAI = OpenAINS.default || OpenAINS;
    const openaiClient = new OpenAI({ apiKey: openaiApiKey.value() });
    // Lazy, cached engines — only the providers actually used get built.
    const engineCache = {};
    const getEngine = (name) => (engineCache[name] || (engineCache[name] = makeEngine(name, openaiClient, OpenAINS)));

    let processed = 0, failed = 0, estCostUSD = 0;
    const costByEngine = { openai: 0, gemini: 0 };
    const sample = [];

    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        const p = products[id];
        const engName = engineOverride || defaultEngineFor(p);
        try {
          const { buffer, contentType } = await fetchImageBuffer(p.photoUrl);
          // OpenAI uses a portrait frame for tall garments; Gemini ignores size.
          const size = (p.category === "Clothing" || p.productType === "clothing") ? "1024x1536" : PHOTO_SIZE;
          const prompt = buildPhotoPrompt(p.name, note);   // name-aware + optional per-run fix note
          const { buffer: rawBuf, costUSD, mime: rawMime } = await getEngine(engName).generate(buffer, contentType, { quality, size, prompt });
          // Trim + centre on a uniform white square so the catalogue grid is consistent.
          const { buffer: outBuf, mime } = await normalizeForCatalogue(rawBuf, rawMime);
          const proposedUrl = await uploadProposalImage(id, outBuf, mime);
          estCostUSD += costUSD;
          costByEngine[engName] = +(costByEngine[engName] + costUSD).toFixed(6);
          await db.ref(`${PHOTO_PROPOSALS_PATH}/${id}`).set({
            // Prefer the TRUE original: if this product was already approved once,
            // p.photoUrl is a generated image — keep the real original from photoUrlOriginal.
            originalUrl: p.photoUrlOriginal || p.photoUrl,
            proposedUrl,
            name: p.name || "",
            productType: p.productType || null,
            engine: engName,                 // which engine made THIS proposal
            costUSD: +costUSD.toFixed(6),     // its per-image cost
            status: "pending",          // pending | approved | rejected (set by the review UI)
            at: Date.now(),
            by: request.auth.uid,
          });
          processed++;
          if (sample.length < 20) sample.push({ id, name: p.name || "", proposedUrl, engine: engName });
        } catch (err) {
          failed++;
          console.warn(`generateProductPhotos: ${id} (${engName}) failed:`, err && err.message);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PHOTO_CONCURRENCY, ids.length || 1) }, worker));

    estCostUSD = +estCostUSD.toFixed(4);
    const today = new Date().toISOString().slice(0, 10);
    await logReorderUsage(db, today, {
      at: Date.now(), kind: "generateProductPhotos", by: request.auth.uid,
      imagesGenerated: processed, failed, quality, estimatedCostUSD: estCostUSD,
      engine: engineOverride || "auto", costByEngine,
    });

    return { processed, failed, total: ids.length, estCostUSD, costByEngine, sample };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Chat proxy (marathon-ai frontend → Anthropic) — Phase 3 backend
// ─────────────────────────────────────────────────────────────────────────────
// chatStream is the server-side proxy for marathon-ai's chat view. The
// frontend cannot call Anthropic directly because doing so would bundle the
// API key into a publicly-fetchable JS file on marathon-club-ai.web.app
// (Firebase Hosting is static, no auth gate on assets). This function keeps
// the key inside Secret Manager and exposes a thin SSE streaming endpoint.
//
// Flow on each request:
//   1. Verify the Firebase ID token in the Authorization header. Reject if
//      missing/invalid OR if the verified email isn't ADMIN_EMAIL.
//   2. Read /orders, /insights_log, /insights/reorderPlan/latest. Take the
//      most recent CHAT_CONTEXT_RECENT_LIMIT entries from orders + logs
//      (full plan is small enough to send whole).
//   3. Build the system prompt with the spec'd Marathon-business preamble
//      plus the live context as compact JSON.
//   4. Open an Anthropic streaming session and pipe text deltas to the
//      client as SSE events.
//
// SSE event shape (all events are JSON in the `data:` field):
//   { type: "context", summary: { ordersSent, logsSent, planGeneratedAt } }
//   { type: "token",   text: "..." }
//   { type: "done",    usage: { input_tokens, output_tokens } }
//   { type: "error",   message: "..." }
//
// CORS: allowlist (production hosting + Vite dev ports). Preflight handled.
// Body: { messages: [{ role, content }, ...] } — Anthropic message format.
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_MODEL                  = "claude-sonnet-4-6";
const CHAT_MAX_TOKENS             = 4096;
const CHAT_CONTEXT_RECENT_LIMIT   = 100;
const CHAT_ALLOWED_ORIGINS = new Set([
  "https://marathon-club-ai.web.app",
  "http://localhost:5174",
  "http://localhost:5173",
]);

function chatSystemPrompt({ orders, logs, plan }) {
  const recent = (obj, limit) => {
    const arr = Object.values(obj || {}).filter(v => v && typeof v === "object");
    arr.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    return arr.slice(0, limit);
  };
  const recentOrders = recent(orders, CHAT_CONTEXT_RECENT_LIMIT);
  const recentLogs   = recent(logs,   CHAT_CONTEXT_RECENT_LIMIT);

  return `You are an AI business assistant for Marathon, a sneaker retail store in Durban, South Africa with 3 locations (Pine, PE, Trophy). You have access to the store's current data including orders, stock depletions, and AI reorder analysis. Answer questions about inventory, sales patterns, reorder decisions, and business strategy. Be direct and specific — this is a working tool, not a demo.

LIVE STORE DATA (snapshot at the start of this turn):

Recent orders (most recent ${recentOrders.length} of ${Object.keys(orders || {}).length} total):
${JSON.stringify(recentOrders)}

Recent insights events (most recent ${recentLogs.length} of ${Object.keys(logs || {}).length} total):
${JSON.stringify(recentLogs)}

Latest AI reorder plan${plan?.generatedAt ? ` (generated ${new Date(plan.generatedAt).toISOString()})` : ""}:
${plan ? JSON.stringify(plan) : "No plan has been generated yet."}`;
}

exports.chatStream = onRequest(
  {
    region: "europe-west1",
    secrets: [anthropicApiKey],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (req, res) => {
    // ── CORS — manual because SSE responses need streaming-friendly headers.
    const origin = req.headers.origin || "";
    if (CHAT_ALLOWED_ORIGINS.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Max-Age", "3600");
      return res.status(204).send("");
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ── Auth: verify Firebase ID token + email allowlist.
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: "Missing Authorization bearer token." });
    }
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      console.warn("chatStream: token verification failed:", err.code || err.message);
      return res.status(401).json({ error: "Invalid or expired token." });
    }
    if (decoded.email !== ADMIN_EMAIL) {
      console.warn(`chatStream: forbidden caller ${decoded.email}`);
      return res.status(403).json({ error: "Forbidden." });
    }

    // ── Validate body.
    const messages = req.body && req.body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages must be a non-empty array." });
    }

    // ── Load live context. RTDB reads under Admin SDK bypass security rules.
    const db = admin.database();
    let ordersSnap, logsSnap, planSnap;
    try {
      [ordersSnap, logsSnap, planSnap] = await Promise.all([
        db.ref("orders").once("value"),
        db.ref("insights_log").once("value"),
        db.ref("insights/reorderPlan/latest").once("value"),
      ]);
    } catch (err) {
      console.error("chatStream: context read failed:", err.message);
      return res.status(503).json({ error: "Could not load store context." });
    }

    const orders = ordersSnap.val() || {};
    const logs   = logsSnap.val()   || {};
    const plan   = planSnap.val()   || null;
    const ordersCount = Object.keys(orders).length;
    const logsCount   = Object.keys(logs).length;
    const ordersSent  = Math.min(ordersCount, CHAT_CONTEXT_RECENT_LIMIT);
    const logsSent    = Math.min(logsCount,   CHAT_CONTEXT_RECENT_LIMIT);

    // ── Open the SSE stream. From here on, errors are reported as SSE events
    // (HTTP headers have already been sent, so 4xx/5xx is no longer an option).
    res.set("Content-Type", "text/event-stream");
    res.set("Cache-Control", "no-cache");
    res.set("Connection", "keep-alive");
    res.set("X-Accel-Buffering", "no"); // tell any intermediate proxy not to buffer
    res.flushHeaders?.();

    const sse = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    sse({
      type: "context",
      summary: {
        ordersTotal:           ordersCount,
        ordersSent,
        insightsLogTotal:      logsCount,
        insightsLogSent:       logsSent,
        reorderPlanGeneratedAt: plan?.generatedAt || null,
        reorderPlanPresent:    !!plan,
      },
    });

    const system = chatSystemPrompt({ orders, logs, plan });

    const AnthropicCtor = Anthropic.default || Anthropic;
    const client = new AnthropicCtor({ apiKey: anthropicApiKey.value() });

    try {
      const stream = await client.messages.stream({
        model: CHAT_MODEL,
        max_tokens: CHAT_MAX_TOKENS,
        system,
        messages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          sse({ type: "token", text: event.delta.text });
        }
      }

      const final = await stream.finalMessage();
      const usage = final?.usage || {};
      sse({
        type: "done",
        usage: {
          input_tokens:  usage.input_tokens  || 0,
          output_tokens: usage.output_tokens || 0,
        },
      });
      console.log(`chatStream: completed for ${decoded.email}, tokens in/out: ${usage.input_tokens || 0}/${usage.output_tokens || 0}`);
    } catch (err) {
      const status = err && err.status;
      console.error("chatStream: Anthropic call failed:", status, err.message);
      // Errors after headers flushed must come back as SSE events, not HTTP.
      sse({ type: "error", message: err.message || `AI service error${status ? ` (HTTP ${status})` : ""}.` });
    }

    res.end();
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Staff user management (super-admin only)
// ─────────────────────────────────────────────────────────────────────────────
// Three callable functions for super-admin-only staff user lifecycle. The
// Firebase Auth client SDK can't create or delete users — only this admin
// SDK path can — so the UI at /#admin/users calls these instead of touching
// auth directly. /users/{uid} reads/writes for permission edits go straight
// to RTDB from the client (no Cloud Function needed); these only handle
// auth-side operations + paired /users record creation/deletion.
//
// Auth gate: assertAdmin (mirrors analyzeReorderNeeds + broadcast functions).
// Token transforms: toAuthPassword + usernameToEmail from ./lib/auth-utils.cjs
// (the same module Login.jsx imports its ES-module mirror from).

const VALID_PERMISSIONS = [
  "store_assistant", "warehouse",   "source",       "display_refills",
  "place_orders",    "product_admin","insights",    "broadcast",
  "customer_data",   "user_management",
];
const VALID_ROLES = ["admin", "store_assistant", "warehouse"];

// ─── PICKUP-BOARD VOICE (natural TTS) ─────────────────────────────────────────
// One callable, pluggable engines for the TV pickup board's spoken announcements:
//   • openai      — tts-1 (bound OPENAI_API_KEY), voice nova/coral/…
//   • elevenlabs  — most human; key read at RUNTIME from Secret Manager so the
//                   function deploys BEFORE the key exists and ACTIVATES the moment
//                   ELEVENLABS_API_KEY is created (no redeploy). Absent ⇒ inactive.
//   • browser     — client-side speechSynthesis (handled on the TV, not here).
// Each generated clip is CACHED in Storage per engine+voice+text, so after the
// first generation an announcement replays instantly and free. Text is locked to
// the pickup-announcement shape so it can't be abused for arbitrary paid TTS.
const OPENAI_TTS_MODEL = "tts-1";
const OPENAI_TTS_COST_PER_MCHAR = 15;                 // $15 / 1M chars (tts-1)
const ELEVEN_MODEL = "eleven_turbo_v2_5";
const ELEVEN_DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";  // "Sarah" — clear, friendly
const ELEVEN_COST_PER_KCHAR = 0.10;                   // ≈ turbo pricing (approx, for logging)
const VOICE_TEXT_RE = /^(Order number .{1,24}, ready for collection\.?|Pickup announcements on\.?)$/;

function ttsCacheKey(engine, voice, text) {
  const t = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const v = String(voice || "default").replace(/[^a-z0-9]+/gi, "").toLowerCase();
  return `${engine}_${v}_${t}`.slice(0, 100);
}

// Runtime ElevenLabs key (NOT a bound secret — lets the function deploy before the
// key exists). Cached per instance; null when the secret is absent/unreadable.
let _elevenKey; let _elevenChecked = false;
async function getElevenKey() {
  if (_elevenChecked) return _elevenKey || null;
  _elevenChecked = true;
  try {
    const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
    const client = new SecretManagerServiceClient();
    const [v] = await client.accessSecretVersion({ name: "projects/marathon-club/secrets/ELEVENLABS_API_KEY/versions/latest" });
    _elevenKey = (v.payload.data.toString("utf8") || "").trim() || null;
  } catch { _elevenKey = null; }
  return _elevenKey;
}

async function ttsTokenUrl(file, path) {
  const [md] = await file.getMetadata();
  let token = md.metadata && md.metadata.firebaseStorageDownloadTokens;
  token = token ? String(token).split(",")[0] : null;
  if (!token) { token = require("crypto").randomUUID(); await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } }); }
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

exports.pickupVoice = onCall(
  { region: "europe-west1", secrets: [openaiApiKey], memory: "256MiB", timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
    const data = request.data || {};

    // Status probe for the admin selector: which engines are usable right now.
    if (data.status) {
      return { engines: { browser: true, openai: true, elevenlabs: !!(await getElevenKey()) } };
    }

    const text = String(data.text || "").trim();
    const engine = ["openai", "elevenlabs"].includes(data.engine) ? data.engine : "openai";
    const voice = String(data.voice || "").trim().slice(0, 40);
    if (!VOICE_TEXT_RE.test(text)) throw new HttpsError("invalid-argument", "Unsupported announcement text.");

    const bucket = admin.storage().bucket(STORAGE_BUCKET);
    const path = `tts/${ttsCacheKey(engine, voice, text)}.mp3`;
    const file = bucket.file(path);

    const [exists] = await file.exists();
    if (exists) return { url: await ttsTokenUrl(file, path), engine, cached: true, costUSD: 0 };

    let buf, costUSD = 0;
    if (engine === "elevenlabs") {
      const k = await getElevenKey();
      if (!k) throw new HttpsError("failed-precondition", "elevenlabs_inactive"); // TV falls back to Browser
      const vid = voice || ELEVEN_DEFAULT_VOICE;
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": k, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
      });
      if (!res.ok) throw new HttpsError("internal", `elevenlabs ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
      buf = Buffer.from(await res.arrayBuffer());
      costUSD = +((text.length / 1000) * ELEVEN_COST_PER_KCHAR).toFixed(6);
    } else {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openaiApiKey.value()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: voice || "nova", input: text, response_format: "mp3" }),
      });
      if (!res.ok) throw new HttpsError("internal", `openai tts ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
      buf = Buffer.from(await res.arrayBuffer());
      costUSD = +((text.length / 1e6) * OPENAI_TTS_COST_PER_MCHAR).toFixed(6);
    }

    const token = require("crypto").randomUUID();
    await file.save(buf, { resumable: false, contentType: "audio/mpeg", metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
    const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    try { await logReorderUsage(admin.database(), new Date().toISOString().slice(0, 10), { at: Date.now(), kind: "pickupVoice", by: request.auth.uid, engine, chars: text.length, costUSD }); } catch { /* best-effort */ }
    return { url, engine, cached: false, costUSD };
  }
);

exports.createStaffUser = onCall(
  { region: "europe-west1" },
  async (request) => {
    assertAdmin(request);

    const { username, displayName, pin, role, permissions } = request.data || {};

    // ── Validate ──────────────────────────────────────────────────────────
    if (typeof username !== "string" || !/^[a-z0-9_]{1,30}$/.test(username)) {
      throw new HttpsError("invalid-argument", "Username must be 1-30 chars, lowercase letters/digits/underscore only.");
    }
    if (typeof displayName !== "string" || displayName.trim().length < 1 || displayName.length > 50) {
      throw new HttpsError("invalid-argument", "Display name must be 1-50 chars.");
    }
    if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
      throw new HttpsError("invalid-argument", "PIN must be exactly 4 digits.");
    }
    if (!VALID_ROLES.includes(role)) {
      throw new HttpsError("invalid-argument", `Role must be one of: ${VALID_ROLES.join(", ")}.`);
    }
    if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string" || !VALID_PERMISSIONS.includes(p))) {
      throw new HttpsError("invalid-argument", `Permissions must be an array of: ${VALID_PERMISSIONS.join(", ")}.`);
    }
    const cleanDisplayName = displayName.trim();

    // ── Username collision check via Firebase Auth ───────────────────────
    const email = usernameToEmail(username);
    let collision = false;
    try {
      await admin.auth().getUserByEmail(email);
      collision = true;
    } catch (err) {
      if (err.code !== "auth/user-not-found") {
        console.error("createStaffUser: getUserByEmail unexpected error:", err);
        throw new HttpsError("internal", "Could not verify username availability.");
      }
    }
    if (collision) {
      throw new HttpsError("already-exists", `Username "${username}" is already taken.`);
    }

    // ── Create the Firebase Auth user. The getUserByEmail preflight above
    //    closes the common case, but it's racy: two concurrent creates with
    //    the same username can both pass the preflight, then one createUser
    //    fails with auth/email-already-exists. Preserve the already-exists
    //    contract here so the UI can render the right field-level error. ──
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email,
        password: toAuthPassword(pin),
        displayName: cleanDisplayName,
      });
    } catch (err) {
      if (err.code === "auth/email-already-exists") {
        throw new HttpsError("already-exists", `Username "${username}" is already taken.`);
      }
      console.error("createStaffUser: createUser failed:", err);
      throw new HttpsError("internal", "Could not create Firebase Auth user.");
    }

    // ── Write the /users/{uid} record. On failure, roll back the auth user
    //    so we never leave an orphan account that can sign in but has no
    //    permissions record. ──────────────────────────────────────────────
    try {
      await admin.database().ref(`users/${userRecord.uid}`).set({
        username,
        displayName: cleanDisplayName,
        role,
        permissions,
        createdAt: admin.database.ServerValue.TIMESTAMP,
      });
    } catch (err) {
      console.error("createStaffUser: /users write failed — rolling back auth user:", err);
      try { await admin.auth().deleteUser(userRecord.uid); }
      catch (rollbackErr) { console.error("createStaffUser: rollback also failed:", rollbackErr); }
      throw new HttpsError("internal", "Could not persist user record.");
    }

    return { uid: userRecord.uid, username, displayName: cleanDisplayName };
  }
);

exports.deleteStaffUser = onCall(
  { region: "europe-west1" },
  async (request) => {
    assertAdmin(request);

    const { uid } = request.data || {};
    if (typeof uid !== "string" || !uid) {
      throw new HttpsError("invalid-argument", "uid is required.");
    }

    // ── Self-deletion guard. The super-admin uses a Google account with the
    //    ADMIN_EMAIL address; if anyone ever tampers with /users to include
    //    that email, this stops a UI mis-click from locking the org out. ──
    let target;
    try {
      target = await admin.auth().getUser(uid);
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        throw new HttpsError("not-found", "User not found.");
      }
      console.error("deleteStaffUser: getUser failed:", err);
      throw new HttpsError("internal", "Could not look up user.");
    }
    if (target.email === ADMIN_EMAIL) {
      throw new HttpsError("failed-precondition", "Cannot delete the super-admin account.");
    }

    // ── /users record first, auth user second. If auth-delete fails after
    //    the RTDB delete, the user can no longer access role-gated views
    //    (no /users record → no permissions). ──────────────────────────
    try {
      await admin.database().ref(`users/${uid}`).remove();
    } catch (err) {
      console.error("deleteStaffUser: /users remove failed:", err);
      throw new HttpsError("internal", "Could not remove user record.");
    }
    try {
      await admin.auth().deleteUser(uid);
    } catch (err) {
      console.error("deleteStaffUser: deleteUser failed (but /users already removed):", err);
      throw new HttpsError("internal", "Could not delete Firebase Auth user. The /users record was already removed; manual cleanup may be required.");
    }

    return { success: true };
  }
);

exports.updateStaffPassword = onCall(
  { region: "europe-west1" },
  async (request) => {
    assertAdmin(request);

    const { uid, pin } = request.data || {};
    if (typeof uid !== "string" || !uid) {
      throw new HttpsError("invalid-argument", "uid is required.");
    }
    if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
      throw new HttpsError("invalid-argument", "PIN must be exactly 4 digits.");
    }

    try {
      await admin.auth().updateUser(uid, { password: toAuthPassword(pin) });
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        throw new HttpsError("not-found", "User not found.");
      }
      console.error("updateStaffPassword: updateUser failed:", err);
      throw new HttpsError("internal", "Could not update PIN.");
    }

    return { success: true };
  }
);
