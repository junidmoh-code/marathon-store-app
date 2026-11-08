// Junid, 8 Nov 2026: Concrete Till 2 (0000OF1Y) stays active; it is only quiet
// because the shop is new. Puts its row back on the SimplyBLU pull and removes
// the `foldInto` set earlier that day. Dry run unless --execute.
import { adminRequire } from "../adminRequire.mjs";
const admin = adminRequire(import.meta.url)("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "marathon-club", databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const EXECUTE = process.argv.includes("--execute");
const path = "config/cardTerminals/00000F1Y";
const cur = (await db.ref(path).once("value")).val();
if (!cur || cur.storeId !== "concrete" || cur.bank !== "standard-bank") { console.log("not the expected row; nothing written"); process.exit(1); }
console.log(`${cur.label}: source ${cur.source} -> portal, foldInto ${cur.foldInto ?? "none"} -> none${EXECUTE ? "" : " (dry run)"}`);
if (EXECUTE) {
  await db.ref(path).update({ source: "portal", foldInto: null });
  const back = (await db.ref(path).once("value")).val();
  const ok = back?.source === "portal" && back?.foldInto === undefined;
  console.log(`${ok ? "✓" : "✗"} read back: source=${back?.source} foldInto=${back?.foldInto ?? "none"}`);
  process.exit(ok ? 0 : 1);
}
process.exit(0);
