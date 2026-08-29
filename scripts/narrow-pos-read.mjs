// ─── NARROW /pos's BLANKET READ, IN STAGES ───────────────────────────────────
// /pos carries `.read` for every signed-in non-anonymous staff member, and that
// grant CASCADES to every child. Two consequences, both closed here:
//
//   • the abandoned card nodes (/pos/card_batches, /pos/card_batch_drafts,
//     /pos/card_batch_overrides) are readable estate-wide, and no rule under
//     /pos can stop that — a deeper `.read`:`false` is inert, because RTDB read
//     grants cascade DOWN and cannot be revoked from below;
//   • /pos/noReceiptReturns carries its own manager-only `.read` that has never
//     once applied, masked by the same blanket grant.
//
// The fix is to push the grant DOWN: give each child that needs it the SAME
// predicate, verbatim, then delete the parent's. `$other` carries one too, so
// every present and future UNNAMED child keeps its access from a single entry
// rather than from somebody remembering it. The card nodes are explicitly
// named, so `$other` does not reach them, and they go dark.
//
// STAGED ON PURPOSE — stage 1 has NO EFFECT AT ALL while /pos still grants, so
// it can be verified at leisure before the one line that changes behaviour:
//
//   node scripts/narrow-pos-read.mjs --stage 1          # add the six child .read grants
//   node scripts/narrow-pos-read.mjs --stage 2          # remove /pos's own .read
//   node scripts/narrow-pos-read.mjs --stage 3          # drop the card_batch_overrides deep write
//
// Add --apply to write; without it every stage is a dry run that prints its diff
// and leaves no backup file behind.
//
// Method throughout (console-managed rules drift; database.rules.json in this
// repo is STALE and must never be deployed): GET live → timestamped backup IN
// THIS WORKTREE → patch in memory → diff → PUT → re-GET → verify byte-for-byte
// → RESTORE the backup on anything unexpected. NEVER `firebase deploy --only
// database`.

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const STAGE = Number(process.argv[process.argv.indexOf("--stage") + 1]);
if (![1, 2, 3].includes(STAGE)) { console.error("--stage must be 1, 2 or 3"); process.exit(2); }

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const BACKUP = `rules-live-backup-${stamp}-stage${STAGE}.json`;

// The children that must keep the grant. NOT a guess: it is every child that
// currently relies on inheriting it, minus the card nodes, which are the point
// of the exercise. `$other` is in the list and is what makes this safe.
const CARD_NODES = ["card_batches", "card_batch_drafts", "card_batch_overrides"];

function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token, grant_type: "refresh_token",
  }).toString();
  const res = JSON.parse(execSync("curl -sS -X POST https://oauth2.googleapis.com/token -d @-",
    { input: body, encoding: "utf8" }));
  if (!res.access_token) throw new Error("token refresh failed");
  return res.access_token;
}
const url = `${DB}/.settings/rules.json?access_token=${accessToken()}`;
const getRules = async (what) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET rules (${what}) failed: HTTP ${r.status}`);
  return r.text();
};

const before = await getRules("before");
const doc = JSON.parse(before);
const pos = doc.rules.pos;
const posBefore = JSON.stringify(pos);
// Everything OUTSIDE /pos must come out untouched at every stage.
const outsidePosBefore = JSON.stringify(
  Object.fromEntries(Object.entries(doc.rules).filter(([k]) => k !== "pos")));

let summary = [];

if (STAGE === 1) {
  const PRED = pos[".read"];
  if (typeof PRED !== "string") throw new Error("/pos has no .read — stage 1 has already run, or something else changed it.");
  const needs = Object.keys(pos).filter((k) => !k.startsWith(".") && pos[k][".read"] === undefined && !CARD_NODES.includes(k));
  if (!needs.length) throw new Error("no child needs a .read — stage 1 appears to have run already.");
  for (const k of needs) pos[k][".read"] = PRED;   // VERBATIM, not a rewrite
  summary = [
    `added .read to ${needs.length} children: ${needs.join(", ")}`,
    `predicate copied verbatim: ${PRED}`,
    "/pos still carries its own .read — this stage changes NOTHING yet",
  ];
  if (JSON.stringify(pos[".read"]) !== JSON.stringify(PRED)) throw new Error("stage 1 must not touch /pos's own .read");
}

if (STAGE === 2) {
  if (pos[".read"] === undefined) throw new Error("/pos already has no .read — stage 2 has run.");
  // REFUSE unless stage 1 is fully in place. This is the guard that stops the
  // dangerous line landing without its safety net.
  const unguarded = Object.keys(pos).filter((k) => !k.startsWith(".") && pos[k][".read"] === undefined && !CARD_NODES.includes(k));
  if (unguarded.length) {
    throw new Error(`REFUSING: these children still have no .read of their own and would go dark: ${unguarded.join(", ")}. Run stage 1 first.`);
  }
  if (pos.$other?.[".read"] === undefined) {
    throw new Error("REFUSING: $other has no .read, so every UNNAMED /pos child would go dark. Run stage 1 first.");
  }
  const removed = pos[".read"];
  delete pos[".read"];
  summary = [
    `removed /pos's blanket .read: ${removed}`,
    `every child that needed it now carries it, $other included`,
    `going dark, intentionally: ${CARD_NODES.join(", ")}, and /pos/noReceiptReturns falls back to its own manager-only rule`,
  ];
}

