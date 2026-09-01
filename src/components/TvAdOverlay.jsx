// ─── TV AD OVERLAY ────────────────────────────────────────────────────────────
// Full-screen ad shown over the queue board on a self-contained repeating timer:
// hidden for AD_HIDDEN_MS, then visible for AD_VISIBLE_MS, looping forever from
// mount. No admin toggle, no manual trigger — the board underneath keeps
// rendering/updating the whole time, this just paints over it while visible.
// To swap the ad creative, change AD_OVERLAY_CONFIG.src (and alt) only — the
// timer logic below never needs to change for a new ad.
import { useEffect, useState } from "react";

export const AD_HIDDEN_MS = 15 * 60 * 1000;
export const AD_VISIBLE_MS = 2 * 60 * 1000;

export const AD_OVERLAY_CONFIG = {
  src: "/ads/lacoste-buy2-r750.png",
  alt: "Marathon Club — buy any two Lacoste for R750",
};

export function useAdOverlayVisible(hiddenMs = AD_HIDDEN_MS, visibleMs = AD_VISIBLE_MS) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let timer;
    const showAd = () => { setVisible(true); timer = setTimeout(hideAd, visibleMs); };
    const hideAd = () => { setVisible(false); timer = setTimeout(showAd, hiddenMs); };
    timer = setTimeout(showAd, hiddenMs);
    return () => clearTimeout(timer);
  }, [hiddenMs, visibleMs]);
  return visible;
}

export default function TvAdOverlay({ hiddenMs, visibleMs }) {
  const visible = useAdOverlayVisible(hiddenMs, visibleMs);
  if (!visible) return null;
  return (
    <div
      data-testid="tv-ad-overlay"
      style={{
        position: "fixed", inset: 0, zIndex: 500,
        background: "#000",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <img
        src={AD_OVERLAY_CONFIG.src}
        alt={AD_OVERLAY_CONFIG.alt}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </div>
  );
}
