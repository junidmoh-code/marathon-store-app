#!/usr/bin/env node
// ── Concrete house-style generator — the Mac mini queue worker ───────────────
// Picks up /concrete_house_style/{pid} rows with status "queued", generates a
// studio photo with Gemini image (subject = the product's own photo, style =
// Junid's reference library, + the house-style prompt), stores it at
// products/{pid}/concrete/house-<ts>.png and sets the row "awaiting_approval"
// with the measured cost. A failure retries once, then the row is "failed" and
// flagged. NEVER publishes, never touches /products, /shopify_publish or any
// Marathon photo. Approval happens in the app.
//
//   node scripts/concrete/house-style-worker.mjs           one pass, then exit
//   … --pids=p1,p2                                       only these (must be queued)
//   … --sample=p1,p2 --out=<dir>                          SAMPLE: generate for these products
//        and save the images to <dir> ONLY — no database write, no Storage write,
//        no Concrete mark required. For showing Junid what the style produces.
//
// launchd (com.marathon.concretestyle.plist) re-runs it every 30 s (KeepAlive +
// ThrottleInterval). A pass with nothing queued costs one small RTDB query.
// GEMINI_API_KEY is read from Secret Manager with the mini's gcloud (as
// scripts/social/lookbook-real.mjs does) or from the environment; never printed.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  HOUSE_STYLE_CONFIG_PATH, HOUSE_STYLE_JOBS_PATH, STATUS, MAX_ATTEMPTS,
  modelFor, subjectUrls, refsToSend, buildParts, afterFailure, money, isStaleRunning,
} from "../../src/utils/concreteHouseStyle.js";

const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
const { geminiGenerateImage, inlineImagePart, NBPRO_MODEL, NBPRO_OUT_PER_MTOK, NBPRO_FLAT_IMAGE_USD,
  GEMINI_MODEL, GEMINI_OUT_PER_MTOK, GEMINI_FLAT_IMAGE_USD } = fnRequire("./lib/gemini-image.cjs");

const PER_PASS = 4;
const pidsArg = process.argv.find((a) => a.startsWith("--pids="))?.split("=")[1]?.split(",").filter(Boolean) || null;

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
    storageBucket: "marathon-club.firebasestorage.app",
  });
}
const db = admin.database();
const bucket = admin.storage().bucket();
const log = (l) => console.log(`${new Date().toISOString()}  ${l}`);

async function serverNow() {
  const off = await new Promise((res) => {
    const t = setTimeout(() => res(0), 5000);
    db.ref(".info/serverTimeOffset").once("value", (s) => { clearTimeout(t); res(Number(s.val()) || 0); });
  });
  return Date.now() + off;
}

function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  for (const g of ["/opt/homebrew/bin/gcloud", "gcloud"]) {
    try {
      return execFileSync(g, ["secrets", "versions", "access", "latest", "--secret=GEMINI_API_KEY", "--project", "marathon-club"], { encoding: "utf8" }).trim();
    } catch { /* next */ }
  }
  throw new Error("GEMINI_API_KEY not available (env or Secret Manager)");
}

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: (res.headers.get("content-type") || "image/jpeg").split(";")[0] };
}

async function queued() {
  if (pidsArg) {
    const out = {};
    for (const pid of pidsArg) { const j = (await db.ref(`${HOUSE_STYLE_JOBS_PATH}/${pid}`).get()).val(); if (j?.status === STATUS.QUEUED) out[pid] = j; }
    return out;
  }
  try {
    return (await db.ref(HOUSE_STYLE_JOBS_PATH).orderByChild("status").equalTo(STATUS.QUEUED).limitToFirst(PER_PASS).get()).val() || {};
  } catch (e) {
    if (!/index not defined/i.test(String(e?.message || e))) throw e;
    // The .indexOn paste is pending: the node only holds Concrete products, so
    // one full read is small. Filter here.
    const all = (await db.ref(HOUSE_STYLE_JOBS_PATH).get()).val() || {};
    return Object.fromEntries(Object.entries(all).filter(([, j]) => j?.status === STATUS.QUEUED).slice(0, PER_PASS));
  }
}

