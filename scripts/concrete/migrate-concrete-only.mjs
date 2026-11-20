// ─── MIGRATE listOnConcrete → concreteProduct (Junid, 20 Nov 2026) ───────────
// Junid decided a product marked Concrete is CONCRETE-ONLY. Every product with
// listOnConcrete:true and no concreteProduct field gets concreteProduct:true
// (+ SetBy/SetAt from the SERVER clock) and its /settings/concreteOnlyIndex
// entry; any that are live on Marathon get Marathon desiredState "off" with the
// "concrete_only" off record, which the Marathon reconciler applies.
//
//   node scripts/concrete/migrate-concrete-only.mjs                 # dry run: counts only
//   node scripts/concrete/migrate-concrete-only.mjs --commit        # write
//   node scripts/concrete/migrate-concrete-only.mjs --rollback FILE # put back exactly what FILE recorded
//
// SAFETY: /products is scanned in pages (orderByKey, 400 a page — never one
// whole-node read). Before writing, every candidate is RE-READ and drift-
// checked; a rollback snapshot of every field this run will touch is written
// to disk and READ BACK (parsed, counted) before the first write; each write
// is then post-verified. listOnConcrete is left exactly as it is (still read
// for one release). Admin SDK — rules do not apply, so the shapes here match
// what the rules would accept.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONCRETE_INDEX_PATH } from "../../src/utils/concreteListing.js";
import { needsMarathonOff, concreteOnlyOffFields, MARATHON_PUBLISH_PATH } from "../shopify/concreteOnly.mjs";

const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const ACTOR = "script:migrate-concrete-only";
const PAGE = 400;
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const rbIdx = args.indexOf("--rollback");
const ROLLBACK = rbIdx >= 0 ? args[rbIdx + 1] : null;
const ROLLBACK_DIR = join(homedir(), "Documents", "marathon-rollbacks");
const MARATHON_FIELDS = ["desiredState", "updatedAt", "updatedBy", "lastOff", "offLog"];

let offset = null;
async function serverNow() {
  if (offset == null) offset = Number((await db.ref(".info/serverTimeOffset").get()).val()) || 0;
  return Date.now() + offset;
}

/** A candidate: legacy-marked and never migrated. */
export const isCandidate = (p) => !!p && p.listOnConcrete === true && typeof p.concreteProduct !== "boolean";

async function scanCandidates() {
  const out = [];
  let last = null, scanned = 0;
  for (;;) {
    let q = db.ref("products").orderByKey().limitToFirst(PAGE + 1);
    if (last) q = q.startAt(last);
    const page = (await q.get()).val() || {};
    // startAt is inclusive: drop the key we already saw.
    const keys = Object.keys(page).sort().filter((k) => k !== last);
    if (!keys.length) break;
    for (const k of keys) { scanned++; if (isCandidate(page[k])) out.push({ pid: k, name: page[k].name || k }); }
    last = keys[keys.length - 1];
    if (keys.length < PAGE) break;
  }
  return { scanned, candidates: out };
}

const pick = (node, fields) => Object.fromEntries(fields.map((f) => [f, node?.[f] ?? null]));

