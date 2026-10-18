// ─── TV PICKUP VOICE — keep the audio unlock alive for the life of the page ───
//
// The board speaks from preloaded clips through ONE Web Audio context (see
// TvWithAutoCollect in App.jsx). Chrome creates that context SUSPENDED until
// the page has had a user gesture, and the gesture is per page load: every
// reload starts locked again. Until Oct 2026 the only unlock was a big "Tap once to
// enable pickup voice" button, and the board reloaded itself on every hosting
// deploy (5–10 a day, mostly in trading hours), so the voice the staff turned
// on at 09:00 was gone by the first deploy of the morning.
//
// This module owns the unlock so nobody has to think about it:
//   - it tries to start audio on load, with no gesture. On a correctly launched
//     TV (deploy/tv: Chrome with --autoplay-policy=no-user-gesture-required)
//     that simply works and nothing is ever shown;
//   - it remembers in localStorage that this screen is a voice screen;
//   - it re-arms on ANY touch, key or focus, silently, and re-checks on
//     visibility changes and every few minutes with a silent primer;
//   - it only reports "blocked" when the browser really refused, and the UI
//     shows a small corner hint for that case alone — never in kiosk mode.
//
// Pure of React and of the DOM globals: every dependency is injected so the
// state machine is unit-tested in node (tvVoiceKeeper.test.js).

export const VOICE_ARMED_KEY = "marathon.tv.voiceArmed";
export const PRIMER_EVERY_MS = 4 * 60 * 1000;   // silent primer cadence
export const RESUME_SETTLE_MS = 1500;           // how long a resume() gets before we judge it
export const START_RETRY_MS = 3000;             // an announcement that hasn't started by now is retried once

/** `?kiosk=1` — set by the deploy/tv launchers. */
export function isKioskLaunch(search) {
  try { return new URLSearchParams(search || "").get("kiosk") === "1"; } catch { return false; }
}

export function readVoiceArmed(storage) {
  try { return storage?.getItem(VOICE_ARMED_KEY) === "1"; } catch { return false; }
}

function writeVoiceArmed(storage) {
  try { storage?.setItem(VOICE_ARMED_KEY, "1"); } catch { /* private window — the unlock still works for this load */ }
}

/** The corner hint shows only when the browser really blocked audio, and never on a kiosk launch. */
export function shouldShowVoiceHint({ kiosk, state }) {
  return !kiosk && state === "blocked";
}

/**
 * Whether the board should try to speak at all. A kiosk launch always does; so
 * does a screen that has been armed before (the persisted flag) — each
 * announcement then resumes audio itself, which Chrome allows on a site the
 * TV has played sound on, and a refusal is logged and brings the hint back.
 * A screen never armed and not yet running stays quiet (orders are marked
 * seen silently, so arming later never recites a backlog).
 */
export function voiceWanted({ kiosk, state, armedBefore = false }) {
  if (state === "unsupported") return false;
  return !!kiosk || state === "armed" || !!armedBefore;
}

/** One silent frame through the context: proves (and keeps) the output path alive. */
export function playSilentPrimer(ctx) {
  const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
}

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
};

/**
 * @param {object} o
 * @param {() => AudioContext|null} o.getCtx  the board's context (it is created and closed by the board)
 * @param {Storage} [o.storage]               localStorage
 * @param {EventTarget} [o.win]               window — pointer/key/focus
 * @param {EventTarget & {visibilityState?:string}} [o.doc]  document — visibilitychange
 * @param {(state:string) => void} [o.onChange]
 * States: "starting" → "armed" | "blocked" | "unsupported".
 */
