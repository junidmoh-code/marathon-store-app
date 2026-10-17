// ─── GRANT: STORE ASSISTANT FOR ONE STORE, PER PERSON ────────────────────────
// Junid, 17 Oct 2026:
//   Yasmin → Store Assistant for Marathon PE only (placing orders), plus her
//            existing Card Slip scope (Marathon PE Till 2).
//   Amanda → Store Assistant for Trophy only (placing orders), plus her
//            existing Card Slip scope (Trophy Till 2).
//   Their POS access stays exactly as it is.
//
// THE SAME SIGN-IN: the store app and the POS both log in as
// {username}@marathon.internal with the password pin-{PIN} (src/utils/
// auth-utils.js, the POS's src/auth/auth-utils.js). One Firebase Auth user
// each; this script creates nothing and never touches a password.
//
// THE EXISTING ROLE AND THE EXISTING SCOPE, nothing new:
//   • role "store_assistant" with that role's preset, ROLE_DEFAULT_PERMS.
//     store_assistant (the "Place Orders" Store Assistant screen + Returns), and
//     permFlags derived from it in the SAME update() (permFlagsFor) so the
//     rules-readable mirror can never drift from the array;
//   • destShop = the shop's id ("marathon-pe" / "trophy"), the per-user scope
//     the live /orders read rule enforces (a destShop account may only query
//     orderByChild('destShop').equalTo(its own shop)), and the one the Store
//     Assistant screen, the order feed and Stock Audit follow.
// Any other store-app permission the account held is REPLACED by the preset —
// Junid's brief: the Store Assistant role, and no admin, Card Recon, policy or
// other store's screens. The previous values are written to a rollback file.
//
// LEFT EXACTLY AS THEY ARE: posAccess, stockRole (the POS's sale/return writes
// ride on it), cardSlipTills, storeIds, sections and everything else.
//
// The person must already have POS access to that shop's till system (its
// posId), or the script stops rather than guessing.
//
//   node scripts/staff/grant-store-assistant-one-store.mjs            # dry run
//   node scripts/staff/grant-store-assistant-one-store.mjs --execute  # write + read back
// Run it twice: the second run changes nothing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adminRequire } from "../adminRequire.mjs";
import { ROLE_DEFAULT_PERMS, permFlagsFor } from "../../src/components/permissionCatalog.js";
import { SEED_REGISTRY } from "../../src/utils/networkRegistry.js";

const admin = adminRequire(import.meta.url)("firebase-admin");
const EXECUTE = process.argv.includes("--execute");
const ROLE = "store_assistant";
const GRANTS = [
  { username: "yasmin", shopId: "marathon-pe", till: { storeId: "pe", tillId: "till-2" } },
  { username: "amanda", shopId: "trophy", till: { storeId: "trophy", tillId: "till-2" } },
];

