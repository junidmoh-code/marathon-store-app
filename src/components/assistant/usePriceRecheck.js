// ─── "No price set" on a card is checked against the server, once ────────────
//
// docs/ASSISTANT-NO-PRICE-SET.md. A device serving /products from its offline
// mirror can hold a row from before a price was set, if it never applied that
// change record. Nothing else would ever correct it, so the assistant view
// names the products it would show as unpriced and each is re-read ONCE per
// session, by key (offline/rowRecheck.js). A patched row bumps the products
// leg and the card re-renders with the price.
//
// Cost: one child read per unpriced product per session. On 16 Nov 2026 the
// whole catalogue held one. Capped per pass anyway, so a bad day (a bulk clear)
// cannot become a burst of thousands of reads.
//
// When /products is NOT served from the mirror the screen is on a live onValue,
// which is already the truth. Nothing is read then.

import { useEffect } from "react";
import { get, ref } from "firebase/database";
import { database } from "../../firebase";
import { retailPriceOf } from "../../utils/retailPrice";
import { isLegServing } from "../../offline/serving";
import { getMirrorDbHandle } from "../../offline/mirrorDbHandle";
import { recheckMirroredRows } from "../../offline/rowRecheck";

export const PRICE_RECHECK_MAX_PER_PASS = 25;

// Per tab. A row that came back with no price stays checked until the next
// load: re-reading it on every render would be polling, and the change feed
// still carries the price when one is set.
const checked = new Set();
const inFlight = new Set();

/** The ids a pass would re-check: unpriced, not yet checked, capped. Pure. */
export function idsToRecheck(products, { done = checked, busy = inFlight, max = PRICE_RECHECK_MAX_PER_PASS } = {}) {
  const out = [];
  for (const p of products ?? []) {
    if (out.length >= max) break;
    if (!p || typeof p.id !== "string" || !p.id) continue;
    if (retailPriceOf(p) !== null) continue;
    if (done.has(p.id) || busy.has(p.id)) continue;
    out.push(p.id);
  }
  return out;
}

const liveRead = async (path) => {
  const snap = await get(ref(database, path));
  return snap.exists() ? snap.val() : null;
};

/** One pass. Exported for tests; the hook is the only production caller. */
export async function runPriceRecheck(products, {
  serving = () => isLegServing("products"),
  openDb = getMirrorDbHandle,
  read = liveRead,
  recheck = recheckMirroredRows,
} = {}) {
  if (!serving()) return { checked: 0, patched: 0, keys: [] };
  const ids = idsToRecheck(products);
  if (!ids.length) return { checked: 0, patched: 0, keys: [] };
  ids.forEach((id) => inFlight.add(id));
  try {
    const db = await openDb();
    const res = await recheck({ node: "products", keys: ids, db, read });
    ids.forEach((id) => checked.add(id));
    return res;
  } catch (err) {
    // Not marked checked: a failed read (offline, timeout) is asked again on
    // the next pass, not given up on.
    console.warn("price recheck: could not re-read", ids.length, "product(s):", err?.message || err);
    return { checked: 0, patched: 0, keys: [], error: true };
  } finally {
    ids.forEach((id) => inFlight.delete(id));
  }
}

export function usePriceRecheck(products) {
  useEffect(() => {
    if (!products?.length) return;
    runPriceRecheck(products).catch(() => {});
  }, [products]);
}

export function _resetPriceRecheckForTests() {
  checked.clear();
  inFlight.clear();
}
