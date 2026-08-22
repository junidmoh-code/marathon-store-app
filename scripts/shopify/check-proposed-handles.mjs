// ── HANDLE COLLISION CHECK FOR A BATCH OF NAME PROPOSALS ─────────────────────
//   node scripts/shopify/check-proposed-handles.mjs --pids p1,p2,…
//   node scripts/shopify/check-proposed-handles.mjs --pids-file the139.pids
//   node scripts/shopify/check-proposed-handles.mjs --pids-file x --json out.json
//
// READ-ONLY. Nothing is written, on Shopify or in RTDB, and nothing is
// published.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Shopify derives nothing: reconcile.mjs sets the handle EXPLICITLY from the
// clean title (compliance.mjs buildHandle). So two products whose titles slug
// to the same string are two products fighting over one URL. Shopify resolves
// that fight by silently appending "-1", which means the collision does not
// fail — it succeeds, quietly, and the product Junid thought he was linking to
// is at a different address than the one he reads off the report.
//
// A re-naming batch is exactly where this bites. The old names were unique
// because they carried brand and model words; strip those out and "Arsenal Fly
// Emirates Home Jersey Red" and "Arsenal Fly Emirates Jersey" both want to
// become something like "red-home-football-jersey". Trading a compliance
// problem for a collision problem is not a fix.
//
// ── WHAT IS CHECKED, AND AGAINST WHAT ────────────────────────────────────────
// Every proposed handle is checked against BOTH:
//
//   1. THE REST OF THE BATCH — including the batch against itself. A pair that
//      collides is reported once, naming both sides.
//   2. THE WHOLE LIVE CATALOGUE — every /shopify_publish node that has a
//      cleanName, not only the ones currently switched on. An OFF product
//      still owns its Shopify handle: the reconciler set it when the product
//      was created and turning a product off does not release the URL. A check
//      against on-only products would pass a batch that collides with 145
//      switched-off ones.
//
// A product's collision with ITSELF is not a collision — a proposal that slugs
// to the handle that product already has is the normal, quiet case.
import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const flags = process.argv.slice(2);
const arg = (n) => { const i = flags.indexOf(n); return i === -1 ? null : flags[i + 1]; };
const JSON_OUT = arg("--json");

let pids = [];
const pidsFile = arg("--pids-file");
if (pidsFile) pids = readFileSync(pidsFile, "utf8").split(/[,\s]+/).filter(Boolean);
else if (arg("--pids")) pids = arg("--pids").split(",").map((s) => s.trim()).filter(Boolean);
if (!pids.length) { console.error("need --pids or --pids-file"); process.exit(2); }

// The SAME transform reconcile.mjs applies. Duplicated here rather than
// imported because compliance.mjs pulls in the whole push-payload builder for
// a five-line slug; the shape is pinned by shopifyTriggers' own tests and by
// social-select.test.cjs.
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// PAGED, never one whole-node read — /shopify_publish is 3,458 nodes.
const publish = await readMapPaged(db, "shopify_publish", { pageSize: 400 });

// ── The batch's proposed names ───────────────────────────────────────────────
const batch = [];
const missing = [];
for (const pid of pids) {
  const node = publish[pid];
  const proposal = node?.nameProposal;
  if (!proposal || !proposal.name) { missing.push(pid); continue; }
  batch.push({
    pid,
    oldName: node.cleanName || null,
    oldHandle: node.cleanName ? slug(node.cleanName) : null,
    newName: proposal.name,
    newHandle: slug(proposal.name),
    status: proposal.status || null,
    identity: proposal.identity?.text || null,
  });
}

// ── Every handle the catalogue already owns ──────────────────────────────────
// Built from cleanName, which is what the reconciler slugs. A product in the
// batch is excluded from the incumbent map so it never collides with itself.
const inBatch = new Set(batch.map((b) => b.pid));
const incumbent = new Map();   // handle → [pid]
for (const [pid, node] of Object.entries(publish)) {
  if (inBatch.has(pid)) continue;
  if (!node?.cleanName) continue;
  const h = slug(node.cleanName);
  if (!h) continue;
  if (!incumbent.has(h)) incumbent.set(h, []);
  incumbent.get(h).push(pid);
}

