// ─── RECORD A GEMINI TOP-UP ──────────────────────────────────────────────────
// The one fact the credit projection cannot work out for itself.
//
// There is NO API that returns the prepay balance — checked on 2026-09-19: the
// Gemini discovery document carries no credit or balance resource, and
// generativelanguage.googleapis.com is DISABLED on this GCP project because the
// key bills to the AI Studio prepay wallet, which sits outside Cloud Billing
// altogether. So the balance is reconstructed: what was put in, minus what has
// been metered at /aiAssistant/usage since.
//
// That makes this script the moment the projection resets. Run it right after
// topping up at https://aistudio.google.com/app/apikey (project marathon-club):
//
//   node scripts/record-ai-topup.mjs 50
//   node scripts/record-ai-topup.mjs 50 --at 2026-09-20T09:30:00+02:00
//   node scripts/record-ai-topup.mjs --show
//
// THE TIME MATTERS AS MUCH AS THE AMOUNT. Spend is counted from the moment
// recorded here, so a top-up logged a day late credits this wallet with a day
// of the last one's spending and under-reports what is left. `--at` exists for
// exactly that: record it with the time it actually happened.
//
// NOTHING BREAKS IF THIS IS NEVER RUN. The projection reports "unknown" — never
// "ok" — and the hourly canary still catches an empty wallet. What is lost is
// the warning BEFOREHAND, which is the whole point of the projection.

import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const PATH = "config/aiCredits";

const args = process.argv.slice(2);
const SHOW = args.includes("--show");
const atArg = args.includes("--at") ? args[args.indexOf("--at") + 1] : null;
const amountArg = args.find((a) => /^[0-9]+(\.[0-9]{1,2})?$/.test(a));

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
const db = admin.database();

const money = (n) => `$${Number(n).toFixed(2)}`;
const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";

if (SHOW) {
  const [credits, status] = await Promise.all([
    db.ref(PATH).once("value").then((s) => s.val()),
    db.ref("ai_credit_status").once("value").then((s) => s.val()),
  ]);
  if (!credits || !credits.amountUSD) {
    console.log("No top-up recorded. The projection cannot run; only the hourly canary is watching.");
  } else {
    console.log(`Last top-up: ${money(credits.amountUSD)} at ${when(credits.at)}${credits.note ? ` — ${credits.note}` : ""}`);
  }
  if (status) {
    console.log(`Watchdog: level=${status.level} spend=${money(status.spendUSD || 0)} `
      + `burn=${money(status.burnPerDayUSD || 0)}/day `
      + `remaining=${status.remainingUSD === null || status.remainingUSD === undefined ? "unknown" : money(status.remainingUSD)}`
      + `${status.daysLeft ? ` (~${status.daysLeft} days)` : ""}`);
    console.log(`  checked ${status.checkedAt ? when(status.checkedAt) : "never"}`
      + `${status.canary ? `, canary ${status.canary.exhausted ? "EXHAUSTED" : status.canary.reachable ? "ok" : "unreachable"}` : ""}`);
  } else {
    console.log("Watchdog has not written a status yet — has aiCreditScan been deployed?");
  }
  await admin.app().delete();
  process.exit(0);
}

if (!amountArg) {
  console.error("Usage: node scripts/record-ai-topup.mjs <amountUSD> [--at <ISO8601>]\n"
    + "       node scripts/record-ai-topup.mjs --show");
  await admin.app().delete();
  process.exit(1);
}

const amountUSD = Number(amountArg);
// A TYPO HERE BECOMES A WRONG BALANCE FOR A MONTH, and the alarm's whole job is
// to be believed. The ceiling is not a policy about spending — it is a guard
// against a fat-fingered "5000" that would silence the alarm until the wallet
// ran dry in the background.
if (!(amountUSD > 0) || amountUSD > 1000) {
  console.error(`✗ ${money(amountUSD)} does not look like a top-up. Expected between $0.01 and $1000.`);
  await admin.app().delete();
  process.exit(1);
}

let at = Date.now();
if (atArg) {
  const parsed = Date.parse(atArg);
  if (!Number.isFinite(parsed)) {
    console.error(`✗ could not read "${atArg}" as a date. Use an ISO 8601 stamp, e.g. 2026-09-20T09:30:00+02:00`);
    await admin.app().delete();
    process.exit(1);
  }
  // A top-up in the FUTURE would exclude all spend until that moment and
  // report a full wallet however much is used — a silent alarm, which is the
  // one failure mode this whole feature exists to remove.
  if (parsed > Date.now() + 60000) {
    console.error(`✗ ${when(parsed)} is in the future — spend is counted from this moment, so a future stamp hides every charge until then.`);
    await admin.app().delete();
    process.exit(1);
  }
  at = parsed;
}

const prior = (await db.ref(PATH).once("value")).val();
await db.ref(PATH).set({
  amountUSD, at,
  recordedAt: Date.now(),
  // Kept so the history of a wallet is readable without a separate ledger.
  previous: prior ? { amountUSD: prior.amountUSD ?? null, at: prior.at ?? null } : null,
});

console.log(`✓ recorded ${money(amountUSD)} topped up at ${when(at)}`);
if (prior?.at) console.log(`  (previous: ${money(prior.amountUSD)} at ${when(prior.at)})`);
console.log("  aiCreditScan runs hourly and will reset the projection on its next pass.");

await admin.app().delete();
