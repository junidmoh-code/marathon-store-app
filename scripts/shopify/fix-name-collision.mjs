// ── Give colliding listings names that tell them apart ───────────────────────
//
//   node scripts/shopify/fix-name-collision.mjs --report
//   node scripts/shopify/fix-name-collision.mjs --file names.json
//   node scripts/shopify/fix-name-collision.mjs --file names.json --commit
//   node scripts/shopify/fix-name-collision.mjs --file names.json --source ai --commit
//   node scripts/shopify/fix-name-collision.mjs --undo ROLLBACK.json
//
// ── WHAT A COLLISION IS ──────────────────────────────────────────────────────
// Shopify handles are unique per shop, and a handle is built from the listing
// name alone (compliance.mjs buildHandle). Two products whose cleanNames
// slugify to the same string are competing for one handle: whichever reaches
// Shopify first owns it, and every sibling is refused by the reconciler and
// parked with `state: "blocked"`. The blocked ones are not broken records —
// they are perfectly good products standing behind a name that was never
// specific enough to be a name.
//
// The lexicon path is what produces them. It strips brand, sub-label and
// silhouette from a staff-typed title and rebuilds from the remainder, which
// for footwear leaves "Sneaker" plus a colour. Three different white shoes all
// arrive at "sneaker-white". That is not a duplicate record; it is one word
// doing the work of three names.
//
// ── WHY THIS SCRIPT TAKES NAMES INSTEAD OF INVENTING THEM ────────────────────
// A distinguishing name has to come from looking at the two products. There is
// no rule that separates "Sneaker White" from "Sneaker White" — the difference
// is in the photographs, and a suffix ("Sneaker White 2") is not a difference,
// it is a serial number pretending to be one. So this script does the part
// that is mechanical and refuses to do the part that is not: you supply
// pid → name, it validates, guards and writes.
//
// The FILE format is a JSON array, exactly what --report prints a skeleton of:
//   [{ "pid": "p1784124080353", "name": "Camel wide-leg lounge set", "why": "…" }]
// `why` is documentation for the rollback file and the reviewer; it is never
// written to the database and never reaches Shopify.
//
// ── THE GUARDS, AND WHY EACH ONE EXISTS ──────────────────────────────────────
//   · A listing that is ON — or on its way ON — is NEVER renamed. Renaming a
//     live one changes the handle of a page customers and search engines are
//     already pointed at; renaming one whose desiredState is "on" changes the
//     name that is about to be pushed, out from under the person who signed it
//     off minutes ago. Clearing a collision by renaming a public product is a
//     decision with public consequences and it is not this script's to make.
//     The predicate is the APP'S OWN (publishState.js), not a local rewrite:
//     a hand-rolled `state === "live" && liveState === "on"` misses a legacy
//     node that has no liveState field and IS on the storefront.
//   · The new name must pass validateVisionName TODAY — the browser's own
//     checkCleanName gate is a strict SUBSET of it (same digit-start, same
//     3-80 length, same trigger list; the vision validator adds an ALL-CAPS
//     refusal), so passing this passes that. Re-run here because the Admin
//     SDK bypasses database rules entirely, and because the trigger lexicon
//     grows: a name that was clean this morning may not be now.
//   · The new handle must not collide with ANY other node's handle, including
//     the other names in the same batch. A fix that trades one collision for
//     another is not a fix.
//   · cleanNameSource records where the name CAME FROM, and it is not a
//     convenience field. "manual" is the one value vision-name.mjs refuses to
//     propose over (mayProposeFor), so marking a name manual permanently
//     stops a future naming run from recreating the clash — which is exactly
//     right for a name a person wrote after looking at the photographs, and
//     exactly wrong for a name the vision model wrote. Recording 43 machine
//     names as hand-written would corrupt the one field that tells Junid
//     which names are actually his. So: --source manual (the default) for a
//     name you wrote, --source ai for a name you are taking from the
//     model's proposal.
//   · A still-PENDING proposal is decided either way, because
//     approve-name-proposals.mjs acts on anything still pending and would
//     otherwise overwrite this name on its next run. It is marked "applied"
//     when the name being written IS the proposal's name (it was taken) and
//     "rejected" when a different name supersedes it. Neither is a guess.
//
// ── REVERSIBLE ───────────────────────────────────────────────────────────────
// A rollback file lands in ~/marathon-rollbacks (NOT /tmp — /tmp is cleared on
// reboot and a rollback that evaporates is not a rollback), carrying the
// previous name, source and proposal status for every node touched.
import { createRequire } from "module";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { validateVisionName, NAME_PROPOSAL_KEY } from "../../src/utils/visionNaming.js";
import { isOn, isOnOrGoingOn } from "../../src/components/shopify/publishState.js";
import { buildHandle } from "./compliance.mjs";

