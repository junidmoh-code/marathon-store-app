// ── Take every proposed name at once (owner instruction 2026-08-20) ──────────
//
//   node scripts/shopify/approve-name-proposals.mjs              dry run
//   node scripts/shopify/approve-name-proposals.mjs --commit     applies
//   node scripts/shopify/approve-name-proposals.mjs --undo FILE  puts it back
//
// The review lane exists so a human decides each name. Junid has decided all of
// them at once, which is his call to make — so this does exactly what the lane's
// "Use this name" button does, 2,700-odd times, and NOTHING ELSE.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
// It does not publish. It writes `cleanName` and nothing that any customer can
// see: the storefront only changes when the reconciler acts on `desiredState`,
// which this never touches. A product that is already ON the storefront is
// SKIPPED — renaming it here would leave the app disagreeing with what shoppers
// are looking at, which is the one thing approveName refuses in the UI too.
//
// ── THE SAME GATES AS THE BUTTON, SELF-ENFORCED ──────────────────────────────
// The Admin SDK bypasses database rules, so every check the browser relies on
// has to be made here explicitly:
//   · only status "pending" — a decided proposal is never re-decided
//   · the name must pass validateVisionName TODAY, not when it was written
//     (the lexicon grows; a name that was clean in the morning may not be)
//   · `state` must be present and the listing must not be ON
//   · cleanNameSource is written as "ai", the value the live rule admits —
//     never "vision", which it refuses
//
// ── REVERSIBLE ───────────────────────────────────────────────────────────────
// Every proposal carries `previousName`, so the undo needs no new information —
// but a rollback file is written anyway, because reading a decision back out of
// the thing it changed is how one-way migrations happen by accident.
import { createRequire } from "module";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { validateVisionName, NAME_PROPOSAL_KEY } from "../../src/utils/visionNaming.js";
import { isOn, isOnOrGoingOn } from "../../src/components/shopify/publishState.js";

const COMMIT = process.argv.includes("--commit");
const UNDO = process.argv.includes("--undo") ? process.argv[process.argv.indexOf("--undo") + 1] : null;

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
// Server time, not this laptop's clock. `updatedAt` is a rules-validated field
// (`newData.val() <= now + 86400000`) and the Admin SDK bypasses rules, so a
// skewed clock writes ~2,700 nodes carrying a value the rule would have refused
// — silently, with no error, poisoning every later browser write to those nodes.
const SERVER_NOW = admin.database.ServerValue.TIMESTAMP;
const stamp = () => ({ updatedAt: SERVER_NOW, updatedBy: "script:approve-name-proposals" });

// ── UNDO ─────────────────────────────────────────────────────────────────────
if (UNDO) {
  const rows = JSON.parse(readFileSync(UNDO, "utf8"));
  console.log(`undoing ${rows.length} approval(s) from ${UNDO}`);
  let back = 0, skippedLive = 0;
  for (const { pid, previousName, previousSource } of rows) {
    assertSafeSegment(pid, "productId");
    // Time has passed since the run this is undoing: a product renamed while
    // it was awaiting may have been PUBLISHED since. Putting the old name back
    // would then rename a live listing — the one thing the apply path refuses
    // to do — and would do it without anyone asking.
    const now = await db.ref(`shopify_publish/${pid}`).once("value").then((sn) => sn.val());
    if (isOnOrGoingOn(now)) {
      skippedLive += 1;
      console.warn(`  ✗ ${pid} — on the storefront (or published and waiting); NOT put back`);
      continue;
    }
    await db.ref(`shopify_publish/${pid}`).update({
      // previousName null means the product had NO listing name before, and
      // null is how RTDB says "remove this field" — which is exactly right.
      cleanName: previousName ?? null,
      // previousSource is recorded by every run from 2026-08-20 onward. Older
      // rollback files carry only the name, and for those "lexicon" is the
      // right guess: this script's scope is proposals that had not been
      // decided, so any name they were replacing came from the lexicon path.
      cleanNameSource: previousSource ?? (previousName ? "lexicon" : null),
      nameApprovedAt: null,
      [`${NAME_PROPOSAL_KEY}/status`]: "pending",
      [`${NAME_PROPOSAL_KEY}/decidedAt`]: null,
      ...stamp(),
    });
    back += 1;
    if (back % 200 === 0) console.log(`  ${back}/${rows.length}`);
  }
  console.log(`done — ${back} name(s) put back and their suggestions returned to pending${skippedLive ? `; ${skippedLive} refused because the product is public now` : ""}.`);
  process.exit(0);
}

