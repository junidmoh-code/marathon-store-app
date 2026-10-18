// ─── THE LOOKBOOK SAMPLES, WHERE JUNID CAN SEE THEM ──────────────────────────
// Takes the samples lookbook-samples.mjs already saved in
// ~/Desktop/lookbook-samples/ (NN.jpg + samples.json) and, WITHOUT generating
// anything:
//
//   · puts each one in the Social queue as status "sample": a real
//     /social_posts record, visible under the queue's Samples filter, tappable
//     to full size, with no scheduledAt and no platform switched on. The
//     publisher only ever reads status "approved", the generators only count
//     draft/approved/posting, and socialHealthScan ignores samples, so a
//     sample can never be scheduled, posted or counted;
//   · with --email, sends the masters to the inbox the social reports go to
//     (junidmoh@gmail.com, scripts/social/install-social-alarm.mjs RECIPIENT),
//     through the existing Gmail SMTP sender: the card-recon mailbox, its app
//     password read from the gitignored .env of ~/marathon-store-app. Nothing
//     secret is printed.
//
// Idempotent: a sample already in the queue (samples.json postId) is not
// written again, and an email already sent is not sent again (emailedAt).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/lookbook-samples-publish.mjs [--email]
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");

const DIR = join(homedir(), "Desktop", "lookbook-samples");
const TO = "junidmoh@gmail.com";
const USD_TO_ZAR = 18.0;
const LABEL = { "gemini-3-pro-image": "Nano Banana Pro", "gemini-3.1-flash-image": "Flash" };

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const logPath = join(DIR, "samples.json");
const log = JSON.parse(await readFile(logPath, "utf8"));
const samples = Object.keys(log).filter((n) => log[n].ok && existsSync(join(DIR, `${n}.jpg`))).sort();
if (!samples.length) throw new Error(`no finished samples in ${DIR}`);

async function upload(n, buffer) {
  const token = randomUUID();
  const path = `aiStudio/social/samples/lookbook-${n}_${token}.jpg`;
  await admin.storage().bucket(STORAGE_BUCKET).file(path).save(buffer, {
    resumable: false, contentType: "image/jpeg",
    metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

const describe = (n, s) =>
  `SAMPLE ${n} · ${LABEL[s.model] || s.model}${s.scene ? ` · ${s.scene}` : ""} · ${s.rows.length} pieces · total ${s.total} · ` +
  `R${(s.costUSD * USD_TO_ZAR).toFixed(2)} to generate. Not scheduled; never posted.`;

for (const n of samples) {
  const s = log[n];
  if (s.postId) { console.log(`${n}: already in the queue as ${s.postId}`); continue; }
  const url = await upload(n, await readFile(join(DIR, `${n}.jpg`)));
  const id = db.ref("social_posts").push().key;
  const now = Date.now();
  await db.ref(`social_posts/${id}`).set({
    status: "sample",
    kind: "lookbook",
    format: "feed",
    media: [{ type: "image", url }],
    caption: describe(n, s),
    captionSource: "not-needed",
    products: s.rows.map((r) => ({ pid: r.pid, name: r.name, price: r.price })),
    platforms: { instagram: false, facebook: false, tiktok: false },
    scheduledAt: null,
    sample: {
      n, model: s.model, costUSD: s.costUSD, total: s.total, madeAt: s.at, capOverridden: Boolean(s.budget && s.budget.overridden),
      ...(s.scene ? { scene: s.scene } : {}), ...(s.dims ? { master: s.dims.master } : {}),
    },
    createdAt: now,
    updatedAt: now,
    updatedBy: "script:lookbook-samples-publish",
  });
  s.postId = id;
  s.url = url;
  console.log(`${n}: in the queue as ${id} (status sample)`);
}
await writeFile(logPath, JSON.stringify(log, null, 2) + "\n");

if (process.argv.includes("--email")) {
  const pending = samples.filter((n) => !log[n].emailedAt);
  if (!pending.length) {
    console.log("email: every sample was already sent");
  } else {
    // The card-recon mailbox's credentials, from the gitignored .env it runs on.
    const env = {};
    for (const line of readFileSync(join(homedir(), "marathon-store-app", ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    const user = env.CARD_RECON_IMAP_USER, pass = String(env.CARD_RECON_IMAP_PASSWORD || "").replace(/\s+/g, "");
    if (!user || !pass) throw new Error("the card-recon mailbox credentials are not in ~/marathon-store-app/.env");
    const nodemailer = createRequire(join(homedir(), "marathon-store-app", "scripts", "cardrecon", "package.json"))("nodemailer");
    const port = Number(env.CARD_RECON_SMTP_PORT) || 465;
    const transport = nodemailer.createTransport({
      host: env.CARD_RECON_SMTP_HOST || "smtp.gmail.com", port, secure: port === 465,
      auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
    });
    const lines = pending.map((n) => {
      const s = log[n];
      return `${n} — ${LABEL[s.model] || s.model} (${s.model}), R${(s.costUSD * USD_TO_ZAR).toFixed(2)} to generate\n` +
        s.rows.map((r) => `     ${r.slot.padEnd(9)}${r.name} — ${r.price}`).join("\n") + `\n     TOTAL ${s.total}`;
    });
    await transport.sendMail({
      from: `Marathon Social <${user}>`,
      to: TO,
      subject: `Lookbook samples ${pending.join(", ")} — not posted`,
      text: [
        "Junid,",
        "",
        "The lookbook samples, made by the production lookbook code and posted nowhere.",
        "They are also in the Social card, under Queue → Samples, with status SAMPLE.",
        "",
        ...lines,
        "",
        "compare-NN.jpg sets each one beside the first real poster (17 Oct). The reference",
        "poster you described has never reached the Mac mini, so there is nothing else to compare against yet.",
      ].join("\n"),
      attachments: pending.flatMap((n) => [
        { filename: `lookbook-sample-${n}.jpg`, path: join(DIR, `${n}.jpg`) },
        ...(existsSync(join(DIR, `compare-${n}.jpg`)) ? [{ filename: `lookbook-compare-${n}.jpg`, path: join(DIR, `compare-${n}.jpg`) }] : []),
      ]),
    });
    const at = new Date().toISOString();
    for (const n of pending) log[n].emailedAt = at;
    await writeFile(logPath, JSON.stringify(log, null, 2) + "\n");
    console.log(`email: sent ${pending.join(", ")} to ${TO}`);
  }
}
process.exit(0);
