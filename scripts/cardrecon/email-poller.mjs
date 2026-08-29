// ─── THE CARD RECON EMAIL POLLER (Mac mini) ──────────────────────────────────
// The FNB terminals and the managers email their Batch Report PDFs to the
// shop's mailbox. This reads that mailbox on a schedule and feeds every PDF
// through the SAME capture path a manager's phone uses — the cardBatchCapture
// callable — so nobody has to do anything at all.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
// It is not a second reader. It does not parse a slip, check arithmetic, or
// decide what a figure is: it puts a file into the callable and writes down
// what came back. Every refusal the capture path already makes applies here
// unchanged and unweakened — unmapped TID, TID mismatch, duplicate batch, the
// slip's own arithmetic, the line count against the printed Transactions
// figure, the 7-day window bound, TSN contiguity. A mirror of any of that here
// would be a second implementation to keep in step, and this repo has learned
// what that costs.
//
// The ONE thing the callable cannot do the same way is decide WHICH TILL, since
// an email has no picked till. That decision lives server-side too
// (functions/lib/card-recon-email.cjs): the slip's TID must resolve in the
// registry and its MID must not contradict the registered one. An unmapped
// terminal is refused, and the refusal is written where it can be seen.
//
// ── NOTHING IS SILENTLY DROPPED ──────────────────────────────────────────────
// Every message carrying a PDF leaves a record at /card_batch_intake with an
// outcome per attachment, which is what the Card recon tab shows. A terminal
// that quietly stops reconciling is the failure the whole feature exists to
// prevent, so "the poller ran and said nothing" is not an available outcome.
//
// ── THE SAME SLIP IS NEVER SUBMITTED TWICE ───────────────────────────────────
// Two guards, deliberately, because either alone has a hole:
//   1. A CLAIM at /card_batch_intake_seen/{messageKey}, taken in a transaction
//      before any work. A claim a killed run left behind is retaken after
//      STALE_CLAIM_MS, so a SIGKILL costs a delay and never a lost slip.
//   2. The message is flagged \Seen in the mailbox, and only UNSEEN mail is
//      searched — so the mailbox itself remembers, and a lost database claim
//      does not mean re-reading a year of mail.
// The duplicate-batch refusal downstream is a third, and it is the owner's
// instruction that it must not be the only one. It is not.
//
// ── CREDENTIALS ──────────────────────────────────────────────────────────────
// A gitignored .env at the repo root, and nothing else. NOTHING here prints,
// logs or echoes a credential value — the most this program will say about one
// is its NAME and whether it was found. If .env is missing or short of a value,
// this stops with a sentence naming exactly what to add and where.
//
// See docs/CARD-RECON.md ("The email poller") for setup, and
// scripts/cardrecon/install-card-recon-poller.sh for the launchd agent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import {
  messageKey, planMessage, attachmentOutcome, intakeRecord, claimDecision, clip,
  parseEnvText,
} from "./intakeCore.mjs";

// firebase-admin is BORROWED from functions/, the way every other script on the
// mini borrows it (scripts/shopify, scripts/social). One copy, one version.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
// The web API key is PUBLIC — it is in src/firebase.js, shipped in every
// bundle. It identifies the project to Identity Toolkit and authorises nothing
// on its own, so it is a constant here rather than one more thing to put in
// .env and keep in step.
const FIREBASE_WEB_API_KEY = "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo";
const CALLABLE_URL = "https://europe-west1-marathon-club.cloudfunctions.net/cardBatchCapture";

const INTAKE_PATH = "card_batch_intake";
const SEEN_PATH = "card_batch_intake_seen";
// ── THE HEARTBEAT ────────────────────────────────────────────────────────────
// ONE node, overwritten every successful tick. Without it, "no emailed slips
// for two days" is ambiguous in the worst possible direction: a quiet mailbox
// and a poller that died look identical, and the feed's whole purpose is that a
// terminal not reconciling is VISIBLE. With it, the tab can say which one it
// is. (CodeRabbit, PR #510.)
const STATUS_PATH = "card_batch_poll_status";

