// ─── DEVICE QUARANTINE — THE SCREEN ──────────────────────────────────────────
//
// Mounted beside the app in main.jsx, never around it: the app underneath is
// never unmounted, so a sale, a count or a save that is still going through
// keeps going through while the message is up. The rules for WHEN it may
// appear, and why every doubt means "no message", are in quarantine.js.
//
// While shown it is a portal on <body> and the app's own root is made `inert`,
// so nothing under it can be tapped or typed into. There is no close button,
// and it comes back on every open until the owner clears the flag from the
// Mirror Fleet screen — which reaches this device live, and takes it down in
// the same second.

import { Component, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getDeviceId } from "./deviceId";
import {
  OWNER_NAME, readCachedQuarantine, shouldShowNow, watchQuarantine, firebaseSubscribe,
} from "./quarantine";
import { isUpdateBusy } from "../update/updateChecker";

const CHECK_EVERY_MS = 1000;

// A throw anywhere below renders NOTHING. The quarantine is a convenience for
// the owner; a bug in it must never become a shop that cannot trade.
class FailOpen extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.warn("device quarantine: failed open —", err?.message ?? err); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function QuarantineScreen({ deviceId }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`Show this screen to ${OWNER_NAME}`}
      data-device-quarantine=""
      style={{
        position: "fixed", inset: 0, zIndex: 2147483646, background: "#000", color: "#fff",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: 24, textAlign: "center", fontFamily: "-apple-system, system-ui, sans-serif",
        touchAction: "none", overscrollBehavior: "contain",
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.2, maxWidth: 480 }}>
        Show this screen to {OWNER_NAME}
      </div>
      <div style={{ fontSize: 17, color: "#d1d1d6", marginTop: 16, maxWidth: 440, lineHeight: 1.45 }}>
        {OWNER_NAME} needs to look at this phone. Please bring it to {OWNER_NAME} as soon as you can.
        The app is paused on this device only. Nothing you were doing has been lost.
      </div>
      <div style={{ marginTop: 28, fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.8 }}>
        Device
      </div>
      <div style={{ marginTop: 6, fontSize: 15, fontFamily: "ui-monospace, Menlo, monospace", color: "#ffd60a", wordBreak: "break-all", maxWidth: 440 }}>
        {deviceId}
      </div>
    </div>
  );
}

function Quarantine({ auth, subscribe = firebaseSubscribe, busy = isUpdateBusy }) {
  const [deviceId] = useState(() => getDeviceId());
  const [quarantined, setQuarantined] = useState(() => readCachedQuarantine(deviceId));
  const [signedIn, setSignedIn] = useState(false);
  const [shown, setShown] = useState(false);
  const activity = useRef({ at: 0, untouched: true });

  // Signed in, non-anonymous: the rule on /mirror_switch wants exactly that,
  // and a listener opened earlier is refused and never retries.
  useEffect(() => {
    if (!auth) return undefined;
    let cancelled = false;
    let unsub = null;
    (async () => {
      const { onAuthStateChanged } = await import("firebase/auth");
      if (cancelled) return;
      unsub = onAuthStateChanged(auth, (user) => setSignedIn(!!user && user.isAnonymous !== true));
    })().catch(() => {});
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [auth]);

  useEffect(() => {
    if (!signedIn) return undefined;
    return watchQuarantine({ deviceId, subscribe, onChange: setQuarantined });
  }, [signedIn, deviceId, subscribe]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const touch = () => { activity.current = { at: Date.now(), untouched: false }; };
    const events = ["pointerdown", "keydown", "touchstart", "input"];
    for (const e of events) window.addEventListener(e, touch, { capture: true, passive: true });
    return () => { for (const e of events) window.removeEventListener(e, touch, { capture: true }); };
  }, []);

  // Cleared: down at once. Flagged: up the first moment nothing is in hand.
  useEffect(() => {
    if (!quarantined) { setShown(false); return undefined; }
    if (shown) return undefined;
    const check = () => {
      let isBusy = true;
      try { isBusy = busy(); } catch { isBusy = true; }
      const a = activity.current;
      if (shouldShowNow({ quarantined: true, busy: isBusy, msSinceActivity: Date.now() - a.at, untouched: a.untouched })) {
        setShown(true);
      }
    };
    check();
    const t = setInterval(check, CHECK_EVERY_MS);
    return () => clearInterval(t);
  }, [quarantined, shown, busy]);

  // Only over a signed-in session: that is the session that can HEAR the
  // clear, so the message can never stand in front of a sign-in screen it
  // would then be impossible to get past.
  const visible = shown && signedIn && !!deviceId && quarantined;

  // Nothing under the message can be tapped or typed into while it is up —
  // and ONLY while it is up: the app is made inert by exactly the condition
  // that draws the message, so it can never be frozen behind nothing.
  useEffect(() => {
    if (!visible || typeof document === "undefined") return undefined;
    const root = document.getElementById("root");
    if (!root) return undefined;
    root.inert = true;
    root.setAttribute("aria-hidden", "true");
    return () => { root.inert = false; root.removeAttribute("aria-hidden"); };
  }, [visible]);

  if (!visible) return null;
  const screen = <QuarantineScreen deviceId={deviceId} />;
  return typeof document !== "undefined" && document.body ? createPortal(screen, document.body) : screen;
}

export default function DeviceQuarantine(props) {
  return <FailOpen><Quarantine {...props} /></FailOpen>;
}
