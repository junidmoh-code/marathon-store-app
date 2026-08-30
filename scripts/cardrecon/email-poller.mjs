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
  parseEnvText, classifyAttachment,
} from "./intakeCore.mjs";
// ── THE SECOND READER ────────────────────────────────────────────────────────
// EFT payment notifications arrive in the SAME mailbox (customers enter it as
// the notification address in their FNB app). This poller is the only IMAP
// consumer — a separate poller could never work, because this one marks
// ordinary mail \Seen and would hide every notification from it. The decisions
// live in eftCore.mjs; here is only the wiring. See handleEftMessage.
import {
  EFT_POOL_PATH, isEftCandidate, authenticationVerdict, htmlToText,
  eftMessageKey, poolWriteDecision, eftPoolRecord,
  redactAccountDigits, domainOfAddress, parseAllowedAccountTails, accountVerdict,
  looksPaymentShaped,
} from "./eftCore.mjs";
import { selectReader, noReaderReason } from "./eftBanks.mjs";

// firebase-admin is BORROWED from functions/, the way every other script on the
// mini borrows it (scripts/shopify, scripts/social). One copy, one version.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
// The PDF text extraction and the slip-format detector are the CARD PATH'S
// OWN, borrowed — the EFT reader must see a batch slip exactly the way the
// slip pipeline would, or the two would disagree about whose document it is.
// pdfjs-dist ships in functions' dependencies; the installer ensures it is
// present in functions/node_modules on the mini.
const { pdfToLines } = require("./cardRecon/pdfText.js");
const { detectReportFormat } = require("./lib/card-recon-pdf.cjs");

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
    // TRIMMED BEFORE THE FALLBACK, not after. A whitespace-only value is
    // truthy, so `|| default` never applied and the uid became "" — which
    // createCustomToken rejects, every five minutes, while the installer
    // (which trims first, then falls back) had validated the DEFAULT
    // identity and reported everything fine. The installer must not be able
    // to disagree with the program it is checking. (Independent review, #510.)
    uid: String(env.CARD_RECON_POLLER_UID ?? "").trim() || "card-recon-email-poller",
    lookbackDays: number("CARD_RECON_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS, { min: 1, max: 365, what: "a number of days between 1 and 365" }),
    // The shop's own account numbers, LAST FOUR each, from EFT_ALLOWED_ACCOUNTS
    // in .env (comma-separated; full numbers or last-four both work). NEVER a
    // value in a log — at most the count. An empty list refuses every payment
    // as refused-account, deliberately: fail-closed until the owner fills it.
    eftAccountTails: parseAllowedAccountTails(env.EFT_ALLOWED_ACCOUNTS),
    eftAccountsConfigured: !!String(env.EFT_ALLOWED_ACCOUNTS ?? "").trim(),
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
  // The EFT reader's own tallies — separable on purpose: a refused slip means a
  // terminal is not reconciling; a refused-auth notification means somebody
  // tried to forge a payment. Different alarms for different people.
  let eftRecorded = 0, eftRefusedAuth = 0, eftRefusedParse = 0, eftRefusedAccount = 0;
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
            eftRecorded += result.eftRecorded || 0;
            eftRefusedAuth += result.eftRefusedAuth || 0;
            eftRefusedParse += result.eftRefusedParse || 0;
            eftRefusedAccount += result.eftRefusedAccount || 0;
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
      // The EFT reader beats on the same heart: counts only, never a figure —
      // this node is readable by every card_recon holder.
      eftRecorded, eftRefusedAuth, eftRefusedParse, eftRefusedAccount,
      // How many account tails the allowlist held this tick — a COUNT, never
      // a value. Zero is the loudest number on this line: it means every
      // payment refuses until EFT_ALLOWED_ACCOUNTS is set in .env.
      eftAccountTails: cfg.eftAccountTails.length,
      mailbox: cfg.mailbox,
    });
  } catch (err) {
    console.warn(`⚠ could not write the heartbeat (${err.message}) — the capture itself is unaffected`);
  }

  console.log(`· ${scanned} scanned, ${processed} with slips · ${recorded} recorded, ${refused} REFUSED, ${unrelated} unrelated`);
  if (refused) console.log("  refused slips are in the Card recon tab under 'Emailed slips' — a terminal is not reconciling");
  if (eftRecorded || eftRefusedAuth || eftRefusedParse || eftRefusedAccount) {
    console.log(`· EFT: ${eftRecorded} payment(s) recorded, ${eftRefusedAuth} FAILED AUTHENTICATION, ${eftRefusedParse} unreadable, ${eftRefusedAccount} to a DIFFERENT ACCOUNT — see /eft_pool`);
  }
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
  // The subject as LOGS may show it: FNB subject lines can carry an account
  // number, and the launchd log must not. Records sweep separately
  // (eftPoolRecord); this is for every console line. (CodeRabbit, this PR.)
  message.logSubject = redactAccountDigits(message.subject) || "(no subject)";
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

  // ── ROUTING IS BY CONTENT, DECIDED BEFORE EITHER READER CLAIMS ─────────────
  // The R100 test payment of 2026-08-30 proved the previous shape wrong twice:
  // the notification came from the PAYER'S bank (standardbank.co.za, not
  // fnb.co.za), and every field of it lived in an attached PDF — so an
  // attachment's PRESENCE says nothing about which reader owns a message. What
  // decides is what the documents ARE:
  //
  //   · a batch report (FNB's own subject line, or PDF content that
  //     detectReportFormat recognises as a slip) → the card capture path;
  //   · a bank-domain message whose content a bank reader recognises — or
  //     fails to, which is a recorded refusal — → the EFT reader, which then
  //     owns the message ENTIRELY, its PDFs included;
  //   · everything else → ordinary mail or the slip path, exactly as before.
  //
  // handleEftMessage does the content inspection itself (it must extract the
  // PDF text to decide) and returns null when the message is NOT the EFT
  // reader's — including when its PDFs turn out to be batch slips, which fall
  // through to the card path untouched. A throw inside it leaves the message
  // UNREAD so the next tick retries; nothing is marked \Seen on a message
  // whose outcome is not durably recorded.
  let eft = null;
  try {
    eft = await handleEftMessage({
      client, range, db, parsed, message, cfg,
      uid, uidValidity: String(client.mailbox?.uidValidity ?? ""),
      size: downloaded.meta?.expectedSize || 0,
    });
  } catch (err) {
    console.error(`  ✗ EFT reader on "${message.logSubject}": ${err.message} — the message stays unread and is retried`);
    return empty;
  }
  if (eft) return eft;

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
    console.log(`  · "${message.logSubject}" — ${claim.why}`);
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
    console.warn(`  ⚠ could not mark "${message.logSubject}" read (${err.message}) — the claim still stops it being submitted twice`);
  });

  return {
    processed: true,
    recorded: record.recorded, refused: record.refused, unrelated: record.unrelated,
  };
}

