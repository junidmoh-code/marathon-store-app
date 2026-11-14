#!/usr/bin/env node
// ── TIKTOK POSTER (Mac mini), 14 Nov 2026 ────────────────────────────────────
// Posts Marathon Club's existing Instagram/Facebook content to TikTok
// (@marathon.club7), through Signal Studio's local poster on this machine
// (~/marathon-photo-service, src/social/local.ts): Signal Studio owns the
// TikTok app keys and the verified URL prefix TikTok pulls media from.
//
//   node scripts/social/tiktok-poster.mjs --slot        launchd 08:30 / 18:30: 3 posts, 15-20 min apart
//   node scripts/social/tiktok-poster.mjs --kickoff 3   N posts now, 3 minutes apart
//   node scripts/social/tiktok-poster.mjs --dry-run     queue counts and the next picks; posts nothing
//   node scripts/social/tiktok-poster.mjs --status      Signal Studio connection + ledger counts
//
// READS RTDB ONLY (social_posts). It writes nothing to any Marathon system and
// never touches Instagram or Facebook. Its memory is the ledger,
// ~/.marathon-tiktok/ledger.json (outside the repo, so a reset never wipes it):
//
//   sending  → written BEFORE the post call: if we die mid-call, the family is
//              never tried again (it may be live; "never repost" wins)
//   sent     → TikTok accepted it (publish id); status polled until it settles
//   live     → PUBLISH_COMPLETE
//   failed   → TikTok said FAILED, or the call had no clear answer (unknown)
//   refused  → TikTok refused before creating anything; tried again on a later
//              run, at most MAX_ATTEMPTS times
//
// Not connected, Signal Studio down, token missing: one log line and exit 0.
// Nothing here ever blocks anything else. Failures show in Signal Studio's
// daily report (its "TikTok local poster" line) and in logs/tiktok-poster.log.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminRequire } from "../adminRequire.mjs";
import {
  PER_SLOT, PHOTO_MAX_H, PHOTO_MAX_W, VIDEO_MAX_S, VIDEO_MIN_S, backoff, buildQueue, counts, pickNext, slotGap, tiktokText,
} from "./tiktokQueue.mjs";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const STATUS = args.includes("--status");
const SLOT = args.includes("--slot");
const kickIdx = args.indexOf("--kickoff");
const KICKOFF = kickIdx === -1 ? 0 : Math.max(1, Math.min(10, Number(args[kickIdx + 1]) || 3));

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "..", "..", "logs", "tiktok-poster.log");
const STATE_DIR = process.env.TIKTOK_POSTER_STATE || join(homedir(), ".marathon-tiktok");
const LEDGER = join(STATE_DIR, "ledger.json");
const LOCK = join(STATE_DIR, "run.lock");
const BASE = `http://127.0.0.1:${process.env.SIGNAL_LOCAL_POST_PORT || 8796}`;
const FFPROBE = existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });
function log(line) {
  console.log(line);
  if (DRY) return;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    try { if (statSync(LOG).size > 512 * 1024) renameSync(LOG, `${LOG}.1`); } catch { /* none yet */ }
    appendFileSync(LOG, `${stamp()}  ${line}\n`);
  } catch { /* logging never stops a run */ }
}

/** SIGNAL_LOCAL_POST_TOKEN from the environment or ~/.env (the file Signal Studio reads). Never logged. */
function token() {
  if (process.env.SIGNAL_LOCAL_POST_TOKEN) return process.env.SIGNAL_LOCAL_POST_TOKEN;
  try {
    const m = /^\s*(?:export\s+)?SIGNAL_LOCAL_POST_TOKEN\s*=\s*["']?([^"'\s#]+)/m.exec(readFileSync(join(homedir(), ".env"), "utf8"));
    return m ? m[1] : null;
  } catch { return null; }
}

function readLedger() {
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return { families: {}, last: null }; }
}
function saveLedger(l) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${LEDGER}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 1));
  renameSync(tmp, LEDGER);
}

/** One run at a time. A lock older than 2 hours is a crashed run. */
function lock() {
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 2 * 3600000) rmSync(LOCK);
    writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    return true;
  } catch { return false; }
}
const unlock = () => { try { rmSync(LOCK); } catch { /* gone */ } };

async function local(path, { method = "GET", body, type } = {}) {
  const t = token();
  const res = await fetch(`${BASE}${path}`, {
    method, body, headers: { authorization: `Bearer ${t}`, ...(type ? { "content-type": type } : {}) }, signal: AbortSignal.timeout(180000),
  });
  let json = null;
  try { json = await res.json(); } catch { json = { error: `HTTP ${res.status}` }; }
  return { status: res.status, json };
}

