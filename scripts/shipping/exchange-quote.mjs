#!/usr/bin/env node
// A LIVE Courier Guy quote for an online exchange, both legs, RATES ONLY (scripts/shipping/exchangeQuote.mjs). Called by
// Jamie's exchange desk (marathon-dm-agent) from this checkout; prints ONE JSON line. Never books, never writes.
//
//   node scripts/shipping/exchange-quote.mjs --order-key 18985060335765 \
//     --returning '[{"pid":"p1785332131877","size":"6"}]' --replacement '[{"pid":"p1785332131877","size":"7"}]' \
//     --mode locker|door [--phone +27…] [--email them@example.com]
//
// Exit 0 with { ok: true, returnLeg: { rand, service, mode, locker }, outboundLeg: { rand, service } | null, totalCents,
// blockers } or { ok: false, reason, transient? }; exit 1 with { ok: false, error } on a crash.
import { quoteExchange } from "./exchangeQuote.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? null : null;
};
try {
  const db = (await import("./adminDb.mjs")).adminDb();
  const client = (await import("./courier-client.mjs")).createCourierClient();
  const out = await quoteExchange(
    { orderKey: arg("order-key"), returning: arg("returning") ?? "[]", replacement: arg("replacement") ?? "[]", mode: arg("mode") || "locker", phone: arg("phone") },
    { db, client, email: arg("email") },
  );
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message || err).slice(0, 400) })}\n`);
  process.exit(1);
}
