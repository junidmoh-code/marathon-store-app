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
import { offlineMirrorEnabled } from "./killSwitch";
import { bumpLegs } from "./mirrorSignal";
import { MIRROR_LEGS } from "./nodes";
import { confirmPending } from "./pendingWrites";
import { FEED_CURSOR_META, CHANGES_ROOT } from "./changeFeed";
import { primePhotoCachePass, isPhotoCacheApiAvailable, openPhotoCache, heldPhotoCount } from "./photoCache";
import { readWholeLeg, MISS } from "./localReads";
import { setServingLegs, notifyServingChanged, isLegServing } from "./serving";
import { legVerdict, getLegHealth, vouchingRecord } from "./health";
import { decideServing, feedIsStale } from "./servingDecision";
import { setForcedUpdateMode, setUpdateBusy } from "../update/updateChecker";
import {
  addBytes, bytesToday, deviceRecord, reportDeviceHealth, thisDevice,
} from "./deviceHealth";
import { pendingCount } from "./pendingWrites";
import { noteMirrorOpened, requestPersistence, storageSnapshot } from "./storageHealth";

// The FLOOR, not the latency. A live signal on the change log (see below)
// runs a pass as soon as anything is written; this is the backstop for a
// signal that never arrives — a dropped socket, a tab the browser throttled.
export const PASS_INTERVAL_MS = 60 * 1000;
// A burst of writes is one pass, not one per record. Long enough to coalesce
// a refill run, short enough that nobody notices.
export const SIGNAL_DEBOUNCE_MS = 400;
// After a failed pass, back off rather than hammering a line that is down.
export const PASS_BACKOFF_MS = 5 * 60 * 1000;
// The photo leg runs LAST and only once the data legs are complete: a picture
// must never be downloading while a number is missing.
export const PHOTO_PASS_EVERY = 2;
// A setup download that fails is retried, quietly, for as long as the app is
// open. Nobody is waiting on it — the app is working on live reads — so the
// retry is slow enough to be free and frequent enough to finish a download
// over a shaky afternoon.
export const SETUP_RETRY_MS = 5 * 60 * 1000;
// …doubling after each failure up to this, so a download that keeps failing
// costs less every time it is tried rather than the same again. With the
// engine's own per-leg cap (sync.js LEG_MAX_ATTEMPTS) this is what ended the
// #624 loop: a leg that fails three times in a session is benched, and once
// every leg still missing is benched the download stops and says so.
export const SETUP_RETRY_MAX_MS = 60 * 60 * 1000;

// "This device's staff have asked for the local copy." Written when the
// Download button is tapped and read on every open afterwards, so the question
// is asked ONCE per device and the download resumes by itself from then on.
//
// It lives under the `setup.` prefix deliberately: health.js purges that
// prefix whenever the snapshot is purged, so a device whose copy is thrown
// away by a schema change asks again rather than silently re-downloading
// 104 MB in the background.
export const CONSENT_META = "setup.consented";

// The account whose read rights the serving hint was last checked against.
// localStorage, not IndexedDB, because the auth listener must decide
// SYNCHRONOUSLY whether the hint still applies — a hook reads it on its very
// first render. A different account on the tablet clears the hint at once and
// it comes back only after checkAccess() has asked the database.
export const ACCESS_UID_KEY = "marathon-store.offlineMirror.accessUid";
const readAccessUid = () => {
  try { return typeof localStorage !== "undefined" ? localStorage.getItem(ACCESS_UID_KEY) : null; }
  catch { return null; }
};
const writeAccessUid = (uid) => {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(ACCESS_UID_KEY, uid ?? ""); }
  catch { /* per-tab only */ }
};

