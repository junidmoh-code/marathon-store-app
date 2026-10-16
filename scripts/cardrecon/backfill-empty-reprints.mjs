// ─── BACKFILL: EMPTY BATCHES RE-PRINTED ON A LATER DAY ───────────────────────
// Until 16 Oct 2026 a terminal that took no card and re-printed its last
// (empty) batch at the evening settlement was filed "already captured", so the
// day it reported R0.00 for had no record and Junid's Card Recon showed the till
// "awaiting a slip" while the store app showed it in. The capture path now
// records the first later-day copy as a later report of the batch
// (emptyReprintOpensAt in functions/lib/card-recon.cjs). This puts the copies
// already refused in the last 30 days through that same path.
//
// WHAT IT DOES, for each such message, OLDEST FIRST (each one's window starts
// where the previous one closed, so the order is the window):
//   1. reads the message's PDF from the shop mailbox — READ-ONLY, nothing is
//      flagged, moved or claimed;
//   2. sends it to the DEPLOYED cardBatchCapture callable on the email channel,
//      as the poller's own identity — extract, then submit — exactly as the
//      poller does. Nothing is written by this script itself: the server
//      decides, and refuses a copy that is not a later-day re-print.
//
// WHICH MESSAGES: /card_batch_intake rows from the last 30 days (the `at`
// index, never the node) whose attachment was refused "already captured", where
// the batch's report on file is a settled empty batch and the message arrived
// on a LATER SA day than that report closed. One per terminal, batch and day —
// the first copy; a second copy the same day is a re-send and stays one.
//
// IDEMPOTENT. A day already recorded is no longer "later" than the report on
// file, so a second run finds nothing for it. Run on the Mac mini: it needs the
// mailbox credentials in .env and the service-account key the poller uses.
//
//   node scripts/cardrecon/backfill-empty-reprints.mjs            # dry run
//   node scripts/cardrecon/backfill-empty-reprints.mjs --execute  # send them

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { adminRequire } from "../adminRequire.mjs";
import { parseEnvText } from "./intakeCore.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");

const EXECUTE = process.argv.includes("--execute");
const DAYS = 30;
const DAY_MS = 86400000;
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const CALLABLE_URL = "https://europe-west1-marathon-club.cloudfunctions.net/cardBatchCapture";
// The project's PUBLIC web API key — the same constant the poller uses.
const FIREBASE_WEB_API_KEY = "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo";
const MAX_REVISIONS = 20;

// .env lives in the checkout that holds the poller — this one, or (from a git
// worktree) the main checkout.
function envPath() {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (existsSync(join(here, ".env"))) return join(here, ".env");
  const common = execSync("git rev-parse --path-format=absolute --git-common-dir", { cwd: here, encoding: "utf8" }).trim();
  return join(common.replace(/\/\.git\/?$/, ""), ".env");
}
const env = parseEnvText(readFileSync(envPath(), "utf8"));

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club", databaseURL: DATABASE_URL });
const db = admin.database();
const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
const nowMs = Date.now() + offset;
const sastDay = (ms) => new Date(ms + 2 * 3600000).toISOString().slice(0, 10);

const terminals = (await db.ref("config/cardTerminals").once("value")).val() || {};

/** The report on file for a batch: its highest revision's slip (key probes, one leaf each). */
async function inForce(storeId, tid, batchNo) {
  let last = null;
  for (let rev = 1; rev <= MAX_REVISIONS; rev++) {
    const key = rev === 1 ? String(batchNo) : `${batchNo}-r${rev}`;
    if (!(await db.ref(`card_batches/${storeId}/${tid}/${key}/batchKey`).once("value")).exists()) break;
    last = key;
  }
  if (!last) return null;
  return { key: last, slip: (await db.ref(`card_batches/${storeId}/${tid}/${last}/slip`).once("value")).val() || {} };
}