async function rollback(file) {
  const snap = JSON.parse(readFileSync(file, "utf8"));
  console.log(`Rolling back ${snap.entries.length} product(s) from ${file}${COMMIT ? "" : " (dry run — add --commit)"}`);
  for (const e of snap.entries) {
    const u = {
      [`products/${e.pid}/concreteProduct`]: e.before.concreteProduct,
      [`products/${e.pid}/concreteProductSetBy`]: e.before.concreteProductSetBy,
      [`products/${e.pid}/concreteProductSetAt`]: e.before.concreteProductSetAt,
      [`${CONCRETE_INDEX_PATH}/${e.pid}`]: e.before.index,
    };
    if (e.marathonOff) for (const f of MARATHON_FIELDS) u[`${MARATHON_PUBLISH_PATH}/${e.pid}/${f}`] = e.marathonBefore[f];
    console.log(`  ${e.pid} ${e.name}${e.marathonOff ? " (+ Marathon intent restored)" : ""}`);
    if (COMMIT) await db.ref().update(u);
  }
  console.log(COMMIT ? "Rolled back." : "Dry run — nothing written.");
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);
  const { scanned, candidates } = await scanCandidates();
  // Marathon state per candidate (one scoped read each).
  const plan = [];
  for (const c of candidates) {
    const node = (await db.ref(`${MARATHON_PUBLISH_PATH}/${c.pid}`).get()).val();
    plan.push({ ...c, marathonOff: needsMarathonOff(node) });
  }
  const offCount = plan.filter((p) => p.marathonOff).length;
  console.log(`Scanned ${scanned} products. listOnConcrete:true and not yet migrated: ${plan.length}. Live on Marathon (will be switched off there): ${offCount}.`);
  for (const p of plan) console.log(`  ${p.pid}  ${p.name}${p.marathonOff ? "  ← live on Marathon" : ""}`);
  if (!COMMIT) { console.log("Dry run — nothing written. Re-run with --commit."); return; }
  if (!plan.length) { console.log("Nothing to migrate."); return; }

  // 1. Fresh re-read + drift check + snapshot.
  const entries = [];
  for (const p of plan) {
    const [prod, node, idx] = await Promise.all([
      db.ref(`products/${p.pid}`).get().then((s) => s.val()),
      db.ref(`${MARATHON_PUBLISH_PATH}/${p.pid}`).get().then((s) => s.val()),
      db.ref(`${CONCRETE_INDEX_PATH}/${p.pid}`).get().then((s) => s.val()),
    ]);
    if (!isCandidate(prod)) { console.log(`  drift: ${p.pid} changed since the scan — skipped`); continue; }
    entries.push({
      pid: p.pid, name: p.name,
      before: { concreteProduct: prod.concreteProduct ?? null, concreteProductSetBy: prod.concreteProductSetBy ?? null, concreteProductSetAt: prod.concreteProductSetAt ?? null, index: idx ?? null },
      marathonOff: needsMarathonOff(node),
      marathonBefore: pick(node, MARATHON_FIELDS),
      node,
    });
  }
  mkdirSync(ROLLBACK_DIR, { recursive: true });
  const file = join(ROLLBACK_DIR, `concrete-only-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), actor: ACTOR, entries: entries.map(({ node, ...e }) => e) }, null, 2));
  const back = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(back.entries) || back.entries.length !== entries.length) throw new Error(`rollback file did not read back (${file}) — nothing written`);
  console.log(`Rollback snapshot: ${file} (${back.entries.length} entries, read back OK)`);

  // 2. Write, one product per multi-path update, 3. post-verify.
  let ok = 0, off = 0;
  for (const e of entries) {
    const at = await serverNow();
    const u = {
      [`products/${e.pid}/concreteProduct`]: true,
      [`products/${e.pid}/concreteProductSetBy`]: ACTOR,
      [`products/${e.pid}/concreteProductSetAt`]: at,
      [`${CONCRETE_INDEX_PATH}/${e.pid}`]: true,
    };
    if (e.marathonOff) {
      for (const [k, v] of Object.entries(concreteOnlyOffFields(e.node, { at, actor: ACTOR }))) u[`${MARATHON_PUBLISH_PATH}/${e.pid}/${k}`] = v;
    }
    await db.ref().update(u);
    const [cp, idx, ds] = await Promise.all([
      db.ref(`products/${e.pid}/concreteProduct`).get().then((s) => s.val()),
      db.ref(`${CONCRETE_INDEX_PATH}/${e.pid}`).get().then((s) => s.val()),
      e.marathonOff ? db.ref(`${MARATHON_PUBLISH_PATH}/${e.pid}/desiredState`).get().then((s) => s.val()) : Promise.resolve("off"),
    ]);
    if (cp === true && idx === true && ds === "off") { ok++; if (e.marathonOff) off++; console.log(`  ✓ ${e.pid} ${e.name}${e.marathonOff ? " — Marathon switched off" : ""}`); }
    else console.error(`  ✗ ${e.pid} did not verify (concreteProduct=${cp}, index=${idx}, marathon desired=${ds})`);
  }
  console.log(`Migrated ${ok}/${entries.length}. Marathon off intents written: ${off}. Rollback: node scripts/concrete/migrate-concrete-only.mjs --rollback ${file} --commit`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
