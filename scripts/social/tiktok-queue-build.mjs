#!/usr/bin/env node
// ── TIKTOK HANDOFF QUEUE: BATCH BUILDER (Mac mini) ───────────────────────────
// Builds the next batch of 3 TikTok posts for Junid's Claude chat to publish
// through Higgsfield (see docs/tiktok-queue.md and tiktokHfQueue.mjs).
//
//   node scripts/social/tiktok-queue-build.mjs            launchd 09:00 / 17:30 SAST (+ retries 5 and 10 min later)
//   node scripts/social/tiktok-queue-build.mjs --slot morning|evening [--date YYYY-MM-DD]
//   node scripts/social/tiktok-queue-build.mjs --force     rebuild a batch that already exists
//   node scripts/social/tiktok-queue-build.mjs --dry-run   print the picks; writes nothing
//
// READS RTDB (social_posts) and the Signal Studio poster's ledger. It writes
// only under ~/.marathon-tiktok-queue (TIKTOK_QUEUE_DIR):
//   media/<post_id>/<n>.jpg|mp4   TikTok-ready files (JPEG <= 1080x1920 <= 20 MB; MP4 H.264 3-600 s, 23-60 fps, >= 360 px)
//   batches/<date>-<slot>.json    one file per batch, never rewritten unless --force
//   latest.json                   the newest batch (the server adds posted/pending status)
//   rejects.json                  families whose media cannot be made to fit (never offered)
// posted.json and skipped.json belong to the server (one writer per file).
//
// It never posts anywhere: Signal Studio's own TikTok connection stays private
// until the audit passes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminRequire } from "../adminRequire.mjs";
import { buildQueue } from "./tiktokQueue.mjs";
import { toPhoto, toVideo } from "./tiktokQueueMedia.mjs";
import {
  BATCH_ID_RE, PER_BATCH, PHOTO_H, PHOTO_MAX_BYTES, PHOTO_MAX_ITEMS, PHOTO_W, POST_ID_RE, SLOT_NAMES, SLOT_READY,
  batchId, batchOrder, carryOver, isVertical, pickBatch, sast, slotFor, tiktokCaption, videoPlan,
} from "./tiktokHfQueue.mjs";

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i === -1 ? null : args[i + 1]; };
const DRY = args.includes("--dry-run");
const FORCE = args.includes("--force");

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "..", "..", "logs", "tiktok-queue.log");
const DIR = process.env.TIKTOK_QUEUE_DIR || join(homedir(), ".marathon-tiktok-queue");
const POSTER_LEDGER = join(process.env.TIKTOK_POSTER_STATE || join(homedir(), ".marathon-tiktok"), "ledger.json");
const PUBLIC_BASE = (process.env.TIKTOK_QUEUE_PUBLIC_BASE || "https://mac-mini-von-marathon-3.tail5a5180.ts.net/studio/tiktok-queue").replace(/\/+$/, "");

const PREP_BUDGET_MS = Number(process.env.TIKTOK_QUEUE_BUDGET_MS || 10 * 60000);
// launchd runs the build at :00/:30 and retries 5 and 10 minutes later (an existing batch is never rebuilt).
// The last try writes a short batch rather than none.
const LAST_TRY = args.includes("--last-try") || !!arg("--slot") || (() => { const t = sast().hhmm; return (t >= "09:10" && t < "13:00") || t >= "17:40"; })();
const HF_IMPORT_MAX_BYTES = 50 * 1024 * 1024; // Higgsfield media_import_url, the step before tiktok_prepare_publish


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

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw new Error(`${f} unreadable (${e.message}); not building`); } };
function writeJson(f, v) {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 1));
  renameSync(tmp, f);
}

async function download(url) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      last = new Error(`HTTP ${r.status}`); last.httpStatus = r.status;
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) break; // the file is gone
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
  }
  const err = new Error(`download failed: ${last?.message}`);
  err.gone = !!last?.httpStatus && last.httpStatus >= 400 && last.httpStatus < 500 && ![408, 429].includes(last.httpStatus);
  throw err;
}

/** Files for one post under media/<post_id>/ (reused when already there, e.g. a post rolled over). */
async function prepare(c) {
  if (!POST_ID_RE.test(c.key)) throw Object.assign(new Error(`post id ${c.key} is not URL-safe`), { gone: true });
  const dir = join(DIR, "media", c.key);
  const want = c.media === "VIDEO" ? ["1.mp4"] : c.urls.slice(0, PHOTO_MAX_ITEMS).map((_, i) => `${i + 1}.jpg`);
  if (want.every((f) => existsSync(join(dir, f)))) return want;
  if (DRY) return want;
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < want.length; i++) {
    const raw = await download(c.urls[i]);
    const dest = join(dir, want[i]);
    if (c.media === "VIDEO") {
      const why = toVideo(raw, `${dest}.part`);
      if (statSync(`${dest}.part`).size > HF_IMPORT_MAX_BYTES) { rmSync(`${dest}.part`, { force: true }); throw Object.assign(new Error("video over Higgsfield's 50 MB import limit"), { gone: true }); }
      renameSync(`${dest}.part`, dest);
      if (why) log(`  ${c.key}: re-encoded video (${why})`);
    } else {
      const tmp = `${dest}.part`;
      writeFileSync(tmp, await toPhoto(raw));
      renameSync(tmp, dest);
    }
  }
  return want;
}

