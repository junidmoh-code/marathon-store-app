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

import { useEffect, useState } from "react";
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
  const [failed, setFailed] = useState(false);

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
      if (cancelled || !rt) { if (!cancelled) { setFailed(!rt); setReady(true); } return; }
      setRuntime(rt);
      const state = await rt.setupState();
      if (cancelled) return;
      if (state.done) { setReady(true); rt.start(); }
    }, (err) => {
      if (cancelled) return;
      // See the header: a mirror that cannot start must not stop the app.
      console.warn("offline mirror: could not start —", err);
      setFailed(true);
      setReady(true);
    });

    const bail = setTimeout(() => {
      if (cancelled) return;
      console.warn("offline mirror: did not start within "
        + `${startTimeoutMs} ms — rendering the app on its live reads.`);
      setReady(true);
    }, startTimeoutMs);

    return () => { cancelled = true; clearTimeout(bail); };
  }, [enabled, auth, storage, startTimeoutMs]);

  if (!enabled || ready || failed) return children;
  if (!runtime) return null;   // a blank instant while IndexedDB opens
  return (
    <MirrorSetupScreen
      runtime={runtime}
      onDone={() => { setReady(true); runtime.start(); }}
    />
  );
}