const arg = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const COMMIT = process.argv.includes("--commit");
const REPORT = process.argv.includes("--report");
const FILE = arg("--file");
const UNDO = arg("--undo");
// Provenance of the names in --file. "manual" also locks the product against
// future vision proposals; "ai" does not, and must not pretend to.
const SOURCE = arg("--source") || "manual";
if (!["manual", "ai", "lexicon"].includes(SOURCE)) {
  console.error(`--source must be manual | ai | lexicon (the values the database rule admits), not ${JSON.stringify(SOURCE)}`);
  process.exit(2);
}

export const ROLLBACK_DIR = join(homedir(), "marathon-rollbacks");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
// Server time, not this laptop's clock: updatedAt is a rules-validated field
// (`newData.val() <= now + 86400000`) and a skewed local clock would write a
// value the rule rejects for every browser that touches the node afterwards.
const SERVER_NOW = admin.database.ServerValue.TIMESTAMP;
const stamp = () => ({ updatedAt: SERVER_NOW, updatedBy: "script:fix-name-collision" });

// ── UNDO ─────────────────────────────────────────────────────────────────────
if (UNDO) {
  const rows = JSON.parse(readFileSync(UNDO, "utf8"));
  console.log(`undoing ${rows.length} rename(s) from ${UNDO}`);
  let back = 0, refused = 0;
  for (const { pid, previousName, previousSource, previousProposalStatus } of rows) {
    assertSafeSegment(pid, "productId");
    // THE UNDO NEEDS THE SAME GATE AS THE COMMIT, and for a sharper reason.
    // Time has passed: a product renamed while it was blocked may have been
    // published since. Putting the old name back would then rename a LIVE
    // listing — the one thing this script refuses to do — and it would do it
    // without anyone asking. A transaction, not update(), so the check is made
    // against the SERVER's value at write time.
    // Read the node ONCE up front so the transaction has something to fall
    // back to. RTDB hands the mutator a null `cur` on the first (cold-cache)
    // attempt even when the node exists, and `if (!cur) return undefined`
    // would abort every transaction and put nothing back at all — the
    // documented trap this repo has walked into before. The server's
    // compare-and-retry then supplies the real value and the gate below runs
    // again against THAT, which is where it matters.
    const scanned = await db.ref(`shopify_publish/${pid}`).once("value").then((sn) => sn.val());
    if (!scanned) { refused += 1; console.warn(`  ✗ ${pid} — no node; nothing to put back`); continue; }
    const res = await db.ref(`shopify_publish/${pid}`).transaction((cur) => {
      const base = cur || scanned;
      if (isOnOrGoingOn(base)) return undefined;
      const next = {
        ...base,
        // null is how RTDB removes a field, which is exactly right when the
        // node had no name (or no source) before this script ran.
        cleanName: previousName ?? null,
        cleanNameSource: previousSource ?? null,
        ...stamp(),
      };
      if (previousName == null) delete next.cleanName;
      if (previousSource == null) delete next.cleanNameSource;
      if (previousProposalStatus && next[NAME_PROPOSAL_KEY]) {
        next[NAME_PROPOSAL_KEY] = { ...next[NAME_PROPOSAL_KEY], status: previousProposalStatus };
        // A proposal put back to "pending" must not keep the decision stamp
        // this script wrote — a pending proposal carrying a decidedAt is a
        // contradiction the review lane has no way to read.
        if (previousProposalStatus === "pending") delete next[NAME_PROPOSAL_KEY].decidedAt;
      }
      return next;
    });
    if (res.committed) back += 1;
    else { refused += 1; console.warn(`  ✗ ${pid} — on the storefront (or published and waiting); NOT put back`); }
  }
  console.log(`done — ${back} name(s) put back${refused ? `, ${refused} refused (see above)` : ""}.`);
  process.exit(refused ? 2 : 0);
}

