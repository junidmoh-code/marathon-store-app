// ─── TV SPECIALS RAIL ─────────────────────────────────────────────────────────
// Advertising band for the customer pickup TV: shows the ACTIVE specials from
// the /specials node (the cross-app contract written by the pricing tab —
// see src/utils/specials.js for the record shape). The band replaces the
// decorative shoe conveyor in TvDisplayMockup whenever at least one special
// is running; with none it renders NOTHING and the board looks exactly as it
// always has (the clean empty state).
//
// Bandwidth: /specials holds one compact (~0.5 KB) record per ACTIVE special
// and is deleted-at-end, so subscribing to the WHOLE node is the intended,
// measured-cheap contract (specials.js: "its size IS the bandwidth bill").
// This module subscribes to /specials and NOTHING else. Photos ride the
// product photoUrl (Storage, 1-year immutable cache) — fetched once per
// special, then served from the browser cache.
//
// The TV session is ANONYMOUS. Live rule verified 2026-08-13:
//   /specials .read = "auth != null"  → anonymous reads allowed.
// The read still FAILS OPEN: any error logs, clears the rail (board reverts
// to the plain conveyor) and retries a minute later — an unreadable ads node
// must never take down the pickup board.

import { useEffect, useRef, useState } from "react";
import { onValue, ref } from "firebase/database";
import { database } from "../firebase";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const BAND_H = 160;          // must equal the ShoeConveyor band it replaces
const SLOT_W = 430;          // px per special card, incl. breathing room
const SCROLL_SPEED = 0.5;    // px per frame at 60fps when the rail overflows
const RETRY_MS = 60_000;

export function useSpecials() {
  const [specials, setSpecials] = useState([]);
  const [gen, setGen] = useState(0); // bumps to re-subscribe after a failed read
  useEffect(() => {
    let retry = null;
    const unsub = onValue(ref(database, "specials"), (snap) => {
      const v = snap.val() || {};
      setSpecials(
        Object.entries(v)
          .filter(([, s]) => s && typeof s === "object")
          .map(([id, s]) => ({ id, ...s }))
          .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
      );
    }, (err) => {
      // FAIL OPEN: ads are optional — log, show no rail, retry in a minute
      // (also heals the cancelled-listen case if auth raced the subscribe).
      console.warn("Firebase read error on /specials — TV specials rail stays off:", err);
      setSpecials([]);
      retry = setTimeout(() => setGen((g) => g + 1), RETRY_MS);
    });
    return () => { unsub(); if (retry) clearTimeout(retry); };
  }, [gen]);
  return specials;
}

const fmtR = (n) =>
  "R" + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function SpecialCard({ s }) {
  return (
    <div style={{
      width: SLOT_W - 30, flexShrink: 0, height: BAND_H - 20, margin: "0 15px",
      display: "flex", alignItems: "center", gap: 16,
      background: "rgba(14,20,33,0.9)", border: "1px solid rgba(239,68,68,0.35)",
      borderRadius: 14, padding: "0 18px", boxSizing: "border-box",
      boxShadow: "0 0 22px rgba(239,68,68,0.18)", overflow: "hidden",
    }}>
      {s.photoUrl ? (
        <img src={s.photoUrl} alt={s.name}
             onError={(e) => { e.currentTarget.style.display = "none"; }}
             style={{ height: BAND_H - 44, width: BAND_H - 44, objectFit: "contain", flexShrink: 0,
                      filter: "drop-shadow(0 6px 16px rgba(0,0,0,0.6))" }} />
      ) : null}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{
          alignSelf: "flex-start", background: "#EF4444", color: "#fff",
          fontSize: 11, fontWeight: 900, letterSpacing: 1.6, padding: "2px 9px", borderRadius: 4,
        }}>SPECIAL</span>
        <span style={{
          color: "#fff", fontSize: 19, fontWeight: 700, lineHeight: 1.15,
          overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>{s.name || ""}</span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ color: "#22C55E", fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>
            {fmtR(s.price)}
          </span>
          {typeof s.wasPrice === "number" && (
            <span style={{ color: "#64748B", fontSize: 17, fontWeight: 600, textDecoration: "line-through" }}>
              {fmtR(s.wasPrice)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export default function TvSpecialsRail({ specials }) {
  const containerRef = useRef(null);
  const stripRef = useRef(null);
  // 0 → rail fits on screen: render it static and centred (a marquee of one
  // card looks broken). >0 → number of duplicated sets for a seamless loop.
  const [copies, setCopies] = useState(0);
  const count = specials?.length || 0;
  const base = count * SLOT_W;

  useEffect(() => {
    if (!count) return;
    const W = containerRef.current?.offsetWidth
      || (typeof window !== "undefined" ? window.innerWidth : 1920);
    setCopies(base <= W ? 0 : Math.max(2, Math.ceil((2 * W) / base) + 1));
  }, [count, base]);

  useEffect(() => {
    if (!copies) return; // static rail — nothing to animate
    const el = stripRef.current;
    if (!el) return;
    let pos = 0, raf;
    const tick = () => {
      pos -= SCROLL_SPEED;
      if (pos <= -base) pos += base; // keep the sub-pixel fraction — no jump
      el.style.transform = `translateX(${pos}px)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Drop the imperative offset: when the rail goes back to static (fewer
      // specials now fit), the strip must not stay shifted off-screen.
      el.style.transform = "";
    };
  }, [copies, base]);

  if (!count) return null; // clean empty state — caller falls back to the conveyor

  const list = copies
    ? Array.from({ length: copies * count }, (_, i) => specials[i % count])
    : specials;

  return (
    <div ref={containerRef} style={{
      width: "100%", height: BAND_H, flexShrink: 0, overflow: "hidden",
      display: "flex", alignItems: "center", fontFamily: FONT,
      justifyContent: copies ? "flex-start" : "center",
    }}>
      <div ref={stripRef} style={{ display: "flex", flexShrink: 0, alignItems: "center",
                                   willChange: copies ? "transform" : undefined }}>
        {list.map((s, i) => <SpecialCard key={`${s.id}-${i}`} s={s} />)}
      </div>
    </div>
  );
}
