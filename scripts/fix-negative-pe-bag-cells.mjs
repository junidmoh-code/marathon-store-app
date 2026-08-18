// ─── THE THREE NEGATIVE PE BAG CELLS — STAGED (--execute TO APPLY) ────────────
//
// Marathon PE holds three negative /stock cells in category `bags`. A negative cell is
// a debt the books owe: the shop sold or shipped units the ledger says it did not have.
// Left alone they distort every count, every excess report and the confidence score,
// and they are the shape that made `shop_sneaker_negative_heal` necessary a month ago.
//
// ⚠ THEY ARE NOT ALL THE SAME PROBLEM, AND THEY DO NOT ALL GET THE SAME FIX.
// The obvious assumption — that all three are fallout from the 2026-08-15 PE → Trophy
// bags relocation — is true of exactly ONE of them. The ledger says so:
//
//  1. p1782635759411 "Under Amour cama flash bag", size `_`   PE −1, trophy 2
//     RELOCATION FALLOUT. 15 Aug 09:03 the relocation booked PE's 2 units to Trophy.
//     At 10:20 the SAME DAY, PE sold one — because it was still physically on PE's
//     floor. So Trophy holds ONE PHANTOM unit and PE owes one. Both errors are the
//     same unit, and correcting either alone would leave the other.
//     → PAIRED TRANSFER trophy → marathon-pe, qty 1. PE −1→0, trophy 2→1.
//       Nothing is invented; one unit stops existing in two places at once.
//
//  2. p1782640227755 "Nike black and gold bag", size L         PE −1, trophy has no L
//  3. p1782641125804 "Nike black and pink bag", size L         PE −1, nowhere holds L
//     NOT RELOCATION FALLOUT. Both L negatives were created in JUNE and JULY, weeks
//     before the relocation, by ordinary overselling: (2) received 2, sold 3, one
//     returned; (3) received 2, sold 3. The relocation moved these products' XL, never
//     their L. No location holds an L to pair against, because the unit genuinely left
//     the building and was never on the books.
//     → NEGATIVE-HEAL ADJUSTMENT +1 at marathon-pe. This does NOT create sellable
//       stock: it raises −1 to 0, clearing a phantom debt. Same shape and intent as
//       the live `health_negative_zero_fix` (89 records) and
//       `shop_sneaker_negative_heal` (443 records) corrections.
//
// WHY THE DISTINCTION MATTERS. Applying the paired transfer to (2) and (3) would fail
// outright — Trophy has no L to source and applyMovement's negative floor would refuse
// it. Applying a bare adjustment to (1) would clear PE's negative and LEAVE Trophy's
// phantom, quietly inflating Trophy by one bag for good. Each cell gets the correction
// its own history earns.
//
// ── EVERY QUANTITY IS DECLARED, NOT DERIVED (CodeRabbit, PR #379) ────────────
// The first version computed `after = live + delta` and verified `want = live ± qty`.
// Both halves read the world instead of asserting about it, and that is wrong for a
// correction whose whole justification is an audit of a SPECIFIC state:
//
//   • Applying a delta to whatever is live means a cell that drifted since the audit
//     still gets "corrected" — onto a baseline nobody reviewed. The 2026-08-17 audit
//     concluded "PE holds −1"; if PE now holds −3 the conclusion does not transfer,
//     and the script must decline and say so rather than move it to −2.
//   • The verification derived its expectation from the PRE-RUN snapshot, so a re-run
//     over an already-applied correction skipped the write (correctly, by movement id)
//     and then compared the already-corrected quantity against corrected-plus-delta.
//     A SUCCESSFUL re-run reported ⛔ MISMATCH. The idempotency claim in the header
//     was true of the write and false of the check that vouched for it.
//
// So each leg now declares `expectedBefore` and `expectedAfter` as literals from the
// audit. A leg is PENDING (live === expectedBefore), APPLIED (live === expectedAfter
// and the movement id exists) or DRIFTED (anything else → refused, nothing written).
// Verification compares the fresh quantity to `expectedAfter` ABSOLUTELY, so it is the
// same assertion on the first run and the fifth. `blocked` and `bad` both fail the
// exit code — a report nobody reads must still break a pipeline.
//
// ── WRITE SHAPE: applyMovement, REPRODUCED ───────────────────────────────────
// The Admin SDK bypasses the `v`+1 security rule, so nothing here is enforced for us —
// which is exactly why it is reproduced deliberately rather than approximated. Each
// correction is ONE atomic multi-path update() containing:
//   • stock_movements/{mvId}  the ledger record, with before/after per location
//   • per touched cell: qty, v (= old v + 1, or 0 if the cell is new), mv, lastType,
//     updatedAt, updatedBy
// Movement ids are deterministic, so a re-run never double-applies. What it repairs is
// narrower than "a partial failure", and the difference is worth stating (CodeRabbit,
// PR #379): a re-run RESUMES between corrections — if the run dies after the first
// lands, the rest still go — but there is nothing to repair WITHIN one, because its
// legs and its ledger record are a single atomic update that lands whole or not at all.
// A DRIFTED cell is never repaired by re-running; it is refused every time, by design.
//
// ── THE RACE, STATED HONESTLY (CodeRabbit, PR #379) ──────────────────────────
// The review asked for each cell to be committed conditionally against current server
// state. RTDB CANNOT DO THAT. `transaction()` is CAS on ONE node; a multi-path
// `update()` spanning three cells and a ledger record is atomic but UNCONDITIONAL.
// There is no primitive that is both. The choice is therefore:
//
//   (a) per-cell transactions — real CAS, but the ledger record lands in a separate
//       write, so a crash between them leaves a moved cell with no movement behind it.
//       That is the defect class this repo has paid for before, and it is worse than
//       the race it fixes: a lost update is visible in the next count, an unrecorded
//       movement is invisible forever.
//   (b) one atomic update per correction, guarded by a re-read as late as possible.
//
// (b) is taken. Immediately before each write the touched cells are re-read and must
// still hold `expectedBefore` AND the same `v` observed at staging; `v+1` is computed
// from that fresh read, never from the opening snapshot. That shrinks the window from
// "the whole /stock scan plus the report" to a single round trip, and any concurrent
// movement in that window bumps `v` and is caught.
//
// It does NOT close the window, and pretending otherwise would be the more dangerous
// bug. The residual is: a till committing between the guard read and the update. The
// mitigation is the same one the provenance backfill uses — RUN IT QUIET, outside
// trading hours — and the blast radius if it happens anyway is one bag cell, with the
// ledger record naming the exact before/after so it is reconstructable.
//
// Usage:
//   node scripts/fix-negative-pe-bag-cells.mjs             # match table, writes nothing
//   node scripts/fix-negative-pe-bag-cells.mjs --execute   # apply
//   FIX_MD=~/report.md node scripts/fix-negative-pe-bag-cells.mjs

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { homedir } from "os";
// The three questions this script has to get right are pure, so they live in a
// module with tests rather than inline where only healthy data ever exercises them.
import {
  classifyLeg, correctionState, guardDrift, verifyLeg, nextVersion, APPLIED, PENDING,
} from "./lib/negativeCellPlanCore.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const EXECUTE = process.argv.includes("--execute");
const LEDGER_REF = "bagneg-pe-2026-08-17";
const ACTOR = "scripts/fix-negative-pe-bag-cells.mjs";
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

