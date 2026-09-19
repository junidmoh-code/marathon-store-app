// ─── OFFLINE MIRROR — starting it ────────────────────────────────────────────
//
// Dynamically imported from main.jsx so that with the flag off this module —
// and the IndexedDB and firebase code behind it — is never fetched or parsed.
// With the flag off the app's behaviour is byte-for-byte what it was.
//
// ── WHAT STARTING MEANS ─────────────────────────────────────────────────────
//
//   1. open IndexedDB and check the record-shape version. A mismatch purges
//      the data stores and every cursor, which turns the next step into a
//      first run.
//   2. ask for persistent storage. A browser that may evict the origin's
//      storage under pressure could drop 104 MB of download; asking costs
//      nothing and is usually granted for an installed PWA.
//   3. run the SETUP DOWNLOAD if this device has not finished one. This is the
//      blocking part, and SetupScreen renders its progress.
//   4. then loop: a pass every PASS_INTERVAL_MS, plus a pass the moment the
//      connection returns.
//
// ── THE PASS LOOP IS SCHEDULED IN `finally` ─────────────────────────────────
//
// …which is exactly why every read in this mirror is bounded (bounded.js). A
// pass that hangs would stop the loop for ever, and the whole mirror with it,
// because the next pass is only scheduled once this one settles. That is not a
// theory: it is the third of the three hangs the POS mirror found in its first
// real offline test.
//
// ── AUTH ────────────────────────────────────────────────────────────────────
//
// Every mirrored node is rules-gated on a signed-in, non-anonymous user. A
// listener or read registered before sign-in is REJECTED and does not retry,
// so nothing starts until auth says there is a user, and everything stops when
// it says there is not.

import { openMirrorDb } from "./db";
import { createRtdbAdapter } from "./rtdbAdapter";
import { createConnectionTracker } from "./connection";
import { createSyncEngine } from "./sync";
import { offlineMirrorEnabled } from "./mirrorFlag";
import { bumpLegs } from "./mirrorSignal";
import { MIRROR_LEGS } from "./nodes";
import { confirmPending } from "./pendingWrites";
import { primePhotoCachePass, isPhotoCacheApiAvailable, openPhotoCache } from "./photoCache";
import { readWholeLeg, MISS } from "./localReads";
import { setServingLegs } from "./serving";
import { isLegUsable } from "./health";
import { setForcedUpdateMode, setUpdateBusy } from "../update/updateChecker";
import { pendingCount } from "./pendingWrites";

export const PASS_INTERVAL_MS = 60 * 1000;
// After a failed pass, back off rather than hammering a line that is down.
export const PASS_BACKOFF_MS = 5 * 60 * 1000;
// The photo leg runs LAST and only once the data legs are complete: a picture
// must never be downloading while a number is missing.
export const PHOTO_PASS_EVERY = 2;

