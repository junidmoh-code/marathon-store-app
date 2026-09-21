// ─── HOW MUCH GEMINI CREDIT IS LEFT, AND WHEN TO SHOUT (PURE) ────────────────
// One prepaid wallet pays for EVERY Gemini call this business makes: the social
// engine's image generation, product photo generation, the AI assistant, and
// card recon's slip OCR. When it empties, all of them stop — and on 19 Sept
// 2026 nobody found out for a day, because each feature failed in its own quiet
// way and nothing watched the money.
//
// ── WHY A PROJECTION AND NOT A READING ───────────────────────────────────────
// There is NO API that returns the balance. Checked properly on 19 Sept 2026:
// the Gemini API's discovery document carries no credit, balance or billing
// resource, and `generativelanguage.googleapis.com` is DISABLED on the
// marathon-club GCP project — the key bills to the AI Studio prepay wallet,
// which sits outside Cloud Billing entirely, so a native billing budget cannot
// see this spend either.
//
// So the balance is RECONSTRUCTED: a top-up the owner records, minus the spend
// already metered at /aiAssistant/usage. That ledger has been running since
// 21 Aug 2026 and holds $146.54 of real spend, ending on 12 Sept — the day
// before the outage began, which is exactly what an emptied wallet looks like.
//
// ── THE COST FIELD IS NOT ONE FIELD, AND THAT MATTERS ────────────────────────
// Writers disagree: card recon's OCR logs `costUSD`, the image generators log
// `estimatedCostUSD`, and one path carries `costByEngine`. Summing only the
// first reports $0.0456 across all time and makes a full wallet look untouched
// — which is precisely the mistake that was made while building this, so the
// reader takes EVERY known name rather than the one it expects. A new writer
// that invents a fourth name will under-report, so `costOf` is the single
// place this is decided and the place to add one.

"use strict";

/** Every field name a usage row has ever carried a dollar figure in. */
const COST_FIELDS = ["costUSD", "estimatedCostUSD", "estCostUSD"];

/**
 * What one usage row cost, in dollars.
 *
 * FIRST PRESENT FIELD WINS, not the largest and not the sum — a row carrying
 * both would be one figure written twice, never two charges.
 */
function costOf(row) {
  if (!row || typeof row !== "object") return 0;
  for (const f of COST_FIELDS) {
    const v = Number(row[f]);
    if (Number.isFinite(v) && v !== 0) return v;
  }
  return 0;
}

/**
 * Total metered spend at or after `sinceMs`, and the per-day burn.
 *
 * @param {object|null} usageNode  /aiAssistant/usage — { "YYYY-MM-DD": { pushKey: row } }
 * @param {number} sinceMs         the top-up moment; rows before it are another wallet's
 * @param {number} nowMs
 * @returns {{spendUSD:number, rows:number, days:number, burnPerDayUSD:number, lastSpendAt:number|null}}
 */
function spendSince(usageNode, sinceMs, nowMs) {
  let spendUSD = 0, rows = 0, lastSpendAt = null;
  for (const day of Object.values(usageNode || {})) {
    // RTDB hands a sparse array back as an object and a dense one as an array
    // with null holes; both shapes are walked and holes skipped.
    const entries = Array.isArray(day) ? day : Object.values(day || {});
    for (const row of entries) {
      if (!row || typeof row !== "object") continue;
      // THE ROW'S OWN STAMP DECIDES, never the day key it is filed under. The
      // usage log is keyed by SA date and the top-up is a moment, so a top-up
      // made at midday must not be credited with that morning's spend.
      const at = Number(row.at);
      if (!Number.isFinite(at) || at < sinceMs) continue;
      const c = costOf(row);
      spendUSD += c;
      if (c) { rows++; lastSpendAt = Math.max(lastSpendAt || 0, at); }
    }
  }
  // AT LEAST ONE DAY, always. A top-up an hour ago with $3 spent since is not
  // a burn rate of $72/day — dividing by a fraction of a day turns a busy
  // afternoon into a false alarm, and the first hours after a top-up are
  // exactly when the owner has just acted and least needs shouting at.
  const days = Math.max(1, (nowMs - sinceMs) / 86400000);
  return {
    spendUSD: +spendUSD.toFixed(4),
    rows,
    days: +days.toFixed(2),
    burnPerDayUSD: +(spendUSD / days).toFixed(4),
    lastSpendAt,
  };
}

// ── THE THRESHOLDS ───────────────────────────────────────────────────────────
// Measured against the real ledger: a quiet day is ~$0.95 (the social engine
// alone), a product-photo day reaches $5-9. So "days left" is the honest unit
// for a quiet week and useless on a photo day, and a dollar floor is the
// reverse — hence both, whichever trips first.
const LOW_BALANCE_USD = 5;
const LOW_DAYS = 7;

