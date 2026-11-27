#!/usr/bin/env node
// Book an online exchange's RETURN leg (locker-to-door, the locker nearest the customer): scripts/shipping/bookReturn.mjs.
// Called by Jimmy (marathon-dm-agent src/jimmy/returnBooking.js) from this checkout; prints ONE JSON line.
//
//   node scripts/shipping/book-return.mjs --key exchange-1793-1793333411004 [--email them@example.com] [--door-collection | --no-door-collection]
//     [--collection locker|door]
//
// --collection door: the CUSTOMER chose a door collection on the exchange page (Junid, 25 Nov 2026): no locker is looked
// for, a courier collects from their address (mode "door_collection", doorFallback.kind "customer_choice"). Default locker.
//
// No locker for the parcel (Junid, 24 Nov 2026): a courier collects from the customer's door instead, ONLY when
// /config/shipping/returnDoorCollection is true or --door-collection is passed (a caller that reads `mode:
// "door_collection"` and tells the customer a courier will collect, never "drop it at the locker"); --no-door-collection
// forces the old refusal. The answer carries mode: "locker_dropoff" | "door_collection".
//
// Exit 0 with { booked: true, … } or { skipped: true, reason, refused?, dryRun? }; exit 1 with { error, ambiguous }
// (ambiguous: the create may have run, check the portal before anything retries).
import { bookReturn } from "./bookReturn.mjs";
import { flag } from "./exchangeQuote.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? null : null;
};
const key = arg("key");
try {
  if (!key) throw new Error("--key exchange-<n>-<paidAtMs> is required");
  const doorCollection = process.argv.includes("--door-collection") ? true : process.argv.includes("--no-door-collection") ? false : null;
  // Given without locker/door → an error (one JSON line), never a silent locker; absent → locker.
  const c = flag(process.argv, "collection", { allowed: ["locker", "door"] });
  const collection = c.present ? c.value : "locker";
  const out = await bookReturn(key, { email: arg("email"), doorCollection, collection });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: String(err?.message || err).slice(0, 400), ambiguous: !!err?.ambiguous, ...(err?.transient ? { transient: true } : {}) })}\n`);
  process.exit(1);
}
