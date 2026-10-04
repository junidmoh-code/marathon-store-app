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
// It also marks the photos ALREADY generated for those items as made from the
// old photo (generations/{g}/sourceUrl = the old copy), so the card flags them
// and Approve waits for a Regenerate.
//
// REVERSIBLE: every correction is recorded at new_arrivals/fixes/{FIX_ID}/{pid}
// = { was, now, at, stamped } in the SAME atomic write; --revert restores `was` on
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

/**
 * The photos ALREADY generated for a stuck item were made from its old copy
 * (the generator read it). They carry no record of that, so nothing could tell
 * they are out of date. Returns the generation ids to stamp with
 * sourceUrl = was — every generation that has no sourceUrl yet. Pure.
 */
export function gensToStamp(generations) {
  return Object.entries(generations || {}).filter(([, g]) => g && typeof g === "object" && g.url && !g.sourceUrl).map(([id]) => id);
}

/** The undo for one recorded correction, given the item's copy as it is now: { restore } or { skip: why }. Pure. */
export function undo(record, currentOriginalUrl) {
  if (!record || !record.was) return { skip: "no record of what it was" };
  if (record.reverted) return { skip: "already put back" };
  if (String(currentOriginalUrl || "") !== String(record.now)) return { skip: "changed since the correction — left alone" };
  return { restore: record.was };
}

const val = async (db, p) => (await db.ref(p).once("value")).val();

/** io: { db, now(), dryRun, revert, log } → { checked, corrected, photosMarked, reshot | reverted, skipped } */
export async function run({ db, now = () => Date.now(), dryRun = false, revert = false, log = () => {} }) {
  if (revert) {
    const records = (await val(db, `${ROOT}/fixes/${FIX_ID}`)) || {};
    const out = { checked: 0, reverted: 0, skipped: [] };
    for (const [pid, record] of Object.entries(records)) {
      out.checked += 1;
      const u = undo(record, await val(db, `${ROOT}/items/${pid}/originalUrl`));
      if (u.skip) { out.skipped.push({ pid, why: u.skip }); continue; }
      const paths = { [`items/${pid}/originalUrl`]: u.restore, [`fixes/${FIX_ID}/${pid}/reverted`]: now() };
      // The stamps this step put on its generated photos go too.
      for (const g of Object.values(record.stamped || {})) paths[`items/${pid}/generations/${g}/sourceUrl`] = null;
      if (!dryRun) await db.ref(ROOT).update(paths);
      out.reverted += 1;
      log(`${pid}: put back`);
    }
    return out;
  }
  const out = { checked: 0, corrected: 0, photosMarked: 0, reshot: 0, unmarkable: [], pids: [] };
  for (const lane of NEW_LANES) {
    const keys = Object.keys((await val(db, `${ROOT}/by_status/${lane}`)) || {});
    for (const pid of keys) {
      out.checked += 1;
      const [originalUrl, photoUrl, photoUrlOriginal] = await Promise.all([
        val(db, `${ROOT}/items/${pid}/originalUrl`), val(db, `products/${pid}/photoUrl`), val(db, `products/${pid}/photoUrlOriginal`),
      ]);
      const c = correction(pid, originalUrl, { photoUrl, photoUrlOriginal });
      if (!c) continue;
      // Same storage object, new address = staff replaced the photo (the bug). Only then are the item's
      // existing photos known to be of the OLD picture; a copy that differs for another reason says nothing about them.
      const reshot = !!sourcePhoto.objectPath(c.was) && sourcePhoto.objectPath(c.was) === sourcePhoto.objectPath(c.now);
      // Only a stuck item's generations are read (keyed, one item).
      const generations = reshot ? await val(db, `${ROOT}/items/${pid}/generations`) : null;
      const stamped = gensToStamp(generations);
      // An older item with a generated photo but no generation record cannot be marked: counted, and named.
      if (reshot && !Object.keys(generations || {}).length && await val(db, `${ROOT}/items/${pid}/generatedUrl`)) { out.unmarkable.push(pid); }
      // A second run never loses what the item FIRST pointed at: an existing record keeps its `was`.
      const earlier = dryRun ? null : await val(db, `${ROOT}/fixes/${FIX_ID}/${pid}`);
      const keep = earlier && earlier.was && !earlier.reverted ? earlier : null;
      const paths = {
        [`fixes/${FIX_ID}/${pid}`]: { was: keep ? keep.was : c.was, now: c.now, at: now(), ...(keep ? { firstAt: keep.firstAt || keep.at } : {}), lane, ...([...(keep ? Object.values(keep.stamped || {}) : []), ...stamped].length ? { stamped: [...new Set([...(keep ? Object.values(keep.stamped || {}) : []), ...stamped])] } : {}) },
        [`items/${pid}/originalUrl`]: c.now,
      };
      // Its existing photos were made from the old copy: say so on each, so the card flags them and Approve waits for a Regenerate.
      for (const g of stamped) paths[`items/${pid}/generations/${g}/sourceUrl`] = c.was;
      // The record and the item — in ONE atomic write.
      if (!dryRun) await db.ref(ROOT).update(paths);
      out.corrected += 1;
      out.photosMarked += stamped.length;
      if (reshot) out.reshot += 1;
      out.pids.push(pid);
      log(`${pid} (${lane}): re-pointed at the product's current photo${stamped.length ? `; ${stamped.length} generated photo${stamped.length === 1 ? "" : "s"} marked as made from the old one` : ""}`);
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
    : `${dryRun ? "WOULD correct" : "Corrected"} ${out.corrected} of ${out.checked} items on the New tab (${out.reshot} where staff replaced the photo, ${out.corrected - out.reshot} other); ${out.photosMarked} already-generated photo${out.photosMarked === 1 ? "" : "s"} marked as made from the old photo${out.unmarkable.length ? `; ${out.unmarkable.length} older item(s) have a generated photo with no record to mark: ${out.unmarkable.join(", ")}` : ""}${dryRun ? " (dry run: nothing written)" : ` — undo with --revert (record: new_arrivals/fixes/${FIX_ID})`}.`);
  process.exit(0);
}
