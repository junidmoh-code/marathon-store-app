#!/usr/bin/env node
// ─── NEW ARRIVALS — the weekly learning report, emailed to Junid ─────────────
// Runs on the Mac mini (launchd com.marathon.newarrivals.learning, Mondays
// 08:00 SAST) from the store checkout the chain already uses (~/msa-runtime):
//
//     node scripts/newArrivals/learningReport.mjs            email it
//     node scripts/newArrivals/learningReport.mjs --print    print it, send nothing
//
// WHY THE MINI: the only mailbox the business sends from lives there (the
// poster's src/mail.mjs reads its login from the mini's own .env — it never
// leaves that machine). The Admin SDK and sharp are the poster's installed
// copies too; this file brings the report (learningCore.mjs) and nothing else.
//
// READS (bounded, by key — never a whole big node): the last DECISIONS_MAX
// rows of new_arrivals/decisions, and the learning-log rows of the newest
// GENLOG_MAX codes (plus any a decision names) by key.
// No model call, no cost, nothing written. Prompt changes are only PROPOSED.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { learningReport } from "./learningCore.mjs";

const POSTER = process.env.MGP_DIR || path.join(os.homedir(), "marathon-group-poster");
const from = (rel) => import(pathToFileURL(path.join(POSTER, rel)).href);
export const DECISIONS_MAX = 4000;
export const GENLOG_MAX = 400;

export const GENLOG_BATCH = 50;

// Decisions are keyed by push id: key order IS time order.
const lastRows = async (db, node, n) => Object.values((await db.ref(node).orderByKey().limitToLast(n).once("value")).val() || {});
const formatCode = (n) => `G-${String(n).padStart(4, "0")}`;
/**
 * The learning-log rows by CODE — keyed reads, never an ordered scan (codes
 * stop sorting as text after G-9999): the newest GENLOG_MAX codes counted back
 * from the counter, plus any older code a decision names.
 */
async function genlogRows(db, decisions) {
  const seq = Number((await db.ref("new_arrivals/genSeq").once("value")).val()) || 0;
  const codes = new Set();
  for (let n = seq; n > Math.max(0, seq - GENLOG_MAX); n--) codes.add(formatCode(n));
  for (const d of decisions) if (d?.gen?.code && /^G-\d{4,}$/.test(d.gen.code)) codes.add(d.gen.code);
  const list = [...codes], out = [];
  for (let i = 0; i < list.length; i += GENLOG_BATCH) {
    out.push(...await Promise.all(list.slice(i, i + GENLOG_BATCH).map(async (c) => (await db.ref(`new_arrivals/genlog/${c}`).once("value")).val())));
  }
  return out.filter(Boolean);
}

/** io: { db, email({ subject, body, attachments }), fetchImage(url), resize(buf), print, now } */
export async function run(io) {
  const decisions = await lastRows(io.db, "new_arrivals/decisions", DECISIONS_MAX);
  const genlogs = await genlogRows(io.db, decisions);
  const r = learningReport({ decisions, genlogs, now: io.now ? io.now() : Date.now() });
  if (io.print) return { ...r, sent: null };
  const attachments = [], missing = [];
  for (const im of r.images) {
    try { attachments.push({ filename: `${im.code}-${im.tier === "loved" ? "loved" : "not-right"}.jpg`, contentType: "image/jpeg", content: await io.resize(await io.fetchImage(im.url)) }); }
    catch (e) { missing.push(`${im.code} (${String(e.message || e).slice(0, 60)})`); }
  }
  const body = missing.length ? `${r.body}\n\nPhotos that could not be attached: ${missing.join(", ")}.` : r.body;
  return { ...r, body, sent: await io.email({ subject: r.subject, body, attachments }) };
}

// Only when run as a script (the test imports run()). The path is resolved
// first: launchd may start it through a symlink, and a guard that silently
// did not match would mean no email and no error.
const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] || "")).href; } catch { return null; } })();
if (invoked === import.meta.url) {
  const { fb, fetchBytes } = await from("src/fb.mjs");
  const { emailJunid } = await from("src/mail.mjs");
  const sharp = createRequire(path.join(POSTER, "package.json"))("sharp");
  const print = process.argv.includes("--print");
  const out = await run({
    db: fb().db, print, email: emailJunid,
    fetchImage: async (url) => (await fetchBytes(url)).buffer,
    resize: (buf) => sharp(buf).rotate().resize(900, 900, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(),
  });
  if (print) console.log(`${out.subject}\n\n${out.body}\n\nphotos: ${out.images.map((i) => `${i.code}-${i.tier}`).join(", ") || "none"}`);
  else console.log(`learning report: ${JSON.stringify({ ok: out.sent?.ok, why: out.sent?.why, judged: out.rows.length, photos: out.images.length })}`);
  process.exit(print || out.sent?.ok ? 0 : 1);
}
