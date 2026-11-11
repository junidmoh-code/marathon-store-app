// ─── ONE LIVE SUBSCRIPTION PER PATH, KEPT ACROSS SCREEN SWITCHES ─────────────
//
// WHAT THIS COSTS WITHOUT IT. The Realtime Database SDK keeps a node's data
// only while something is listening to it. Every hook in this app opened its
// own onValue in an effect and closed it on unmount, so leaving a screen
// dropped the node and opening the next screen — very often one that reads the
// SAME node — downloaded all of it again. Measured from the profiler, 10–11
// Nov 2026, 21 hours: one phone moving between the Refill, Health and Source
// screens re-downloaded /refill_requests (15.6 MB) 28 times in ninety minutes;
// across the fleet 874 MB of 2,629 MB of client listens were a node the same
// page had held less than ten minutes earlier.
//
// WHAT THIS DOES. One real listener per key, shared by every subscriber, and
// held for LINGER_MS after the last one leaves. A screen that mounts inside
// that window is handed the value already in memory and the listener simply
// carries on — the server sends nothing but the changes it would have sent
// anyway.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//   - It never serves a value the server has not confirmed is current: the
//     cached snapshot is the listener's own latest, and it is dropped the
//     moment the listener is.
//   - It never keeps a listener for a page nobody can see. A lingering entry
//     with no subscriber is released as soon as the page is hidden
//     (releaseIdle) — a phone in a pocket reconnects through the night, and a
//     held listener is re-sent on every reconnect.
//   - It never hands one signed-in person's rows to the next: an identity
//     change releases every idle entry and ends lingering for the rest.
//   - A listener the server CANCELLED (permission denied) is dead in the SDK.
//     It is marked dead here and the next subscriber opens a fresh one, which
//     is what remounting a hook did before.
//
//   - It never holds more than a phone can afford. Only the MAX_IDLE_HEAVY
//     most recently left big nodes are kept, within MAX_IDLE_BYTES in all; the
//     oldest is released first. Sizes are per-path HINTS from the policy —
//     nothing is serialised to be measured.
//   - It never replays a held value it cannot vouch for. After the connection
//     drops, or the signed-in identity changes, an entry still in use is
//     marked no-replay: a NEW subscriber is not handed the held snapshot, the
//     listener is reopened and everybody gets the server's fresh answer.
//   - A subscriber that throws does not stop the others being told, and does
//     not stay subscribed.
//
// HOW LONG, PER PATH. Holding only pays for a big node that changes slowly.
// `policy(key)` answers { lingerMs, bytes } for each key; the app's table is
// in sharedLiveRead.js (ten minutes for the big ones, seconds for the rest).
//
// Pure: no firebase, no React, no DOM. `listen(target, onSnap, onErr)` is
// injected and must return an unsubscribe function — exactly onValue's shape.

/** The long hold: covers moving between screens (measured gaps are seconds
 *  to ~4 minutes). For big, slow-changing nodes only. */
export const LINGER_MS = 10 * 60 * 1000;
/** The short hold: a tab toggle, a strict-mode remount. The default. */
export const SHORT_LINGER_MS = 25 * 1000;
/** A held node at least this big counts against MAX_IDLE_HEAVY. */
export const HEAVY_BYTES = 1024 * 1024;
/** Big nodes kept after their last subscriber left: the most recent three. */
export const MAX_IDLE_HEAVY = 3;
/** …and never more than this in all, by the policy's size hints. The newest
 *  idle entry is always kept, whatever its size, or the biggest node — the one
 *  holding pays most for — could never be held at all. */
export const MAX_IDLE_BYTES = 32 * 1024 * 1024;

