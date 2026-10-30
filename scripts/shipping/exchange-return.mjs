#!/usr/bin/env node
// Junid's "good condition" on an online exchange's return: the returned item(s) back into stock at Marathon PE (one
// "return" movement per unit, reason "exchange return #<n>") and the arrival confirmed, so Till 2 can pack the
// replacement (scripts/shipping/exchangeReturn.mjs). Called by Jimmy (marathon-dm-agent src/jimmy/returnCondition.js)
// from this checkout; prints ONE JSON line.
//
//   node scripts/shipping/exchange-return.mjs --key exchange-1793-1793333411004 --order 1793 [--dry]
//        [--returning '[{"pid":"p1…","size":"11","title":"…"}]']   (only when the record has no incoming.returning)
//
// Exit 0 with { ok: true, done | already | dryRun, items, replacement } or { ok: false, notReady | busy, reason };
// exit 1 with { error } (a read or write failed; running it again is safe: every movement id is fixed).
import { confirmExchangeReturn } from "./exchangeReturn.mjs";
import { openDb } from "../lib/swap-line.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? null : null;
};
let app = null;
try {
  const key = arg("key");
  if (!key) throw new Error("--key exchange-<n>-<paidAtMs> is required");
  let returning = null;
  if (arg("returning")) returning = JSON.parse(arg("returning"));
  const opened = openDb();
  app = opened.admin;
  const out = await confirmExchangeReturn(key, { db: opened.db, dry: process.argv.includes("--dry"), orderNumber: arg("order"), returning });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  await app.app().delete().catch(() => {});
  process.exit(0);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: String(err?.message || err).slice(0, 400) })}\n`);
  await app?.app?.().delete().catch(() => {});
  process.exit(1);
}