// ── SCOPE ────────────────────────────────────────────────────────────────────
const publish = await readMapPaged(db, "shopify_publish", { pageSize: 400 });
const skipped = { notPending: 0, live: 0, refusedByValidator: 0, noName: 0, manual: 0 };
const work = [];
for (const [pid, node] of Object.entries(publish)) {
  const p = node?.[NAME_PROPOSAL_KEY];
  if (!p) continue;
  if (p.status !== "pending") { skipped.notPending += 1; continue; }
  if (!p.name) { skipped.noName += 1; continue; }
  if (isOnOrGoingOn(node)) { skipped.live += 1; continue; }
  // A NAME JUNID TYPED IS HIS DECISION, and a pending proposal is not proof
  // he never made one. approveName() and publishProduct() write cleanName and
  // cleanNameSource but never DECIDE the proposal, so a hand-written name sits
  // beside a proposal that is still "pending" — and without this gate the very
  // next run of this script would overwrite his name with the machine's AND
  // rewrite cleanNameSource to "ai", which is the one field that told anyone
  // the name was his. It would also unlock the product for future vision runs
  // (mayProposeFor), so the same overwrite could then happen again.
  if (node.cleanNameSource === "manual") { skipped.manual += 1; continue; }
  const verdict = validateVisionName(p.name);
  if (!verdict.ok) { skipped.refusedByValidator += 1; continue; }
  work.push({ pid, node, proposal: p });
}

console.log(`proposals that would be taken : ${work.length}`);
console.log(`  skipped — already decided   : ${skipped.notPending}`);
console.log(`  skipped — listing is ON     : ${skipped.live}   (live, or published and waiting for the reconciler)`);
console.log(`  skipped — hand-written name : ${skipped.manual}   (cleanNameSource "manual" — Junid's own decision)`);
console.log(`  skipped — fails the validator: ${skipped.refusedByValidator}   (brand trigger today)`);
console.log(`  skipped — proposal has no name: ${skipped.noName}`);
const renames = work.filter((w) => w.node.cleanName).length;
console.log(`\nof those, ${renames} REPLACE an existing listing name and ${work.length - renames} fill an empty one`);
console.log(`sample:`);
for (const w of work.slice(0, 5)) {
  console.log(`  ${JSON.stringify(w.node.cleanName || "(no name)")} → ${JSON.stringify(w.proposal.name)}`);
}

if (!COMMIT) {
  console.log(`\nDRY RUN — nothing written. Re-run with --commit.`);
  console.log(`NOTE: this changes listing NAMES only. Nothing reaches the storefront until you publish.`);
  process.exit(0);
}

// ── APPLY ────────────────────────────────────────────────────────────────────
// A transaction per node, not a batched multi-path update: the gate has to be
// re-tested against the SERVER value at write time. The reconciler runs every
// two minutes and a product can go live between the scope read above and this
// write — and that product must not be renamed.
const rollback = [];
let applied = 0, aborted = 0;
const CONCURRENCY = 12;
let cursor = 0;
async function worker() {
  while (cursor < work.length) {
    const { pid, node, proposal } = work[cursor++];
    assertSafeSegment(pid, "productId");
    const res = await db.ref(`shopify_publish/${pid}`).transaction((cur) => {
      // NEVER ABORT ON A NULL `cur`. On the first (cold-cache) attempt RTDB
      // hands the mutator null even when the node exists — so `if (!cur)
      // return undefined` aborts EVERY transaction and writes nothing, which
      // is exactly what the first version of this script did: 0 applied, 2,684
      // "skipped". The documented trap, in shopifyPublishStore.js:225-228, and
      // I walked into it anyway.
      //
      // Fall back to the scanned node and let the server's compare-and-retry
      // supply the real value; the gates below then run again against THAT,
      // which is where they actually matter.
      const base = cur || node;
      const p = base[NAME_PROPOSAL_KEY];
      if (!p || p.status !== "pending") return undefined;   // decided since the scan
      if (isOnOrGoingOn(base)) return undefined;             // went live, or was published, since the scan
      if (base.cleanNameSource === "manual") return undefined;  // hand-named since the scan
      if (!validateVisionName(p.name).ok) return undefined;
      const at = SERVER_NOW;
      return {
        ...base,
        state: base.state || "awaiting",
        cleanName: String(p.name).trim(),
        cleanNameSource: "ai",
        nameApprovedAt: at,
        [NAME_PROPOSAL_KEY]: { ...p, status: "applied", decidedAt: at },
        ...stamp(),
      };
    });
    if (res.committed) {
      applied += 1;
      rollback.push({ pid, previousName: proposal.previousName ?? null, previousSource: node.cleanNameSource ?? null, appliedName: proposal.name });
    } else {
      aborted += 1;
    }
    if ((applied + aborted) % 200 === 0) console.log(`  ${applied + aborted}/${work.length} (applied ${applied}, skipped ${aborted})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ── WHERE THE ROLLBACK FILE GOES, AND WHY NOT /tmp ───────────────────────────
// The first run of this script wrote its rollback to /tmp. macOS clears /tmp
// on reboot, and that file was the ONLY record of 2,684 renames — the undo
// path below needs it, and one restart would have taken it. Rollback files
// belong somewhere that survives the machine being turned off.
const ROLLBACK_DIR = join(homedir(), "marathon-rollbacks");
mkdirSync(ROLLBACK_DIR, { recursive: true });
const file = join(ROLLBACK_DIR, `approve-name-proposals-rollback-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(rollback, null, 1));
console.log(`\napplied ${applied} · skipped at write time ${aborted}`);
console.log(`ROLLBACK FILE: ${file}`);
console.log(`  put it all back with:  node scripts/shopify/approve-name-proposals.mjs --undo ${file}`);
console.log(`\nNothing is on the storefront. These are listing names waiting to be published.`);
process.exit(0);
