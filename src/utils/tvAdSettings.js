// ─── TV AD SETTINGS — shared read contract ────────────────────────────────────
// One node, /settings/tvAd, drives both the admin "TV Ad" card (writes it) and
// the TV screen overlay (reads it). Kept in one file so the two can never drift
// on shape: { enabled, mediaUrl, mediaType, intervalSeconds, durationSeconds,
// updatedAt, updatedBy }. Read fails OPEN to "no ad" — a broken/missing node
// must never block the queue board, only skip the overlay.
//
// Seconds, not minutes: the schedule needs sub-minute precision (e.g. "30s
// every 4 minutes"), so intervalSeconds/durationSeconds are the source of
// truth. Older writes from before this used *Minutes fields — read as a
// fallback (×60) so a stale node still resolves to something sane.
import { useEffect, useState } from "react";
import { onValue, ref } from "firebase/database";
import { database } from "../firebase";

export const TV_AD_SETTINGS_PATH = "settings/tvAd";

export const DEFAULT_TV_AD_INTERVAL_SECONDS = 15 * 60;
export const DEFAULT_TV_AD_DURATION_SECONDS = 2 * 60;

function resolveSeconds(secondsField, minutesField, fallback) {
  if (Number(secondsField) > 0) return Number(secondsField);
  if (Number(minutesField) > 0) return Number(minutesField) * 60;
  return fallback;
}

export function useTvAdSettings() {
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    const unsub = onValue(
      ref(database, TV_AD_SETTINGS_PATH),
      (snap) => {
        const v = snap.val() || {};
        setSettings({
          enabled: !!v.enabled,
          mediaUrl: v.mediaUrl || "",
          mediaType: v.mediaType === "video" ? "video" : "image",
          intervalSeconds: resolveSeconds(v.intervalSeconds, v.intervalMinutes, DEFAULT_TV_AD_INTERVAL_SECONDS),
          durationSeconds: resolveSeconds(v.durationSeconds, v.durationMinutes, DEFAULT_TV_AD_DURATION_SECONDS),
          updatedAt: v.updatedAt || null,
          updatedBy: v.updatedBy || null,
        });
      },
      () => setSettings({ enabled: false, mediaUrl: "", mediaType: "image", intervalSeconds: DEFAULT_TV_AD_INTERVAL_SECONDS, durationSeconds: DEFAULT_TV_AD_DURATION_SECONDS, updatedAt: null, updatedBy: null }),
    );
    return () => unsub();
  }, []);
  return settings;
}
