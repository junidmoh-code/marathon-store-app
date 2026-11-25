#!/usr/bin/env node
// A LIVE Courier Guy quote for an online exchange, both legs, RATES ONLY (scripts/shipping/exchangeQuote.mjs). Called by
// Jamie's exchange desk (marathon-dm-agent) from this checkout; prints ONE JSON line. Never books, never writes.
//
//   node scripts/shipping/exchange-quote.mjs --order-key 18985060335765 \
//     --returning '[{"pid":"p1785332131877","size":"6"}]' --replacement '[{"pid":"p1785332131877","size":"7"}]' \
//     --mode locker|door [--phone +27…] [--email them@example.com]
//
// Exit 0 with { ok: true, returnLeg: { rand, service, mode, locker }, outboundLeg: { rand, service } | null, totalCents,
// blockers } or { ok: false, reason, transient? }; exit 1 with { ok: false, error, transient? } on a crash. ALWAYS exactly
// one JSON line on stdout. The caller MUST read returnLeg.mode (locker_dropoff | door_collection) to tell the customer how
// the item comes back. --mode given without locker/door is an error, never a silent locker; absent = locker.
// The client is rates-only (no createShipment): this can never book.
import { runQuoteCli } from "./exchangeQuote.mjs";

const code = await runQuoteCli(process.argv.slice(2), {
  makeDeps: async () => ({
    db: (await import("./adminDb.mjs")).adminDb(),
    client: (await import("./courier-client.mjs")).createCourierClient(),
  }),
});
process.exit(code);
