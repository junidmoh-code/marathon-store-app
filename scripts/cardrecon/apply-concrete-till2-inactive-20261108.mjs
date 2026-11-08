// Junid, 8 Nov 2026: Concrete Till 2 (0000OF1Y) is not in use. Its row becomes
// source "inactive", with foldInto naming Till 1, so it is never a card in Card
// Recon, never "awaiting", never asked for a slip, and the one payment SimplyBLU
// lists on it (31 Oct, R750, rung on Till 1) counts on Till 1.
// Records already under it are kept, unshown. Dry run unless --execute.
import { adminRequire } from "../adminRequire.mjs";
const admin = adminRequire(import.meta.url)("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club", databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const EXECUTE = process.argv.includes("--execute");
const tid = "00000F1Y", into = "00000F2Y", set = { source: "inactive", foldInto: into };
const path = `config/cardTerminals/${tid}`;
const [cur, target] = await Promise.all([db.ref(path).once("value"), db.ref(`config/cardTerminals/${into}`).once("value")]).then((s) => s.map((x) => x.val()));
if (!cur || cur.storeId !== "concrete" || target?.storeId !== "concrete" || target?.source !== "portal") { console.log("not the expected rows — nothing written"); process.exit(1); }
console.log(`${tid} (${cur.label}): ${EXECUTE ? "SET" : "would set"} ${JSON.stringify(set)}`);
if (EXECUTE) {
  await db.ref(path).transaction((row) => (row && row.storeId === "concrete" ? { ...row, ...set } : undefined));
  const back = (await db.ref(path).once("value")).val();
  const ok = Object.entries(set).every(([k, v]) => back?.[k] === v);
  console.log(`${ok ? "✓" : "✗"} read back: source=${back?.source} foldInto=${back?.foldInto}`);
  process.exit(ok ? 0 : 1);
}
process.exit(0);