/** Network or 5xx from our own server: worth a few tries with backoff. Never used for the post call itself. */
async function retrying(what, fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fn();
      if (r.status < 500 || i === tries - 1) return r;
      log(`  ${what}: HTTP ${r.status}, retrying`);
    } catch (e) {
      if (i === tries - 1) throw e;
      log(`  ${what}: ${e.message}, retrying`);
    }
    await sleep(backoff(i));
  }
}

async function download(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === 3) throw new Error(`download failed: ${e.message}`);
      await sleep(backoff(i));
    }
  }
}

/** JPEG within 1080x1920, whatever came in (PNG, WebP, oversize). */
async function photoBytes(buf) {
  const sharp = adminRequire(import.meta.url)("sharp");
  return sharp(buf).rotate().resize(PHOTO_MAX_W, PHOTO_MAX_H, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
}

/** An MP4 TikTok will take: 3-600 s, H.264. Anything else is refused here rather than at TikTok. */
function checkVideo(buf) {
  const f = join(tmpdir(), `tiktok-probe-${process.pid}.mp4`);
  writeFileSync(f, buf);
  try {
    const j = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f]).toString());
    const v = (j.streams || []).find((s) => s.codec_type === "video");
    const dur = Number(j.format?.duration);
    if (!v) return "no video stream";
    if (!/mp4|mov/.test(j.format?.format_name || "")) return `not an MP4 (${j.format?.format_name})`;
    if (!(dur >= VIDEO_MIN_S && dur <= VIDEO_MAX_S)) return `duration ${dur}s outside ${VIDEO_MIN_S}-${VIDEO_MAX_S}s`;
    if (!["h264", "hevc"].includes(v.codec_name)) return `codec ${v.codec_name}`;
    return null;
  } finally { rmSync(f, { force: true }); }
}

/** Poll a publish id until it settles or ~3 minutes pass; updates the ledger entry in place. */
async function settle(entry, ledger) {
  for (let i = 0; i < 18; i++) {
    let r;
    try { r = await local(`/tiktok/post-status?publishId=${encodeURIComponent(entry.publishId)}`); } catch (e) { r = { status: 0, json: { error: e.message } }; }
    if (r.status === 200) {
      const s = r.json.status;
      entry.status = s;
      if (s === "PUBLISH_COMPLETE" || s === "SEND_TO_USER_INBOX") { entry.state = "live"; entry.postId = r.json.postId || null; entry.url = r.json.url || null; entry.at = Date.now(); saveLedger(ledger); return entry; }
      if (s === "FAILED") { entry.state = "failed"; entry.lastError = `TikTok FAILED: ${r.json.failReason || "no reason"}`; entry.at = Date.now(); saveLedger(ledger); return entry; }
    }
    await sleep(Math.min(20000, 5000 + i * 1000));
  }
  saveLedger(ledger);
  return entry; // still processing: the next run looks again
}

async function postOne(c, ledger) {
  const fam = ledger.families;
  const prev = fam[c.key] || {};
  const entry = { state: "sending", media: c.media, ids: c.ids, attempts: (prev.attempts || 0) + 1, at: Date.now() };
  const { title, description } = tiktokText(c);
  // Prepare everything that can fail without touching TikTok first.
  const files = [];
  try {
    for (const url of c.urls) {
      const raw = await download(url);
      let bytes = raw;
      if (c.media === "PHOTO") bytes = await photoBytes(raw);
      else { const bad = checkVideo(raw); if (bad) throw new Error(`video not usable: ${bad}`); }
      const up = await retrying("upload", () => local(`/tiktok/media?type=${c.media === "PHOTO" ? "jpg" : "mp4"}`, { method: "POST", body: bytes, type: "application/octet-stream" }));
      if (up.status !== 200) throw new Error(`upload refused: ${up.json?.error || up.status}`);
      files.push(up.json.name);
    }
  } catch (e) {
    fam[c.key] = { ...entry, state: "refused", lastError: e.message.slice(0, 200) };
    saveLedger(ledger);
    log(`FAILED ${c.key} ${c.media}: ${e.message} (attempt ${entry.attempts}, nothing sent to TikTok)`);
    return null;
  }
  fam[c.key] = entry;
  saveLedger(ledger); // "sending" is on disk before the one call that can create a post
  let r;
  try {
    r = await local("/tiktok/post", { method: "POST", type: "application/json", body: JSON.stringify({ media: c.media, files, title, description, isAigc: c.isAigc, brandOrganic: true }) });
  } catch (e) {
    fam[c.key] = { ...entry, state: "failed", lastError: `outcome unknown: ${e.message}`.slice(0, 200) };
    saveLedger(ledger);
    log(`FAILED ${c.key} ${c.media}: outcome unknown (${e.message}); never retried, check TikTok`);
    return null;
  }
  if (r.status !== 200) {
    const unknown = r.json?.kind === "unknown" || r.status >= 500 && r.json?.kind !== "transient";
    fam[c.key] = { ...entry, state: unknown ? "failed" : "refused", lastError: String(r.json?.error || r.status).slice(0, 200) };
    saveLedger(ledger);
    log(`FAILED ${c.key} ${c.media}: ${r.json?.error || r.status}${unknown ? " (outcome unknown; never retried)" : ` (attempt ${entry.attempts}, created nothing)`}`);
    return null;
  }
  Object.assign(entry, { state: "sent", publishId: r.json.publishId, privacy: r.json.privacy, at: Date.now() });
  fam[c.key] = entry;
  ledger.last = { media: c.media, at: Date.now() };
  saveLedger(ledger);
  await settle(entry, ledger);
  log(`posted ${c.key} ${c.media} privacy=${entry.privacy} publish=${entry.publishId} status=${entry.status || "PROCESSING"}${entry.url ? ` ${entry.url}` : ""}`);
  return entry;
}

