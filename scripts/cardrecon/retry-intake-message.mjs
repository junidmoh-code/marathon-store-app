// ─── RUN ONE EMAILED SLIP AGAIN, AFTER THE REASON IT FAILED IS FIXED ─────────
// A refused slip is not retried by itself, and deliberately so: the claim is
// marked done and the message is marked read, because "try it again in five
// minutes" is the wrong answer to a slip the capture path has judged. When the
// reason was a BUG rather than a judgement — the callable answering INTERNAL,
// say — the fix ships and the slip still has to be re-run by hand.
//
// This is that hand. It undoes exactly two things for ONE message: the claim
// that says it is finished, and the \Seen flag that keeps it out of the search.
// The next tick then treats it as new mail and puts it through the unchanged
// capture path, where the duplicate-batch refusal is still waiting if the slip
// did in fact land the first time.
//
// IT WILL NOT RE-RUN A SLIP THAT WAS RECORDED. A capture that succeeded is
// evidence; re-running it can only produce a duplicate refusal or, if something
// has changed underneath, a second record. Refused and unrelated rows only.
//
// Runs ON THE MAC MINI — it needs both the mailbox credentials and the Admin
// SDK. Names the message it will act on and does nothing without --execute.
//
//   node scripts/cardrecon/retry-intake-message.mjs <intakeId|messageKey>
//   node scripts/cardrecon/retry-intake-message.mjs <intakeId|messageKey> --execute
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { parseEnvText } from "./intakeCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const INTAKE_PATH = "card_batch_intake";
const SEEN_PATH = "card_batch_intake_seen";

const [target] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!target) {
  console.error("usage: retry-intake-message.mjs <intakeId|messageKey> [--execute]");
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

// The row, by push id or by message key — whichever the person had to hand.
let id = target, record = (await db.ref(`${INTAKE_PATH}/${target}`).get()).val();
if (!record) {
  // A KEYED LOOKUP, not a scan: the feed grows by a row per message for ever.
  const found = await db.ref(INTAKE_PATH).orderByChild("messageKey").equalTo(target).limitToFirst(1).get();
  found.forEach((c) => { id = c.key; record = c.val(); });
}
if (!record) {
  console.error(`No intake record for "${target}" — pass the row's push id or its messageKey.`);
  await admin.app().delete();
  process.exit(1);
}

const rows = Object.values(record.attachments || {});
console.log(`intake ${id}`);
console.log(`  subject : ${record.subject}`);
console.log(`  from    : ${record.from}`);
console.log(`  state   : ${record.state}  (recorded ${record.recorded}, refused ${record.refused}, unrelated ${record.unrelated})`);
for (const r of rows) console.log(`  · ${r.outcome}: ${r.reason || r.batchKey}`);

if (record.recorded > 0) {
  console.error("\nThis message has a RECORDED slip on it. Re-running could only produce a duplicate refusal or a second record; refusing.");
  await admin.app().delete();
  process.exit(1);
}

console.log(`\n${EXECUTE ? "CLEARING" : "WOULD clear"} the claim at /${SEEN_PATH}/${record.messageKey}`);
console.log(`${EXECUTE ? "MARKING" : "WOULD mark"} Message-ID ${record.messageId} unread in ${user}`);
if (!EXECUTE) {
  console.log("\nDRY RUN — nothing changed. Re-run with --execute; the next tick (≤5 min) picks it up.");
  await admin.app().delete();
  process.exit(0);
}

// THE MAILBOX FIRST. If the flag comes off and the claim then fails to clear,
// the next tick sees the message, finds the claim done, and marks it read
// again — no harm. The other order leaves a cleared claim on a message the
// search will never return, which is a slip nobody is coming back for.
const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
await client.connect();
let unflagged = 0;
try {
  const lock = await client.getMailboxLock(String(env.CARD_RECON_IMAP_MAILBOX || "INBOX").trim());
  try {
    const uids = await client.search({ header: { "message-id": record.messageId } }, { uid: true });
    if (!uids?.length) throw new Error(`no message with that Message-ID is in the mailbox any more`);
    for (const uid of uids) {
      await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      unflagged++;
    }
  } finally { lock.release(); }
} finally {
  try { await client.logout(); } catch { /* going anyway */ }
}
console.log(`marked ${unflagged} message(s) unread`);

await db.ref(`${SEEN_PATH}/${record.messageKey}`).remove();
console.log("claim cleared");
// The refused ROW is left exactly where it is. It is the record of what
// happened, and the retry will write its own; a feed that quietly deletes its
// own history is one nobody can audit.
console.log(`\nDone. The next tick will treat it as new mail. The refused row (${id}) stays as the record of the first attempt.`);
await admin.app().delete();
