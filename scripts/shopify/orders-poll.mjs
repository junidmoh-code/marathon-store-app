#!/usr/bin/env node
// ── Website orders → the app (Mac mini) ─────────────────────────────────────
// One tick of onlineOrders/poll.mjs against the live database and Shopify.
// reconcile-runner.mjs runs this FIRST in every reconciler tick, before
// reconcile.mjs, so the holds it writes are in place before any stock is
// pushed. docs/ONLINE-ORDERS.md is the contract.
//
//   node scripts/shopify/orders-poll.mjs            dry run: reads everything,
//                                                   prints what it WOULD write
//   node scripts/shopify/orders-poll.mjs --commit   the real tick
//   … --no-shopify                                  skip Shopify (keep/backfill only)
//
// Credentials: Shopify through scripts/shopify/env.mjs (.env); Firebase Admin
// through Application Default Credentials; the attention email through the
// shop mailbox's SMTP (CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD in the
// same .env — the card-recon poller's sender). None is ever printed.
import { createRequire } from "node:module";
import { graphql } from "./client.mjs";
import "./env.mjs";
import { serverNowMs } from "./publishNode.mjs";
import { runOrdersPoll } from "./onlineOrders/poll.mjs";
import { recordingDb } from "./onlineOrders/recordingDb.mjs";

const COMMIT = process.argv.includes("--commit");
const NO_SHOPIFY = process.argv.includes("--no-shopify");
// Junid's inbox — the address every alarm already goes to (card-recon,
// write-off digest). Fixed here, never read from .env.
const NOTIFY_TO = "junidmoh@gmail.com";

const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
const { resolveAssignment, saDateStringFromMs } = fnRequire("./displayChecks/lib.cjs");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}
const liveDb = admin.database();
const db = COMMIT ? liveDb : recordingDb(liveDb, (line) => console.log(`  [dry] ${line}`));

function mailSender() {
  const user = process.env.CARD_RECON_IMAP_USER;
  const pass = process.env.CARD_RECON_IMAP_PASSWORD;
  if (!user || !pass) return null;
  let nodemailer;
  try {
    nodemailer = createRequire(new URL("../cardrecon/package.json", import.meta.url))("nodemailer");
  } catch {
    return null;
  }
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  return (mail) => transport.sendMail({ from: user, to: NOTIFY_TO, subject: mail.subject, text: mail.text });
}

const started = Date.now();
try {
  const summary = await runOrdersPoll({
    db,
    graphql: NO_SHOPIFY ? null : graphql,
    nowMs: () => serverNowMs(liveDb),
    send: COMMIT ? mailSender() : null,
    increment: (n) => admin.database.ServerValue.increment(n),
    resolveAssignment,
    saDate: (ms) => saDateStringFromMs(ms),
    log: (line) => console.log(line),
  });
  const s = summary;
  const busy = s.ingested || s.cancelled || s.flagged || s.entries || s.holds || s.fulfilled || s.fulfilFailed || s.mailed || s.errors.length;
  console.log(
    busy
      ? `orders: ${s.ingested} new · ${s.cancelled} cancelled · ${s.flagged} flagged · ${s.kept} open · ${s.entries} feed entr${s.entries === 1 ? "y" : "ies"} · ${s.holds} hold change(s) · ${s.fulfilled} fulfilled · ${s.fulfilFailed} fulfil failed · ${s.mailed} emailed${s.errors.length ? ` · ${s.errors.length} ERROR(S)` : ""} (${Date.now() - started} ms)${COMMIT ? "" : " — DRY RUN, nothing written"}`
      : `orders: quiet (${s.kept} open)${COMMIT ? "" : " — DRY RUN"}`,
  );
  process.exit(s.errors.length ? 1 : 0);
} catch (e) {
  console.error(`✗ orders poll failed: ${String(e?.message || e)}`);
  process.exit(1);
}