// A tick's ceiling. A backlog is drained a tick at a time rather than in one
// run that holds the lock for an hour; the schedule is every few minutes.
const MAX_MESSAGES_PER_TICK = 20;
// Only recent mail is searched. A mailbox with years of history must not be
// re-read because a flag was lost.
const DEFAULT_LOOKBACK_DAYS = 14;
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
// ── THE TICK STOPS TAKING WORK BEFORE THE RUNNER STOPS IT ────────────────────
// The worst case is arithmetic nobody should rely on: 20 messages × 10
// attachments × two calls × a five-minute timeout is hours, and the launchd
// runner kills a run at 30 minutes. A kill is survivable — the claim goes stale
// and the next tick retakes that message — but it is survivable by accident,
// and a run killed mid-capture is a run whose log ends in the middle of a
// sentence.
//
// So the tick bounds ITSELF: once it has been going this long it finishes the
// message in hand and stops taking new ones, leaving the rest for the tick five
// minutes later. The runner's maxRunMs stays what it should be — a backstop for
// something genuinely stuck, not the thing that ends a normal busy run.
const TICK_BUDGET_MS = 12 * 60 * 1000;

// ─── .env ────────────────────────────────────────────────────────────────────
// THE PARSING ITSELF LIVES IN intakeCore.mjs, exported. The installer needs the
// same answer this does — "can the poller read this file?" — and answering it
// twice, once here and once in bash, drifted four times in a single review
// cycle. It runs this parser through node instead. See parseEnvText.
function loadEnv() {
  const path = join(REPO, ".env");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail(
      `No .env at ${path}.\n` +
      `The poller reads its mailbox credentials from there. Create it with:\n` +
      `  CARD_RECON_IMAP_USER=marathon6631@gmail.com\n` +
      `  CARD_RECON_IMAP_PASSWORD=<the 16-character Gmail app password>\n` +
      `and nothing else is required.`,
    );
  }
  return parseEnvText(text);
}

// ── ONE EXIT SHAPE ───────────────────────────────────────────────────────────
// A failure a person can act on is a SENTENCE, never a stack trace in a log —
// and it is thrown rather than process.exit()ed, because exiting from inside
// the run can truncate the very line that explains what went wrong (stdout to
// the runner is a pipe) and leaves the database connection open behind it.
class PollerStop extends Error {}
function fail(message) { throw new PollerStop(message); }

function config() {
  const fileEnv = loadEnv();
  const env = { ...fileEnv, ...process.env };
  // Which of the two places a value came from — the NAME only, never the value.
  const sourceOf = (key) => (process.env[key] !== undefined
    ? "this process's environment (a shell export, or the launchd plist)"
    : join(REPO, ".env"));
  const need = (key, what) => {
    const v = String(env[key] || "").trim();
    if (!v) {
      fail(`${key} is not set. Add it to ${join(REPO, ".env")} — ${what}. The value is never printed or logged.`);
    }
    return v;
  };
  // A NUMBER FROM A TEXT FILE IS NOT A NUMBER UNTIL IT IS CHECKED. Number("993 ")
  // is fine, Number("nine ninety three") is NaN — and NaN travels: a NaN port
  // fails inside the TLS socket with a message about the network, and a NaN
  // lookback makes an Invalid Date that IMAP rejects as a malformed SEARCH.
  // Both read as "the mailbox is broken" when the truth is a typo in .env.
  // (CodeRabbit, PR #510.)
  const number = (key, fallback, { min, max, what }) => {
    const raw = String(env[key] ?? "").trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      // NAME THE FILE THE VALUE IS ACTUALLY IN. process.env wins over .env
      // here, so a variable set in the shell or in the launchd plist's
      // EnvironmentVariables produced a message telling someone to remove a
      // line from .env that is not there — and removing it changes nothing,
      // which is a worse place to be than no message at all. The whole point
      // of this validator is the sentence.
      fail(`${key} reads "${raw}", which is not ${what}. It is set in ${sourceOf(key)}; remove it to use the default (${fallback}).`);
    }
    return value;
  };
  return {
    user: need("CARD_RECON_IMAP_USER", "the mailbox the terminals email (marathon6631@gmail.com)"),
    // GOOGLE SHOWS AN APP PASSWORD AS FOUR GROUPS OF FOUR ("abcd efgh ijkl
    // mnop") and people paste what they are shown. The spaces are presentation,
    // not part of the secret, and an IMAP LOGIN with them fails as
    // AUTHENTICATIONFAILED — which reads as "the password is wrong" and sends
    // someone off to mint another one that will fail the same way. Stripped
    // here, and only here: a Gmail app password is sixteen letters and nothing
    // else, so there is no legitimate value this can damage.
    password: need("CARD_RECON_IMAP_PASSWORD", "a Gmail APP PASSWORD, not the account password — myaccount.google.com → Security → App passwords").replace(/\s+/g, ""),
    host: String(env.CARD_RECON_IMAP_HOST || "imap.gmail.com").trim(),
    port: number("CARD_RECON_IMAP_PORT", 993, { min: 1, max: 65535, what: "a port number" }),
    mailbox: String(env.CARD_RECON_IMAP_MAILBOX || "INBOX").trim(),
    // The identity the callable sees. It holds `card_recon` and
    // `card_recon_intake` in permFlags and nothing else — granted once by
    // scripts/cardrecon/grant-poller-identity.mjs.
    uid: String(env.CARD_RECON_POLLER_UID || "card-recon-email-poller").trim(),
    lookbackDays: number("CARD_RECON_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS, { min: 1, max: 365, what: "a number of days between 1 and 365" }),
    dryRun: process.argv.includes("--dry-run"),
  };
}

