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
//   … --pretend-go-live=<ISO>                       dry run only: route older orders
//
// Credentials: Shopify through scripts/shopify/env.mjs (.env); Firebase Admin
// through Application Default Credentials; the attention email through the
// shop mailbox's SMTP (CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD in the
// same .env — the card-recon poller's sender). None is ever printed.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { graphql } from "./client.mjs";
import "./env.mjs";
import { serverNowMs } from "./publishNode.mjs";
import { runOrdersPoll } from "./onlineOrders/poll.mjs";
import { recordingDb } from "./onlineOrders/recordingDb.mjs";

const COMMIT = process.argv.includes("--commit");
// Dry run only: --pretend-go-live=2026-10-20T00:00:00Z shows how orders from
// before the real go-live WOULD be pulled in and routed. Never with --commit —
// those orders were rung by hand and must never be held or packed again.
const pretendArg = process.argv.find((a) => a.startsWith("--pretend-go-live="));
const pretendGoLiveMs = pretendArg ? Date.parse(pretendArg.split("=")[1]) : null;
if (pretendArg && (COMMIT || !Number.isFinite(pretendGoLiveMs))) {
  console.error("✗ --pretend-go-live takes an ISO date and is for dry runs only");
  process.exit(2);
}
const NO_SHOPIFY = process.argv.includes("--no-shopify");
// Junid's inbox — the address every alarm already goes to (card-recon,
// write-off digest). Fixed here, never read from .env.
const NOTIFY_TO = "junidmoh@gmail.com";
// Junid's WhatsApp (as Jimmy's src/jimmy/junid.js). Messages to him go through
// JIMMY'S OUTBOX — the one WhatsApp session on this mini that is linked and
// delivering (the broadcast gateway on :8080 was found unlinked, QR waiting,
// 25 Oct 2026). Queued exactly as marathon-dm-agent/bin/jimmy-send.mjs does;
// the Jimmy service sends it on its next tick (about two minutes).
const JUNID_WHATSAPP = "27813995333";
const JIMMY_DB = join(homedir(), "marathon-dm-agent", "data", "agent.db");

const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
const { resolveAssignment, saDateStringFromMs, isTriggerStoreEnabled } = fnRequire("./displayChecks/lib.cjs");
const { loadNetwork } = fnRequire("./lib/network-load.cjs");
const { loadStoreSettings } = fnRequire("./displayChecks/settings.cjs");

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

// "Tell me on WhatsApp" (Junid, 25 Oct 09:52). null when Jimmy's outbox is not
// on this machine — the caller then emails instead.
function whatsappJunid() {
  if (!existsSync(JIMMY_DB)) return null;
  return async (text) => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(JIMMY_DB);
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      // Never write into a database that is not Jimmy's (a fresh empty file, a moved one).
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jimmy_outbox'").get()) throw new Error("Jimmy's outbox table is not there");
      db.prepare("INSERT INTO jimmy_outbox(to_person, kind, sub, text, media, ref, created_at) VALUES (?, 'junid', 'online_request', ?, NULL, 'orders-poll', ?)")
        .run(JUNID_WHATSAPP, String(text), Date.now());
    } finally { db.close(); }
  };
}

const started = Date.now();
try {
  const summary = await runOrdersPoll({
    db,
    pretendGoLiveMs,
    graphql: NO_SHOPIFY ? null : graphql,
    nowMs: () => serverNowMs(liveDb),
    send: COMMIT ? mailSender() : null,
    whatsappJunid: COMMIT ? whatsappJunid() : null,
    increment: (n) => admin.database.ServerValue.increment(n),
    resolveAssignment,
    // A shop with Display Checks off is never routed to (it could not see or
    // close the entry). A read that fails counts as ON — today's routing.
    displayFeedEnabled: async (shop) => {
      try { return isTriggerStoreEnabled(shop, await loadNetwork(liveDb), await loadStoreSettings(liveDb, shop)); }
      catch { return true; }
    },
    saDate: (ms) => saDateStringFromMs(ms),
    log: (line) => console.log(line),
  });
  const s = summary;
  if (s.missingIndex.size) console.log(`⚠ RULES NOT PASTED: /online_orders needs .indexOn [${[...s.missingIndex].join(", ")}] (docs/ONLINE-ORDERS.md)`);
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
