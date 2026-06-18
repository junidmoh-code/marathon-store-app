// ─── BARCODE (visual) ─────────────────────────────────────────────────────────
// Renders a Code 128 barcode as crisp SVG from a stored code value, with the
// human-readable code beneath. Pure presentational — no Firebase. Used in the
// print preview; also the on-screen fallback a scanner can read directly if a
// printer is unavailable.

import React from "react";
import { code128Modules, code128Width } from "./barcode";

export default function Barcode({ value, height = 56, moduleWidth = 2, showText = true, background = "#fff" }) {
  if (!value) return null;
  let modules, totalModules;
  try {
    modules = code128Modules(value);
    totalModules = code128Width(value);
  } catch {
    return <div style={{ color: "#F87171", fontSize: 11 }}>Invalid code</div>;
  }

  const quiet = 10;                                   // quiet zone (modules) each side
  const widthModules = totalModules + quiet * 2;
  const w = widthModules * moduleWidth;
  const textH = showText ? 14 : 0;

  // Build bar rects, advancing x by each module width; only "bar" runs are drawn.
  let x = quiet;
  const rects = [];
  modules.forEach((m, i) => {
    if (m.bar) rects.push(<rect key={i} x={x * moduleWidth} y={0} width={m.width * moduleWidth} height={height} fill="#000" />);
    x += m.width;
  });

  return (
    <div style={{ background, padding: "6px 8px", borderRadius: 8, display: "inline-block" }}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" shapeRendering="crispEdges">
        {rects}
      </svg>
      {showText && (
        <div style={{ fontFamily: "monospace", fontSize: 12, letterSpacing: 2, textAlign: "center", color: "#000", height: textH, lineHeight: `${textH}px` }}>
          {value}
        </div>
      )}
    </div>
  );
}
