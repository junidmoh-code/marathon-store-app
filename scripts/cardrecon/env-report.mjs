// ─── WHAT THE POLLER WILL SEE IN .env — NAMES ONLY, NEVER VALUES ─────────────
// The installer must refuse to arm a schedule over a .env the poller cannot
// read. It used to answer that question itself, in bash, mirroring the JS
// parser — and the two copies drifted four times in one review cycle
// (strip-before-trim, per-character quote stripping, a lone quote read as a
// credential, and a carriage return handled differently). Every drift had the
// same shape: the installer says fine and the failure appears in a log five
// minutes later.
//
// So the mirror is gone. This runs the SAME parser the poller runs, and prints
// only what the installer needs to decide.
//
// IT READS THE FILE ONLY, WHERE THE POLLER MERGES process.env OVER IT — and
// that asymmetry is deliberate, in the safe direction. The poller runs under
// launchd, whose plist sets neither credential, so the file IS what it will
// see; if this merged the installer's own shell environment instead, a variable
// exported in the terminal someone is installing from would report "present"
// for a credential that will not exist at 03:00. Reading less than the poller
// can only refuse a working setup, never arm a broken one.
//
//   node scripts/cardrecon/env-report.mjs missing KEY [KEY…]   → missing names
//   node scripts/cardrecon/env-report.mjs value CARD_RECON_POLLER_UID
//
// `value` exists for ONE key and is guarded to it: the poller's uid is not a
// secret (it is a username, printed in the installer's own output), and the
// installer needs the exact string to check the right identity's permissions.
// Nothing else can be read out through this, by construction.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parseEnvText, missingEnvKeys } from "./intakeCore.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PRINTABLE = new Set(["CARD_RECON_POLLER_UID"]);

let env = {};
try {
  env = parseEnvText(readFileSync(join(REPO, ".env"), "utf8"));
} catch {
  // A missing .env is the installer's own check, made before this runs; an
  // unreadable one reports every key missing, which is the safe answer.
}

const [mode, ...keys] = process.argv.slice(2);
if (mode === "missing") {
  console.log(missingEnvKeys(env, keys).join(" "));
} else if (mode === "value") {
  const key = keys[0];
  if (!PRINTABLE.has(key)) {
    console.error(`refusing to print ${key} — only ${[...PRINTABLE].join(", ")} may be read out`);
    process.exit(2);
  }
  console.log(String(env[key] ?? "").trim());
} else {
  console.error("usage: env-report.mjs missing KEY… | value CARD_RECON_POLLER_UID");
  process.exit(2);
}
