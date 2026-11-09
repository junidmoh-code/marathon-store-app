#!/usr/bin/env node
// ─── SWEEP DEAD STYLE-CODE CLAIMS ────────────────────────────────────────────
// One-off. Applies the rule resolveStyleCode applies (functions/lib/
// style-code-orphans.cjs) to every claim, and writes the same /style_code_orphans
// records. It removes dead claims and nothing else: a claim with any owner still
// answering for it stays. See docs/STYLE-CODE-ORPHAN-CLAIMS.md.
//
// No whole-node read: the code list comes from a shallow read, then each claim
// and each owner is read by key.
//
//   node scripts/sweep-style-code-orphans.mjs           # dry run, writes nothing
//   node scripts/sweep-style-code-orphans.mjs --apply

import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { sweepOrphanClaims } = require("../functions/lib/style-code-orphans.cjs");

const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const RELEASED_BY = "script:sweep-style-code-orphans";

if (process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error("FIREBASE_DATABASE_EMULATOR_HOST is set: the code list would come from live and the writes go elsewhere. Unset it to run.");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });

const { access_token: token } = await app.options.credential.getAccessToken();
const res = await fetch(`${DATABASE_URL}/style_code_index.json?shallow=true&access_token=${token}`);
if (!res.ok) throw new Error(`Could not list the index: HTTP ${res.status}`);
const codes = Object.keys((await res.json()) || {}).sort();

const report = await sweepOrphanClaims(admin.database(), {
  codes, apply, releasedBy: RELEASED_BY, nowMs: Date.now(),
});

console.log(JSON.stringify(report, null, 2));
console.log(
  `\n${apply ? "APPLIED" : "DRY RUN"}: ${report.scanned} claims, ${report.live} live, ` +
  `${report.dead.length} dead, ${report.released.length} released, ` +
  `${report.redirected.length} redirected, ${report.siblingsOnly.length} kept for live siblings, ` +
  `${report.unresolved.length} unresolved, ${report.malformed.length} malformed, ` +
  `${report.changed.length} changed mid-run, ${report.failed.length} failed.`,
);
await app.delete();
process.exit(report.failed.length ? 1 : 0);
