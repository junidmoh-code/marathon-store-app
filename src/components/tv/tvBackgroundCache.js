// ─── TV BACKGROUNDS — the board's photo cache (Cache Storage, no worker) ──────
//
// The board downloads today's photos ONCE into Cache Storage and rotates from
// there: a rotation, a new day or a new upload never re-downloads a photo the
// TV already has. Same approach as the offline mirror's photo cache
// (src/offline/photoCache.js): the page fills and reads the cache by hand — no
// service worker, no fetch interception (the app's SW was rolled back for good
// on 2026-05-09). main.jsx's boot-time cache clear spares this cache by name
// (src/offline/cacheClear.js), or every boot would throw it away.
//
// Memory: a TV has little to spare, so only the last few photos shown are held
// as decoded blob: URLs; the rest stay on disk in the cache.
//
// Fails open: no Cache Storage, a CORS refusal or a network error resolves to
// the photo's plain URL, which the browser fetches and HTTP-caches itself (the
// files carry a year-long immutable Cache-Control).

export const TV_BG_CACHE_NAME = "marathon-tv-backgrounds-v1";
const HELD_OBJECT_URLS = 3; // on screen, fading out, and the next one
export const FETCH_TIMEOUT_MS = 30_000;   // a hung download must not pin the rotation
export const RETRY_AFTER_MS = 5 * 60_000; // a failed photo is not retried on every tick

export function createTvBackgroundCache({
  cacheStorage = typeof caches === "undefined" ? null : caches,
  fetchFn = typeof fetch === "undefined" ? null : (u, o) => fetch(u, o),
  urlApi = typeof URL === "undefined" ? null : URL,
  log = console,
  nowMs = () => Date.now(),
} = {}) {
  let cachePromise = null;
  const inFlight = new Map();   // url → Promise<boolean>
  const held = new Map();       // url → blob: URL, oldest first
  const failedAt = new Map();   // url → when it last failed (short negative cache)

  const open = () => {
    if (!cacheStorage?.open) return Promise.resolve(null);
    if (!cachePromise) cachePromise = Promise.resolve(cacheStorage.open(TV_BG_CACHE_NAME)).catch(() => null);
    return cachePromise;
  };

  // Make sure url is in the cache, downloading it first if needed. false = could not cache.
  function ensure(url) {
    if (inFlight.has(url)) return inFlight.get(url);
    const p = (async () => {
      const cache = await open();
      if (!cache || !fetchFn) return false;
      if (await cache.match(url)) return true;
      if (nowMs() - (failedAt.get(url) ?? -Infinity) < RETRY_AFTER_MS) return false;
      const ctl = typeof AbortController === "undefined" ? null : new AbortController();
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { ctl?.abort(); reject(new Error("timed out")); }, FETCH_TIMEOUT_MS);
      });
      try {
        const res = await Promise.race([fetchFn(url, { mode: "cors", signal: ctl?.signal }), timeout]);
        if (!res || !res.ok) throw new Error(`HTTP ${res?.status}`);
        await cache.put(url, res);
        failedAt.delete(url);
        return true;
      } finally {
        clearTimeout(timer);
      }
    })().catch((err) => {
      failedAt.set(url, nowMs());
      log.warn?.("TV backgrounds: could not cache a photo, using its URL:", err?.message || err);
      return false;
    }).finally(() => inFlight.delete(url));
    inFlight.set(url, p);
    return p;
  }

  /** Download every url not cached yet, one at a time (a slow store link). */
  async function prefetch(urls) {
    for (const u of urls || []) await ensure(u);
  }

  /** The src to draw for url: a blob: URL from the cache, else url itself. */
  async function resolve(url) {
    if (!url) return url;
    if (held.has(url)) {
      const ou = held.get(url);
      held.delete(url); held.set(url, ou); // most recent last
      return ou;
    }
    if (!(await ensure(url)) || !urlApi?.createObjectURL) return url;
    try {
      const res = await (await open()).match(url);
      if (!res) return url;
      const blob = await res.blob();
      if (held.has(url)) return held.get(url); // a concurrent resolve got there first
      const ou = urlApi.createObjectURL(blob);
      held.set(url, ou);
      while (held.size > HELD_OBJECT_URLS) {
        const [oldUrl, oldOu] = held.entries().next().value;
        held.delete(oldUrl);
        try { urlApi.revokeObjectURL(oldOu); } catch { /* ignore */ }
      }
      return ou;
    } catch {
      return url;
    }
  }

  /** Drop cached photos that are no longer in the Workshop at all. */
  async function prune(keepUrls) {
    const cache = await open();
    if (!cache?.keys) return [];
    const keep = new Set(keepUrls || []);
    const gone = [];
    for (const req of await cache.keys()) {
      const u = typeof req === "string" ? req : req.url;
      if (!keep.has(u)) { gone.push(u); await cache.delete(req); }
    }
    return gone;
  }

  return { prefetch, resolve, prune, ensure };
}

let shared = null;
/** One cache per page (lazy). */
export function tvBackgroundCache() {
  if (!shared) shared = createTvBackgroundCache();
  return shared;
}
