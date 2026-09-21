// ─── OFFLINE MIRROR — the gate, and the dot ──────────────────────────────────
//
// `MirrorGate` wraps the whole app. It decides, live, whether this device
// mirrors at all, and it shows the one-button download gate to a device that
// does not have a complete copy yet.
//
// ── ONE SWITCH, AND IT IS REMOTE ────────────────────────────────────────────
//
// There is no longer a per-device flag. Whether a device mirrors is one value
// in the database (killSwitch.js), watched live from the moment somebody signs
// in, and a flip takes effect
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
import {
  mirrorSwitchOn, offlineMirrorEnabled, subscribeMirrorSwitch, watchMirrorSwitchLive,
} from "./killSwitch";
import { setOfflineMirrorRuntime } from "./mirrorRuntime";

// PR #618 raced the start against an 8-second bound, because a start that
// hung left the app behind a setup screen that could never finish. Nothing is
// held any more — the app renders from the first paint and reads live — so the
// bound has nothing to protect and is gone. openMirrorDb() can still block
// indefinitely on a browser with IndexedDB disabled; the only consequence now
// is a device that never mirrors, which is a device behaving exactly as it did
// before any of this existed.
// ── NO QUESTION ANY MORE (owner decision, 21 Sep 2026) ──────────────────
// A device with the switch on and somebody signed in starts its download the
// moment it is in use. The one-button "Keep the shop on this device" gate
// used to stand here; the owner asked that every device in use download
// without being asked. The download still runs BEHIND the working app, still
// only after sign-in, still only while the switch is on — the switch is the
// consent now, and turning it off still stops every device within a second.
const autoConsent = (rt) => rt.consentAndDownload().catch((err) => {
  console.warn("offline mirror: could not start the download —", err);
});

export function MirrorGate({ auth, storage, children }) {
  const [switchOn, setSwitchOn] = useState(() => mirrorSwitchOn());
  const [runtime, setRuntime] = useState(null);
  const [signedIn, setSignedIn] = useState(false);
  // The live runtime, for the effects that must reach it without waiting for a
  // re-render: a kill-switch flip has to stop the engine in the same tick it
  // arrives, and a flip back on has to reuse the runtime rather than build a
  // second one alongside the first.
  const runtimeRef = useRef(null);
  // ── AND THE START THAT HAS NOT FINISHED YET ───────────────────────────────
  //
  // `startOfflineMirror()` is not a pure constructor. By the time it resolves
  // it has opened IndexedDB, started the connection tracker and registered its
  // own auth listener — and that listener schedules a pass by itself, with no
  // dependence on anyone calling start(). So a runtime that is built and then
  // dropped is not garbage: it is a second engine, reading and reporting on
  // the same device, owned by nobody.
  //
  // Two flips while one is in flight is all it takes: the effect re-runs,
  // `runtimeRef.current` is still null because nothing has resolved, and it
  // builds a second one. The promise is held here so a re-run ADOPTS the start
  // already running instead of starting another, and the resolve handler
  // adopts the runtime even when its own effect run was cancelled — so there
  // is always exactly one engine and something that can stop it.
  // (Sonnet architect review, PR #624.)
  const startPromiseRef = useRef(null);

  const enabled = switchOn;

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

  // ── STARTING, AND THE ONE QUESTION ────────────────────────────────────────
  //
  // NOTHING HAPPENS BEFORE SIGN-IN. Every mirrored node's read rule wants a
  // signed-in, non-anonymous user, and a listener or read registered before
  // that is refused without retrying — so a start that ran at first paint
  // (which it did, because the switch answer is cached and true from the cache
  // on every reload) left the change-log signal permanently dead for the
  // session, and told a member of staff that a database rule had not been
  // pasted when the truth was "you have not typed your PIN yet".
  // (Fable-vs-spec review, PR #624.)
  useEffect(() => {
    if (!enabled || !signedIn) return undefined;
    let cancelled = false;

    // Already running, and the switch has just come back on: resume the same
    // engine rather than building a second one against the same IndexedDB.
    if (runtimeRef.current) {
      const rt = runtimeRef.current;
      rt.resume().then((what) => {
        if (!cancelled && what === "needs-consent") autoConsent(rt);
      }).catch(() => {});
      return () => { cancelled = true; };
    }

    if (!startPromiseRef.current) {
      startPromiseRef.current = (async () => {
        const { startOfflineMirror } = await import("./bootstrap");
        return startOfflineMirror({ auth, storage });
      })();
      // Registered synchronously in the same tick the import starts, so the
      // dot and every reader see a pending promise rather than "not yet
      // decided".
      setOfflineMirrorRuntime(startPromiseRef.current);
    }
    const promise = startPromiseRef.current;

    promise.then(async (rt) => {
      if (!rt) return;
      // ADOPTED EVEN IF THIS EFFECT RUN WAS CANCELLED. The engine belongs to
      // the component, not to the effect run that happened to ask for it;
      // leaving it unadopted is what makes it an orphan nothing can stop.
      runtimeRef.current = rt;
      setRuntime(rt);
      // The switch may have gone off during the start. Nothing may run against
      // a switch that is already false — and this is the line that stops the
      // engine built during a flip that has since been reversed.
      if (!offlineMirrorEnabled()) { rt.stop(); return; }
      // A later, live effect run is driving it; this one only had to make sure
      // it was adopted.
      if (cancelled) return;

      // ONE call decides what this device needs next: run the pass loop on a
      // complete copy, resume the download on an agreed but unfinished one, or
      // say that nobody has been asked yet.
      const what = await rt.resume();
      if (!cancelled && what === "needs-consent") autoConsent(rt);
    }, (err) => {
      if (cancelled) return;
      // See the header: a mirror that cannot start must not stop the app.
      console.warn("offline mirror: could not start —", err);
    });

    return () => { cancelled = true; };
  }, [enabled, signedIn, auth, storage]);

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

  // Nothing is ever shown over the app: see autoConsent. `runtime` is kept
  // for the status dot, which reads it through mirrorRuntime.
  void runtime;
  return <>{children}</>;
}
