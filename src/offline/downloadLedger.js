// ─── OFFLINE MIRROR — HOW MANY TIMES MAY A LEG BE DOWNLOADED WHOLE? ──────────
//
// THE INCIDENT THIS CLOSES (cost watch, 28 Oct – 10 Nov 2026). "A node is read
// whole exactly once per device" was a promise with nothing behind it. Every
// bound the engine had was a bound on FAILURES — a leg that failed three times
// in a session was benched — and it lived in memory, so it reset on every
// reload. A leg that downloaded SUCCESSFULLY and was then told to download
// again was not a failure at all: nothing counted it, and nothing stopped it.
// On 10 Nov that was ~50 devices re-reading three settings legs every 20–240
// seconds for hours (724 full walks in three hours, ~3.5 GB); on 30 Oct it was
// /products and /stock, and one phone read 2.0 GB.
//
// So this is the bound, and it counts the one thing that costs money: A WALK
// OF A LEG STARTED FROM ITS FIRST PAGE. Whatever the reason — a census
// disagreement, an expired cursor, a failed validation, a browser that threw
// the copy away — a leg may start from page one LEG_DOWNLOADS_PER_DAY times in
// any 24 hours on one device, and then it may not. A leg that is refused is
// simply not mirrored until the window moves on: the screens read it live,
// exactly as they did before there was a mirror, and the device says so on
// the fleet screen ("download-budget").
//
// ── WHY localStorage AND NOT THE MIRROR'S OWN IndexedDB ─────────────────────
//
// The worst repeat downloader in the fleet is a handset whose browser deletes
// the mirror's IndexedDB (17 wipes — storageHealth.js). A ledger kept in the
// database being deleted would be deleted with it, and that device is exactly
// the one the bound is for. localStorage survives those wipes on the devices
// we have watched (it is how the wipe count itself survives), and it is
// shared by every tab of the app on the device, which is the right scope: the
// bytes are per device, not per tab.
//
// A device with no usable localStorage (private mode) falls back to memory.
// That is a per-session bound again, and it is the best that device can do.
//
// ── WHAT DOES NOT COUNT ─────────────────────────────────────────────────────
//
// A walk RESUMED from staging, or a range walk resumed from its cursor, is the
// same download carrying on, not a new one. A key-diff repair (sync.js
// reconcileLegKeys) reads keys and a handful of rows, never the leg.

export const LEG_DOWNLOADS_PER_DAY = 3;
export const DOWNLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DOWNLOAD_LEDGER_KEY = "marathon-store.offlineMirror.downloadLedger";

export class MirrorDownloadBudgetError extends Error {
  constructor(leg, { max, windowMs, nextAt }) {
    super(
      `offline mirror: "${leg}" has already been downloaded whole ${max} times in the last `
      + `${Math.round(windowMs / 3600000)} hours on this device. It is not downloaded again until `
      + `${new Date(nextAt).toISOString()}; its screens read live until then.`,
    );
    this.name = "MirrorDownloadBudgetError";
    this.leg = leg;
    this.nextAt = nextAt;
  }
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

function defaultStorage() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch { /* access itself can throw in a sandboxed frame */ }
  return null;
}

export function createDownloadLedger({
  storage = defaultStorage(),
  now = Date.now,
  max = LEG_DOWNLOADS_PER_DAY,
  windowMs = DOWNLOAD_WINDOW_MS,
  key = DOWNLOAD_LEDGER_KEY,
} = {}) {
  // `storage` is the ledger for as long as it works. The moment a read or a
  // write of it fails, this tab carries on from the last ledger it saw, in
  // memory — so a slot that could not be written down still counts here.
  const fallback = memoryStorage();
  let storageBroken = !storage;

  const parse = (raw) => {
    try {
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  };

  function readRaw() {
    if (!storageBroken) {
      try {
        const raw = storage.getItem(key);
        fallback.setItem(key, raw ?? "");
        return parse(raw);
      } catch { storageBroken = true; }
    }
    return parse(fallback.getItem(key));
  }

  // A start stamped in the FUTURE (the device clock was wrong and has been put
  // right) is rewritten as "now" the first time it is seen, and written back —
  // so it ages out a day later like any other, rather than being re-read as
  // "now" on every read and holding its slot for ever.
  function read() {
    const ledger = readRaw();
    const at = now();
    let clamped = false;
    for (const leg of Object.keys(ledger)) {
      if (!Array.isArray(ledger[leg])) continue;
      ledger[leg] = ledger[leg].map((t) => {
        if (Number.isFinite(t) && t > at) { clamped = true; return at; }
        return t;
      });
    }
    if (clamped) write(ledger);
    return ledger;
  }

  function write(ledger) {
    const raw = JSON.stringify(ledger);
    fallback.setItem(key, raw);
    if (storageBroken) return;
    try { storage.setItem(key, raw); } catch { storageBroken = true; }
  }

  // The starts still inside the window, oldest first. A timestamp from the
  // future (a device clock that was wrong and has been put right) would hold
  // its slot for ever, so it is treated as "now".
  function recent(ledger, leg) {
    const at = now();
    const times = Array.isArray(ledger[leg]) ? ledger[leg] : [];
    return times
      .filter((t) => Number.isFinite(t))
      .map((t) => Math.min(t, at))
      .filter((t) => at - t < windowMs)
      .sort((a, b) => a - b);
  }

  return {
    max,
    windowMs,
    /** How many more whole downloads of `leg` this device may start right now. */
    remaining(leg) {
      return Math.max(0, max - recent(read(), leg).length);
    },
    /** When the next slot frees up — `now` if one is free already. */
    nextAt(leg) {
      const times = recent(read(), leg);
      if (times.length < max) return now();
      return times[times.length - max] + windowMs;
    },
    /**
     * Take one slot for `leg`. False — and nothing recorded — when there is
     * none: the caller must not start the walk.
     */
    consume(leg) {
      const ledger = read();
      const times = recent(ledger, leg);
      if (times.length >= max) return false;
      const next = {};
      // Pruned on every write, so the ledger never grows past max × legs.
      for (const name of Object.keys(ledger)) {
        const kept = recent(ledger, name);
        if (kept.length) next[name] = kept;
      }
      next[leg] = [...times, now()];
      write(next);
      return true;
    },
    /** Every leg's starts inside the window — for the device report and tests. */
    snapshot() {
      const ledger = read();
      const out = {};
      for (const name of Object.keys(ledger)) {
        const kept = recent(ledger, name);
        if (kept.length) out[name] = kept;
      }
      return out;
    },
  };
}
