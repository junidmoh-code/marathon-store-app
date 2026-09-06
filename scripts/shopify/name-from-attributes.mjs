// ── THE NAMER, NOW DERIVED FROM THE ATTRIBUTES ───────────────────────────────
// Replaces the vision namer's SECOND judgement. vision-name.mjs asks one photo
// for an identity and, separately, for prose — two readings of the same picture
// that are free to disagree, and prose that nothing can rank on. This reads the
// attributes that were already extracted and derives the listing name from
// them, so the name and the data behind a suggestion are the same answer.
//
//   node scripts/shopify/name-from-attributes.mjs                  DRY RUN, prints every name
//   node scripts/shopify/name-from-attributes.mjs --pids p1,p2     scope: named products
//   node scripts/shopify/name-from-attributes.mjs --collisions     ONLY products whose handle collides today
//   node scripts/shopify/name-from-attributes.mjs --apply          write the proposals
//
// COSTS NOTHING. There is no model call here at all — the spend happened in
// extract-attributes.mjs, and this is arithmetic over what it wrote. That is
// the point of deriving rather than asking twice.
//
// ── IT PROPOSES. IT DOES NOT APPLY. ──────────────────────────────────────────
// Proposals go to /shopify_publish/{pid}/nameProposal and wait for review in
// the publishing page, exactly as the vision namer's do — same key, same shape,
// same lane, so the existing review screen needs no change. cleanName is never
// written here.
//
// ── THE ONE HARD EXCLUSION ───────────────────────────────────────────────────
// A name Junid typed is his decision (mayProposeFor). Unchanged.
import { createRequire } from "module";
import "./env.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import {
  buildNameProposal, mayProposeFor, validateVisionName, NAME_PROPOSAL_KEY,
} from "../../src/utils/visionNaming.js";
import {
  ATTRIBUTES_PATH, usableAttributes, distinctNamesFor, handleFromName,
  ATTRIBUTE_NAME_SOURCE,
} from "../../src/utils/productAttributes.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { isSneakerProduct } from "../lib/sneakerScope.mjs";


const flags = process.argv.slice(2);
const arg = (n) => { const i = flags.indexOf(n); if (i === -1) return null; const v = flags[i + 1]; if (!v || v.startsWith("--")) { console.error(`${n} needs a value`); process.exit(2); } return v; };
const PIDS = arg("--pids");
const APPLY = flags.includes("--apply");
const COLLISIONS_ONLY = flags.includes("--collisions");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const products = await readMapPaged(db, "products", { pageSize: 500 });
const publish = await readMapPaged(db, "shopify_publish", { pageSize: 400 });
const attrs = await readMapPaged(db, ATTRIBUTES_PATH, { pageSize: 500 });

// ── THE NAMING SET IS ALWAYS THE WHOLE ENRICHED CATALOGUE ────────────────────
// distinctNamesFor escalates specificity where a handle COLLIDES, so it has to
// see everything a name could collide with. Scoping the set to --pids would let
// two products in different runs be handed the same name and neither run would
// know. --pids filters the OUTPUT, never the set the collision test runs over.
const named = [];
for (const [pid, p] of Object.entries(products)) {
  if (!p?.id || p.mergedInto || !isSneakerProduct(p)) continue;
  const a = usableAttributes(attrs[pid]);
  if (!a) continue;
  named.push([pid, a]);
}
const derived = distinctNamesFor(named);

const onlyPids = PIDS ? new Set(PIDS.split(",").map((s) => s.trim()).filter(Boolean)) : null;

// The handles in USE today, to report what this actually fixes.
const todayHandles = new Map();
for (const [pid] of named) {
  const h = handleFromName(publish[pid]?.cleanName || "");
  if (!h) continue;
  if (!todayHandles.has(h)) todayHandles.set(h, []);
  todayHandles.get(h).push(pid);
}

