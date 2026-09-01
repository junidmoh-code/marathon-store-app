// ─── TV AD OVERLAY ────────────────────────────────────────────────────────────
// Full-screen ad shown over the queue board, driven live from /settings/tvAd
// (see src/utils/tvAdSettings.js) — no hardcoded timer, no redeploy needed to
// change the ad, the schedule, or turn it off. When disabled or no mediaUrl is
// set, this renders nothing and starts no timer at all; the board underneath
// keeps rendering/updating the whole time regardless.
import { useEffect, useState } from "react";
import { useTvAdSettings } from "../utils/tvAdSettings";

function useAdOverlayVisible(active, hiddenMs, visibleMs) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) { setVisible(false); return; }
    let timer;
    const showAd = () => { setVisible(true); timer = setTimeout(hideAd, visibleMs); };
    const hideAd = () => { setVisible(false); timer = setTimeout(showAd, hiddenMs); };
    timer = setTimeout(showAd, hiddenMs);
    return () => clearTimeout(timer);
  }, [active, hiddenMs, visibleMs]);
  return visible;
}

export default function TvAdOverlay() {
  const settings = useTvAdSettings();
  const active = !!(settings && settings.enabled && settings.mediaUrl);
  const hiddenMs = active ? settings.intervalMinutes * 60_000 : 0;
  const visibleMs = active ? settings.durationMinutes * 60_000 : 0;
  const visible = useAdOverlayVisible(active, hiddenMs, visibleMs);

  if (!active || !visible) return null;

  return (
    <div
      data-testid="tv-ad-overlay"
      style={{
        position: "fixed", inset: 0, zIndex: 500,
        background: "#000",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {settings.mediaType === "video" ? (
        <video
          key={settings.mediaUrl}
          src={settings.mediaUrl}
          autoPlay
          muted
          loop
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <img
          src={settings.mediaUrl}
          alt="Ad"
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      )}
    </div>
  );
}
