// ─── ARMING — THE READ, AND WHAT IT COSTS ────────────────────────────────────
//
// The Arming tab is the only screen in this card that asks about the whole
// catalogue at once, so its read is the thing most worth being explicit about.
//
// ── WHAT IT READS, AND WHAT IT REFUSES TO ────────────────────────────────────
// FOUR one-shot location-scoped get()s, the same shape useStockCells(loc) and
// useStockTargets(loc) make everywhere else in this folder:
//
//     /stock/hub1          /stock_targets/hub1
//     /stock/hub2          /stock_targets/hub2
//
// PLUS TWO SUBSCRIPTIONS THE TAB OPENS THROUGH ITS HOOKS, named here because an
// earlier version of this comment said "four reads and nothing else" and that
// was not true:
//
//     /locations             useLocations()        ~1 KB
//     /config/refillEngine   useEngineConfigState()  6.6 KB
//
// Both are onValue listeners, both are tiny, and both are the same hooks the
// Seating tab uses — but the Seating tab is UNMOUNTED while Arming is open (the
// card renders its tabs by a mutually-exclusive ternary), so on this screen they
// are this screen's. No test can see them either: every suite mocks ./useStock
// wholesale, so adding a listener there would turn nothing red. Naming them is
// the only honest control available. (Adversarial review, PR #601.)
//
// It does NOT read /stock, /stock_targets or /products. /products is already
// subscribed app-wide by useProducts() and is handed in as a prop exactly as
// the Seating tab takes it, so the catalogue costs this tab nothing it was not
// already costing.
//
// ── THE NUMBERS, MEASURED AGAINST LIVE ON 2026-09-11 ─────────────────────────
//     /stock/hub1            512 KB        /stock_targets/hub1      40 KB
//     /stock/hub2          1,405 KB        /stock_targets/hub2     785 KB
//                                                        total  ≈ 2.68 MB
//
// For comparison, the whole of /stock is 6.18 MB across its ten locations, and
// resolving the engine's dead-size rule exactly would need every byte of it.
// The two hubs are 1.87 MB of that, so the eight this tab does not read whole
// are 4.31 MB.
//
// (An earlier version of this comment said 3.8 MB, arrived at by subtracting
// the tab's 2.68 MB total from /stock's — a category error, because 825 KB of
// that total is /stock_targets and is not part of /stock at all.)
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
// stock held somewhere else. 184 products live — 185 (product, hub) pairs —
// the same count armingCore.js derives, from the same pass.
//
// Settled with the SEATING TAB'S OWN READ — /stock/{loc}/{pid}, one product at
// a time — over the locations the tab does not already hold. Never a whole
// node: that is the read this tab was built to avoid, and doing it here to tidy
// up the residue by reading those nodes whole would spend a further 4.31 MB to
// settle 185 (product, hub) pairs out of 9,520. Per product it is ~320 KB.
//
// Batched, because 184 products across 8 locations is 1,472 requests and firing
// them all at once is how a shop phone drops the lot. Each response is a few
// hundred bytes.
//
// THE BATCH BOUNDS REQUESTS, NOT PRODUCTS. It used to slice the PRODUCT list and
// then multiply each one by every location, so a "batch of 24" put 24 × 8 = 192
// gets on the wire at once — eight times the bound this comment claimed.
// Flattening to (product, location) pairs first is what makes the number true.
// (CodeRabbit, PR #601.)
const BATCH = 24;

export async function resolveUndecided(pids, locations, { onProgress } = {}) {
  const stock = {};
  let bytes = 0;
  const list = [...(pids || [])];
  const locs = [...(locations || [])];
  const jobs = list.flatMap((pid) => locs.map((loc) => [pid, loc]));
  let reads = 0;
  for (let i = 0; i < jobs.length; i += BATCH) {
    await Promise.all(jobs.slice(i, i + BATCH).map(([pid, loc]) => {
      reads += 1;
      return get(ref(database, `stock/${loc}/${pid}`)).then((s) => {
        if (!s.exists()) return;
        const v = s.val();
        bytes += weigh(v);
        // Merged per location, so the caller can fold this straight into the
        // context it already holds. `stock[loc]` may already carry other
        // products from an earlier batch.
        (stock[loc] || (stock[loc] = {}))[pid] = v;
      });
    }));
    // PROGRESS IS IN PRODUCTS, because that is the unit the screen names. The
    // jobs are ordered product-major, so the count of whole products finished
    // is the job index divided by the number of locations.
    onProgress?.(
      locs.length ? Math.min(Math.floor((i + BATCH) / locs.length), list.length) : list.length,
      list.length,
    );
  }
  return { stock, bytes, readCount: reads };
}
