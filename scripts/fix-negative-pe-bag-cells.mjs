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
// ── WRITE SHAPE: applyMovement, REPRODUCED ───────────────────────────────────
// The Admin SDK bypasses the `v`+1 security rule, so nothing here is enforced for us —
// which is exactly why it is reproduced deliberately rather than approximated. Each
// correction is ONE atomic multi-path update() containing:
//   • stock_movements/{mvId}  the ledger record, with before/after per location
//   • per touched cell: qty, v (= old v + 1, or 0 if the cell is new), mv, lastType,
//     updatedAt, updatedBy
// Movement ids are deterministic, so a re-run after a partial failure is idempotent
// rather than double-applied.
//
// Usage:
//   node scripts/fix-negative-pe-bag-cells.mjs             # match table, writes nothing
//   node scripts/fix-negative-pe-bag-cells.mjs --execute   # apply
//   FIX_MD=~/report.md node scripts/fix-negative-pe-bag-cells.mjs

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { homedir } from "os";

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
const PLAN = [
  {
    pid: "p1782635759411", sizeKey: "_", size: "_",
    kind: "paired-transfer", from: "trophy", to: "marathon-pe", qty: 1,
    reason: `${LEDGER_REF}: PE sold this bag on 2026-08-15 at 10:20, after the 09:03 bags_belts_trophy_owned relocation had already booked PE's units to Trophy. Trophy therefore holds one phantom unit and PE owes one. Paired transfer returns the single unit to the shop that sold it; no stock is created.`,
  },
  {
    pid: "p1782640227755", sizeKey: "L", size: "L",
    kind: "negative-heal", to: "marathon-pe", qty: 1,
    reason: `${LEDGER_REF}: pre-existing oversell at Marathon PE (received 2, sold 3, one returned — all June/July 2026, before the 2026-08-15 relocation, which moved this product's XL and never its L). No location holds an L to pair against. Clears the phantom debt to zero; creates no sellable stock.`,
  },
  {
    pid: "p1782641125804", sizeKey: "L", size: "L",
    kind: "negative-heal", to: "marathon-pe", qty: 1,
    reason: `${LEDGER_REF}: pre-existing oversell at Marathon PE (received 2, sold 3 — July 2026, before the 2026-08-15 relocation, which moved this product's XL and never its L). No location holds an L to pair against. Clears the phantom debt to zero; creates no sellable stock.`,
  },
];

const cellPath = (loc, pid, sizeKey) => `stock/${loc}/${pid}/${sizeKey}`;
const mvId = (p) => `${LEDGER_REF}_${p.pid}_${p.sizeKey}`;

const [stockSnap, productsSnap] = await Promise.all([
  db.ref("/stock").once("value"),
  db.ref("/products").once("value"),
]);
const stock = stockSnap.val() || {};
const products = productsSnap.val() || {};
const qtyOf = (loc, pid, sk) => {
  const v = stock?.[loc]?.[pid]?.[sk]?.qty;
  return typeof v === "number" ? v : null;
};

say(`# Negative PE bag cells — ${EXECUTE ? "**EXECUTE**" : "STAGED (nothing written)"}`);
say();
say(`Ledger reference \`${LEDGER_REF}\`. Snapshot ${new Date().toISOString()}.`);
say();

