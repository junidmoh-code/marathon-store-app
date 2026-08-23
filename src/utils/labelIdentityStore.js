// ─── FETCHING THE IDENTITY MAP — once per session, patched as you work ───────
// The map costs one callable round trip over two whole nodes (~150KB). That is
// cheap once and ruinous per registration, so it is held in a module-level
// promise and shared by every surface that asks.
//
// ── "WITH NO RELOAD" IS THE WHOLE POINT ──────────────────────────────────────
// The owner's rule is that a product leaves Leftovers "immediately, in the same
// session, with no reload". Two mechanisms serve it, and the cheap one is the
// default:
//
//   noteRegistered(pid, {codes, tokens})   PATCHES the cached map in place with
//                                          the fact just written and notifies
//                                          every mounted hook SYNCHRONOUSLY. No
//                                          network, no blank list. This is what
//                                          a registration calls.
//   invalidateIdentity()                   drops the cache and refetches. Kept
//                                          for the cases where the client does
//                                          NOT know what changed — a merge
//                                          repoints every claim and alias the
//                                          loser owned.
//
// The first version called invalidateIdentity() on every registration. A
// 200-shoe pass was 200 round trips of 150KB each, and each one flipped `ready`
// to false for the duration — which made the Leftovers tab render its green
// "Nothing left over" tick mid-pass. Patching removes both problems.
//
// ── A REFETCH NEVER BLANKS THE LIST ──────────────────────────────────────────
// `ready` goes true on the FIRST successful load and stays true. A later
// refetch exposes `refreshing` instead, so a screen can say "checking…" while
// still showing the list it already has. An empty list and "we don't know yet"
// must never look the same on a warehouse phone.
//
// FAIL SOFT, ALWAYS. A failed or denied call resolves to an EMPTY map, never a
// rejection the caller has to handle. An empty map means "the two admin-only
// stores told us nothing", which degrades each screen to the style-code field
// alone — the behaviour before this change.

import { httpsCallable } from "firebase/functions";
import { useEffect, useState } from "react";
import { functions } from "../firebase";

const productIdentityFn = httpsCallable(functions, "productIdentity");

let inFlight = null;        // the request currently running, or null
let latest = {};            // the last resolved map, PLUS every patch since
let everLoaded = false;     // we have an answer (a load or a patch)
let needsFetch = true;      // an invalidate happened, or we never loaded
let refetchAfter = false;   // an invalidate landed while a request was in flight
let version = 0;            // bumped by every change; guards stale resolutions
const listeners = new Set();

function announce() {
  version += 1;
  for (const fn of [...listeners]) fn(version, latest, everLoaded);
}

/**
 * The map, as a promise.
 *
 * It resolves to `latest`, NOT to whatever the network happened to return —
 * that distinction is the whole point. A registration patches `latest` while a
 * request may still be in flight, and a caller awaiting this must see the patch,
 * not the older server answer.
 */
export function fetchIdentityMap() {
  if (!needsFetch && !inFlight) return Promise.resolve(latest);
  if (!inFlight) {
    // The version this fetch belongs to. If anything changes the map while the
    // request is in flight — an invalidate, or a patch from a registration —
    // this response is STALE and must not overwrite what replaced it. Without
    // the guard the two resolutions race and the older map can win.
    const startedAt = version;
    needsFetch = false;
    inFlight = productIdentityFn({})
      .then(({ data }) => {
        const map = (data && data.map && typeof data.map === "object") ? data.map : {};
        if (startedAt === version) latest = map;   // otherwise superseded — discard
        everLoaded = true;
      })
      .catch((err) => {
        console.warn("productIdentity: could not load the identity map:", err && err.message);
        needsFetch = true;      // a failure is not cached — the next screen retries
        everLoaded = true;      // "we asked and got nothing" is still an answer
      })
      .then(() => {
        inFlight = null;
        // An invalidate that landed WHILE this request was in flight discarded
        // its response above (the version moved) and set needsFetch again.
        // Nothing else would start the replacement — the hooks that bumped on
        // the invalidate found this request already running and joined it —
        // so the map would stay stale until the next mount. Chain ONE refetch
        // here; every waiter on this promise resolves to the fresh map.
        // Keyed on the invalidate, NOT on needsFetch: a FAILED call also sets
        // needsFetch, and chaining on that would retry a dead endpoint forever.
        if (refetchAfter) { refetchAfter = false; return fetchIdentityMap(); }
        return latest;
      });
  }
  return inFlight.then(() => latest);
}