/** queued → running, by transaction, so two workers can never take one job. */
async function claim(pid, now) {
  const res = await db.ref(`${HOUSE_STYLE_JOBS_PATH}/${pid}`).transaction((cur) => {
    if (cur === null) return null;                     // see clearMarker: never abort on the optimistic null pass
    if (cur.status !== STATUS.QUEUED) return undefined;
    return { ...cur, status: STATUS.RUNNING, startedAt: now, attempts: (Number(cur.attempts) || 0) + 1 };
  });
  return res.committed && res.snapshot.val()?.status === STATUS.RUNNING ? res.snapshot.val() : null;
}

async function generate(pid, job, cfg, key) {
  const product = (await db.ref(`products/${pid}`).get()).val();
  if (!product) throw new Error("product record is gone");
  if (product.listOnConcrete !== true) throw new Error("product is not marked for Concrete");
  const subjects = subjectUrls(product);
  if (!subjects.length) throw new Error("product has no photo to use as the subject");
  const subjectImgs = await Promise.all(subjects.map(fetchImage));
  const refImgs = [];
  for (const r of refsToSend(cfg)) { try { refImgs.push(await fetchImage(r.url)); } catch { /* a dead ref is skipped */ } }
  const parts = buildParts({ prompt: cfg?.prompt, subjects: subjectImgs, refs: refImgs, img: (x) => inlineImagePart(x.buffer, x.contentType) });
  const m = modelFor(job.model || cfg?.model);
  const pro = m.id === NBPRO_MODEL;
  const out = await geminiGenerateImage(key, pro ? NBPRO_MODEL : GEMINI_MODEL, parts, {
    outPerMtok: pro ? NBPRO_OUT_PER_MTOK : GEMINI_OUT_PER_MTOK,
    flatUsd: pro ? NBPRO_FLAT_IMAGE_USD : GEMINI_FLAT_IMAGE_USD,
    imageConfig: pro ? { aspectRatio: "1:1", imageSize: "2K" } : { aspectRatio: "1:1" },
  });
  const ext = /jpe?g/.test(out.mime) ? "jpg" : "png";
  const path = `products/${pid}/concrete/house-${Date.now()}.${ext}`;
  const token = randomUUID();
  await bucket.file(path).save(out.buffer, {
    contentType: out.mime, resumable: false,
    metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } },
  });
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  return { url, path, costUsd: out.costUSD, model: m.id, subjectUrl: subjects[0], refsUsed: refImgs.length };
}

