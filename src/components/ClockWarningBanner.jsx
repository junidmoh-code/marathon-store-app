// ─── "THIS DEVICE'S CLOCK IS WRONG" BANNER ───────────────────────────────────
// On 2026-07-17 a till whose DATE was set one day behind (time-of-day correct to
// the second) reset the shared order counter and destroyed 47 orders, then went
// on stamping orders into "yesterday" so the warehouse queue never showed them.
// It took a live investigation to find the device, because nothing anywhere said
// "this device's clock is wrong".
//
// serverTime.js fixed the DATA — every write is now server-anchored — but that
// cure hides the disease: a misconfigured device now behaves correctly and says
// nothing. This banner is the replacement signal. It exists so the next bad
// clock announces itself in the first second, to whoever is holding the device,
// instead of being found by forensics a day later.
//
// Deliberate choices:
//   • NOT dismissible. A wrong clock is a persistent misconfiguration, not a
//     notification. It clears when the clock is fixed AND the RTDB connection
//     re-handshakes — NOT instantly: /.info/serverTimeOffset is measured at
//     connection time and is not resynced while a socket stays up. So expect it
//     to linger after a fix until reconnect/reload. (Same mechanism means a clock
//     changed MID-SESSION isn't noticed until reconnect either — see the note in
//     serverTime.js. This banner is a diagnostic, not a guarantee.)
//   • NOT blocking. Thanks to serverTime.js the data is already correct, so this
//     is a nag, not a stop. Never stand between a cashier and a sale.
//   • STAFF ONLY — enforced by ROLE, not tree position. App.jsx gates this on
//     role !== ROLES.DISPLAY, because ROLES.DISPLAY renders the SAME customer TV
//     inside AppInner: being an AuthGate child does NOT mean staff-only. A
//     warning on the shop-floor board is worse than the bug it reports.
import { useEffect, useMemo, useState } from "react";
import { onServerTimeOffsetChange, serverNowMs } from "../utils/serverTime";

// 5 minutes. Comfortably above ordinary phone/tablet drift and network jitter,
// far below the one-day error that caused the incident. The offset is measured
// against the RTDB server, so a busy connection moves this by milliseconds.
export const CLOCK_WARN_THRESHOLD_MS = 5 * 60 * 1000;

// "about 24 hours", "about 3 days", "about 12 minutes" — plain words, no
// decimals. Staff need to recognise the scale of the mistake, not measure it.
export function describeSkew(absMs) {
  const mins = Math.round(absMs / 60000);
  if (mins < 60) return `about ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(absMs / 3600000);
  if (hours < 48) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(absMs / 86400000);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

// How often the displayed date is re-read while the banner is up. Only ever
// runs on an already-misconfigured device, so a minute is cheap and plenty.
const DATE_REFRESH_MS = 60 * 1000;

/** The real date in SA — pinned to Africa/Johannesburg, NOT the device's
 *  timezone. A device can be wrong about the zone as well as the clock, and this
 *  banner's whole job is to state a fact the device is getting wrong. Every
 *  other date in the app is SA-anchored (see serverTime.js), so this matches. */
export function formatSaDate(ms) {
  return new Date(ms).toLocaleDateString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

/** Whether the clock is wrong enough to shout about. Pure + exported: this repo
 *  has no DOM test env, so the decision is tested here rather than via render. */
export function shouldWarn(offsetMs) {
  if (typeof offsetMs !== "number" || !Number.isFinite(offsetMs)) return false;
  return Math.abs(offsetMs) >= CLOCK_WARN_THRESHOLD_MS;
}

/** The full sentence, exported so tests assert the words staff actually read. */
export function clockWarningText(offsetMs) {
  // offset = server clock - device clock, so a POSITIVE offset means the device
  // is running behind. That was the incident: offset ≈ +24h.
  const behind = offsetMs > 0;
  return `This device's date/time is wrong — set it to automatic. It is ${describeSkew(Math.abs(offsetMs))} ${behind ? "behind" : "ahead"}.`;
}

export default function ClockWarningBanner() {
  const [offset, setOffset] = useState(0);
  // Ticks only to force a re-render; the date itself is DERIVED below, never
  // stored. Holding the date in state was wrong twice over: the initial value is
  // built at construction, when the offset is still 0 because the RTDB round-trip
  // hasn't landed — so the banner's FIRST paint showed the device's own wrong
  // date before self-correcting a frame later. Deriving at render means the value
  // cannot be stale by construction; the tick exists purely so a banner nobody
  // touches for hours still crosses midnight.
  const [dateTick, setDateTick] = useState(0);
  useEffect(() => onServerTimeOffsetChange(setOffset), []);
  useEffect(() => {
    if (!shouldWarn(offset)) return undefined;
    // A plain interval beats a scheduled next-midnight timeout: no boundary
    // arithmetic to get wrong, it self-corrects if the offset shifts under us,
    // and it only ticks on a device that is already misconfigured.
    const id = setInterval(() => setDateTick(t => t + 1), DATE_REFRESH_MS);
    return () => clearInterval(id);
  }, [offset]);

  // Derived, not stored — recomputed whenever the offset lands or the tick fires,
  // so it is correct on the very first paint AND after midnight.
  const realDate = useMemo(() => formatSaDate(serverNowMs()), [offset, dateTick]);

  if (!shouldWarn(offset)) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        // 10001 to outrank PWAUpdateBanner (App.jsx), which is ALSO fixed top:0
        // at z-index 10000. There are two update banners: src/update/UpdateBanner
        // (bottom-centre, 9999, never competed) and PWAUpdateBanner (top, 10000,
        // collides exactly). At equal z-index DOM order wins, and this renders
        // first — so the blue update bar covered the clock warning's first line.
        // A wrong clock outranks a pending refresh.
        zIndex: 10001,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "10px 16px",
        background: "#B91C1C",
        color: "#fff",
        font: "700 14px/1.35 -apple-system, 'Segoe UI', Roboto, sans-serif",
        textAlign: "center",
        boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 16 }}>⚠</span>
      <span>{clockWarningText(offset)}</span>
      <span style={{ fontWeight: 500, opacity: 0.9 }}>Today is {realDate}.</span>
    </div>
  );
}