// ─── TIME ────────────────────────────────────────────────────────────────────
// The RTDB server's clock, not this machine's. Everything stamped into the
// database uses it: the mini is a Mac in a shop, and a record whose time came
// from a drifted local clock is a record nobody can line up against a batch
// window. Same discipline as serverNowMs() in the browser.
let serverOffsetMs = 0;
async function syncServerClock(db) {
  try {
    const snap = await db.ref(".info/serverTimeOffset").once("value");
    const v = Number(snap.val());
    if (Number.isFinite(v)) serverOffsetMs = v;
  } catch (err) {
    console.warn(`⚠ could not read the server clock offset (${err.message}) — falling back to this machine's clock`);
  }
}
const serverNowMs = () => Date.now() + serverOffsetMs;

// ─── THE CALLABLE ────────────────────────────────────────────────────────────
// The poller signs in as its own identity: a custom token minted with the
// service-account key already on this machine, exchanged for an ID token. No
// password anywhere, and the permission it carries is data
// (/users/{uid}/permFlags) that can be revoked without a deploy.
async function mintIdToken(uid) {
  const customToken = await admin.auth().createCustomToken(uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!res.ok) {
    // The body can quote the request; the STATUS is all that is said.
    throw new Error(`could not exchange the poller's token (HTTP ${res.status}). Has scripts/cardrecon/grant-poller-identity.mjs been run?`);
  }
  const body = await res.json();
  if (!body?.idToken) throw new Error("the token exchange returned no ID token");
  return body.idToken;
}

// ── THE TOKEN IS REFRESHED, NOT REASONED ABOUT ───────────────────────────────
// An ID token lasts an hour and a tick is bounded at twelve minutes, so today
// one cannot expire mid-run. That is an argument, not a guarantee: it depends on
// TICK_BUDGET_MS, on the runner's maxRunMs, and on nobody raising either — and
// the failure it protects is every remaining capture in the tick returning 401
// while the log says the mailbox is fine. A closure that re-mints on age costs
// one line and removes the dependency. (CodeRabbit, PR #510.)
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;
function tokenProvider(uid) {
  let token = null, mintedAt = 0;
  return async () => {
    if (!token || Date.now() - mintedAt > TOKEN_MAX_AGE_MS) {
      token = await mintIdToken(uid);
      mintedAt = Date.now();
    }
    return token;
  };
}

async function callCapture(idToken, data) {
  const res = await fetch(CALLABLE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`the capture call was refused: ${message}`);
  }
  if (!body || typeof body.result !== "object" || body.result === null) {
    throw new Error("the capture call returned nothing this understands");
  }
  return body.result;
}

