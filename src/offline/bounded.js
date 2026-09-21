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

// Reject with OfflineTimeoutError if `promise` has not settled in `ms`.
// The timer is always cleared, so a screen that searches on every keystroke does
// not accumulate live timers.
export function withTimeout(promise, { ms = READ_TIMEOUT_MS, label = "the read" } = {}) {
  if (!(ms > 0)) return Promise.resolve(promise);
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new OfflineTimeoutError(label, ms)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
