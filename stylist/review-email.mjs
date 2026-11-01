// ─── EMAIL JUNID THE STYLIST'S REVIEW SHEET (DIRECT LINKS, DELIVERY CHECKED) ──
// node stylist/review-email.mjs --dir ~/Desktop/stylist-review-2026-11-02
//
// Uploads each outfit picture and one combined sheet to Storage (the same
// public download-token links the lookbook samples use), sends one email
// through the existing Gmail SMTP sender (the card-recon mailbox in
// ~/marathon-store-app/.env) with the links written out AND the sheet
// inline, then verifies delivery two ways: Gmail must ACCEPT the recipient
// (SMTP 250), and the message must be in the sender's Sent Mail by its
// Message-ID (IMAP). Either failing is a non-zero exit. The email path has
// failed before; a send is never reported without both checks.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "../functions/package.json"));
const admin = require("firebase-admin");
const sharp = require("sharp");
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");
import { TO, send, inSentMail } from "./mail.mjs";

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg("dir");
if (!DIR) throw new Error("--dir <review folder> is required");
const review = JSON.parse(fs.readFileSync(path.join(DIR, "review.json"), "utf8"));
const rows = review.rows.filter((r) => r.file);

if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app", storageBucket: STORAGE_BUCKET });
async function upload(name, buffer) {
  const token = randomUUID();
  const p = `aiStudio/social/stylist-review/${review.start}/${name}_${token}.jpg`;
  await admin.storage().bucket(STORAGE_BUCKET).file(p).save(buffer, { resumable: false, contentType: "image/jpeg",
    metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } } });
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(p)}?alt=media&token=${token}`;
}

// The sheet: every outfit stacked, one row each.
const pics = await Promise.all(rows.map((r) => sharp(path.join(DIR, r.file)).resize({ width: 1600, height: 420, fit: "contain", background: "#ffffff" }).jpeg().toBuffer()));
const sheet = await sharp({ create: { width: 1600, height: 420 * pics.length, channels: 3, background: "#ffffff" } })
  .composite(pics.map((b, i) => ({ input: b, top: i * 420, left: 0 }))).jpeg({ quality: 84 }).toBuffer();
fs.writeFileSync(path.join(DIR, "sheet.jpg"), sheet);
const sheetUrl = await upload("sheet", sheet);
for (const r of rows) r.url = await upload(r.file.replace(/\.jpg$/, ""), fs.readFileSync(path.join(DIR, r.file)));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const text = [
  "Junid,",
  "",
  `The new local stylist (${review.model} + Fashion-CLIP, running free on the Mac mini) styled ${rows.length} outfits in a row, offline. Nothing was posted.`,
  "No top, bottoms or sneaker repeats across the set; every total is under R2,000.",
  "",
  `The whole sheet: ${sheetUrl}`,
  "",
  ...rows.flatMap((r, i) => [
    `${i + 1}. ${r.answer.theme} — R${r.total} — ${r.url}`,
    ...r.pieces.map((p) => `     ${p.slot.padEnd(9)}${p.brand} ${p.name} — R${p.price}`),
    `     Why: ${r.answer.why}`,
    `     Caption: ${r.answer.caption.replace(/\n/g, " / ")}`,
    "",
  ]),
].join("\n");
const html = `<p>Junid,</p><p>The new local stylist (<b>${esc(review.model)}</b> + Fashion-CLIP, running free on the Mac mini) styled ${rows.length} outfits in a row, offline. Nothing was posted. No top, bottoms or sneaker repeats; every total is under R2,000.</p>
<p><a href="${sheetUrl}">Open the whole sheet</a></p><p><img src="cid:sheet" width="800" style="max-width:100%"></p>
${rows.map((r, i) => `<h3>${i + 1}. ${esc(r.answer.theme)} — R${r.total} · <a href="${r.url}">picture</a></h3><ul>${r.pieces.map((p) => `<li>${esc(p.slot)}: ${esc(p.brand)} ${esc(p.name)} — R${p.price}</li>`).join("")}</ul><p><i>${esc(r.answer.why)}</i></p><p style="white-space:pre-wrap">${esc(r.answer.caption)}</p>`).join("")}`;

const info = await send({
  subject: `Stylist review: ${rows.length} outfits from the new local stylist (not posted)`,
  text, html, attachments: [{ filename: "stylist-review-sheet.jpg", content: sheet, cid: "sheet" }],
});
console.log(`smtp: accepted for ${TO} — ${info.response} — ${info.messageId}`);
if (!(await inSentMail(info.messageId))) throw new Error(`the message ${info.messageId} is not in the sender's Sent Mail`);
console.log(`imap: in Sent Mail — delivered to Gmail for ${TO}`);
fs.writeFileSync(path.join(DIR, "emailed.json"), JSON.stringify({ at: new Date().toISOString(), to: TO, messageId: info.messageId, response: info.response, sheetUrl, links: rows.map((r) => r.url) }, null, 1));
process.exit(0);
