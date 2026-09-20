// ─── OFFLINE MIRROR — the gate, and the dot ──────────────────────────────────
//
// `MirrorGate` wraps the whole app. It decides, live, whether this device
// mirrors at all, and it shows the one-button download gate to a device that
// does not have a complete copy yet.
//
// ── TWO SWITCHES, AND ONE OF THEM IS REMOTE ─────────────────────────────────
//
// A device mirrors only if it is in the rollout (the per-device flag) AND the
// fleet switch in the database says yes (killSwitch.js). The fleet switch is
// watched live from the moment somebody signs in, and a flip takes effect
// WITHOUT A RELOAD: turning it off stops the engine and clears the serving
// hint, which re-renders every mirror-reading hook onto its live subscription;
// turning it back on starts the same engine again. That is the whole point of
// it — on a bad night the fix must not depend on a build reaching a tablet.
//
// ── IT NEVER TRAPS ANYONE ───────────────────────────────────────────────────
//
// If the mirror cannot start at all — IndexedDB refused, a browser with none,
// the module failed to load — the gate renders the app. An app reading live is
// the state it has always been in and it works; an app behind a setup screen
// that can never finish is a shop that cannot trade. The dot says the mirror
// is off, which is a thing someone can act on.

import { useEffect, useRef, useState } from "react";
import { deviceInRollout, offlineMirrorEnabled } from "./mirrorFlag";
import { mirrorSwitchOn, subscribeMirrorSwitch, watchMirrorSwitchLive } from "./killSwitch";
import { setOfflineMirrorRuntime } from "./mirrorRuntime";
import { MirrorSetupScreen } from "./MirrorSetupScreen";

// A mirror that cannot START must not hold the app hostage. openMirrorDb()
// can block indefinitely — a browser with IndexedDB disabled, a profile in a
// state it will not explain — and `await` on it has no timeout of its own. A
// blank screen with no error is the worst outcome available here, so the start
// is raced against a bound and the app is rendered if it is not ready in time.
// The mirror is still starting behind it; if it finishes later the serving
// hint turns on and the hooks switch over on their next render.
export const START_TIMEOUT_MS = 8000;

export function MirrorGate({ auth, storage, children, startTimeoutMs = START_TIMEOUT_MS }) {
  const [switchOn, setSwitchOn] = useState(() => mirrorSwitchOn());
  const [runtime, setRuntime] = useState(null);
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  // Whether the start bound has already elapsed — read by the late-start path
  // below, which must know that the overlay will never mount.
  const bailed = useRef(false);
  // The live runtime, for the effects that must reach it without waiting for a
  // re-render: a kill-switch flip has to stop the engine in the same tick it
  // arrives, and a flip back on has to reuse the runtime rather than build a
  // second one alongside the first.
  const runtimeRef = useRef(null);

  const enabled = deviceInRollout() && switchOn;

  // ── THE CHILDREN ALWAYS RENDER ───────────────────────────────────────────
  //
  // An earlier version returned the setup screen INSTEAD of the app. That is
  // a deadlock on a fresh device: every mirrored node is rules-gated on a
  // signed-in, non-anonymous user, the sign-in screen lives inside <App>, and
  // the setup screen was covering it — so the download failed with
  // PERMISSION_DENIED and nobody could reach the PIN screen to fix it. The
  // same trap caught the anonymous TV session. (Fable-vs-spec review, PR #618.)
  //
  // So the app mounts underneath and the setup screen is an OVERLAY on top of
  // it, shown only once there is a user whose credentials the download can
  // actually use. Blocking is what the overlay does, not what this gate does.
  useEffect(() => {
    if (!auth) return undefined;
    let cancelled = false;
    let unsub = null;
    (async () => {
      const { onAuthStateChanged } = await import("firebase/auth");
      if (cancelled) return;
      unsub = onAuthStateChanged(auth, (user) => {
        setSignedIn(!!user && user.isAnonymous !== true);
      });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [auth]);

  // ── THE FLEET SWITCH ──────────────────────────────────────────────────────
  //
  // Watched from sign-in, because its read rule is the same one every mirrored
  // node has: a signed-in, non-anonymous user. A subscription opened before
  // that is refused and does not retry, so it waits — and a device that never
  // signs in (the anonymous TV shell) never mirrors, which is correct.
  useEffect(() => {
    if (!signedIn) return undefined;
    return watchMirrorSwitchLive();
  }, [signedIn]);

  useEffect(() => subscribeMirrorSwitch((on) => setSwitchOn(on)), []);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    // Already running, and the switch has just come back on: start the same
    // engine rather than building a second one against the same IndexedDB.
    if (runtimeRef.current) {
      runtimeRef.current.start();
      return undefined;
    }

    const promise = (async () => {
      const { startOfflineMirror } = await import("./bootstrap");
      return startOfflineMirror({ auth, storage });
    })();
    // Registered synchronously in the same tick the import starts, so the dot
    // and every reader see a pending promise rather than "not yet decided".
    setOfflineMirrorRuntime(promise);

    promise.then(async (rt) => {
      if (cancelled || !rt) { if (!cancelled) setReady(true); return; }
      runtimeRef.current = rt;
      setRuntime(rt);
      // The switch may have gone off during the start. Nothing may run against
      // a switch that is already false.
      if (!offlineMirrorEnabled()) { rt.stop(); return; }
      const state = await rt.setupState();
      if (cancelled) return;
      if (state.done) { setReady(true); rt.start(); return; }
      // ── A LATE START MUST NOT LEAVE THE MIRROR DORMANT ────────────────
      // If the 8-second bail has already fired, `ready` is true, so the
      // overlay will never mount — and the overlay is the only thing that
      // calls setup(). Without this the mirror would sit there, started and
      // idle, for the whole session, on exactly the slow device the bail
      // exists for. So a late start runs its setup in the BACKGROUND: the
      // app is already working on live reads, and nobody is held.
      // (Sonnet verification review, PR #618.)
      if (bailed.current) {
        rt.setup()
          .then(() => rt.start())
          .catch((err) => console.warn("offline mirror: background setup failed —", err));
      }
    }, (err) => {
      if (cancelled) return;
      // See the header: a mirror that cannot start must not stop the app.
      console.warn("offline mirror: could not start —", err);
      setReady(true);
    });

    const bail = setTimeout(() => {
      if (cancelled) return;
      bailed.current = true;
      console.warn("offline mirror: did not start within "
        + `${startTimeoutMs} ms — rendering the app on its live reads.`);
      setReady(true);
    }, startTimeoutMs);

    return () => { cancelled = true; clearTimeout(bail); };
  }, [enabled, auth, storage, startTimeoutMs]);

  // ── THE KILL ──────────────────────────────────────────────────────────────
  //
  // Separate from the start, and deliberately so: it must fire on the flip
  // itself, not on a remount. `stop()` clears the serving hint, which is what
  // puts every hook back on its live subscription on its next render — and the
  // serving store re-renders them, so "next render" is now. The runtime is
  // KEPT: the local copy is still on disk, still valid, and a switch that goes
  // back on should not cost a device another 104 MB.
  useEffect(() => {
    if (enabled || !runtimeRef.current) return;
    runtimeRef.current.stop();
  }, [enabled]);

  // The one condition under which a person is held: the mirror is on, it
  // started, somebody is signed in, and this device has no complete copy yet.
  const blocking = enabled && !ready && !!runtime && signedIn;

  return (
    <>
      {children}
      {blocking && (
        <MirrorSetupScreen
          runtime={runtime}
          onDone={() => { setReady(true); runtime.start(); }}
        />
      )}
    </>
  );
}
