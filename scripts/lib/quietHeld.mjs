// ─── JUNID'S QUIET RULE (26 Nov 2026) — the held-message file ────────────────
// Only three things may reach Junid: a return-condition dispute (dm-agent), a
// refund that could not be paid out automatically, and a SYSTEM DOWN alert.
// Everything else this repo used to email or WhatsApp him is written here
// instead, as one JSON line, and marathon-dm-agent imports the file into the
// Fable coach's daily review queue every tick:
//
//   ~/marathon-dm-agent/data/quiet-held.jsonl   (QUIET_HELD_FILE overrides)
//   {"at":<ms>,"channel":"email"|"whatsapp","source":"marathon-store-app:<script>",
//    "kind":null,"subject":"…","text":"…","needsDecision":true|false,"recordOnly":false|true}
//
// needsDecision: the message asked Junid to decide or do something.
// recordOnly:    a pure report/digest, kept for the record.
//
// Never throws past the caller unless the file cannot be written at all — a
// caller that marks a row "told" only after this returns keeps the row for the
// next tick when the disk refuses.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const QUIET_HELD_FILE = () => process.env.QUIET_HELD_FILE || join(homedir(), "marathon-dm-agent", "data", "quiet-held.jsonl");

/** One held line, as the dm-agent importer reads it. Pure. */
export function heldLine({ at = Date.now(), channel = "email", source, kind = null, subject = "", text = "", needsDecision = true } = {}) {
  if (!source) throw new Error("quietHeld: a source is required");
  const decide = needsDecision === true;
  return {
    at: Number(at) || Date.now(),
    channel: channel === "whatsapp" ? "whatsapp" : "email",
    source: String(source),
    kind: kind ?? null,
    subject: String(subject ?? "").slice(0, 300),
    text: String(text ?? "").slice(0, 8000),
    needsDecision: decide,
    recordOnly: !decide,
  };
}

/** Append one held line. → the line written. */
export function appendQuietHeld(entry, { file = QUIET_HELD_FILE(), append = appendFileSync, mkdir = mkdirSync } = {}) {
  const line = heldLine(entry);
  mkdir(dirname(file), { recursive: true });
  append(file, `${JSON.stringify(line)}\n`);
  return line;
}

/**
 * A drop-in for a `send({subject, text})` mail sender that holds the message
 * instead. `decide(mail)` → whether that message asks Junid to decide/do
 * something (default: yes).
 */
export function heldMailSender({ source, channel = "email", decide = () => true, log = () => {}, ...opts }) {
  return async (mail) => {
    const line = appendQuietHeld({ channel, source, subject: mail?.subject, text: mail?.text, needsDecision: decide(mail) !== false }, opts);
    log(`  · held for Fable's review (Junid's quiet rule): ${line.subject || line.text.split("\n")[0]}`);
    return { held: true, messageId: "quiet-held" };
  };
}
