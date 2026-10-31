// ─── GRANT: ONE TILL'S DAILY CARD SLIP, PER PERSON ───────────────────────────
// Junid, 16 Oct 2026:
//   Yasmin → Marathon PE Till 2 only.
//   Amanda → Trophy Till 2 only.
// Junid, 31 Oct 2026: Amanda → Concrete Till 1 and Concrete Till 2 ONLY —
//   she sends Concrete's slips and is refused for Trophy Till 2 and every
//   other till. `only: true` makes the list her WHOLE scope: a till she holds
//   that is not in it is removed (and said, by name, before anything is
//   written). Her POS access is not touched.
//
// Writes /users/{uid}/cardSlipTills/{storeId}/{tillId} = true — the per-till
// scope the cardBatchCapture callable's "slip" action checks (functions/lib/
// card-slip-scope.cjs). /users is owner-write in the live rules, so this is the
// Admin SDK's job; no rule changes.
//
// NOTHING IS HARD-CODED BUT THE PEOPLE AND THE TILL NAMES:
//   • the till is found in /config/cardTerminals by the label of the placement
//     IN FORCE NOW (the till a machine stands at), and the grant is that
//     till's storeId/tillId — never a TID, so a swapped machine follows the till;
//   • the person is their existing sign-in ({username}@marathon.internal, the
//     store app's and the POS's own login), looked up one account at a time,
//     and must already have POS access to the till's store. A mismatch stops
//     the script rather than guessing.
//
// ONLY THIS ONE CHILD IS WRITTEN (update(), a single path per person). Their
// permissions, permFlags, posAccess and everything else on /users are left
// exactly as they are. Run it twice and the second run changes nothing.
//
//   node scripts/cardrecon/grant-card-slip-tills.mjs            # dry run
//   node scripts/cardrecon/grant-card-slip-tills.mjs --execute  # write + read back

import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const admin = adminRequire(import.meta.url)("firebase-admin");
// This checkout's own libs — the same ones the callable runs.
const local = createRequire(import.meta.url);
const { tillAt } = local("../../functions/lib/card-terminal-placements.cjs");
const { SLIP_SCOPE_FIELD, readSlipScope } = local("../../functions/lib/card-slip-scope.cjs");
const { loadNetwork } = local("../../functions/lib/network-load.cjs");
const { tillsFor } = local("../../functions/lib/network-registry.cjs");

const EXECUTE = process.argv.includes("--execute");
const GRANTS = [
  { username: "yasmin", tillLabels: ["Marathon Till 2"] },
  { username: "amanda", tillLabels: ["Concrete Till 1", "Concrete Till 2"], only: true },
];

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
const nowMs = Date.now() + offset;
const terminals = (await db.ref("config/cardTerminals").once("value")).val() || {};
// THE POS'S OWN TILLS (/network, the registry every till reads). A grant for a
// till the POS does not have would be a till nobody sells on — refused.
const network = await loadNetwork(db, { fresh: true });
const posHasTill = (storeId, tillId) => tillsFor(network, storeId).some((t) => t.tillId === tillId);
// Where every live machine stands now, "storeId/tillId".
const standing = new Set(Object.entries(terminals)
  .filter(([, row]) => row && !row.retiredAt)
  .map(([, row]) => { const t = tillAt(row, nowMs); return `${t.storeId}/${t.tillId}`; }));

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

