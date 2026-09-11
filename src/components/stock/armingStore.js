// ─── ARMING — THE READ, AND WHAT IT COSTS ────────────────────────────────────
//
// The Arming tab is the only screen in this card that asks about the whole
// catalogue at once, so its read is the thing most worth being explicit about.
//
// ── WHAT IT READS, AND WHAT IT REFUSES TO ────────────────────────────────────
// FOUR location-scoped reads, the same shape useStockCells(loc) and
// useStockTargets(loc) make everywhere else in this folder:
//
//     /stock/hub1          /stock_targets/hub1
//     /stock/hub2          /stock_targets/hub2
//
// It does NOT read /stock, /stock_targets or /products. /products is already
// subscribed app-wide by useProducts() and is handed in as a prop exactly as
// the Seating tab takes it, so the catalogue costs this tab nothing it was not
// already costing. /config/refillEngine is already subscribed by
// useEngineConfig() and is 6.6 KB.
//
// ── THE NUMBERS, MEASURED AGAINST LIVE ON 2026-09-11 ─────────────────────────
//     /stock/hub1            512 KB        /stock_targets/hub1      40 KB
//     /stock/hub2          1,405 KB        /stock_targets/hub2     785 KB
//                                                        total  ≈ 2.68 MB
//
// For comparison, the whole of /stock is 6.47 MB across its ten locations, and
// resolving the engine's dead-size rule exactly would need every byte of it.
// This read is 41% of that and answers bucket A — armed at both hubs, the
// defect the tab exists for — identically: 34 products either way, measured
// over the whole live catalogue. See armingCore.js for why.
//
// It is still two and a half megabytes, and the brief asked for it to be
// measured rather than assumed, so the tab reports its own byte count on screen
// every time it loads. A number nobody can see is a number nobody can object to.
//
// ── ONE-SHOT get(), NOT A SUBSCRIPTION ───────────────────────────────────────
// usePath would keep a listener open on both hub stock nodes for as long as the
// card is mounted, re-delivering the whole payload on every cell write from
// every till. The Seating tab reads one-shot for the same reason; the Refresh
// button is the deliberate re-read.

import { ref, get } from "firebase/database";
import { database } from "../../firebase";
import { ARMING_HUBS } from "./armingCore";

// Bytes as they arrive, not as they sit in memory. JSON.stringify of the
// decoded value is the closest honest measure available in the browser — RTDB's
// websocket frames are not exposed — and it is the same shape the REST payload
// has (which is what the 2.68 MB above was measured from). It is an estimate
// and is labelled as one on screen.
const weigh = (v) => {
  try { return v == null ? 0 : JSON.stringify(v).length; } catch { return 0; }
};

// ── THE TAB'S READ ───────────────────────────────────────────────────────────
// Returns the context seatingCore wants, plus the bill.
//
// A node that does not exist is LEFT OUT of the map rather than written as {}.
// That is what readSeatingContext does and it matters: `storeCarries` asks
// whether the per-product map exists and is non-empty, and RTDB deletes a key
// whose value becomes empty, so "absent" and "present but empty" are the same
// state in the database and must be the same state here.
export async function readArmingContext(hubs = ARMING_HUBS) {
  const stock = {};
  const targets = {};
  let bytes = 0;
  const reads = [];
  for (const hub of hubs) {
    reads.push(get(ref(database, `stock/${hub}`)).then((s) => {
      if (!s.exists()) return;
      const v = s.val();
      bytes += weigh(v);
      stock[hub] = v;
    }));
    reads.push(get(ref(database, `stock_targets/${hub}`)).then((s) => {
      if (!s.exists()) return;
      const v = s.val();
      bytes += weigh(v);
      targets[hub] = v;
    }));
  }
  await Promise.all(reads);
  return { stock, targets, bytes, readCount: reads.length };
}

// ── RESOLVING THE UNDECIDED ──────────────────────────────────────────────────
// The residue the hub-scoped read cannot settle: products whose policy-covered
// sizes hold no units at either hub, where the engine's dead-size rule turns on
// stock held somewhere else. 198 products live.
//
// Settled with the SEATING TAB'S OWN READ — /stock/{loc}/{pid}, one product at
// a time — over the locations the tab does not already hold. Never a whole
// node: that is the read this tab was built to avoid, and doing it here to tidy
// up a 2% residue would spend 4 MB to move 67 rows.
//
// Batched, because 198 products across 8 locations is 1,584 requests and firing
// them all at once is how a shop phone drops the lot. Each response is a few
// hundred bytes.
const BATCH = 24;

export async function resolveUndecided(pids, locations, { onProgress } = {}) {
  const stock = {};
  let bytes = 0;
  const list = [...(pids || [])];
  for (let i = 0; i < list.length; i += BATCH) {
    const slice = list.slice(i, i + BATCH);
    await Promise.all(slice.flatMap((pid) => (locations || []).map((loc) =>
      get(ref(database, `stock/${loc}/${pid}`)).then((s) => {
        if (!s.exists()) return;
        const v = s.val();
        bytes += weigh(v);
        // Merged per location, so the caller can fold this straight into the
        // context it already holds. `stock[loc]` may already carry other
        // products from an earlier batch.
        (stock[loc] || (stock[loc] = {}))[pid] = v;
      }),
    )));
    onProgress?.(Math.min(i + BATCH, list.length), list.length);
  }
  return { stock, bytes };
}
