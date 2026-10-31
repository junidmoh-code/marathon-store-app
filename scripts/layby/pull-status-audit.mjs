// ─── Layby pull ↔ parcel status: audit + backfill (31 Oct 2026) ──────────────
// Counts layby requests marked Sent on one node and still open on the other
// (scripts/lib/laybyPullAudit.mjs has the classes), and — with --apply — moves
// ONLY the unambiguous ones: a parcel still reading pullRequested whose latest
// pull is a collect pull already marked sentToStore, with nothing after the
// send. Everything else is printed, never written.
//
// Each write is a per-parcel transaction that re-checks the parcel still reads
// pullRequested at commit time, so a run is idempotent and cannot overwrite a
// parcel that moved on while it ran. The written fields are rules-legal
// (status in the /laybys allowed set; sentToStoreAt an $other child).
//
// Also prints, for context only, how many parcels whose /laybys status is
// still in the pull pipeline have a /pos/sales record that already reads
// collected (the known "L-00026 class": a POS completion that did not mirror
// onto /laybys). That is the POS's mirror, not a request status, and it is
// not touched here. Those are single-key reads of /pos/sales/{id}/status only.
//
// Reads: /laybyPulls and /laybys in key-ordered pages (rtdbPaged) — there is
// no index to narrow either, and this is a one-off audit (~540 KB on 31 Oct).
//
// Usage:  node scripts/layby/pull-status-audit.mjs            (dry run)
//         node scripts/layby/pull-status-audit.mjs --apply
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { auditPullStatus, fixPatch } from "../lib/laybyPullAudit.mjs";

const APPLY = process.argv.includes("--apply");
// adminRequire resolves ../functions from the URL it is given — hand it one
// that sits in scripts/, not scripts/layby/.
const require = adminRequire(new URL("../_.mjs", import.meta.url).href);
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

async function census() {
  const pulls = await readMapPaged(db, "laybyPulls");
  const laybys = await readMapPaged(db, "laybys");
  return { pulls, laybys, audit: auditPullStatus(pulls, laybys) };
}

const fmt = (r) => `${r.invoiceNo || "?"} (${r.laybyId}) ${r.storageHub || "?"}: pull=${r.pullStatus} parcel=${r.parcelStatus}${r.reason ? ` — ${r.reason}` : ""}`;

const before = await census();
const b = before.audit;
console.log(`pulls ${Object.keys(before.pulls).length}, parcels ${Object.keys(before.laybys).length}`);
console.log(`BEFORE  agree ${b.agree} · fix ${b.fix.length} · ambiguous ${b.ambiguous.length} · pending-vs-sent ${b.pendingVsSent.length}`);
for (const r of b.fix) console.log("  fix       ", fmt(r));
for (const r of b.ambiguous) console.log("  ambiguous ", fmt(r));
for (const r of b.pendingVsSent) console.log("  pending   ", fmt(r));

// Context: POS-side completions not mirrored (not fixed here).
const inPipeline = Object.entries(before.laybys).filter(([, l]) => ["pullRequested", "sentToStore"].includes(l?.status));
let posCollected = 0;
for (const [id, l] of inPipeline) {
  const s = (await db.ref(`pos/sales/${l.saleId || id}/status`).get()).val();
  if (s === "collected") posCollected += 1;
}
console.log(`context: ${inPipeline.length} parcels in the pull pipeline; ${posCollected} of them already collected per /pos/sales (POS mirror, not touched)`);

if (!APPLY) { console.log("dry run — nothing written. Re-run with --apply."); process.exit(0); }

let written = 0, moved = 0;
for (const r of b.fix) {
  const patch = fixPatch(r);
  const res = await db.ref(`laybys/${r.laybyId}`).transaction((cur) => {
    if (cur == null) return cur;                 // cold cache: let the server answer
    if (cur.status !== "pullRequested") return;  // moved on — abort, write nothing
    return { ...cur, ...patch };
  });
  if (res.committed && res.snapshot.val()?.status === "sentToStore") written += 1; else moved += 1;
}
const after = (await census()).audit;
console.log(`APPLIED written ${written} · skipped (moved on) ${moved}`);
console.log(`AFTER   agree ${after.agree} · fix ${after.fix.length} · ambiguous ${after.ambiguous.length} · pending-vs-sent ${after.pendingVsSent.length}`);
process.exit(0);
