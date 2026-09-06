// ─── THE IN-APP CHIME ────────────────────────────────────────────────────────
// A two-note chime, synthesised. No asset, no fetch, no decode — so it works on
// the shop's slow link, works offline, and adds nothing to the bundle.
//
// ── THE UNLOCK IS NOT OPTIONAL ──────────────────────────────────────────────
// Every browser blocks audio until the page has had one real user gesture. A
// chime scheduled before that does not error and does not play; it is silently
// dropped, and the first refill request of the day makes no sound while the
// code looks like it worked. So the first tap, click or key press after load
// resumes the AudioContext, once, and the listener removes itself.
//
// This is the same discipline the TV board's pickup voice uses (App.jsx), with
// one deliberate difference: the TV asks for an explicit "enable sound" tap
// because it is an unattended screen nobody touches. This runs on a phone in
// someone's hand, which is tapped within seconds of opening — so it rides the
// first gesture rather than spending a control on it.

let ctx = null;
let unlocked = false;
let listening = false;

function Ctx() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function context() {
  const C = Ctx();
  if (!C) return null;
  if (!ctx) {
    try { ctx = new C(); } catch { return null; }
  }
  return ctx;
}

/** Arm the one-shot unlock. Safe to call repeatedly; only the first arms. */
export function armAudioUnlock() {
  if (listening || unlocked || typeof window === "undefined") return;
  listening = true;
  const unlock = () => {
    unlocked = true;
    // resume() returns a PROMISE. A bare try/catch catches only a synchronous
    // throw, so a rejection here (a closed context, a browser restriction)
    // would reach the global unhandledrejection listener in main.jsx and paint
    // the FATAL RED BANNER across a staff member's screen — for a chime.
    try { context()?.resume?.()?.catch?.(() => {}); } catch { /* nothing better available */ }
    // The capture flag is PART OF THE LISTENER'S IDENTITY: removing without it
    // removes nothing, and the listener stays for the life of the page calling
    // resume() on every tap forever. The first draft had this mismatch, and the
    // test that "proved" removal passed only because its fake window ignored
    // the options argument.
    for (const ev of ["pointerdown", "touchstart", "keydown"]) {
      window.removeEventListener(ev, unlock, { capture: true });
    }
    listening = false;
  };
  // Capture phase, so a gesture consumed by a component still unlocks audio.
  for (const ev of ["pointerdown", "touchstart", "keydown"]) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }
}

/** True once a user gesture has unlocked playback for this page load. */
export function audioUnlocked() {
  return unlocked;
}

/**
 * Two rising notes, ~350ms total. A no-op — never a throw — when audio is
 * locked or unavailable: a silent app is a small disappointment, a crashed one
 * during a stock count is not.
 */
export function playChime() {
  if (!unlocked) return false;
  const c = context();
  if (!c) return false;
  try {
    // Same reason as in armAudioUnlock: an unhandled rejection here would show
    // the app's fatal error banner. playChime promises never to throw, and an
    // unhandled rejection is not covered by that promise unless it is caught.
    if (c.state === "suspended") c.resume()?.catch?.(() => {});
    const start = c.currentTime + 0.01;
    // E5 then B5 — a rising interval reads as "something arrived" rather than
    // as an error tone.
    [[659.25, 0], [987.77, 0.16]].forEach(([freq, offset]) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // A short attack and an exponential tail: a bare on/off gate clicks
      // audibly on most phone speakers.
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.22, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.34);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.36);
    });
    return true;
  } catch {
    return false;
  }
}