// The three cells, named by pid — never by name. Each carries the correction its own
// ledger history earns, decided in the block comment above, not at runtime.
//
// `expectedBefore`/`expectedAfter` are the audited quantities, written as literals.
// They are the contract: if the world no longer matches, the audit no longer applies
// and this script declines rather than adapting. Re-audit and re-stage instead.
const PLAN = [
  {
    pid: "p1782635759411", sizeKey: "_", size: "_",
    kind: "paired-transfer", from: "trophy", to: "marathon-pe", qty: 1,
    legs: [
      { loc: "trophy",      delta: -1, expectedBefore:  2, expectedAfter: 1 },
      { loc: "marathon-pe", delta: +1, expectedBefore: -1, expectedAfter: 0 },
    ],
    reason: `${LEDGER_REF}: PE sold this bag on 2026-08-15 at 10:20, after the 09:03 bags_belts_trophy_owned relocation had already booked PE's units to Trophy. Trophy therefore holds one phantom unit and PE owes one. Paired transfer returns the single unit to the shop that sold it; no stock is created.`,
  },
  {
    pid: "p1782640227755", sizeKey: "L", size: "L",
    kind: "negative-heal", to: "marathon-pe", qty: 1,
    legs: [
      { loc: "marathon-pe", delta: +1, expectedBefore: -1, expectedAfter: 0 },
    ],
    reason: `${LEDGER_REF}: pre-existing oversell at Marathon PE (received 2, sold 3, one returned — all June/July 2026, before the 2026-08-15 relocation, which moved this product's XL and never its L). No location holds an L to pair against. Clears the phantom debt to zero; creates no sellable stock.`,
  },
  {
    pid: "p1782641125804", sizeKey: "L", size: "L",
    kind: "negative-heal", to: "marathon-pe", qty: 1,
    legs: [
      { loc: "marathon-pe", delta: +1, expectedBefore: -1, expectedAfter: 0 },
    ],
    reason: `${LEDGER_REF}: pre-existing oversell at Marathon PE (received 2, sold 3 — July 2026, before the 2026-08-15 relocation, which moved this product's XL and never its L). No location holds an L to pair against. Clears the phantom debt to zero; creates no sellable stock.`,
  },
];