// ── THE LIVE PICTURE ─────────────────────────────────────────────────────────
// Paged, never one whole-node read: /shopify_publish is ~3,500 nodes and a
// single get() of it is the read that spikes the bandwidth bill.
const publish = await readMapPaged(db, "shopify_publish", { pageSize: 400 });

const handleOf = (name) => { try { return buildHandle(name); } catch { return null; } };
const byHandle = new Map();
for (const [pid, node] of Object.entries(publish)) {
  const h = handleOf(node?.cleanName);
  if (!h) continue;
  if (!byHandle.has(h)) byHandle.set(h, []);
  byHandle.get(h).push(pid);
}
const groups = [...byHandle.entries()]
  .filter(([, pids]) => pids.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

// ── REPORT ───────────────────────────────────────────────────────────────────
// Prints every group, marks the live member, and emits a skeleton file for the
// non-live ones — the names are left blank on purpose. Filling them in is the
// part that needs eyes on the photographs.
if (REPORT || (!FILE && !COMMIT)) {
  let clearableWithoutLive = 0;
  const needsLiveRename = [];
  const skeleton = [];
  for (const [handle, pids] of groups) {
    const live = pids.filter((p) => isOnOrGoingOn(publish[p]));
    const nonLive = pids.filter((p) => !isOnOrGoingOn(publish[p]));
    // A group clears by renaming only its non-live members when renaming ALL
    // of them leaves at most one product on this handle. With 0 or 1 live
    // member that always holds; with 2+ the handle is contested by products
    // that are already public, and only Junid can decide which one moves.
    if (live.length <= 1) clearableWithoutLive += 1;
    else needsLiveRename.push({ handle, live });
    console.log(`\n${handle}  (${pids.length})`);
    for (const pid of pids) {
      const n = publish[pid];
      console.log(`  ${isOnOrGoingOn(n) ? "LIVE " : "     "}${pid}  ${JSON.stringify(n?.cleanName)}  src=${n?.cleanNameSource ?? "-"} state=${n?.state ?? "-"}`);
    }
    for (const pid of nonLive) skeleton.push({ pid, name: "", why: "", wasCalled: publish[pid]?.cleanName ?? null, handle });
  }
  console.log(`\n────────────────────────────────────────────────`);
  console.log(`collision groups                       : ${groups.length}`);
  console.log(`  clear by renaming NON-LIVE members   : ${clearableWithoutLive}`);
  console.log(`  need a LIVE product renamed          : ${needsLiveRename.length}`);
  for (const g of needsLiveRename) console.log(`     ${g.handle} — ${g.live.length} live members: ${g.live.join(", ")}`);
  console.log(`  non-live products to name            : ${skeleton.length}`);
  mkdirSync(ROLLBACK_DIR, { recursive: true });
  // Timestamped: a fixed name would silently overwrite a skeleton the operator
  // was halfway through filling in, and the names in it are the expensive part.
  const out = join(ROLLBACK_DIR, `collision-skeleton-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(skeleton, null, 1));
  console.log(`\nskeleton written to ${out} — fill in every "name", then:`);
  console.log(`  node scripts/shopify/fix-name-collision.mjs --file ${out} --commit`);
  process.exit(0);
}

// ── VALIDATE THE PROPOSED NAMES ──────────────────────────────────────────────
const rows = JSON.parse(readFileSync(FILE, "utf8"));
if (!Array.isArray(rows) || !rows.length) { console.error(`${FILE} is not a non-empty JSON array`); process.exit(2); }

// Handles claimed by products this batch is NOT touching. A new name has to be
// unique against these AND against the rest of the batch.
const touching = new Set(rows.map((r) => r.pid));
const claimed = new Map();
for (const [pid, node] of Object.entries(publish)) {
  if (touching.has(pid)) continue;
  const h = handleOf(node?.cleanName);
  if (h) claimed.set(h, pid);
}

const work = [];
const refusals = [];
const seenInBatch = new Map();
for (const row of rows) {
  const { pid, name } = row;
  const reject = (why) => refusals.push({ pid, name, why });
  if (!pid || typeof pid !== "string") { reject("row has no pid"); continue; }
  try { assertSafeSegment(pid, "productId"); } catch (e) { reject(String(e.message)); continue; }
  const node = publish[pid];
  if (!node) { reject("no /shopify_publish node — nothing to rename"); continue; }
  if (isOnOrGoingOn(node)) { reject(node.desiredState === "on" && !isOn(node) ? "published and waiting for the reconciler — renaming now would change the name that is about to go out" : "listing is ON — a live product is never renamed by this script"); continue; }
  const clean = String(name ?? "").trim();
  if (!clean) { reject("no name supplied (the skeleton's blank was never filled in)"); continue; }
  const vision = validateVisionName(clean);
  if (!vision.ok) { reject(`refused by the name validator: ${vision.problems.join("; ")}`); continue; }
  const h = handleOf(clean);
  if (!h) { reject("name produces no usable handle"); continue; }
  if (claimed.has(h)) { reject(`handle "${h}" is already held by ${claimed.get(h)}`); continue; }
  if (seenInBatch.has(h)) { reject(`handle "${h}" duplicates ${seenInBatch.get(h)} in this same batch`); continue; }
  seenInBatch.set(h, pid);
  work.push({ pid, node, name: clean, handle: h, why: row.why || "" });
}

console.log(`renames that would be applied : ${work.length}`);
console.log(`refused                       : ${refusals.length}`);
for (const r of refusals) console.log(`  ✗ ${r.pid}  ${JSON.stringify(r.name ?? null)}  — ${r.why}`);
console.log("");
for (const w of work) {
  console.log(`  ${w.pid}  ${JSON.stringify(w.node.cleanName ?? null)}`);
  console.log(`             → ${JSON.stringify(w.name)}   [${w.handle}]`);
  if (w.why) console.log(`             because: ${w.why}`);
}

if (!COMMIT) {
  console.log(`\nDRY RUN — nothing written. Re-run with --commit.`);
  console.log(`Names would be recorded as cleanNameSource "${SOURCE}"${SOURCE === "manual" ? " (also locks them against future vision proposals)" : ""}.`);
  console.log(`NOTE: this changes listing NAMES only. Nothing reaches the storefront until the product is published.`);
  process.exit(0);
}
if (!work.length) { console.log("\nnothing to write."); process.exit(refusals.length ? 2 : 0); }

// ── APPLY ────────────────────────────────────────────────────────────────────
// One transaction per node so the live gate is re-tested against the SERVER's
// value at write time: the reconciler runs outside this process and a product
// can go live between the read above and this write.
const rollback = [];
let applied = 0, aborted = 0;
for (const { pid, node, name } of work) {
  const res = await db.ref(`shopify_publish/${pid}`).transaction((cur) => {
    // NEVER abort on a null `cur`. RTDB hands the mutator null on the first
    // (cold-cache) attempt even when the node exists, so `if (!cur) return`
    // aborts every transaction and writes nothing. Fall back to the scanned
    // node and let the server's compare-and-retry supply the real value — the
    // gate below then runs again against THAT, which is where it matters.
    const base = cur || node;
    if (isOnOrGoingOn(base)) return undefined;        // went live, or was published, since the scan
    const proposal = base[NAME_PROPOSAL_KEY];
    // A pending proposal left pending would be re-applied over this name by
    // approve-name-proposals.mjs on its next run. Decide it truthfully:
    // "applied" if this IS its name, "rejected" if something else won.
    const decided = proposal && proposal.status === "pending"
      ? { [NAME_PROPOSAL_KEY]: {
            ...proposal,
            status: String(proposal.name ?? "").trim() === name ? "applied" : "rejected",
            decidedAt: SERVER_NOW,
          } }
      : {};
    return {
      ...base,
      state: base.state || "awaiting",
      cleanName: name,
      cleanNameSource: SOURCE,
      ...decided,
      ...stamp(),
    };
  });
  if (res.committed) {
    applied += 1;
    rollback.push({
      pid,
      previousName: node.cleanName ?? null,
      previousSource: node.cleanNameSource ?? null,
      previousProposalStatus: node[NAME_PROPOSAL_KEY]?.status ?? null,
      appliedName: name,
    });
  } else {
    aborted += 1;
    console.warn(`  ✗ ${pid} — went live (or was published) between the scan and the write; NOT renamed`);
  }
}

mkdirSync(ROLLBACK_DIR, { recursive: true });
const file = join(ROLLBACK_DIR, `fix-name-collision-rollback-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(rollback, null, 1));
console.log(`\napplied ${applied} · skipped at write time ${aborted}`);
console.log(`ROLLBACK FILE: ${file}`);
console.log(`  put it all back with:  node scripts/shopify/fix-name-collision.mjs --undo ${file}`);
process.exit(0);
