// ─── OFFLINE MIRROR — the gate, and the dot ──────────────────────────────────
//
// `MirrorGate` wraps the whole app. With the flag off it renders its children
// and imports nothing: the dynamic import below never runs, so none of the
// mirror's code is fetched or parsed and the app is byte-for-byte what it was.
//
// With the flag on it starts the mirror and, until this device has a COMPLETE
// copy, shows the setup screen instead of the app. The download is automatic —
// there is no button that starts it and no button that skips it.
//
// ── IT NEVER TRAPS ANYONE ───────────────────────────────────────────────────
//
// If the mirror cannot start at all — IndexedDB refused, a browser with none,
// the module failed to load — the gate renders the app. An app reading live is
// the state it has always been in and it works; an app behind a setup screen
// that can never finish is a shop that cannot trade. The dot says the mirror
// is off, which is a thing someone can act on.

import { useEffect, useRef, useState } from "react";
import { offlineMirrorEnabled } from "./mirrorFlag";
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
  const enabled = offlineMirrorEnabled();
  const [runtime, setRuntime] = useState(null);
  const [ready, setReady] = useState(!enabled);
  const [signedIn, setSignedIn] = useState(false);
  // Whether the start bound has already elapsed — read by the late-start path
  // below, which must know that the overlay will never mount.
  const bailed = useRef(false);

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
    if (!enabled || !auth) return undefined;
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
  }, [enabled, auth]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const promise = (async () => {
      const { startOfflineMirror } = await import("./bootstrap");
      return startOfflineMirror({ auth, storage });
    })();
    // Registered synchronously in the same tick the import starts, so the dot
    // and every reader see a pending promise rather than "not yet decided".
    setOfflineMirrorRuntime(promise);

    promise.then(async (rt) => {
      if (cancelled || !rt) { if (!cancelled) setReady(true); return; }
      setRuntime(rt);
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