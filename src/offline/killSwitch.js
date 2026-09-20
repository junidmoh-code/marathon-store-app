// ─── OFFLINE MIRROR — THE REMOTE KILL SWITCH ─────────────────────────────────
//
// ONE value in the database decides whether every device in the fleet reads
// from its local copy or from RTDB, and it is obeyed LIVE — no reload, no
// deploy, no visit to a device.
//
//   /mirror_switch/enabled = false   →  every device drops to live reads
//   /mirror_switch/enabled = true    →  every device mirrors again
//
// ── WHY THIS HAS TO EXIST BEFORE THE ROLLOUT ────────────────────────────────
//
// The mirror changes where every screen in this app gets its numbers. If it
// turns out to be wrong about one of them, the fix cannot be "push a build and
// hope every tablet picks it up" — a shop tablet can sit on one bundle for
// days. The switch is the one thing that has to work on a bad night, so it is
// the smallest, dumbest mechanism available: a boolean, read by an onValue on
// a five-byte path, and consulted by the single function every mirror read
// path already calls.
//
// ── WHY IT IS SAFE WHEN IT CANNOT BE READ ───────────────────────────────────
//
// The answer a device has never heard is OFF, not ON. A device that cannot
// read the switch — the rule is not pasted, the line is down on a cold boot,
// the user is not signed in — reads live, which is exactly what this app did
// before the mirror existed. It costs money and it is never wrong.
//
// But a device that HAS heard the answer keeps it, in localStorage, across a
// reload and across a dead line. That is the offline case: a tablet in a back
// room with no signal must go on serving the copy it was told to serve, and a
// failed re-read of the switch is not a reason to stop. So:
//
//   a successful read             → that answer, cached
//   a read that fails             → the last cached answer, unchanged
//   no answer ever, no cache      → OFF, live reads, today's behaviour
//
// ── WHAT COUNTS AS "OFF" ────────────────────────────────────────────────────
//
// Anything that could plausibly have been typed to mean off. `false`, the
// string "false", 0, "off", "no". Everything else — true, absent, a value
// nobody expected — is on. The asymmetry is deliberate: a fat-fingered kill is
// still a kill, and the failure that matters is a switch that was flipped and
// did not take.
//
// The node being ABSENT reads as on, once the read has actually succeeded. A
// successful read proves the rule is pasted and the line is up; "nobody has
// ever written the value" is then the normal steady state of a fleet that has
// never needed killing, not an outage.

// The node, and the one child devices read. Reading the CHILD rather than the
// node means a future sibling (a note saying who flipped it and why) costs the
// fleet nothing.
export const MIRROR_SWITCH_NODE = "mirror_switch";
export const MIRROR_SWITCH_PATH = "mirror_switch/enabled";

// The last answer heard, kept across reloads. A HINT about a remote value, not
// data — same rules as serving.js: a lone string, read and written whole,
// never read-modify-written.
export const SWITCH_CACHE_KEY = "marathon-store.offlineMirror.switch";

// How long a first boot waits for the switch before carrying on without it.
// Nothing is blocked while it waits — the app has already rendered and is
// reading live — so this only decides how long a fresh device takes to start
// mirroring, never how long anyone looks at a spinner.
export const SWITCH_WAIT_MS = 6000;

let state = null;              // { on, at } once heard; null until then
let loaded = false;            // has the cache been consulted this session?
let watching = false;
let firstAnswer = null;        // promise resolved by the first read of any kind
let resolveFirst = null;
const listeners = new Set();

/**
 * What a raw value at /mirror_switch/enabled means.
 *
 * Exported and pure so the mapping is testable without a database, and so the
 * one asymmetry in it — everything unrecognised is ON, everything that looks
 * like a person typing "off" is OFF — is a thing a reader can see rather than
 * infer.
 */
export function switchVerdict(raw) {
  if (raw === false || raw === 0) return false;
  if (typeof raw === "string" && /^(false|off|no|0)$/i.test(raw.trim())) return false;
  return true;
}

function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SWITCH_CACHE_KEY) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.on === "boolean") state = { on: parsed.on, at: parsed.at ?? null };
  } catch { /* a cache that cannot be read is simply no cache */ }
}

/**
 * The switch, RIGHT NOW, synchronously.
 *
 * Synchronous because a hook decides on its FIRST RENDER whether to open a
 * live onValue, and an answer that arrives later arrives after the money is
 * spent (serving.js's header has the long version).
 */
export function mirrorSwitchOn() {
  loadCache();
  return state?.on === true;
}

/** Has this device ever heard an answer? Used by the health record and the gate. */
export function mirrorSwitchKnown() {
  loadCache();
  return state !== null;
}

