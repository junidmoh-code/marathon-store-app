// ─── LOAD PERFUME STOCK INTO CENTRAL ─────────────────────────────────────────
// One-off receiving load for 20 perfumes, owner-supplied 2026-08-04. The
// products and their photos already exist; this only puts quantity on them.
//
//   node scripts/load-central-perfumes.mjs --dry-run    # resolve + plan, writes nothing
//   node scripts/load-central-perfumes.mjs --commit     # apply
//
// ── WHY A SCRIPT AND NOT THE APP ─────────────────────────────────────────────
// The app's Set Qty screen is the normal path and is exactly right for one or
// two lines. Twenty hand-typed quantities against a live ledger is where a
// slipped digit lands silently, so this does the same write the app does, from
// a checked-in list that can be diffed and re-read. It follows the house pattern
// set by scripts/sweep-shop-sneakers.mjs.
//
// ── WHAT IT WRITES — the same shape applyMovement produces ───────────────────
// ONE atomic multi-path update per line: the /stock cell AND its
// /stock_movements ledger entry together, never separately. Type `received`
// (goods arriving at the receiving warehouse), which is what the app writes when
// stock is received, and which the RTDB rules permit for a warehouse|admin role.
//
// ⚠️ THE ADMIN SDK BYPASSES RULES. Nothing validates this write server-side, so
// the shape is produced here deliberately and completely: qty, v+1, a fresh mv,
// lastType, updatedAt/By, plus the movement's before/after audit pair. Getting
// this wrong would create a cell the app's own optimistic-concurrency guard
// could never write to again.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//   • DRY RUN BY DEFAULT. --commit is required to write anything.
//   • ADDITIVE, and it says so. `received` adds to whatever is there. Every line
//     is reported as "0 → 83", so a re-run is visibly a second delivery, not an
//     idempotent no-op. Do not run it twice for one delivery.
//   • WRITE-TIME PRECONDITION. Each cell is re-read immediately before its write
//     and skipped if it moved since planning, so a concurrent sale or receive is
//     never clobbered. (Same guard the sneaker sweep needed after a live run.)
//   • EXACT-NAME RESOLUTION ONLY, case/punctuation-insensitive, and it must be
//     unique among perfumes. Anything ambiguous or missing aborts the whole run
//     before a single write — a perfume load that guesses is worse than none.

import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url).href);
const admin = require("firebase-admin");

const DRY = !process.argv.includes("--commit");

// Owner's delivery list, verbatim. Names are matched, not trusted as ids.
const DELIVERY = [
  ["Queen of Fire", 83],
  ["Marshmallow Blush", 32],
  ["Is Intense", 30],
  ["Cat Walk", 21],
  ["Amber D'or", 19],
  ["Barakat Aqua Stellar", 15],
  ["Rodriguez for Her", 12],
  ["Roses D'emotion", 10],
  ["Epic", 9],
  ["Adore", 7],
  ["Oud Imperious", 4],
  ["Eternal Oud", 4],
  ["Barakat Rouge 540", 3],
  ["Honeyed Fantasy", 3],
  ["Oud Mood", 3],
  ["Pandora Scents Roses Vanilla", 3],
  ["Madam Moiselle", 2],
  ["Hadia", 2],
  ["Khair Confection", 1],
  ["Just Choco", 1],
];

