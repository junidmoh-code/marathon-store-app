// ─── PINE'S DISPLAY CHECK — ON, FROM THE SALES OF 23 NOV 2026 (Junid, 22 Nov 2026)
// Pine's display check was off because no switch had ever been written for it:
// a shop follows the registry's "fully live" flag unless
// /displayChecks_settings/{shop}/enabled says otherwise, and Pine is not fully
// live. This writes Pine's three small settings in ONE multi-path update, so a
// sale can never see enabled without its start day (the roster and cover beside
// them are never touched):
//     /displayChecks_settings/marathon-pine/enabled  = true
//     /displayChecks_settings/marathon-pine/scope    = "all_but_sneakers"
//     /displayChecks_settings/marathon-pine/startsOn = "2026-11-23"
// The triggers (onDisplaySale, onClothingSale) then raise a display check for
// every Pine sale made on or after the start day, sneakers and slides apart.
// Nothing sold before it becomes a task. DEPLOY THE TWO TRIGGERS FIRST: an
// older build does not read startsOn and would start with tonight's sales.
// Dry run by default.
//   node scripts/display/pine-display-check-on.mjs            (dry run)
//   node scripts/display/pine-display-check-on.mjs --apply
//   node scripts/display/pine-display-check-on.mjs --apply --off   back to how it was
import { adminRequire } from "../adminRequire.mjs";
const req = adminRequire(import.meta.url);
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });

const APPLY = process.argv.includes("--apply");
const OFF = process.argv.includes("--off");
const STORE = "marathon-pine";
const WANT = OFF ? { enabled: null, scope: null, startsOn: null } : { enabled: true, scope: "all_but_sneakers", startsOn: "2026-11-23" };
const db = admin.database();
const at = (k) => db.ref(`displayChecks_settings/${STORE}/${k}`);
const read = async () => Object.fromEntries(await Promise.all(Object.keys(WANT).map(async (k) => [k, (await at(k).once("value")).val()])));

const before = await read();
console.log("before:", JSON.stringify(before));
console.log("want:  ", JSON.stringify(WANT));
if (!APPLY) { console.log("DRY RUN — nothing written"); process.exit(0); }
// One atomic multi-path update: all three keys land together or none do.
await db.ref(`displayChecks_settings/${STORE}`).update(WANT);
console.log("after: ", JSON.stringify(await read()));
process.exit(0);
