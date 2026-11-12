// ─── HUB 3 POLICY — GO LIVE (Junid, 9 Nov 2026) ──────────────────────────────
// HISTORICAL (9 Nov 2026). Superseded by apply-central-clothing-policy.mjs on
// 12 Nov 2026: setConcreteDivision now refuses the fromHub3/hub3Keep shape
// below, so running this fails. Kept as the record of what went live then.
// Through applyCategoryPolicy, the function the Engine Policy card calls, so
// each change has a history entry and a one-tap revert. Dry run by default.
//   1. the footwear-all group gains a Hub 3 leg: keep 3, ask at 1, seated only;
//   2. config/refillEngine/concreteDivision: the shop keeps, Hub 3 keep OFF.
//   node scripts/apply-hub3-policy.mjs            (dry run)
//   node scripts/apply-hub3-policy.mjs --apply
import { createRequire } from "module";
import { adminRequire } from "./adminRequire.mjs";
const req = adminRequire(import.meta.url);
const require = createRequire(import.meta.url);
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");
const { FOOTWEAR_GROUP_KEY } = require("../functions/lib/policy-resolve.cjs");

const APPLY = process.argv.includes("--apply");
const db = admin.database();
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const RUNNER = "script:apply-hub3-policy";
const call = (data) => applyCategoryPolicy({ db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: RUNNER, data, nowMs: Date.now() });

const live = (await db.ref(`config/refillEngine/policyGroups/${FOOTWEAR_GROUP_KEY}`).once("value")).val();
if (!live || live.armed !== true) throw new Error("the footwear-all group is not armed — stop");
if (live.policy.hub3) console.log("Hub 3 leg already present:", JSON.stringify(live.policy.hub3));
const group = { ...live, policy: { ...live.policy, hub3: { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true } } };
const division = { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } };

const g = await call({ action: "setGroup", groupKey: FOOTWEAR_GROUP_KEY, group, expectedBefore: live, dryRun: !APPLY });
console.log("group:", g.dryRun ? "DRY" : "APPLIED", JSON.stringify(g.after?.policy?.hub3 || null), g.historyId || "");
const liveDiv = (await db.ref("config/refillEngine/concreteDivision").once("value")).val();
const d = await call({ action: "setConcreteDivision", policy: division, expectedBefore: liveDiv ?? null, dryRun: !APPLY });
console.log("division:", d.dryRun ? "DRY" : (d.noChange ? "NO CHANGE" : "APPLIED"), JSON.stringify(d.after), d.historyId || "");
process.exit(0);