const rows = [];
for (const [pid, { name, handle, level }] of derived) {
  if (onlyPids && !onlyPids.has(pid)) continue;
  const node = publish[pid];
  const before = node?.cleanName || null;
  const beforeHandle = handleFromName(before || "");
  const collidesToday = !!beforeHandle && (todayHandles.get(beforeHandle) || []).length > 1;
  if (COLLISIONS_ONLY && !collidesToday) continue;
  rows.push({
    pid, name, handle, level, before, beforeHandle, collidesToday,
    product: products[pid], node,
    blocked: !mayProposeFor(node) ? "manual name — Junid's decision" :
      !validateVisionName(name).ok ? `refused: ${validateVisionName(name).problems.join("; ")}` : null,
  });
}
rows.sort((a, b) => a.pid.localeCompare(b.pid));

// ── WHICH HANDLES ARE ALREADY SPOKEN FOR ─────────────────────────────────────
// Every product that will KEEP its current cleanName after this run still owns
// that handle, and a proposal walking into one is the same publish block this
// build exists to end.
//
// The first version excluded every product distinctNamesFor had named, which
// was wrong in three ways at once (CodeRabbit): a product filtered out by
// --pids or --collisions keeps its old name and its old handle; so does one
// blocked by mayProposeFor; and so does one whose derived name the validator
// refused. All three were treated as having vacated their handle.
//
// ── AND IT HAS TO BE A FIXED POINT, NOT ONE PASS ─────────────────────────────
// The second version computed the free set once, then blocked rows against it.
// But blocking a row is itself a change to the free set: row A, blocked here
// because its derived handle is on the storefront, now KEEPS its own current
// handle — and A had already been excluded from the free set on the assumption
// it was renaming. Row B could then be handed A's current handle unblocked
// (adversarial review). distinctNamesFor already iterates to a fixed point for
// exactly this shape of problem; this has to as well.
//
// It terminates: every round blocks at least one more row or stops, and rows
// are finite. Blocking is monotone — a blocked row is never unblocked — so the
// answer does not depend on the order rows are visited.
let takenElsewhere = new Map();
for (let round = 0; ; round++) {
  const renaming = new Set(rows.filter((r) => !r.blocked).map((r) => r.pid));
  takenElsewhere = new Map();
  for (const [pid, n] of Object.entries(publish)) {
    if (renaming.has(pid)) continue;
    const h = handleFromName(n?.cleanName || "");
    if (h) takenElsewhere.set(h, pid);
  }
  let newlyBlocked = 0;
  for (const r of rows) {
    if (r.blocked) continue;
    const owner = takenElsewhere.get(r.handle);
    // Its OWN current handle is not a collision with itself.
    if (owner && owner !== r.pid) {
      r.blocked = `handle "${r.handle}" is on the storefront, held by ${owner}`;
      newlyBlocked += 1;
    }
  }
  if (!newlyBlocked) { if (round) console.log(`handle blocking settled after ${round + 1} round(s)`); break; }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`enriched sneakers: ${named.length} · derived names: ${derived.size} · in this report: ${rows.length}`);
const dupNow = [...todayHandles.values()].filter((v) => v.length > 1);
console.log(`handles colliding TODAY among enriched products: ${dupNow.length} group(s), ${dupNow.reduce((t, v) => t + v.length, 0)} product(s)\n`);

for (const r of rows) {
  const mark = r.blocked ? "✗" : r.collidesToday ? "→" : "·";
  console.log(`${mark} ${r.pid}`);
  console.log(`    catalogue : ${JSON.stringify(r.product?.name || "")}`);
  console.log(`    before    : ${JSON.stringify(r.before)}  handle ${JSON.stringify(r.beforeHandle)}${r.collidesToday ? "   ← COLLIDES" : ""}`);
  console.log(`    after     : ${JSON.stringify(r.name)}  handle ${JSON.stringify(r.handle)}${r.level ? `  (escalated to tier ${r.level})` : ""}`);
  if (r.blocked) console.log(`    BLOCKED   : ${r.blocked}`);
}

