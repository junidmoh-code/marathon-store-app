// ─── ARM THE PRODUCTS THAT ONLY SALES WERE REFILLING (Junid, 24 Oct 2026) ────
// Junid's rule: a refill request is raised ONLY by the scan comparing what is
// on hand against policy. Before sale-raised requests are switched off, every
// product/location that was being refilled ONLY by sales (no policy the scan
// would act on) is armed under the EXISTING category policy's numbers — so
// switching sales off loses nothing the scan could cover.
//
// Census (24 Oct, sale-raised lines: Hub 2 sneaker lines, last 6 days; shop
// clothing-sold lines, last 14 days): 681 product/location pairs, 653 already
// under a scan policy, 28 not. Of those 28 this script arms the 10 (11 with a pair that sold during the run) that an
// existing category policy fits; the rest are left and reported:
//   - 6 paper bags (PE/Trophy): Junid reversed the paper-bag policy (18 Oct) —
//     never re-armed without him
//   - 9 cells that DO resolve, to 0 (an explicit 0 or a size with no units
//     anywhere) — a decision, not a gap
//   - Bracelet, Necklace (no chains-bracelets policy anywhere) and a kids
//     soccer boot size 32 (the footwear map names no size 32) — no existing
//     policy to arm them under
//
// HOW: per-product target rows through the server's own writer
// (category-policy-write.cjs applyCategoryPolicy → setProductTargets): the
// same validation, drift check and engine_policy_history entry as the Engine
// Policy card. Per-product rows, NOT a new category location — arming bags at
// Marathon PE as a category would arm every paper bag there too (paper bags
// share every field with real bags; the name is the only signal).
//
//   node scripts/arm-sale-only-products.mjs            # dry run (default)
//   node scripts/arm-sale-only-products.mjs --execute  # snapshot, then write
import fs from "fs";
import os from "os";
import path from "path";
import { adminRequire } from "./adminRequire.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const EXECUTE = process.argv.includes("--execute");
// --rollback: remove exactly the rows this script wrote (source policy_target,
// prevAbsent, set from 11:41Z on 24 Oct — the writer stamps setBy with the admin email), through the same writer — the removal is in history too.
// Used 24 Oct 13:46: the Clothing-Sold tabs these 11 were counted from have not
// been mounted since 12 Jul (#202), so the products were never being refilled
// by sales and arming them would have ADDED scan requests nobody approved.
const ROLLBACK = process.argv.includes("--rollback");
// A rollback is live only with --execute as well (Sonnet architect, #787).
if (ROLLBACK && !EXECUTE) console.log("(--rollback without --execute: dry run)");
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const RUNNER = "arm-sale-only-products-20261024";

// The existing category policy each product is armed under, and its numbers
// at that shop (read live below and refused if they changed).
const PLAN = [
  { loc: "marathon-pe", pid: "p1786965136965", name: "Adidas bag dark Grey jp0146", under: "bags", from: "trophy" },
  { loc: "marathon-pe", pid: "p1786965270481", name: "Adidas bag Blue JP0146", under: "bags", from: "trophy" },
  { loc: "trophy", pid: "p1783323795780", name: "Versace Glasses", under: "sunglasses", from: "trophy" },
  { loc: "trophy", pid: "p1783323795787", name: "Dolce & Gabbana Glasses", under: "sunglasses", from: "trophy" },
  { loc: "trophy", pid: "p1783323795783", name: "Dior Glasses", under: "sunglasses", from: "trophy" },
  { loc: "trophy", pid: "p1783323795777", name: "Celine Glasses", under: "sunglasses", from: "trophy" },
  { loc: "trophy", pid: "p1783323795782", name: "Loewe Glasses", under: "sunglasses", from: "trophy" },
  { loc: "trophy", pid: "p1783323795785", name: "Hermès Glasses", under: "sunglasses", from: "trophy" },
  { loc: "trophy", pid: "p1783323795779", name: "Off-White Glasses", under: "sunglasses", from: "trophy" },
  { loc: "trophy", pid: "p1783322642153", name: "Belt", under: "belts", from: "trophy" },
  // Sold after the first census (24 Oct 13:40) — same category as the other glasses.
  { loc: "trophy", pid: "p1783323795778", name: "Emporio Armani Glasses", under: "sunglasses", from: "trophy" },
];