async function candidates() {
  const snap = await db.ref("card_batch_intake").orderByChild("at").startAt(nowMs - DAYS * DAY_MS).once("value");
  const seen = new Set();
  const out = [];
  const rows = Object.entries(snap.val() || {})
    .map(([id, r]) => ({ id, r, at: Number(r?.receivedAt) || Number(r?.at) || 0 }))
    .sort((a, b) => a.at - b.at);
  for (const { id, r, at } of rows) {
    const atts = Array.isArray(r?.attachments) ? r.attachments : Object.values(r?.attachments || {});
    if (!atts.some((a) => a?.outcome === "refused" && /already captured/i.test(String(a.reason || "")))) continue;
    const m = /Batch\s+(\d+)\s+of\s+Terminal\s+([A-Za-z0-9]+)/i.exec(String(r.subject || ""));
    if (!m || !r.messageId) continue;
    const [, batchNo, tid] = m;
    const t = terminals[tid];
    if (!t) continue;
    const day = sastDay(at);
    const k = `${tid}/${batchNo}/${day}`;
    if (seen.has(k)) continue;
    const f = await inForce(t.storeId, tid, batchNo);
    if (!f || f.slip.windowSource !== "empty-batch" || f.slip.totalCents !== 0) continue;
    if (!(day > sastDay(f.slip.closedAt))) continue;
    seen.add(k);
    out.push({ id, at, day, tid, batchNo, label: t.label || tid, messageId: r.messageId, subject: r.subject, from: r.from || null, onFile: f.key });
  }
  return out;
}

const list = await candidates();
console.log(`${list.length} later-day re-print${list.length === 1 ? "" : "s"} of an empty batch in the last ${DAYS} days:`);
for (const c of list) console.log(`  ${c.day}  ${c.label} #${c.batchNo} (on file: ${c.onFile})  intake ${c.id}`);
if (!EXECUTE || !list.length) {
  if (!EXECUTE) console.log("\nDry run — nothing sent. Re-run with --execute.");
  process.exit(0);
}

// ── THE POLLER'S IDENTITY: a custom token, exchanged for an ID token ─────────
const pollerUid = String(env.CARD_RECON_POLLER_UID || "card-recon-email-poller").trim();
async function idToken() {
  const custom = await admin.auth().createCustomToken(pollerUid);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status})`);
  return (await res.json()).idToken;
}
async function call(token, data) {
  const res = await fetch(CALLABLE_URL, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }), signal: AbortSignal.timeout(300000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body.result;
}

const token = await idToken();
const client = new ImapFlow({
  host: String(env.CARD_RECON_IMAP_HOST || "imap.gmail.com").trim(), port: Number(env.CARD_RECON_IMAP_PORT || 993), secure: true,
  auth: { user: String(env.CARD_RECON_IMAP_USER).trim(), pass: String(env.CARD_RECON_IMAP_PASSWORD).replace(/\s+/g, "") },
  logger: false,
});
await client.connect();
const lock = await client.getMailboxLock(String(env.CARD_RECON_IMAP_MAILBOX || "INBOX").trim(), { readOnly: true });
let recorded = 0, refused = 0;
try {
  for (const c of list) {
    const uids = await client.search({ header: { "message-id": c.messageId } }, { uid: true });
    if (!uids.length) { console.log(`  ✗ ${c.day} ${c.label} #${c.batchNo}: message not found in the mailbox`); refused++; continue; }
    const { content } = await client.download(String(uids[0]), undefined, { uid: true });
    const chunks = [];
    for await (const ch of content) chunks.push(ch);
    const mail = await simpleParser(Buffer.concat(chunks));
    const pdf = mail.attachments.find((a) => /pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.filename || ""));
    if (!pdf) { console.log(`  ✗ ${c.day} ${c.label} #${c.batchNo}: no PDF on the message`); refused++; continue; }
    const extract = await call(token, {
      action: "extract", channel: "email", pdf: { base64: pdf.content.toString("base64") },
      intake: { messageId: c.messageId, from: c.from, subject: c.subject, filename: pdf.filename || null, receivedAt: c.at },
    });
    if (!extract?.ok) { console.log(`  ✗ ${c.day} ${c.label} #${c.batchNo}: ${extract?.reason}`); refused++; continue; }
    const submit = await call(token, { action: "submit", draftId: extract.draftId });
    if (!submit?.ok) { console.log(`  ✗ ${c.day} ${c.label} #${c.batchNo}: ${submit?.reason}`); refused++; continue; }
    console.log(`  ✓ ${c.day} ${c.label} #${c.batchNo} → recorded as ${submit.batchKey}`);
    recorded++;
  }
} finally {
  lock.release();
  await client.logout();
}
console.log(`\n${recorded} recorded, ${refused} not.`);
process.exit(refused ? 1 : 0);