// ─── THE EFT READER ──────────────────────────────────────────────────────────
// One payment notification, all the way through: authenticate, inspect the
// CONTENT of every document it carries, read it with the right bank's reader,
// check the destination account, store. Returns null when the message is not
// this reader's — not a bank candidate, or its documents turn out to be batch
// slips, which belong to the card path.
//
// THE DOCUMENTS DECIDE, NOT THE ATTACHMENT COUNT. The R100 test payment
// (2026-08-30) carried every field in an attached PaymentConfirmation.pdf and
// nothing in the body; a batch report is also a PDF from a bank domain. So
// each PDF's text is extracted (borrowing functions/cardRecon/pdfText.js, the
// same extraction the slip path trusts) and classified:
//   · detectReportFormat recognises it as a slip → the card path's, untouched;
//   · a bank reader (eftBanks.mjs) recognises it → parsed exactly;
//   · nobody recognises it → a refusal that stores the text and names the
//     domain — the work order for the missing reader, never a guess.
//
// NOTHING IS SILENTLY DROPPED: every message this reader owns leaves a record
// at /eft_pool — recorded (status "unmatched"), refused-auth (forgery
// attempt), refused-parse (no reader / format change), or refused-account
// (real money, somebody else's account).
//
// THE SAME NOTIFICATION NEVER CREATES TWO POOL RECORDS. Three layers:
//   1. The record's node name IS the message's key (eftMessageKey) — a replay
//      lands on the same node.
//   2. The write is a CREATE-ONLY transaction (poolWriteDecision): an existing
//      record — whatever status a later session has moved it to — is never
//      overwritten.
//   3. The shared claim at /card_batch_intake_seen/{key}, same discipline and
//      the same stale-claim rescue as the slips. One mailbox, one ledger.
//
// A throw anywhere in here is caught by handleMessage and leaves the message
// UNREAD, so the next tick retries; \Seen is only ever set below, after the
// outcome is durably in the database.

