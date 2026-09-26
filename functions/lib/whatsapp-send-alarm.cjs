// ─── WHATSAPP SEND ALARM — a refused customer message emails Junid ──────────
// deliverOutboxDoc (lib/outbox-deliver.cjs) prints ONE line whenever a send to
// Meta fails:
//
//     WHATSAPP_SEND_ALARM order_ready to ***3356 was REFUSED (attempt 1 of 2, will retry) — Meta payment problem … Meta said: (#131042) … Outbox doc 9vLa….
//
// A Cloud Monitoring log-match policy (scripts/whatsapp/install-send-alarm.mjs)
// turns that line into an email to Junid — the same route as the card-recon,
// social, write-off and device-enrolment alarms. EMAIL ONLY, never WhatsApp:
// an alarm about WhatsApp cannot travel over WhatsApp.
//
// WHY EVERY FAILURE AND NOT A THRESHOLD: on 26 Sep 2026 the outbox held 40
// "failed" docs in its whole history, every one from a single Meta incident on
// 12 Jun 2026 — there is no background noise of per-customer failures to filter
// out. One failure is news. The policy's rate limit (one email per 5 minutes)
// is what stops an outage from flooding the inbox, not this code.
//
// Pure: no I/O, never throws on any input, so it cannot break the delivery
// path's no-throw contract.
"use strict";

const MARKER = "WHATSAPP_SEND_ALARM";
// TWO policies, because a log-match policy sends at most one email per 5
// minutes: Meta refuses attempt 1 ("will retry"), the sweep retries a minute
// later and gives up — and on ONE policy that terminal email is swallowed, so
// Junid's only word would be "will retry" (Fable review, PR #655). The
// terminal line carries GAVE_UP and gets a policy of its own.
const POLICY_NAME = "WhatsApp order message refused";
const GAVE_UP_POLICY_NAME = "WhatsApp order message NOT sent (gave up)";
const GAVE_UP = "FAILED, gave up";   // plain ASCII: it is a Cloud Logging filter substring
const RECIPIENT = "junidmoh@gmail.com";

// What each Meta error code means for Junid, in words that say what to do.
// Codes from Meta's Cloud API error reference; anything unlisted falls back to
// Meta's own message, which the alarm line always carries anyway.
const META_CODE_HINTS = {
  0:      "Meta could not authenticate the token — rotate the meta-whatsapp-token secret",
  10:     "Meta refused permission for this token — check the system user still owns the WhatsApp account",
  190:    "Meta token expired or revoked — rotate the meta-whatsapp-token secret",
  368:    "Meta temporarily blocked the number for a policy violation — check WhatsApp Manager",
  130429: "Meta throughput limit hit — too many messages too fast",
  131000: "Meta internal error — usually passes, check again if it repeats",
  131031: "Meta LOCKED the WhatsApp Business account — check WhatsApp Manager",
  131042: "Meta PAYMENT problem on the WhatsApp Business account — fix the payment method in Meta Business billing",
  131048: "Meta spam rate limit — too many customers blocked or reported the number",
  131056: "Too many messages to the same customer too fast",
  132000: "Template parameter count does not match the approved template",
  132001: "Template does not exist or is not approved in WhatsApp Manager",
  133010: "The phone number is not registered with the WhatsApp Cloud API",
};

const oneLine = (s, max) => {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

// The human reason for a failed send: the Meta code's hint when there is one,
// otherwise the shape of the failure.
function explainSendFailure(args) {
  const { metaCode, preflight } = args || {};
  if (preflight) return "the send never left Google — the Meta token secret is not reachable from the function";
  const code = Number(metaCode);
  if (metaCode != null && Object.prototype.hasOwnProperty.call(META_CODE_HINTS, code)) return META_CODE_HINTS[code];
  if (metaCode != null) return `Meta refused it with error ${metaCode}`;
  return "Meta could not be reached or gave no error code";
}

// The one line the policy matches. `outcome` is the ladder's own word:
// "failed" (terminal), "retry" (Meta attempt burned, will retry) or
// "retry-infra" (nothing sent, will retry).
function alarmLine(args) {
  try {
    const { docId, templateName, recipient, outcome, attempts, maxAttempts, metaCode, preflight, error } = args || {};
    const what = outcome === "failed"
      ? `${GAVE_UP} after ${attempts ?? "?"} attempt(s); the customer was NOT messaged`
      : outcome === "retry-infra"
        ? "was NOT sent (will retry)"
        : `was REFUSED (attempt ${attempts ?? "?"} of ${maxAttempts ?? "?"}, will retry)`;
    const code = metaCode != null ? ` [Meta code ${metaCode}]` : "";
    return oneLine(
      `${MARKER} ${templateName || "?"} to ${recipient || "?"} ${what} — ${explainSendFailure({ metaCode, preflight })}.${code} ` +
      `Meta said: ${error || "nothing"}. Outbox doc ${docId || "?"}.`,
      600,
    );
  } catch {
    return `${MARKER} a WhatsApp send failed (details could not be formatted).`;
  }
}

module.exports = { MARKER, POLICY_NAME, GAVE_UP_POLICY_NAME, GAVE_UP, RECIPIENT, META_CODE_HINTS, explainSendFailure, alarmLine };
