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
//   2. A LOCAL CACHE of ledger-confirmed keys (and uid markers), so a lost
//      database claim does not mean re-reading a fortnight of mail every
//      tick. \Seen is still SET after processing, as politeness to the
//      human's inbox — but never consulted: the owner reads this mailbox on
//      their phone, and the read-flag is theirs, not this program's memory.
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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { deliverNotices } from "./noticeCore.mjs";
import { drainVerdictEmails, parseVerdictMode, verdictSenderOk, EFT_VERDICT_FROM_MAILBOX } from "./verdictMailCore.mjs";
import {
  guideReplyEligibility, drainGuideReplies, guideClaimPath, guideClaimStep, guideCountPath, guideCountStep,
  parseGuideReplySwitch, parseNeverList, GUIDE_REPLY_NEVER_ENV_VAR,
} from "./guideReplyCore.mjs";

import {
  messageKey, planMessage, attachmentOutcome, intakeRecord, claimDecision, clip,
  parseEnvText, classifyAttachment,
  EVIDENCE_PATH, refusedPdfPath, evidenceRecord,
  retryCandidates, sweepDue, judgedVersion, RETRY_WINDOW_MS, VERSION_CHECK_MS, PENDING_RETRY_MS,
} from "./intakeCore.mjs";
// ── THE SECOND READER ────────────────────────────────────────────────────────
// EFT payment notifications arrive in the SAME mailbox (customers enter it as
// the notification address in their FNB app). This poller is the only IMAP
// consumer — a separate poller could never work, because this one marks
// ordinary mail \Seen and would hide every notification from it. The decisions
// live in eftCore.mjs; here is only the wiring. See handleEftMessage.
import {
  EFT_POOL_PATH, eftMessageRoute, authenticationVerdict, htmlToText,
  eftMessageKey, createOnlyStep, eftPoolRecord,
  paymentFingerprint, fingerprintClaimStep, EFT_FINGERPRINT_PATH, applyFingerprintHold, HELD_OUTCOMES,
  refusalFingerprint, applyRefusalFingerprint,
  redactAccountDigits, domainOfAddress, parseAllowedAccountTails, parseAllowedAccounts,
  destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff, EFT_CUTOFF_ENV_VAR, DEFAULT_EFT_PAYMENT_DATE_CUTOFF,
  IMMEDIATE_NOT_REQUIRED_FROM,
  looksPaymentShaped, looksLikeStrangerPayment, unknownBankRecord,
} from "./eftCore.mjs";
import { selectReader, noReaderReason } from "./eftBanks.mjs";
import { envelopeCandidateKeys, groupEftPayments, eftPaymentKey, applyEvictions } from "./eftCore.mjs";

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
const { detectReportFormat, PARSER_VERSION } = require("./lib/card-recon-pdf.cjs");

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
// Where a refused attachment's original PDF is kept (owner-only — see
// evidenceRecord in intakeCore.mjs). The project's default bucket, the same
// one the callable stores slips in.
const STORAGE_BUCKET = "marathon-club.firebasestorage.app";

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
    // The SAME mailbox sends Junid's "Unread – needs manual entry" emails
    // (noticeCore.mjs) — a Gmail app password works for SMTP as for IMAP.
    smtpHost: String(env.CARD_RECON_SMTP_HOST || "smtp.gmail.com").trim(),
    smtpPort: number("CARD_RECON_SMTP_PORT", 465, { min: 1, max: 65535, what: "a port number" }),
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
    // FIX 7a: the FULL numbers, so every digit a document prints is checked.
    eftAccounts: parseAllowedAccounts(env.EFT_ALLOWED_ACCOUNTS),
    eftAccountsConfigured: !!String(env.EFT_ALLOWED_ACCOUNTS ?? "").trim(),
    // Junid's verdict emails: "all" (default) or "rejected" — verdictMailCore.
    verdictMode: parseVerdictMode(env.EFT_VERDICT_EMAILS),
    // Junid, 25 Oct 2026: the guide reply to a customer who emailed their own
    // proof — "on" (default) or "off"; plus addresses never replied to.
    guideReply: parseGuideReplySwitch(env.EFT_GUIDE_REPLY),
    guideReplyNever: parseNeverList(env[GUIDE_REPLY_NEVER_ENV_VAR]),
    // FIX 8: the payment-date cutoff (EFT_PAYMENT_DATE_CUTOFF, YYYY-MM-DD SAST,
    // default in eftCore.mjs). A payment the BANK dates before this day is
    // refused — stale money the pool never saw is not new money. A value that
    // is not a date is carried here as {ok:false}: the EFT reader then throws
    // on every bank notification BEFORE claiming it (handleEftMessage), so
    // they wait unread and are retried once the line is fixed — never a
    // silent fallback to a cutoff Junid did not set, and never a stopped
    // tick either: the card-slip path and the heartbeat keep running.
    // (Sonnet architect review, #765.)
    eftPaymentDateCutoff: parsePaymentDateCutoff(env.EFT_PAYMENT_DATE_CUTOFF),
    eftPaymentDateCutoffSource: sourceOf(EFT_CUTOFF_ENV_VAR),
    dryRun: process.argv.includes("--dry-run"),
  };
}

// ─── THE LOCAL PROCESSED-KEY CACHE ───────────────────────────────────────────
// A convenience layer over the claim ledger, never a second truth: keys the
// ledger has confirmed "done", remembered locally so the every-two-minutes
// tick does not re-ask RTDB about the same fortnight of mail for ever. Lost or
// deleted, the next tick simply re-reads the ledger once per message and
// rebuilds it. Pruned past the lookback window so it cannot grow unbounded.
const PROCESSED_CACHE_FILE = join(REPO, "logs", "card-recon-processed.json");
// THE EVICTION LIST. A retry script (retry-eft-message.mjs, retry-intake-
// message.mjs) that wants a message looked at again cannot just delete its
// keys from the cache file: a tick in flight holds its own copy for minutes
// and would write the keys straight back. So the scripts also record the keys
// here, and this program forgets them at load AND at every save — whatever
// its in-memory copy says. Entries age out with the cache's own window.
const EVICT_FILE = join(REPO, "logs", "card-recon-evict.json");
function readEvictions() {
  try { return JSON.parse(readFileSync(EVICT_FILE, "utf8")) || {}; } catch { return {}; }
}
function loadProcessedCache(lookbackDays) {
  let entries = {};
  try { entries = JSON.parse(readFileSync(PROCESSED_CACHE_FILE, "utf8")) || {}; } catch { /* first run, or corrupt — rebuilt from the ledger */ }
  const windowMs = (lookbackDays + 3) * 86400000;
  const oldest = Date.now() - windowMs;
  let dirty = false;
  for (const [k, at] of Object.entries(entries)) {
    if (!Number.isFinite(at) || at < oldest) { delete entries[k]; dirty = true; }
  }
  if (applyEvictions(entries, readEvictions(), Date.now(), windowMs)) dirty = true;
  return { entries, dirty, windowMs };
}
function saveProcessedCache(cache) {
  // Re-read the eviction list at the moment of writing: a retry that ran
  // while this tick was in flight is honoured, never overwritten.
  if (applyEvictions(cache.entries, readEvictions(), Date.now(), cache.windowMs)) cache.dirty = true;
  if (!cache.dirty) return;
  try { writeFileSync(PROCESSED_CACHE_FILE, JSON.stringify(cache.entries)); }
  catch (err) { console.warn(`⚠ could not write ${PROCESSED_CACHE_FILE} (${err.message}) — the ledger is the truth; this only costs re-reads`); }
}

