#!/usr/bin/env node
// ── Write-off digest mailer (Mac mini) — 2026-11-01 ─────────────────────────
// launchd com.marathon.writeoffdigestmail runs this every 10 minutes. It reads
// /refill_engine/refusalWriteoffDigestOutbox (small: one entry per daily digest
// until it is sent), emails each entry to Junid over Gmail SMTP as the shop
// mailbox — the same route as the EFT verdicts and the orders-poller watchdog,
// the emails that DO reach him — and records Gmail's answer (message id) on the
// archived digest and on the status the Health card reads. Why this exists:
// functions/lib/writeoff-digest.cjs, "THE EMAIL THAT ARRIVES".
//
//   node scripts/refill/writeoff-digest-mailer.mjs            the real run
//   node scripts/refill/writeoff-digest-mailer.mjs --dry-run  prints what it
//                                                             would send; sends
//                                                             and writes nothing
//
// Credentials: CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD in the
// git-ignored .env (only ever sends AS marathon6631@gmail.com). firebase-admin
// with the mini's gcloud ADC. WRITEOFF_DIGEST_MAIL=0 switches it off.
import { createRequire } from "node:module";
import "../shopify/env.mjs";
import { adminRequire } from "../adminRequire.mjs";
import { DIGEST_MAIL_TO, OUTBOX, STATUS, dueEntries, mailFor, patchAfter, senderOk } from "./writeoffDigestMailCore.mjs";

if (process.env.WRITEOFF_DIGEST_MAIL === "0") process.exit(0);
const DRY = process.argv.includes("--dry-run");
const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });

const admin = adminRequire(import.meta.url)("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
let code = 0;
try {
  const outbox = (await db.ref(OUTBOX).once("value")).val() || {};
  const due = dueEntries(outbox, Date.now());
  if (!due.length) { if (DRY) console.log(`${stamp()}  nothing to send`); }
  else {
    const user = process.env.CARD_RECON_IMAP_USER;
    const pass = process.env.CARD_RECON_IMAP_PASSWORD;
    if (!user || !pass) throw new Error("CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD not set (.env)");
    if (!senderOk(user)) throw new Error("not sending as a different mailbox than the shop's (marathon6631@gmail.com)");
    const nodemailer = createRequire(new URL("../cardrecon/package.json", import.meta.url))("nodemailer");
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    for (const [key, entry] of due) {
      const mail = mailFor(key, entry, user);
      if (DRY) { console.log(`WOULD MAIL ${DIGEST_MAIL_TO}\nSubject: ${mail.subject}\n\n${mail.text}`); continue; }
      const statusKey = (await db.ref(`${STATUS}/archiveKey`).once("value")).val();
      // Marked BEFORE the send: a tick that dies between Gmail and the record
      // below is not re-sent for 30 minutes (writeoffDigestMailCore SENDING_STALE_MS).
      await db.ref(`${OUTBOX}/${key}/sendingAtMs`).set(Date.now());
      let info = null, error = null;
      try { info = await transport.sendMail(mail); } catch (e) { error = e; code = 1; }
      await db.ref().update(patchAfter({ key, entry, ok: !error, info, error, nowMs: Date.now(), statusArchiveKey: statusKey }));
      console.log(`${stamp()}  ${key}: ${error ? `NOT sent (${String(error?.message || error).slice(0, 200)})` : `sent to ${DIGEST_MAIL_TO} — ${info?.messageId || "no id"} ${String(info?.response || "").slice(0, 80)}`}`);
    }
  }
} catch (e) {
  console.error(`${stamp()}  writeoff-digest-mailer: ${e?.message || e}`);
  code = 1;
} finally {
  await admin.app().delete().catch(() => {});
}
process.exit(code);
