// ─── 10 NOV 2026 — EFT MATCHING ENFORCED AT MARATHON PINE ────────────────────
// Junid: Pine is now on the POS and must be a system-approval-only EFT store,
// exactly like Trophy, Marathon PE and Concrete — staff cannot hand-enter an
// EFT and the till's "EFT without matching" path goes. Junid's own hand entry
// (owner-only at every store) still floats and a Pine till spends it once.
//
// The enforced set is CONFIG (functions/lib/eft-enforce.cjs): the node
// /eft_enforcement { stores: { … }, updatedAt, updatedBy }, served to every
// till by eftEnforcementStatus. The code default now names Pine too, but the
// live node is present, so the node is what decides — this sets stores/pine
// = true, MERGING the way the owner's "set" does: Trophy, Marathon PE and
// Concrete are never touched, and a store added in the meantime survives.
//
//   node scripts/cardrecon/apply-eft-enforcement-pine-20261110.mjs            # dry run
//   node scripts/cardrecon/apply-eft-enforcement-pine-20261110.mjs --execute
//
// Needs GOOGLE_APPLICATION_CREDENTIALS (an Admin SDK identity). One node read,
// one transaction; idempotent (a second run finds Pine on and writes nothing).
import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const admin = adminRequire(import.meta.url)("firebase-admin");
const local = createRequire(import.meta.url);
const { EFT_ENFORCEMENT_PATH, enforcedStoresOf, enforcementUpdateOf } = local("../../functions/lib/eft-enforce.cjs");

const EXECUTE = process.argv.includes("--execute");
const OWNER = "gunidmoh@gmail.com"; // the owner's change, as the callable records it
const STORE = "pine";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

const ref = db.ref(EFT_ENFORCEMENT_PATH);
const before = (await ref.once("value")).val();
console.log(`before: ${JSON.stringify(before?.stores ?? null)} → enforced ${JSON.stringify(enforcedStoresOf(before))}`);
if (before?.stores?.[STORE] === true) { console.log(`${STORE} is already enforced — nothing to do.`); process.exit(0); }
// Validated by the callable's own check (store id + boolean), with a
// placeholder time — the real one is the server's, below.
const check = enforcementUpdateOf({ stores: { [STORE]: true } }, { at: 0, by: OWNER });
if (!check.ok) fail(check.message);
if (!EXECUTE) { console.log(`Dry run — would set stores/${STORE} = true. Re-run with --execute.`); process.exit(0); }

// MERGE over the CURRENT node inside the transaction; a missing node starts
// from the default set, exactly as the callable does. Only stores/pine
// changes: every other flag already there is carried over untouched.
const res = await ref.transaction((cur) => {
  const base = cur?.stores && typeof cur.stores === "object" ? cur.stores
    : Object.fromEntries(enforcedStoresOf(null).map((id) => [id, true]));
  return { stores: { ...base, [STORE]: true }, updatedAt: admin.database.ServerValue.TIMESTAMP, updatedBy: OWNER };
});
if (!res.committed) fail("the transaction did not commit — nothing changed.");
const after = (await ref.once("value")).val();
const enforced = enforcedStoresOf(after);
console.log(`after:  ${JSON.stringify(after.stores)} → enforced ${JSON.stringify(enforced)} (updatedAt ${new Date(after.updatedAt).toISOString()})`);
for (const id of ["trophy", "pe", "concrete", STORE]) if (!enforced.includes(id)) fail(`${id} is not enforced after the write.`);
// Nothing else moved: every flag but Pine's is what it was before.
for (const [id, on] of Object.entries(before?.stores ?? {})) if (id !== STORE && after.stores[id] !== on) fail(`${id} changed (${on} → ${after.stores[id]}).`);
console.log("✓ Trophy, Marathon PE, Concrete and Pine enforce EFT matching; nothing else changed.");
await admin.app().delete();
