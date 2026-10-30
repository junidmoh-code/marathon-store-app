#!/usr/bin/env node
// Book an online exchange's RETURN leg (locker-to-door, the locker nearest the customer): scripts/shipping/bookReturn.mjs.
// Called by Jimmy (marathon-dm-agent src/jimmy/returnBooking.js) from this checkout; prints ONE JSON line.
//
//   node scripts/shipping/book-return.mjs --key exchange-1793-1793333411004 [--email them@example.com]
//
// Exit 0 with { booked: true, … } or { skipped: true, reason, refused?, dryRun? }; exit 1 with { error, ambiguous }
// (ambiguous: the create may have run, check the portal before anything retries).
import { bookReturn } from "./bookReturn.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? null : null;
};
const key = arg("key");
try {
  if (!key) throw new Error("--key exchange-<n>-<paidAtMs> is required");
  const out = await bookReturn(key, { email: arg("email") });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: String(err?.message || err).slice(0, 400), ambiguous: !!err?.ambiguous })}\n`);
  process.exit(1);
}