const DEST = "central";
// Perfume is one-size: the "_" sentinel, byte-identical to what the POS, the
// barcode catalogue and stockSizeKey() all use for a size-less line. A perfume
// written to any other key would be invisible to every one of them.
const SIZE_KEY = "_";
const ACTOR = "script:load-central-perfumes";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ── EXPLICIT ALIASES ─────────────────────────────────────────────────────────
// The delivery note and the catalogue disagree on spelling. Recorded here, one
// line per case, rather than loosening the matcher — a matcher that ignores
// spaces would also happily match names that merely look alike, and this list
// is auditable in a way a fuzzier rule is not.
//   "Cat Walk" → catalogue holds "Catwalk" (p1782762651779), verified the only
//                perfume matching once spaces/punctuation are ignored.
const ALIASES = { "Cat Walk": "Catwalk" };
const catalogueName = (given) => ALIASES[given] || given;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const main = async () => {
  const [products, central] = await Promise.all([
    db.ref("products").once("value").then((s) => s.val() || {}),
    db.ref(`stock/${DEST}`).once("value").then((s) => s.val() || {}),
  ]);

  // Perfume by CATEGORY — productType is absent on the live perfume records
  // (they predate it), so keying off it would match nothing.
  const perfumes = Object.entries(products).filter(
    ([, p]) => p && p.id && (p.category === "Perfume" || p.subcategory === "Perfume"));

  const plan = [];
  const problems = [];
  for (const [name, qty] of DELIVERY) {
    if (!Number.isInteger(qty) || qty <= 0) { problems.push(`${name}: qty ${qty} is not a positive whole number`); continue; }
    const want = catalogueName(name);
    const hits = perfumes.filter(([, p]) => norm(p.name) === norm(want));
    if (hits.length === 0) { problems.push(`${name}: no perfume with this name`); continue; }
    if (hits.length > 1) { problems.push(`${name}: ${hits.length} perfumes share this name (${hits.map(([id]) => id).join(", ")})`); continue; }
    const [pid, p] = hits[0];
    const cell = (central[pid] || {})[SIZE_KEY];
    const cur = Number(cell?.qty) || 0;
    plan.push({ pid, name: p.name, given: name, qty, cur, v: Number(cell?.v) || 0, exists: !!cell });
  }

  console.log(`\n${DRY ? "DRY RUN — nothing will be written" : "COMMIT — writing"}   dest=${DEST} size="${SIZE_KEY}"\n`);
  for (const r of plan) {
    const alias = norm(r.name) !== norm(r.given) ? `   [as "${r.given}"]` : "";
    console.log(`  ${r.name.padEnd(32)} ${String(r.cur).padStart(4)} → ${String(r.cur + r.qty).padStart(4)}  (+${r.qty})${r.exists ? "" : "   [new cell]"}${alias}`);
  }
  console.log(`\n  ${plan.length} lines · ${plan.reduce((t, r) => t + r.qty, 0)} units`);

  if (problems.length) {
    console.error(`\n✗ ABORTING — ${problems.length} unresolved:\n` + problems.map((p) => `    ${p}`).join("\n"));
    console.error("\n  Nothing was written. Fix the names (or the catalogue) and re-run.\n");
    process.exit(1);
  }
  if (DRY) { console.log("\n  Re-run with --commit to apply.\n"); return; }

  let done = 0, skipped = 0, failed = 0;
  for (const r of plan) {
    const path = `stock/${DEST}/${r.pid}/${SIZE_KEY}`;
    try {
      // Precondition: the cell must still hold what we planned against.
      const live = await db.ref(`${path}/qty`).once("value").then((x) => x.val());
      const cur = Number(live) || 0;
      if (cur !== r.cur) {
        console.warn(`  skip (changed under us): ${r.name} expected ${r.cur}, found ${cur}`);
        skipped++;
        continue;
      }
      // ⚠️ v ON A **NEW** CELL IS 0, NOT 1. applyMovement writes
      //   `cell && typeof cell.v === "number" ? cell.v + 1 : 0`
      // and the RTDB rule enforces exactly that:
      //   !data.exists() ? v === 0 : v === data.v + 1
      // The first version of this script did `liveV + 1` unconditionally, which
      // put v=1 on cells it created — a shape the rule would have REJECTED had
      // the Admin SDK not bypassed it. Harmless after the fact (v is a
      // monotonic counter; only the increment is ever compared, so subsequent
      // app writes still validate), but wrong, and exactly the class of mistake
      // the "bypasses rules" warning at the top of this file is about.
      const liveCell = await db.ref(path).once("value").then((x) => x.val());
      const newV = liveCell && typeof liveCell.v === "number" ? liveCell.v + 1 : 0;
      const ts = new Date().toISOString();
      const mvId = db.ref("stock_movements").push().key;
      const newQty = cur + r.qty;

      await db.ref().update({
        [`stock_movements/${mvId}`]: {
          type: "received",
          productId: r.pid,
          size: SIZE_KEY,
          qty: r.qty,
          from: null,
          to: DEST,
          before: { [DEST]: cur },
          after: { [DEST]: newQty },
          actor: ACTOR,
          actorRole: "admin",
          ts,
          appliedAt: ts,
          reason: "perfume_delivery_2026_08_04",
          link: { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null },
        },
        [`${path}/qty`]: newQty,
        [`${path}/v`]: newV,
        [`${path}/mv`]: mvId,
        [`${path}/lastType`]: "received",
        [`${path}/updatedAt`]: ts,
        [`${path}/updatedBy`]: ACTOR,
      });
      console.log(`  ✓ ${r.name.padEnd(32)} ${cur} → ${newQty}`);
      done++;
    } catch (e) {
      console.error(`  ✗ ${r.name}: ${e?.message || e}`);
      failed++;
    }
  }

  console.log(`\n  written ${done} · skipped ${skipped} · failed ${failed}\n`);
  // Non-zero exit on any failure: a partial load must not read as success.
  if (failed) process.exit(1);
};

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
