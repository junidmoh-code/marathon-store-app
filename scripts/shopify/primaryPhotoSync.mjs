// ─── BACKFILL: the Shopify primary photo becomes the app photo ───────────────
// The logic of scripts/shopify/sync-primary-photos-to-app.mjs and
// rollback-primary-photo-sync.mjs, with every Firebase leg injected so the
// tests run it against fakes. The write itself is NOT here: every replaced
// product goes through primaryPhotoCore.setShopifyPrimaryPhoto — the exact
// function the photo strip and the New Arrivals chain call — so the backfill
// has no code path of its own.
//
// Reads, per product, only what the decision needs: /shopify_publish/{pid}/
// media and /photos, and /products/{pid}/photoUrl + photoUrlOriginal (plus a
// one-child existence probe). Never a whole-node read of /products or
// /shopify_publish.
import { setShopifyPrimaryPhoto, storedPrimaryOf, objectPathOf } from "../../src/components/shopify/primaryPhotoCore.js";
import { APP_STORAGE_PREFIX } from "../../src/components/shopify/publishShared.js";

/**
 * The product an object belongs to, or null: products/{pid}/…, or an intake
 * capture products/_intake/{code}/{pid}.jpg (named by the product). Any other
 * "_" folder is not a product.
 */
export function ownerPidOf(path) {
  const p = String(path || "");
  const intake = /^products\/_intake\/[^/]+\/([A-Za-z0-9-]+)\.[a-z0-9]+$/i.exec(p);
  if (intake) return intake[1];
  const m = /^products\/([^/_][^/]*)\//.exec(p);
  return m ? m[1] : null;
}

// Objects that are never "a product's photo": derived thumbnails.
const isThumb = (path) => /\/thumb_[^/]*$/.test(path);

/**
 * md5 → Set of product ids whose folder holds an object with that content,
 * from one listing of products/ ([{ name, md5Hash }]).
 */
export function buildOwnersByMd5(objects) {
  const out = new Map();
  for (const o of objects || []) {
    const pid = ownerPidOf(o?.name);
    if (!pid || !o.md5Hash || isThumb(o.name)) continue;
    if (!out.has(o.md5Hash)) out.set(o.md5Hash, new Set());
    out.get(o.md5Hash).add(pid);
  }
  return out;
}

/**
 * One product's verdict. → { pid, verdict, primary?, current?, others? } where
 * verdict is one of:
 *   "no-product"         — a publishing node whose product record is gone
 *   "no-shopify-primary" — the node has no list of its own (it shows the app photo)
 *   "primary-missing"    — the primary names an object of this bucket that is not there
 *   "matching"           — the app already shows the primary (same URL, or same md5)
 *   "shared"             — the primary's content (or its object) belongs to ANOTHER product too
 *   "replace"            — the app photo will become the primary
 */
export function classify({ pid, exists, node, product, md5, ownersByMd5 }) {
  if (!exists) return { pid, verdict: "no-product" };
  const primary = storedPrimaryOf(node);
  if (!primary) return { pid, verdict: "no-shopify-primary" };
  const current = product?.photoUrl || null;
  if (current === primary) return { pid, verdict: "matching", primary, current, by: "url" };
  const pm = md5(primary), cm = current ? md5(current) : null;
  if (!pm && primary.startsWith(APP_STORAGE_PREFIX)) return { pid, verdict: "primary-missing", primary, current };
  if (pm && cm && pm === cm) return { pid, verdict: "matching", primary, current, by: "md5" };
  const owner = ownerPidOf(objectPathOf(primary));
  const others = new Set(owner && owner !== pid ? [owner] : []);
  for (const p of (pm && ownersByMd5.get(pm)) || []) if (p !== pid) others.add(p);
  if (others.size) return { pid, verdict: "shared", primary, current, others: [...others].sort() };
  return { pid, verdict: "replace", primary, current };
}