/**
 * One attachment, all the way through: extract, then submit. Returns the shape
 * attachmentOutcome() expects — never throws for a REFUSAL (that is an answer),
 * only for a transport failure the caller records as one.
 */
async function captureOne(getToken, { attachment, message }) {
  const extract = await callCapture(await getToken(), {
    action: "extract",
    channel: "email",
    pdf: { base64: attachment.content.toString("base64") },
    intake: {
      // NEVER null. The callable refuses an emailed capture that cannot name
      // its source message — rightly, because provenance is the whole point of
      // recording a figure nobody vouched for. Some mail genuinely arrives with
      // no Message-ID, and `key` is what identifies it in that case (a hash of
      // its stable parts — see messageKey). Sending null here would turn a
      // legitimate slip into a refusal about plumbing.
      messageId: message.messageId || `key:${message.key}`,
      from: message.from,
      subject: message.subject,
      filename: attachment.filename || null,
      receivedAt: message.receivedAt,
    },
  });
  if (!extract.ok) return { ok: false, reason: extract.reason };

  const submit = await callCapture(await getToken(), { action: "submit", draftId: extract.draftId });
  if (!submit.ok) return { ok: false, reason: submit.reason, tid: extract.review?.tid };
  return {
    recorded: true,
    tid: extract.review?.tid || null,
    storeId: extract.review?.terminal?.storeId || null,
    tillId: extract.review?.terminal?.tillId || null,
    batchKey: submit.batchKey,
    linesCaptured: submit.linesCaptured === true,
    warnings: submit.warnings || [],
  };
}

// ─── THE CLAIM ───────────────────────────────────────────────────────────────
// A transaction, so two runs cannot both take the same message. The DECISION is
// pure (claimDecision) and tested; this is only the write.
async function claimMessage(db, key) {
  const ref = db.ref(`${SEEN_PATH}/${key}`);
  const now = serverNowMs();
  let verdict = null;
  const txn = await ref.transaction((cur) => {
    verdict = claimDecision(cur, now);
    if (!verdict.take) return undefined;             // abort, leave it alone
    return { state: "claimed", at: now };
  });
  // `done` travels with the verdict because the CALLER decides whether to mark
  // the message read, and only a finished message may be marked.
  return { taken: txn.committed, done: !!verdict?.done, why: verdict?.why || "held" };
}