if (STAGE === 3) {
  const node = pos.card_batch_overrides;
  if (!node) throw new Error("/pos/card_batch_overrides is missing entirely.");
  if (!node.$storeId) throw new Error("the deep write rule is already gone — stage 3 has run.");
  // Replace the whole block with a NAMED write denial. Named matters: deleting
  // the node outright would drop it back under /pos/$other, which grants write.
  pos.card_batch_overrides = { ".write": "false" };
  summary = [
    "removed the $storeId/$dayYmd/$tillId create grant — staff can no longer write an override naming a manager",
    'the node stays NAMED with ".write": "false" so /pos/$other does not pick it up again',
    "the feature that wrote these was deleted in marathon-pos-app #269; the node is empty",
  ];
}

const after = JSON.stringify(doc, null, 2) + "\n";
console.log(`\n── STAGE ${STAGE} ${APPLY ? "" : "(DRY RUN)"} ──`);
for (const line of summary) console.log(`  • ${line}`);

// Show the /pos diff, and nothing else, because nothing else may change.
const diff = (a, b, path = "") => {
  const out = [];
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const av = a?.[k], bv = b?.[k];
    if (JSON.stringify(av) === JSON.stringify(bv)) continue;
    if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av)) {
      out.push(...diff(av, bv, `${path}/${k}`));
    } else {
      out.push(`    ${path}/${k}\n      - ${JSON.stringify(av)}\n      + ${JSON.stringify(bv)}`);
    }
  }
  return out;
};
console.log("\n  /pos changes:");
for (const line of diff(JSON.parse(posBefore), pos)) console.log(line);

if (!APPLY) { console.log("\n  DRY RUN — nothing written, no backup left behind. Add --apply.\n"); process.exit(0); }

writeFileSync(BACKUP, before);
console.log(`\n  live rules backed up to ./${BACKUP} (${before.length} bytes)`);

const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: after });
if (!put.ok) throw new Error(`PUT failed: HTTP ${put.status} ${await put.text()}`);
console.log("  written. re-fetching to verify…");

const live = await getRules("after");
const problems = [];
if (live !== after) problems.push("the re-fetched document is not byte-identical to what was sent");
const liveDoc = JSON.parse(live);
const outsidePosAfter = JSON.stringify(
  Object.fromEntries(Object.entries(liveDoc.rules).filter(([k]) => k !== "pos")));
if (outsidePosAfter !== outsidePosBefore) problems.push("something OUTSIDE /pos changed — nothing may");
if (JSON.stringify(liveDoc.rules.pos) !== JSON.stringify(pos)) problems.push("/pos did not land exactly as intended");

if (problems.length) {
  console.error("\n  VERIFY FAILED:");
  for (const p of problems) console.error(`    • ${p}`);
  console.error("  RESTORING the backup…");
  const restore = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: before });
  console.error(restore.ok ? `  restored from ./${BACKUP}` : `  RESTORE ALSO FAILED (HTTP ${restore.status}) — restore ./${BACKUP} BY HAND NOW`);
  process.exit(1);
}
console.log("\n  VERIFIED: landed verbatim, nothing outside /pos moved.\n");
