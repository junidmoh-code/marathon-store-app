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
//     notification. It clears the instant the clock is fixed, and no sooner.
//   • NOT blocking. Thanks to serverTime.js the data is already correct, so this
//     is a nag, not a stop. Never stand between a cashier and a sale.
//   • STAFF ONLY. App renders this inside AuthGate's staff children, never on
//     the customer-facing TV shell — a warning on the shop-floor TV is worse
//     than the bug it reports.
import { useEffect, useState } from "react";
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
  // The real date, per the server — the single most useful fact for someone
  // about to fix the device, and the one its own screen is lying about.
  // Held in state and refreshed on a timer: this banner only re-renders when the
  // OFFSET changes, and a misconfigured till sits untouched for hours. Computing
  // the date at render alone let it cross midnight and keep displaying
  // yesterday — a banner about wrong dates showing a wrong date.
  const [realDate, setRealDate] = useState(() => formatSaDate(serverNowMs()));
  useEffect(() => onServerTimeOffsetChange(setOffset), []);
  useEffect(() => {
    if (!shouldWarn(offset)) return undefined;
    // Re-read on appear, then poll. A plain interval beats a scheduled
    // next-midnight timeout here: no boundary arithmetic to get wrong, it
    // self-corrects if the offset shifts under us, and it only ticks on a
    // device that is already misconfigured.
    setRealDate(formatSaDate(serverNowMs()));
    const id = setInterval(() => setRealDate(formatSaDate(serverNowMs())), DATE_REFRESH_MS);
    return () => clearInterval(id);
  }, [offset]);

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
        zIndex: 10000, // above UpdateBanner (9999) — a wrong clock outranks a pending refresh
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
