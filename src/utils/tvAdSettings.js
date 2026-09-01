// ─── TV AD SETTINGS — shared read contract ────────────────────────────────────
// One node, /settings/tvAd, drives both the admin "TV Ad" card (writes it) and
// the TV screen overlay (reads it). Kept in one file so the two can never drift
// on shape: { enabled, mediaUrl, mediaType, intervalMinutes, durationMinutes,
// updatedAt, updatedBy }. Read fails OPEN to "no ad" — a broken/missing node
// must never block the queue board, only skip the overlay.
import { useEffect, useState } from "react";
import { onValue, ref } from "firebase/database";
import { database } from "../firebase";

export const TV_AD_SETTINGS_PATH = "settings/tvAd";

export const DEFAULT_TV_AD_INTERVAL_MINUTES = 15;
export const DEFAULT_TV_AD_DURATION_MINUTES = 2;

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
          intervalMinutes: Number(v.intervalMinutes) > 0 ? Number(v.intervalMinutes) : DEFAULT_TV_AD_INTERVAL_MINUTES,
          durationMinutes: Number(v.durationMinutes) > 0 ? Number(v.durationMinutes) : DEFAULT_TV_AD_DURATION_MINUTES,
          updatedAt: v.updatedAt || null,
          updatedBy: v.updatedBy || null,
        });
      },
      () => setSettings({ enabled: false, mediaUrl: "", mediaType: "image", intervalMinutes: DEFAULT_TV_AD_INTERVAL_MINUTES, durationMinutes: DEFAULT_TV_AD_DURATION_MINUTES, updatedAt: null, updatedBy: null }),
    );
    return () => unsub();
  }, []);
  return settings;
}