/** { [post_id]: number of earlier batches it was offered in } */
function offeredCounts(before) {
  const n = {};
  for (const id of listBatches().filter((b) => batchOrder(b, before) < 0)) {
    for (const p of readJson(join(DIR, "batches", `${id}.json`), { posts: [] }).posts || []) n[p.post_id] = (n[p.post_id] || 0) + 1;
  }
  return n;
}

function listBatches() {
  try { return readdirSync(join(DIR, "batches")).map((f) => f.replace(/\.json$/, "")).filter((id) => BATCH_ID_RE.test(id)).sort(batchOrder); } catch { return []; }
}

async function main() {
  const slot = arg("--slot") || slotFor();
  if (!SLOT_NAMES.includes(slot)) throw new Error(`--slot must be morning or evening, not ${slot}`);
  const date = arg("--date") || sast().date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, not ${date}`);
  const id = batchId(date, slot);
  const file = join(DIR, "batches", `${id}.json`);
  if (existsSync(file) && !FORCE && !DRY) {
    // A crash between the batch write and the latest.json write is repaired here, without rebuilding media.
    const newest = listBatches().at(-1);
    if (newest === id && readJson(join(DIR, "latest.json"), {}).batch_id !== id) { writeJson(join(DIR, "latest.json"), readJson(file, null)); log(`TikTok queue: latest.json repaired to ${id}`); }
    else log(`TikTok queue: batch ${id} already built; kept (use --force to rebuild)`);
    return;
  }

  const admin = adminRequire(import.meta.url)("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const snap = await admin.database().ref("social_posts").once("value");
  const queue = buildQueue(Object.entries(snap.val() || {}).map(([k, p]) => ({ id: k, ...p })));

  const rejects = readJson(join(DIR, "rejects.json"), {});
  const state = {
    posted: readJson(join(DIR, "posted.json"), {}),
    skipped: readJson(join(DIR, "skipped.json"), {}),
    rejects,
    ledger: readJson(POSTER_LEDGER, { families: {} }),
    offered: offeredCounts(id),
  };

  // Rollover: the previous batch's posts Junid's chat did not confirm come first, same post_id.
  const prevId = listBatches().filter((b) => batchOrder(b, id) < 0).at(-1);
  const prev = prevId ? readJson(join(DIR, "batches", `${prevId}.json`), null) : null;
  const carry = carryOver(prev, queue, state);
  const carried = new Set(carry.map((c) => c.key));

  // Bounded: the batch must be ready within the slot's 15 minutes, and two transient failures in a row mean
  // Storage or the network is down for everyone, so the rest of the queue is not walked (a retry run follows).
  const deadline = Date.now() + PREP_BUDGET_MS;
  const posts = [];
  const transient = [];
  let inARow = 0;
  let outOfTime = false;
  for (const c of pickBatch(queue, state, Infinity, carry)) {
    if (posts.length >= PER_BATCH) break;
    if (inARow >= 2) { log("  two transient failures in a row: stopping this run"); break; }
    if (Date.now() > deadline) { outOfTime = true; log("  preparation budget used up: stopping this run"); break; }
    try {
      const files = await prepare(c);
      const { caption, hashtags } = tiktokCaption(c);
      posts.push({
        post_id: c.key,
        media_type: c.media,
        media_urls: files.map((f) => `${PUBLIC_BASE}/media/${c.key}/${f}`),
        caption,
        hashtags,
        slot,
        date,
        kind: c.kind,
        is_aigc: c.isAigc,
        offers_before: state.offered[c.key] || 0,
        rolled_over: carried.has(c.key),
      });
      inARow = 0;
    } catch (e) {
      if (e.gone) { rejects[c.key] = { at: new Date().toISOString(), reason: e.message }; log(`  ${c.key}: rejected (${e.message})`); }
      else { inARow++; transient.push(`${c.key}: ${e.message}`); log(`  ${c.key}: not ready this run (${e.message}); stays in the queue`); } // Storage or the network
    }
  }
  // Nothing written when the run fell short only because of an outage: the retry launch builds the full batch.
  if (posts.length < PER_BATCH && (transient.length || outOfTime) && !LAST_TRY) throw new Error(`batch ${id} short (${posts.length}/${PER_BATCH}) after ${outOfTime ? "running out of time" : "transient failures"}, left for the retry run (prepared media is kept): ${transient.slice(0, 3).join("; ")}`);
  if (!posts.length && transient.length) throw new Error(`no post could be prepared: ${transient.slice(0, 3).join("; ")}`);

  const batch = {
    batch_id: id, slot, date, ready_by: `${date} ${SLOT_READY[slot]} SAST`, generated_at: new Date().toISOString(),
    posts,
  };
  if (DRY) { console.log(JSON.stringify(batch, null, 1)); return; }
  writeJson(join(DIR, "rejects.json"), rejects);
  writeJson(file, batch);
  if (listBatches().at(-1) === id) writeJson(join(DIR, "latest.json"), batch);
  log(`TikTok queue: batch ${id} built with ${posts.length} post(s): ${posts.map((p) => `${p.post_id} ${p.media_type}`).join(", ") || "queue empty"}`);
}

main().then(() => process.exit(0), (e) => { log(`TikTok queue build FAILED: ${e.stack || e.message}`); process.exit(1); });
