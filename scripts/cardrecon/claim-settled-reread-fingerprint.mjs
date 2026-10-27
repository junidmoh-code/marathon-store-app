// ─── MARK A HAND-SETTLED MISSING-READER REFUSAL'S TRANSACTION ID AS SPENT ────
// Junid, 27 Oct 2026. The twin of claim-settled-bank-fingerprint.mjs for a
// refusal written BEFORE its bank had a reader ("No payment-notification
// reader exists for nedbank.co.za yet"): such a record stored no bank id, so
// the id is fetched again — the record's own message, by Message-ID, from the
// mailbox, READ-ONLY — and read by the reader that exists now. The id is then
// claimed as SPENT by Junid's manual record, so a resent copy is held at
// ingest and refused at the settle, whatever the reader decides about it.
//
//   node scripts/cardrecon/claim-settled-reread-fingerprint.mjs <usedPoolKey> <refusedPoolKey>... [--execute]
//
// Several refused keys = several copies of ONE payment (the Nedbank R350 came
// four times): every copy must re-read to the same bank id, or nothing is
// written. Without --execute it only reads and says what it would write. It
// writes ONE node, /eft_pool_fingerprints/{fp}, create-or-add-spender, never
// replacing a spender already there. NO POOL RECORD IS EVER WRITTEN, and the
// mailbox is opened read-only (no \Seen, no moves). The judgement is
// rereadRefusal + settledFingerprintPlan (eftCore.mjs), pure and tested.
//
// Runs ON THE MAC MINI — it needs the mailbox credentials and the Admin SDK.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { parseEnvText } from "./intakeCore.mjs";
import {
  EFT_POOL_PATH, EFT_FINGERPRINT_PATH, authenticationVerdict,
  rereadRefusal, settledFingerprintPlan, settledClaimStep,
} from "./eftCore.mjs";
import { selectReader } from "./eftBanks.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { pdfToLines } = require("./cardRecon/pdfText.js");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
// Gmail's every-message view: the notification may have been archived or
// moved since the tick that refused it.
const ALL_MAIL = "[Gmail]/All Mail";

const [spenderKey, ...refusedKeys] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!spenderKey || !refusedKeys.length) {
  console.error("usage: claim-settled-reread-fingerprint.mjs <usedPoolKey> <refusedPoolKey>... [--execute]");
  process.exit(2);
}

const env = parseEnvText(readFileSync(join(REPO, ".env"), "utf8"));
const user = String(env.CARD_RECON_IMAP_USER || "").trim();
const pass = String(env.CARD_RECON_IMAP_PASSWORD || "").replace(/\s+/g, "");
if (!user || !pass) {
  console.error(`CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD are not both set in ${join(REPO, ".env")}.`);
  process.exit(1);
}

/** The refused message's documents as the poller sees them: PDFs first, then the body. */
async function documentsOf(client, messageId) {
  const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
  if (uids.length !== 1) return { ok: false, why: `${uids.length} messages in the mailbox carry Message-ID ${messageId}.` };
  const msg = await client.fetchOne(String(uids[0]), { source: true }, { uid: true });
  const parsed = await simpleParser(msg.source);
  if (parsed.messageId !== messageId) return { ok: false, why: `The mailbox search returned ${parsed.messageId}, not ${messageId}.` };
  const fromAddress = parsed.from?.value?.[0]?.address || "";
  const verdict = authenticationVerdict({ headerLines: parsed.headerLines, fromAddress });
  if (!verdict.pass) return { ok: false, why: `The message does not pass DKIM today (${verdict.detail}).` };
  const docs = [];
  for (const att of parsed.attachments ?? []) {
    if (!/pdf/i.test(att.contentType || "") && !/\.pdf$/i.test(att.filename || "")) continue;
    const out = await pdfToLines(att.content, { grouping: "bucket" });
    if (out.ok) docs.push(out.lines);
  }
  // The poller's own derivation of the two (email-poller.mjs, `message`), so
  // rereadRefusal compares like with like.
  const header = {
    from: parsed.from?.text ?? null,
    receivedAt: parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.getTime() : null,
  };
  return { ok: true, fromDomain: verdict.fromDomain, docs, header };
}

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
const db = admin.database();
const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
try {
  const spender = (await db.ref(`${EFT_POOL_PATH}/${spenderKey}`).once("value")).val();
  await client.connect();
  const plans = [];
  const lock = await client.getMailboxLock(ALL_MAIL, { readOnly: true });
  try {
    for (const refusedKey of refusedKeys) {
      const record = (await db.ref(`${EFT_POOL_PATH}/${refusedKey}`).once("value")).val();
      if (!record?.messageId) { plans.push({ refusedKey, ok: false, why: `No /eft_pool record with a Message-ID at ${refusedKey}.` }); continue; }
      const fetched = await documentsOf(client, record.messageId);
      if (!fetched.ok) { plans.push({ refusedKey, ...fetched }); continue; }
      // Exactly one of the message's PDFs must be a payment the reader claims.
      const claimed = fetched.docs
        .map((lines) => ({ lines, r: selectReader({ fromDomain: fetched.fromDomain, lines }) }))
        .filter((x) => x.r);
      if (claimed.length !== 1) { plans.push({ refusedKey, ok: false, why: `${claimed.length} of the message's PDFs are read as a payment — exactly one is needed.` }); continue; }
      const [{ lines, r }] = claimed;
      const view = rereadRefusal({ record, readerId: r.id, parse: r.parse(lines), docText: lines.join("\n"), fetched: fetched.header });
      if (!view.ok) { plans.push({ refusedKey, ...view }); continue; }
      plans.push({ refusedKey, ...settledFingerprintPlan({ refusedKey, refused: view.refused, spenderKey, spender }), amountCents: view.refused.amountCents });
    }
  } finally {
    lock.release();
  }
  for (const p of plans) console.log(p.ok ? `· ${p.refusedKey} → fingerprint ${p.fingerprint} (${p.amountCents}c)` : `✗ ${p.refusedKey}: ${p.why}`);
  const fps = new Set(plans.filter((p) => p.ok).map((p) => p.fingerprint));
  if (plans.some((p) => !p.ok) || fps.size !== 1) {
    console.error(fps.size > 1 ? "✗ the copies re-read to different bank ids — not one payment; nothing written." : "✗ nothing written.");
    process.exitCode = 1;
  } else {
    const [fingerprint] = fps;
    const path = `${EFT_FINGERPRINT_PATH}/${fingerprint}`;
    const before = (await db.ref(path).once("value")).val();
    console.log(`· ${refusedKeys.length} cop${refusedKeys.length === 1 ? "y" : "ies"} of one payment, settled by ${spenderKey} (used)`);
    console.log(`· ${path} now: ${JSON.stringify(before)}`);
    if (!EXECUTE) console.log("· dry run — re-run with --execute to mark the bank id spent by the used record");
    else {
      // The server's clock, not this machine's (serverNowMs, as in the poller).
      const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
      const res = await db.ref(path).transaction(settledClaimStep({ spenderKey, refusedKey: refusedKeys[0], at: Date.now() + offset }));
      console.log(`${res.committed ? "✓ marked spent" : "· unchanged (a spender is already recorded)"}: ${JSON.stringify(res.snapshot.val())}`);
    }
  }
} finally {
  await client.logout().catch(() => {});
  await admin.app().delete();
}
