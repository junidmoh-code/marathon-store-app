// ─── 2 NOV 2026 — EFT MATCHING ENFORCED AT CONCRETE ──────────────────────────
// Junid: every EFT at Concrete must be a system-confirmed, matched payment,
// exactly like Trophy and Marathon PE — no "EFT without matching" there.
//
// The enforced set is CONFIG (functions/lib/eft-enforce.cjs): the node
// /eft_enforcement { stores: { … }, updatedAt, updatedBy }, which the
// eftEnforcementStatus callable serves to every till (marathon-pos-app
// src/sale/eftEnforcement.js asks it, caches the answer, and removes the
// "without matching" button where it says enforced). The live node already
// names Concrete — as false, set by Junid on 17 Oct 2026. This flips that one
// flag, MERGING the way the owner's "set" does (enforcementUpdateOf + merge
// over what is there): Trophy and Marathon PE are never touched, and a store
// someone else added in the meantime survives.
//
//   node scripts/cardrecon/apply-eft-enforcement-concrete-20261102.mjs            # dry run
//   node scripts/cardrecon/apply-eft-enforcement-concrete-20261102.mjs --execute
//
// Needs GOOGLE_APPLICATION_CREDENTIALS (an Admin SDK identity). One node read,
// one transaction; idempotent (a second run finds Concrete on and writes
// nothing).
import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

const admin = adminRequire(import.meta.url)("firebase-admin");
const local = createRequire(import.meta.url);
const { EFT_ENFORCEMENT_PATH, enforcedStoresOf, enforcementUpdateOf } = local("../../functions/lib/eft-enforce.cjs");

const EXECUTE = process.argv.includes("--execute");
const OWNER = "gunidmoh@gmail.com"; // the owner's change, as the callable records it
const STORE = "concrete";

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
// from the default set, exactly as the callable does.
const res = await ref.transaction((cur) => {
  const base = cur?.stores && typeof cur.stores === "object" ? cur.stores
    : Object.fromEntries(enforcedStoresOf(null).map((id) => [id, true]));
  return { stores: { ...base, [STORE]: true }, updatedAt: admin.database.ServerValue.TIMESTAMP, updatedBy: OWNER };
});
if (!res.committed) fail("the transaction did not commit — nothing changed.");
const after = (await ref.once("value")).val();
const enforced = enforcedStoresOf(after);
console.log(`after:  ${JSON.stringify(after.stores)} → enforced ${JSON.stringify(enforced)} (updatedAt ${new Date(after.updatedAt).toISOString()})`);
for (const id of ["trophy", "pe", STORE]) if (!enforced.includes(id)) fail(`${id} is not enforced after the write.`);
console.log("✓ Trophy, Marathon PE and Concrete enforce EFT matching.");
await admin.app().delete();
