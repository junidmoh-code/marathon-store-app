const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { applyCategoryPolicy } = require("./lib/category-policy-write.cjs");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onValueWritten } = require("firebase-functions/v2/database");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const { toAuthPassword, usernameToEmail } = require("./lib/auth-utils.cjs");
const reorderDemand = require("./lib/reorder-demand.cjs");
const { runHoldRevealSweep } = require("./lib/hold-reveal-sweep.cjs");
const { notifyHoldAvailability } = require("./lib/hold-availability-notify.cjs");
const { notifyOrderTomorrow } = require("./lib/order-tomorrow-notify.cjs");
const { deliverOutboxDoc } = require("./lib/outbox-deliver.cjs");

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
// HISTORY: the self-hosted gateway VM these settings were written for no
// longer exists (instance deleted; its static IP sits reserved). The primary
// sender is now the event-driven outboxInstantSend trigger below; this sweep
// is the retry lane and backstop, and FALLBACK_GRACE_SECONDS survives only as
// the sweep's minimum doc age — the "head start" it grants is now the instant
// trigger's window, no longer a gateway's.
const META_FALLBACK_ENABLED  = process.env.META_FALLBACK_ENABLED !== "false";        // default true
const FALLBACK_GRACE_SECONDS = parseInt(process.env.FALLBACK_GRACE_SECONDS, 10) || 60; // sweep's minimum doc age (see block above)
const META_MAX_ATTEMPTS      = parseInt(process.env.META_MAX_ATTEMPTS, 10) || 2;       // Meta tries before "failed"
// Separate cap for preflight (infra) failures — sends that provably never
// left the building (e.g. secret binding missing). These refund the Meta
// attempt and revert to pending, so without their own cap a permanently
// broken binding would grow the pending pool without bound and starve the
// sweep's stable limit(50) window. 240 ≈ 4 hours at the sweep's cadence.
const META_MAX_INFRA_ATTEMPTS = parseInt(process.env.META_MAX_INFRA_ATTEMPTS, 10) || 240;
// Kill switch for the event-driven outboxInstantSend trigger (default ON).
// Set INSTANT_SEND_ENABLED=false — e.g. if a self-hosted gateway ever comes
// back and should get its FALLBACK_GRACE_SECONDS head start again — and the
// system degrades to exactly the pre-trigger behaviour: the sweep alone.
// NOTE this is a BUILD-TIME switch, not a live flag: flipping it means
// creating functions/.env with the value and redeploying
// functions:outboxInstantSend. No .env file exists today, so the default is
// genuinely ON. (The other env flags above share this property.)
const INSTANT_SEND_ENABLED   = process.env.INSTANT_SEND_ENABLED !== "false";

// Normalise a South African number to E.164: +27XXXXXXXXX. Returns null when
// the input is not a recognisable SA mobile or a "+"-prefixed international
// number — callers must refuse to send rather than deliver to a mangled
// number (the old fallback happily turned "abc" into "+27" and a truncated
// "81399533" into "+2781399533"). DELIBERATELY stricter than
// src/utils/phone.js normalizeSAPhone: that one preserves malformed digits
// because it feeds display/identity; this one gates SENDING, where a
// malformed number must be a refusal, not a best effort.
function normaliseSAPhone(raw) {
  const s = String(raw || "").trim();
  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/[^\d]/g, "");
    // A "+27" that isn't a complete SA number is exactly the malformed class
    // the census found ("+2771845") — refuse it. Other country codes can't be
    // shape-validated here beyond E.164's envelope: 8–15 digits and no
    // leading 0 (no country code starts with 0).
    if (d.startsWith("27")) return /^27\d{9}$/.test(d) ? "+" + d : null;
    if (d.startsWith("0")) return null;
    return d.length >= 8 && d.length <= 15 ? "+" + d : null;
  }
  let digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^0\d{9}$/.test(digits)) digits = "27" + digits.slice(1);
  else if (/^\d{9}$/.test(digits) && !digits.startsWith("0")) digits = "27" + digits;
  return /^27\d{9}$/.test(digits) ? "+" + digits : null;
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

