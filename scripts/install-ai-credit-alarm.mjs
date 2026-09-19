// ─── THE GEMINI CREDIT ALARM ─────────────────────────────────────────────────
//
// aiCreditScan (functions/index.js) prints one line when the shared Gemini
// prepay wallet is running low or has emptied:
//
//     AI_CREDIT_ALARM The Gemini prepay wallet is LOW: $4.12 left of $50.00, …
//
// This script creates the Cloud Monitoring machinery that turns that line into
// an email to the owner, and — with --verify — proves it is still there. The
// machinery itself lives in scripts/lib/alarm-install.mjs, shared with the
// poller alarm; only the description below is particular to this one.
//
// WHY THIS EXISTS: ONE prepaid wallet pays for the social image engine, product
// photo generation, the AI assistant and card-recon slip OCR. It emptied on
// 2026-09-13 and the social feed went dark; six days later a manager found the
// same outage by standing at a till with a slip in hand, because photo capture
// had been failing estate-wide all day. Nothing watched the money, and each
// feature failed in its own quiet way. This makes the NEXT one arrive by email,
// with days to spare rather than after the fact.
//
// THE ALARM RUNS ON GOOGLE'S INFRASTRUCTURE, never on the Mac mini and never on
// anything the outage could take with it.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   node scripts/install-ai-credit-alarm.mjs            # create / update
//   node scripts/install-ai-credit-alarm.mjs --verify   # assert, change nothing
//   node scripts/install-ai-credit-alarm.mjs --test     # emit a real test alarm
//
// Needs application-default credentials with permission to manage Monitoring
// and Logging in marathon-club — i.e. `gcloud auth application-default login`
// as an owner. This is setup, not run-time.

import { installAlarm } from "./lib/alarm-install.mjs";

// THE MARKER. The same literal appears in functions/index.js (lib/ai-credit.cjs
// writes it). If these ever disagree the alarm is disconnected and every green
// check stays green, which is the exact failure the whole feature exists to
// prevent — so the pin below reads the source and asserts they match rather
// than trusting a comment.
export const MARKER = "AI_CREDIT_ALARM";

const args = process.argv.slice(2);

const ok = await installAlarm({
  marker: MARKER,
  // A longer substring than the marker alone: the marker also appears in this
  // file and in the test line, so pinning on it would be satisfied by its own
  // mention. This is the sentence the function actually composes.
  markerPin: "AI_CREDIT_ALARM ${head}",
  sourceFile: new URL("../functions/lib/ai-credit.cjs", import.meta.url),
  metric: "ai_credit_alarm",
  // The Cloud Run service is the function name, lowercased.
  service: "aicreditscan",
  policyName: "AI credit (Gemini) alarm",
  conditionLabel: "aiCreditScan raised the credit alarm",
  recipient: "junidmoh@gmail.com",
  channelName: "Junid — Marathon alarms",
  channelDescription: "Raised by aiCreditScan when the shared Gemini prepay wallet runs low or empties.",
  documentation:
    "The shared Gemini prepay wallet is low or empty. **ONE key pays for all of it**: the social image " +
    "engine, product photo generation, the AI assistant and card-recon slip OCR. When it empties, photo " +
    "capture stops at every till and the social feed goes dark — and each of those fails in its own quiet " +
    "way, which is why this alarm exists.\n\n" +
    "Top up at https://aistudio.google.com/app/apikey (project `marathon-club`), then record the amount so " +
    "the projection resets:\n\n" +
    "    node scripts/record-ai-topup.mjs <amountUSD>\n\n" +
    "Until an amount is recorded the projection cannot run and only the hourly canary is watching — that " +
    "still catches an empty wallet, but it cannot warn you beforehand.\n\n" +
    "The watchdog's own verdict is in Realtime Database at `/ai_credit_status`; the metered spend it reads " +
    "is at `/aiAssistant/usage`.",
  testLine: `${MARKER} TEST — this is install-ai-credit-alarm.mjs --test proving the alarm reaches an inbox. Nothing is wrong.`,
}, { verify: args.includes("--verify"), test: args.includes("--test") });

if (!ok) {
  console.error("\n✗✗ the alarm is NOT fully installed — see above");
  process.exitCode = 1;
} else {
  console.log(`\n${args.includes("--verify") ? "The alarm is installed and wired." : "Done."} A low or empty wallet now emails junidmoh@gmail.com.`);
}