export function mirrorSwitchState() {
  loadCache();
  return state ? { ...state, known: true } : { on: false, at: null, known: false };
}

/**
 * Record an answer and tell everyone who is listening.
 *
 * This is the ONLY way the value changes, and it is what the live subscription
 * calls. Tests call it directly, which keeps them honest about the thing that
 * actually drives the app rather than about a test-only back door.
 */
export function setMirrorSwitchValue(raw, { now = Date.now } = {}) {
  loadCache();
  const on = switchVerdict(raw);
  const changed = state?.on !== on;
  state = { on, at: now() };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SWITCH_CACHE_KEY, JSON.stringify(state));
    }
  } catch { /* private mode: the answer holds for this tab, which still works */ }
  if (resolveFirst) { resolveFirst(on); resolveFirst = null; }
  // Notified on every answer, not only a change: the first answer of a session
  // is not a "change" and is exactly the one a gate is waiting for.
  for (const l of listeners) { try { l(on); } catch { /* a listener never breaks the switch */ } }
  return changed;
}

/**
 * A read that FAILED. Deliberately not the same thing as an answer: it leaves
 * the cached value exactly where it was, and only releases anyone waiting on a
 * first answer so they stop waiting.
 */
export function noteMirrorSwitchUnreadable(err) {
  console.warn("offline mirror: could not read the kill switch —", err?.message ?? err);
  if (resolveFirst) { resolveFirst(mirrorSwitchOn()); resolveFirst = null; }
}

export function subscribeMirrorSwitch(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Open the live subscription. Idempotent — several callers may ask, one
 * subscription exists.
 *
 * `subscribe` is injected so this module has no firebase import of its own and
 * can be tested against a plain function. The default is wired in by
 * `watchMirrorSwitchLive` below, which is the only firebase-aware part.
 */
export function watchMirrorSwitch({ subscribe }) {
  if (watching) return () => {};
  watching = true;
  let stop = () => {};
  try {
    stop = subscribe(
      (value) => setMirrorSwitchValue(value),
      (err) => noteMirrorSwitchUnreadable(err),
    ) ?? (() => {});
  } catch (err) {
    watching = false;
    noteMirrorSwitchUnreadable(err);
    return () => {};
  }
  return () => {
    watching = false;
    try { stop(); } catch { /* ignore */ }
  };
}

export function mirrorSwitchIsWatched() { return watching; }

/**
 * Resolves when this device has heard an answer, or when it has waited long
 * enough to carry on without one. Never rejects; the value is
 * `mirrorSwitchOn()` either way.
 */
export function ensureMirrorSwitch({ timeoutMs = SWITCH_WAIT_MS } = {}) {
  loadCache();
  if (!firstAnswer) {
    firstAnswer = new Promise((resolve) => { resolveFirst = resolve; });
  }
  if (!(timeoutMs > 0)) return firstAnswer;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(mirrorSwitchOn()), timeoutMs);
  });
  return Promise.race([firstAnswer, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// ── THE LIVE READ ───────────────────────────────────────────────────────────
//
// firebase/database is imported lazily, inside the call, so this module stays
// importable by anything (including the synchronous read paths) without
// pulling the SDK in behind it.
//
// It is ONE onValue on ONE boolean. At five bytes a change and nothing at all
// between changes, it is the cheapest thing this app subscribes to, and it has
// to be a subscription rather than a poll: the whole promise of the switch is
// "flip it and the fleet obeys", and a poll makes that "flip it and wait".
export function watchMirrorSwitchLive() {
  return watchMirrorSwitch({
    subscribe: (onAnswer, onError) => {
      let unsub = null;
      let cancelled = false;
      (async () => {
        try {
          const [{ ref, onValue }, { database }] = await Promise.all([
            import("firebase/database"),
            import("../firebase"),
          ]);
          if (cancelled) return;
          unsub = onValue(
            ref(database, MIRROR_SWITCH_PATH),
            (snap) => onAnswer(snap.exists() ? snap.val() : null),
            (err) => onError(err),
          );
        } catch (err) { onError(err); }
      })();
      return () => { cancelled = true; if (unsub) unsub(); };
    },
  });
}

// `keepCache` is what a RELOAD looks like from in here: everything this module
// holds in memory is gone, and the localStorage answer is still on the device.
export function _resetMirrorSwitchForTests({ keepCache = false } = {}) {
  state = null;
  loaded = false;
  watching = false;
  firstAnswer = null;
  resolveFirst = null;
  listeners.clear();
  if (keepCache) return;
  try { localStorage?.removeItem(SWITCH_CACHE_KEY); } catch { /* ignore */ }
}
