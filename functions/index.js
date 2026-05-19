const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const { toAuthPassword, usernameToEmail } = require("./lib/auth-utils.cjs");

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

async function handlePost(req, res) {
  const body = req.body || {};
  console.log("sendWhatsApp request:", JSON.stringify({
    templateName:  body.templateName,
    recipientPhone: body.recipientPhone,
    paramCount:    (body.templateParams || []).length,
  }));

  const { templateName, recipientPhone, templateParams = [] } = body;

  if (!templateName || !recipientPhone) {
    console.warn("Missing required fields:", { templateName, recipientPhone });
    return res.status(400).json({ error: "templateName and recipientPhone are required" });
  }

  const to = normaliseSAPhone(recipientPhone);
  console.log("Sending template:", templateName, "to:", to, "params:", templateParams);

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

  console.log("Meta API payload:", JSON.stringify(payload));

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
    console.error("Fetch to Meta API failed:", err.message);
    return res.status(502).json({ error: "Could not reach WhatsApp API", detail: err.message });
  }

  console.log("Meta API response status:", waRes.status, "body:", JSON.stringify(json));

  if (!waRes.ok) {
    const metaCode    = json?.error?.code;
    const metaMessage = json?.error?.message || "WhatsApp API call failed";
    const metaType    = json?.error?.type || "";

    if (metaCode === 190) {
      console.error("TOKEN EXPIRED — rotate Meta token in Business Manager, then: gcloud secrets versions add meta-whatsapp-token --data-file=<file> --project=marathon-club && firebase deploy --only functions:sendWhatsApp");
      return res.status(401).json({
        error: "WhatsApp token expired or invalid. Rotate the meta-whatsapp-token secret in Secret Manager (marathon-club) and redeploy sendWhatsApp.",
        metaCode,
        metaMessage,
      });
    }

    // For template/param errors (not auth errors), return 200 with success:false
    // so the browser doesn't see a 502 and the app continues without interruption.
    console.warn("Meta API soft error (non-auth):", JSON.stringify(json));
    return res.status(200).json({ success: false, metaCode, metaMessage, detail: json });
  }

  const messageId = json.messages?.[0]?.id ?? null;
  console.log("WhatsApp sent successfully:", templateName, "to:", to, "msgId:", messageId);
  return res.json({ success: true, messageId });
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
// analyzeReorderNeeds is a Gen 2 admin-only callable that ingests the store's
// full operational history (every product, every order, every insights_log
// entry) and asks Claude Sonnet 4.6 to produce a structured reorder plan for
// the upcoming 45-day cycle. The flow:
//
//   1. Gate the call:
//      a) /insights/reorderPlan/status — reject if state === "running" within
//         REORDER_CONCURRENT_LOCK_MS (concurrent-run protection).
//      b) /insights/reorderPlan/latest — reject if generatedAt is within
//         REORDER_RATE_LIMIT_MS, unless the super-admin passes { force: true }.
//   2. Write state = "running" to /insights/reorderPlan/status so the UI can
//      reflect progress without holding the callable open for the full run.
//   3. Read /products, /orders, /insights_log in parallel — no time filter.
//   4. Aggregate per-product lifetime stats AND a recent-60-day slice so the
//      model can weight recent trends without losing all-time signal. Also
//      surface SLOW MOVERS — stocked products with little/no sales activity.
//   5. Pre-filter out products with zero activity ever. If more than 200
//      remain, sort by composite activity score and cap at the top 200,
//      surfacing the pagination state in dataQualityNotes.
//   6. Read the admin's businessContext memory (manually seeded via the
//      Firebase console) and include it in the system prompt.
//   7. Call Claude with a strict-JSON instruction and parse the response.
//      One retry on parse failure with a tightening prompt.
//   8. Write the full { plan, meta } to /insights/reorderPlan/latest so the
//      UI can render from cache between runs (and survive 70 s callable
//      client-timeouts — the UI fire-and-forgets the call and polls RTDB).
//   9. Log token counts, cost estimate, and pagination state to
//      /aiAssistant/usage/{YYYY-MM-DD}/{pushKey} — no API key, no full prompt.
//  10. Write state = "idle" (or "error") to /insights/reorderPlan/status in a
//      finally block so the UI is never left thinking a run is still active.
//
// The callable still returns { plan, meta } on success for the rare case a
// caller actually awaits — the UI doesn't, but the contract is preserved.
//
// Sizing: this is a heavy-compute, owner-triggered tool. 1 GiB memory and
// 900 s timeout cover full-history aggregation for typical catalog sizes.
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
      const estimatedCostUSD = +(
        (inputTokens  / 1e6) * PRICE_INPUT_PER_MTOK +
        (outputTokens / 1e6) * PRICE_OUTPUT_PER_MTOK
      ).toFixed(6);

      const durationMs = Date.now() - startedAt;
      const today = saDateStringFromMs(Date.now());
      try {
        await db.ref(`aiAssistant/usage/${today}`).push({
          timestamp: new Date().toISOString(),
          callerEmail,
          model: REORDER_MODEL,
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
      } catch (err) {
        console.warn("analyzeReorderNeeds: usage log write failed:", err.message);
      }

      const meta = {
        reportDate: today,
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
      //     means the reader never sees idle without a fresh result.
      try {
        await db.ref(REORDER_LATEST_PATH).set({
          plan: parsed,
          meta,
          generatedAt: Date.now(),
          generatedBy: callerUid,
          durationMs,
        });
        console.log(`analyzeReorderNeeds: Result cache written to /${REORDER_LATEST_PATH}`);
      } catch (err) {
        // Persist failure is recorded but NOT rethrown here — the caller
        // still gets { plan, meta } from this run. The finally block reads
        // persistFailed and writes status:"error" instead of "idle" so the
        // polling UI doesn't read stale /latest after seeing idle.
        persistFailed = true;
        persistError  = (err && err.message) || String(err);
        console.warn("analyzeReorderNeeds: result cache write failed:", persistError);
      }

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

const CHAT_MODEL                  = "claude-sonnet-4-20250514";
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