/** Run `fn` over `items`, `concurrency` at a time, `gapMs` between starts per lane. */
export async function eachLimited(items, concurrency, fn, { gapMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let i = 0;
  const lane = async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      if (gapMs) await sleep(gapMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
}

/**
 * The whole backfill over `pids`.
 *   io: { readNode(pid) → { media, photos }, readProduct(pid) → { exists, photoUrl, photoUrlOriginal },
 *         md5Of(url) → md5|null (async), ownersByMd5 }
 *   write: null for a dry run; else the deps setShopifyPrimaryPhoto takes
 *          (now, md5Of, rebuildThumb, writeProduct)
 *   onReplaced(entry): called after each product that really changed (the rollback ledger)
 * → { counts, rows } — every product's verdict, and what the write said.
 */
export async function runSync(pids, io, { write = null, onReplaced = async () => {}, log = () => {}, concurrency = 4, gapMs = 0, sleep } = {}) {
  const counts = { total: pids.length, matching: 0, replace: 0, "no-shopify-primary": 0, "no-product": 0, "primary-missing": 0, shared: 0,
                   replaced: 0, failed: 0, unchanged: 0 };
  const rows = [];
  await eachLimited(pids, concurrency, async (pid) => {
    let row;
    try {
      const [node, product] = await Promise.all([io.readNode(pid), io.readProduct(pid)]);
      const urls = [storedPrimaryOf(node), product?.photoUrl].filter(Boolean);
      const md5s = new Map(await Promise.all(urls.map(async (u) => [u, await io.md5Of(u)])));
      row = classify({ pid, exists: !!product?.exists, node, product, md5: (u) => md5s.get(u) ?? null, ownersByMd5: io.ownersByMd5 });
      counts[row.verdict] += 1;
      if (row.verdict === "replace" && write) {
        const r = await setShopifyPrimaryPhoto(pid, {
          product: { photoUrl: product.photoUrl ?? null, photoUrlOriginal: product.photoUrlOriginal ?? null },
          oldPrimary: null, newPrimary: row.primary,
        }, { ...write, md5Of: async (u) => (md5s.has(u) ? md5s.get(u) : io.md5Of(u)) });
        row.result = r;
        if (!r.ok) counts.failed += 1;
        else if (!r.changed) counts.unchanged += 1;
        else {
          counts.replaced += 1;
          await onReplaced({
            pid, oldPhotoUrl: product.photoUrl ?? null, oldPath: objectPathOf(product.photoUrl),
            oldPhotoUrlOriginal: product.photoUrlOriginal ?? null, oldPhotoSource: product.photoSource ?? null,
            newPhotoUrl: row.primary, newPath: objectPathOf(row.primary), patch: r.patch,
            oldMd5: md5s.get(product.photoUrl) ?? null, newMd5: md5s.get(row.primary) ?? null, thumb: r.thumb,
          });
        }
      }
    } catch (e) {
      row = { pid, verdict: "error", message: String(e?.message || e) };
      counts.failed += 1;
    }
    rows.push(row);
    log(row);
  }, { gapMs, sleep });
  return { counts, rows };
}

/**
 * Undo ONE ledger entry. Refuses when the app photo has changed since the
 * sync (anything but the photo the sync put there): a later edit is never
 * overwritten. → { pid, ok, refused?, patch? }
 */
export async function rollbackEntry(entry, { readProduct, writeProduct, rebuildThumb = null, apply = false }) {
  const pid = entry?.pid;
  if (!pid || !entry.newPhotoUrl) return { pid, ok: false, refused: "the ledger entry is incomplete" };
  const now = await readProduct(pid);
  if (!now?.exists) return { pid, ok: false, refused: "the product no longer exists" };
  if (now.photoUrl !== entry.newPhotoUrl) {
    return { pid, ok: false, refused: "the app photo has changed since the sync — left as it is" };
  }
  const patch = {
    photoUrl: entry.oldPhotoUrl ?? null,
    // RTDB deletes a null child: a field the sync created goes away again.
    photoUrlOriginal: entry.oldPhotoUrlOriginal ?? null,
    photoSource: entry.oldPhotoSource ?? null,
  };
  if (!apply) return { pid, ok: true, dryRun: true, patch };
  if (rebuildThumb && entry.oldPhotoUrl) { try { await rebuildThumb(pid, entry.oldPhotoUrl); } catch { /* best-effort */ } }
  await writeProduct(pid, patch);
  return { pid, ok: true, patch };
}
