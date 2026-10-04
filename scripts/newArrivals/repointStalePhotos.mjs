#!/usr/bin/env node
// ─── NEW ARRIVALS — re-point items stuck on an old product photo (one-off) ───
// Until 4 Oct the queue item kept its own copy of the product's photo
// (items/{pid}/originalUrl), made when it entered New. A photo replaced in
// admin afterwards left that copy stale. The code no longer reads the copy
// first (functions/newArrivals/sourcePhoto.cjs) — this step corrects the
// stored copies too, so nothing that still falls back to them shows an old photo.
//
// Run on the Mac mini (Admin SDK from the poster's install), from the store checkout:
//     node scripts/newArrivals/repointStalePhotos.mjs --dry-run   count only, write nothing
//     node scripts/newArrivals/repointStalePhotos.mjs             correct them
//     node scripts/newArrivals/repointStalePhotos.mjs --revert    put every corrected copy back
//
// REVERSIBLE: every correction is recorded at new_arrivals/fixes/{FIX_ID}/{pid}
// = { was, now, at } BEFORE the item is touched; --revert restores `was` on
// every item whose copy is still the `now` this step wrote (an item changed
// since is left alone and named).
//
// READS: the three New-lane indexes (pid keys) and, per pid, two scalars of the
// item and three of the product — keyed, never a whole node. Only items on the
// New tab (new / ready / rejected) are touched; approved and done items, every
// generated photo and every product record are left exactly as they are.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sourcePhoto from "../../functions/newArrivals/sourcePhoto.cjs";

export const FIX_ID = "stale-photo-2026-10-04";
export const NEW_LANES = ["new", "ready", "rejected"];
const ROOT = "new_arrivals";

/** What one item needs: null (its copy is right, or it has none), or { was, now }. Pure. */
export function correction(pid, originalUrl, product) {
  if (!originalUrl) return null;
  const now = sourcePhoto.currentSourceUrl(pid, product, null);
  if (!now || String(originalUrl) === now) return null;
  return { was: String(originalUrl), now };
}

/** The undo for one recorded correction, given the item's copy as it is now: { restore } or { skip: why }. Pure. */
export function undo(record, currentOriginalUrl) {
  if (!record || !record.was) return { skip: "no record of what it was" };
  if (record.reverted) return { skip: "already put back" };
  if (String(currentOriginalUrl || "") !== String(record.now)) return { skip: "changed since the correction — left alone" };
  return { restore: record.was };
}

const val = async (db, p) => (await db.ref(p).once("value")).val();

/** io: { db, now(), dryRun, revert, log } → { checked, corrected | reverted, skipped: [...] } */
export async function run({ db, now = () => Date.now(), dryRun = false, revert = false, log = () => {} }) {
  if (revert) {
    const records = (await val(db, `${ROOT}/fixes/${FIX_ID}`)) || {};
    const out = { checked: 0, reverted: 0, skipped: [] };
    for (const [pid, record] of Object.entries(records)) {
      out.checked += 1;
      const u = undo(record, await val(db, `${ROOT}/items/${pid}/originalUrl`));
      if (u.skip) { out.skipped.push({ pid, why: u.skip }); continue; }
      if (!dryRun) await db.ref(ROOT).update({ [`items/${pid}/originalUrl`]: u.restore, [`fixes/${FIX_ID}/${pid}/reverted`]: now() });
      out.reverted += 1;
      log(`${pid}: put back`);
    }
    return out;
  }
  const out = { checked: 0, corrected: 0, pids: [] };
  for (const lane of NEW_LANES) {
    const keys = Object.keys((await val(db, `${ROOT}/by_status/${lane}`)) || {});
    for (const pid of keys) {
      out.checked += 1;
      const [originalUrl, photoUrl, photoUrlOriginal] = await Promise.all([
        val(db, `${ROOT}/items/${pid}/originalUrl`), val(db, `products/${pid}/photoUrl`), val(db, `products/${pid}/photoUrlOriginal`),
      ]);
      const c = correction(pid, originalUrl, { photoUrl, photoUrlOriginal });
      if (!c) continue;
      // A second run never loses what the item FIRST pointed at: an existing record keeps its `was`.
      const earlier = dryRun ? null : await val(db, `${ROOT}/fixes/${FIX_ID}/${pid}`);
      const was = earlier && earlier.was && !earlier.reverted ? earlier.was : c.was;
      // The record and the item — in ONE atomic write.
      if (!dryRun) await db.ref(ROOT).update({ [`fixes/${FIX_ID}/${pid}`]: { was, now: c.now, at: now(), lane }, [`items/${pid}/originalUrl`]: c.now });
      out.corrected += 1;
      out.pids.push(pid);
      log(`${pid} (${lane}): re-pointed at the product's current photo`);
    }
  }
  return out;
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] || "")).href; } catch { return null; } })();
if (invoked === import.meta.url) {
  const POSTER = process.env.MGP_DIR || path.join(os.homedir(), "marathon-group-poster");
  const { fb } = await import(pathToFileURL(path.join(POSTER, "src/fb.mjs")).href);
  const dryRun = process.argv.includes("--dry-run"), revert = process.argv.includes("--revert");
  const out = await run({ db: fb().db, dryRun, revert, log: (m) => console.log(m) });
  console.log(revert
    ? `${dryRun ? "WOULD put back" : "Put back"} ${out.reverted} of ${out.checked} corrected items${out.skipped.length ? `; ${out.skipped.length} left alone (${[...new Set(out.skipped.map((s) => s.why))].join("; ")})` : ""}.`
    : `${dryRun ? "WOULD correct" : "Corrected"} ${out.corrected} of ${out.checked} items on the New tab${dryRun ? " (dry run: nothing written)" : ` — undo with --revert (record: new_arrivals/fixes/${FIX_ID})`}.`);
  process.exit(0);
}