export async function startOfflineMirror({
  auth,
  storage,
  buildVersion = typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : null,
  onProgress = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
  // ── INJECTED, SO THIS FUNCTION ITSELF CAN BE TESTED ───────────────────────
  //
  // Everything below used to be reachable only through a real IndexedDB and a
  // real firebase connection, so every test stopped at the engine or at a fake
  // runtime — and a spec review found that the most expensive behaviour on the
  // branch lived in exactly the gap between them: a pass loop that started
  // itself before anybody had agreed to a download. A fake adapter and a test
  // database are the difference between "we believe it does not" and a
  // counted zero. (Fable-vs-spec review, PR #624.)
  openDb = openMirrorDb,
  makeAdapter = createRtdbAdapter,
} = {}) {
  if (!offlineMirrorEnabled()) return null;

  const db = await openDb();
  // Asked BEFORE ensureSchema stamps it: a database that opens without its
  // schema stamp, on a device that has held one before, was deleted by the
  // browser (storageHealth.js). A read that fails counts as "had one", so a
  // flaky IndexedDB is never reported as an eviction.
  const hadSchema = await Promise.resolve()
    .then(() => db.getMeta("schemaVersion"))
    .then((v) => v !== undefined && v !== null, () => true);
  await db.ensureSchema({ buildVersion });
  noteMirrorOpened({ hadSchema, now });

  // Best effort, and deliberately not awaited for its answer: a device that
  // says no still mirrors, it is merely more likely to lose the copy. The
  // answer is reported to the fleet screen (storageHealth.js).
  requestPersistence().then(
    (granted) => { if (granted !== null) db.setMeta("storagePersisted", { granted, at: now() }).catch(() => {}); },
    () => {},
  );

  // Every read this device does is weighed as it happens — see
  // rtdbAdapter.measureBytes — and the running total is what the fleet screen
  // reports. A failure to record bytes must never fail a read, so addBytes is
  // fire-and-forget.
  const adapter = makeAdapter({
    onBytes: (n) => { addBytes(db, n, { now }).catch(() => {}); },
  });
  const connection = createConnectionTracker({ subscribeConnected: adapter.subscribeConnected, now });
  connection.start();

  const state = {
    setup: null, lastPass: null, lastError: null, photos: null,
    // The download, as it happens: which leg, which legs have landed, and the
    // last failure if there was one.
    setupProgress: null, setupDone: [], setupError: null, downloading: false,
    setupCensus: null,
    feedOkAt: null,
  };

  // The setup screen listens here. The engine takes ONE onProgress at
  // construction, so the runtime fans it out rather than the screen reaching
  // into the engine.
  const progressListeners = new Set();
  const fanOut = (p) => {
    // Kept so the dot can show the download to somebody who is working
    // through it. `rows` is only present on a leg that has FINISHED.
    if (p.phase === "setup") {
      state.setupProgress = { leg: p.leg, done: p.done, total: p.total, at: now() };
      if (p.rows !== undefined && !state.setupDone.includes(p.leg)) state.setupDone.push(p.leg);
    }
    onProgress(p);
    for (const l of progressListeners) { try { l(p); } catch { /* a listener never breaks a pass */ } };
  };

  // `mayRepair` is the consent gate reaching into the pass loop. The loop's
  // step 4 re-downloads any leg that has lost its setup marker — which on a
  // device that has never set up is EVERY leg — so without this the pass loop
  // is a second, unasked download path that also stamps the device complete.
  const engine = createSyncEngine({
    db, adapter, now, buildVersion, onProgress: fanOut,
    mayRepair: () => consented,
  });

  // WHICH LEGS THIS DEVICE IS ACTUALLY SERVING FROM, refreshed after setup and
  // after every pass and written to the synchronous hint every hook reads on
  // its first render (serving.js). A leg that goes unusable — a refused swap, a
  // census drift — drops out here, and the hooks reading it open their live
  // subscriptions again on the next render.
  // When the change feed last read cleanly, and since when each leg's check
  // could not be asked. In memory: a reload is a fresh start (servingDecision).
  // `let`: a resume from idle suspend is a fresh start too — the time spent
  // suspended is not time the feed failed (Fable-vs-spec review, PR #639).
  let startedAt = now();
  const unknownVerdictSince = new Map();
  let readableUnserved = MIRROR_LEGS.map((l) => l.name);   // until the first refresh says otherwise
  async function refreshServing() {
    // THE ACCESS GATE: nothing is served to a signed-in account whose read
    // rights have not been checked on this device (ensureAccess). Every pass
    // comes through here, so this is the one place it can be enforced.
    const uid = currentUser?.uid ?? auth?.currentUser?.uid ?? null;
    if (uid && readAccessUid() !== uid) {
      lastServing = [];
      setServingLegs([]);
      setForcedUpdateMode(false);
      return [];
    }
    // See servingDecision.js: complete-and-vouched AND a current feed, with
    // "could not ask" kept apart from "no".
    const verdicts = {};
    for (const leg of MIRROR_LEGS) {
      try { verdicts[leg.name] = await legVerdict(db, leg.name); }
      catch { verdicts[leg.name] = "unknown"; }
    }
    const serving = decideServing({
      verdicts,
      wasServing: (name) => isLegServing(name),
      unknownSince: unknownVerdictSince,
      feedStale: feedIsStale({
        connected: connection.isConnected(), feedOkAt: state.feedOkAt, startedAt, now: now(),
      }),
      now: now(),
    });
    lastServing = serving;
    // Legs this account COULD read that are not served locally — each one is
    // a live subscription some screen may be holding. A leg the account may
    // not read at all (not-permitted) has no live source either, so it does
    // not count against the device. idleSuspend asks this: a device parks its
    // connection only when nothing it could read is being read live.
    // (Fable-vs-spec review, PR #639: "mirrored" used to mean ANY leg served.)
    const unserved = [];
    for (const leg of MIRROR_LEGS) {
      if (serving.includes(leg.name)) continue;
      let reason = null;
      try { reason = (await getLegHealth(db, leg.name))?.reason ?? null; } catch { /* unknown: counts */ }
      if (reason !== "not-permitted") unserved.push(leg.name);
    }
    readableUnserved = unserved;
    setServingLegs(serving);
    // A device serving locally has no whole-node subscriptions to make a stale
    // bundle obvious, so its reload becomes forced rather than advisory.
    setForcedUpdateMode(serving.length > 0);
    return serving;
  }

  let timer = null;
  let stopped = false;
  let suspended = false;
  let passes = 0;
  // ── THE TWO FACTS THAT DECIDE WHETHER ANYTHING READS RTDB ─────────────────
  //
  // `consented` — has somebody on this device tapped Download? Read once at
  // start and set by the tap. NOTHING in this engine may read the database
  // before it is true. The consent gate is not a screen with a button on it;
  // it is this variable, and the screen is how it gets set.
  //
  // `wanted` — has anything actually asked for the steady-state pass loop?
  // The auth listener used to schedule a pass by itself, which turned sign-in
  // into a download on a device nobody had asked: the pass loop repairs any
  // leg without a setup marker, one per pass, which on a fresh device is ALL
  // of them — a complete second download path, unconsented, and finishing
  // without the forced census that makes a first copy safe to serve.
  // (Fable-vs-spec review, PR #624.)
  let consented = !!(await db.getMeta(CONSENT_META));
  let wanted = false;

  async function runOnePass() {
    const report = await engine.runPass();
    state.lastPass = { at: now(), ...report };
    // The feed is CURRENT only if this pass actually read it. Skipped (backing
    // off, benched) or failed is not current, however recent the pass.
    if (report.feed && !report.feed.skipped && !report.errors.some((e) => e.where === "feed")) {
      state.feedOkAt = now();
    }
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
    await reportHealth();
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
    if (stopped || suspended) return;
    clearTimeoutFn(timer);
    timer = setTimeoutFn(tick, ms);
  }

  // ONE pass at a time. A pass still resolving when the device suspended (its
  // network call parked by goOffline) must not run alongside the pass a
  // resume starts: the late one finishes, and its own `finally` schedules the
  // next. (Sonnet architect review, PR #639.)
  // A tick that arrives meanwhile (a resume's catch-up) is not dropped: it
  // runs as soon as the pass in flight has finished.
  let passRunning = false;
  let passAgain = false;
  async function tick() {
    if (stopped) return;
    if (passRunning) { passAgain = true; return; }
    passRunning = true;
    try { await tickOnce(); } finally {
      passRunning = false;
      if (passAgain) { passAgain = false; schedule(0); }
    }
  }
  async function tickOnce() {
    // ── THE KILL SWITCH, CHECKED BY THE ENGINE ITSELF ───────────────────────
    // MirrorGate stops the runtime when the switch goes false, and that is the
    // path that runs. This is the second lock on the same door: a runtime
    // started by anything else — a future caller, a test, a gate someone
    // deletes — still cannot do a single pass against a switch that is off.
    // It costs one synchronous localStorage read a minute.
    if (!offlineMirrorEnabled() || !consented) { runtime.stop(); return; }
    let ms = PASS_INTERVAL_MS;
    try {
      await ensureAccess();
      const report = await runOnePass();
      if (report.errors.length) ms = PASS_BACKOFF_MS;
    } catch (err) {
      state.lastError = { where: "pass", reason: err.name, message: err.message };
      ms = PASS_BACKOFF_MS;
      // A pass that could not finish still has to re-decide what is served:
      // a feed that has been failing on a live line for FEED_STALE_MS must
      // leave the hint even if no pass ever gets as far as refreshServing.
      await refreshServing().catch(() => {});
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

  // ── THE LIVE SIGNAL ───────────────────────────────────────────────────────
  //
  // Without this the mirror is exactly as stale as PASS_INTERVAL_MS, and a
  // minute between one device's write and another's screen is not "what it
  // displays today". The subscription streams change RECORDS (~60 bytes),
  // never a node, and it only ever asks for a pass — the page is read and
  // committed by the one tested path.
  let signalUnsub = null;
  let signalTimer = null;
  async function watchChanges() {
    if (signalUnsub || stopped || suspended) return;
    const after = (await db.getMeta(FEED_CURSOR_META)) ?? null;
    if (stopped || suspended || signalUnsub) return;
    signalUnsub = adapter.subscribeNewChanges(CHANGES_ROOT, after, () => {
      if (stopped) return;
      // Debounced: a refill run writes hundreds of records and they should
      // cost one pass, not hundreds.
      clearTimeoutFn(signalTimer);
      signalTimer = setTimeoutFn(() => schedule(0), SIGNAL_DEBOUNCE_MS);
    });
  }

  // ── THE DOWNLOAD RUNS BEHIND THE STAFF, NOT IN FRONT OF THEM ──────────────
  //
  // The first version of this held the app behind a progress bar until 104 MB
  // had landed. That is the wrong trade on a shop floor: the app works
  // perfectly well on live reads — it is what it did for two years — and a
  // person who cannot serve a customer because a bar is at 38% is a person
  // whose till is a phone in someone else's hand.
  //
  // So: one tap on Download, the app opens THAT INSTANT, and this runs
  // underneath it. Until it finishes, nothing serves locally (refreshServing
  // only runs at the end) and every screen reads live exactly as it does
  // today. The only thing that changes at the end is where the numbers come
  // from.
  //
  // IT RESUMES. runSetup skips a leg that is already set up and staging.js
  // resumes a part-finished leg from the last page that actually landed, so a
  // download interrupted by a closed tab, a flat battery or a dropped line
  // picks up where it stopped rather than starting again. A failure retries on
  // its own every SETUP_RETRY_MS for as long as the app is open.
  // Is this device serving any leg right now (from this session or, via the
  // synchronous hint, the last one)?
  const servingAnything = () => MIRROR_LEGS.some((l) => isLegServing(l.name));

  // The legs that DID land are worth keeping current: the same forced census
  // the success path runs, then serving from what is verified, then the pass
  // loop — which keeps them current and repairs whatever is missing.
  async function handOverToPassLoop() {
    state.downloading = false;
    try { state.setupCensus = await engine.checkCensus({ force: true }); }
    catch (e) { state.setupCensus = { error: e.message }; }
    await refreshServing();
    await reportHealth();
    runtime.start();
  }

  let setupLoop = null;
  function downloadInBackground() {
    if (setupLoop) return setupLoop;
    state.downloading = true;
    setupLoop = (async () => {
      let failedAttempts = 0;
      for (;;) {
        // The kill switch, and a sign-out, both end the download. Asked here
        // AND passed into runSetup, which asks it between legs.
        if (stopped || !offlineMirrorEnabled()) { state.downloading = false; return null; }
        try {
          await ensureAccess();
          state.setup = await engine.runSetup({
            keepGoing: () => !stopped && offlineMirrorEnabled() && signedInEnough(),
          });
          // ABANDONED IS NOT FINISHED. A kill switch, a sign-out or a stop
          // ends the leg loop without throwing, and treating that as a
          // completed download would census a copy that is not there, stamp
          // the serving hint from it and start the pass loop on a device that
          // has just been told to stop. It simply stands down; the next open,
          // or the switch coming back, resumes it.
          if (state.setup?.abandoned) { state.downloading = false; return null; }
          state.setupError = null;

          // ── VERIFIED BEFORE IT IS SERVED ─────────────────────────────────
          //
          // A first download has nothing to compare itself against: the shrink
          // guard protects a copy that already exists, and on a fresh device
          // `held` is 0, so a catalogue truncated to a fifth of itself is
          // "bigger than what I had" and is accepted. That is precisely the
          // POS incident — 4,654 products read as 799 because a short page was
          // taken for the end of the node — in the one state the guard cannot
          // see.
          //
          // /mirror_counts is the outside opinion, and it is asked HERE,
          // FORCED, before refreshServing decides what this device may serve.
          // A leg that disagrees with the census is marked failed and its
          // setup marker dropped, so it is not served and the ordinary pass
          // loop downloads it again. Nothing is deleted, and nothing short is
          // ever vouched for.
          try { state.setupCensus = await engine.checkCensus({ force: true }); }
          catch (err) { state.setupCensus = { error: err.message }; }

          await refreshServing();
          bumpLegs(MIRROR_LEGS.map((l) => l.name));
          state.downloading = false;
          await reportHealth();
          runtime.start();
          return state.setup;
        } catch (err) {
          // NOTHING IS LOST. Every leg that landed is on disk with its health
          // record; the next attempt starts from the first one that did not,
          // and a range leg from the cursor it last committed.
          failedAttempts += 1;
          const failedLegs = err.failedLegs ?? [];
          state.setupError = {
            at: now(), reason: err.name, message: err.message,
            legs: failedLegs.map((f) => f.leg),
          };
          // WHERE is the failing LEG, not "setup" — it is what the fleet
          // screen shows, and "movements" is what somebody can act on.
          state.lastError = {
            where: failedLegs[0]?.leg ?? err.leg ?? "setup", reason: err.name, message: err.message,
          };
          // Reported NOW. A device stuck in its download used to report
          // nothing at all, which is why the fleet screen could not see #624.
          await reportHealth();

          // Nothing left this session can try? Stop, and say so — never loop.
          let missing = [];
          try { missing = (await engine.setupState()).legs.filter((l) => !l.ready).map((l) => l.leg); }
          catch { /* treat as "unknown": keep the backoff, never a tight loop */ }
          const benched = new Set(engine.legFailures().filter((f) => f.benched).map((f) => f.leg));
          if (missing.length > 0 && missing.every((l) => benched.has(l))) {
            state.setupError = { ...state.setupError, gaveUp: [...benched] };
            console.warn("offline mirror: the download gave up on", [...benched].join(", "),
              "for this session — it will try again the next time the app is opened.");
            await handOverToPassLoop();
            return null;
          }
          // ── A DEVICE ALREADY SERVING MUST NOT WAIT FROZEN ────────────────
          // Its screens are reading the legs it served last session, and only
          // the pass loop's change feed keeps them current. Waiting out a
          // retry here left them frozen for up to an hour at a time: on
          // 26 Sep 2026 Junid's iPhone kept showing the Air Force 1 White as
          // Clothing while every edit he made landed on the server, because
          // its stock leg kept failing to assemble. The pass loop repairs the
          // missing leg itself (one per pass, with the same per-leg backoff),
          // so the download is handed to it rather than retried beside it.
          if (servingAnything()) {
            await handOverToPassLoop();
            return null;
          }
          const wait = Math.min(SETUP_RETRY_MAX_MS, SETUP_RETRY_MS * 2 ** (failedAttempts - 1));
          console.warn("offline mirror: the download stopped —", err.message,
            `— it will try again by itself in ${Math.round(wait / 60000)} min.`);
          await new Promise((resolve) => setTimeoutFn(resolve, wait));
        }
      }
    })().finally(() => { setupLoop = null; });
    return setupLoop;
  }

  const runtime = {
    db, adapter, engine, connection, state,
    // Awaited by nothing on the staff's path. Kept as a promise for the tests
    // and for a caller that wants to know when the copy is complete.
    async setup(opts) {
      state.setup = await engine.runSetup(opts);
      await refreshServing();
      bumpLegs(MIRROR_LEGS.map((l) => l.name));
      return state.setup;
    },

    // ── THE ONE QUESTION A DEVICE IS EVER ASKED ─────────────────────────────
    //
    // "Has somebody on this device tapped Download?" Asked once per device;
    // afterwards the copy resumes by itself on every open until it is complete.
    async hasConsented() {
      return !!(await db.getMeta(CONSENT_META));
    },
    // Awaits the one small IndexedDB write that records the tap, and NOT the
    // download it starts. Returning the loop's promise would be the obvious
    // thing and is the bug: the gate awaits this call, so it would sit on the
    // screen for the whole 104 MB and the button would say "Starting…" over a
    // covered app for four minutes. The download is deliberately dropped on
    // the floor here — it reports through state and the status dot.
    async consentAndDownload() {
      await db.setMeta(CONSENT_META, { at: now(), buildVersion });
      consented = true;
      downloadInBackground();
      return true;
    },
    downloadInBackground,

    // ── WHAT THIS DEVICE SHOULD BE DOING, RIGHT NOW ─────────────────────────
    //
    // Called on a start, and again every time the fleet switch comes back on.
    // Three states and one of them is a question: a complete copy runs the
    // pass loop, an incomplete copy that has been agreed to resumes its
    // download, and a device nobody has asked yet is left alone for the gate
    // to ask. Before this existed, a switch flipped back ON called start()
    // only — so a device killed mid-download never finished it except through
    // the pass loop's repair side door, unverified.
    async resume() {
      if (!offlineMirrorEnabled()) return "off";
      if (!consented) return "needs-consent";
      if ((await engine.setupState()).done) { runtime.start(); return "running"; }
      // Incomplete, but already serving legs from an earlier session: the pass
      // loop keeps those current AND repairs what is missing. A download run
      // instead would leave them frozen until it finished (see
      // handOverToPassLoop's caller in downloadInBackground).
      if (servingAnything()) { runtime.start(); return "running"; }
      downloadInBackground();
      return "downloading";
    },
    // ── PROGRESS COMES FROM THE DISK, NOT FROM THIS SESSION'S MEMORY ────────
    //
    // `state.setupDone` only knows what THIS session downloaded, and runSetup
    // skips the legs that are already there — so a device that had 90 MB on
    // disk and was reloaded showed "0% (0 MB of 104 MB)" while it finished the
    // last leg. The legs that are set up are a fact on the device; ask it.
    // (Fable-vs-spec review, PR #624.)
    async downloadProgress() {
      let legsDone = [...state.setupDone];
      try {
        const setup = await engine.setupState();
        legsDone = setup.legs.filter((l) => l.ready).map((l) => l.leg);
      } catch { /* the session's own list is a fair fallback */ }
      return {
        downloading: state.downloading,
        legsDone,
        current: state.setupProgress?.leg ?? null,
        error: state.setupError,
      };
    },
    onSetupProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    refreshServing,
    setupState: () => engine.setupState(),
    runOnePass,
    // `stopped` is cleared here as well as on an auth transition: a public
    // start()/stop() pair whose start() silently does nothing after a stop()
    // is a trap for the next caller, even though nothing does that today.
    // (Sonnet verification review, PR #618.)
    // Refuses against a switch that is off, against a device that has not
    // agreed to hold a copy, and against a session with nobody signed in —
    // every mirrored node's read rule requires a signed-in, non-anonymous
    // user, and a listener registered before that is refused without retrying.
    start() {
      if (!offlineMirrorEnabled() || !consented) return;
      wanted = true;
      if (!signedInEnough()) return;
      stopped = false; schedule(0); watchChanges();
    },
    // ── IDLE: SUSPEND AND RESUME (idleSuspend.js decides when) ──────────────
    //
    // Suspending stops the pass loop and closes the change-feed signal; it
    // does not stop serving — the copy on disk is still the copy, and a
    // suspended device is one nobody is looking at. Nothing is dropped:
    // resuming re-opens the signal from the cursor STORED IN INDEXEDDB (not
    // the one the signal was first opened with at boot, which on a device
    // left open all day re-downloaded every change since the morning on each
    // reconnect) and runs a pass at once, which reads the feed from that same
    // cursor. A resume is a catch-up, never a fresh download.
    suspendLive() {
      if (stopped || suspended) return false;
      suspended = true;
      clearTimeoutFn(timer);
      clearTimeoutFn(signalTimer);
      if (signalUnsub) { signalUnsub(); signalUnsub = null; }
      return true;
    },
    resumeLive() {
      if (!suspended) return false;
      suspended = false;
      startedAt = now();
      if (stopped || !wanted) return true;
      schedule(0);
      watchChanges();
      return true;
    },
    isSuspended: () => suspended,
    // Every leg this account may read is served from the local copy.
    fullyMirrored: () => lastServing.length > 0 && readableUnserved.length === 0,
    stop() {
      stopped = true;
      wanted = false;
      clearTimeoutFn(timer);
      unwatchConnection();
      if (signalUnsub) { signalUnsub(); signalUnsub = null; }
      clearTimeoutFn(signalTimer);
      connection.stop();
      // Nothing may go on claiming this device serves locally once the mirror
      // has stopped: every hook reads that hint synchronously and would skip
      // the live subscription it now needs.
      setServingLegs([]);
      setForcedUpdateMode(false);
    },
  };

  // ── THE DEVICE'S OWN REPORT ───────────────────────────────────────────────
  //
  // One small record per device at /mirror_devices/{deviceId}, written only
  // when something a person would act on has changed (deviceHealth.js decides,
  // and rate-limits). It is the only way to answer "is the fleet actually
  // working" without picking up twenty tablets.
  // "Is there a user whose credentials a mirrored read can actually use?"
  // With no auth object at all — the tests, and only the tests — the answer is
  // yes, because there is nothing to wait for.
  function signedInEnough() {
    if (!auth) return true;
    const u = currentUser ?? auth.currentUser ?? null;
    return !!u && u.isAnonymous !== true;
  }

  let lastReport = null;
  // The last serving list refreshServing computed. reportHealth used to
  // recompute it — 21 more IndexedDB reads on every pass — for a number the
  // pass had just worked out.
  let lastServing = [];
  // Who is signed in on this device, for the report. Read, never enforced —
  // every rule in this database is enforced by the database.
  let currentUser = auth?.currentUser ?? null;
  async function reportHealth({ user = null } = {}) {
    try {
      const legs = [];
      for (const leg of MIRROR_LEGS) {
        const health = await getLegHealth(db, leg.name).catch(() => null);
        const vouched = vouchingRecord(health);
        legs.push({
          name: leg.name,
          ok: health?.ok === true,
          reason: health?.reason ?? null,
          rows: vouched?.rows ?? null,
          at: vouched?.at ?? null,
        });
      }
      const { deviceId, label } = thisDevice();
      const setup = await engine.setupState();
      const record = deviceRecord({
        deviceId, label, buildVersion, now,
        uid: user?.uid ?? currentUser?.uid ?? null,
        email: user?.email ?? currentUser?.email ?? null,
        legs,
        serving: lastServing,
        complete: setup.done,
        downloading: state.downloading,
        switchOn: offlineMirrorEnabled(),
        lastSyncAt: legs.reduce((m, l) => Math.max(m, l.at ?? 0), 0) || null,
        lastPassAt: state.lastPass?.at ?? null,
        lastError: state.lastError,
        bytes: await bytesToday(db, { now }),
        photos: await heldPhotoCount(db).catch(() => null),
        pending: pendingCount(),
        failing: engine.legFailures(),
        storage: await storageSnapshot({ now }).catch(() => null),
      });
      const written = await reportDeviceHealth({
        write: (path, value) => adapter.writePath(path, value),
        record,
        last: lastReport,
      });
      if (written) lastReport = written;
    } catch (err) {
      // A device that cannot report its health goes on working perfectly well.
      console.warn("offline mirror: health report failed —", err?.message ?? err);
    }
  }
  runtime.reportHealth = reportHealth;

  // Asks the database, once per signed-in account, which held legs that
  // account may read — see engine.checkAccess. Only ever called from the two
  // consented paths (a pass, a download), so it never reads unasked.
  async function ensureAccess() {
    const uid = currentUser?.uid ?? auth?.currentUser?.uid ?? null;
    if (!uid || readAccessUid() === uid) return;
    const { unchecked } = await engine.checkAccess();
    // Anything unanswered (a timeout) leaves this account UNCHECKED: nothing
    // is served to it yet, and the next pass asks again.
    if (unchecked.length) return;
    writeAccessUid(uid);
    await refreshServing();
  }
  runtime.ensureAccess = ensureAccess;

  // A copy taken by the old pager may be short and still be in the serving
  // hint from the last session. Retire it before anything trusts the hint.
  // Local only: IndexedDB in, health records out, no RTDB read. (Here, below
  // every `let` refreshServing touches — not at the top of the function.)
  try {
    const retired = await engine.retireOldPagerCopies();
    if (retired.length) await refreshServing();
    // A leg the LAST account could not read is asked again for this one.
    await engine.clearNotPermitted();
  } catch (err) {
    console.warn("offline mirror: could not retire old-pager copies —", err?.message ?? err);
  }

  // Nothing runs until there is a signed-in, non-anonymous user, and
  // everything stops when there is not — every mirrored node's read rule says
  // so, and a read registered before sign-in is rejected without retrying.
  if (auth) {
    const { onAuthStateChanged } = await import("firebase/auth");
    onAuthStateChanged(auth, (user) => {
      currentUser = user ?? null;
      // A DIFFERENT ACCOUNT: nothing is served from the copy until its read
      // rights have been checked (ensureAccess, on the next pass). Synchronous,
      // so no screen renders one account's copy for another in between.
      if (user?.uid && readAccessUid() !== user.uid) setServingLegs([]);
      // Signed out, or someone else: serving.js already refuses the old hint
      // (it is keyed to the account); every screen is told to ask again.
      notifyServingChanged();
      const usable = signedInEnough() && offlineMirrorEnabled();
      // It RESUMES what was already wanted. It does not decide that something
      // should run: a sign-in is not a request for a 104 MB download, and
      // treating it as one is how this engine used to download the whole shop
      // onto a device whose staff had never been asked.
      if (usable && wanted) { stopped = false; schedule(0); }
      else if (!usable) { clearTimeoutFn(timer); stopped = true; }
    });
  }

  return runtime;
}
