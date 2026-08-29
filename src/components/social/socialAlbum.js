// ── READING THE ALBUM ────────────────────────────────────────────────────────
// /social_library is written by the generator and never pruned (see
// functions/lib/social-library.cjs). This module is the browser's side of it:
// turning an archived entry plus the CURRENT catalogue into something you can
// look at — a tile, or a full outfit with a price on it.
//
// ── PRICES ARE RESOLVED, NEVER STORED ────────────────────────────────────────
// The album deliberately archives only pid and slot. Everything a shopper sees
// — name, price, whether it is still in stock — is looked up at read time from
// live product records. An album that cached R850 in August would still be
// saying R850 in December, on a page that looks authoritative because it has a
// photograph next to it.
//
// The cost of that choice is that a product can disappear from under an old
// picture. That is handled explicitly rather than hidden: an item that no
// longer resolves is reported as MISSING and excluded from the fit total,
// because a total that silently omits a line is a lie, and one that silently
// includes a deleted product is a different lie.

export const ALBUM_PATH = "social_library";

// The order a look reads in, top to bottom, the way you'd describe an outfit
// rather than the order the generator happened to pick.
const SLOT_ORDER = ["cap", "top", "bottom", "shoe", "fragrance", "bag"];

export function slotRank(slot) {
  const i = SLOT_ORDER.indexOf(String(slot || "").toLowerCase());
  return i === -1 ? SLOT_ORDER.length : i;
}

// The sweep in scripts/sweep-unguarded-array-ops.mjs wants a wrapped receiver,
// not a ternary it cannot see through — and it is right to: everything here
// comes off an RTDB snapshot, where a list can arrive as null.
const asList = (v) => (Array.isArray(v) ? v : []);

export function normaliseAlbumEntry(id, body) {
  if (!body || typeof body !== "object") return null;
  const media = asList(body.media).filter((m) => m && m.type === "image" && m.url);
  if (!media.length) return null;
  return {
    id,
    postId: typeof body.postId === "string" ? body.postId : id,
    url: media[0].url,
    media,
    kind: typeof body.kind === "string" ? body.kind : "single",
    format: typeof body.format === "string" ? body.format : null,
    products: asList(body.products).filter((p) => p && typeof p.pid === "string" && p.pid),
    createdAt: Number.isFinite(body.createdAt) ? body.createdAt : null,
    videoPath: typeof body.videoPath === "string" ? body.videoPath : null,
    costUSD: Number.isFinite(body.costUSD) ? body.costUSD : null,
  };
}

export function albumList(raw) {
  const out = [];
  for (const [id, body] of Object.entries(raw || {})) {
    const e = normaliseAlbumEntry(id, body);
    if (e) out.push(e);
  }
  // Newest first; a null createdAt sorts last rather than throwing the order.
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// More than one product in the frame makes it a fit — see isOutfitEntry in the
// server module for why this is about the frame and not the label.
export const isFit = (entry) => !!entry && entry.products.length > 1;

/**
 * Resolve an album entry against the live catalogue.
 *
 * `lookup(pid)` returns { name, price, available } or null/undefined when the
 * product no longer exists. `price` is a number in rand; anything that is not
 * a finite number is treated as "no price", NOT as zero — a free garment and
 * an unpriced one are different claims and only one of them is ever true.
 */
export function resolveFit(entry, lookup) {
  const items = (entry?.products || []).map((p) => {
    const found = typeof lookup === "function" ? lookup(p.pid) : null;
    const price = Number(found?.price);
    return {
      pid: p.pid,
      slot: p.slot || null,
      name: found?.name || null,
      price: Number.isFinite(price) && price > 0 ? price : null,
      available: found ? found.available !== false : false,
      missing: !found,
    };
  });
  items.sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || a.pid.localeCompare(b.pid));

  const priced = items.filter((i) => !i.missing && i.price !== null);
  const total = priced.reduce((a, i) => a + i.price, 0);
  return {
    items,
    total: priced.length ? total : null,
    // The total is only the WHOLE fit when every item resolved and carried a
    // price. Anything less and the page must say so rather than present a
    // partial sum as the price of the look.
    complete: items.length > 0 && priced.length === items.length,
    pricedCount: priced.length,
    missingCount: items.filter((i) => i.missing).length,
    soldOutCount: items.filter((i) => !i.missing && !i.available).length,
    // One click adds the whole fit, so it has to be honest about whether that
    // is currently possible.
    canAddAll: items.length > 0 && items.every((i) => !i.missing && i.available),
  };
}

// Grouped by hand rather than via toLocaleString("en-ZA"): that returns a
// NON-BREAKING space, and which separator you get at all depends on the ICU
// data compiled into the runtime. A price is not the place for output that
// differs between two machines running the same code.
// ── AN EMPTY ALBUM AND AN UNREADABLE ONE ARE DIFFERENT CLAIMS ────────────────
// The album's read is denied until the /social_library console rule is pasted,
// which on day one it will not be. Rendering the cheerful "nothing here yet"
// copy in that case tells the owner his pictures were never archived, when in
// fact they are all there and the browser simply cannot see them. He would go
// looking for a bug in the generator.
//
// Pure and separate from the component so the distinction is pinned by a test
// rather than by whoever edits the JSX next.
export function albumEmptyState({ busy, error, count }) {
  if (busy) return { show: false };
  if (error) return { show: true, tone: "error", text: error };
  if (!count) {
    return {
      show: true, tone: "empty",
      text: "The album is empty. Every picture the generator makes from now on lands here automatically; anything made before that is added by running the backfill script.",
    };
  }
  return { show: false };
}

export function formatRand(n) {
  if (!Number.isFinite(n)) return "—";
  const whole = String(Math.abs(Math.round(n)));
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${n < 0 ? "-" : ""}R${grouped}`;
}