// ─── ONE TICK ────────────────────────────────────────────────────────────────
async function run() {
  const cfg = config();

  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
  const db = admin.database();
  await syncServerClock(db);

  // Minted once here so a broken identity stops the tick before it touches the
  // mailbox, then re-minted on age by the provider.
  const getToken = tokenProvider(cfg.uid);
  try {
    await getToken();
  } catch (err) {
    fail(err.message);
  }

  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    // imapflow's own logging would put message contents in the log; the lines
    // this program writes are the log.
    logger: false,
    socketTimeout: 120000,
  });

  try {
    await client.connect();
  } catch (err) {
    // A WRONG PASSWORD AND A DEAD NETWORK ARE DIFFERENT PROBLEMS. Gmail answers
    // an app password that has been revoked with AUTHENTICATIONFAILED, and the
    // fix for that is a person minting a new one — worth saying out loud rather
    // than letting it read as "the network was down again".
    const auth = /auth/i.test(err?.responseText || err?.message || "");
    fail(auth
      ? `the mailbox refused the credentials (${cfg.user}). Mint a fresh Gmail app password and put it in .env as CARD_RECON_IMAP_PASSWORD.`
      : `could not reach ${cfg.host}:${cfg.port} (${err.message}). The next tick retries.`);
  }

  let scanned = 0, processed = 0, recorded = 0, refused = 0, unrelated = 0;
  let scannedSoFar = 0;
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const since = new Date(serverNowMs() - cfg.lookbackDays * 86400000);
      const uids = await client.search({ seen: false, since }, { uid: true });
      const take = (uids || []).slice(-MAX_MESSAGES_PER_TICK);
      scanned = take.length;
      if (!take.length) {
        // A QUIET TICK STILL BEATS. The heartbeat below is written on the way
        // out either way, which is what tells the tab apart from a dead poller.
        console.log("· 0 unread messages to look at");
      } else {
        console.log(`· ${take.length} unread message${take.length === 1 ? "" : "s"} to look at`);

        const deadline = Date.now() + TICK_BUDGET_MS;
        for (const uid of take) {
          if (Date.now() > deadline) {
            console.log(`  · ${take.length - scannedSoFar} message(s) left for the next tick — this one has been going ${Math.round(TICK_BUDGET_MS / 60000)} minutes`);
            break;
          }
          scannedSoFar++;
          // ONE MESSAGE'S FAILURE IS NEVER THE TICK'S. A malformed MIME tree,
          // an attachment that will not decode, a capture call that times out —
          // each is recorded against that message and the next one still runs.
          try {
            const result = await handleMessage({ client, uid, db, getToken, cfg });
            if (result.processed) processed++;
            recorded += result.recorded;
            refused += result.refused;
            unrelated += result.unrelated;
          } catch (err) {
            console.error(`  ✗ message uid ${uid}: ${err.message}`);
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* the connection is going anyway */ }
  }

  // WRITTEN EVEN WHEN THE TICK FOUND NOTHING — that is the entire point of it.
  // A failure to write the heartbeat must not fail the tick: the slips are
  // already recorded, and the next tick writes it again.
  try {
    await db.ref(STATUS_PATH).set({
      lastRunAt: serverNowMs(), scanned, processed, recorded, refused, unrelated,
      mailbox: cfg.mailbox,
    });
  } catch (err) {
    console.warn(`⚠ could not write the heartbeat (${err.message}) — the capture itself is unaffected`);
  }

  console.log(`· ${scanned} scanned, ${processed} with slips · ${recorded} recorded, ${refused} REFUSED, ${unrelated} unrelated`);
  if (refused) console.log("  refused slips are in the Card recon tab under 'Emailed slips' — a terminal is not reconciling");
  return 0;
}