const get = async (p) => (await db.ref(p).get()).val();
const enc = (s) => String(s).replace(/[.#$/[\]\s]/g, "_");
const policy = (await get("config/refillEngine/categoryPolicy")) || {};
const plan = [];
for (const p of PLAN) {
  const entry = policy[p.under]?.[p.from];
  if (!entry || typeof entry.target !== "number") throw new Error(`${p.under} has no ${p.from} entry — refusing`);
  const product = await get(`products/${p.pid}`);
  if (!product) throw new Error(`${p.pid} missing`);
  if (product.name !== p.name) throw new Error(`${p.pid} is "${product.name}", expected "${p.name}" — refusing`);
  const sizes = (Array.isArray(product.sizes) && product.sizes.length ? product.sizes : ["_"]).map((s) => enc(s === "" ? "_" : s));
  const live = (await get(`stock_targets/${p.loc}/${p.pid}`)) || {};
  const rows = [], expected = {};
  for (const k of sizes) {
    expected[k] = live[k] ?? null;
    if (live[k]) continue;                          // never overwrite a row someone set
    const row = { sizeKey: k, target: entry.target, minQty: entry.minQty };
    if (typeof entry.reorderPoint === "number" && entry.reorderPoint < entry.target) row.reorderPoint = entry.reorderPoint;
    rows.push(row);
  }
  plan.push({ ...p, numbers: `${entry.target}/${entry.minQty}/${entry.reorderPoint ?? "-"}`, sizes, rows, expected, live });
}
console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} — ${plan.length} products`);
for (const p of plan) console.log(`  ${p.loc.padEnd(12)} ${p.name.padEnd(30)} under ${p.under} (${p.from} ${p.numbers}) sizes ${p.sizes.join(",")} → ${p.rows.length ? "arm" : "already has rows, skip"}`);
if (ROLLBACK) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(os.homedir(), "marathon-rollbacks", `arm-sale-only-products-ROLLBACK-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stock_targets-before.json"), JSON.stringify(Object.fromEntries(plan.map((p) => [`stock_targets/${p.loc}/${p.pid}`, p.live])), null, 2));
  const out = [];
  for (const p of plan) {
    // Exactly the rows this run wrote: our source, no previous row, the
    // writer's admin stamp, and set inside the 24 Oct arming minutes — never
    // a row the Engine Policy card wrote later on the same product.
    const mine = Object.entries(p.live).filter(([, r]) => r && r.source === "policy_target" && r.prevAbsent === true
      && r.setBy === ADMIN_EMAIL && String(r.setAt || "") >= "2026-10-24T11:41:00" && String(r.setAt || "") < "2026-10-24T11:45:00").map(([k]) => k);
    if (!EXECUTE) { out.push({ pid: p.pid, wouldRemove: mine }); console.log(`  would remove ${p.loc} ${p.name} ${mine.join(",") || "(nothing)"}`); continue; }
    if (!mine.length) { out.push({ pid: p.pid, skipped: "no row written by this script" }); continue; }
    const expected = Object.fromEntries(mine.map((k) => [k, p.live[k]]));
    const res = await applyCategoryPolicy({ db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: RUNNER, nowMs: Date.now(),
      data: { action: "setProductTargets", loc: p.loc, pid: p.pid, rows: [], remove: mine, expected } });
    const after = await get(`stock_targets/${p.loc}/${p.pid}`);
    out.push({ loc: p.loc, pid: p.pid, name: p.name, removed: mine, historyId: res?.historyId ?? null, after });
    console.log(`  removed ${p.loc} ${p.name} ${mine.join(",")} → history ${res?.historyId ?? JSON.stringify(res).slice(0, 60)}; now ${JSON.stringify(after)}`);
  }
  fs.writeFileSync(path.join(dir, "rollback-log.json"), JSON.stringify(out, null, 2));
  console.log(`log: ${path.join(dir, "rollback-log.json")}`);
  process.exit(0);
}
if (!EXECUTE) process.exit(0);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(os.homedir(), "marathon-rollbacks", `arm-sale-only-products-${stamp}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "stock_targets-before.json"), JSON.stringify(Object.fromEntries(plan.map((p) => [`stock_targets/${p.loc}/${p.pid}`, p.live])), null, 2));
console.log(`snapshot: ${path.join(dir, "stock_targets-before.json")}`);
const log = [];
for (const p of plan) {
  if (!p.rows.length) { log.push({ ...p, skipped: "already has rows" }); continue; }
  const res = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: RUNNER, nowMs: Date.now(),
    data: { action: "setProductTargets", loc: p.loc, pid: p.pid, rows: p.rows, remove: [], expected: p.expected },
  });
  const after = await get(`stock_targets/${p.loc}/${p.pid}`);
  log.push({ loc: p.loc, pid: p.pid, name: p.name, under: p.under, numbers: p.numbers, historyId: res?.historyId ?? res?.id ?? null, after });
  console.log(`  armed ${p.loc} ${p.name} → history ${res?.historyId ?? res?.id ?? JSON.stringify(res).slice(0, 80)}`);
}
fs.writeFileSync(path.join(dir, "arm-log.json"), JSON.stringify(log, null, 2));
console.log(`log: ${path.join(dir, "arm-log.json")}`);
process.exit(0);