// One message is never worth unbounded PDF rendering. A notification is one
// PDF; two tolerates a duplicate attach.
const MAX_EFT_PDFS = 3;

async function handleEftMessage({ client, range, db, parsed, message, cfg, uid, uidValidity, size }) {
  // mailparser can fail to resolve a From ADDRESS a human would read fine; the
  // raw header text is the fallback so a bank-claiming message with an odd
  // From still gets examined (and refused visibly) rather than silently filed
  // as ordinary mail. (Independent adversarial review.)
  const fromAddress = parsed.from?.value?.[0]?.address
    || /<([^<>\s]+@[^<>\s]+)>/.exec(message.from || "")?.[1]
    || null;
  if (!isEftCandidate({ fromAddress, subject: message.subject })) return null;
  const fromDomain = domainOfAddress(fromAddress);

  const empty = { processed: false, recorded: 0, refused: 0, unrelated: 0, eftRecorded: 0, eftRefusedAuth: 0, eftRefusedParse: 0, eftRefusedAccount: 0 };
  const verdict = authenticationVerdict({ headerLines: parsed.headerLines, fromAddress });

  // ── CONTENT INSPECTION, BEFORE ANY CLAIM ───────────────────────────────────
  // Only an AUTHENTICATED message earns PDF rendering — a forgery's
  // attachments are attacker files and are not opened; its refusal record
  // carries the body text.
  const bodyText = (parsed.text || "").trim() || htmlToText(parsed.html || "");
  const documents = []; // { lines: string[]|null, text: string }
  let slipPdfs = 0;
  // ── AN AUTH-FAILED MESSAGE WITH ATTACHMENTS IS NOT CONSUMED ────────────────
  // Its PDFs are never opened (attacker files), so their content cannot be
  // routed — and consuming the message would eat a GENUINE batch report whose
  // delivery path broke its DKIM (a forward, a relay). It falls through to the
  // slip path, whose capture callable validates every byte itself; a forged
  // "slip" refuses harmlessly there, a real one is captured. Only an
  // attachment-less auth failure is recorded here as a forgery attempt.
  // (Independent adversarial review, v2.)
  if (!verdict.pass && (parsed.attachments || []).some((a) => { try { return classifyAttachment(a).ok; } catch { return false; } })) {
    return null;
  }
  if (verdict.pass) {
    // Every attachment is ACCOUNTED FOR in the record, even the ones that are
    // not extracted: an oversized or corrupt PDF, or one past the ceiling,
    // leaves a placeholder line in the raw text instead of vanishing — a
    // refusal that hides the very document it refused would be undiagnosable.
    const verdicts = (Array.isArray(parsed.attachments) ? parsed.attachments : [])
      .map((att) => {
        // planMessage guards this same call; an EFT message's attachment list
        // is outside data too. (Independent adversarial review, v2.)
        try { return { att, cls: classifyAttachment(att) }; }
        catch { return { att, cls: { ok: false, kind: "refuse", why: "That attachment could not be read at all." } }; }
      })
      .filter(({ cls }) => cls.ok || cls.kind === "refuse"); // skip = inline logos etc.
    let extracted = 0;
    for (const { att, cls } of verdicts) {
      if (!cls.ok) {
        documents.push({ lines: null, text: `[attachment "${clip(att.filename, 80)}" not read: ${cls.why}]` });
        continue;
      }
      if (++extracted > MAX_EFT_PDFS) {
        documents.push({ lines: null, text: `[PDF "${clip(att.filename, 80)}" not read: more than ${MAX_EFT_PDFS} PDFs on one message]` });
        continue;
      }
      const out = await pdfToLines(att.content);
      if (!out.ok) {
        // AN ENVIRONMENTAL FAILURE MUST NOT BECOME A DURABLE REFUSAL. pdfjs
        // failing to LOAD is this machine's problem, not the document's — a
        // refusal here would be create-only and \Seen for ever, unrecoverable
        // after the environment is fixed. Throw instead: the message stays
        // unread and every later tick retries. (Independent adversarial
        // review, v2 — found while pdfjs-dist was genuinely absent.)
        if (/reader is unavailable/i.test(out.reason)) {
          throw new Error(`the PDF reader is unavailable on this machine (pdfjs-dist missing from functions/node_modules?) — run scripts/cardrecon/install-card-recon-poller.sh`);
        }
        documents.push({ lines: null, text: `[PDF "${clip(att.filename, 80)}" could not be read: ${out.reason}]` });
        continue;
      }
      // A batch slip inside a bank-domain message belongs to the CARD path.
      if (detectReportFormat(out.lines)) { slipPdfs++; continue; }
      documents.push({ lines: out.lines, text: out.lines.join("\n") });
    }
    if (slipPdfs > 0 && documents.length === 0) {
      // Every document was a slip: this whole message is the card path's.
      return null;
    }

  }

  // The auth verdict is part of the key so a forgery carrying a guessed genuine
  // Message-ID cannot occupy the key the genuine notification will need.
  const key = eftMessageKey({
    messageId: parsed.messageId, from: message.from, subject: message.subject,
    date: message.receivedAt, size, uid, uidValidity, authPass: verdict.pass,
  });

  if (cfg.dryRun) {
    console.log(`  · would examine as an EFT notification (auth ${verdict.pass ? "pass" : "FAIL"}, ${documents.length} document(s)): "${message.logSubject}"`);
    return empty;
  }

  const claim = await claimMessage(db, key);
  if (!claim.taken) {
    console.log(`  · EFT "${message.logSubject}" — ${claim.why}`);
    // done = the outcome is recorded, the message may be marked read.
    // NOT done = a run (possibly dead) still holds it — the message must stay
    // unread or the rescue tick can never see it.
    if (claim.done) await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch(() => {});
    return empty;
  }

  if (slipPdfs > 0) {
    // Mixed cargo — a slip AND other documents on one message. The EFT reader
    // takes the message, so the slip will NOT be captured from this email —
    // and a launchd log line is not a place anyone looks. The loss goes into
    // the SLIP feed as a refusal row, where slip problems live. AFTER the
    // claim, so a crash-retry cannot write it twice.
    // (Independent adversarial review, v2.)
    const slipLoss = intakeRecord({
      message,
      results: [attachmentOutcome({ filename: `${slipPdfs} batch-slip PDF(s)`, error: "Arrived alongside a payment notification, which this message was read as — the slip was NOT captured. Forward the batch report on its own." })],
      skipped: [], at: serverNowMs(),
    });
    await db.ref(INTAKE_PATH).push(slipLoss).catch((err) => {
      console.warn(`  ⚠ could not record the uncaptured slip in the intake feed (${err.message})`);
    });
    console.warn(`  ⚠ "${message.logSubject}" carries ${slipPdfs} batch-slip PDF(s) alongside other documents — refusal row written to the slip feed`);
  }

  // ── WHICH BANK'S DOCUMENT IS THIS? ─────────────────────────────────────────
  // Every extracted document is offered to the readers, then the body itself
  // (a bank that prints its fields in the email body will be read there). The
  // first document a reader recognises is parsed with that reader; recognised
  // by nobody is a refusal whose raw text and named domain are the work order
  // for the missing reader.
  let parsedPay = null, readerId = null, rawText = "";
  let account = null;
  if (verdict.pass) {
    const bodyLines = bodyText ? bodyText.split("\n") : [];
    const offered = [...documents.filter((d) => d.lines), { lines: bodyLines, text: bodyText }];
    const claimed = offered
      .map((d) => ({ d, r: selectReader({ fromDomain, lines: d.lines }) }))
      .filter((x) => x.r);
    if (claimed.length > 1) {
      // TWO PAYMENT DOCUMENTS ON ONE MESSAGE. Recording only the first would
      // silently lose the second payment; refused instead, whole, and a
      // person splits them. (Independent adversarial review, v2.)
      parsedPay = { ok: false, reason: `This message carries ${claimed.length} recognisable payment documents — only one payment per message can be recorded safely. Handle them individually.` };
      rawText = claimed.map((x) => x.d.text).join("\n────────\n");
    } else if (claimed.length === 1) {
      const { d: doc, r: reader } = claimed[0];
      readerId = reader.id;
      parsedPay = reader.parse(doc.lines);
      rawText = doc.text;
      if (parsedPay.ok) {
        account = accountVerdict({ accountMask: parsedPay.accountMask, allowedTails: cfg.eftAccountTails, configured: cfg.eftAccountsConfigured });
      }
    } else {
      // NOBODY RECOGNISES IT. If it is payment-shaped at all, the refusal is
      // the work order for the missing reader. If not — a statement, a fraud
      // alert, bank marketing — recording it would fill the owner's refusal
      // feed with red rows about newsletters, and red must keep meaning
      // something. Ordinary mail: marked read, nothing written.
      // (Independent adversarial review, v2.)
      const everything = [...documents.map((d) => d.text), bodyText].filter(Boolean).join("\n────────\n");
      if (!looksPaymentShaped(`${message.subject || ""}\n${everything}`)) {
        console.log(`  · bank mail, not payment-shaped: "${message.logSubject}" — marked read, nothing recorded`);
        // The claim is settled (not abandoned to go stale), THEN the flag.
        await db.ref(`${SEEN_PATH}/${key}`).set({ state: "done", at: serverNowMs(), eft: true });
        await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch(() => {});
        return empty;
      }
      parsedPay = { ok: false, reason: noReaderReason(fromDomain) };
      // The refusal shows everything that was seen: each document, then the
      // body — this text IS the missing reader's specification.
      rawText = everything;
    }
  } else {
    rawText = bodyText;
  }

  const record = eftPoolRecord({ message, verdict, parsed: parsedPay, account, reader: readerId, rawText, at: serverNowMs() });

  let decision = null;
  await db.ref(`${EFT_POOL_PATH}/${key}`).transaction((cur) => {
    decision = poolWriteDecision(cur, record);
    return decision.write ? decision.value : undefined; // undefined = abort, keep what is there
  });
  // The claim flips to done AFTER the pool write. A crash between the two costs
  // a stale-claim delay; the create-only transaction is what makes the retry
  // land on the existing record instead of doubling it.
  await db.ref(`${SEEN_PATH}/${key}`).set({ state: "done", at: serverNowMs(), eft: true });
  // Last, and deliberately: a message is only marked read once its outcome is
  // in the database.
  await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch((err) => {
    console.warn(`  ⚠ could not mark "${message.logSubject}" read (${err.message}) — the claim still stops it landing twice`);
  });

  // A REPLAY REPORTS NOTHING. The record was written by an earlier run; saying
  // "recorded" again — and counting it again in the heartbeat — makes a no-op
  // look like a payment. (Independent adversarial review.)
  if (decision && !decision.write) {
    console.log(`  · EFT "${message.logSubject}" — ${decision.why}`);
    return empty;
  }
  const label = record.outcome === "recorded"
    ? `payment recorded (status unmatched, ${record.reader} reader)`
    : `${record.outcome} — ${record.reason}`;
  console.log(`  · EFT: ${label}`);
  return {
    // processed feeds the "N with slips" line and the heartbeat's slip count —
    // an EFT message is not slip work and must not inflate it; the EFT
    // tallies are its whole story.
    ...empty,
    eftRecorded: record.outcome === "recorded" ? 1 : 0,
    eftRefusedAuth: record.outcome === "refused-auth" ? 1 : 0,
    eftRefusedParse: record.outcome === "refused-parse" ? 1 : 0,
    eftRefusedAccount: record.outcome === "refused-account" ? 1 : 0,
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
