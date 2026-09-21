// ─── THE POLLER ALARM: A LOG MARKER, A GOOGLE-OPERATED POLICY, AN EMAIL ──────
//
// cardReconHealthScan (functions/index.js) prints one line when the card recon
// mailbox poller on the Mac mini has stopped ticking:
//
//     CARD_RECON_ALARM The card recon mailbox poller has not ticked for 42 minutes. …
//
// This script creates the Cloud Monitoring machinery that turns that line into
// an email to the owner, and — with --verify — proves it is still there.
//
// THE MACHINERY NOW LIVES IN scripts/lib/alarm-install.mjs, shared with the
// Gemini credit alarm. It used to live here in full, and the credit alarm would
// have been its third near-identical copy — four hundred lines of retry rules,
// pagination, drift comparison and 404-versus-"don't know" reasoning, every
// line load-bearing and none of it obvious. This repo has already paid for that
// kind of duplication once: an installer that mirrored the poller's .env parser
// "drifted four times in one review cycle", and every drift had the same shape
// — the installer says fine and the failure appears in a log five minutes
// later. Behaviour here is unchanged; only its home moved.
//
// WHY THIS EXISTS: on 2026-08-31 launchd silently stopped firing the poller at
// 01:16 and payments sat unread for nine hours, because the only witness was a
// heartbeat panel the owner has to open. KeepAlive in the plist makes that
// death unlikely; this alarm makes the next one LOUD.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   node scripts/cardrecon/install-cardrecon-alarm.mjs            # create / update
//   node scripts/cardrecon/install-cardrecon-alarm.mjs --verify   # assert, change nothing
//   node scripts/cardrecon/install-cardrecon-alarm.mjs --test     # emit a real test alarm
//
// Needs application-default credentials with permission to manage Monitoring
// and Logging in marathon-club — i.e. `gcloud auth application-default login`
// as an owner. This is setup, not run-time.

import { installAlarm } from "../lib/alarm-install.mjs";

// THE MARKER. The same literal appears in functions/index.js. If these two ever
// disagree the alarm is disconnected and every green check stays green, which
// is the exact failure the whole feature exists to prevent — so the pin reads
// the function source and asserts they match, rather than trusting a comment.
export const MARKER = "CARD_RECON_ALARM";

const args = process.argv.slice(2);
const VERIFY = args.includes("--verify");

const ok = await installAlarm({
  marker: MARKER,
  markerPin: "CARD_RECON_ALARM The card recon mailbox poller",
  sourceFile: new URL("../../functions/index.js", import.meta.url),
  metric: "card_recon_alarm",
  service: "cardreconhealthscan",
  policyName: "Card recon poller alarm",
  conditionLabel: "cardReconHealthScan raised the alarm",
  recipient: "junidmoh@gmail.com",
  channelName: "Junid — card recon poller",
  channelDescription: "Raised by cardReconHealthScan when the mailbox poller on the Mac mini stops ticking.",
  documentation:
    "The card recon mailbox poller on the Mac mini has stopped ticking — card slips AND EFT payment " +
    "notifications are not being read until it is back. Check the mini is on and on the network, then: " +
    "`launchctl kickstart -k gui/501/com.marathon.cardreconpoll` and read " +
    "~/marathon-store-app/logs/card-recon-poll.log. The watchdog's verdict is in Realtime Database at " +
    "/card_batch_poll_health; the poller's own heartbeat at /card_batch_poll_status.",
  testLine: `${MARKER} TEST — this is install-cardrecon-alarm.mjs --test proving the alarm reaches an inbox. Nothing is wrong.`,
}, { verify: VERIFY, test: args.includes("--test") });

if (!ok) {
  console.error("\n✗✗ the alarm is NOT fully installed — see above");
  process.exitCode = 1;
} else {
  console.log(`\n${VERIFY ? "The alarm is installed and wired." : "Done."} A bad day now emails junidmoh@gmail.com.`);
}
