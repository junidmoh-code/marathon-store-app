// One-shot read-only probe, Phase 2 step 1-2 of the Hub 2 sneaker arming task.
import { adminRequire } from "./adminRequire.mjs";
const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

(async () => {
  const sneakers = (await db.ref("config/refillEngine/categoryPolicy/sneakers").once("value")).val();
  console.log("=== config/refillEngine/categoryPolicy/sneakers ===");
  console.log(JSON.stringify(sneakers, null, 2));

  const group = (await db.ref("config/refillEngine/policyGroups/footwear-all").once("value")).val();
  console.log("=== config/refillEngine/policyGroups/footwear-all ===");
  console.log(JSON.stringify(group, null, 2));

  process.exit(0);
})().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