const cellPath = (loc, pid, sizeKey) => `stock/${loc}/${pid}/${sizeKey}`;
const mvId = (p) => `${LEDGER_REF}_${p.pid}_${p.sizeKey}`;
const mvType = (p) => (p.kind === "paired-transfer" ? "transfer_out" : "adjustment");

const [stockSnap, productsSnap] = await Promise.all([
  db.ref("/stock").once("value"),
  db.ref("/products").once("value"),
]);
const stock = stockSnap.val() || {};
const products = productsSnap.val() || {};
const cellOf = (loc, pid, sk) => stock?.[loc]?.[pid]?.[sk] ?? null;
const qtyOf = (loc, pid, sk) => {
  const v = cellOf(loc, pid, sk)?.qty;
  return typeof v === "number" ? v : null;
};

// Has this correction already landed? The movement id is the only witness that
// survives a crash, so it — not the quantity — decides.
const appliedAlready = Object.fromEntries(
  await Promise.all(PLAN.map(async (p) => [
    p.pid, (await db.ref(`stock_movements/${mvId(p)}`).once("value")).exists(),
  ])),
);

say(`# Negative PE bag cells — ${EXECUTE ? "**EXECUTE**" : "STAGED (nothing written)"}`);
say();
say(`Ledger reference \`${LEDGER_REF}\`. Snapshot ${new Date().toISOString()}.`);
say();

