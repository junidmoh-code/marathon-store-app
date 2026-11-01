// The existing Gmail SMTP sender (the card-recon mailbox in the mini's
// gitignored ~/marathon-store-app/.env), shared by the stylist's alerts and
// its review email. Returns nodemailer's info; throws when Gmail does not
// accept the recipient.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TO = "junidmoh@gmail.com";
const mailRequire = createRequire(path.join(os.homedir(), "marathon-store-app", "scripts", "cardrecon", "package.json"));

export function mailEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(os.homedir(), "marathon-store-app", ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const user = env.CARD_RECON_IMAP_USER, pass = String(env.CARD_RECON_IMAP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) throw new Error("the card-recon mailbox credentials are not in ~/marathon-store-app/.env");
  return { env, user, pass };
}

export async function send(msg) {
  const nodemailer = mailRequire("nodemailer");
  const { env, user, pass } = mailEnv();
  const port = Number(env.CARD_RECON_SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({ host: env.CARD_RECON_SMTP_HOST || "smtp.gmail.com", port, secure: port === 465, auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000 });
  const info = await transport.sendMail({ from: `Marathon Social <${user}>`, to: TO, ...msg });
  if (!(info.accepted || []).map(String).includes(TO)) throw new Error(`Gmail did not accept ${TO}: ${JSON.stringify(info.rejected)} ${info.response}`);
  return info;
}

/** True once the message is in the sender's Sent Mail (Gmail files every SMTP send there). */
export async function inSentMail(messageId, tries = 6) {
  const { ImapFlow } = mailRequire("imapflow");
  const { env, user, pass } = mailEnv();
  const imap = new ImapFlow({ host: env.CARD_RECON_IMAP_HOST || "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  await imap.connect();
  try {
    for (let t = 0; t < tries; t++) {
      const lock = await imap.getMailboxLock("[Gmail]/Sent Mail");
      let n = 0;
      try { n = (await imap.search({ header: { "message-id": messageId } })).length; } finally { lock.release(); }
      if (n) return true;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return false;
  } finally { await imap.logout(); }
}
