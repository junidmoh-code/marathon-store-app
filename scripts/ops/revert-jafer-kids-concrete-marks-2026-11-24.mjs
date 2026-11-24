// ─── UNDO THREE MISTAKEN CONCRETE MARKINGS (Junid, 24 Nov 2026) ─────────────
// On 24 Nov 2026 at 19:17–19:18 SAST Jafer (uid P4EQ7TjPeKYi76HVX2LhdcL6L0d2)
// tapped the "Concrete" division button on three kids shoes on Marathon's
// Missing Products list — the only control their cards had (no policy at
// Hub 1 / Hub 2 for sizes 24–35). Junid asked for exactly these three marks
// to be taken off. NOTHING ELSE is touched: not his Hub 3 solve of the same
// three (seats, cells, requests), not any other marking.
//
// The write is the Not-listed sheet's Unmark (divisionMark.clearDivision):
// buildConcreteUpdate({ on: false, verify: true }) in ONE multi-path update,
// refused per product unless the live mark is still Jafer's from 24 Nov. The
// before-state of every path is saved to the rollback file and a log entry is
// written to /settings/divisionMarkReverts.
//   node scripts/ops/revert-jafer-kids-concrete-marks-2026-11-24.mjs <adminModule.cjs> <rollback.json> [--apply]
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { buildConcreteUpdate } from "../../src/utils/concreteListing.js";

const [, , adminModule, rollbackFile] = process.argv;
const APPLY = process.argv.includes("--apply");
const require = createRequire(import.meta.url);
const { db, admin } = require(adminModule);   // { db, admin } — an initialised firebase-admin app
const JAFER = "P4EQ7TjPeKYi76HVX2LhdcL6L0d2";
const JUNID = "yXTAJTbTewXDXzm1H9akQP3f4vQ2";
const DAY_START = Date.parse("2026-11-23T22:00:00Z");   // 24 Nov 00:00 SAST
const PIDS = {
  p1795529014851: "Jordan black",
  p1795527449787: "Nike air force white and blue",
  p1795525177291: "Nike ari force white and red",
};
const once = async (p) => (await db.ref(p).once("value")).val();
const nowMs = Date.now();
const updates = {}, before = {}, log = [];
for (const [pid, label] of Object.entries(PIDS)) {
  const p = (await once(`products/${pid}`)) || {};
  const idx = await once(`settings/concreteOnlyIndex/${pid}`);
  const ok = p.concreteProduct === true && idx === true && p.concreteProductSetBy === JAFER && Number(p.concreteProductSetAt) >= DAY_START;
  console.log(pid, String(p.name || "").replace(/ /g, " "), "| expected", label, "| mark", p.concreteProduct, "index", idx, "by", p.concreteProductSetBy, "at", new Date(p.concreteProductSetAt).toISOString(), ok ? "→ REVERT" : "→ SKIP (not Jafer's 24 Nov mark any more)");
  if (!ok) continue;
  const live = await once(`shopify_publish_concrete/${pid}`);
  const u = buildConcreteUpdate({ productIds: [pid], on: false, uid: JUNID, nowMs, verify: true, liveOnConcrete: live?.state === "live" ? [pid] : null });
  for (const k of Object.keys(u)) before[k] = await once(k);
  Object.assign(updates, u);
  log.push({ pid, name: String(p.name || "").replace(/ /g, " "), markedBy: JAFER, markedAt: p.concreteProductSetAt, revertedAt: nowMs });
}
writeFileSync(rollbackFile, JSON.stringify({ at: new Date(nowMs).toISOString(), before, updates }, null, 1));
console.log(`${log.length} to revert, ${Object.keys(updates).length} paths; rollback → ${rollbackFile}`);
if (APPLY && log.length) {
  const key = db.ref("settings/divisionMarkReverts").push().key;
  updates[`settings/divisionMarkReverts/${key}`] = { at: nowMs, by: JUNID, reason: "Jafer's mistaken Concrete taps on Missing Products, 24 Nov 2026 (cards had no Hub 1/Hub 2 button) — reverted on Junid's instruction", products: log };
  await db.ref().update(updates);
  for (const { pid } of log) console.log(pid, "now concreteProduct", await once(`products/${pid}/concreteProduct`), "index", await once(`settings/concreteOnlyIndex/${pid}`));
  console.log("logged at settings/divisionMarkReverts/" + key);
} else console.log(APPLY ? "nothing to write" : "dry run — pass --apply to write");
await admin.app().delete();
process.exit(0);