async function main() {
  const t = token();
  if (!t && !DRY) { log("TikTok: SIGNAL_LOCAL_POST_TOKEN is not in ~/.env; skipped"); return; }

  let st = null;
  if (t) {
    try { st = (await local("/tiktok/status")).json; } catch (e) { st = { connected: false, reason: `Signal Studio not reachable (${e.message})` }; }
  }

  const require = adminRequire(import.meta.url);
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const snap = await admin.database().ref("social_posts").orderByChild("status").equalTo("posted").once("value");
  const posts = Object.entries(snap.val() || {}).map(([id, p]) => ({ id, ...p }));
  const queue = buildQueue(posts);
  const ledger = readLedger();
  const n = counts(queue, ledger);
  const summary = `queue ${n.total} (${n.photos} photos, ${n.videos} videos): ${n.posted} live, ${n.pending} pending, ${n.failed} failed, ${n.waiting} waiting`;

  if (DRY || STATUS) {
    console.log(`Signal Studio: ${st ? JSON.stringify(st) : "no token"}`);
    console.log(summary);
    if (DRY) {
      const sim = JSON.parse(JSON.stringify(ledger)); let last = sim.last?.media;
      for (let i = 0; i < 6; i++) {
        const c = pickNext(queue, sim, last); if (!c) break;
        const { title, description } = tiktokText(c);
        console.log(`\nnext ${i + 1}: ${c.key} ${c.media} ${c.kind} aigc=${c.isAigc} ${c.urls.length} file(s)\n  title: ${title}\n  ${description.replace(/\n/g, "\n  ")}`);
        sim.families[c.key] = { state: "sent" }; last = c.media;
      }
    }
    return;
  }

  if (!st?.connected) {
    log(`TikTok: not connected in Signal Studio (${st?.reason || "unknown"}); skipped. ${summary}`);
    return;
  }
  if (!lock()) { log("TikTok: another run is in progress; skipped"); return; }
  try {
    // Anything left processing by an earlier run is settled first.
    for (const e of Object.values(ledger.families)) if (e.state === "sent" && e.publishId) await settle(e, ledger);
    const want = KICKOFF || (SLOT ? PER_SLOT : 1);
    const gap = () => (KICKOFF ? 3 * 60000 : slotGap());
    log(`TikTok run: ${want} post(s) as @${st.username} (${st.nickname}), privacy options ${JSON.stringify(st.privacyOptions)}; ${summary}`);
    let done = 0, tries = 0;
    while (done < want && tries < want + 3) {
      tries++;
      const c = pickNext(queue, ledger, ledger.last?.media);
      if (!c) { log("TikTok: queue is empty; nothing left to post"); break; }
      const r = await postOne(c, ledger);
      if (r) { done++; if (done < want) await sleep(gap()); }
    }
    log(`TikTok run done: ${done}/${want} posted. ${(() => { const m = counts(queue, ledger); return `${m.posted} live, ${m.pending} pending, ${m.failed} failed, ${m.waiting} waiting`; })()}`);
  } finally { unlock(); }
}

main().then(() => process.exit(0), (e) => { log(`TikTok run error: ${e?.stack || e}`); unlock(); process.exit(0); });
