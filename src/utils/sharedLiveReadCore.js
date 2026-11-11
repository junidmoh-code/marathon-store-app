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
// Pure: no firebase, no React, no DOM. `listen(target, onSnap, onErr)` is
// injected and must return an unsubscribe function — exactly onValue's shape.

/** How long a listener outlives its last subscriber. Long enough to cover
 *  moving between screens (the measured gaps are seconds to ~4 minutes),
 *  short enough that an abandoned node stops streaming changes. */
export const LINGER_MS = 10 * 60 * 1000;

export function createSharedLiveReads({
  listen,
  lingerMs = LINGER_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  if (typeof listen !== "function") throw new Error("createSharedLiveReads: listen is required");
  const entries = new Map();   // key -> entry

  const stopListening = (e) => {
    if (e.linger != null) { clearTimer(e.linger); e.linger = null; }
    const stop = e.stop;
    e.stop = null;
    if (stop) { try { stop(); } catch { /* the SDK already dropped it */ } }
  };
  const drop = (e) => {
    stopListening(e);
    if (entries.get(e.key) === e) entries.delete(e.key);
  };

  const start = (e) => {
    e.dead = false;
    // `gen` guards a restart: a callback from a listener that has since been
    // replaced must not overwrite the newer one's value.
    const gen = (e.gen += 1);
    const stop = listen(
      e.makeTarget(),
      (snap) => {
        if (e.gen !== gen || entries.get(e.key) !== e) return;
        e.has = true;
        e.snap = snap;
        for (const s of [...e.subs]) { if (e.subs.has(s)) s.onData(snap); }
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
        for (const s of subs) { if (e.subs.has(s) && s.onError) s.onError(err); }
      },
    );
    // A listener that failed synchronously has already cleared e.stop's slot.
    if (e.gen === gen && !e.dead) e.stop = stop;
    else if (e.gen === gen && e.dead) { try { stop && stop(); } catch { /* gone */ } }
  };

  /**
   * Subscribe to `key`. `makeTarget()` builds the ref or query the FIRST
   * subscriber's listener is opened on; every later subscriber to the same key
   * shares it, so the key must name the query completely (path + constraints).
   *
   * `onData(snapshot)` is called with the value already held, synchronously,
   * when there is one — and then on every change. Returns an unsubscribe.
   */
  function subscribe(key, makeTarget, onData, onError) {
    let e = entries.get(key);
    if (!e) {
      e = { key, makeTarget, subs: new Set(), stop: null, has: false, snap: null,
            dead: false, linger: null, noLinger: false, gen: 0 };
      entries.set(key, e);
    }
    if (e.linger != null) { clearTimer(e.linger); e.linger = null; }
    const sub = { onData, onError };
    e.subs.add(sub);
    if (e.dead || (!e.stop && !e.has)) {
      e.makeTarget = makeTarget;
      start(e);
    } else if (e.has) {
      onData(e.snap);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      e.subs.delete(sub);
      if (e.subs.size > 0 || entries.get(key) !== e) return;
      // `lingerMs` may be a function, so the app's one instance can be told
      // how long to hold after it has been built.
      const ms = typeof lingerMs === "function" ? lingerMs() : lingerMs;
      if (e.dead || e.noLinger || !(ms > 0)) { drop(e); return; }
      e.linger = setTimer(() => { e.linger = null; if (e.subs.size === 0) drop(e); }, ms);
    };
  }

  /** Release every listener nobody is subscribed to, now. */
  function releaseIdle() {
    for (const e of [...entries.values()]) if (e.subs.size === 0) drop(e);
  }

  /** The signed-in identity changed. Idle listeners go now; the ones still in
   *  use carry on exactly as a plain onValue would, but are not kept once
   *  their subscribers leave. */
  function identityChanged() {
    for (const e of [...entries.values()]) {
      if (e.subs.size === 0) drop(e);
      else e.noLinger = true;
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

  return { subscribe, releaseIdle, identityChanged, reset, stats };
}
