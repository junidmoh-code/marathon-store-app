// ─── NOTHING MAY HANG — the one bounded-read primitive ───────────────────────
//
// WHY THIS FILE EXISTS ───────────────────────────────────────────────────────
// Ported from marathon-pos-app, where the first real-world offline test found
// three separate places where the app simply stopped, all with the same shape and none of them a mirror bug:
//
//   - the customer picker span for 4+ minutes on a spinner (a whole-node
//     onValue on /customers that never fires while RTDB is unreachable),
//   - a Storage fetch hung for TWO MINUTES (firebase/storage retries for its
//     default 2-minute operation window before giving up),
//   - a sync pass that started while connected and lost the line mid-page hung
//     on `get()` for ever, and since the next pass is only scheduled in that
//     pass's `.finally`, the WHOLE ENGINE stopped until the tab was reloaded.
//
// The firebase SDKs do not fail fast offline: a `get()` is queued against a
// connection that may return, and an `onValue` simply never calls back. That is
// correct for a background writer and catastrophic for anything a person is
// standing in front of. So every read on a path a person waits on goes through
// this file, and the answer is always one of two things — a value, or an honest
// failure inside a stated number of milliseconds. Never silence.
//
// A TIMEOUT IS NOT AN ERROR TO SWALLOW. `OfflineTimeoutError` carries the label
// of what was being read and how long we waited, so the caller can say
// "Customers could not be reached" instead of rendering an empty list, which an
// operator reads as "this customer does not exist".

export class OfflineTimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} did not answer within ${ms} ms — the office may be unreachable`);
    this.name = "OfflineTimeoutError";
    this.label = label;
    this.ms = ms;
  }
}

export const isTimeout = (err) => err instanceof OfflineTimeoutError
  || err?.name === "OfflineTimeoutError";

// Default budgets. These are what a person at a counter will tolerate, not what
// a network is capable of: a device that cannot answer in this long must
// say so and move on, because the mirror can answer instead.
export const READ_TIMEOUT_MS = 8000;        // a bounded, indexed RTDB read
// 90 s, not 30. A /stock page is ONE location — up to 1.6 MB (marathon-pe,
// hub2, central) — and on a shop line that is not a 30-second read. Worse, a
// device's reads share one websocket, so while a big page crawls in, every
// small read queued behind it times out too. On 21 Sep five tablets (PE, the
// TV, Xoli, Zee, Shukulan) timed out on nearly every leg and benched them.
// A timed-out read is not cancelled — its bytes arrive anyway — so a longer
// wait costs nothing and a retry costs the page again.
export const BIG_READ_TIMEOUT_MS = 90000;   // a setup page, or a whole-node fallback read
export const ASSET_TIMEOUT_MS = 2500;       // a Storage object (a photo, a label)

// ── A SLEEPING TABLET IS NOT A SLOW LINE ────────────────────────────────────
// When an Android tablet's screen goes off, Chrome freezes the page. Nothing
// runs; the socket may drop. On wake every overdue timer fires at once, so a
// read that had no chance to answer is reported as "did not answer within
// 90000 ms" — and the mirror then counts it towards benching the leg and
// re-downloads the page. On 21 Sep a PE tablet spent 164 MB that way, and
// devices that were otherwise healthy reported 8-second reads of a single row
// timing out.
//
// `sleepAware` (the mirror's reads) therefore counts only time the page was
// AWAKE: the clock stops while the document is hidden, and a timer that fires
// much later than it was due (the page was frozen) re-arms with WAKE_GRACE_MS
// for the socket to come back, rather than failing. Bounded twice over: at
// most MAX_WAKES re-arms of any kind, and HIDDEN_CEILING_MS of running while
// hidden — so a read can never wait for ever.
export const WAKE_GRACE_MS = 20000;
// While HIDDEN but still running (a desktop background tab — not frozen), the
// awake clock is stopped, so this separate ceiling is what keeps the read
// bounded: if it fires ON TIME the page was running all along and the read
// fails honestly. If it fires LATE the page was frozen, which is the case the
// wake grace exists for. (Sonnet review, PR #633.)
export const HIDDEN_CEILING_MS = 10 * 60 * 1000;
const LATE_BY_MS = 5000;
// Every re-arm — a late (frozen) timer AND a hidden→visible return — counts
// against this, so hide/show cycling cannot extend a read without end.
const MAX_WAKES = 5;

const docHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function sleepAwareTimeout(ms, label) {
  let timer = null;
  let ceiling = null;
  let remaining = ms;
  let armedAt = 0;
  let wakes = 0;
  let settle = null;
  const fail = () => { const s = settle; settle = null; s?.(new OfflineTimeoutError(label, ms)); };
  const armCeiling = () => {
    if (ceiling !== null || !settle) return;
    const due = Date.now() + HIDDEN_CEILING_MS;
    ceiling = setTimeout(() => {
      ceiling = null;
      if (Date.now() - due > LATE_BY_MS) {
        // Frozen, not running. It may now stay hidden but RUN, so the ceiling
        // is re-armed — as a wake, so this cannot repeat without end.
        if (wakes >= MAX_WAKES) { fail(); return; }
        wakes += 1;
        armCeiling();
        return;
      }
      fail();                                        // running in the background all along
    }, HIDDEN_CEILING_MS);
  };
  const clearCeiling = () => { if (ceiling !== null) { clearTimeout(ceiling); ceiling = null; } };
  const onVisibility = () => {
    if (!settle) return;
    if (docHidden()) {
      if (timer !== null) { clearTimeout(timer); timer = null; remaining -= Date.now() - armedAt; }
      armCeiling();
    } else if (timer === null) {
      clearCeiling();
      if (wakes >= MAX_WAKES) { fail(); return; }
      wakes += 1;
      remaining = Math.max(remaining, WAKE_GRACE_MS);
      arm();
    }
  };
  const arm = () => {
    armedAt = Date.now();
    const due = armedAt + remaining;
    timer = setTimeout(() => {
      timer = null;
      const late = Date.now() - due;
      if (late > LATE_BY_MS && wakes < MAX_WAKES) {
        // The page was frozen: this read never had its time. Give the socket
        // a moment to come back instead of calling it a failure.
        wakes += 1;
        remaining = WAKE_GRACE_MS;
        arm();
        return;
      }
      fail();
    }, Math.max(0, remaining));
  };
  const promise = new Promise((_resolve, reject) => {
    settle = reject;
    if (docHidden()) armCeiling(); else arm();
  });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  const clear = () => {
    settle = null;
    if (timer !== null) clearTimeout(timer);
    clearCeiling();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  };
  return { promise, clear };
}

// Reject with OfflineTimeoutError if `promise` has not settled in `ms`.
// The timer is always cleared, so a screen that searches on every keystroke does
// not accumulate live timers.
export function withTimeout(promise, { ms = READ_TIMEOUT_MS, label = "the read", sleepAware = false } = {}) {
  if (!(ms > 0)) return Promise.resolve(promise);
  if (sleepAware) {
    const t = sleepAwareTimeout(ms, label);
    return Promise.race([Promise.resolve(promise), t.promise]).finally(t.clear);
  }
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new OfflineTimeoutError(label, ms)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