/**
 * What the wallet looks like, and how loudly to say it.
 *
 * `level` is one of:
 *   "unknown"  — no top-up recorded, so there is nothing to project from.
 *                NEVER reported as healthy: a silent watchdog and a happy one
 *                must not look alike.
 *   "ok"       — comfortably above both thresholds
 *   "low"      — under the dollar floor or inside the days floor
 *   "empty"    — the canary got a 402/429, or the projection is at zero
 *
 * The CANARY OVERRIDES THE PROJECTION, always. The projection is arithmetic
 * over what we metered; the canary is the wallet answering for itself. When
 * they disagree the wallet is right — that is the whole reason it exists,
 * because spend we never metered (a price change, another consumer of the
 * same key, a retry storm) is invisible to the sum and fatal to the estimate.
 */
function assessCredit({ toppedUpUSD, toppedUpAt, spend, canaryExhausted = false, nowMs }) {
  const known = Number.isFinite(Number(toppedUpUSD)) && Number(toppedUpUSD) > 0
    && Number.isFinite(Number(toppedUpAt)) && Number(toppedUpAt) > 0;

  const remainingUSD = known ? +(Number(toppedUpUSD) - spend.spendUSD).toFixed(4) : null;
  const daysLeft = known && spend.burnPerDayUSD > 0
    ? +(Math.max(0, remainingUSD) / spend.burnPerDayUSD).toFixed(1)
    : null;

  let level;
  if (canaryExhausted) level = "empty";
  else if (!known) level = "unknown";
  else if (remainingUSD <= 0) level = "empty";
  else if (remainingUSD < LOW_BALANCE_USD || (daysLeft !== null && daysLeft < LOW_DAYS)) level = "low";
  else level = "ok";

  return {
    level,
    known,
    canaryExhausted: !!canaryExhausted,
    toppedUpUSD: known ? +Number(toppedUpUSD).toFixed(2) : null,
    toppedUpAt: known ? Number(toppedUpAt) : null,
    spendUSD: spend.spendUSD,
    burnPerDayUSD: spend.burnPerDayUSD,
    remainingUSD,
    daysLeft,
    checkedAt: nowMs,
  };
}

// ── WHEN TO SEND AN EMAIL, AS OPPOSED TO WHEN TO BE WORRIED ──────────────────
// A scan every hour must not send an email every hour. One per level, and a
// reminder every six hours while it lasts — the same shape as the poller
// alarm, for the same reason: a daily wall of identical mail is unread mail.
//
// THE SIGNATURE IS THE LEVEL, so "low" escalating to "empty" is a NEW alarm
// and mails immediately rather than waiting out the reminder window. Going the
// other way — empty back to low after a top-up — is a recovery, not an alarm.
const REMINDER_MS = 6 * 60 * 60 * 1000;
const ALARM_LEVELS = new Set(["low", "empty"]);

/**
 * @param {object} state      the assessment above
 * @param {object|null} last  { at, signature } of the last alarm sent
 * @returns {{alarm:boolean, recovered:boolean, signature:string}}
 */
function creditAlarmDecision(state, last, nowMs) {
  const signature = state.level;
  const shouting = ALARM_LEVELS.has(state.level);
  if (!shouting) {
    return { alarm: false, recovered: !!last, signature };
  }
  if (!last || last.signature !== signature) return { alarm: true, recovered: false, signature };
  return { alarm: nowMs - Number(last.at || 0) >= REMINDER_MS, recovered: false, signature };
}

/** The marker line Cloud Monitoring turns into an email. */
function creditAlarmLine(state) {
  const money = (n) => `$${Number(n).toFixed(2)}`;
  const head = state.canaryExhausted
    ? "The Gemini prepay wallet is EMPTY — the API is refusing every call (HTTP 402)."
    : state.level === "empty"
      ? `The Gemini prepay wallet is projected EMPTY (${money(state.remainingUSD)} left of ${money(state.toppedUpUSD)}).`
      : `The Gemini prepay wallet is LOW: ${money(state.remainingUSD)} left of ${money(state.toppedUpUSD)}`
        + (state.daysLeft !== null ? `, about ${state.daysLeft} day${state.daysLeft === 1 ? "" : "s"} at ${money(state.burnPerDayUSD)}/day.` : ".");
  return `AI_CREDIT_ALARM ${head} `
    + `ONE key pays for all of it: social image generation, product photos and card-recon slip OCR — `
    + `when it empties, photo capture at every till stops and the social feed goes dark. `
    + `Top up at https://aistudio.google.com/app/apikey (project marathon-club), `
    + `then record the amount so the projection resets.`;
}

module.exports = {
  COST_FIELDS, LOW_BALANCE_USD, LOW_DAYS, REMINDER_MS,
  costOf, spendSince, assessCredit, creditAlarmDecision, creditAlarmLine,
};
