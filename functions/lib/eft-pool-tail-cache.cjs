// ─── THE TILL SEARCH'S POOL TAIL — read once per burst, not once per keystroke ─
// eftPoolSearch answers a cashier typing a reference. Every call used to read
// the pool's 400-record tail: ~1.0 MB of database download per KEYSTROKE
// (profiler, 10–11 Nov 2026: bursts of 7–12 reads inside ten seconds, ~500
// reads on a trading day, ~0.5 GB/day — for a list that had not changed
// between two letters of the same word).
//
// This holds the tail in the function instance for a short while, and asks the
// database ONE record's worth of question before trusting it:
//
//   PROBE (every call that could use the held tail, ~2.5 KB): the pool's
//     newest record, `orderByChild("at").limitToLast(1)`. If the held tail does
//     not contain exactly that record, a payment has landed (or the newest one
//     changed) since the tail was read → the tail is read again NOW. A payment
//     that arrives while the customer is at the counter is therefore found on
//     the very next search, exactly as before — never "wait for the cache".
//   TTL (EFT_SEARCH_TAIL_TTL_MS): the held tail is dropped after this long
//     whatever the probe says. It bounds the one thing the probe cannot see —
//     an OLDER record changing (used / released / reversed at another till).
//     For those few seconds a search may still show a just-spent payment as
//     waiting; the settle is a consume-once transaction on the record itself
//     (settleDecision) and refuses it, as it always has for two tills racing.
//
// SEARCH ONLY. The settle, the manual entry and the approve read the tail
// themselves, fresh, every time — money never rides on a held copy.
//
// No whole-node read is added: the full read is the same bounded tail query
// the search always made, and the probe is that query with a limit of one.
//
// PURE of firebase: the two reads are injected, the clock is injected; tested
// in test/eft-pool-tail-cache.test.cjs.

"use strict";

const { isDeepStrictEqual } = require("node:util");

// Long enough to cover one cashier typing one reference (the measured bursts
// are under 15 s end to end); short enough that a payment spent at another
// till stops being offered almost at once.
const EFT_SEARCH_TAIL_TTL_MS = 15 * 1000;

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.readTail    the bounded tail read (key → record)
 * @param {() => Promise<object|null>} deps.readNewest  the tail with a limit of ONE (key → record)
 * @param {() => number} [deps.now]
 * @param {number} [deps.ttlMs]
 * @returns {{ get: () => Promise<object>, clear: () => void, stats: () => {full:number, probes:number, hits:number} }}
 */
function createPoolTailCache({ readTail, readNewest, now = Date.now, ttlMs = EFT_SEARCH_TAIL_TTL_MS }) {
  let held = null;      // { tail, at } — the last tail read that SUCCEEDED
  let loading = null;   // the full read in flight, shared by every caller that needs one
  const counts = { full: 0, probes: 0, hits: 0 };

  /** Does the held tail still end with what the database says is newest? */
  function stillNewest(tail, newest) {
    const entries = Object.entries(newest && typeof newest === "object" ? newest : {});
    // An empty pool matches only an empty held tail.
    if (!entries.length) return Object.keys(tail).length === 0;
    return entries.every(([key, record]) => Object.prototype.hasOwnProperty.call(tail, key) && isDeepStrictEqual(tail[key], record));
  }

  function load() {
    if (!loading) {
      counts.full++;
      const startedAt = now();
      loading = Promise.resolve()
        .then(readTail)
        .then((tail) => {
          const clean = tail && typeof tail === "object" ? tail : {};
          // Stamped with when the read was ASKED, not when it answered: the
          // tail is at least that old, so the TTL can only err towards fresh.
          held = { tail: clean, at: startedAt };
          return clean;
        })
        .finally(() => { loading = null; });
      // A failed read is not held and not swallowed: every waiter sees the
      // error, `held` keeps its previous value (which the TTL still bounds),
      // and the next call tries the database again.
    }
    return loading;
  }

  async function get() {
    // A full read already in flight answers everyone who arrives meanwhile —
    // five keystrokes landing together on a cold instance are one read.
    if (loading) return loading;
    const mine = held;
    if (!mine || now() - mine.at >= ttlMs || now() < mine.at) return load();
    let newest;
    try {
      counts.probes++;
      newest = await readNewest();
    } catch {
      // The probe is an optimisation. If it fails, ask for the tail itself and
      // let THAT read's outcome be the call's outcome, as before this cache.
      return load();
    }
    if (held === mine && stillNewest(mine.tail, newest)) {
      counts.hits++;
      return mine.tail;
    }
    // A newer tail was read while the probe was out: that one is the answer.
    if (held && held !== mine && !loading) return held.tail;
    return load();
  }

  return {
    get,
    clear() { held = null; },
    stats: () => ({ ...counts }),
  };
}

module.exports = { EFT_SEARCH_TAIL_TTL_MS, createPoolTailCache };
