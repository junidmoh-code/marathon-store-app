// ─── CENTRAL SUPPLIES PINE/CONCRETE CLOTHING; HUB 3 SNEAKERS ONLY — GO LIVE ──
// Junid, 12 Nov 2026. Through applyCategoryPolicy, the function the Engine
// Policy card calls, so each change has a history entry. Dry run by default.
//   1. the footwear-all group's Hub 3 leg: keep 2, ask at 1, seated only
//      (was 3 / ask 1). Every other leg of the group is carried over untouched
//      and checked equal before anything is written;
//   2. config/refillEngine/concreteDivision = { shopOnly: { perSize: 2, oneSize: 5 } }
//      (the from-Hub 3 keep and the Hub 3 keep with its switch are removed).
// The two are applied separately (12 Nov 2026): the division key alone leaves
// the Marathon plan byte-for-byte unchanged; the Hub 3 leg does not — Hub 3's
// open locks shrink to the new keep and the Central units they free can be
// asked for by Hub 2 (one pair in the 12 Nov snapshot). That one is Junid's call.
//   node scripts/apply-central-clothing-policy.mjs                       (dry run, both)
//   node scripts/apply-central-clothing-policy.mjs --apply --division    the key only
//   node scripts/apply-central-clothing-policy.mjs --apply --hub3-leg    the Hub 3 leg only
import { createRequire } from "module";
import { adminRequire } from "./adminRequire.mjs";
const req = adminRequire(import.meta.url);
const require = createRequire(import.meta.url);
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");
const { FOOTWEAR_GROUP_KEY } = require("../functions/lib/policy-resolve.cjs");
const { planCentralClothingPolicy } = require("./lib/centralClothingPolicy.cjs");

const APPLY = process.argv.includes("--apply");
const DO_DIVISION = !APPLY || process.argv.includes("--division");
const DO_LEG = !APPLY || process.argv.includes("--hub3-leg");
if (APPLY && !DO_DIVISION && !DO_LEG) throw new Error("--apply needs --division and/or --hub3-leg");
const db = admin.database();
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const RUNNER = "script:apply-central-clothing-policy";
const call = (data) => applyCategoryPolicy({ db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: RUNNER, data, nowMs: Date.now() });

const liveGroup = (await db.ref(`config/refillEngine/policyGroups/${FOOTWEAR_GROUP_KEY}`).once("value")).val();
const liveDivision = (await db.ref("config/refillEngine/concreteDivision").once("value")).val();
const plan = planCentralClothingPolicy({ liveGroup, liveDivision });
console.log("Hub 3 leg:", JSON.stringify(liveGroup?.policy?.hub3 ?? null), "->", JSON.stringify(plan.group.policy.hub3));
console.log("division:", JSON.stringify(liveDivision), "->", JSON.stringify(plan.division));

if (!DO_LEG) console.log("group: not asked for (--hub3-leg)");
else if (plan.groupChanges) {
  const g = await call({ action: "setGroup", groupKey: FOOTWEAR_GROUP_KEY, group: plan.group, expectedBefore: liveGroup, dryRun: !APPLY });
  console.log("group:", g.dryRun ? "DRY" : "APPLIED", JSON.stringify(g.after?.policy?.hub3 || null), g.historyId || "");
} else console.log("group: already at the new Hub 3 leg");
if (DO_DIVISION) {
  const d = await call({ action: "setConcreteDivision", policy: plan.division, expectedBefore: liveDivision ?? null, dryRun: !APPLY });
  console.log("division:", d.dryRun ? "DRY" : (d.noChange ? "NO CHANGE" : "APPLIED"), JSON.stringify(d.after), d.historyId || "");
} else console.log("division: not asked for (--division)");
process.exit(0);