async function handleMessage({ client, uid, db, getToken, cfg }) {
  const empty = { processed: false, recorded: 0, refused: 0, unrelated: 0 };
  // imapflow takes a RANGE, and a range is a string ("12", "1:5") — not the
  // number. Passing the raw uid works by coercion in some paths and silently
  // addresses the wrong message in others; the documented form is the string.
  const range = String(uid);
  const downloaded = await client.download(range, undefined, { uid: true });
  if (!downloaded?.content) return empty;
  // A MIME TREE FROM OUTSIDE CAN FAIL TO PARSE, and a stream left half-read
  // holds the IMAP connection's fetch open — the next command on it hangs until
  // the socket times out, so ONE malformed message would stall the rest of the
  // tick. Destroyed on the way out, and the failure is this message's alone.
  // (CodeRabbit, PR #510.)
  let parsed;
  try {
    parsed = await simpleParser(downloaded.content);
  } catch (err) {
    try { downloaded.content.destroy?.(); } catch { /* already gone */ }
    throw new Error(`could not be read as an email (${err.message})`);
  }

  const message = {
    messageId: clip(parsed.messageId, 200),
    from: clip(parsed.from?.text, 200),
    subject: clip(parsed.subject, 200),
    receivedAt: parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.getTime() : null,
  };
  message.key = messageKey({
    messageId: parsed.messageId, from: message.from, subject: message.subject,
    // imapflow's DownloadObject.meta names it expectedSize; `size` is always
    // undefined, which quietly took a distinguishing part out of the fallback
    // key below. (CodeRabbit, PR #510.)
    date: message.receivedAt, size: downloaded.meta?.expectedSize || 0,
    // The mailbox's own identity for this message, which is what makes two
    // genuinely different no-Message-ID mails distinguishable — see messageKey.
    uid, uidValidity: String(client.mailbox?.uidValidity ?? ""),
  });

  const { take, refused: badAttachments, skipped } = planMessage(parsed.attachments);
  if (!take.length && !badAttachments.length) {
    // Ordinary mail. Marked read so it is not looked at again, and nothing is
    // written — a record per newsletter would bury the thing this feed is for.
    if (!cfg.dryRun) await client.messageFlagsAdd(range, ["\\Seen"], { uid: true });
    return empty;
  }

  // A DRY RUN CHANGES NOTHING, AND THE CLAIM IS A CHANGE. Taking one here left
  // a "claimed" row behind that the real schedule then stood down from for
  // thirty minutes — so the one command documented as safe to run by hand was
  // the one that stopped the poller capturing. (CodeRabbit, PR #510.)
  const claim = cfg.dryRun ? { taken: true, done: false, why: "dry run" } : await claimMessage(db, message.key);
  if (!claim.taken) {
    console.log(`  · "${message.subject || "(no subject)"}" — ${claim.why}`);
    // WHETHER TO MARK IT READ DEPENDS ENTIRELY ON WHY WE STOOD DOWN, and
    // getting this wrong loses a slip silently.
    //
    //   ALREADY PROCESSED — its outcome is in the feed. Marking it read is
    //     what stops it being re-downloaded every tick for ever.
    //
    //   ANOTHER RUN IS HOLDING IT — including a run that DIED holding it. That
    //     claim goes stale in 30 minutes and the next tick is supposed to
    //     retake it — but only if the search still returns it, and the search
    //     only returns UNSEEN mail. Marking it read here would hide it from
    //     the very tick that was going to rescue it, and the slip would sit in
    //     the mailbox unread by anything for ever.
    if (claim.done && !cfg.dryRun) await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch(() => {});
    return empty;
  }

  const results = badAttachments.map((r) => attachmentOutcome({ filename: r.filename, error: r.reason }));
  for (const attachment of take) {
    if (cfg.dryRun) {
      console.log(`  · would submit ${attachment.filename} (${attachment.content.length} bytes)`);
      continue;
    }
    let capture = null, error = null;
    try {
      capture = await captureOne(getToken, { attachment, message });
    } catch (err) {
      error = err.message;
    }
    const row = attachmentOutcome({ filename: attachment.filename, capture, error });
    results.push(row);
    console.log(`  · ${row.filename}: ${row.outcome}${row.reason ? ` — ${row.reason}` : ` (batch ${row.batchKey} · ${row.tid})`}`);
  }
  if (cfg.dryRun) return empty;

  const record = intakeRecord({ message, results, skipped, at: serverNowMs() });
  // ONE UPDATE, TWO PATHS, ATOMICALLY. Written as two calls, a crash between
  // them leaves the outcome recorded and the claim still "claimed" — so half an
  // hour later the next tick retakes it, resubmits slips that are already in,
  // and files the duplicate-batch refusals as REFUSED. A false alarm on the one
  // feed whose whole value is that a refusal means something. A root update
  // with two absolute paths cannot half-happen.
  const intakeId = db.ref(INTAKE_PATH).push().key;
  await db.ref().update({
    [`${INTAKE_PATH}/${intakeId}`]: record,
    [`${SEEN_PATH}/${message.key}`]: { state: "done", at: serverNowMs(), intakeId },
  });
  // LAST, and deliberately: a message is only marked read once its outcome is
  // in the database. Crash before this and the next tick sees it again, which
  // the claim and the duplicate-batch refusal both handle; crash after marking
  // it read with nothing recorded and the slip is gone.
  await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch((err) => {
    console.warn(`  ⚠ could not mark "${message.subject}" read (${err.message}) — the claim still stops it being submitted twice`);
  });

  return {
    processed: true,
    recorded: record.recorded, refused: record.refused, unrelated: record.unrelated,
  };
}

// ── THE TICK'S OWN EXIT ──────────────────────────────────────────────────────
// The RTDB connection keeps the event loop alive, so the app is closed
// explicitly and the process is allowed to END rather than being killed — which
// is what guarantees every line above actually reached the log.
let exitCode = 0;
try {
  exitCode = await run();
} catch (err) {
  console.error(`✗ ${err instanceof PollerStop ? err.message : `the poller stopped unexpectedly: ${err?.stack || err}`}`);
  exitCode = 1;
}
try { await admin.app().delete(); } catch { /* never initialised, or already gone */ }
process.exitCode = exitCode;