// ─── THE AUTOMATIC RE-RUN ────────────────────────────────────────────────────
// A fix to the parser used to reach the refusals it was written for only when
// somebody ran retry-intake-message.mjs once per message. Now each intake row
// carries the parser version that judged it, and when a deploy raises that
// version the poller re-runs every refusal from the last fortnight an older
// one judged — the same two moves the script makes (clear the claim, forget
// the cached key), with nobody involved. The decisions are pure and tested
// (retryCandidates / sweepDue in intakeCore.mjs); this is the IO.
//
// BANDWIDTH: the deployed version is ASKED FOR at most every 30 minutes (one
// tiny callable answer), and the bounded intake query — orderByChild("at")
// over the window, never the node — runs only when that version has risen or
// six hours have passed. A quiet tick reads nothing.
//
// DURABILITY: a released message is remembered in this file BEFORE its claim
// is cleared, and stays remembered until the scan sees it re-processed. The
// local processed cache would otherwise still say "done" after a crash between
// the two, and the message would never be looked at again.
const RETRY_STATE_FILE = join(REPO, "logs", "card-recon-retry-state.json");
function readRetryState() {
  let state = {};
  try { state = JSON.parse(readFileSync(RETRY_STATE_FILE, "utf8")) || {}; } catch { /* first run */ }
  const now = Date.now();
  const pending = {};
  for (const [k, at] of Object.entries(state.pending || {})) {
    if (Number.isFinite(at) && now - at <= PENDING_RETRY_MS) pending[k] = at;
  }
  // Which intake row each pending release came from, so the re-run's row can
  // be linked back to it (retriedIntakeId) — see handleMessage.
  const releasedFrom = {};
  for (const [k, id] of Object.entries(state.releasedFrom || {})) if (k in pending && typeof id === "string") releasedFrom[k] = id;
  return { ...state, pending, releasedFrom };
}
function writeRetryState(state) {
  try { writeFileSync(RETRY_STATE_FILE, JSON.stringify(state)); }
  catch (err) { console.warn(`⚠ could not write ${RETRY_STATE_FILE} (${err.message})`); }
}

/**
 * Release every refusal an older parser judged, so this tick's scan re-runs
 * it. Returns the pending map the scan must honour.
 */
