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
// rows of new_arrivals/decisions and the last GENLOG_MAX of new_arrivals/genlog.
// No model call, no cost, nothing written. Prompt changes are only PROPOSED.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { learningReport } from "./learningCore.mjs";

const POSTER = process.env.MGP_DIR || path.join(os.homedir(), "marathon-group-poster");
const from = (rel) => import(pathToFileURL(path.join(POSTER, rel)).href);
export const DECISIONS_MAX = 4000;
export const GENLOG_MAX = 1500;

const lastRows = async (db, node, n) => Object.values((await db.ref(node).orderByKey().limitToLast(n).once("value")).val() || {});

/** io: { db, email({ subject, body, attachments }), fetchImage(url), resize(buf), print, now } */
export async function run(io) {
  const [decisions, genlogs] = await Promise.all([lastRows(io.db, "new_arrivals/decisions", DECISIONS_MAX), lastRows(io.db, "new_arrivals/genlog", GENLOG_MAX)]);
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

// Only when run as a script (the test imports run()).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