// ── the match table ──────────────────────────────────────────────────────────
// Every leg is classified against the AUDITED numbers, not against a delta applied
// to whatever happens to be there.
say(`## Match table`);
say();
say(`| pid | name (display only) | size | correction | location | expected before | live now | expected after | state |`);
say(`|---|---|---|---|---|---|---|---|---|`);
let blocked = 0;
let alreadyApplied = 0;
const updates = [];
for (const p of PLAN) {
  const name = JSON.stringify(products[p.pid]?.name ?? null);
  const done = appliedAlready[p.pid];
  const states = [];
  for (const leg of p.legs) {
    const live = qtyOf(leg.loc, p.pid, p.sizeKey);
    const state = classifyLeg({
      live, expectedBefore: leg.expectedBefore, expectedAfter: leg.expectedAfter, movementExists: done,
    });
    states.push(state);
    const flag = state === PENDING || state === APPLIED ? state : `${state} ⛔`;
    say(`| \`${p.pid}\` | ${name} | ${p.sizeKey} | ${p.kind} | \`${leg.loc}\` | ${leg.expectedBefore} | ${live === null ? "(no cell)" : live} | ${leg.expectedAfter} | ${flag} |`);
  }

  const verdict = correctionState(states);
  if (verdict === "skip") { alreadyApplied += 1; updates.push({ p, id: mvId(p), skip: true }); continue; }
  if (verdict === "blocked") { blocked += 1; continue; }
  updates.push({ p, id: mvId(p), skip: false });
}
say();
if (blocked) {
  say(`⛔ **${blocked} correction(s) refused** — a cell no longer holds the quantity the 2026-08-17 audit`);
  say(`recorded, or its cell is missing. Nothing is written for those. The audit's conclusion does not`);
  say(`carry to a state it never examined: re-audit that cell and re-stage rather than forcing it.`);
  say();
}
if (alreadyApplied) {
  say(`ℹ️ ${alreadyApplied} correction(s) already applied (movement id present, quantities match \`expectedAfter\`).`);
  say(`They are re-verified below and never re-written.`);
  say();
}

say(`## What each correction does, and does not`);
say();
say(`- The **paired transfer** moves ONE existing unit from Trophy to PE. Network total unchanged.`);
say(`  Trophy's count drops by one because it was holding a unit that PE had already sold.`);
say(`- The **negative heals** raise a cell from −1 to 0. They add nothing sellable: a negative cell is`);
say(`  a debt, and clearing it to zero records that the debt is acknowledged, not that stock arrived.`);
say(`  Network sellable total is unchanged (a negative never counted as available — \`avail()\` clamps`);
say(`  it to 0 everywhere in the engine).`);
say();
say(`Only correction 1 is fallout from the 2026-08-15 relocation. Corrections 2 and 3 are older`);
say(`oversells that the relocation never touched — worth knowing before treating this as one incident.`);
say();

