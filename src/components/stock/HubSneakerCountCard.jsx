// ─── HUB SNEAKER COUNT — TEMPORARY HOME CARD ──────────────────────────────────
// The way in to the count, and the only thing this feature adds to the home
// screen. Behind the SAME master flag as the view: flip
// HUB_SNEAKER_COUNT_ENABLED to false and this renders nothing at all.
//
// ── WHY THE CARD DOES NOT READ /stock ────────────────────────────────────────
// Progress is "N of M size cells counted", and M is a property of the hub's
// stock node — which is 1,971 products at hub 2. Reading that on the HOME screen,
// for every admin, on every app open, to render one line of text would be absurd.
//
// So the count view publishes M into the tiny session record when it loads
// (publishSessionTotal), and this card reads only:
//     /settings/hubSneakerCount/sessions/{hub}      (one small object)
//     /settings/hubSneakerCount/counted/{hub}/{id}  (the recorded cells)
// Both one-shot, no onValue — same rule as the rest of the feature. Before the
// view has ever been opened for a hub there is no M yet, and the card says so
// rather than inventing a number.

import React, { useEffect, useMemo, useState } from "react";
import { CARD, BORDER, GRAY, GREEN, BLUE_L, tabOn, tabOff } from "./ui";
import { hubOptions } from "./hubCountCore";
import { loadCardSummary, rememberHub, useLocationRegistryOnce } from "./hubCountStore";
import { labelFor } from "./locations";

export default function HubSneakerCountCard({ onOpen }) {
  // Read once, not subscribed — see useLocationRegistryOnce. Until it resolves,
  // hubOptions falls back to the DEFAULT_LOCATIONS seed, so the picker is never
  // empty on first paint.
  const registry = useLocationRegistryOnce();
  // Memoised: hubOptions builds a new array every call, which would make the
  // effect below re-run (and re-fetch) on every render.
  const hubs = useMemo(() => hubOptions(registry), [registry]);
  const [hub, setHub] = useState(hubs[0]?.id || "");
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  // Keep the selection valid once the LIVE registry replaces the fallback seed.
  // Not just "fill an empty selection": a seeded id that the real registry does
  // not contain would otherwise stay selected and load a hub that isn't there.
  useEffect(() => {
    if (!hubs.length) return;
    if (!hub || !hubs.some((h) => h.id === hub)) setHub(hubs[0].id);
  }, [hub, hubs]);

  useEffect(() => {
    if (!hub) return;
    let cancelled = false;
    setLoading(true);
    loadCardSummary(hub)
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch(() => { if (!cancelled) setSummary(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [hub]);

  const done = summary?.done || 0;
  // The published total is the hub's OWN cell count. A counter can also add a
  // product that has no cell here, and those extra cells are recorded too — so
  // `done` can legitimately exceed it. Widen the denominator rather than print
  // "12 of 10", which reads as a bug.
  const total = Math.max(summary?.total || 0, done);
  const complete = total > 0 && done >= total;

  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 14, padding: "12px 13px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 17 }}>👟</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff" }}>Hub Sneaker Count</div>
          <div style={{ fontSize: 10.5, color: GRAY }}>Temporary stock-take</div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 9 }}>
        {hubs.map((h) => (
          <button key={h.id} onClick={() => setHub(h.id)}
            style={{ ...(hub === h.id ? tabOn : tabOff), padding: "5px 11px", fontSize: "0.74rem" }}>
            {h.label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: GRAY, marginBottom: 10 }}>
        {loading ? "Checking progress…"
          : total > 0 ? (
            <>
              <strong style={{ color: complete ? GREEN : BLUE_L, fontSize: 13 }}>{done} of {total}</strong>
              {" "}size cells counted at {labelFor(hub, registry)}
            </>
          ) : done > 0 ? (
            <><strong style={{ color: BLUE_L, fontSize: 13 }}>{done}</strong> cells counted at {labelFor(hub, registry)}</>
          ) : "Not started at this hub."}
      </div>

      <button onClick={() => { rememberHub(hub); onOpen(hub); }}
        style={{ ...tabOn, width: "100%", borderRadius: 11, padding: "10px 12px", fontSize: "0.82rem" }}>
        Open count →
      </button>
    </div>
  );
}