const want = ROLE_DEFAULT_PERMS[ROLE];
if (!Array.isArray(want) || !want.includes("store_assistant")) {
  console.error(`✗ ROLE_DEFAULT_PERMS.${ROLE} is ${JSON.stringify(want)}: not the Store Assistant preset.`);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
// RTDB hands objects back with their keys sorted, so compare key-sorted.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v ?? null);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const asList = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);

const plan = [];
for (const g of GRANTS) {
  const shop = SEED_REGISTRY.locations?.[g.shopId];
  if (!shop || shop.type !== "store") fail(`${g.shopId}: not a store in the network registry.`);
  const email = `${g.username}@marathon.internal`;
  let user;
  try { user = await admin.auth().getUserByEmail(email); } catch { fail(`${email}: no such sign-in. Nothing was created.`); }
  if (user.disabled) fail(`${email} is disabled.`);
  // One person, one record: a targeted read, never the /users node.
  const rec = (await db.ref(`users/${user.uid}`).once("value")).val() || {};
  if (rec.posAccess?.isActive === false) fail(`${email}: POS access is switched off.`);
  const posStores = asList(rec.posAccess?.storeIds);
  // EXACTLY that one shop at the POS: destShop also scopes the POS's /orders
  // reads (the live rule), so a cashier who also works another shop's till
  // would lose order lookups there. An empty list means "every store".
  if (!posStores.length) fail(`${email} has POS access to every store; a one-store scope would break their POS order lookups elsewhere.`);
  if (posStores.length !== 1 || posStores[0] !== shop.posId) fail(`${email} has POS access to [${posStores.join(", ")}], not to ${shop.name} ("${shop.posId}") alone.`);
  // stockRole is kept for the POS, but admin / warehouse would keep the store
  // app's Stock, Health, Shopify and TV Ad screens open: stop and ask instead.
  if (rec.stockRole && !["pos", "store"].includes(rec.stockRole)) fail(`${email} has stockRole "${rec.stockRole}", which opens stock screens beyond Store Assistant. Not changed.`);
  // The POS's Card Recon tab reads permFlags.card_recon: never drop it unseen.
  if (asList(rec.permissions).includes("card_recon") || rec.permFlags?.card_recon) fail(`${email} holds card_recon (the POS's Card Recon tab). Not changed.`);
  if (rec.cardSlipTills?.[g.till.storeId]?.[g.till.tillId] !== true) fail(`${email}: the Card Slip scope ${g.till.storeId}/${g.till.tillId} is missing — run scripts/cardrecon/grant-card-slip-tills.mjs first.`);

  const patch = { role: ROLE, permissions: [...want], permFlags: permFlagsFor(want), destShop: g.shopId };
  // A POS-made account has no store-app name: give it the POS one, never overwrite.
  if (!rec.username) patch.username = g.username;
  if (!rec.displayName) patch.displayName = rec.posAccess?.displayName ? rec.posAccess.displayName.charAt(0).toUpperCase() + rec.posAccess.displayName.slice(1) : g.username;
  const changes = Object.fromEntries(Object.entries(patch).filter(([k, v]) => !same(rec[k], v)));
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, rec[k] ?? null]));
  plan.push({ ...g, email, uid: user.uid, shopName: shop.name, patch, changes, before, kept: { posAccess: rec.posAccess ?? null, stockRole: rec.stockRole ?? null, cardSlipTills: rec.cardSlipTills ?? null, storeIds: rec.storeIds ?? null } });
}

console.log(EXECUTE ? "GRANTING:" : "Would grant (dry run):");
for (const p of plan) {
  console.log(`\n• ${p.email} (${p.uid}) → Store Assistant, ${p.shopName} only`);
  if (!Object.keys(p.changes).length) { console.log("    already exactly so — nothing to write"); continue; }
  for (const [k, v] of Object.entries(p.changes)) console.log(`    ${k}: ${JSON.stringify(p.before[k])}  →  ${JSON.stringify(v)}`);
  console.log(`    kept as is: stockRole ${JSON.stringify(p.kept.stockRole)}, posAccess ${JSON.stringify(p.kept.posAccess)}, cardSlipTills ${JSON.stringify(p.kept.cardSlipTills)}, storeIds ${JSON.stringify(p.kept.storeIds)}`);
}

if (!EXECUTE) {
  console.log("\nDry run: nothing written. Re-run with --execute.");
  process.exit(0);
}

const todo = plan.filter((p) => Object.keys(p.changes).length);
if (todo.length) {
  const dir = path.join(os.homedir(), "marathon-rollbacks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `store-assistant-one-store-${new Date().toISOString().replace(/[:.]/g, "")}.json`);
  fs.writeFileSync(file, JSON.stringify(todo.map((p) => ({ uid: p.uid, email: p.email, restore: p.before })), null, 2), { mode: 0o600 });
  console.log(`\nRollback (previous values): ${file}`);
}
for (const p of todo) {
  // ONE update() per person: permissions and its permFlags mirror together.
  await db.ref(`users/${p.uid}`).update(p.patch);
}
let ok = true;
for (const p of plan) {
  const back = (await db.ref(`users/${p.uid}`).once("value")).val() || {};
  const good = Object.entries(p.patch).every(([k, v]) => same(back[k], v)) && same(back.posAccess, p.kept.posAccess) && same(back.stockRole, p.kept.stockRole) && same(back.cardSlipTills, p.kept.cardSlipTills);
  ok &&= good;
  console.log(`${good ? "✓" : "✗"} ${p.email}: role ${back.role}, permissions ${JSON.stringify(back.permissions)}, destShop ${back.destShop}; POS access, stockRole and Card Slip unchanged: ${good}`);
}
process.exit(ok ? 0 : 1);