async function retryStale({ db, getToken, cfg }) {
  const state = readRetryState();
  const now = serverNowMs();
  if (!Number.isInteger(state.deployedVersion) || !(Number(state.checkedAt) > 0) || now - state.checkedAt > VERSION_CHECK_MS) {
    try {
      const v = await callCapture(await getToken(), { action: "version" });
      if (Number.isInteger(v?.parserVersion)) state.deployedVersion = v.parserVersion;
    } catch (err) {
      // A callable from before this change has no "version" action: nothing
      // is re-run until one that does is deployed.
      console.warn(`⚠ could not ask the capture callable for its parser version (${err.message}) — no automatic re-run this time`);
    }
    state.checkedAt = now;
  }
  if (cfg.dryRun || !sweepDue(state, { deployedVersion: state.deployedVersion, nowMs: now })) {
    if (!cfg.dryRun) writeRetryState(state);
    return state.pending;
  }
  const windowMs = Math.min(RETRY_WINDOW_MS, cfg.lookbackDays * 86400000);
  const snap = await db.ref(INTAKE_PATH).orderByChild("at").startAt(now - windowMs).once("value");
  const candidates = retryCandidates(snap.val(), { nowMs: now, deployedVersion: state.deployedVersion, windowMs });
  for (const c of candidates) {
    state.pending[c.messageKey] = now;
    state.releasedFrom[c.messageKey] = c.id;
    writeRetryState(state);
    // ONE update: the claim goes and the row is stamped together. The refused
    // row STAYS — it is the record of the first attempt — but stops counting
    // as outstanding; the re-run writes a row of its own.
    await db.ref().update({
      [`${SEEN_PATH}/${c.messageKey}`]: null,
      [`${INTAKE_PATH}/${c.id}/retriedAt`]: now,
      [`${INTAKE_PATH}/${c.id}/retriedBy`]: "auto-retry",
      [`${INTAKE_PATH}/${c.id}/retriedForVersion`]: state.deployedVersion,
    });
    console.log(`  ↻ re-running intake ${c.id} — judged by an older parser than v${state.deployedVersion}`);
  }
  state.sweptVersion = state.deployedVersion;
  state.sweptAt = now;
  writeRetryState(state);
  if (candidates.length) console.log(`· ${candidates.length} earlier refusal(s) released for re-run under parser v${state.deployedVersion}`);
  return state.pending;
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
  // THE TID TRAVELS WITH THE REFUSAL. The duplicate check runs at EXTRACT, so
  // the commonest refusal of all was returning here — and returning no
  // terminal, which left the capture screen unable to show it against any
  // card. The callable now stamps the TID onto every refusal it makes once the
  // file has been parsed; this carries it through.
  if (!extract.ok) return { ok: false, reason: extract.reason, tid: extract.tid || null, parserVersion: extract.parserVersion ?? null };

  const submit = await callCapture(await getToken(), { action: "submit", draftId: extract.draftId });
  if (!submit.ok) return { ok: false, reason: submit.reason, tid: extract.review?.tid, parserVersion: submit.parserVersion ?? null };
  return {
    // Which parser judged it — stamped on the intake row (see retryStale).
    parserVersion: submit.parserVersion ?? extract.parserVersion ?? null,
    recorded: true,
    tid: extract.review?.tid || null,
    storeId: extract.review?.terminal?.storeId || null,
    tillId: extract.review?.terminal?.tillId || null,
    // THE NAME THE TILL HAD WHEN THIS SLIP WAS CAPTURED, stamped here rather
    // than looked up later. The registry row is edited whenever a machine is
    // renamed or moved — three of the six were on 18 Sep 2026 — and a feed that
    // resolved the label at RENDER time would retitle every historical row to
    // whatever the machine is called today. The record on /card_batches keeps
    // its own `terminalLabel` for exactly this reason; this is the same rule
    // applied to the intake feed.
    terminalLabel: extract.review?.terminal?.label || null,
    // When the batch CLOSED and the till the machine stood on for it — so the
    // capture screen ticks a till for TODAY's report only, never for an old
    // batch re-printed today, and a moved machine is named by where it stood.
    closedAt: Number.isFinite(submit.closedAt) ? submit.closedAt : null,
    placeStoreId: submit.placeStoreId || null,
    placeTillId: submit.placeTillId || null,
    placeLabel: submit.placeLabel || null,
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

  // ── JUNID'S UNREAD NOTICES — BEFORE the mailbox, so an IMAP outage ──────
  // never holds them up (Sonnet review, #707).
  // A slip the server gave up reading is emailed to Junid from this mailbox.
  // The server decides what and to whom; this only delivers (noticeCore.mjs).
  // A failure here is logged and costs nothing else: the notice waits for the
  // next tick, and the row is already in his report regardless.
  if (!cfg.dryRun) {
    try {
      const transport = nodemailer.createTransport({
        host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpPort === 465,
        auth: { user: cfg.user, pass: cfg.password },
        // Short, because this runs BEFORE the mailbox: a dead SMTP host must
        // cost seconds, not the tick. (Sonnet review, #707.)
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      });
      const round = await deliverNotices({
        call: async (data) => callCapture(await getToken(), data),
        send: (mail) => transport.sendMail(mail),
        from: cfg.user,
      });
      if (round.refusal) console.warn(`⚠ card recon notices: ${round.refusal}`);
    } catch (err) {
      console.warn(`⚠ card recon notices could not be collected (${err.message}) — they wait for the next tick`);
    }
  }

  // ── JUNID'S EFT VERDICT EMAILS — the recycler reports' path: Gmail SMTP as
  // the card-recon mailbox, to the fixed inbox in verdictMailCore.mjs. The
  // transport connects only when a verdict is sent. A dry run sends nothing.
  if (!cfg.dryRun && !verdictSenderOk(cfg.user)) {
    console.warn(`⚠ EFT verdict emails are OFF this tick: the mailbox is ${cfg.user}, not ${EFT_VERDICT_FROM_MAILBOX}`);
  } else if (!cfg.dryRun) {
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpPort === 465,
      auth: { user: cfg.user, pass: cfg.password },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    verdictSend = (mail) => transport.sendMail(mail);
    verdictFrom = cfg.user;
    verdictMode = cfg.verdictMode.mode;
    if (cfg.verdictMode.warning) console.warn(`⚠ ${cfg.verdictMode.warning}`);
    // The customer guide reply goes the same way, as the same mailbox — and
    // only when that mailbox is the card-recon one (the guard just above).
    if (cfg.guideReply.warning) console.warn(`⚠ ${cfg.guideReply.warning}`);
    guideReplyOn = cfg.guideReply.on;
    guideNever = cfg.guideReplyNever;
    guideDb = db;
  }
  // Which immediacy rule decides, said every tick (date-phased, Junid 27 Oct 2026).
  console.log(`· EFT: a payment the bank dates before ${IMMEDIATE_NOT_REQUIRED_FROM} must be immediate; from ${IMMEDIATE_NOT_REQUIRED_FROM} immediate or regular`);
  // FIX 8 — said on every tick, so the log always shows which cutoff decided:
  // a date, never a secret. A bad value is said every tick too, until fixed.
  if (cfg.eftPaymentDateCutoff.ok) {
    console.log(`· EFT payment-date cutoff: ${cfg.eftPaymentDateCutoff.date} (${EFT_CUTOFF_ENV_VAR}) — a payment the bank dates earlier refuses`);
  } else {
    console.warn(`⚠ ${cfg.eftPaymentDateCutoff.reason} It is set in ${cfg.eftPaymentDateCutoffSource}; fix it or remove it to use the default (${DEFAULT_EFT_PAYMENT_DATE_CUTOFF}). Until then every bank notification waits UNREAD — nothing is confirmed, nothing is refused; slips are unaffected.`);
  }

  // ── RE-RUN WHAT AN OLDER PARSER REFUSED — before the scan, so the scan
  // finds the released messages in this same tick. Never the tick's failure.
  let retryPending = {};
  try {
    retryPending = await retryStale({ db, getToken, cfg });
  } catch (err) {
    console.warn(`⚠ the automatic re-run sweep failed (${err.message}) — it is tried again next time`);
    retryPending = readRetryState().pending;
  }
  const releasedFrom = readRetryState().releasedFrom;

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
  let eftRecorded = 0, eftRefusedAuth = 0, eftRefusedParse = 0, eftRefusedAccount = 0, eftRefusedTiming = 0, eftRefusedStale = 0, eftHeld = 0, eftErrors = 0;
  let scannedSoFar = 0;
  let windowCount = 0;
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const since = new Date(serverNowMs() - cfg.lookbackDays * 86400000);
      // ── EVERY message in the window, READ OR NOT ─────────────────────────
      // The old search asked for UNSEEN mail — and the owner reads this
      // mailbox on their phone, which marks messages read before the poller
      // ever sees them. \Seen is a person's gesture, not this program's
      // memory: what has been PROCESSED lives in the claim ledger at
      // /card_batch_intake_seen, keyed by message id, and that is what the
      // filter below consults. The read-flag is still SET after processing
      // (politeness to the human's inbox) but never trusted again.
      const uids = await client.search({ since }, { uid: true });
      // One envelope fetch answers "which of these are new?" without
      // downloading a single body: with a Message-ID the ledger key is
      // computable right here (envelopeCandidateKeys — both readers' key
      // shapes). Known keys come from the local cache first, so a routine
      // tick makes ZERO ledger reads; a key the cache does not know is read
      // from the ledger once and cached. No Message-ID → download it and let
      // the per-message claim decide: one wasted download, never a wrong skip.
      const candidates = [];
      if (uids?.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          candidates.push({ uid: msg.uid, messageId: msg.envelope?.messageId ?? null });
        }
      }
      windowCount = candidates.length;
      const cache = loadProcessedCache(cfg.lookbackDays);
      // A second cache marker keyed by the mailbox's OWN identity for the
      // message (uidValidity + uid), learned whenever a message reaches a
      // durably-final state. It exists for the case where the envelope's
      // Message-ID string differs byte-for-byte from the parsed one the
      // ledger was keyed with (folding, exotic headers): without it such a
      // message would be re-downloaded every tick for a fortnight; with it,
      // once.
      const uidKeyOf = (uid) => `u:${String(client.mailbox?.uidValidity ?? "")}:${uid}`;
      const unprocessed = [];
      let pendingChanged = false;
      const oldestRelease = Math.min(...Object.values(retryPending).filter(Number.isFinite));
      for (const c of candidates) {
        const keys = envelopeCandidateKeys({ messageId: c.messageId });
        // ── A MESSAGE RELEASED FOR RE-RUN (retryStale) bypasses the local
        // cache — which still says "done" — and asks the ledger directly.
        const releasedAt = keys ? keys.map((k) => retryPending[k]).find(Number.isFinite) : undefined;
        if (releasedAt !== undefined) {
          const claim = (await db.ref(`${SEEN_PATH}/${keys[0]}`).once("value")).val();
          if (claim?.state === "done") {
            // Re-processed since the release (or the release never cleared
            // it): either way, finished with.
            if (Number(claim.at) >= releasedAt) { for (const k of keys) delete retryPending[k]; pendingChanged = true; }
            continue;
          }
          for (const k of keys) delete cache.entries[k];
          delete cache.entries[uidKeyOf(c.uid)];
          cache.dirty = true;
          unprocessed.push(c);
          continue;
        }
        // A uid marker cached BEFORE a pending release is not trusted: the
        // envelope's Message-ID can differ from the parsed one the release is
        // keyed by (or be absent), and then only the ledger can say whether
        // this message is one of the released. Costs a ledger read per such
        // message until the release is re-processed.
        const uidCachedAt = cache.entries[uidKeyOf(c.uid)];
        if (uidCachedAt && !(Number.isFinite(oldestRelease) && uidCachedAt < oldestRelease)) continue;
        if (!keys) { unprocessed.push(c); continue; }
        if (keys.some((k) => cache.entries[k])) continue;
        let done = false;
        for (const k of keys) {
          const state = (await db.ref(`${SEEN_PATH}/${k}/state`).once("value")).val();
          if (state === "done") {
            cache.entries[k] = Date.now();
            cache.entries[uidKeyOf(c.uid)] = Date.now();
            cache.dirty = true;
            done = true;
            break;
          }
        }
        if (!done) unprocessed.push(c);
      }
      if (pendingChanged && !cfg.dryRun) writeRetryState({ ...readRetryState(), pending: retryPending });
      // RE-RUNS GO FIRST, OLDEST FIRST. Daily reports of one open batch must
      // be re-read in the order they were sent, or an earlier one meets the
      // fuller one already recorded and is refused as "shrinks" (Trophy Till
      // 1's batch 69 has five). Then the newest of everything else, as before;
      // the tick handles the lot in mailbox order.
      const isReleased = (c) => {
        const keys = envelopeCandidateKeys({ messageId: c.messageId });
        return !!keys && keys.some((k) => Number.isFinite(retryPending[k]));
      };
      const released = unprocessed.filter(isReleased).slice(0, MAX_MESSAGES_PER_TICK);
      const others = unprocessed.filter((c) => !isReleased(c));
      const room = MAX_MESSAGES_PER_TICK - released.length;
      const take = [...released, ...(room > 0 ? others.slice(-room) : [])]
        .map((c) => c.uid).sort((a, b) => a - b);
      scanned = take.length;
      if (!cfg.dryRun) saveProcessedCache(cache);
      if (!take.length) {
        // A QUIET TICK STILL BEATS. The heartbeat below is written on the way
        // out either way, which is what tells the tab apart from a dead poller.
        console.log(`· 0 unprocessed messages to look at (${candidates.length} in the window)`);
      } else {
        console.log(`· ${take.length} unprocessed message${take.length === 1 ? "" : "s"} to look at (${candidates.length} in the window)`);

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
            const result = await handleMessage({ client, uid, db, getToken, cfg, releasedFrom });
            // `done` = this message's outcome is durably in the database (or
            // it was found already done) — safe to never download again. A
            // held claim, a dry run and a throw all stay un-cached, so the
            // retry that rescues them still sees them.
            if (result.done && !cfg.dryRun) {
              cache.entries[uidKeyOf(uid)] = Date.now();
              cache.dirty = true;
            }
            if (result.processed) processed++;
            recorded += result.recorded;
            refused += result.refused;
            unrelated += result.unrelated;
            eftRecorded += result.eftRecorded || 0;
            eftRefusedAuth += result.eftRefusedAuth || 0;
            eftRefusedParse += result.eftRefusedParse || 0;
            eftRefusedAccount += result.eftRefusedAccount || 0;
            eftRefusedTiming += result.eftRefusedTiming || 0;
            eftRefusedStale += result.eftRefusedStale || 0;
            eftHeld += result.eftHeld || 0;
            eftErrors += result.eftErrors || 0;
          } catch (err) {
            console.error(`  ✗ message uid ${uid}: ${err.message}`);
          }
        }
      }
      if (!cfg.dryRun) saveProcessedCache(cache);
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* the connection is going anyway */ }
    // Junid's verdict emails, AFTER the mailbox is let go — see sendVerdicts.
    await sendVerdicts();
  }

  // WRITTEN EVEN WHEN THE TICK FOUND NOTHING — that is the entire point of it.
  // A failure to write the heartbeat must not fail the tick: the slips are
  // already recorded, and the next tick writes it again.
  try {
    await db.ref(STATUS_PATH).set({
      // `scanned` = messages this tick actually took on (was "unread found"
      // before the processed-ledger scan); `window` = everything the lookback
      // held, so the two together say how much of the mailbox is settled.
      lastRunAt: serverNowMs(), scanned, window: windowCount, processed, recorded, refused, unrelated,
      // The EFT reader beats on the same heart: counts only, never a figure —
      // this node is readable by every card_recon holder.
      eftRecorded, eftRefusedAuth, eftRefusedParse, eftRefusedAccount, eftRefusedTiming, eftRefusedStale, eftHeld,
      // Counted where it happens: noteStrangerPayment hands nothing back (it
      // must not consume the message), so the tally is a run counter rather
      // than a value threaded through six return points.
      eftUnknownBank: unknownBankThisRun,
      // How many account tails the allowlist held this tick — a COUNT, never
      // a value. Zero is the loudest number on this line: it means every
      // payment refuses until EFT_ALLOWED_ACCOUNTS is set in .env.
      eftAccountTails: cfg.eftAccountTails.length,
      // FIX 8: the cutoff this tick refused stale payments against — a date,
      // so the owner can see from the heartbeat which cutoff is live.
      eftPaymentDateCutoff: cfg.eftPaymentDateCutoff.ok ? cfg.eftPaymentDateCutoff.date : "INVALID",
      eftImmediateNotRequiredFrom: IMMEDIATE_NOT_REQUIRED_FROM,
      // Messages the EFT reader THREW on this tick (left unread, retried) — a
      // persistent environment failure must not hide behind a healthy beat.
      eftErrors,
      mailbox: cfg.mailbox,
    });
  } catch (err) {
    console.warn(`⚠ could not write the heartbeat (${err.message}) — the capture itself is unaffected`);
  }

  console.log(`· ${scanned} scanned, ${processed} with slips · ${recorded} recorded, ${refused} REFUSED, ${unrelated} unrelated`);
  if (refused) console.log("  refused slips are in the Card recon tab under 'Emailed slips' — a terminal is not reconciling");
  if (eftRecorded || eftRefusedAuth || eftRefusedParse || eftRefusedAccount || eftRefusedTiming || eftRefusedStale || eftHeld || unknownBankThisRun) {
    console.log(`· EFT: ${eftRecorded} payment(s) recorded, ${eftRefusedAuth} FAILED AUTHENTICATION, ${eftRefusedParse} unreadable, ${eftRefusedAccount} to a DIFFERENT ACCOUNT, ${eftRefusedTiming} NOT IMMEDIATE, ${eftRefusedStale} DATED BEFORE THE CUTOFF, ${eftHeld} HELD (resent copy, possible duplicate for review, or no bank transaction id), ${unknownBankThisRun} from a bank not set up — see /eft_pool`);
  }
  return 0;
}

