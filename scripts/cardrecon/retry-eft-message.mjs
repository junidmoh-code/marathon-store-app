// ─── RUN ONE REFUSED EFT NOTIFICATION AGAIN, AFTER THE REASON IT FAILED IS FIXED
// A refused notification is not retried by itself, deliberately: the claim is
// done and the message is read, because "try again in five minutes" is the
// wrong answer to a message the reader has judged. When the reason was a
// MISSING READER — the Absa "Notice of Payment" of 2026-09-01 refused with
// "No payment-notification reader exists for absa.co.za yet", and the reader
// shipped the same day (#540) — the fix lands and the message still has to be
// re-run by hand. This is that hand, the EFT twin of retry-intake-message.mjs.
//
// It undoes exactly two things for ONE message and moves one record:
//   1. the refused /eft_pool record is MOVED to `<key>-retried-<ms>` (stamped
//      retriedAt / retriedFrom) — never deleted; a feed that quietly deletes
//      its own failures cannot be audited, and the original key must be free
//      for the re-run's create-only write, which would otherwise find the old
//      refusal and refuse to overwrite it;
//   2. the claim at /card_batch_intake_seen/<key> is cleared;
//   3. the message's \Seen flag is removed — the same courtesy the slip retry
//      pays: the poller's own memory is the claim ledger (it searches by date
//      and dedupes on the claim row, never on \Seen), so the flag is for the
//      person reading the mailbox, and the cleared claim is what makes the
//      next tick put the message through the UNCHANGED reader path with
//      whatever reader exists now.
//
// IT WILL NOT RE-RUN A RECORDED PAYMENT. A payment that landed is evidence;
// re-running it can only produce a duplicate refusal or a second record. The
// whole judgement is eftRetryPlan (eftCore.mjs), pure and tested.
//
// Runs ON THE MAC MINI — it needs both the mailbox credentials and the Admin
// SDK. Names what it will do and does nothing without --execute.
//
//   node scripts/cardrecon/retry-eft-message.mjs <poolKey>
//   node scripts/cardrecon/retry-eft-message.mjs <poolKey> --execute
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { parseEnvText } from "./intakeCore.mjs";
import { EFT_POOL_PATH, eftRetryPlan } from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

const [target] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!target) {
  console.error("usage: retry-eft-message.mjs <poolKey> [--execute]");
  process.exit(2);
}

const env = parseEnvText(readFileSync(join(REPO, ".env"), "utf8"));
const user = String(env.CARD_RECON_IMAP_USER || "").trim();
const pass = String(env.CARD_RECON_IMAP_PASSWORD || "").replace(/\s+/g, "");
if (!user || !pass) {
  console.error(`CARD_RECON_IMAP_USER / CARD_RECON_IMAP_PASSWORD are not both set in ${join(REPO, ".env")}.`);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
const db = admin.database();

const record = (await db.ref(`${EFT_POOL_PATH}/${target}`).get()).val();
const seenRow = (await db.ref(`card_batch_intake_seen/${target}`).get()).val();
const plan = eftRetryPlan({ poolKey: target, record, seenRow, at: Date.now() });
if (!plan.ok) {
  console.error(plan.why);
  await admin.app().delete();
  process.exit(1);
}

console.log(`Refused record ${target}: ${record.outcome} — ${record.reason}`);
console.log(`  from ${record.from}, Message-ID ${plan.messageId}`);
console.log(`\n${EXECUTE ? "MOVING" : "WOULD move"} the refused record to /${EFT_POOL_PATH}/${plan.archiveKey} (stamped retriedAt)`);
console.log(`${EXECUTE ? "CLEARING" : "WOULD clear"} the claim at /${plan.seenPath}`);
console.log(`${EXECUTE ? "MARKING" : "WOULD mark"} Message-ID ${plan.messageId} unread in ${user}`);
if (!EXECUTE) {
  console.log("\nDRY RUN — nothing changed. Re-run with --execute; the next tick (≤2 min) picks it up with the readers that exist now.");
  await admin.app().delete();
  process.exit(0);
}

// THE MAILBOX FIRST, and nothing in the database until it succeeds: a mailbox
// failure (the message gone, a bad password) then leaves the pool record and
// the claim exactly as they were — no archived copy with an orphaned claim
// row that would keep the poller skipping a message nobody can re-run.
// (Independent architect review, this PR.)
const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
await client.connect();
let unflagged = 0;
try {
  const lock = await client.getMailboxLock(String(env.CARD_RECON_IMAP_MAILBOX || "INBOX").trim());
  try {
    const uids = await client.search({ header: { "message-id": plan.messageId } }, { uid: true });
    if (!uids?.length) throw new Error("no message with that Message-ID is in the mailbox any more — nothing was changed");
    for (const uid of uids) {
      await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      unflagged++;
    }
  } finally { lock.release(); }
} finally {
  try { await client.logout(); } catch { /* going anyway */ }
}
console.log(`marked ${unflagged} message(s) unread`);

// THEN THE RECORD: archive copy created, then the original removed, then the
// claim cleared — in that order, so a crash at any point leaves something
// visible and nothing lost: both copies (harmless), or the archive with the
// claim still set (re-run the script; eftRetryPlan refuses the missing
// original, and the claim row is cleared by hand from the line it prints).
await db.ref(`${EFT_POOL_PATH}/${plan.archiveKey}`).set(plan.archived);
await db.ref(`${EFT_POOL_PATH}/${target}`).remove();
console.log("refused record archived under its retried key; the original key is free");

await db.ref(plan.seenPath).remove();
console.log("claim cleared");
console.log(`\nDone. The next tick treats it as new mail. The first attempt's refusal stays on the EFT payments tab under ${plan.archiveKey}.`);
await admin.app().delete();
