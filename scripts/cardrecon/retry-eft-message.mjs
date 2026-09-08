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
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { parseEnvText } from "./intakeCore.mjs";
import { EFT_POOL_PATH, eftRetryPlan, envelopeCandidateKeys, mergeEvictions } from "./eftCore.mjs";

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
  const evictFile = join(repo, "logs", "card-recon-evict.json");
  let existing = {};
  try { existing = JSON.parse(readFileSync(evictFile, "utf8")) || {}; } catch { /* first eviction */ }
  writeFileSync(evictFile, JSON.stringify(mergeEvictions(existing, doomed, Date.now(), EVICT_WINDOW_MS)));
  const file = join(repo, "logs", "card-recon-processed.json");
  if (!existsSync(file)) return 0;
  let entries;
  try { entries = JSON.parse(readFileSync(file, "utf8")) || {}; } catch { return 0; }
  let evicted = 0;
  for (const k of doomed) if (k in entries) { delete entries[k]; evicted++; }
  if (evicted) writeFileSync(file, JSON.stringify(entries));
  return evicted;
}

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
let uidValidity = null;
const seenUids = [];
try {
  const lock = await client.getMailboxLock(String(env.CARD_RECON_IMAP_MAILBOX || "INBOX").trim());
  try {
    uidValidity = client.mailbox?.uidValidity ?? null;
    const uids = await client.search({ header: { "message-id": plan.messageId } }, { uid: true });
    if (!uids?.length) throw new Error("no message with that Message-ID is in the mailbox any more — nothing was changed");
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

// THE CACHE LAST, after the claim is gone. Evicting first opened a window: a
// tick reading the ledger between the eviction and the clear still found
// "done", re-cached the key with a NEWER timestamp, and that entry then beat
// the eviction for good. With the claim cleared first, a tick that reads now
// finds nothing done and processes the mail; a tick that read earlier holds
// an older entry the eviction removes at its next save. (Delta review.)
const evicted = evictFromProcessedCache({ repo: REPO, messageId: plan.messageId, uidValidity, uids: seenUids });
console.log(`local processed cache: ${evicted} entr${evicted === 1 ? "y" : "ies"} evicted now, and recorded on the eviction list the poller honours at its next save`);
console.log(`\nDone. The next tick treats it as new mail. The first attempt's refusal stays on the EFT payments tab under ${plan.archiveKey}.`);
await admin.app().delete();