// ── Collisions ───────────────────────────────────────────────────────────────
const withinBatch = new Map();
for (const b of batch) {
  if (!withinBatch.has(b.newHandle)) withinBatch.set(b.newHandle, []);
  withinBatch.get(b.newHandle).push(b);
}

const batchClashes = [...withinBatch.entries()].filter(([, rows]) => rows.length > 1);
const catalogueClashes = batch
  .filter((b) => incumbent.has(b.newHandle))
  .map((b) => ({ ...b, against: incumbent.get(b.newHandle) }));

// ── Compliance, re-checked against the CURRENT lexicon ───────────────────────
// The naming run validated each name as it was written. This re-checks the
// stored result, because the two can disagree: a lexicon extended between the
// run and now would refuse a name that passed at the time, and that is exactly
// the situation this batch exists to fix. Checking the stored value is the
// only check that reflects what would actually be pushed.
const dirty = batch
  .map((b) => ({ ...b, hits: triggersInText(b.newName) }))
  .filter((b) => b.hits.length);

// Structural rules validatePayload also enforces on a title.
const malformed = batch.filter((b) =>
  !b.newHandle ||
  /^\d/.test(b.newName.trim()) ||
  b.newName.trim().length < 3 ||
  b.newName.trim().length > 80 ||
  !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.newHandle));

console.log(`
══ PROPOSED HANDLE CHECK ══
batch:                 ${pids.length} product(s) asked for
proposals found:       ${batch.length}
no proposal yet:       ${missing.length}${missing.length ? ` — ${missing.join(", ")}` : ""}
catalogue handles:     ${incumbent.size} distinct, from ${publish ? Object.keys(publish).length : 0} publish nodes
`);

if (batchClashes.length) {
  console.log(`✗ ${batchClashes.length} collision(s) INSIDE the batch:`);
  for (const [handle, rows] of batchClashes) {
    console.log(`   /${handle}`);
    for (const r of rows) console.log(`      ${r.pid}  "${r.newName}"   (was: ${r.oldName})`);
  }
  console.log();
} else {
  console.log("✓ no two products in the batch want the same handle\n");
}

if (catalogueClashes.length) {
  console.log(`✗ ${catalogueClashes.length} collision(s) with the EXISTING catalogue:`);
  for (const c of catalogueClashes) {
    console.log(`   ${c.pid}  "${c.newName}"  →  /${c.newHandle}`);
    for (const other of c.against) {
      console.log(`      already taken by ${other}  "${publish[other].cleanName}"  (${publish[other].liveState || publish[other].state})`);
    }
  }
  console.log();
} else {
  console.log("✓ no proposed handle is already taken by another product\n");
}

if (dirty.length) {
  console.log(`✗ ${dirty.length} proposed name(s) STILL carry a brand mark:`);
  for (const d of dirty) console.log(`   ${d.pid}  "${d.newName}"  — ${d.hits.join(", ")}`);
  console.log();
} else {
  console.log("✓ every proposed name is clean against the current lexicon\n");
}

if (malformed.length) {
  console.log(`✗ ${malformed.length} proposed name(s) break a structural rule:`);
  for (const m of malformed) console.log(`   ${m.pid}  "${m.newName}"  →  /${m.newHandle}`);
  console.log();
}

const clean = batch.filter((b) =>
  !dirty.some((d) => d.pid === b.pid) &&
  !malformed.some((m) => m.pid === b.pid) &&
  !catalogueClashes.some((c) => c.pid === b.pid) &&
  !batchClashes.some(([, rows]) => rows.length > 1 && rows.some((r) => r.pid === b.pid)));

console.log(`${clean.length} of ${pids.length} are ready to re-publish.`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    checkedAt: new Date().toISOString(),
    asked: pids.length,
    batch, missing,
    batchClashes: batchClashes.map(([handle, rows]) => ({ handle, pids: rows.map((r) => r.pid) })),
    catalogueClashes, dirty, malformed,
    clean: clean.map((c) => ({ pid: c.pid, oldName: c.oldName, newName: c.newName, handle: c.newHandle })),
  }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
process.exit(0);