export async function startOfflineMirror({
  auth,
  storage,
  buildVersion = typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : null,
  onProgress = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
} = {}) {
  if (!offlineMirrorEnabled()) return null;

  const db = await openMirrorDb();
  await db.ensureSchema({ buildVersion });

  // Best effort, and deliberately not awaited for its answer: a device that
  // says no still mirrors, it is merely more likely to lose the copy.
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      navigator.storage.persist().then(
        (granted) => db.setMeta("storagePersisted", { granted, at: now() }).catch(() => {}),
        () => {},
      );
    }
  } catch { /* not available */ }

  const adapter = createRtdbAdapter();
  const connection = createConnectionTracker({ subscribeConnected: adapter.subscribeConnected, now });
  connection.start();

  // The setup screen listens here. The engine takes ONE onProgress at
  // construction, so the runtime fans it out rather than the screen reaching
  // into the engine.
  const progressListeners = new Set();
  const fanOut = (p) => {
    onProgress(p);
    for (const l of progressListeners) { try { l(p); } catch { /* a listener never breaks a pass */ } };
  };

  const engine = createSyncEngine({ db, adapter, now, buildVersion, onProgress: fanOut });

  // WHICH LEGS THIS DEVICE IS ACTUALLY SERVING FROM, refreshed after setup and
  // after every pass and written to the synchronous hint every hook reads on
  // its first render (serving.js). A leg that goes unusable — a refused swap, a
  // census drift — drops out here, and the hooks reading it open their live
  // subscriptions again on the next render.
  async function refreshServing() {
    const serving = [];
    for (const leg of MIRROR_LEGS) {
      try { if (await isLegUsable(db, leg.name)) serving.push(leg.name); }
      catch { /* an unreadable leg is not a serving one */ }
    }
    setServingLegs(serving);
    // A device serving locally has no whole-node subscriptions to make a stale
    // bundle obvious, so its reload becomes forced rather than advisory.
    setForcedUpdateMode(serving.length > 0);
    return serving;
  }

  let timer = null;
  let stopped = false;
  let passes = 0;
  const state = { setup: null, lastPass: null, lastError: null, photos: null };

  async function runOnePass() {
    const report = await engine.runPass();
    state.lastPass = { at: now(), ...report };
    state.lastError = report.errors.length ? report.errors[0] : null;

    // Wake the screens whose nodes moved — and only those.
    if ((report.feed?.applied ?? 0) + (report.feed?.deleted ?? 0) > 0) {
      bumpLegs(MIRROR_LEGS.filter((l) => l.feed === "changes").map((l) => l.name));
    }
    for (const r of report.range) if (r.added > 0) bumpLegs([r.leg]);

    // The echo of this device's own writes is only worth keeping until the
    // feed brings the same fact back round. Dropping it the moment it does,
    // rather than letting it expire on a timer, is what stops it hiding
    // someone else's later change.
    if (report.feed?.paths?.length) confirmPending(report.feed.paths);

    // Unsent writes are a reason not to reload, and the update checker's busy
    // registry is where that already lives.
    setUpdateBusy("offline-mirror-pending-writes", pendingCount() > 0);

    await refreshServing();
    passes += 1;
    if (passes % PHOTO_PASS_EVERY === 0) await runPhotoPass();
    return report;
  }

  async function runPhotoPass() {
    if (!isPhotoCacheApiAvailable() || !storage) return;
    try {
      const products = await readWholeLeg(db, "products");
      if (products === MISS || !products) return;
      const list = Object.values(products).filter((p) => p && p.id);
      state.photos = await primePhotoCachePass({
        db, storage, cache: await openPhotoCache(), products: list, now,
        setTimeoutFn,
      });
    } catch (err) {
      // A photo problem must NEVER disable the data legs. It is recorded and
      // the pass goes on.
      state.photos = { error: err.message };
    }
  }

  function schedule(ms) {
    if (stopped) return;
    clearTimeoutFn(timer);
    timer = setTimeoutFn(tick, ms);
  }

  async function tick() {
    if (stopped) return;
    let ms = PASS_INTERVAL_MS;
    try {
      const report = await runOnePass();
      if (report.errors.length) ms = PASS_BACKOFF_MS;
    } catch (err) {
      state.lastError = { where: "pass", reason: err.name, message: err.message };
      ms = PASS_BACKOFF_MS;
    } finally {
      // See the header: the ONLY place the next pass is scheduled.
      schedule(ms);
    }
  }

  // A reconnection is the one event worth interrupting the cadence for: a
  // device that has been off the line has a backlog and a person in front of
  // it.
  const unwatchConnection = connection.subscribe(() => {
    if (connection.isConnected() && !stopped) schedule(0);
  });

  const runtime = {
    db, adapter, engine, connection, state,
    // Awaited by the setup screen. Resolves when this device has a complete
    // copy; rejects only if a leg that cannot be empty came back empty, which
    // is a fault to show rather than to retry silently.
    async setup(opts) {
      state.setup = await engine.runSetup(opts);
      await refreshServing();
      bumpLegs(MIRROR_LEGS.map((l) => l.name));
      return state.setup;
    },
    onSetupProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    refreshServing,
    setupState: () => engine.setupState(),
    runOnePass,
    start() { schedule(0); },
    stop() {
      stopped = true;
      clearTimeoutFn(timer);
      unwatchConnection();
      connection.stop();
      // Nothing may go on claiming this device serves locally once the mirror
      // has stopped: every hook reads that hint synchronously and would skip
      // the live subscription it now needs.
      setServingLegs([]);
      setForcedUpdateMode(false);
    },
  };

  // Nothing runs until there is a signed-in, non-anonymous user, and
  // everything stops when there is not — every mirrored node's read rule says
  // so, and a read registered before sign-in is rejected without retrying.
  if (auth) {
    const { onAuthStateChanged } = await import("firebase/auth");
    onAuthStateChanged(auth, (user) => {
      const usable = !!user && user.isAnonymous !== true;
      if (usable) { stopped = false; schedule(0); }
      else { clearTimeoutFn(timer); stopped = true; }
    });
  }

  return runtime;
}