// Send a WhatsApp template via the Meta Graph API — the actual sender behind
// both outbox lanes (outboxInstantSend and metaFallbackSweep). `to` must
// already be E.164-normalized (the producer stores it that way). Returns
// { ok: true, messageId } on success; { ok: false, error, metaCode } on a
// failure that reached (or tried to reach) Meta; or
// { ok: false, preflight: true, error } when it can prove NOTHING was sent
// (see the guard below) — that third shape exempts the doc from the Meta
// attempt cap, so it carries a strict contract. Never throws for Meta errors,
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

  // Guard against the silently-empty secret: SecretParam.value() degrades to
  // "" (with only a warning) when the binding or its IAM grant is missing —
  // most plausibly on a freshly deployed function whose service-account grant
  // lags. Without this check the request goes out as "Bearer " and Meta's 401
  // (code 190) triggers the TOKEN EXPIRED log below, sending the operator to
  // rotate a perfectly good token.
  // preflight:true — an INFRA failure detected BEFORE any bytes reach Meta,
  // not a message failure: the doc must not burn its Meta retry budget or go
  // terminally "failed" over it (CodeRabbit, PR #388). The delivery ladder
  // refunds the attempt and reverts to "pending" under a separate infra cap.
  // ⚠ preflight may ONLY mark failures where provably NOTHING was sent — a
  // post-request failure (429, socket timeout) must never carry it, because
  // Meta may have accepted the message and a refunded retry would duplicate.
  if (!metaToken.value()) {
    return { ok: false, preflight: true, error: "meta-whatsapp-token secret not available to this function (check secret binding / IAM grant)" };
  }

  let waRes, json;
  try {
    // Explicit 30s timeout, well under the 120s invocation limit: a hung Meta
    // fetch must fail as a VALUE (revert → sweep retry, capped by
    // META_MAX_ATTEMPTS) — riding to the function kill instead would strand
    // the claimed doc in "sending" forever. Deliberately NOT preflight: the
    // request went out, Meta may have accepted, so this failure must burn the
    // Meta budget — an uncapped refund here would mint duplicates.
    waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${metaToken.value()}`,
        "Content-Type":  "application/json",
      },
      body:   JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
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
// database) for the self-hosted gateway to consume. Request contract is
// { templateName, recipientPhone, templateParams } — this no longer calls Meta
// directly. Invoked only via the authenticated onCall wrapper below; returns a
// plain result object and throws HttpsError on failure (the callable protocol
// maps those to a rejected client promise).
async function enqueueWhatsApp(data) {
  const { templateName, recipientPhone, templateParams = [] } = data || {};

  console.log("sendWhatsApp enqueue:", JSON.stringify({
    templateName,
    recipient:  maskPhone(recipientPhone),
    paramCount: templateParams.length,
  }));

  if (!templateName || !recipientPhone) {
    console.warn("Missing required fields:", { templateName, recipientPhone: maskPhone(recipientPhone) });
    throw new HttpsError("invalid-argument", "templateName and recipientPhone are required");
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
    throw new HttpsError("invalid-argument", rendered.error);
  }

  const to           = normaliseSAPhone(recipientPhone);
  if (!to) {
    console.error("sendWhatsApp rejected unusable recipient phone:", maskPhone(recipientPhone));
    // details.unusableRecipient distinguishes this PERMANENT failure from the
    // other invalid-argument causes (missing fields, template-contract) so
    // the hold-reveal sweep only treats truly-unfixable sends as terminal.
    throw new HttpsError("invalid-argument", "recipientPhone is not a usable phone number", { unusableRecipient: true });
  }
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
      return { success: true, outboxId: dup.id, status, deduped: true };
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
    return { success: true, outboxId: ref.id, status: "pending" };
  } catch (err) {
    console.error("Failed to enqueue WhatsApp outbox doc:", err.message);
    throw new HttpsError("internal", "Could not enqueue WhatsApp message");
  }
}

// Authenticated callable. Was an open onRequest HTTP endpoint that let ANYONE
// on the internet enqueue a WhatsApp send from our business number (Meta-
// suspension + spam risk — security audit finding #2). Now an onCall, so the
// Firebase platform verifies the caller's ID token; we additionally reject
// anonymous sessions (the TV/pickup board), leaving only signed-in staff.
// No secret binding: the enqueue path writes to the outbox and never calls
// Meta — the token lives only on metaFallbackSweep, which does the Meta send.
exports.sendWhatsApp = onCall(
  { region: "europe-west1" },
  async (request) => {
    const provider = request.auth?.token?.firebase?.sign_in_provider;
    if (!request.auth || provider === "anonymous") {
      throw new HttpsError("unauthenticated", "Sign-in required to send WhatsApp messages.");
    }
    return enqueueWhatsApp(request.data);
  }
);

// Claim a single outbox doc and deliver it via Meta. The claim-then-send body
// moved VERBATIM to lib/outbox-deliver.cjs so the instant trigger and the
// sweep share ONE code path and the duplicate-safety tests
// (test/outbox-deliver.test.cjs) can drive it without firebase-admin. The
// claim is a Firestore transaction acting as a mutex against every other
// claimer: it proceeds only if the doc is still "pending", so we can never
// double-send a doc someone else already grabbed. Resolves quietly — send
// errors are values and the lib catches its own status-write failures — so
// one bad doc can't abort the sweep. logPrefix labels the calling lane in
// every log line; the sweep's value keeps its historical log strings
// byte-identical for any external Cloud Logging filters.
async function processFallbackDoc(db, docRef, docId, logPrefix) {
  await deliverOutboxDoc({
    db, docRef, docId,
    sendTemplate:     sendViaMetaTemplate,
    maxAttempts:      META_MAX_ATTEMPTS,
    maxInfraAttempts: META_MAX_INFRA_ATTEMPTS,
    serverTimestamp:  () => admin.firestore.FieldValue.serverTimestamp(),
    maskPhone,
    logPrefix,
  });
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
      await processFallbackDoc(db, docSnap.ref, docSnap.id, "metaFallbackSweep");
    }
  }
);

// ─── INSTANT OUTBOX SEND — event-driven delivery (kills the polling delay) ───
// Fires the moment a doc lands in whatsapp_outbox and delivers it via Meta
// immediately, instead of leaving it for the every-minute sweep.
//
// WHY: the self-hosted gateway VM this outbox was built for NO LONGER EXISTS —
// project marathon-club has zero Compute instances and its static IP
// (marathon-broadcast-ip, 34.59.92.37) sits RESERVED, attached to nothing.
// Every one of the last 3,200 outbox docs was delivered by metaFallbackSweep,
// which by design waits FALLBACK_GRACE_SECONDS (60s, the dead gateway's head
// start) and then polls each minute — a measured 60-126s (median ~95s) added
// to EVERY customer message. This trigger removes that penalty; the sweep
// stays deployed, untouched, as the retry lane and backstop.
//
// DUPLICATE SAFETY (do not weaken): delivery goes through the SAME
// processFallbackDoc → deliverOutboxDoc claim transaction the sweep uses —
// only a "pending" doc can be claimed, and the flip to "sending" commits
// atomically, so a trigger re-fire (Firestore create events are delivered
// at-least-once), an overlapping sweep run, or any future claimer finds the
// doc non-pending and walks away. The producer-side 90s dedupe in
// enqueueWhatsApp is a separate, untouched guard on doc CREATION. retry:false
// below keeps the platform from re-running a crashed invocation on its own.
//
// CRASH WINDOWS, stated honestly: a crash BEFORE the claim commits leaves the
// doc "pending" and the sweep sends it within ~2 min. A crash AFTER the claim
// commits but before the terminal update strands the doc in "sending" — no
// claimer ever touches "sending", so there is NO duplicate, but that doc needs
// manual discovery. This gap is inherited from the sweep (same window existed
// per sweep run); per-message invocations mean more, smaller windows, not a
// new failure mode. DO NOT "fix" it by reverting stale "sending" docs to
// pending: Meta may have accepted the send just before the crash, and a
// revert would then double-send. Recovery must stay a human decision.
//
// Failure semantics are the lib's: a failed Meta send reverts the doc to
// "pending" for the SWEEP to retry (an update never re-fires this create
// trigger), terminal "failed" past META_MAX_ATTEMPTS — as before — or, for a
// preflight (infra) failure that provably sent nothing, past the separate
// META_MAX_INFRA_ATTEMPTS budget.
exports.outboxInstantSend = onDocumentCreated(
  {
    document: "whatsapp_outbox/{docId}",
    region:         "europe-west1",   // verified live: the (default) Firestore DB's locationId is europe-west1
    memory:         "256MiB",
    timeoutSeconds: 120,              // match the sweep; the 60s default would kill a slow Meta call mid-claim
    // The serial sweep was an accidental rate limiter (~1-3 Meta calls/sec,
    // one instance). Without a cap, a bulk enqueue would fan out to ~100
    // concurrent instances hammering one WhatsApp number — Meta throttles,
    // failures burn both attempts, and client-timeout-but-delivered
    // duplicates become load-correlated. 3 instances keeps Meta throughput
    // near the old profile while preserving virtually all of the latency win.
    maxInstances:   3,
    retry:          false,            // the SDK default, stated for the record — see the crash-window note above
    secrets:        [metaToken],
  },
  async (event) => {
    if (!INSTANT_SEND_ENABLED) {
      console.log("outboxInstantSend: disabled (INSTANT_SEND_ENABLED=false)");
      return;
    }
    const db = admin.firestore();
    const docId = event.params.docId;
    // Re-resolve the ref from params rather than trusting the event snapshot:
    // the claim transaction re-reads the doc anyway, so a stale snapshot can
    // never cause a send the current doc state doesn't justify.
    await processFallbackDoc(db, db.collection("whatsapp_outbox").doc(docId), docId, "outboxInstantSend");
  }
);

// Hub 2 dispatch-hold reveal sweep. A Hub 2 order marked READY holds its customer
// "order_ready" WhatsApp until notifyReadyAt (= Sent + HUB2_DISPATCH_HOLD_MS, set
// by the app) so the parcel has time to reach the shop. The warehouse tablet must
// NOT be trusted to send it later — it sleeps / closes — so the SERVER owns the
// delayed send. Every minute: send any pending order that is now due, and clear
// the flag without sending if the order left READY (reverted / OOS / collected)
// so a stale hold can never fire. enqueueWhatsApp writes to the same outbox as the
// instant path (with its own 90s dedupe), so a re-run can't double-send.
// The sweep body lives in lib/hold-reveal-sweep.cjs (moved VERBATIM — see the
// invariants documented there, incl. the COST-FIX filtered query from PR #208
// and the null-tolerant claim transaction) so the parity test suite
// (test/hold-reveal-sweep.test.cjs) can drive it without firebase-admin. This
// handler only injects the real deps; `now` is still taken inside the lib
// AFTER the query resolves, exactly as before.
exports.dispatchHoldRevealSweep = onSchedule(
  { schedule: "every 1 minutes", region: "europe-west1", timeoutSeconds: 120, memory: "256MiB" },
  async () => {
    await runHoldRevealSweep({ db: admin.database(), enqueueWhatsApp });
  }
);

// ─── ORDER TOMORROW NOTIFY (owner restoration 2026-08-19) ────────────────────
// The FOURTH order-status message, restored. order_placed / order_ready /
// rder_out_of_stock still fire from the client on their own transitions; this
// one — deleted from WarehouseView by e115cde on 2026-08-08, after which 892
// messages a month went to zero — fires again the moment staff mark an order
// COMING TOMORROW.
//
// SAME trigger, SAME template, SAME timing as before the deletion. What is NOT
// the same is the delivery: the old call was a client-side fire-and-forget,
// which is precisely the shape that once sent a customer the same message 2-5
// times and got the gateway number banned. It now hangs off the WRITE the staff
// action already makes — /orders/{orderId}/status → "coming_tomorrow" — behind
// a create-once claim, so one order is messaged exactly once, ever.
//
// NOT PR #385. That message fires at FULFIL and says the stock is here; this
// one fires at hold-placed time and says it is coming. Nothing here reads or
// writes holdLink, /refill_requests, or anything else #385 owns.
//
// Scoped to the STATUS LEAF: a re-queue that rewrites comingTomorrowAt without
// changing the status never even wakes this. enqueueWhatsApp is the same outbox
// producer with the same 90s dedupe; no new send path, no secret binding. Every
// guard and the failure handling live in lib/order-tomorrow-notify.cjs
// (node-tested, mutation-proven).
//   firebase deploy --only functions:orderTomorrowNotify
exports.orderTomorrowNotify = onValueWritten(
  {
    ref:            "/orders/{orderId}/status",
    instance:       "marathon-club-default-rtdb",
    region:         "europe-west1",
    memory:         "256MiB",
    timeoutSeconds: 60,
    // A transient enqueue failure rethrows, and the status may never change
    // again — without retries that customer is simply never told. The core
    // releases its claim BEFORE rethrowing, so a retry re-claims and re-sends;
    // every other outcome returns rather than throws, so nothing else re-drives.
    retry:          true,
  },
  async (event) => {
    await notifyOrderTomorrow({
      db:      admin.database(),
      enqueueWhatsApp,
      orderId: event.params.orderId,
      before:  event.data.before.val(),
      after:   event.data.after.val(),
    });
  }
);

// ─── HOLD AVAILABILITY NOTIFY (owner reinstatement 2026-08-19) ───────────────
// The customer WhatsApp for held items, restored — at FULFIL, when the stock is
// physically there, never at hold-placed time (the old "available tomorrow"
// send was deleted in e115cde and stays deleted).
//
// It hangs off the WRITE the Fulfil action already makes, not off the button:
// /refill_requests/{id}/status → "fulfilled". That keeps the combined refill
// list byte-identical — a hold line stays an ordinary request row with no
// badge, no order number, no customer name and no second button — and keeps the
// send off a tablet that might sleep, drop its connection, or fire twice.
//
// Scoped to the STATUS LEAF, not the whole record: a partial fulfil writes
// qty/sentQty and this never even wakes. enqueueWhatsApp is the same outbox
// producer the app's sendWhatsApp callable uses, with the same 90s dedupe;
// there is no new send path and no secret binding here (the Meta token lives
// only on metaFallbackSweep). Every guard, the merged-line rule and the failure
// handling live in lib/hold-availability-notify.cjs (node-tested).
//   firebase deploy --only functions:holdAvailabilityNotify
exports.holdAvailabilityNotify = onValueWritten(
  {
    ref:            "/refill_requests/{requestId}/status",
    instance:       "marathon-club-default-rtdb",
    region:         "europe-west1",
    memory:         "256MiB",
    timeoutSeconds: 60,
    // A transient enqueue failure rethrows, and the status will never change
    // again — without retries that customer is simply never told. The core
    // releases its claim BEFORE rethrowing, so a retry re-claims and re-sends;
    // every other outcome returns rather than throws, so nothing else re-drives.
    // (CodeRabbit #385.)
    retry:          true,
  },
  async (event) => {
    await notifyHoldAvailability({
      db:        admin.database(),
      enqueueWhatsApp,
      requestId: event.params.requestId,
      before:    event.data.before.val(),
      after:     event.data.after.val(),
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

// SA calendar day of an epoch-ms instant — single source in lib/sa-time.cjs
// (was a local copy here; consolidated so date logic can't drift between the
// monolith and the displayChecks trigger).
const { saDateStringFromMs } = require("./lib/sa-time.cjs");

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
// request.data (all optional): { limit=12, productIds:[...], category, reprocess=false,
// style: "white" (default, existing behavior) | "house" (Marathon house-style scene,
// conditioned on the Style Kit reference images — see STYLE_KIT_PATH below),
// note: "…" (a per-run fix instruction folded into the prompt),
// sourceUrl: "https://…" (SINGLE-product calls only — the photo to re-shoot when
// it is not the record's hero; Shopify Publishing's photo set is its own list) }.
// Returns { processed, failed, total, estCostUSD, costByEngine, sample, failures }.

const openaiApiKey = defineSecret("OPENAI_API_KEY");
const geminiApiKey = defineSecret("GEMINI_API_KEY");

const PHOTO_MODEL          = "gpt-image-1";   // OpenAI image-edit model (vision in/out)
const PHOTO_SIZE           = "auto";          // match each product's aspect → no top/bottom crop
const PHOTO_DEFAULT_QUALITY = "medium";       // low|medium|high (request param overrides); cost ↑ with quality
const PHOTO_CONCURRENCY    = 3;               // image gen is slow + heavy → keep it low
const PHOTO_DEFAULT_LIMIT  = 12;              // small first batch to eyeball quality + cost
const PHOTO_MAX_BATCH      = 200;            // hard ceiling per call (cost / timeout safety)
const PHOTO_PROPOSALS_PATH = "aiAssistant/photoProposals";
// The bucket is declared ONCE, in lib/photo-scope.cjs, because the same value
// also builds the APP_STORAGE_PREFIX that gates an incoming sourceUrl.
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");

// ── House-style ("Style Kit") config ──────────────────────────────────────────
// Reference-conditioned generations: every house-style call attaches the enabled
// Style Kit reference images for the product's template (sneaker | clothing) so
// the output matches the store's signature scene. The kit lives at
// /aiAssistant/styleKit/{template} = { prompt, refs: { refId: { url, enabled, … } } }
// and is managed from the AI Studio Style Kit panel — prompt + refs are re-read
// on every call, so edits take effect next generation with NO redeploy.
const STYLE_KIT_PATH = "aiAssistant/styleKit";

// Scoping decisions live in lib/ so they can be proved without a runtime, a
// secret or a paid image call — the same split every other function here uses.
const {
  resolveNamedIds, resolveSourceUrl, needsCatalogueScan, pickIds, mayRecordProposal,
} = require("./lib/photo-scope.cjs");
const HOUSE_MAX_REFS = 6;   // refs sent per generation (kit can hold more; more refs = more latency)

// gpt-image-1 token pricing (USD per 1M tokens) — used only for an ESTIMATE; the
// authoritative number is the OpenAI bill.
const OAI_TEXT_IN_PER_MTOK  = 5;
const OAI_IMAGE_IN_PER_MTOK = 10;
const OAI_IMAGE_OUT_PER_MTOK = 40;

// The white-bg prompt, the condition rule and the prompt composer live in
// lib/photo-prompt.cjs so the compliance rule can be unit-tested. PHOTO_PROMPT
// is used here ONLY as buildPhotoPrompt's base for the white path — never
// handed to an engine directly, since the raw body carries no condition rule.
// DEFAULT_WHITE_PROMPT is the composed one the adapters fall back to.
const { PHOTO_PROMPT, DEFAULT_WHITE_PROMPT, buildPhotoPrompt } = require("./lib/photo-prompt.cjs");

// DEFAULT house-style locked prompts — code fallbacks only. The live prompt is
// read from /aiAssistant/styleKit/{template}/prompt (editable in the Style Kit
// panel, no redeploy); these apply when no custom prompt is saved.
// KEEP IN SYNC with STYLE_KIT_DEFAULT_PROMPTS in src/App.jsx (panel starting text).
const HOUSE_PROMPT_CLOTHING = [
  "You are re-shooting a product photo in our store's signature house style. The STYLE REFERENCE",
  "images show our exact studio scene — recreate that scene precisely: the same backdrop and wall,",
  "the same hangers and display hardware, the same lighting direction, softness and colour grade,",
  "the same camera height, distance, angle and framing, and the same layout and spacing. The output",
  "must look like it was shot in the SAME session, in the SAME spot, with the SAME lighting rig as",
  "the references.",
  "CRITICAL — the references define ONLY the scene and styling. The garments shown in the references",
  "are DIFFERENT products: none of their design, colour, fabric, branding or details may appear in",
  "the output.",
  "The PRODUCT image shows the actual item to photograph. Keep the product's design EXACTLY —",
  "identical shape, proportions, colour, materials, patterns, logos and text. Never redesign,",
  "restyle, recolour, or invent details the real product does not have. Render every brand wordmark",
  "and logo crisply and correctly — properly letter-formed, correctly spelled, matching the real",
  "brand's exact lettering; never garbled, warped or fake-looking.",
  "Present the garments as a coordinated SET, displayed exactly the way the reference sets are",
  "displayed — every piece visible in the product photo (e.g. hoodie and matching joggers) arranged",
  "together in the same configuration, on the same hangers, with the same spacing as the references.",
  "If the product photo shows a single piece, present just that piece in the identical scene and",
  "position. Settle out the creases a garment picks up from packing, folding or a hanger — but anything",
  "set into the cloth by WEAR stays. Natural drape, squared shoulders and straight hems; nothing cropped",
  "or cut off.",
  "Render the product's colours as the ITEM ACTUALLY IS — never washed out or over-exposed by the",
  "rendering, and never freshened either: colour genuinely lost to fading or yellowing stays lost. Darks",
  "must not be lifted or greyed by the exposure. Match the exposure and white balance of the reference",
  "scene so the product sits naturally in its lighting. Tack-sharp focus and fine detail throughout; a",
  "photorealistic result indistinguishable from a real photo of THIS item taken in our studio.",
].join(" ");

const HOUSE_PROMPT_SNEAKER = [
  "You are re-shooting a product photo in our store's signature house style. The STYLE REFERENCE",
  "images show our exact studio scene — recreate it precisely: the same backdrop, surface, lighting",
  "direction, softness and colour grade, the same camera height, angle and framing, and the same",
  "shoe-and-box composition and spacing as the references. The output must look like it was shot in",
  "the SAME session, in the SAME spot, with the SAME lighting rig.",
  "CRITICAL — the references define ONLY the scene, layout and styling. The sneakers and boxes shown",
  "in them are DIFFERENT products: none of their design, colourway or branding may appear in the",
  "output.",
  "The PRODUCT image shows the actual sneaker to photograph. Keep its design EXACTLY — identical",
  "shape, proportions, colourway, materials, patterns, logos and text. Show the OUTER (lateral)",
  "branded display side facing the camera, keeping the SAME side and SAME left/right facing as the",
  "product photo — never flip, mirror or rotate to the plain inner side. Never redesign or invent",
  "details.",
  "Display the sneaker WITH its retail box, positioned exactly as the boxes are positioned in the",
  "references. If a BOX image is provided, reproduce that exact box — its true colours, graphics,",
  "logos and label text, correctly spelled and crisply rendered. If no box image is provided, show",
  "this exact model's authentic retail box using your knowledge of the real product; keep all box",
  "text and branding accurate and legible, and never invent box artwork that doesn't exist.",
  "Colours as the ITEM ACTUALLY IS — darks not lifted or greyed by the exposure, and colour genuinely",
  "lost to fading left lost; match the reference scene's exposure and white balance. Tack-sharp focus",
  "and detail; a photorealistic result indistinguishable from a real photo of THIS item in our studio.",
].join(" ");

const HOUSE_DEFAULT_PROMPTS = { clothing: HOUSE_PROMPT_CLOTHING, sneaker: HOUSE_PROMPT_SNEAKER };


// PROVIDER BOUNDARY: given image bytes + the per-product prompt, return { buffer,
// usage } of a white-bg re-shoot. Swap the body to change image providers.
async function generateWhiteBgImage(client, OpenAINS, imageBuffer, contentType, quality, size, prompt) {
  const toFile = OpenAINS.toFile || (OpenAINS.default && OpenAINS.default.toFile);
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const file = await toFile(imageBuffer, `product.${ext}`, { type: contentType });
  const res = await client.images.edit({
    model: PHOTO_MODEL,
    image: file,
    prompt: prompt || DEFAULT_WHITE_PROMPT,
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

// ── GEMINI engines — "Nano Banana" family ──────────────────────────────────────
// Raw REST (Node-22 global fetch — no SDK dependency). The image comes back as
// base64 inline_data SOMEWHERE in candidates[0].content.parts — we ITERATE the
// parts (don't assume an index), since a response may also carry text.
//
// White-bg workhorse: gemini-3.1-flash-image ("Nano Banana 2") — the forced
// replacement for gemini-2.5-flash-image, which Google retires on 2026-10-02.
// GA id (verified on the v1beta models endpoint alongside its -preview alias;
// GA gets longer deprecation notice, so preferred for this high-volume path).
// Same request/response shape; ~$0.067 per 1K image (was $0.039).
const GEMINI_MODEL          = "gemini-3.1-flash-image";
const GEMINI_OUT_PER_MTOK   = 60;      // $/1M image-output tokens (NB2: 1120 tok ≈ $0.067 per 1K image)
const GEMINI_FLAT_IMAGE_USD = 0.067;   // fallback per-image when usageMetadata is absent
//
// House-style engine: gemini-3-pro-image ("Nano Banana Pro") — multi-reference
// scene conditioning (up to 14 input images), used ONLY for style:"house" runs.
// GA id (verified live; -preview alias also exists). Shares the GEMINI_API_KEY secret.
const NBPRO_MODEL           = "gemini-3-pro-image";
const NBPRO_OUT_PER_MTOK    = 120;     // $/1M image-output tokens (1120 tok ≈ $0.134 per 1K/2K image)
const NBPRO_FLAT_IMAGE_USD  = 0.134;   // fallback per-image when usageMetadata is absent
// Per-request abort so a stalled upstream call fails fast instead of pinning the
// worker for the Cloud Function's full 540s timeout (esp. NB Pro multi-image gens).
// Generous headroom over a normal gen (~30-90s) so legitimate slow calls complete.
const GEMINI_FETCH_TIMEOUT_MS = 180000;

// Core generateContent call shared by both Gemini engines: takes prebuilt
// `parts` (interleaved text labels + inline images) and returns the first
// image in the response. `imageConfig` is only sent when given (the white-bg
// NB2 path sends none — request shape identical to the 2.5-flash-image days).
async function geminiGenerateImage(apiKey, model, parts, { outPerMtok, flatUsd, imageConfig } = {}) {
  const body = { contents: [{ parts }] };
  if (imageConfig) body.generationConfig = { imageConfig };
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GEMINI_FETCH_TIMEOUT_MS),
      },
    );
  } catch (err) {
    // Normalise the abort into the same Error-with-message path as HTTP failures,
    // so the per-product worker catch logs it consistently and moves on.
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`gemini request timed out after ${GEMINI_FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`gemini HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const outParts = ((((json.candidates || [])[0] || {}).content) || {}).parts || [];
  let b64 = null, mime = "image/png";
  for (const part of outParts) {                    // image lives in inline_data among the parts
    const inl = part.inlineData || part.inline_data; // REST returns camelCase; accept both
    if (inl && inl.data) { b64 = inl.data; mime = inl.mimeType || inl.mime_type || mime; break; }
  }
  if (!b64) throw new Error("gemini returned no image");
  // Cost: image-output tokens × the model's rate, else the documented flat per-image.
  const um = json.usageMetadata || {};
  const outTok = um.candidatesTokenCount || 0;
  const costUSD = outTok ? +((outTok / 1e6) * outPerMtok).toFixed(6) : flatUsd;
  return { buffer: Buffer.from(b64, "base64"), costUSD, mime };
}

const inlineImagePart = (buffer, contentType) =>
  ({ inline_data: { mime_type: contentType, data: buffer.toString("base64") } });

async function generateWhiteBgImageGemini(apiKey, imageBuffer, contentType, prompt) {
  return geminiGenerateImage(apiKey, GEMINI_MODEL, [
    { text: prompt || DEFAULT_WHITE_PROMPT },
    inlineImagePart(imageBuffer, contentType),
  ], { outPerMtok: GEMINI_OUT_PER_MTOK, flatUsd: GEMINI_FLAT_IMAGE_USD });
}

// House-style generation on Nano Banana Pro: the product photo (+ its box shot,
// for sneakers) and the Style Kit references go in as SEPARATE, text-labelled
// images so the model can't confuse which item to render and which scene to
// copy. Square 2K output — the catalogue grid is square, and 2K costs the same
// as 1K on this model.
async function generateHouseStyleImage(apiKey, prompt, product, box, refs) {
  const parts = [
    { text: prompt },
    { text: "PRODUCT — the item to place in the scene:" },
    inlineImagePart(product.buffer, product.contentType),
  ];
  if (box) {
    parts.push({ text: "PRODUCT'S BOX — reproduce this exact box:" });
    parts.push(inlineImagePart(box.buffer, box.contentType));
  }
  if (refs.length) {
    parts.push({ text: "STYLE REFERENCES — match this exact scene, backdrop, lighting and layout:" });
    for (const r of refs) parts.push(inlineImagePart(r.buffer, r.contentType));
  }
  return geminiGenerateImage(apiKey, NBPRO_MODEL, parts, {
    outPerMtok: NBPRO_OUT_PER_MTOK, flatUsd: NBPRO_FLAT_IMAGE_USD,
    imageConfig: { aspectRatio: "1:1", imageSize: "2K" },
  });
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
  if (name === "nbpro") {
    // House-style only — multi-reference conditioning on Nano Banana Pro.
    // opts.box / opts.refs are { buffer, contentType } (refs: array).
    const key = geminiApiKey.value();
    return {
      name: "nbpro",
      generate: (buf, ct, { prompt, box, refs } = {}) =>
        generateHouseStyleImage(key, prompt, { buffer: buf, contentType: ct }, box, refs || []),
    };
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
    // Long-cache so the browser reuses the image instead of re-downloading it on
    // every admin re-mount (cuts Storage egress; stops the photo "reload"). Safe:
    // each generation writes a unique path, so cached copies never go stale.
    metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } },
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

// House-style outputs keep their generated scene — the white-bg pipeline's
// trim/white-square/dark-strengthen passes would mangle the grid backdrop, so
// they are deliberately BYPASSED. Just cap the size for the catalogue (the
// model already returns square via imageConfig). Best-effort like the white path.
async function normalizeHouseStyle(buffer, fallbackMime) {
  try {
    const sharp = require("sharp");
    const out = await sharp(buffer)
      .resize(CATALOGUE_CANVAS, CATALOGUE_CANVAS, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer();
    return { buffer: out, mime: "image/jpeg" };
  } catch (e) {
    console.warn("normalizeHouseStyle failed, using raw output:", e && e.message);
    return { buffer, mime: fallbackMime || "image/jpeg" };
  }
}

// Load the Style Kit for house-style runs: per-template locked prompt (custom
// from RTDB else the code default) + the enabled reference images, capped at
// HOUSE_MAX_REFS (oldest first — the curated core of the kit). Ref buffers are
// fetched ONCE and shared by every product in the batch.
async function loadStyleKit(db) {
  const snap = await db.ref(STYLE_KIT_PATH).once("value");
  const kit = snap.val() || {};
  const out = {};
  for (const template of ["sneaker", "clothing"]) {
    const t = kit[template] || {};
    const prompt = (typeof t.prompt === "string" && t.prompt.trim()) ? t.prompt.trim() : HOUSE_DEFAULT_PROMPTS[template];
    const refEntries = Object.entries(t.refs || {})
      .filter(([, r]) => r && r.url && r.enabled !== false)
      .sort(([, a], [, b]) => (a.addedAt || 0) - (b.addedAt || 0))
      .slice(0, HOUSE_MAX_REFS);
    const refs = (await Promise.all(refEntries.map(async ([id, r]) => {
      try { return await fetchImageBuffer(r.url); }
      catch (err) { console.warn(`styleKit ref ${template}/${id} fetch failed:`, err && err.message); return null; }
    }))).filter(Boolean);
    out[template] = { prompt, refs };
  }
  return out;
}

// Map a raw per-product error into a short, aggregatable reason the Studio UI can
// show (so a failed run isn't silent). Keeps the common cases legible; falls back
// to a truncated raw message for anything unrecognised.
function classifyPhotoError(msg, engName) {
  const m = String(msg || "").trim();
  if (/HTTP 429|credits are depleted|rate|quota|RESOURCE_EXHAUSTED/i.test(m)) {
    const provider = engName === "openai" ? "OpenAI" : "Gemini";  // gemini + nbpro → Gemini
    return `AI credits depleted or rate-limited (429) — check ${provider} billing`;
  }
  const kit = m.match(/no usable (\w+) Style Kit references/i);
  if (kit) return `No ${kit[1]} Style Kit references — add & enable refs for that template`;
  if (/image fetch HTTP|untrusted image host|invalid image url/i.test(m)) return "Couldn't fetch the product image";
  if (/image too large/i.test(m)) return "Product image too large";
  if (/timed out/i.test(m)) return "AI request timed out";
  if (/returned no image/i.test(m)) return "AI returned no image";
  if (/HTTP 5\d\d/i.test(m)) return "AI service error (5xx) — try again";
  return (m || "failed").slice(0, 140);
}

// Turn a failure that killed the WHOLE run into something the app can show a
// human. Without this the callable answers a bare `internal`, and on 2026-08-23
// that cost a day: the project's billing account had been closed, every image
// call died, and the app's own guess — "is generateProductPhotos deployed?" —
// pointed at the one thing that was healthy. The function was deployed the
// whole time. Never make the client guess a cause the server already knows.
//
// An HttpsError thrown deliberately (assertAdmin, bad arguments) is already a
// finished message and passes through untouched.
function photoRunFailure(err) {
  if (err instanceof HttpsError) return err;
  const m = String((err && err.message) || err || "");

  // Billing. `billingEnabled: true` on the project does NOT mean the account
  // behind it is open, which is exactly how this hid for a day.
  if (/billing (is |account )?(is )?(disabled|closed)|billing account .* (disabled|closed)/i.test(m)) {
    return new HttpsError(
      "failed-precondition",
      "Google Cloud billing is disabled for this project, so no photo can be generated. " +
      "Check that marathon-club is linked to an OPEN billing account — a closed one still " +
      "reports billingEnabled: true. Topping up AI credits does not fix this.",
    );
  }

  // The API keys live in Secret Manager, which itself needs a live project.
  if (/secret|SECRET_MANAGER|permission denied on resource project/i.test(m)) {
    return new HttpsError(
      "failed-precondition",
      "The server could not read its API keys from Secret Manager. That usually means the " +
      "project's billing or the Secret Manager API is off, not that a key is wrong: " + m.slice(0, 200),
    );
  }

  // Anything else: still better than `internal` — carry the real text across so
  // whoever reads the toast has something to search for.
  return new HttpsError("internal", `The photo run failed before any image was made: ${m.slice(0, 300)}`);
}

exports.generateProductPhotos = onCall(
  {
    region: "europe-west1",
    secrets: [openaiApiKey, geminiApiKey],
    memory: "1GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    // Any failure that escapes the whole run — as opposed to one product's
    // generation, which is caught per-product below — leaves this callable as a
    // bare `internal` with no detail attached. Map the causes we can recognise
    // onto a message that names them. See photoRunFailure.
    try {
      return await generateProductPhotosRun(request);
    } catch (err) {
      throw photoRunFailure(err);
    }
  }
);

async function generateProductPhotosRun(request) {
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
  // style:"house" = Marathon house-style scene (Style Kit references + Nano
  // Banana Pro, engine override ignored). Anything else = the classic white-bg
  // pipeline, byte-for-byte unchanged.
  const style = data.style === "house" ? "house" : "white";
  // Optional per-run instruction (the studio "regenerate note" / fix chips) — a
  // short, sanitised hint appended to the prompt so the engine knows what to fix.
  const note = typeof data.note === "string"
    ? data.note.replace(/[^\x20-\x7E\u00A0-\uFFFF]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240)
    : "";

  // ── SCOPE, WITHOUT READING THE CATALOGUE FOR ONE PRODUCT ─────────────────
  // A named-ids call (the Studio's Regenerate, and every call from the
  // Shopify product page) used to read ALL of /products and ALL of
  // /aiAssistant/photoProposals to re-shoot ONE photo — 4,275 records and
  // ~3,500 proposal nodes off the wire for a single image. Those two reads
  // exist for the unattended sweep, which genuinely has to scan to find the
  // next N products missing a photo; a caller that already knows the id
  // needs neither. Fetch exactly the named records instead.
  let products, existing = {};
  const namedIds = resolveNamedIds(data, PHOTO_MAX_BATCH);
  if (!needsCatalogueScan(namedIds)) {
    const snaps = await Promise.all(namedIds.map((id) => db.ref(`products/${id}`).once("value")));
    products = {};
    snaps.forEach((s, i) => { const v = s.val(); if (v) products[namedIds[i]] = v; });
  } else {
    const [prodSnap, propSnap] = await Promise.all([
      db.ref("products").once("value"),
      db.ref(PHOTO_PROPOSALS_PATH).once("value"),
    ]);
    products = prodSnap.val() || {};
    existing = propSnap.val() || {};
  }

  // ── THE PHOTO TO RE-SHOOT ────────────────────────────────────────────────
  // Normally the product record's hero. Shopify Publishing needs an override
  // because its photo set is NOT the record's: the reviewer taps a slot in
  // the publishing strip and expects that image re-shot, and a custom
  // publishing set may not contain the hero at all. Single-product calls
  // only — a source photo means nothing applied across a batch. Untrusted
  // input, so it is bounded here and fetched through fetchImageBuffer's
  // existing SSRF guard (https + *.googleapis.com, no redirects) like any
  // other URL.
  const sourceUrl = resolveSourceUrl(data, namedIds);

  // Named ids keep the caller's order; the sweep filters, sorts and caps.
  // Both branches live in lib/photo-scope.cjs and are node-tested.
  const ids = pickIds({ namedIds, products, existing, sourceUrl, data, limit });

  const OpenAINS = require("openai");
  const OpenAI = OpenAINS.default || OpenAINS;
  const openaiClient = new OpenAI({ apiKey: openaiApiKey.value() });
  // Lazy, cached engines — only the providers actually used get built.
  const engineCache = {};
  const getEngine = (name) => (engineCache[name] || (engineCache[name] = makeEngine(name, openaiClient, OpenAINS)));

  // House style: load the Style Kit (locked prompts + enabled refs) once —
  // the ref buffers are shared across every product in this batch.
  const styleKit = style === "house" ? await loadStyleKit(db) : null;

  let processed = 0, failed = 0, estCostUSD = 0;
  const costByEngine = { openai: 0, gemini: 0, nbpro: 0 };
  const sample = [];
  const failures = [];   // { id, name, reason } — surfaced to the Studio UI (capped)

  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const p = products[id];
      const isClothing = p.category === "Clothing" || p.productType === "clothing";
      // House style always runs on Nano Banana Pro; templates key on productType.
      const template = isClothing ? "clothing" : "sneaker";
      const engName = style === "house" ? "nbpro" : (engineOverride || defaultEngineFor(p));
      try {
        // The override when the caller named one, else the record's hero.
        const srcUrl = sourceUrl || p.photoUrl;
        const { buffer, contentType } = await fetchImageBuffer(srcUrl);
        // OpenAI uses a portrait frame for tall garments; Gemini ignores size.
        const size = isClothing ? "1024x1536" : PHOTO_SIZE;
        const kit = styleKit ? styleKit[template] : null;
        // Never write a style:"house" proposal that isn't actually reference-
        // conditioned: if the template has no enabled refs (or every ref fetch
        // failed), fail this product loudly instead of burning an NB Pro gen on
        // an ungrounded result. The Style Kit panel warns when a template is empty.
        if (kit && !kit.refs.length) {
          throw new Error(`house style: no usable ${template} Style Kit references`);
        }
        // name-aware + optional per-run fix note; house swaps in the template's locked prompt
        const prompt = buildPhotoPrompt(p.name, note, kit ? kit.prompt : PHOTO_PROMPT);
        // Sneaker house shots include the product's own box photo when one is
        // saved (photoBoxUrl). Best-effort: a broken box URL downgrades to the
        // no-box prompt path instead of failing the product.
        let box = null;
        if (kit && template === "sneaker" && p.photoBoxUrl) {
          try { box = await fetchImageBuffer(p.photoBoxUrl); }
          catch (err) { console.warn(`generateProductPhotos: ${id} box photo fetch failed:`, err && err.message); }
        }
        const { buffer: rawBuf, costUSD, mime: rawMime } = await getEngine(engName)
          .generate(buffer, contentType, { quality, size, prompt, box, refs: kit ? kit.refs : undefined });
        // White: trim + centre on a uniform white square so the catalogue grid is
        // consistent. House: keep the generated scene — resize only.
        const { buffer: outBuf, mime } = kit
          ? await normalizeHouseStyle(rawBuf, rawMime)
          : await normalizeForCatalogue(rawBuf, rawMime);
        const proposedUrl = await uploadProposalImage(id, outBuf, mime);
        estCostUSD += costUSD;
        costByEngine[engName] = +(costByEngine[engName] + costUSD).toFixed(6);
        // ── A sourceUrl CALL WRITES NO PROPOSAL NODE ─────────────────────
        // /aiAssistant/photoProposals is keyed by product id and written
        // with .set() — a whole-node REPLACE. It belongs to the AI Studio
        // review lane, and a caller that re-shoots one slot of a Shopify
        // publishing set must not write into it, for two reasons that both
        // end in real damage:
        //
        //   · It would silently destroy an unreviewed AI Studio candidate
        //     for the same product — already generated, already paid for.
        //   · Worse, `originalUrl` on that node is what AI Studio's approve
        //     writes into products/{id}/photoUrlOriginal. A publishing photo
        //     can itself be a generated image, so approving such a proposal
        //     in the OTHER surface would overwrite the record's pointer to
        //     the TRUE original with a generated one — the file survives in
        //     Storage with nothing left referencing it. "Originals are never
        //     overwritten" has to hold across both surfaces, not one.
        //
        // So the image is returned and nothing is recorded. It stays in
        // Storage as an immutable object; if the caller discards it, it is
        // an orphan, which is the honest price of not corrupting a lane that
        // belongs to somebody else.
        if (mayRecordProposal(sourceUrl)) {
          await db.ref(`${PHOTO_PROPOSALS_PATH}/${id}`).set({
            // Unchanged, and deliberately so: this branch only runs when NO
            // sourceUrl was named, so p.photoUrl is what was read. Prefer the
            // TRUE original — if this product was already approved once,
            // p.photoUrl is itself a generated image, and photoUrlOriginal is
            // the record's only pointer back to the real photograph.
            originalUrl: p.photoUrlOriginal || p.photoUrl,
            proposedUrl,
            name: p.name || "",
            productType: p.productType || null,
            engine: engName,                 // which engine made THIS proposal
            costUSD: +costUSD.toFixed(6),     // its per-image cost
            status: "pending",          // pending | approved | rejected (set by the review UI)
            at: Date.now(),
            by: request.auth.uid,
            // House-style provenance (absent on white runs — their records are unchanged).
            ...(kit ? { style: "house", template, refsUsed: kit.refs.length } : {}),
          });
        }
        processed++;
        // `sourceUrl` echoes back the image this generation was ACTUALLY made
        // from. A caller that asked for a specific photo can compare it and
        // refuse to show a side-by-side against a different one — which is
        // what a deployed build older than this argument would produce, and
        // what a rollback would produce again.
        if (sample.length < 20) sample.push({ id, name: p.name || "", proposedUrl, engine: engName, sourceUrl: srcUrl });
      } catch (err) {
        failed++;
        if (failures.length < 50) failures.push({ id, name: p.name || "", reason: classifyPhotoError(err && err.message, engName) });
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
    engine: style === "house" ? "nbpro" : (engineOverride || "auto"), style, costByEngine,
  });

  return { processed, failed, total: ids.length, estCostUSD, costByEngine, sample, failures };
}

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

// Every permission the staff editor can grant. MUST stay a superset of the
// client catalog in src/components/permissionCatalog.js — createStaffUser rejects
// any permission not listed here, so a missing key silently blocks account
// creation (that is exactly how Warehouse users became un-creatable: their
// default set includes stock_management/stock_add/barcode, which used to be
// absent from this list). `display_refills` is retained as a legacy no-op so
// old records that still carry it don't fail validation on edit.
const VALID_PERMISSIONS = [
  "store_assistant", "warehouse",     "source",        "place_orders",
  "product_admin",   "insights",      "broadcast",     "customer_data",
  "stock_management","stock_add",     "barcode",       "user_management",
  "display_checks",  // Display Checks module (clothing) — mirrors permissionCatalog.js
  "display_refills", // legacy no-op — kept for back-compat only
];
const VALID_ROLES = ["admin", "store_assistant", "warehouse"];
// Stock role gates inventory WRITES in the RTDB rules, separate from the app
// role. createStaffUser accepts an optional stockRole so a Warehouse account is
// write-capable the moment it's created (no separate second step). "" / absent
// clears it (no stock-write access).
const VALID_STOCK_ROLES = ["", "store", "warehouse", "pos", "admin"];
// Sensible stockRole per app role when the client doesn't send one explicitly.
const DEFAULT_STOCK_ROLE = { admin: "admin", warehouse: "warehouse", store_assistant: "" };

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
const VOICE_TEXT_RE = /^(Order number .{1,24}, (ready for collection|out of stock|scheduled for tomorrow)\.?|Pickup announcements on\.?)$/;

// Fixed vocabulary the TV pickup board preloads and plays LOCALLY (digit-by-digit
// number reading). token → exact words. MUST match VOICE_VOCAB in src/App.jsx.
const VOICE_VOCAB = {
  order_number: "Order number",
  d0: "zero", d1: "one", d2: "two",   d3: "three", d4: "four",
  d5: "five", d6: "six", d7: "seven", d8: "eight", d9: "nine",
  ready:    "ready for collection",
  oos:      "out of stock",
  tomorrow: "scheduled for tomorrow",
  enabled:  "Pickup announcements on",
};

function ttsCacheKey(engine, voice, text) {
  const t = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const v = String(voice || "default").replace(/[^a-z0-9]+/gi, "").toLowerCase();
  return `${engine}_${v}_${t}`.slice(0, 100);
}

// Runtime ElevenLabs key (NOT a bound secret — lets the function deploy before the
// key exists). Cached per instance; null when the secret is absent/unreadable.
let _elevenKey = null; let _elevenCheckedAt = 0;
async function getElevenKey() {
  if (_elevenKey) return _elevenKey;                      // found → cache for the instance lifetime
  if (Date.now() - _elevenCheckedAt < 60000) return null; // absent → re-check at most once/min (so activation is near-immediate, no hammering)
  _elevenCheckedAt = Date.now();
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

// Get (cache-hit) or generate+cache one OpenAI TTS clip. Deterministic Storage path
// keyed by voice+text, so re-requesting the same word is free and idempotent. Used
// by the vocab preload (and the legacy single-clip path). chars = billable chars
// generated this call (0 on a cache hit).
async function openaiTtsUrl(bucket, voice, text) {
  const path = `tts/${ttsCacheKey("openai", voice, text)}.mp3`;
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (exists) return { url: await ttsTokenUrl(file, path), cached: true, chars: 0 };
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${openaiApiKey.value()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: voice || "nova", input: text, response_format: "mp3" }),
  });
  if (!res.ok) throw new HttpsError("internal", `openai tts ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const token = require("crypto").randomUUID();
  await file.save(buf, { resumable: false, contentType: "audio/mpeg", metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
  const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  return { url, cached: false, chars: text.length };
}

exports.pickupVoice = onCall(
  { region: "europe-west1", secrets: [openaiApiKey], memory: "256MiB", timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
    const data = request.data || {};

    // Status probe for the admin selector: which engines are usable right now.
    if (data.status) {
      return { engines: { browser: true, openai: true, elevenlabs: !!(await getElevenKey()) } };
    }

    // Vocab preload for the TV: generate (or cache-hit) the whole fixed vocabulary in
    // one OpenAI voice and return { token → url }. The board fetches + decodes these
    // once at startup and plays announcements locally. Idempotent: after the first
    // generation every call is cache hits. Fixed internal wordlist, so it bypasses
    // VOICE_TEXT_RE (it can't be abused for arbitrary paid TTS).
    if (data.vocab) {
      const vvoice = String(data.voice || "nova").trim().slice(0, 40) || "nova";
      const bucket = admin.storage().bucket(STORAGE_BUCKET);
      const entries = Object.entries(VOICE_VOCAB);
      const results = await Promise.all(entries.map(async ([tok, words]) => {
        const { url, chars } = await openaiTtsUrl(bucket, vvoice, words);
        return [tok, url, chars];
      }));
      const urls = {};
      let genChars = 0;
      for (const [tok, url, chars] of results) { urls[tok] = url; genChars += chars; }
      if (genChars) {
        try { await logReorderUsage(admin.database(), new Date().toISOString().slice(0, 10), { at: Date.now(), kind: "pickupVoiceVocab", by: request.auth.uid, engine: "openai", chars: genChars, costUSD: +((genChars / 1e6) * OPENAI_TTS_COST_PER_MCHAR).toFixed(6) }); } catch { /* best-effort */ }
      }
      return { urls, voice: vvoice };
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

    const { username, displayName, pin, role, permissions, stockRole } = request.data || {};

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
    // stockRole is optional. If omitted, fall back to a sensible default for the
    // role so a Warehouse/Admin account can write stock immediately.
    const resolvedStockRole = (stockRole === undefined || stockRole === null)
      ? (DEFAULT_STOCK_ROLE[role] || "")
      : stockRole;
    if (typeof resolvedStockRole !== "string" || !VALID_STOCK_ROLES.includes(resolvedStockRole)) {
      throw new HttpsError("invalid-argument", `Stock role must be one of: ${VALID_STOCK_ROLES.filter(Boolean).join(", ")} (or empty).`);
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

// ─── AUTOMATED REFILL ENGINE ──────────────────────────────────────────────────
// 15-min health scan: targets vs stock vs open intents → refill requests /
// R### orders / exception dashboard. Logic in lib/refill-engine.cjs (pure,
// node-tested); I/O wrapper in refill-scan.cjs. Deploy scoped:
//   firebase deploy --only functions:refillHealthScan
exports.refillHealthScan = require("./refill-scan.cjs").refillHealthScan;

// ─── DISPLAY CHECKS — onClothingSale (PR 2: dormant trigger, writes only) ─────
// Clothing `sold` movements at enabled stores become display checks in the
// displayChecks* namespaces. Pure logic in displayChecks/lib.cjs (node-tested);
// trigger I/O in displayChecks/onClothingSale.js. Sale source proven in
// docs/display-checks-sale-source.md. Deploy scoped:
//   firebase deploy --only functions:onClothingSale
exports.onClothingSale = require("./displayChecks/onClothingSale.js").onClothingSale;

// ─── DISPLAY CHECKS — wakeHeldChecks (scheduled hold→wake sweep, no UI) ────────
// Every 5 min (Africa/Johannesburg), walks the active index
// /displayChecks_active/{store} and moves held checks through stock_seen → grace
// → open IN PLACE (never-null model: a check never changes address, so no
// relocation race), and reaps completed tombstones from a prior SA day. Pure
// decision in displayChecks/lib.cjs; sweep IO in displayChecks/wakeHeldChecks.js.
//   firebase deploy --only functions:wakeHeldChecks
exports.wakeHeldChecks = require("./displayChecks/wakeHeldChecks.js").wakeHeldChecks;

// ─── DISPLAY CHECKS — completeDisplayCheck (PR 7: staff completion, write path) ─
// Callable: a signed-in staff member closes an OPEN check with "confirmed" or
// "no_stock". Server-authoritative write-once + no-stock soft-block; completion
// COPIES to the day node and flips the active record to a `completed` tombstone
// IN PLACE — never deletes (the invariant the cold-cache close depends on). Pure
// decision in displayChecks/lib.cjs; IO in displayChecks/completeCheck.js.
//   firebase deploy --only functions:completeDisplayCheck
exports.completeDisplayCheck = require("./displayChecks/completeCheck.js").completeDisplayCheck;

// ─── STYLE CODE — resolveStyleCode (sneaker intake identity lookup) ───────────
// Sneakers arrive without boxes, so there is no box barcode. The manufacturer
// style code on the inside-tongue label is the canonical identity key instead.
// This callable turns a code into a product identity behind ONE signature and a
// three-tier provider chain — /sneaker_models cache, the KicksDB catalog API,
// and a reserved web-search stub — so a tier can be swapped without touching a
// caller. Pure normalisation in lib/style-code.cjs, providers in
// lib/style-code-providers.cjs (both node-tested); IO in
// styleCode/resolveStyleCode.js.
//
// SECRET: KICKSDB_API_KEY. The key is read inside the function and NEVER ships
// to the client — the browser only ever calls this callable.
//   firebase functions:secrets:set KICKSDB_API_KEY
//   firebase deploy --only functions:resolveStyleCode
exports.resolveStyleCode = require("./styleCode/resolveStyleCode.js").resolveStyleCode;

// ─── STYLE CODE — readStyleCodeLabel (the four-tier label funnel) ─────────────
// Photo of an inside-tongue label → a validated style code. A FUNNEL, not one
// model call: Cloud Vision DOCUMENT_TEXT_DETECTION + regex first (cheap,
// deterministic), escalating to Gemini 3.6 Flash with structured JSON ONLY on
// the residual — zero or ambiguous candidates. Confusable-character retry is
// tier 3 and lives in resolveStyleCode (lookup only, no second vision call);
// manual entry is tier 4 and is never removed.
//
// Results cache on a hash of the IMAGE BYTES so a retake never re-bills, and the
// cache row holds the extracted CODES ONLY — never the Vision payload, which is
// tens of KB of bounding boxes per photo.
//
// REQUIRES: vision.googleapis.com enabled on the project. SECRET: GEMINI_API_KEY.
//   firebase deploy --only functions:readStyleCodeLabel
exports.readStyleCodeLabel = require("./styleCode/readStyleCodeLabel.js").readStyleCodeLabel;

// ─── STYLE CODE — reapStyleCodeOcrCache (the 90-day TTL's other half) ────────
// readStyleCodeLabel expires cache rows lazily (never serves a stale one), but a
// photo taken once and never retaken is never re-read, so its row would live
// forever. This bounded, cursored daily sweep is what actually removes them —
// bounded because "read the whole node once a day" is the same bandwidth
// mistake in a different costume.
//   firebase deploy --only functions:reapStyleCodeOcrCache
exports.reapStyleCodeOcrCache = require("./styleCode/reapOcrCache.js").reapStyleCodeOcrCache;

// ─── STYLE CODE — processStyleCodeCapture (the capture queue worker) ──────────
// Fires on a new /style_code_captures/{captureId}. The displayChecks subtree is
// READ-ONLY to the client (it has .read rules and no .write rule anywhere), so
// the display-check UI cannot write its capture there — it enqueues here
// instead, the same shape as pos/storeCreditQueue, and this trigger decides.
//
// THE GUARANTEE: capturing a code on an EXISTING product writes the CODE, the
// label photo and the resolved data into PENDING fields. It NEVER overwrites the
// live name, image or category. The pure decision is in
// lib/style-code-capture.cjs, where a test asserts the forbidden fields cannot
// appear in the product patch. One vision comparison of the catalogue image
// against the product's own image auto-confirms on agreement and queues for
// admin review on disagreement — BOTH outcomes logged, because a silent
// auto-confirm is indistinguishable from a function that stopped running.
//
// SECRET: GEMINI_API_KEY (the image comparison).
//   firebase deploy --only functions:processStyleCodeCapture
exports.processStyleCodeCapture = require("./styleCode/processCapture.js").processStyleCodeCapture;

// ─── PRODUCT MERGE — mergeProducts (two records, one shoe) ────────────────────
// Admin-only callable that joins a duplicated product into its survivor: cells
// transfer at their own locations (summed on collision, per-location totals
// conserved), the loser becomes a hidden redirect (`mergedInto`), its barcodes
// and style-code claims repoint to the survivor, the matching
// /duplicate_candidates row closes, and the full before-state is recorded at
// /product_merges/{mergeId}. One atomic multi-path update; NO location refuses a
// merge (the Pine/hub3 refusal was removed 2026-08-22), but a concurrent write
// to either party's cells does. All logic in lib/product-merge.cjs (node-tested); auth + IO in
// productMerge/mergeProducts.js.
//   firebase deploy --only functions:mergeProducts
exports.mergeProducts = require("./productMerge/mergeProducts.js").mergeProducts;

// ─── LABEL ALIASES — labelAlias (fuzzy label identity: match / add) ──────────
// A label reading is an ALIAS, not a key: identity is assigned once at
// registration and every later scan is a fuzzy token-overlap LOOKUP with a
// three-band outcome (silent / ask-the-human / never-registered). The ONLY
// reader/writer of /label_aliases (Admin SDK — no client rules). Pure logic in
// lib/label-alias.cjs (node-tested); auth + IO in labelAlias/labelAlias.js.
//   firebase deploy --only functions:labelAlias
exports.labelAlias = require("./labelAlias/labelAlias.js").labelAlias;

// ─── STYLE CODE SIBLINGS — styleCodeSibling (the collision question, answered) ─
// One printed style code can legitimately own SEVERAL colourway products — the
// standard Nike tongue label carries no colourway text, so the label cannot
// tell black from white (owner evidence 2026-08-07, HF5509-002). When a
// registration collides with an existing claim, the UI asks "same shoe, or a
// different colourway?" and THIS callable records the answer: same-shoe routes
// to the existing merge flow via /duplicate_candidates; different-colourway
// registers a SIBLING under /style_code_index/{code}/siblings (Admin SDK only —
// the client claim rule never permits that child, by design). Velocity and
// repeat answers are logged to /style_code_sibling_events, never acted on.
// Pure logic in lib/style-code-siblings.cjs (node-tested).
//   firebase deploy --only functions:styleCodeSibling
exports.styleCodeSibling = require("./styleCode/styleCodeSibling.js").styleCodeSibling;

// ── storefrontSearch — the PUBLIC, read-only storefront search endpoint ──────
// Shopify's own search cannot find these products: every brand, sub-label and
// silhouette term is stripped before a product is pushed, so the words a
// shopper types are exactly the words the Shopify catalogue does not contain.
// This matches on the app's TRUE data (an index at /search_index, built by
// scripts/shopify/build-search-index.mjs) and answers with Shopify handles.
// The brand is used to FIND a product and never travels back out — the response
// is an allow-list, and the query is not echoed.
// DEPLOY SCOPED, BY NAME:  firebase deploy --only functions:storefrontSearch
exports.storefrontSearch = require("./storefrontSearch/storefrontSearch.js").storefrontSearch;

// ── cleanProductPhoto — REMOVED (2026-08-20) ────────────────────────────────
// The per-photo "clean background" action is gone, and the callable with it.
// It was not broken: the truthfulness gate in the browser compared the product
// region pixel-for-pixel and discarded any result where the model had redrawn
// the item. The trouble was that on real shop photographs — a shoe on a rack
// against a painted backdrop — replacing that much of the frame IS a re-render,
// and a re-render never survives a pixel comparison. Measured on 2026-08-19:
// seven generations, one deliberately tampered (correctly discarded) and six
// honest ones (all discarded). The action was safe and it produced nothing.
//
// What replaced it is the AI Studio regenerator, already in this file as
// generateProductPhotos, now reachable from the Shopify product page with a
// `sourceUrl` naming the publishing photo to re-shoot. Its guard is not a pixel
// gate — a house-style re-shoot changes the whole scene by design — it is an
// explicit human accept against a side-by-side, which is how AI Studio has
// always worked.
//
// THE DEPLOYED FUNCTION MUST STILL BE DELETED. Removing the export stops it
// being redeployed; it does NOT remove the running instance, which still holds
// the GEMINI_API_KEY secret binding and is still callable by any admin:
//   firebase functions:delete cleanProductPhoto --region europe-west1

// ─── ENGINE POLICY — setCategoryPolicy ────────────────────────────────────────
// The ONLY supported way to change /config/refillEngine/categoryPolicy: the
// owner-armed map that says what each category keeps at each location, and when
// the engine asks for more. Reached from the Engine Policy card.
//
// Everything it does — the owner check, validation, the drift check, the
// rollback snapshot, the audit entry, the post-verify and the dry-run preview —
// lives in lib/category-policy-write.cjs, injected with `db` and the caller's
// email so every branch is unit-testable without firebase-admin. This is the
// wrapper and nothing else.
//
// GATE 3 OF 3, and read the module header for the honest limits of it: live
// RTDB rules already gate /config/refillEngine on stockRole 'admin' (as does
// the repo's own database.rules.json — an earlier comment here claimed
// otherwise, repeating an unverified premise from the brief). So four staff
// accounts can write the policy node directly through the SDK today and never
// reach this function. It becomes a real boundary when the console rule printed
// by scripts/print-engine-policy-rule.mjs narrows those four to one.
//
// DEPLOY BY NAME. functions/ is shared with marathon-pos-app:
//   firebase deploy --only functions:setCategoryPolicy
// 300s, not 120: the redesign added three actions that page the catalogue —
// the explicit-row list, the derived size run, and the model that runs before a
// group may be armed (which walks every member). 120s was chosen when the only
// heavy path was the census; a timeout here reads to the owner as "the screen
// is broken", not "that took a while".
exports.setCategoryPolicy = onCall(
  { region: "europe-west1", timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    // assertAdmin ALSO runs here, above the module, so the gate survives a
    // refactor of either side. The module's own check is the one the mutation
    // proof breaks; this one is belt to its braces.
    assertAdmin(request);
    try {
      return await applyCategoryPolicy({
        db: admin.database(),
        callerEmail: request.auth?.token?.email,
        callerUid: request.auth?.uid || null,
        adminEmail: ADMIN_EMAIL,
        data: request.data,
        // Server clock. serverNowMs() is the CLIENT's corrected clock and does
        // not exist here; inside a Cloud Function Date.now() IS server time.
        nowMs: Date.now(),
      });
    } catch (e) {
      if (e && e.httpsCode) throw new HttpsError(e.httpsCode, e.message, e.details);
      throw e;
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL CONTENT ENGINE — THE GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
// Picks products worth posting and produces the post: an image, a caption, the
// platforms and a slot in the schedule. Everything it makes lands in
// /social_posts as a DRAFT. It cannot create an approved post, it never talks
// to Instagram, Facebook or TikTok, and nothing it writes is sent until Junid
// has approved that specific item in the queue.
//
// ── WHAT IT REUSES, AND WHY IT LIVES IN THIS FILE ────────────────────────────
// The paid parts of this already exist: the Nano Banana Pro engine, the Style
// Kit loader, the SSRF-guarded image fetcher, the Storage uploader and the
// usage ledger were all built for generateProductPhotos and are module-scope
// helpers here. Reimplementing any of them in a separate module would fork the
// photo pipeline in two. So the orchestration sits beside its sibling and the
// PURE parts — what is worth posting, what a caption should say — live in
// functions/lib/social-select.cjs, social-caption.cjs and social-signal.cjs
// where they are node-tested.
//
// ── THE READ PLAN (no whole-node reads) ──────────────────────────────────────
//   1. /shopify_publish, ONE indexed query on state == "live". That is the set
//      of products actually on the storefront — a few hundred rows, the same
//      read the publishing page has made since #365.
//   2. The sell-through signal, from a CACHE at /social_signal/sellThrough,
//      recomputed at most once a day by paging /insights_log BACKWARDS through
//      its push-key range (social-signal.cjs). /social_signal is written and
//      read only by this function through the Admin SDK, so it needs no
//      database rule and never appears in the browser.
//   3. /products/{pid} and /stock/{loc}/{pid} for the SHORTLIST only — the top
//      CANDIDATE_DEPTH rows by a preliminary node-only score, not for all 700.
//      The stock read is per location per product precisely so that "is it in
//      stock" never becomes a read of the /stock node.
//   4. /social_style_refs, one bounded newest-first page, for the look.
//
// ── PHOTO POLICY ─────────────────────────────────────────────────────────────
// Junid's painted backdrop is the default (style "house": the scene is
// CONDITIONED on the Style Kit's photographs of the real backdrop, never
// described in words). Clean white is available and is for advertising only —
// it must be asked for explicitly. Nothing existing is regenerated: every
// generation writes a NEW Storage object and touches no product record, no
// publishing set and no photo proposal.
const socialSelect = require("./lib/social-select.cjs");
const socialCaption = require("./lib/social-caption.cjs");
const socialSignal = require("./lib/social-signal.cjs");

const SOCIAL_POSTS_PATH = "social_posts";
const SOCIAL_REFS_PATH = "social_style_refs";
const SOCIAL_SIGNAL_PATH = "social_signal/sellThrough";
// The shortlist depth. Deep enough that a flat-lay can spread across
// categories and an outfit can find four different slots; shallow enough that
// the per-product reads stay in the hundreds rather than the thousands.
const SOCIAL_CANDIDATE_DEPTH = 80;
// Style references sent with one generation. The same ceiling the Style Kit
// uses for the product pipeline (HOUSE_MAX_REFS) — more references means more
// latency and, past a handful, no more fidelity.
const SOCIAL_MAX_REFS = 6;
// How many reference rows are fetched to find SOCIAL_MAX_REFS enabled ones.
const SOCIAL_REF_PAGE = 150;
// Hard ceiling on one call, so a repeated tap or a bad client cannot fan out an
// expensive run. Four posts at ~$0.134 is well under a dollar.
const SOCIAL_MAX_POSTS = 4;
// Social output geometry. 1080×1350 is Instagram's 4:5 portrait, and it is
// also inside TikTok's photo ceiling (each image must fit within 1080×1920) —
// one size that all three platforms accept, so the queue never holds an asset
// one platform will reject after Junid approved it.
const SOCIAL_W = 1080, SOCIAL_H = 1350;
// The public storefront. Same host scripts/shopify/print-menu-plan.mjs prints.
const SOCIAL_STOREFRONT = "https://marathonclub.co.za";

// Multi-product scene on Nano Banana Pro. The sibling of generateHouseStyleImage:
// same model, same reference-conditioning, but N products instead of one, each
// attached as its own text-labelled image so the model cannot confuse which
// item is which. 4:5 because that is what the platforms want; the product
// pipeline's 1:1 is a catalogue-grid decision that does not apply here.
async function generateSocialScene(apiKey, prompt, productImages, refs) {
  const parts = [{ text: prompt }];
  productImages.forEach((p, i) => {
    parts.push({ text: `PRODUCT ${i + 1} — ${p.name}. Render THIS item:` });
    parts.push(inlineImagePart(p.buffer, p.contentType));
  });
  if (refs.length) {
    parts.push({ text: "STYLE REFERENCES — match this exact scene, backdrop, lighting and mood:" });
    for (const r of refs) parts.push(inlineImagePart(r.buffer, r.contentType));
  }
  return geminiGenerateImage(apiKey, NBPRO_MODEL, parts, {
    outPerMtok: NBPRO_OUT_PER_MTOK, flatUsd: NBPRO_FLAT_IMAGE_USD,
    imageConfig: { aspectRatio: "4:5", imageSize: "2K" },
  });
}

// Fit the generated scene to the one size all three platforms accept. Never
// crops: "inside" preserves the whole composition, which matters when the
// model has spaced four products across the frame. Best-effort — on a sharp
// failure the raw output is kept rather than the post being lost.
async function normalizeSocialImage(buffer, fallbackMime) {
  try {
    const sharp = require("sharp");
    const out = await sharp(buffer)
      .resize(SOCIAL_W, SOCIAL_H, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
      .toBuffer();
    return { buffer: out, mime: "image/jpeg" };
  } catch (e) {
    console.warn("normalizeSocialImage failed, using raw output:", e && e.message);
    return { buffer, mime: fallbackMime || "image/jpeg" };
  }
}

// Generated post media goes to its OWN Storage path, under the aiStudio prefix
// the Style Kit already owns (public read, super-admin write — the access these
// files need, with no Storage rule change). Never under products/{id}/: a
// social scene is not a product photograph and must never be reachable by
// anything that walks a product's folder.
async function uploadSocialImage(postId, index, buffer, mime = "image/jpeg") {
  const token = require("crypto").randomUUID();
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const path = `aiStudio/social/posts/${postId}/${index}_${token}.${ext}`;
  await admin.storage().bucket(STORAGE_BUCKET).file(path).save(buffer, {
    resumable: false,
    contentType: mime,
    metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// The sell-through signal, cached. Recomputed only when the cache is missing or
// older than its TTL — paging /insights_log on every Generate tap would be the
// expensive mistake the cache exists to prevent. A recompute that fails is NOT
// fatal: the generator falls back to a stale signal, or to no sales signal at
// all (ranking then on newness alone), and says which in the run report. A
// caption engine being down must not make the shop unable to post.
async function loadSellThroughSignal(db, nowMs) {
  const cached = (await db.ref(SOCIAL_SIGNAL_PATH).once("value")).val();
  // The freshness test is `computedAt` ALONE. It used to also require
  // `cached.unitsByPid`, which looks like a sanity check and is a trap: RTDB
  // does not store empty objects, so a window in which no sale carried a
  // productId writes a node with NO unitsByPid child — the check then read
  // every cache hit as a miss and re-paged /insights_log and /returns_log on
  // every single Generate tap, forever. Exactly the cost this cache exists to
  // avoid. An absent map is a real, valid answer: "nothing was attributable".
  if (cached && Number(cached.computedAt) > nowMs - socialSignal.SIGNAL_TTL_MS) {
    return { unitsByPid: {}, ...cached, source: "cache" };
  }
  try {
    const { startKey, startMs } = socialSignal.recentDaysStartKey(socialSignal.WINDOW_DAYS, nowMs);
    const fromIso = new Date(startMs + socialSignal.PAD_MS).toISOString();
    const toIso = new Date(nowMs + 60000).toISOString();
    const dbRef = (p) => db.ref(p);
    const [ready, returns] = await Promise.all([
      socialSignal.pageBackwards(dbRef, "insights_log", startKey, "ready"),
      socialSignal.pageBackwards(dbRef, "returns_log", startKey, null),
    ]);
    const tally = socialSignal.tallyUnits(ready.rows, returns.rows, fromIso, toIso);
    const record = {
      unitsByPid: tally.unitsByPid,
      totalUnits: tally.totalUnits,
      attributedUnits: tally.attributedUnits,
      coverage: +tally.coverage.toFixed(4),
      events: tally.events,
      windowDays: socialSignal.WINDOW_DAYS,
      fromIso,
      toIso,
      pagesTruncated: ready.truncated || returns.truncated,
      computedAt: nowMs,
    };
    if (record.pagesTruncated) {
      // A partial window ranks on a fraction of the tills and looks perfect
      // doing it — `coverage` measures ATTRIBUTION, not completeness, so a
      // truncated read can report 99.7% and still have missed half the sales.
      console.warn(`social: sell-through paging hit its ${socialSignal.MAX_PAGES}-page bound — the ranking is a FLOOR, not a total.`);
    }
    await db.ref(SOCIAL_SIGNAL_PATH).set(record);
    return { ...record, source: "computed" };
  } catch (err) {
    console.warn("social: sell-through signal failed:", err && err.message);
    if (cached && cached.unitsByPid) return { ...cached, source: "stale", staleReason: String(err && err.message) };
    return { unitsByPid: {}, coverage: 0, source: "unavailable", staleReason: String(err && err.message) };
  }
}

// Which products have appeared in a post recently, so the generator does not
// propose the same three best-sellers every week. Read from the posts that are
// still meaningful — anything not discarded — through the status index, so this
// is a handful of bounded queries and never a read of the posts node.
async function loadPostedAtByPid(db) {
  const out = {};
  // "discarded" is IN this list on purpose. Junid throwing a draft away is the
  // strongest signal there is that he does not want that product posted, and
  // leaving it out meant the next run re-proposed it and spent another $0.134
  // on the very thing he had just rejected — every day, forever.
  const states = ["draft", "approved", "posting", "posted", "failed", "discarded"];
  const snaps = await Promise.all(states.map((s) =>
    db.ref(SOCIAL_POSTS_PATH).orderByChild("status").equalTo(s).limitToLast(300).once("value")));
  for (const snap of snaps) {
    for (const post of Object.values(snap.val() || {})) {
      const at = Number(post && (post.createdAt || post.scheduledAt)) || 0;
      for (const p of (post && post.products) || []) {
        if (!p || !p.pid) continue;
        if (!out[p.pid] || out[p.pid] < at) out[p.pid] = at;
      }
    }
  }
  return out;
}

// A bounded page of the Style Reference Library, newest first, enabled only.
// The buffers are fetched once per RUN and shared by every post in it.
async function loadSocialStyleRefs(db) {
  // limitToLast is applied by the server BEFORE this code can filter, so the
  // page must be wide enough that switching off a batch of recent references
  // does not hide every enabled one behind them. 40 was the cap AND the page,
  // which meant uploading 40 references for an experiment and then disabling
  // them all made every house-style post fail with "add photos to the Style
  // library" while dozens of enabled ones sat one page deeper.
  const snap = await db.ref(SOCIAL_REFS_PATH).orderByChild("addedAt").limitToLast(SOCIAL_REF_PAGE).once("value");
  const rows = Object.entries(snap.val() || {})
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r && r.enabled !== false)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  // VIDEO references contribute their NOTE and their poster frame, never a
  // video body — the image model takes stills, and a 200 MB download in a
  // Cloud Function to extract one frame we already captured in the browser
  // would be absurd. The poster is what was stored; the poster is what is sent.
  const usable = rows.filter((r) => r.thumbUrl || r.type === "image");
  const chosen = usable.slice(0, SOCIAL_MAX_REFS);
  const buffers = (await Promise.all(chosen.map(async (r) => {
    try { return { ...(await fetchImageBuffer(r.thumbUrl || r.url)), note: r.note || "", id: r.id }; }
    catch (err) { console.warn(`social: style ref ${r.id} fetch failed:`, err && err.message); return null; }
  }))).filter(Boolean);
  return { refs: buffers, notes: rows.map((r) => r.note).filter(Boolean).slice(0, 6), total: rows.length };
}

// The caption. Anthropic, because the key is already a secret this project
// holds and chatStream proves the model id works against this account. A
// failure here NEVER loses a paid image: socialCaption.fallbackCaption() puts a
// plain, honest line on the post, the record is marked captionSource
// "fallback", and Junid rewrites it in ten seconds if he cares to.
async function writeSocialCaption({ kind, picks, link, styleNotes }) {
  const prompt = socialCaption.buildCaptionPrompt({
    kind,
    products: picks.map((p) => ({ name: p.name, retailPrice: p.retailPrice, slot: p.slot })),
    link,
    styleNotes,
  });
  try {
    const AnthropicCtor = Anthropic.default || Anthropic;
    const client = new AnthropicCtor({ apiKey: anthropicApiKey.value() });
    const msg = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const read = socialCaption.readCaption(text);
    if (read.ok) return { caption: read.caption, source: "ai", reason: null };
    return { caption: socialCaption.fallbackCaption({ kind, products: picks }), source: "fallback", reason: read.reason };
  } catch (err) {
    console.warn("social: caption call failed:", err && err.message);
    return {
      caption: socialCaption.fallbackCaption({ kind, products: picks }),
      source: "fallback",
      reason: String(err && err.message).slice(0, 160),
    };
  }
}

exports.generateSocialPosts = onCall(
  {
    region: "europe-west1",
    secrets: [geminiApiKey, anthropicApiKey],
    memory: "1GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    assertAdmin(request);
    const db = admin.database();
    const data = request.data || {};
    const nowMs = Date.now();

    // What to make. `kinds` is a list so one tap can fill a week: ["single",
    // "outfit", "new_arrivals"]. Unknown kinds are refused by name rather than
    // skipped — a typo that silently produces nothing is a support call.
    const wanted = Array.isArray(data.kinds) && data.kinds.length ? data.kinds : ["single"];
    const unknown = wanted.filter((k) => !socialSelect.KIND_KEYS.includes(k));
    if (unknown.length) throw new HttpsError("invalid-argument", `unknown post type(s): ${unknown.join(", ")}`);
    const kinds = wanted.slice(0, SOCIAL_MAX_POSTS);

    // Photo policy: house (the painted backdrop) unless white is explicitly
    // asked for. The DEFAULT is in this expression, not in the caller.
    const style = data.style === "white" ? "white" : "house";

    // Which platforms the drafts are proposed for. Junid changes this per post
    // in the queue; this is only the starting position.
    // An empty object is truthy, so `data.platforms ? … : default` turned
    // `platforms: {}` into all-false — a post postBlocker refuses forever,
    // after the image was already paid for. A selection with nothing in it is
    // not a selection; fall back to the default.
    const asked = data.platforms && typeof data.platforms === "object" ? data.platforms : null;
    const anyAsked = asked && ["instagram", "facebook", "tiktok"].some((k) => asked[k] === true);
    const platforms = anyAsked
      ? { instagram: asked.instagram === true, facebook: asked.facebook === true, tiktok: asked.tiktok === true }
      : { instagram: true, facebook: true, tiktok: false };

    // ── 1. The storefront's live set — one indexed query ─────────────────────
    const liveSnap = await db.ref("shopify_publish").orderByChild("state").equalTo("live").once("value");
    const liveNodes = liveSnap.val() || {};

    // ── 2. Signals ───────────────────────────────────────────────────────────
    const [signal, postedAtByPid, styleKit, library] = await Promise.all([
      loadSellThroughSignal(db, nowMs),
      loadPostedAtByPid(db),
      style === "house" ? loadStyleKit(db) : Promise.resolve(null),
      loadSocialStyleRefs(db),
    ]);

    // ── 3. The shortlist, then its records ───────────────────────────────────
    // A PRELIMINARY rank on node-only fields (sales + liveAt) decides which
    // products are worth reading in full. Ranking on the node first is what
    // keeps step 4 at ~80 products instead of ~700.
    const prelim = Object.entries(liveNodes)
      .filter(([, n]) => n && n.state === "live" && n.liveState === "on" && n.cleanName)
      .map(([pid, n]) => ({
        pid,
        units: Number(signal.unitsByPid?.[pid]) || 0,
        liveAt: Number(n.liveAt) || 0,
        cooled: Number(postedAtByPid[pid]) || 0,
      }))
      .filter((r) => !(r.cooled && nowMs - r.cooled < socialSelect.REPOST_COOLDOWN_DAYS * 86400000))
      .sort((a, b) => (b.units - a.units) || (b.liveAt - a.liveAt) || (a.pid < b.pid ? -1 : 1));

    // Take the best sellers AND the newest, not just the head of one list — a
    // pure sales sort would starve "new arrivals" of anything to show, because
    // a product that went live on Tuesday has sold nothing yet.
    const byNew = [...prelim].sort((a, b) => b.liveAt - a.liveAt || (a.pid < b.pid ? -1 : 1));
    // ── EACH LIST GETS ITS OWN BUDGET ────────────────────────────────────────
    // Draining `prelim` first and then topping up from `byNew` looked like a
    // merge and was dead code: `prelim` is the whole live+on set (~580 rows),
    // so it filled all 80 places every time and `byNew` contributed nothing.
    // The effect was exactly what the merge existed to prevent — the shortlist
    // became the top-80 sellers, and since a product that went live on Tuesday
    // has sold nothing, "new arrivals" found no fresh candidate and reported
    // "0 products went live recently" forever.
    //
    // So the two lists are interleaved against separate budgets. Newness gets
    // a smaller share because it is the thinner signal, but a guaranteed one.
    const NEW_BUDGET = Math.floor(SOCIAL_CANDIDATE_DEPTH * 0.3);
    const shortlist = [];
    const seen = new Set();
    const take = (list, budget) => {
      let taken = 0;
      for (const r of list) {
        if (taken >= budget || shortlist.length >= SOCIAL_CANDIDATE_DEPTH) break;
        if (seen.has(r.pid)) continue;
        seen.add(r.pid);
        shortlist.push(r.pid);
        taken++;
      }
    };
    take(byNew, NEW_BUDGET);
    take(prelim, SOCIAL_CANDIDATE_DEPTH);   // the rest, best sellers first
    take(byNew, SOCIAL_CANDIDATE_DEPTH);    // and top up if sales ran short

    // /locations is a ~10-row config node, so this is a whole-node read of a
    // node that is a constant in practice. It is the one read in this function
    // that does not fit the partial-read rule, and it is called out rather than
    // hidden.
    //
    // ONLY the unsellable locations are dropped, and that list is
    // UNSELLABLE_LOCATIONS — the same one the Shopify inventory push uses.
    //
    // An earlier version also dropped `active: false` locations to save reads.
    // That quietly re-opened the very divergence the stock-parity test exists
    // to close, one level ABOVE where that test can see it: the retired
    // `studio` and `base` buckets still hold real /stock counts, networkTotals
    // counts them, and so social would have seen LESS stock than Shopify
    // sells. Safe in direction (a missed post, not a sold-out link) and wrong
    // in principle — the two must answer identically, and a saving of a few
    // hundred point reads is not worth a second source of truth.
    const locationsSnap = await db.ref("locations").once("value");
    const locations = Object.keys(locationsSnap.val() || {})
      .filter((id) => !socialSelect.UNSELLABLE_LOCATIONS.has(id));
    const products = {}, stockByPid = {};
    const READ_BATCH = 20;
    for (let i = 0; i < shortlist.length; i += READ_BATCH) {
      const slice = shortlist.slice(i, i + READ_BATCH);
      await Promise.all(slice.map(async (pid) => {
        const [rec, ...cells] = await Promise.all([
          db.ref(`products/${pid}`).once("value"),
          ...locations.map((loc) => db.ref(`stock/${loc}/${pid}`).once("value")),
        ]);
        const v = rec.val();
        if (!v) return;
        products[pid] = v;
        const tree = {};
        locations.forEach((loc, j) => { const c = cells[j].val(); if (c) tree[loc] = c; });
        stockByPid[pid] = tree;
      }));
    }

    const shortNodes = {};
    for (const pid of shortlist) if (liveNodes[pid]) shortNodes[pid] = liveNodes[pid];
    const candidates = socialSelect.buildCandidates({
      liveNodes: shortNodes, products, stockByPid,
      salesByPid: signal.unitsByPid || {}, postedAtByPid, nowMs,
    });

    // ── 4. Make each post ────────────────────────────────────────────────────
    const used = new Set();
    const created = [];
    const skipped = [];
    let estCostUSD = 0;

    // Slots for the batch, skipping evenings already taken by a post that is
    // still going to be sent. Computed HERE rather than per post so two posts
    // in one run cannot land on the same evening.
    const existingForSlots = [];
    for (const s of ["draft", "approved", "posting"]) {
      const snap = await db.ref(SOCIAL_POSTS_PATH).orderByChild("status").equalTo(s).limitToLast(100).once("value");
      for (const p of Object.values(snap.val() || {})) existingForSlots.push(p);
    }
    const slots = socialScheduleSlots(existingForSlots, kinds.length, nowMs);
    // ── A MISSING SLOT IS NOT AN EMPTY FIELD ─────────────────────────────────
    // `scheduledAt: null` means DUE IMMEDIATELY to the publisher (socialCore
    // isDue), so writing null for the slots that could not be found would send
    // a whole batch out on the next tick — the very failure the horizon fix in
    // nextSlots addressed, re-opened from the server side. If the schedule is
    // genuinely full this far ahead, that is worth SAYING rather than quietly
    // posting everything at once.
    if (slots.length < kinds.length) {
      console.warn(`social: only ${slots.length} free slot(s) for ${kinds.length} post(s) — the rest are not scheduled.`);
    }

    for (const [index, kind] of kinds.entries()) {
      const { picks, reason } = socialSelect.pickForKind(kind, candidates, { used });
      if (!picks.length) { skipped.push({ kind, reason }); continue; }

      const postId = db.ref(SOCIAL_POSTS_PATH).push().key;
      const spec = socialSelect.POST_KINDS.find((k) => k.key === kind);
      let media = [];
      let costUSD = 0;
      // Set once the paid image is in Storage. If the record write then fails,
      // the object is referenced by nothing and nothing would ever clean it up
      // — so the catch deletes it. The COST is still counted either way:
      // estCostUSD is incremented at generation, so the ledger stays honest
      // about money spent even when the picture is lost.
      let uploadedPath = null;
      // What was ACTUALLY sent to the model — library references plus Style Kit
      // references. Recording only the library share meant a post grounded on
      // six Style Kit photographs was filed as refsUsed: 0, i.e. the audit
      // trail said it ran ungrounded when it had not.
      let refsSent = 0;
      try {
        if (!spec.generates) {
          // New arrivals: a carousel of the products' EXISTING photographs.
          // Nothing is generated and nothing is paid for — the photographs the
          // storefront already leads with are the right pictures for a post
          // saying "this just went live".
          media = picks.map((p) => ({ url: p.photoUrl, type: "image", pid: p.pid }));
        } else {
          const images = [];
          for (const p of picks) {
            const { buffer, contentType } = await fetchImageBuffer(p.photoUrl);
            images.push({ buffer, contentType, name: p.name });
          }
          // House style REFUSES to run ungrounded, exactly as the product
          // pipeline does: a Nano Banana Pro generation with no reference
          // photographs is an invented backdrop, not our backdrop, and burning
          // $0.134 on one is worse than saying so.
          const kitRefs = styleKit ? (styleKit[picks[0].productType === "clothing" ? "clothing" : "sneaker"] || {}).refs || [] : [];
          const refs = [...library.refs, ...kitRefs].slice(0, SOCIAL_MAX_REFS);
          refsSent = refs.length;
          if (style === "house" && !refs.length) {
            throw new Error("house style: no usable style references — add photos to the Style library or the AI Studio Style Kit");
          }
          const prompt = socialCaption.buildScenePrompt({
            kind,
            productNames: picks.map((p) => p.name),
            style,
            styleNotes: library.notes,
          });
          const gen = await generateSocialScene(geminiApiKey.value(), prompt, images, refs);
          costUSD = gen.costUSD;
          estCostUSD += gen.costUSD;
          const { buffer: outBuf, mime } = await normalizeSocialImage(gen.buffer, gen.mime);
          uploadedPath = `aiStudio/social/posts/${postId}/0`;   // for the cleanup below
          media = [{ url: await uploadSocialImage(postId, 0, outBuf, mime), type: "image" }];
        }

        // ── THE LINK ─────────────────────────────────────────────────────
        // One product → that product's page. Several → the storefront's front
        // door, NOT the first product's page: a flat-lay caption that links to
        // one of five items sends four out of five interested customers to the
        // wrong thing. There is no "these five products" URL to link to, and
        // inventing one that 404s would be worse than the front door.
        const link = picks.length === 1 ? picks[0].link : SOCIAL_STOREFRONT;
        const { caption, source: captionSource, reason: captionReason } =
          await writeSocialCaption({ kind, picks, link, styleNotes: library.notes });

        await db.ref(`${SOCIAL_POSTS_PATH}/${postId}`).set({
          status: "draft",                       // the ONLY status this function writes
          kind,
          media,
          caption,
          captionSource,
          ...(captionReason ? { captionNote: captionReason } : {}),
          link,
          platforms,
          // No slot ⇒ the post is created UNSCHEDULED and, crucially, is
          // reported as such below. It still cannot go out without approval.
          scheduledAt: slots[index] || null,
          ...(slots[index] ? {} : { unscheduledReason: "no free posting slot was available" }),
          products: picks.map((p) => ({ pid: p.pid, name: p.name, handle: p.handle, slot: p.slot || null })),
          style,
          engine: spec.generates ? "nbpro" : "none",
          costUSD: +costUSD.toFixed(6),
          refsUsed: spec.generates ? refsSent : 0,
          generatedBy: "generator",
          signalSource: signal.source,
          signalCoverage: signal.coverage ?? null,
          // Recorded per post: a ranking built on a truncated window is a
          // floor, and the record must say so rather than looking authoritative.
          signalTruncated: signal.pagesTruncated === true,
          createdAt: nowMs,
          updatedAt: nowMs,
          updatedBy: request.auth.uid,
        });
        for (const p of picks) used.add(p.pid);
        created.push({
          postId, kind, products: picks.length, costUSD: +costUSD.toFixed(6), captionSource,
          scheduledAt: slots[index] || null,
        });
      } catch (err) {
        console.warn(`social: ${kind} failed:`, err && err.message);
        // Best-effort cleanup of an image that was paid for, uploaded, and then
        // orphaned by a failed record write. A failure here is logged and
        // ignored — an orphan costs pennies of storage; throwing would lose the
        // reason the post failed in the first place.
        if (uploadedPath && media.length) {
          try {
            const objectPath = decodeURIComponent(new URL(media[0].url).pathname.split("/o/")[1] || "");
            if (objectPath) await admin.storage().bucket(STORAGE_BUCKET).file(objectPath).delete();
          } catch (cleanupErr) {
            console.warn(`social: could not clean up the orphaned image for ${postId}:`, cleanupErr && cleanupErr.message);
          }
        }
        skipped.push({ kind, reason: classifyPhotoError(err && err.message, "nbpro") });
      }
    }

    await logReorderUsage(db, saDateForUsage(nowMs), {
      at: nowMs, kind: "generateSocialPosts", by: request.auth.uid,
      postsCreated: created.length, skipped: skipped.length,
      estimatedCostUSD: +estCostUSD.toFixed(4), style,
    });

    return {
      created, skipped,
      estCostUSD: +estCostUSD.toFixed(4),
      candidates: candidates.length,
      signal: {
        source: signal.source,
        coverage: signal.coverage ?? null,
        windowDays: signal.windowDays ?? null,
        truncated: signal.pagesTruncated === true,
      },
      styleRefs: { sent: library.refs.length, inLibrary: library.total },
    };
  }
);

// The three-a-week slots, as the queue and the publisher understand them:
// Monday, Wednesday and Saturday at 18:00 SAST. A deliberate twin of nextSlots
// / assignSlots in src/components/social/socialCore.js — the browser shows the
// dates and this writes them, and social-select.test.cjs pins the two to the
// same answers. SAST is UTC+2 with no DST, so the conversion is a constant.
function socialScheduleSlots(existingPosts, count, fromMs) {
  const SAST = 2 * 60 * 60 * 1000, DAY = 86400000, DAYS = [1, 3, 6], HOUR = 18;
  const taken = new Set((existingPosts || [])
    .map((p) => Number(p && p.scheduledAt)).filter((n) => Number.isFinite(n)));
  const out = [];
  // The horizon is derived from how many slots are wanted, not fixed — see
  // nextSlots in socialCore.js for why a flat 28-day walk silently capped at
  // twelve and turned the overflow into "post immediately".
  const wanted = count + taken.size + 4;
  const horizon = Math.min(366, Math.ceil(wanted / DAYS.length) * 7 + 14);
  const startDay = Math.floor((fromMs + SAST) / DAY);
  for (let d = 0; d < horizon && out.length < count; d++) {
    const midnightUtc = (startDay + d) * DAY - SAST;
    if (!DAYS.includes(new Date(midnightUtc + SAST).getUTCDay())) continue;
    const slot = midnightUtc + HOUR * 3600000;
    if (slot < fromMs || taken.has(slot)) continue;
    out.push(slot);
  }
  return out;
}

// The usage ledger is keyed by SA calendar date, like every other entry in it.
const saDateForUsage = (ms) => require("./lib/sa-time.cjs").saDateStringFromMs(ms);
