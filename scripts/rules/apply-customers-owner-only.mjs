#!/usr/bin/env node
// Make DELETE and ARCHIVE of a customer owner-only in the LIVE, console-managed
// marathon-club RTDB rules, and add the /orders customerId index.
// Dry run by default; writes only with --apply.
//
//   node scripts/rules/apply-customers-owner-only.mjs          # prove + diff
//   node scripts/rules/apply-customers-owner-only.mjs --apply   # prove + write
//
// WHY THIS IS NOT `firebase deploy --only database`
// -------------------------------------------------------------------------
// The live rules and this repo's database.rules.json are NOT the same document
// and have not been for a long time (the live one has 69 top-level nodes; the
// repo file has no shopify_publish, no shopify_sync, and misses much else).
// Deploying the repo file to make this change would strip live rules as a side
// effect — a security regression shipped inside a security fix. So one node is
// merged into the live document and a whole-document diff proves nothing else
// moved.
//
// WHY IT REFUSES TO RUN WITHOUT THE EMULATOR
// -------------------------------------------------------------------------
// On 2026-09-05 a hand-applied, unproven rule took every till down: a
// `.validate` on refundedQty called data.parent() on a create-only path, so the
// value it compared against did not exist yet and every sale was denied. This
// change is in the same dangerous class — it REMOVES a `.write` grant, which is
// the only kind of edit that can refuse a write that used to succeed. So this
// script does not merely offer a proof; it runs one, against the exact document
// it just fetched, and exits if a single case fails. There is no --skip-tests.
//
// ON ETags: /.settings/rules.json does NOT issue one, with or without
// X-Firebase-ETag: true (verified against live 2026-09-04 and again 2026-09-05
// — the response carries no etag header at all). If-Match is sent when the
// server ever gives us something to match on; otherwise the window is closed
// the only way this endpoint allows — re-read immediately before the PUT and
// refuse if the document moved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { patchCustomersRules, patchOrdersIndex, CUSTOMER_RECORD_WRITE, NEXT_ORDERS_INDEX } from "./customersOwnerOnly.mjs";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function token() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/configstore/firebase-tools.json"), "utf8"));
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.tokens.refresh_token,
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  return (await r.json()).access_token;
}
async function getRules(t) {
  const r = await fetch(`${DB}/.settings/rules.json?access_token=${t}`, { headers: { "X-Firebase-ETag": "true" } });
  if (!r.ok) throw new Error(`GET rules failed: ${r.status}`);
  return { rules: await r.json(), etag: r.headers.get("etag") };
}
async function putRules(t, body, etag) {
  const r = await fetch(`${DB}/.settings/rules.json?access_token=${t}`, {
    method: "PUT", body: JSON.stringify(body),
    headers: { ...(etag ? { "If-Match": etag } : {}), "X-Firebase-ETag": "true" },
  });
  if (r.status === 412) throw new Error("PUT refused (412): the live rules changed since they were read — re-run");
  if (!r.ok) throw new Error(`PUT failed: ${r.status} ${await r.text()}`);
  return r.headers.get("etag");
}

const t = await token();
const { rules: live, etag: liveEtag } = await getRules(t);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(os.tmpdir(), `rtdb-rules-backup-${stamp}.json`);
fs.writeFileSync(backup, JSON.stringify(live, null, 2));
console.log(`backup: ${backup}`);
console.log(`etag from server: ${liveEtag === null ? "none (endpoint does not issue one)" : liveEtag}`);

// Patch first — the pure functions refuse loudly if the live shape is not what
// they expect, and there is no point booting an emulator to test a patch that
// cannot be built.
const next = patchOrdersIndex(patchCustomersRules(live));

console.log("\n── the change ──");
console.log("  /customers .write            : REMOVED (was the any-signed-in-till grant)");
console.log("  /customers/$customerId .write: ADDED");
console.log(`      ${CUSTOMER_RECORD_WRITE}`);
console.log(`  /orders .indexOn             : ${JSON.stringify(live.rules.orders[".indexOn"])} → ${JSON.stringify(NEXT_ORDERS_INDEX)}`);

// ── THE PROOF, against THIS document ─────────────────────────────────────────
const liveForEmu = path.join(os.tmpdir(), `rtdb-rules-live-${stamp}.json`);
fs.writeFileSync(liveForEmu, JSON.stringify(live));
console.log("\n── proving on the RTDB emulator ──");
const proof = spawnSync(process.execPath, [path.join(HERE, "customers-rules.test.mjs")], {
  stdio: "inherit",
  env: { ...process.env, LIVE_RULES: liveForEmu },
});
if (proof.status !== 0) {
  console.error("\nREFUSING: the emulator proof did not pass against the CURRENT live rules. Nothing was written.");
  process.exit(1);
}

if (!APPLY) { console.log("\ndry run — re-run with --apply to write"); process.exit(0); }

// Close the race the missing ETag leaves open: prove the document is still
// exactly what we patched and proved, before we push the patch.
const { rules: recheck } = await getRules(t);
if (JSON.stringify(recheck) !== JSON.stringify(live)) {
  console.error("REFUSING: the live rules changed between the read and the write — re-run");
  process.exit(3);
}

const newEtag = await putRules(t, next, liveEtag);
const { rules: after } = await getRules(t);

// ── Verify: our lines landed verbatim and NOTHING else moved ─────────────────
// The diff is taken by stripping exactly the three keys this script is allowed
// to touch from BOTH documents and requiring byte equality of the remainder.
const strip = (r) => {
  const c = JSON.parse(JSON.stringify(r));
  delete c.rules.customers[".write"];
  delete c.rules.customers.$customerId[".write"];
  delete c.rules.orders[".indexOn"];
  return c;
};
const landedWrite = after.rules?.customers?.$customerId?.[".write"] === CUSTOMER_RECORD_WRITE;
const grantGone = after.rules?.customers?.[".write"] === undefined;
const landedIndex = JSON.stringify(after.rules?.orders?.[".indexOn"]) === JSON.stringify(NEXT_ORDERS_INDEX);
const untouched = JSON.stringify(strip(after)) === JSON.stringify(strip(live));
if (!landedWrite || !grantGone || !landedIndex || !untouched) {
  console.error("VERIFY FAILED — restoring backup", { landedWrite, grantGone, landedIndex, untouched });
  try { await putRules(t, live, newEtag); console.error("restored the backup"); }
  catch (e) { console.error("RESTORE FAILED — apply the backup by hand:", backup, e.message); }
  process.exit(1);
}
console.log("\napplied and verified.");
console.log("  /customers .write            :", JSON.stringify(after.rules.customers[".write"] ?? null), "(removed)");
console.log("  /customers/$customerId .write:", JSON.stringify(after.rules.customers.$customerId[".write"]));
console.log("  /orders .indexOn             :", JSON.stringify(after.rules.orders[".indexOn"]));
console.log("  every other byte of the rules document is identical to the backup.");