let bad = 0;
if (!EXECUTE) {
  say(`## Nothing written`);
  say();
  say("```bash");
  say(`node scripts/fix-negative-pe-bag-cells.mjs --execute`);
  say("```");
  say();
  say(`${updates.filter((u) => !u.skip).length} atomic update(s) staged. Movement ids are deterministic`);
  say(`(\`${LEDGER_REF}_{pid}_{sizeKey}\`), so a re-run NEVER doubles: each correction is one atomic`);
  say(`update, and one whose movement id is already present is skipped, not rewritten.`);
  say();
  say(`What a re-run does and does not repair — the distinction matters (CodeRabbit, PR #379):`);
  say();
  say(`- **Between corrections it resumes.** If the run dies after correction 1 lands, a re-run skips 1`);
  say(`  and applies the rest. That is the only "partial failure" this script can produce.`);
  say(`- **Within a correction there is nothing to repair.** Its legs and its ledger record are one`);
  say(`  atomic update, so it lands whole or not at all — a half-written correction is not a state`);
  say(`  that exists.`);
  say(`- **A DRIFTED cell is not repaired, deliberately.** If a quantity no longer matches the audit,`);
  say(`  a re-run refuses it every time rather than adapting. Clearing that needs a fresh audit, not`);
  say(`  another run.`);
  say();
  say(`Run it QUIET — see the race note in the header. The guard read narrows the window; only a shut`);
  say(`till closes it.`);
} else {
  say(`## Applying`);
  say();
  for (const u of updates) {
    const { p, id } = u;
    if (u.skip) { say(`- \`${p.pid}\`/${p.sizeKey}: already applied (\`${id}\`) — skipped`); continue; }

    // ── THE GUARD READ ───────────────────────────────────────────────────────
    // As late as possible before the write. Each cell must STILL hold the audited
    // quantity and the SAME `v` the match table saw. `v` is the discriminator that
    // catches a movement which happened to land on the same quantity.
    const fresh = await Promise.all(
      p.legs.map((leg) => db.ref(cellPath(leg.loc, p.pid, p.sizeKey)).once("value").then((s) => s.val())),
    );
    let drifted = null;
    p.legs.forEach((leg, i) => {
      if (drifted) return;
      drifted = guardDrift({
        staged: cellOf(leg.loc, p.pid, p.sizeKey),
        fresh: fresh[i],
        expectedBefore: leg.expectedBefore,
        loc: leg.loc,
      });
    });
    if (drifted) {
      blocked += 1;
      say(`- \`${p.pid}\`/${p.sizeKey}: ⛔ REFUSED at the guard read — ${drifted}. Nothing written.`);
      continue;
    }

    // Build the atomic payload from the FRESH read, reproducing applyMovement's shape.
    const now = new Date().toISOString();
    const before = {}, after = {};
    const upd = {};
    p.legs.forEach((leg, i) => {
      const cell = fresh[i];
      before[leg.loc] = leg.expectedBefore;
      after[leg.loc] = leg.expectedAfter;
      const path = cellPath(leg.loc, p.pid, p.sizeKey);
      upd[`${path}/qty`] = leg.expectedAfter;
      upd[`${path}/v`] = nextVersion(cell);
      upd[`${path}/mv`] = id;
      upd[`${path}/lastType`] = mvType(p);
      upd[`${path}/updatedAt`] = now;
      upd[`${path}/updatedBy`] = ACTOR;
    });
    upd[`stock_movements/${id}`] = {
      type: mvType(p),
      productId: p.pid, size: p.size, qty: p.qty,
      from: p.from ?? null, to: p.to ?? null,
      before, after,
      actor: ACTOR, actorRole: "admin",
      ts: now, appliedAt: now,
      reason: p.reason,
      link: { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null, correction: LEDGER_REF },
    };
    await db.ref().update(upd);
    say(`- \`${p.pid}\`/${p.sizeKey}: applied \`${id}\` (${Object.keys(upd).length} paths)`);
  }
  say();
  say(`## Verification`);
  say();
  // Absolute, against the declared expectation. Identical assertion on run 1 and run 5,
  // so an idempotent re-run reports ✅ rather than a phantom mismatch.
  const freshStock = (await db.ref("/stock").once("value")).val() || {};
  say(`| pid | size | location | qty now | expected after | |`);
  say(`|---|---|---|---|---|---|`);
  for (const { p } of updates) {
    for (const leg of p.legs) {
      const nowQty = freshStock?.[leg.loc]?.[p.pid]?.[p.sizeKey]?.qty ?? null;
      const okLeg = verifyLeg({ nowQty, expectedAfter: leg.expectedAfter });
      if (!okLeg) bad += 1;
      say(`| \`${p.pid}\` | ${p.sizeKey} | \`${leg.loc}\` | ${nowQty === null ? "(no cell)" : nowQty} | ${leg.expectedAfter} | ${okLeg ? "✅" : "⛔ MISMATCH"} |`);
    }
  }
  say();
  say(bad ? `⛔ ${bad} cell(s) do not match the expected value — investigate before doing anything else.`
          : `✅ every corrected cell holds the expected quantity.`);
}
say();
if (blocked || bad) {
  say(`**Exit status 1** — ${blocked} refused, ${bad} mismatched. Nothing downstream should treat this run as done.`);
}

if (process.env.FIX_MD) {
  const path = process.env.FIX_MD.replace(/^~/, homedir());
  writeFileSync(path, out.join("\n") + "\n");
  console.log(`\n[written] ${path}`);
}
process.exit(blocked || bad ? 1 : 0);
