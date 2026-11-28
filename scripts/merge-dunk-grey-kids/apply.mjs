#!/usr/bin/env node
// ─── STEP 3 — APPLY (writes; refuses while anything blocks) ──────────────────
// Re-runs the investigation and the plan, and REFUSES unless the plan has no
// blockers (open refill requests, display slots, count records, unmapped
// sizes, a changed total, …). Then runs the app's own merge —
// functions/lib/product-merge.cjs performMerge, unchanged — through narrowDb
// (core.mjs) so no whole node is read and every merge movement carries the
// note. performMerge itself: transfers each duplicate cell into the original's
// cell at the SAME location with paired ledger movements in ONE atomic update,
// repoints the duplicate's barcodes, stamps the duplicate `mergedInto` (the
// app's normal way a merged product disappears — its record stays because its
// id is on past movements), and records the reversal recipe under
// /product_merges. Afterwards only the affected cells are re-read and checked.
//
//   node scripts/merge-dunk-grey-kids/apply.mjs            # dry run: plan + refusal reasons
//   node scripts/merge-dunk-grey-kids/apply.mjs --apply    # merge, if nothing blocks
import { createRequire } from "module";
import { adminRequire } from "../adminRequire.mjs";
import { investigate } from "./investigate.mjs";
import { planFrom, printPlan } from "./plan.mjs";
import { KEEP_ID, REMOVE_ID, MERGE_NOTE, narrowDb } from "./core.mjs";

const { performMerge } = createRequire(import.meta.url)("../../functions/lib/product-merge.cjs");
export const ACTOR = { uid: "system:merge-duplicate-845013-100", email: null };

/** Re-read only what the merge touched and compare with the plan. */
export async function verify(db, { plan, locs, barcodeCodes }) {
  const val = async (p) => (await db.ref(p).once("value")).val();
  const problems = [];
  const after = {};
  for (const r of plan.rows.filter((x) => x.action === "transfer")) {
    const q = (await val(`stock/${r.loc}/${KEEP_ID}/${r.size}`))?.qty ?? 0;
    (after[r.loc] ||= {})[r.size] = q;
    if (q !== r.originalAfter) problems.push(`${r.loc} ${r.size}: original holds ${q}, plan said ${r.originalAfter}`);
  }
  for (const loc of locs) if (await val(`stock/${loc}/${REMOVE_ID}`)) problems.push(`duplicate still has stock at ${loc}`);
  if ((await val(`products/${REMOVE_ID}/mergedInto`)) !== KEEP_ID) problems.push("duplicate is not marked mergedInto the original");
  for (const code of barcodeCodes) {
    const row = await val(`barcodes/${code}`);
    if (row && row.productId !== KEEP_ID) problems.push(`barcode ${code} still points at ${row.productId}`);
  }
  return { ok: problems.length === 0, problems, after };
}

export async function run(db, { apply, nowMs, log = console.log }) {
  const inv = await investigate(db);
  const out = planFrom(inv);
  printPlan(out, log);
  if (!out.safeToApply) return { applied: false, refused: out.blockers, plan: out.plan };
  if (!apply) return { applied: false, dryRun: true, plan: out.plan };
  const barcodeCodes = Object.keys(inv.refs.barcodeRows || {});
  const res = await performMerge(narrowDb(db, { loserId: REMOVE_ID, barcodeCodes, note: MERGE_NOTE }), {
    loserId: REMOVE_ID, survivorId: KEEP_ID, actor: ACTOR, nowMs,
  });
  const check = await verify(db, { plan: out.plan, locs: Object.keys((await db.ref("locations").once("value")).val() || {}), barcodeCodes });
  return { applied: true, result: res, verify: check, plan: out.plan };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const require = adminRequire(import.meta.url);
  const admin = require("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = admin.database();
  const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
  const serverNowMs = () => Date.now() + offset;
  const r = await run(db, { apply: process.argv.includes("--apply"), nowMs: serverNowMs() });
  console.log(JSON.stringify({ applied: r.applied, refused: r.refused, result: r.result, verify: r.verify }, null, 2));
  process.exit(r.refused || (r.verify && !r.verify.ok) ? 1 : 0);
}