const sampleArg = process.argv.find((a) => a.startsWith("--sample="))?.split("=")[1]?.split(",").filter(Boolean) || null;
if (sampleArg) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const outDir = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];
  if (!outDir) { console.error("--sample needs --out=<dir>"); process.exit(2); }
  mkdirSync(outDir, { recursive: true });
  const cfg = (await db.ref(HOUSE_STYLE_CONFIG_PATH).get()).val() || {};
  const key = geminiKey();
  const rows = [];
  for (const pid of sampleArg) {
    try {
      const product = (await db.ref(`products/${pid}`).get()).val();
      const subjects = subjectUrls(product);
      const subjectImgs = await Promise.all(subjects.map(fetchImage));
      const refImgs = [];
      for (const r of refsToSend(cfg)) { try { refImgs.push(await fetchImage(r.url)); } catch { /* skip */ } }
      const parts = buildParts({ prompt: cfg?.prompt, subjects: subjectImgs, refs: refImgs, img: (x) => inlineImagePart(x.buffer, x.contentType) });
      const t0 = Date.now();
      const out = await geminiGenerateImage(key, NBPRO_MODEL, parts, { outPerMtok: NBPRO_OUT_PER_MTOK, flatUsd: NBPRO_FLAT_IMAGE_USD, imageConfig: { aspectRatio: "1:1", imageSize: "2K" } });
      const ext = /jpe?g/.test(out.mime) ? "jpg" : "png";
      writeFileSync(`${outDir}/${pid}-generated.${ext}`, out.buffer);
      writeFileSync(`${outDir}/${pid}-original.${subjectImgs[0].contentType.includes("png") ? "png" : "jpg"}`, subjectImgs[0].buffer);
      rows.push({ pid, name: product?.name, costUsd: out.costUSD, ms: Date.now() - t0, refs: refImgs.length, ext });
      log(`sample ${pid}: ${money(out.costUSD)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (e) { rows.push({ pid, error: String(e?.message || e) }); log(`sample ${pid} failed: ${String(e?.message || e)}`); }
  }
  writeFileSync(`${outDir}/samples.json`, JSON.stringify(rows, null, 2));
  process.exit(0);
}

// A row left "running" by a worker that died (crash, kill, restart) is put back
// in the queue after 10 minutes — through afterFailure, so it counts as an
// attempt and a job that keeps dying ends flagged instead of billing forever.
try {
  const running = (await db.ref(HOUSE_STYLE_JOBS_PATH).orderByChild("status").equalTo(STATUS.RUNNING).get()).val() || {};
  const now = await serverNow();
  for (const [pid, job] of Object.entries(running)) {
    if (!isStaleRunning(job, now)) continue;
    await db.ref(`${HOUSE_STYLE_JOBS_PATH}/${pid}`).transaction((cur) => (cur === null ? null : isStaleRunning(cur, now) ? { ...cur, ...afterFailure(cur, "the worker stopped mid-generation", now) } : undefined));
    log(`↻ ${pid}: stale "running" row reclaimed`);
  }
} catch (e) { if (!/index not defined/i.test(String(e?.message || e))) log(`⚠ stale-row check: ${String(e?.message || e)}`); }

const jobs = await queued();
const pids = Object.keys(jobs);
if (!pids.length) { process.exit(0); }
const cfg = (await db.ref(HOUSE_STYLE_CONFIG_PATH).get()).val() || {};
let key;
try { key = geminiKey(); } catch (e) { log(`✗ ${String(e.message)} — jobs left queued`); process.exit(1); }

let spent = 0;
for (const pid of pids) {
  const now = await serverNow();
  const job = await claim(pid, now);
  if (!job) continue;
  try {
    const r = await generate(pid, job, cfg, key);
    spent += r.costUsd;
    // The image is paid for and stored: the row write is retried rather than
    // falling into the catch, which would re-queue it and bill a second image.
    const patch = { status: STATUS.AWAITING, ...r, generatedAt: await serverNow(), error: null, lastErrorAt: null };
    for (let i = 0; ; i++) {
      try { await db.ref(`${HOUSE_STYLE_JOBS_PATH}/${pid}`).update(patch); break; }
      catch (e) { if (i >= 4) { log(`✗ ${pid}: generated (${r.url}) but the row could not be written: ${String(e?.message || e)}`); throw Object.assign(e, { noRequeue: true }); } await new Promise((res) => setTimeout(res, 2000 * (i + 1))); }
    }
    log(`✓ ${pid}: generated (${r.model}, ${r.refsUsed} refs) — ${money(r.costUsd)} — awaiting approval`);
  } catch (e) {
    if (e?.noRequeue) continue;
    const patch = afterFailure(job, String(e?.message || e), await serverNow());
    await db.ref(`${HOUSE_STYLE_JOBS_PATH}/${pid}`).update(patch);
    log(`${patch.status === STATUS.FAILED ? "✗ FLAGGED" : "↻ retry queued"} ${pid} (attempt ${job.attempts}/${MAX_ATTEMPTS}): ${patch.error}`);
  }
}
if (spent) log(`pass spent ${money(spent)}`);
process.exit(0);
