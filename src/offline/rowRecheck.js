// ─── OFFLINE MIRROR — re-check named rows against the server ─────────────────
//
// The change feed is the only thing that moves a row this device already
// holds. The daily census compares row COUNTS, and an edit to an existing row
// changes no count. So a feed record this device never applied leaves that row
// wrong for good, with nothing to say so. On 16 Nov 2026 that was two Manchester
// City jerseys priced through Missing Prices that still read "No price set" on
// an assistant view (docs/ASSISTANT-NO-PRICE-SET.md).
//
// This is the narrow backstop: a screen that can SEE a row looks wrong (a
// sellable product with no price) names it, and the row is read once, by key.
// That is the same one-child read the feed makes. If the server's row differs,
// it is written into the local copy and the leg is bumped through mirrorSignal.
// That is the same signal the feed uses, so every useMirroredPath on the leg
// re-reads.
//
// WHAT IT NEVER DOES
//   · read a whole node, or anything but the rows it is handed;
//   · delete. A row that reads back null is left for the feed, which owns
//     deletes and the census bookkeeping that goes with them;
//   · move the feed cursor, or touch any meta;
//   · overwrite a row the feed changed while the read was in flight (the local
//     copy is compared before and after; if it moved, the feed is fresher).

import { LEG_BY_NODE, rowPath, storeKey } from "./nodes";
import { bumpLegs } from "./mirrorSignal";

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * → { checked, patched, keys } — `keys` are the rows patched.
 * `read(path)` returns the server's value at that path (null when absent).
 */
export async function recheckMirroredRows({ node, keys, db, read, bump = bumpLegs }) {
  const leg = LEG_BY_NODE[node];
  if (!leg || leg.depth !== 1) throw new Error(`recheckMirroredRows: ${node} is not a depth-1 mirrored node`);
  let checked = 0;
  const patched = [];
  for (const key of keys ?? []) {
    if (typeof key !== "string" || key === "" || key.includes("/")) continue;
    const sk = storeKey(leg, key);
    const before = await db.get(leg.store, sk);
    const server = await read(rowPath(leg, key));
    checked += 1;
    if (server === null || server === undefined) continue;   // deletes are the feed's
    if (sameJson(before, server)) continue;
    const now = await db.get(leg.store, sk);
    if (!sameJson(now, before)) continue;                     // the feed moved it meanwhile
    await db.putPage(leg.store, [{ key: sk, value: server }]);
    patched.push(key);
  }
  if (patched.length) bump([leg.name]);
  return { checked, patched: patched.length, keys: patched };
}