export function createSharedLiveReads({
  listen,
  // (key) => { lingerMs, bytes } — or a number / () => number for one hold for all.
  policy = null,
  lingerMs = LINGER_MS,
  maxIdleHeavy = MAX_IDLE_HEAVY,
  maxIdleBytes = MAX_IDLE_BYTES,
  heavyBytes = HEAVY_BYTES,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  warn = (...a) => console.warn(...a),
} = {}) {
  if (typeof listen !== "function") throw new Error("createSharedLiveReads: listen is required");
  const entries = new Map();   // key -> entry
  let idleSeq = 0;             // release order: higher = left more recently

  const policyFor = (key) => {
    let p = null;
    if (typeof policy === "function") p = policy(key);
    if (p == null) p = typeof lingerMs === "function" ? lingerMs(key) : lingerMs;
    if (typeof p === "number") p = { lingerMs: p, bytes: 0 };
    return { lingerMs: Number(p && p.lingerMs) || 0, bytes: Math.max(0, Number(p && p.bytes) || 0) };
  };

  // Held, but not to be handed to anyone new: fed by a connection that has
  // since dropped, or read under an identity that has since changed.
  const noReplay = (e) => e.offline || e.foreign;

  const stopListening = (e) => {
    if (e.linger != null) { clearTimer(e.linger); e.linger = null; }
    const stop = e.stop;
    e.stop = null;
    if (stop) { try { stop(); } catch { /* the SDK already dropped it */ } }
  };
  const drop = (e) => {
    stopListening(e);
    e.has = false;
    e.snap = null;
    if (entries.get(e.key) === e) entries.delete(e.key);
  };

  // One subscriber's callback. A throw is that subscriber's bug: it is logged
  // and the others are still told.
  const tell = (e, s, fn, arg) => {
    try { fn(arg); } catch (err) { warn(`shared live read: a subscriber to /${e.key} threw:`, err); }
  };

  const start = (e) => {
    e.dead = false;
    // `gen` guards a restart: a callback from a listener that has since been
    // replaced must not overwrite the newer one's value.
    const gen = (e.gen += 1);
    let stop;
    try {
      stop = listen(
        e.makeTarget(),
        (snap) => {
          if (e.gen !== gen || entries.get(e.key) !== e) return;
          e.has = true;
          e.snap = snap;
          e.offline = false;        // the server's own answer: vouched for again
          e.foreign = false;
          for (const s of [...e.subs]) { if (e.subs.has(s)) tell(e, s, s.onData, snap); }
        },
        (err) => {
          if (e.gen !== gen || entries.get(e.key) !== e) return;
          // Cancelled by the server. Nothing is cached past this point: a value
          // that can no longer be read must not be handed to a later subscriber.
          e.dead = true;
          e.has = false;
          e.snap = null;
          e.stop = null;
          if (e.linger != null) { clearTimer(e.linger); e.linger = null; }
          const subs = [...e.subs];
          if (subs.length === 0) entries.delete(e.key);
          for (const s of subs) { if (e.subs.has(s) && s.onError) tell(e, s, s.onError, err); }
        },
      );
    } catch (err) {
      // The listener could not even be opened. Nothing is listening and
      // nothing is cached; the caller decides who hears about it.
      if (e.gen === gen) { e.dead = true; e.has = false; e.snap = null; e.stop = null; }
      throw err;
    }
    // A listener that failed synchronously has already cleared e.stop's slot.
    if (e.gen === gen && !e.dead) e.stop = stop;
    else if (e.gen === gen && e.dead) { try { stop && stop(); } catch { /* gone */ } }
  };

  // ── THE CAP ON WHAT IS HELD FOR NOBODY ────────────────────────────────────
  // Oldest-released first, until at most `maxIdleHeavy` big nodes and
  // `maxIdleBytes` in all remain. The newest idle entry always survives.
  const enforceIdleCap = () => {
    const idle = [...entries.values()].filter((e) => e.subs.size === 0 && e.linger != null)
      .sort((a, b) => b.idleSeq - a.idleSeq);          // newest first
    let heavy = 0; let bytes = 0;
    idle.forEach((e, i) => {
      const isHeavy = e.bytes >= heavyBytes;
      const over = i > 0 && ((isHeavy && heavy >= maxIdleHeavy) || bytes + e.bytes > maxIdleBytes);
      if (over) { drop(e); return; }
      if (isHeavy) heavy += 1;
      bytes += e.bytes;
    });
  };

  const release = (e, { linger = true } = {}) => {
    if (e.subs.size > 0 || entries.get(e.key) !== e) return;
    const p = policyFor(e.key);
    // A value that may not be replayed is not worth holding.
    if (!linger || e.dead || e.noLinger || noReplay(e) || !(p.lingerMs > 0)) { drop(e); return; }
    e.bytes = p.bytes;
    e.idleSeq = (idleSeq += 1);
    e.linger = setTimer(() => { e.linger = null; if (e.subs.size === 0) drop(e); }, p.lingerMs);
    enforceIdleCap();
  };

  /**
   * Subscribe to `key`. `makeTarget()` builds the ref or query the FIRST
   * subscriber's listener is opened on; every later subscriber to the same key
   * shares it, so the key must name the query completely (path + constraints).
   *
   * `onData(snapshot)` is called with the value already held, synchronously,
   * when there is one that can be vouched for — and then on every change.
   *
   * Returns an unsubscribe. `unsubscribe({ linger: false })` closes the
   * listener at once if this was the last subscriber (the caller has another
   * source now and will not be back).
   */
  function subscribe(key, makeTarget, onData, onError) {
    let e = entries.get(key);
    if (!e) {
      e = { key, makeTarget, subs: new Set(), stop: null, has: false, snap: null,
            dead: false, linger: null, noLinger: false, offline: false, foreign: false, gen: 0,
            bytes: 0, idleSeq: 0 };
      entries.set(key, e);
    }
    if (e.linger != null) { clearTimer(e.linger); e.linger = null; }
    const sub = { onData, onError };
    e.subs.add(sub);
    // Anything thrown before the unsubscribe exists would leave this
    // subscriber registered with no way to remove it — so it is removed here,
    // and the caller sees its own error exactly as it would from a bare onValue.
    const undo = (err) => { e.subs.delete(sub); release(e); throw err; };
    if (e.dead || (!e.stop && !e.has) || noReplay(e)) {
      // Dead, new, or holding a value that can no longer be vouched for: (re)open
      // it. Everybody subscribed gets the server's fresh answer.
      if (e.stop) stopListening(e);
      e.has = false;
      e.snap = null;
      e.offline = false;
      e.foreign = false;
      e.noLinger = false;          // a fresh listener, opened under whoever is signed in now
      e.makeTarget = makeTarget;
      try { start(e); } catch (err) { undo(err); }
    } else if (e.has) {
      try { onData(e.snap); } catch (err) { undo(err); }
    }
    let done = false;
    return (opts) => {
      if (done) return;
      done = true;
      e.subs.delete(sub);
      release(e, opts);
    };
  }

  /** Release every listener nobody is subscribed to, now. */
  function releaseIdle() {
    for (const e of [...entries.values()]) if (e.subs.size === 0) drop(e);
  }

  /** The connection dropped. Idle listeners go now; a value still on a screen
   *  stays there (as with a bare onValue) but is not replayed to anyone new
   *  until the server has answered again. */
  function connectionLost() {
    for (const e of [...entries.values()]) {
      if (e.subs.size === 0) drop(e);
      else e.offline = true;
    }
  }

  /** The connection is back AND the server has answered everything the SDK
   *  re-sent for the listeners it holds (the caller proves that — see
   *  sharedLiveRead.js). What is held is current again. This never clears an
   *  identity change: only a fresh snapshot does. */
  function connectionRestored() {
    for (const e of entries.values()) e.offline = false;
  }

  /** The signed-in identity changed. Idle listeners go now; the ones still in
   *  use carry on exactly as a plain onValue would, but their held value is
   *  never replayed to a new subscriber and they are not kept once their
   *  subscribers leave. */
  function identityChanged() {
    for (const e of [...entries.values()]) {
      if (e.subs.size === 0) drop(e);
      else { e.noLinger = true; e.foreign = true; }
    }
  }

  function reset() {
    for (const e of [...entries.values()]) drop(e);
  }

  const stats = () => ({
    listeners: [...entries.values()].filter((e) => e.stop).length,
    idle: [...entries.values()].filter((e) => e.subs.size === 0).length,
    keys: [...entries.keys()],
  });

  return { subscribe, releaseIdle, connectionLost, connectionRestored, identityChanged, reset, stats };
}
