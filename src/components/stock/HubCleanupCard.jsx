// ─── HUB STOCK CLEANUP — THE ONE HOME CARD ────────────────────────────────────
// The merger of the two cards that used to exist: the Display Register tile and
// the Hub Sneaker Count card. One card, one module (HubCleanup), three passes —
// register displays into hub stock, scan-first count, leftovers. Behind the
// same master flag as before: HUB_SNEAKER_COUNT_ENABLED off ⇒ nothing renders.
//
// Reads are tiny and one-shot, same discipline as the old card: the session
// record (count progress) and the register node (registered display units) —
// never /stock.

import React, { useEffect, useState } from "react";
import { CARD, BORDER, GRAY, GREEN, BLUE_L, tabOn, tabOff } from "./ui";
import { CLEANUP_HUBS, CLEANUP_HUB_LABELS } from "./hubCleanupCore";
import { loadCardSummary, rememberHub } from "./hubCountStore";
import { loadRegister } from "./hubCleanupStore";

export default function HubCleanupCard({ onOpen }) {
  const [hub, setHub] = useState(CLEANUP_HUBS[0]);
  const [summary, setSummary] = useState(null);
  const [regUnits, setRegUnits] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([loadCardSummary(hub), loadRegister(hub)])
      .then(([s, reg]) => {
        if (cancelled) return;
        setSummary(s);
        setRegUnits(Object.values(reg || {}).reduce((n, r) => n + (Number(r?.qty) || 0), 0));
      })
      .catch(() => { if (!cancelled) { setSummary(null); setRegUnits(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [hub]);

  const done = summary?.done || 0;
  const total = Math.max(summary?.total || 0, done);
  const complete = total > 0 && done >= total;

  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 14, padding: "12px 13px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 17 }}>👟</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff" }}>Hub Count &amp; Displays</div>
          <div style={{ fontSize: 10.5, color: GRAY }}>Register displays · scan-first count · leftovers</div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 9 }}>
        {CLEANUP_HUBS.map((h) => (
          <button key={h} onClick={() => setHub(h)}
            style={{ ...(hub === h ? tabOn : tabOff), padding: "5px 11px", fontSize: "0.74rem" }}>
            {CLEANUP_HUB_LABELS[h]}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: GRAY, marginBottom: 10, lineHeight: 1.5 }}>
        {loading ? "Checking progress…" : (
          <>
            {regUnits != null && <><strong style={{ color: BLUE_L, fontSize: 13 }}>{regUnits}</strong> display unit{regUnits === 1 ? "" : "s"} registered · </>}
            {total > 0
              ? <><strong style={{ color: complete ? GREEN : BLUE_L, fontSize: 13 }}>{done} of {total}</strong> cells counted</>
              : done > 0 ? <><strong style={{ color: BLUE_L, fontSize: 13 }}>{done}</strong> cells counted</>
              : "count not started"}
          </>
        )}
      </div>

      <button onClick={() => { rememberHub(hub); onOpen(hub); }}
        style={{ ...tabOn, width: "100%", borderRadius: 11, padding: "10px 12px", fontSize: "0.82rem" }}>
        Open →
      </button>
    </div>
  );
}