// ── the match table ──────────────────────────────────────────────────────────
say(`## Match table`);
say();
say(`| pid | name (display only) | size | correction | location | before | after |`);
say(`|---|---|---|---|---|---|---|`);
let blocked = 0;
const updates = [];
for (const p of PLAN) {
  const name = JSON.stringify(products[p.pid]?.name ?? null);
  const legs = p.kind === "paired-transfer"
    ? [{ loc: p.from, delta: -p.qty }, { loc: p.to, delta: +p.qty }]
    : [{ loc: p.to, delta: +p.qty }];

  const rows = [];
  let ok = true;
  for (const leg of legs) {
    const before = qtyOf(leg.loc, p.pid, p.sizeKey);
    if (before === null) { ok = false; rows.push({ ...leg, before: "(no cell)", after: "—" }); continue; }
    const after = before + leg.delta;
    // applyMovement's negative floor: only `sold` may drive a cell negative.
    if (leg.delta < 0 && after < 0) { ok = false; }
    rows.push({ ...leg, before, after });
  }
  for (const r of rows) {
    say(`| \`${p.pid}\` | ${name} | ${p.sizeKey} | ${p.kind} | \`${r.loc}\` | ${r.before} | ${r.after}${ok ? "" : " ⛔"} |`);
  }
  if (!ok) { blocked += 1; continue; }

  // Build the atomic payload, reproducing applyMovement's shape exactly.
  const now = new Date().toISOString();
  const id = mvId(p);
  const before = {}, after = {};
  const upd = {};
  for (const leg of legs) {
    const cell = stock?.[leg.loc]?.[p.pid]?.[p.sizeKey] || null;
    const cur = typeof cell?.qty === "number" ? cell.qty : 0;
    const next = cur + leg.delta;
    before[leg.loc] = cur;
    after[leg.loc] = next;
    const path = cellPath(leg.loc, p.pid, p.sizeKey);
    upd[`${path}/qty`] = next;
    upd[`${path}/v`] = typeof cell?.v === "number" ? cell.v + 1 : 0;
    upd[`${path}/mv`] = id;
    upd[`${path}/lastType`] = p.kind === "paired-transfer" ? "transfer_out" : "adjustment";
    upd[`${path}/updatedAt`] = now;
    upd[`${path}/updatedBy`] = ACTOR;
  }
  upd[`stock_movements/${id}`] = {
    type: p.kind === "paired-transfer" ? "transfer_out" : "adjustment",
    productId: p.pid, size: p.size, qty: p.qty,
    from: p.from ?? null, to: p.to ?? null,
    before, after,
    actor: ACTOR, actorRole: "admin",
    ts: now, appliedAt: now,
    reason: p.reason,
    link: { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null, correction: LEDGER_REF },
  };
  updates.push({ p, id, upd });
}
say();
if (blocked) {
  say(`⛔ **${blocked} correction(s) cannot be applied as planned** — a source cell is missing or would go`);
  say(`negative. Nothing is written for those; re-check the holdings before forcing anything.`);
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

if (!EXECUTE) {
  say(`## Nothing written`);
  say();
  say("```bash");
  say(`node scripts/fix-negative-pe-bag-cells.mjs --execute`);
  say("```");
  say();
  say(`${updates.length} atomic update(s) staged. Movement ids are deterministic`);
  say(`(\`${LEDGER_REF}_{pid}_{sizeKey}\`), so a re-run after a partial failure repairs rather than doubles.`);
} else {
  say(`## Applying`);
  say();
  for (const { p, id, upd } of updates) {
    // Idempotency: the movement id is the key. If it already landed, skip.
    const existing = await db.ref(`stock_movements/${id}`).once("value");
    if (existing.exists()) { say(`- \`${p.pid}\`/${p.sizeKey}: already applied (\`${id}\`) — skipped`); continue; }
    await db.ref().update(upd);
    say(`- \`${p.pid}\`/${p.sizeKey}: applied \`${id}\` (${Object.keys(upd).length} paths)`);
  }
  say();
  say(`## Verification`);
  say();
  const fresh = (await db.ref("/stock").once("value")).val() || {};
  say(`| pid | size | location | qty now | expected |`);
  say(`|---|---|---|---|---|`);
  let bad = 0;
  for (const { p } of updates) {
    const legs = p.kind === "paired-transfer" ? [p.from, p.to] : [p.to];
    for (const loc of legs) {
      const now = fresh?.[loc]?.[p.pid]?.[p.sizeKey]?.qty;
      const want = loc === p.to ? (qtyOf(loc, p.pid, p.sizeKey) + p.qty) : (qtyOf(loc, p.pid, p.sizeKey) - p.qty);
      if (now !== want) bad += 1;
      say(`| \`${p.pid}\` | ${p.sizeKey} | \`${loc}\` | ${now} | ${want}${now === want ? "" : " ⛔ MISMATCH"} |`);
    }
  }
  say();
  say(bad ? `⛔ ${bad} cell(s) do not match the expected value — investigate before doing anything else.`
          : `✅ every corrected cell holds the expected quantity.`);
}
say();

if (process.env.FIX_MD) {
  const path = process.env.FIX_MD.replace(/^~/, homedir());
  writeFileSync(path, out.join("\n") + "\n");
  console.log(`\n[written] ${path}`);
}
process.exit(blocked ? 1 : 0);