export function createVoiceKeeper({
  getCtx, storage = null, win = null, doc = null, onChange = () => {}, onDrop = () => {},
  log = console, timers = defaultTimers, primerEveryMs = PRIMER_EVERY_MS,
}) {
  let state = "starting";
  let stopped = false;
  let primerTimer = null;
  const offs = [];

  const setState = (s) => {
    if (s === state) return;
    state = s;
    try { onChange(s); } catch { /* a listener never breaks the keeper */ }
  };
  const isRunning = () => getCtx()?.state === "running";
  const markArmed = () => { writeVoiceArmed(storage); setState("armed"); };

  // Ask the context to run and play the silent primer. resume() MUST be called
  // synchronously inside a gesture handler for the gesture to count, so this
  // does both before awaiting anything. Resolves true when audio is running.
  function poke(reason) {
    const ctx = getCtx();
    if (!ctx) { setState("unsupported"); return Promise.resolve(false); }
    if (ctx.state === "closed") return Promise.resolve(false); // the board is tearing down
    let p = null;
    try { p = ctx.resume?.(); } catch (e) { log.warn?.(`TV voice: resume() threw on ${reason}:`, e?.message || e); }
    try { playSilentPrimer(ctx); } catch (e) { log.warn?.(`TV voice: primer failed on ${reason}:`, e?.message || e); }
    if (isRunning()) { markArmed(); return Promise.resolve(true); }
    return new Promise((resolve) => {
      let settled = false;
      const judge = () => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(t);
        if (stopped) { resolve(false); return; }
        if (isRunning()) { markArmed(); resolve(true); return; }
        // Chrome leaves resume() pending (not rejected) while it is blocked.
        if (state !== "blocked") {
          log.warn?.(`TV voice: the browser is blocking audio (context ${getCtx()?.state || "gone"} after ${reason}). `
            + "Launch the TV with deploy/tv so it never needs a tap; a touch anywhere re-arms it.");
        }
        setState("blocked");
        resolve(false);
      };
      const t = timers.setTimeout(judge, RESUME_SETTLE_MS);
      Promise.resolve(p).then(judge, (e) => {
        log.warn?.(`TV voice: resume() rejected on ${reason}:`, e?.message || e);
        judge();
      });
    });
  }

  function listen(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    offs.push(() => target.removeEventListener(type, fn, opts));
  }

  function start() {
    stopped = false;
    const onGesture = () => { poke("touch"); };
    // Capture phase so a touch anywhere — even one the board itself handles —
    // counts, and passive so it can never block the board's own handling.
    listen(win, "pointerdown", onGesture, { capture: true, passive: true });
    listen(win, "touchstart", onGesture, { capture: true, passive: true });
    listen(win, "keydown", onGesture, { capture: true, passive: true });
    listen(win, "focus", () => { poke("focus"); });
    listen(doc, "visibilitychange", () => { if (doc.visibilityState !== "hidden") poke("visible"); });
    const ctx = getCtx();
    if (ctx && "onstatechange" in ctx) {
      const onState = () => {
        if (stopped) return;
        if (ctx.state === "running") markArmed();
        else if (ctx.state !== "closed" && state === "armed") poke("statechange");
      };
      listen(ctx, "statechange", onState);
    }
    primerTimer = timers.setInterval(() => { if (!stopped) poke("primer"); }, primerEveryMs);
    return poke("load");
  }

  function stop() {
    stopped = true;
    if (primerTimer !== null) timers.clearInterval(primerTimer);
    primerTimer = null;
    while (offs.length) { try { offs.pop()(); } catch { /* ignore */ } }
  }

  // Run fn once audio is running: now if it already is, else after a resume,
  // else once more after START_RETRY_MS. A drop is logged with the reason.
  function whenRunning(fn, label) {
    if (isRunning()) { fn(); return; }
    poke("announce").then((ok) => {
      if (ok) { fn(); return; }
      timers.setTimeout(() => {
        if (stopped) return;
        poke("announce retry").then((ok2) => {
          if (ok2) fn();
          else {
            log.warn?.(`TV voice: "${label}" not spoken — audio is ${getCtx()?.state || "gone"} (browser autoplay block).`);
            try { onDrop(label); } catch { /* ignore */ }
          }
        });
      }, START_RETRY_MS);
    });
  }

  // After scheduling clips, check START_RETRY_MS later that the audio clock
  // actually moved. A context whose clock is frozen (output device asleep, a
  // stalled audio thread) holds the queue forever and every later announcement
  // stacks behind it — so cancel the stuck queue and retry the announcement once.
  function guardStart({ sources, onCancel, retry, label }) {
    const ctx = getCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    timers.setTimeout(() => {
      if (stopped || getCtx() !== ctx) return;
      if (ctx.currentTime - t0 >= 0.5) return; // the clock is moving → it is playing
      log.warn?.(`TV voice: "${label}" did not start within ${START_RETRY_MS / 1000}s (audio ${ctx.state}) — `
        + (retry ? "cancelling the stuck queue and retrying once." : "cancelling it; already retried."));
      for (const s of sources || []) { try { s.stop(); } catch { /* never started */ } }
      try { onCancel?.(); } catch { /* ignore */ }
      if (retry) whenRunning(retry, label);
    }, START_RETRY_MS);
  }

  return { start, stop, poke, whenRunning, guardStart, getState: () => state };
}
