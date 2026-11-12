// ─── ONE-OFF: RELEASE THE CONCRETE DIVISION'S NEW LINES NOW (Junid, 12 Nov 2026)
// After the Central-clothing change, the Concrete-division lines the first scan
// raises are released for picking at once through the existing urgent override
// (earlyRelease on each request — releaseWindows.js). The 06:00/14:00 schedule
// is not changed; only open Hub 3 / Pine / Concrete lines raised since --since
// are touched, never a Marathon line. Dry run by default.
//   node scripts/release-division-now.mjs --since <ISO> [--apply]
import { adminRequire } from "./adminRequire.mjs";
import { planEarlyRelease, applyEarlyRelease } from "./lib/hub3ClothingTransfer.mjs";
const req = adminRequire(import.meta.url);
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const i = process.argv.indexOf("--since");
const SINCE = i > 0 ? process.argv[i + 1] : null;
if (!SINCE || !Number.isFinite(Date.parse(SINCE))) throw new Error("--since <ISO> is required");
const SINCE_ISO = new Date(SINCE).toISOString();
const APPLY = process.argv.includes("--apply");
const db = admin.database();
// Push ids only ("-…"): website rows ("web_…") sort after them and would
// crowd the newest window out.
const requests = (await db.ref("refill_requests").orderByKey().endAt("-~").limitToLast(3000).once("value")).val() || {};
const lines = planEarlyRelease({ requests, sinceIso: SINCE_ISO });
const by = (loc) => lines.filter((l) => l.dest === loc).length;
console.log(`division lines raised since ${SINCE}: ${lines.length} (Concrete ${by("concrete")}, Pine ${by("marathon-pine")}, Hub 3 ${by("hub3")}); sources ${JSON.stringify(lines.reduce((o, l) => ({ ...o, [l.source]: (o[l.source] || 0) + 1 }), {}))}`);
if (!APPLY) process.exit(0);
const res = await applyEarlyRelease({ db, lines, nowIso: new Date().toISOString(), by: "script:release-division-now", reason: "Junid 12 Nov 2026: one-off release of the Concrete division after Central took over Pine/Concrete clothing" });
console.log("released:", res.filter((r) => r.outcome === "released").length, "skipped:", res.filter((r) => r.outcome !== "released").length);
process.exit(0);