/** The map RIGHT NOW, synchronously. `{}` until something has loaded. */
export function currentIdentityMap() {
  return latest;
}

/**
 * A registration just filed something against `productId`. Patch the cached map
 * and tell every mounted hook, synchronously — no network, no blank list.
 *
 * @param {string} productId
 * @param {object} opts  { codes?: string[], tokens?: string[] } — whatever was
 *                       written. Either alone is enough to make the product
 *                       REGISTERED, which is all the Leftovers rule needs.
 */
export function noteRegistered(productId, { codes = [], tokens = null } = {}) {
  if (!productId || typeof productId !== "string") return;
  // Own-property lookup: the map is parsed JSON with Object.prototype behind
  // it, so a pid like "constructor" would otherwise hand back a function and
  // `[...prev.c]` would throw. Same guard as utils/labelIdentity.entryFor.
  const own = Object.prototype.hasOwnProperty.call(latest, productId) ? latest[productId] : null;
  const prev = (own && typeof own === "object") ? { c: Array.isArray(own.c) ? own.c : [], a: Array.isArray(own.a) ? own.a : [] } : { c: [], a: [] };
  const c = [...prev.c];
  for (const raw of codes) {
    const code = String(raw ?? "").trim();
    if (code && !c.includes(code)) c.push(code);
  }
  const a = [...prev.a];
  if (Array.isArray(tokens) && tokens.length) {
    const clean = [...new Set(tokens.map((t) => String(t ?? "").trim()).filter(Boolean))].sort();
    const sig = clean.join(" ");
    if (clean.length && !a.some((x) => x.join(" ") === sig)) a.push(clean);
  }
  // A registration with NEITHER a code nor tokens still registers the product
  // as far as this map is concerned only if it actually filed something; an
  // empty patch must not manufacture an identity.
  if (c.length === prev.c.length && a.length === prev.a.length) return;
  latest = { ...latest, [productId]: { c, a } };
  everLoaded = true;
  announce();
}

/**
 * Drop the cache and refetch. For the changes the client cannot describe — a
 * merge repoints every claim and every alias the loser owned. The current map
 * stays visible while the refetch runs.
 */
export function invalidateIdentity() {
  needsFetch = true;
  if (inFlight) refetchAfter = true;   // the running request is stale on arrival
  announce();
}

/**
 * The map.
 *   map        what we know right now (patches included)
 *   ready      we have an answer — true after the first load OR any patch, and
 *              it never goes back to false. A screen may render its list.
 *   refreshing a fetch is in flight. Say "checking…" beside the list; never
 *              empty it.
 */
export function useLabelIdentity() {
  const [state, setState] = useState({ map: latest, ready: everLoaded, refreshing: !everLoaded });

  useEffect(() => {
    let alive = true;
    const load = () => {
      // Return the SAME object when nothing changes so React bails out. A
      // fresh object every time is a guaranteed extra render pass of whatever
      // screen this hook sits in, on every mount — measurable on the merge
      // picker, which re-renders the label reader beneath it.
      if (alive) setState((s) => (s.refreshing ? s : { ...s, refreshing: true }));
      fetchIdentityMap().then((map) => {
        if (alive) {
          setState((s) => (s.map === map && s.ready && !s.refreshing
            ? s
            : { map, ready: true, refreshing: false }));
        }
      });
    };
    load();
    const onBump = (_v, map, loaded) => {
      if (!alive) return;
      // A patch needs no network: show it at once. Only an INVALIDATE (which
      // sets needsFetch) costs a round trip.
      setState((s) => (s.map === map && s.ready === (loaded || s.ready)
        ? s
        : { ...s, map, ready: loaded || s.ready }));
      if (needsFetch) load();
    };
    listeners.add(onBump);
    return () => { alive = false; listeners.delete(onBump); };
  }, []);

  return state;
}

/** Test seam — drops the module cache and every listener. */
export function __resetIdentityCacheForTests() {
  inFlight = null;
  latest = {};
  everLoaded = false;
  needsFetch = true;
  refetchAfter = false;
  version = 0;
  listeners.clear();
}
