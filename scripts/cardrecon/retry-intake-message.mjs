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
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { parseEnvText } from "./intakeCore.mjs";
import { envelopeCandidateKeys, mergeEvictions, applyEvictions } from "./eftCore.mjs";

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

// ONE RETRY AT A TIME. Both cache files are read-modify-written without a
// lock; two retries in the same second would each undo the other's write.
// A create-exclusive lock file refuses the second run instead.
const RETRY_LOCK = join(REPO, "logs", "card-recon-retry.lock");
let lockFd = null;
try { lockFd = openSync(RETRY_LOCK, "wx"); }
catch { console.error(`Another retry is running (${RETRY_LOCK} exists). Wait for it, or remove the file if it is stale.`); process.exit(1); }
process.on("exit", () => { try { closeSync(lockFd); unlinkSync(RETRY_LOCK); } catch { /* already gone */ } });

// ─── THE LOCAL PROCESSED CACHE MUST FORGET THE MESSAGE TOO ───────────────────
// The poller keeps logs/card-recon-processed.json: keys the claim ledger has
// confirmed "done", plus a per-IMAP-uid marker, so a tick never re-asks RTDB
// about the same fortnight of mail. Clearing the claim row alone is therefore
// NOT enough — the next tick sees the uid marker, skips the message, and says
// "nothing unprocessed" for ever. (Found the hard way on the Absa re-run of
// 2026-09-08: the retry ran clean and the poller ignored the mail until the
// cache file was deleted by hand.) Evict every key this message could sit
// under: its candidate ledger keys and its uid marker(s).
// TWO WRITES, AND THE SECOND IS THE ONE THAT HOLDS. Deleting the keys from the
// cache file is undone by any tick that was already in flight (it holds its
// own copy for minutes and saves it back). The eviction LIST is what the
// poller honours at load and at every save, so the keys are recorded there
// too — a tick that was mid-flight forgets them the moment it saves.
const EVICT_WINDOW_MS = 30 * 86400000;
function evictFromProcessedCache({ repo, messageId, uidValidity, uids }) {
  const doomed = [
    ...(envelopeCandidateKeys({ messageId }) ?? []),
    ...uids.map((uid) => `u:${String(uidValidity ?? "")}:${uid}`),
  ];
  const now = Date.now();
  const evictFile = join(repo, "logs", "card-recon-evict.json");
  let existing = {};
  try { existing = JSON.parse(readFileSync(evictFile, "utf8")) || {}; } catch { /* first eviction */ }
  const evictions = mergeEvictions(existing, doomed, now, EVICT_WINDOW_MS);
  writeFileSync(evictFile, JSON.stringify(evictions));
  const file = join(repo, "logs", "card-recon-processed.json");
  if (!existsSync(file)) return 0;
  let entries;
  try { entries = JSON.parse(readFileSync(file, "utf8")) || {}; } catch { return 0; }
  // The same timestamp rule as the poller's own: an entry the poller cached
  // at or after this eviction (it reprocessed the mail between the claim
  // clear and now) is newer and stays. (CodeRabbit.)
  const evicted = applyEvictions(entries, evictions, now, EVICT_WINDOW_MS);
  if (evicted) writeFileSync(file, JSON.stringify(entries));
  return evicted;
}

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
let uidValidity = null;
const seenUids = [];
try {
  const lock = await client.getMailboxLock(String(env.CARD_RECON_IMAP_MAILBOX || "INBOX").trim());
  try {
    uidValidity = client.mailbox?.uidValidity ?? null;
    const uids = await client.search({ header: { "message-id": record.messageId } }, { uid: true });
    if (!uids?.length) throw new Error(`no message with that Message-ID is in the mailbox any more`);
    for (const uid of uids) {
      await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      unflagged++;
      seenUids.push(uid);
    }
  } finally { lock.release(); }
} finally {
  try { await client.logout(); } catch { /* going anyway */ }
}
console.log(`marked ${unflagged} message(s) unread`);

await db.ref(`${SEEN_PATH}/${record.messageKey}`).remove();
console.log("claim cleared");

// THE CACHE LAST, after the claim is gone — see retry-eft-message.mjs for
// the window that evicting first would open. (Delta review.)
const evicted = evictFromProcessedCache({ repo: REPO, messageId: record.messageId, uidValidity, uids: seenUids });
console.log(`local processed cache: ${evicted} entr${evicted === 1 ? "y" : "ies"} evicted now, and recorded on the eviction list the poller honours at its next save`);

// The refused ROW STAYS — it is the record of what happened, and a feed that
// quietly deletes its own failures is one nobody can audit. But it is STAMPED,
// because an outstanding-refusal count that only ever grows stops meaning
// anything: "3 refused" would come to mean "3 things went wrong at some point"
// rather than "3 things need you now". The tab reads retriedAt and stops
// counting the row; whatever the re-run produces gets a row of its own to
// shout with if it fails again.
await db.ref(`${INTAKE_PATH}/${id}`).update({
  retriedAt: admin.database.ServerValue.TIMESTAMP,
  retriedBy: "retry-intake-message.mjs",
});
console.log("the refused row is marked as re-run — it stays in the feed, but stops counting as outstanding");
console.log(`\nDone. The next tick will treat it as new mail. Row ${id} remains as the record of the first attempt.`);
await admin.app().delete();