const plan = [];
for (const g of GRANTS) {
  for (const tillLabel of g.tillLabels) {
  // THE TILL: the live registry, by where each machine stands now.
  const hits = Object.entries(terminals)
    .filter(([, row]) => row && !row.retiredAt)
    .map(([tid, row]) => ({ tid, ...tillAt(row, nowMs) }))
    .filter((t) => t.label === tillLabel);
  if (hits.length !== 1) fail(`"${tillLabel}": ${hits.length} machines stand at a till by that name — expected exactly one.`);
  const { storeId, tillId } = hits[0];
  // ONE IDENTITY PER TILL (18 Oct 2026): the id granted is the POS's own till
  // id, the one Card Recon draws the card under — or nothing is written.
  if (!posHasTill(storeId, tillId)) fail(`"${tillLabel}" stands at ${storeId}/${tillId}, which is not a till in the POS registry (/network) — refusing a grant that would never match a card.`);

  // THE PERSON: their existing sign-in, one lookup.
  const email = `${g.username}@marathon.internal`;
  let user;
  try { user = await admin.auth().getUserByEmail(email); } catch { fail(`${email}: no such sign-in. Nothing was created.`); }
  if (user.disabled) fail(`${email} is disabled.`);
  const rec = (await db.ref(`users/${user.uid}`).once("value")).val() || {};
  const posStores = Array.isArray(rec.posAccess?.storeIds) ? rec.posAccess.storeIds : Object.values(rec.posAccess?.storeIds || {});
  if (rec.posAccess?.isActive === false) fail(`${email}: POS access is switched off.`);
  if (!posStores.includes(storeId)) fail(`${email} has POS access to [${posStores.join(", ")}], not to "${storeId}" — will not grant ${tillLabel}.`);

  const before = readSlipScope(rec[SLIP_SCOPE_FIELD]);
  // A till already held that no machine stands at, or the POS does not know,
  // is said out loud (never silently kept as if it worked).
  for (const key of before) {
    const [s, t] = key.split("/");
    if (!standing.has(key) || !posHasTill(s, t)) console.error(`  ⚠ ${email} holds ${key}: ${!posHasTill(s, t) ? "not a POS till" : "no card machine stands there"} — fix the registry or remove it.`);
  }
  const want = `${storeId}/${tillId}`;
  plan.push({ ...g, tillLabel, email, uid: user.uid, name: rec.displayName || rec.posAccess?.displayName || g.username, storeId, tillId, before, already: before.includes(want) });
  }
}
// An `only` grant's tills are the person's WHOLE scope: anything else held goes.
const revoke = [];
for (const g of GRANTS.filter((x) => x.only)) {
  const mine = plan.filter((p) => p.username === g.username);
  const keep = new Set(mine.map((p) => `${p.storeId}/${p.tillId}`));
  for (const key of mine[0].before) if (!keep.has(key)) revoke.push({ uid: mine[0].uid, name: mine[0].name, email: mine[0].email, key });
}

console.log(`${EXECUTE ? "GRANTING" : "Would grant"} (live registry as at ${new Date(nowMs).toISOString()}):`);
for (const p of plan) {
  console.log(`  ${p.name} <${p.email}> uid ${p.uid}`);
  console.log(`     → ${p.tillLabel} = ${p.storeId}/${p.tillId}${p.already ? "   (already granted — no change)" : ""}`);
  if (p.before.length && !p.already && !p.only) console.log(`     (already holds: ${p.before.join(", ")} — kept)`);
}
for (const r of revoke) console.log(`  ${r.name} <${r.email}>\n     ✗ ${EXECUTE ? "REMOVING" : "would remove"} ${r.key} — not in her/his list (only)`);
if (!EXECUTE) { console.log("\nDry run — nothing written. Re-run with --execute."); process.exit(0); }

for (const p of plan) {
  if (p.already) continue;
  await db.ref(`users/${p.uid}/${SLIP_SCOPE_FIELD}/${p.storeId}/${p.tillId}`).set(true);
}
for (const r of revoke) await db.ref(`users/${r.uid}/${SLIP_SCOPE_FIELD}/${r.key}`).remove();
console.log("\nRead back:");
for (const p of plan) {
  const now = readSlipScope((await db.ref(`users/${p.uid}/${SLIP_SCOPE_FIELD}`).once("value")).val());
  const ok = now.includes(`${p.storeId}/${p.tillId}`) && !revoke.some((r) => r.uid === p.uid && now.includes(r.key))
    && (!p.only || now.length === plan.filter((x) => x.uid === p.uid).length);
  console.log(`  ${ok ? "✓" : "✗"} ${p.name} (${p.tillLabel}): ${now.join(", ") || "(none)"}`);
  if (!ok) process.exitCode = 1;
}
process.exit(process.exitCode || 0);