/**
 * Keep a refused message's evidence: each refused attachment's PDF in Storage
 * and the lines it extracted, for the owner-only evidence node.
 *
 * BEST EFFORT, AND NEVER THE REASON A ROW IS LOST. A Storage outage or a PDF
 * that will not extract costs the evidence, said in the record's `note` — the
 * refusal itself is still written, because that row is what tells Junid a
 * terminal did not reconcile.
 */
async function keepEvidence({ intakeId, refusedFiles }) {
  const items = [];
  const paths = new Map();
  let n = 0;
  for (const f of refusedFiles) {
    const item = { filename: f.attachment.filename, reason: f.reason, lines: null, pdfPath: null, note: null };
    const path = refusedPdfPath(intakeId, n++);
    try {
      await admin.storage().bucket(STORAGE_BUCKET).file(path).save(f.attachment.content, {
        resumable: false,
        contentType: "application/pdf",
        metadata: { cacheControl: "private, max-age=0" },
      });
      item.pdfPath = path;
      paths.set(f, path);
    } catch (err) {
      item.note = `the PDF could not be stored (${clip(err.message, 120)})`;
      console.warn(`  ⚠ evidence: could not store ${path} (${err.message}) — the refusal is still recorded`);
    }
    try {
      // The card path's own extraction (clustered lines) — what the callable read.
      const out = await pdfToLines(f.attachment.content);
      if (out.ok) item.lines = out.lines;
      else item.note = [item.note, `no lines: ${clip(out.reason, 120)}`].filter(Boolean).join("; ");
    } catch (err) {
      item.note = [item.note, `no lines: ${clip(err.message, 120)}`].filter(Boolean).join("; ");
    }
    items.push(item);
  }
  return { record: evidenceRecord({ items, at: serverNowMs(), parserVersion: PARSER_VERSION }), paths };
}

