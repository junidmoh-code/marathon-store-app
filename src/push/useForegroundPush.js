// ─── WHEN THE APP IS OPEN, THE OS STAYS QUIET ────────────────────────────────
// A system notification for an app you are already looking at is noise. So the
// server sends DATA-ONLY messages (functions/lib/order-push.cjs) and the two
// halves split the job with no overlap possible:
//
//   app backgrounded → public/firebase-messaging-sw.js shows the OS notification
//   app foregrounded → this hook shows an in-app banner and plays the chime
//
// Firebase's SDK decides which of the two receives a given message, and a
// data-only payload gives the browser nothing to display on its own. There is
// therefore no path on which both fire — which is the point, because a
// double-fire is the failure everyone notices and nobody can explain.
//
// The second guard is for OUR side of it: React StrictMode mounts effects
// twice in development, and a foreground tab that reconnects can be handed the
// same message again. Each message carries the moment its window closed, so a
// message already shown is recognised and dropped rather than chiming twice.

import { useCallback, useEffect, useRef, useState } from "react";
import { armAudioUnlock, playChime } from "./chime";
import { routeFromPushMessage } from "./deepLink";

const BANNER_MS = 8000;

/** @param {{enabled: boolean}} args — no listener at all when push is off. */
export function useForegroundPush({ enabled }) {
  const [banner, setBanner] = useState(null);
  const shownRef = useRef(new Set());
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setBanner(null);
  }, []);

  // Arm the audio unlock as soon as push is on, not when the first message
  // arrives — by then the gesture that would have unlocked it is long past.
  useEffect(() => { if (enabled) armAudioUnlock(); }, [enabled]);

  useEffect(() => {
    // Switching push off must take any banner already on screen with it —
    // clearing only the timeout leaves the last alert sitting there after the
    // feature that produced it was turned off.
    if (!enabled) { setBanner(null); return undefined; }
    if (typeof window === "undefined") return undefined;
    let cancelled = false;
    let unsubscribe = null;

    const show = (data) => {
      const key = `${data.tag || "order"}:${data.sentAt || ""}`;
      if (shownRef.current.has(key)) return;
      shownRef.current.add(key);
      // Bounded: a long-lived warehouse tab must not accumulate keys all day.
      if (shownRef.current.size > 100) shownRef.current = new Set([key]);
      setBanner({
        title: data.title || "New order",
        body: data.body || "",
        link: data.link || null,
        count: Number(data.count) || 1,
      });
      playChime();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setBanner(null), BANNER_MS);
    };

    (async () => {
      try {
        const { getMessaging, onMessage, isSupported } = await import("firebase/messaging");
        if (cancelled || !(await isSupported())) return;
        unsubscribe = onMessage(getMessaging(), (payload) => {
          const data = (payload && payload.data) || {};
          if (data.kind !== "order") return;
          show(data);
        });
      } catch (err) {
        // A foreground listener that cannot start is a missing banner, not a
        // missing notification: the OS path is independent of this one.
        console.warn("[push] foreground listener unavailable:", err);
      }
    })();

    // A notification tapped while this tab is already open arrives here rather
    // than as a fresh page load.
    const onSwMessage = (event) => {
      const msg = event && event.data;
      if (msg && msg.type === "marathon-push-navigate" && msg.link) routeFromPushMessage(msg.link);
    };
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", onSwMessage);

    return () => {
      cancelled = true;
      if (typeof unsubscribe === "function") unsubscribe();
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", onSwMessage);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [enabled]);

  const open = useCallback(() => {
    const link = banner && banner.link;
    dismiss();
    if (link) routeFromPushMessage(link);
  }, [banner, dismiss]);

  return { banner, dismiss, open };
}