// The proof, over whatever set was reported.
const seen = new Map();
for (const r of rows) {
  if (!seen.has(r.handle)) seen.set(r.handle, []);
  seen.get(r.handle).push(r.pid);
}
const stillDup = [...seen.entries()].filter(([, v]) => v.length > 1);
console.log(`\nAFTER: ${seen.size} distinct handle(s) for ${rows.length} product(s) — ` +
            (stillDup.length ? `STILL COLLIDING: ${stillDup.map(([h, v]) => `${h} (${v.join(",")})`).join(" · ")}` : "no duplicates"));

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to write the proposals.`);
  process.exit(stillDup.length ? 1 : 0);
}

// ── HANDING A PRODUCT BACK ───────────────────────────────────────────────────
// vision-name.mjs skips any node carrying an attribute-derived proposal, so
// that marker is a claim of OWNERSHIP. It was a one-way ratchet: a product this
// lane named once, and can no longer name — its attributes regressed, or it now
// collides irreducibly with another shoe and distinctNamesFor refuses it — was
// skipped by the prose namer for ever and re-derived by nobody. No namer at
// all, and nothing to notice it (adversarial review).
//
// So the claim is RELEASED here, through the mechanism that already exists for
// "this product needs a fresh name": the reconciler's nameRerunRequestedAt
// marker, which vision-name.mjs's --requested run consumes and clears. A
// distinct reason string keeps the two producers of that signal apart in the
// record.
//
// Scoped to the products this run could see: --pids and --collisions filter the
// OUTPUT, so a full run is what actually releases them, and a scoped run
// releases nothing it did not look at.
const handBack = [];
if (!onlyPids && !COLLISIONS_ONLY) {
  for (const [pid, p] of Object.entries(products)) {
    if (!p?.id || p.mergedInto || !isSneakerProduct(p)) continue;
    if (derived.has(pid)) continue;                        // still ours
    if (publish[pid]?.[NAME_PROPOSAL_KEY]?.source !== ATTRIBUTE_NAME_SOURCE) continue;
    handBack.push(pid);
  }
}
console.log(`\nhanding back to the prose namer: ${handBack.length} product(s) this lane can no longer name`);

let wrote = 0;
for (const r of rows) {
  if (r.blocked) continue;
  assertSafeSegment(r.pid, "productId");
  // STATE FIRST, PROPOSAL SECOND — the same ordering rule as vision-name.mjs,
  // and for the same reason: a node carrying a proposal and NO state is
  // invisible to the review page (every read is a server-filtered query on the
  // `state` index) and unwritable by it (the live .validate requires
  // hasChildren(['state'])). Decided against the SERVER in a transaction on the
  // `state` child alone, never against this run's snapshot — `undefined`
  // aborts, so an existing state of any value is left alone.
  await db.ref(`shopify_publish/${r.pid}/state`).transaction((cur) => (cur ? undefined : "awaiting"));
  await db.ref(`shopify_publish/${r.pid}`).update({
    [NAME_PROPOSAL_KEY]: {
      ...buildNameProposal({
        publicName: r.name, identity: null, previousName: r.before,
        model: null, at: admin.database.ServerValue.TIMESTAMP, attempts: 1,
      }),
      // Marked so the review page can tell an attribute-derived proposal from a
      // prose one at a glance, and so a later audit can find them.
      source: ATTRIBUTE_NAME_SOURCE,
      derivedFrom: { v: attrs[r.pid]?.v ?? null, tier: r.level },
    },
    nameRerunRequestedAt: null,
    nameRerunReason: null,
  });
  wrote += 1;
}
for (const pid of handBack) {
  assertSafeSegment(pid, "productId");
  await db.ref(`shopify_publish/${pid}`).update({
    nameRerunRequestedAt: admin.database.ServerValue.TIMESTAMP,
    nameRerunReason: "attribute namer can no longer name this product",
  });
}
console.log(`\nwrote ${wrote} proposal(s)${handBack.length ? ` · handed back ${handBack.length}` : ""}. ` +
            `PENDING — nothing is on the storefront until they are approved in the publishing page.`);
process.exit(0);