async function handleMessage({ client, uid, db, getToken, cfg, releasedFrom = {} }) {
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
    return { ...empty, eftErrors: 1 };
  }
  if (eft) return eft;

  const { take, refused: badAttachments, skipped } = planMessage(parsed.attachments);
  if (!take.length && !badAttachments.length) {
    // Ordinary mail. A tiny DONE row in the ledger is what stops it being
    // re-downloaded every tick now that the read-flag is nobody's memory —
    // \Seen used to carry this, and \Seen is the owner's phone's to set.
    // Still no intake record: a row per newsletter would bury the feed.
    if (!cfg.dryRun) {
      await db.ref(`${SEEN_PATH}/${message.key}`).set({ state: "done", at: serverNowMs(), unrelated: true });
      await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch(() => {});
      return { ...empty, done: true };
    }
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
    //     claim goes stale in 30 minutes and the next tick retakes it: the
    //     scan filters by the LEDGER, a held claim is not "done", so the
    //     message stays visible to the rescue tick. (The read-flag stopped
    //     mattering when the scan stopped consulting it — but it is still only
    //     set on done outcomes, so the human's inbox tells the same story.)
    if (claim.done && !cfg.dryRun) await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch(() => {});
    return { ...empty, done: claim.done && !cfg.dryRun };
  }

  const results = badAttachments.map((r) => attachmentOutcome({ filename: r.filename, error: r.reason }));
  // The push id is taken NOW, so a refused attachment's evidence can be filed
  // under the same key as the row that reports it.
  const intakeId = cfg.dryRun ? null : db.ref(INTAKE_PATH).push().key;
  const refusedFiles = [];
  // One per submitted attachment: the parser version that answered, or null.
  const versions = [];
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
    versions.push(Number.isInteger(capture?.parserVersion) ? capture.parserVersion : null);
    const row = attachmentOutcome({ filename: attachment.filename, capture, error });
    // The UNREDACTED reason travels to the owner-only evidence; the row keeps
    // the redacted one.
    // A re-send of a batch already on file is not kept: the recorded batch IS
    // its evidence, and those are most of all refusals (CARD-RECON-REFUSALS.md).
    const duplicate = /already captured/i.test(String(capture?.reason || ""));
    if (row.outcome === "refused" && !duplicate) refusedFiles.push({ attachment, row, reason: error || capture?.reason || row.reason });
    results.push(row);
    console.log(`  · ${row.filename}: ${row.outcome}${row.reason ? ` — ${row.reason}` : ` (batch ${row.batchKey} · ${row.tid})`}`);
  }
  if (cfg.dryRun) return empty;

  // Evidence is never the reason a message's outcome is not written: a throw
  // here would leave the claim "claimed" and the next tick would re-submit
  // slips this one already recorded.
  let evidence = null;
  if (refusedFiles.length) {
    try { evidence = await keepEvidence({ intakeId, refusedFiles }); }
    catch (err) { console.warn(`  ⚠ evidence could not be kept (${err.message}) — the outcome is still recorded`); }
  }
  if (evidence) {
    // The row says WHERE the PDF is and nothing about what it holds — before
    // the record is built, because intakeRecord copies the rows.
    for (const f of refusedFiles) f.row.evidence = evidence.paths.get(f) || null;
  }
  const record = intakeRecord({ message, results, skipped, at: serverNowMs(), parserVersion: judgedVersion(versions) });
  // A re-run says which row it re-ran, so an automatic re-run that got NO
  // answer (a transport failure) is not released again every six hours.
  if (releasedFrom[message.key]) record.rerunOf = releasedFrom[message.key];
  // ONE UPDATE, TWO (OR THREE) PATHS, ATOMICALLY. Written as two calls, a crash between
  // them leaves the outcome recorded and the claim still "claimed" — so half an
  // hour later the next tick retakes it, resubmits slips that are already in,
  // and files the duplicate-batch refusals as REFUSED. A false alarm on the one
  // feed whose whole value is that a refusal means something. A root update
  // with two absolute paths cannot half-happen.
  await db.ref().update({
    [`${INTAKE_PATH}/${intakeId}`]: record,
    [`${SEEN_PATH}/${message.key}`]: { state: "done", at: serverNowMs(), intakeId },
    ...(evidence ? { [`${EVIDENCE_PATH}/${intakeId}`]: evidence.record } : {}),
    // A RE-RUN LINKS BACK. The refused row it replaces stops showing only once
    // this answer exists (todaysArrivals.js) — never merely because a re-run
    // was asked for and might not have happened.
    ...(releasedFrom[message.key] ? { [`${INTAKE_PATH}/${releasedFrom[message.key]}/retriedIntakeId`]: intakeId } : {}),
  });
  // LAST, and deliberately: a message is only marked read once its outcome is
  // in the database. Crash before this and the next tick sees it again, which
  // the claim and the duplicate-batch refusal both handle; crash after marking
  // it read with nothing recorded and the slip is gone.
  await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch((err) => {
    console.warn(`  ⚠ could not mark "${message.logSubject}" read (${err.message}) — the claim still stops it being submitted twice`);
  });

  return {
    processed: true, done: true,
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
//   2. The write is a CREATE-ONLY transaction (createOnlyStep): an existing
//      record — whatever status a later session has moved it to — is never
//      overwritten.
//   3. The shared claim at /card_batch_intake_seen/{key}, same discipline and
//      the same stale-claim rescue as the slips. One mailbox, one ledger.
//
// A throw anywhere in here is caught by handleMessage and leaves the message
// UNREAD, so the next tick retries; \Seen is only ever set below, after the
// outcome is durably in the database.

// One message is never worth unbounded PDF rendering. Standard Bank BATCHES
// payments — several PDFs on one email is now the expected shape, not a
// duplicate-attach tolerance — so the ceiling is what a real batch could
// plausibly carry. Past it, each unrendered PDF still leaves a refusal row
// (see the unreadable-documents guard in handleEftMessage), never silence.
const MAX_EFT_PDFS = 8;

// ── THE VERDICT EMAIL (Junid, 17 Oct 2026) ───────────────────────────────────
// Queued once per pool record THIS run wrote — after the write, so the email
// can only ever describe a decision already made, and a replay (which writes
// nothing) emails nothing. Sent by sendVerdicts() once the mailbox session is
// closed (verdictMailCore.drainVerdictEmails). A failed send is logged and
// lost: the record is the truth and stands regardless.
let verdictSend = null;
let verdictFrom = null;
let verdictMode = "all";
const verdictQueue = [];

function emailVerdict(record, poolKey) {
  if (verdictSend) verdictQueue.push({ record, poolKey });
}

// ── THE CUSTOMER GUIDE REPLY (Junid, 25 Oct 2026) ───────────────────────────
// Queued only by noteStrangerPayment, after it FRESHLY wrote an unknown-bank
// record, and only when guideReplyEligibility says it is a real person's
// proof from their own mailbox (guideReplyCore.mjs). Sent after the verdict
// emails, once the mailbox is closed. Changes no record and no decision.
let guideReplyOn = false;
let guideNever = [];
let guideDb = null;
const guideQueue = [];

function queueGuideReply({ record, poolKey, parsed }) {
  // Isolated: nothing here may throw into noteStrangerPayment, or the message
  // would stop flowing on to the card path. (Sonnet architect review.)
  try {
    if (!verdictSend || !guideReplyOn) return;
    const fromAddress = parsed.from?.value?.[0]?.address || null;
    const verdict = guideReplyEligibility({
      record, fromAddress, headerLines: parsed.headerLines, attachments: parsed.attachments, never: guideNever,
    });
    if (!verdict.ok) { console.log(`  · EFT: no customer guide reply (${verdict.why})`); return; }
    guideQueue.push({ to: verdict.to, inReplyTo: parsed.messageId || null, poolKey });
  } catch (err) {
    console.warn(`  ⚠ EFT customer guide reply not considered (${err?.message || err}) — the record stands`);
  }
}

async function sendGuideReplies() {
  // Isolated: this runs in the tick's finally, before the heartbeat.
  try {
    if (!verdictSend || !guideDb || !guideQueue.length) return;
    const out = await drainGuideReplies({
      queue: guideQueue.splice(0),
      send: verdictSend,
      // The path claimed is the path released — a send that fails across
      // SAST midnight must free the slot it took, not the next day's.
      claim: async ({ to, poolKey }) => {
        const now = serverNowMs();
        const path = guideClaimPath(to, now);
        const res = await guideDb.ref(path).transaction(guideClaimStep({ at: now, poolKey }));
        return res?.committed ? path : null;
      },
      countToday: async () => !!(await guideDb.ref(guideCountPath(serverNowMs())).transaction(guideCountStep()))?.committed,
      release: (path) => guideDb.ref(path).remove(),
    });
    // The log never names the customer's address.
    if (out.sent) console.log(`  · EFT: customer guide reply sent (${out.sent}) — how to resend the proof from the banking app`);
    if (out.limited) console.log(`  · EFT: customer guide reply skipped (${out.limited}) — that sender was already answered today`);
    if (out.capped) console.log(`  · EFT: customer guide reply skipped (${out.capped}) — past this tick's ceiling`);
    if (out.dayCapped) console.log(`  · EFT: customer guide reply skipped (${out.dayCapped}) — past today's ceiling`);
    if (out.error) console.warn(`  ⚠ EFT customer guide reply NOT sent (${out.error}) — ${out.unsent} dropped; the pool records stand`);
  } catch (err) {
    console.warn(`  ⚠ EFT customer guide replies failed this tick (${err?.message || err}) — the pool records stand`);
  }
}

async function sendVerdicts() {
  try { await sendVerdictEmails(); } finally { await sendGuideReplies(); }
}

async function sendVerdictEmails() {
  if (!verdictSend || !verdictQueue.length) return;
  const out = await drainVerdictEmails({ queue: verdictQueue.splice(0), mode: verdictMode, send: verdictSend, from: verdictFrom });
  // The log names the verdict and the check, never the amount.
  for (const m of out.sent) console.log(`  · EFT verdict email sent to Junid: ${m.verdict}${m.check ? ` (${m.check})` : ""}`);
  if (out.rolledUp) console.log(`  · EFT verdict email sent to Junid: ${out.rolledUp} more unknown-bank / forgery verdict(s) in one roll-up`);
  if (out.error) console.warn(`  ⚠ EFT verdict email NOT sent (${out.error}) — ${out.unsent} email(s) this tick dropped; the pool records stand, only the emails are lost`);
}

async function handleEftMessage({ client, range, db, parsed, message, cfg, uid, uidValidity, size }) {
  // mailparser can fail to resolve a From ADDRESS a human would read fine; the
  // raw header text is the fallback so a bank-claiming message with an odd
  // From still gets examined (and refused visibly) rather than silently filed
  // as ordinary mail. (Independent adversarial review.)
  const fromAddress = parsed.from?.value?.[0]?.address
    || /<([^<>\s]+@[^<>\s]+)>/.exec(message.from || "")?.[1]
    || null;
  const route = eftMessageRoute({ fromAddress, subject: message.subject });
  // A batch report is the slip path's, always. A stranger gets the
  // visibility-only path below — never a reader, never an opened attachment.
  if (route === "card") return null;
  const fromDomain = domainOfAddress(fromAddress);
  if (route === "stranger") {
    // NOTE it, then HAND IT BACK. Returning a result here would consume the
    // message, and a stranger's message is not this reader's to consume: a
    // batch report forwarded from someone's own address with an edited subject
    // is a stranger too, and swallowing it would lose the slip inside —
    // silently, which is the failure this whole change is about. The row is
    // written; the message carries on down the ordinary route exactly as it
    // did before, and the card path claims and reads it as usual.
    await noteStrangerPayment({ db, parsed, message, cfg, uid, uidValidity, size, fromDomain });
    return null;
  }

  const empty = { processed: false, recorded: 0, refused: 0, unrelated: 0, eftRecorded: 0, eftRefusedAuth: 0, eftRefusedParse: 0, eftRefusedAccount: 0, eftRefusedTiming: 0, eftRefusedStale: 0, eftHeld: 0 };
  // FIX 8 — NO CUTOFF, NO DECISION. A bank notification is never judged, let
  // alone claimed, while EFT_PAYMENT_DATE_CUTOFF is unreadable: the throw is
  // caught by the caller, the message stays unread, eftErrors counts it, and
  // the next tick after the line is fixed reads it as if it had just arrived.
  // (A bank-domain message that turns out to carry batch SLIPS waits with
  // them — it is only routed to the card path further down — and is read the
  // same way once the line is fixed; nothing is lost.)
  if (!cfg.eftPaymentDateCutoff.ok) {
    throw new Error(`${cfg.eftPaymentDateCutoff.reason} Fix ${EFT_CUTOFF_ENV_VAR} in ${cfg.eftPaymentDateCutoffSource}`);
  }
  const verdict = authenticationVerdict({ headerLines: parsed.headerLines, fromAddress });
  // The auth verdict is part of the key so a forgery carrying a guessed genuine
  // Message-ID cannot occupy the key the genuine notification will need.
  const key = eftMessageKey({
    messageId: parsed.messageId, from: message.from, subject: message.subject,
    date: message.receivedAt, size, uid, uidValidity, authPass: verdict.pass,
  });


  // ── CONTENT INSPECTION, BEFORE ANY CLAIM ───────────────────────────────────
  // Only an AUTHENTICATED message earns PDF rendering — a forgery's
  // attachments are attacker files and are not opened; its refusal record
  // carries the body text.
  const bodyText = (parsed.text || "").trim() || htmlToText(parsed.html || "");
  const documents = []; // { lines: string[]|null, text: string }
  let slipPdfs = 0;
  // ── AN AUTH-FAILED MESSAGE WITH ATTACHMENTS IS NOT CONSUMED ────────────────
  // Its PDFs are never opened HERE (attacker files; the capture callable
  // opens them server-side with its own hardening), so their content cannot
  // be routed — and consuming the message would eat a GENUINE batch report
  // whose delivery path broke its DKIM (a forward, a relay). It falls through
  // to the slip path, whose callable validates every byte; a forged "slip"
  // refuses harmlessly there, a real one is captured.
  //
  // BUT THE FORGERY ATTEMPT IS STILL RECORDED FIRST — attaching one PDF must
  // not silence the forgery alarm. The pool record (body text only, no claim
  // needed: the create-only transaction on the auth-fail key is the dedupe)
  // is written before the hand-off; the slip path then owns claim and \Seen.
  // (Delta review, v2.)
  if (!verdict.pass && (parsed.attachments || []).some((a) => { try { return classifyAttachment(a).ok; } catch { return false; } })) {
    if (!cfg.dryRun) {
      const forgery = eftPoolRecord({ message, verdict, parsed: null, account: null, reader: null, rawText: bodyText, at: serverNowMs() });
      let d = null;
      await db.ref(`${EFT_POOL_PATH}/${key}`).transaction(createOnlyStep(forgery, (x) => { d = x; }));
      if (d?.write) {
        console.log(`  · EFT: refused-auth recorded (message also carries attachments — handed to the slip path)`);
        emailVerdict(forgery, key);
      }
    }
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
      // THE OLD LINE GROUPING, on purpose — the EFT readers were built against
      // it. See the note on bucketLines in functions/cardRecon/pdfText.js.
      const out = await pdfToLines(att.content, { grouping: "bucket" });
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
    if (slipPdfs > 0 && !documents.some((d) => d.lines)) {
      // Every READABLE document was a slip (placeholders for corrupt or
      // oversized attachments do not count — a real slip must not be kept out
      // of the card path by a broken sibling). This whole message is the card
      // path's. (Delta review, v2.)
      return null;
    }

  }

  if (cfg.dryRun) {
    console.log(`  · would examine as an EFT notification (auth ${verdict.pass ? "pass" : "FAIL"}, ${documents.length} document(s)): "${message.logSubject}"`);
    return empty;
  }

  const claim = await claimMessage(db, key);
  if (!claim.taken) {
    console.log(`  · EFT "${message.logSubject}" — ${claim.why}`);
    // done = the outcome is recorded, the message may be marked read and
    // never downloaded again. NOT done = a run (possibly dead) still holds it
    // — it must stay visible to the rescue tick.
    if (claim.done) await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch(() => {});
    return { ...empty, done: claim.done === true };
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
    // A DETERMINISTIC child, not a push id: the claim this sits behind is
    // merely "claimed" until the pool write lands, and a crash between the
    // two retries this whole block — a push would file the same loss twice.
    // (Delta review, v2.)
    await db.ref(`${INTAKE_PATH}/eftslip-${key}`).set(slipLoss).catch((err) => {
      console.warn(`  ⚠ could not record the uncaptured slip in the intake feed (${err.message})`);
    });
    console.warn(`  ⚠ "${message.logSubject}" carries ${slipPdfs} batch-slip PDF(s) alongside other documents — refusal row written to the slip feed`);
  }

  // ── WHICH BANK'S DOCUMENT IS THIS — AND HOW MANY PAYMENTS IS IT? ───────────
  // Every extracted document is offered to the readers, then the body itself
  // (a bank that prints its fields in the email body is read there). Standard
  // Bank BATCHES payments — one email, several PaymentConfirmation PDFs, each
  // one payment — so a message is not "a payment": it is a LIST of them.
  // groupEftPayments (eftCore, pure, tested) turns the claimed documents into
  // distinct payments: identical parses are one payment printed twice (a
  // reprint, or the same figures in body and PDF — the bank's own transaction
  // id anchors the identity), different parses are different payments, and an
  // unparseable document is its own refusal. Each gets ITS OWN pool record
  // under its own deterministic key (eftPaymentKey); a single-payment message
  // keeps the message key itself, so every record written before batching
  // existed is still where a replay looks for it.
  //
  // Recognised by nobody stays what it was: one refusal whose raw text and
  // named domain are the work order for the missing reader.
  const outcomes = []; // { poolKey, record }
  const at = serverNowMs();
  if (!verdict.pass) {
    outcomes.push({
      poolKey: key,
      record: eftPoolRecord({ message, verdict, parsed: null, account: null, reader: null, rawText: bodyText, at }),
    });
  } else {
    const bodyLines = bodyText ? bodyText.split("\n") : [];
    const offered = [...documents.filter((d) => d.lines), { lines: bodyLines, text: bodyText }];
    const claimed = offered
      .map((d) => ({ d, r: selectReader({ fromDomain, lines: d.lines }) }))
      .filter((x) => x.r);
    if (claimed.length >= 1) {
      const parsedDocs = claimed.map((x) => ({ ...x, p: x.r.parse(x.d.lines) }));
      // ── AN UNREADABLE SIBLING IS A REFUSAL ROW, NEVER SILENCE ──────────────
      // Placeholder documents (lines: null — a corrupt or password-protected
      // PDF, or one past MAX_EFT_PDFS) cannot be offered to a reader, and
      // before this guard they simply fell out of `offered` — so a batched
      // message with three readable payments and one broken PDF recorded
      // three, marked the message done, and the fourth was lost with nothing
      // to show it ever existed. Each unreadable document now refuses
      // alongside its readable siblings: the payment may be inside it, and a
      // red row a person can chase beats a silence nobody can.
      // (CodeRabbit, this PR.)
      for (const d of documents.filter((x) => x.lines === null)) {
        parsedDocs.push({
          d, r: null,
          p: { ok: false, reason: `An attachment on this message could not be read — a payment may be inside it. ${clip(d.text, 200)}` },
        });
      }
      const groups = groupEftPayments(parsedDocs);
      for (const group of groups) {
        // FIX 7a — paid into the shop's own FNB account: bank AND every
        // printed digit. FIX 7b — an immediate payment, not a scheduled or
        // normal-clearing one. Both refuse rather than guess.
        const account = group.parse.ok
          ? destinationVerdict({
            accountMask: group.parse.accountMask, destBankName: group.parse.destBankName,
            allowedAccounts: cfg.eftAccounts, configured: cfg.eftAccountsConfigured,
          })
          : null;
        const timing = group.parse.ok
          ? immediacyVerdict({ parsed: group.parse, reader: group.readerId, receivedAt: message.receivedAt })
          : null;
        // FIX 8 — dated on or after the cutoff BY THE BANK (group.parse.bankTs,
        // the bank's own printed payment date). message.receivedAt is
        // deliberately not passed: the mailbox's clock is never the payment's.
        const dated = group.parse.ok
          ? paymentDateVerdict({ parsed: group.parse, cutoff: cfg.eftPaymentDateCutoff })
          : null;
        outcomes.push({
          poolKey: eftPaymentKey(key, group, groups.length),
          record: eftPoolRecord({
            message, verdict, parsed: group.parse, account, timing, dated,
            reader: group.readerId, rawText: group.rawText, at,
          }),
        });
      }
    } else {
      // NOBODY RECOGNISES IT. If it is payment-shaped at all, the refusal is
      // the work order for the missing reader. If not — a statement, a fraud
      // alert, bank marketing — recording it would fill the owner's refusal
      // feed with red rows about newsletters, and red must keep meaning
      // something. Ordinary mail: ledger done, marked read, nothing written.
      // (Independent adversarial review, v2.)
      const everything = [...documents.map((d) => d.text), bodyText].filter(Boolean).join("\n────────\n");
      // AN UNREADABLE ATTACHMENT FORCES THE GATE OPEN: a password-protected
      // or corrupt PDF on a bank message is exactly where a payment hides,
      // and its body ("please see the attached document") carries no cue.
      // Silence here would be an unrecoverable loss. (Delta review, v2.)
      const unreadable = documents.some((d) => d.lines === null);
      if (!unreadable && !looksPaymentShaped(`${message.subject || ""}\n${everything}`)) {
        console.log(`  · bank mail, not payment-shaped: "${message.logSubject}" — marked read, nothing recorded`);
        // The claim is settled (not abandoned to go stale), THEN the flag.
        await db.ref(`${SEEN_PATH}/${key}`).set({ state: "done", at: serverNowMs(), eft: true });
        await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch(() => {});
        return { ...empty, done: true };
      }
      outcomes.push({
        poolKey: key,
        record: eftPoolRecord({
          message, verdict, parsed: { ok: false, reason: noReaderReason(fromDomain) },
          account: null, reader: null, rawText: everything, at,
        }),
      });
    }
  }

  // ── ONE CREATE-ONLY WRITE PER PAYMENT ────────────────────────────────────
  // Each record lands under its own key; a crash mid-list leaves the claim
  // "claimed", the next tick retries the whole message, and every record
  // already written aborts its transaction — never doubled, never reset.
  const written = [];
  const writtenKeys = [];
  for (const { poolKey, record: candidate } of outcomes) {
    // FIX 1 — THE BANK'S TRANSACTION ID, NOT THE EMAIL, DECIDES WHETHER THIS
    // IS NEW MONEY. Claim the fingerprint for this record (create-only) BEFORE
    // the pool write; a resend finds the original's claim and is held. A crash
    // between the two is harmless: the retry derives the same pool key, finds
    // its own claim, and lands on the same record.
    let record = candidate;
    if (candidate.outcome === "recorded") {
      // syntheticRef (29 Oct 2026): an Absa notice with no transaction number
      // identifies itself by payer + account + day + amount + reference and
      // is claimed the same way; a second claim is held-possible-duplicate.
      const fingerprint = paymentFingerprint({ reader: candidate.reader, bankRef: candidate.bankRef, syntheticRef: candidate.syntheticRef });
      let holder = null, manualApproved = false;
      if (fingerprint) {
        await db.ref(`${EFT_FINGERPRINT_PATH}/${fingerprint}`)
          .transaction(fingerprintClaimStep(poolKey, serverNowMs(), (d) => { holder = d.holder; manualApproved = d.manualApproved === true; }));
      }
      record = applyFingerprintHold(candidate, { fingerprint, holder, poolKey, manualApproved });
    } else {
      // A refusal claims its transaction id too (eftCore refusalFingerprint):
      // a copy resent once the reason no longer applies is held, not fresh.
      const fingerprint = refusalFingerprint(candidate);
      if (fingerprint) {
        let holder = null;
        await db.ref(`${EFT_FINGERPRINT_PATH}/${fingerprint}`)
          .transaction(fingerprintClaimStep(poolKey, serverNowMs(), (d) => { holder = d.holder; }));
        record = applyRefusalFingerprint(candidate, { fingerprint, holder, poolKey });
      }
    }
    let decision = null;
    // createOnlyStep: undefined = abort, keep what is there.
    await db.ref(`${EFT_POOL_PATH}/${poolKey}`).transaction(createOnlyStep(record, (d) => { decision = d; }));
    if (decision?.write) { written.push(record); writtenKeys.push(poolKey); }
  }
  // The claim flips to done AFTER the pool writes. A crash between costs a
  // stale-claim delay; the create-only transactions make the retry land on
  // the existing records instead of doubling them.
  await db.ref(`${SEEN_PATH}/${key}`).set({ state: "done", at: serverNowMs(), eft: true, payments: outcomes.length });
  // Last, and deliberately: a message is only marked read once its outcome is
  // in the database.
  await client.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch((err) => {
    console.warn(`  ⚠ could not mark "${message.logSubject}" read (${err.message}) — the claim still stops it landing twice`);
  });

  // A REPLAY REPORTS NOTHING. Records written by an earlier run are counted by
  // that run; saying "recorded" again makes a no-op look like a payment.
  // (Independent adversarial review.)
  if (!written.length) {
    console.log(`  · EFT "${message.logSubject}" — every record for this message already exists`);
    return { ...empty, done: true };
  }
  for (const record of written) {
    const label = record.outcome === "recorded"
      ? `payment recorded (status unmatched, ${record.reader} reader)`
      : `${record.outcome} — ${record.reason}`;
    console.log(`  · EFT: ${label}`);
  }
  if (outcomes.length > 1) {
    console.log(`  · EFT: ${outcomes.length} payment document(s) on one message — each recorded separately`);
  }
  for (let i = 0; i < written.length; i++) emailVerdict(written[i], writtenKeys[i]);
  const count = (o) => written.filter((r) => r.outcome === o).length;
  return {
    // processed feeds the "N with slips" line and the heartbeat's slip count —
    // an EFT message is not slip work and must not inflate it; the EFT
    // tallies are its whole story.
    ...empty,
    done: true,
    eftRecorded: count("recorded"),
    eftRefusedAuth: count("refused-auth"),
    eftRefusedParse: count("refused-parse"),
    eftRefusedAccount: count("refused-account"),
    eftRefusedTiming: count("refused-not-immediate"),
    eftRefusedStale: count("refused-stale-date"),
    eftHeld: written.filter((r) => HELD_OUTCOMES.includes(r.outcome)).length,
  };
}

// ─── A BANK THE POOL IS NOT SET UP FOR ───────────────────────────────────────
// The message is from a domain that is not on the allowlist. Everything this
// does is deliberately less than the bank path does:
//
//   NOTHING IS AUTHENTICATED. Authentication answers "is this really the bank
//   it claims to be?", and this sender claims to be a bank we do not know. A
//   verdict here would file a bank the owner has simply not set up alongside
//   forgery attempts, which are a different thing entirely.
//
//   NO ATTACHMENT IS OPENED. Rendering a PDF from an unauthenticated stranger
//   is the one thing this poller has always refused to do, and being curious
//   about the sender does not change that. Only the attachment NAMES are read,
//   off the envelope, which is where a bank puts the word "payment".
//
//   NOTHING IS PARSED. No reader is offered the document, so no amount, no
//   reference and no account can reach the record. It cannot be settled
//   against, by construction — there is nothing to settle.
//
//   NOTHING IS CONSUMED. The message is not claimed and not marked read: it
//   goes on down the ordinary route, so a batch report that happens to reach us
//   from an unexpected address is still captured by the card path. Recording a
//   sighting must never cost the thing sighted.
//
// What is left is one visible row naming the domain, which is the whole point:
// a bank paying the shop that nobody has set up used to be ordinary mail, seen
// by no one.
let unknownBankThisRun = 0;

async function noteStrangerPayment({ db, parsed, message, cfg, uid, uidValidity, size, fromDomain }) {
  const bodyText = (parsed.text || "").trim() || htmlToText(parsed.html || "");
  const attachmentNames = (parsed.attachments || []).map((a) => a?.filename || "").filter(Boolean);
  if (!looksLikeStrangerPayment({ subject: message.subject, bodyText, attachmentNames })) return;

  // The key carries authPass:false — the same shape a refused record uses — and
  // is derived from the message, so the next tick computes the same key and the
  // create-only write below finds the record already there. That is the only
  // dedupe this path needs: it claims nothing.
  const key = eftMessageKey({
    messageId: parsed.messageId, from: message.from, subject: message.subject,
    date: message.receivedAt, size, uid, uidValidity, authPass: false,
  });
  const record = unknownBankRecord({
    message, fromDomain,
    // The BODY only. The attachment names are named in the text so the row can
    // be recognised without anything being opened.
    rawText: [bodyText, attachmentNames.length ? `Attachments (not opened): ${attachmentNames.join(", ")}` : ""].filter(Boolean).join("\n────────\n"),
    at: serverNowMs(),
  });

  if (cfg.dryRun) {
    console.log(`  · EFT (dry run): would note unknown-bank mail from ${fromDomain} — "${message.logSubject}"`);
    unknownBankThisRun += 1;
    return;
  }
  // createOnlyStep, never poolWriteDecision itself: the wrapper used to be
  // RETURNED to the transaction, storing {write,value} as the row and
  // overwriting an existing record (a refusal — evidence) with {write:false}.
  let decision = null;
  await db.ref(`${EFT_POOL_PATH}/${key}`).transaction(createOnlyStep(record, (d) => { decision = d; }));
  if (!decision?.write) return;   // an earlier tick already noted it — and that row is untouched
  unknownBankThisRun += 1;
  console.log(`  · EFT: unknown-bank — payment-shaped mail from ${fromDomain}, which is not a bank this pool knows. Nothing was read from it.`);
  emailVerdict(record, key);
  queueGuideReply({ record, poolKey: key, parsed });
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
