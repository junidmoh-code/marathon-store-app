// ─── THE CODE LINE — read a number off the screen, go find its twin ──────────
// (Owner spec 2026-08-23: "the count page does not show a product's style code,
// so there is no way to read a code and go find its twin.")
//
// ONE component, rendered on every surface that shows a product the operator is
// physically holding: the count panel, the register panel, the product detail
// page and the leftovers cards. It shows EVERY code the product answers to —
// its own field, its /style_code_index claim, sibling claims, and every code
// alias — and every wording alias filed off a label, because the whole point is
// that whatever is printed on the shoe in your hand should be on the screen.
//
// COPYABLE IN ONE TAP. Each chip is a button; tapping copies that exact string
// and says so for a moment. The clipboard API is unavailable on an insecure
// origin and can be denied, so there is a select-the-text fallback and a
// failure is silent-but-visible ("copy failed") rather than a dead tap.
//
// It reads NOTHING. The codes and aliases arrive as props from
// utils/labelIdentity.identityFor — this file has no store, no fetch and no
// opinion about where the map came from, so it renders identically in a test.

import React, { useEffect, useRef, useState } from "react";
import { formatStyleCodeForDisplay } from "../../utils/styleCode";

const GRAY = "rgba(233,238,255,.5)";

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.contentEditable = "true";
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    // iOS Safari ignores a bare select() on a readonly textarea — it needs the
    // focus and an explicit range, which is why the plain pattern returns false
    // on the very devices this app runs on. The primary navigator.clipboard
    // path works on the HTTPS origin; this is the degraded case, and a visible
    // "copy failed" beats a dead tap either way.
    el.focus();
    el.select();
    if (typeof el.setSelectionRange === "function") el.setSelectionRange(0, text.length);
    const ok = document.execCommand && document.execCommand("copy");
    document.body.removeChild(el);
    return !!ok;
  } catch {
    return false;
  }
}

function Chip({ text, label, tone = "code", disabled }) {
  const [state, setState] = useState(null); // "copied" | "failed"
  // The flash timer is owned, not fired and forgotten: a second tap must reset
  // it (otherwise tap 2's "✓ copied" is cleared early by tap 1's timer), and an
  // unmount must cancel it. These chips sit inside rows that unmount the moment
  // the operator picks the product.
  const timer = useRef(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const tones = {
    code:  { bg: "rgba(74,127,255,.14)", border: "1px solid rgba(74,127,255,.42)", color: "#CFE0FF" },
    alias: { bg: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.16)", color: "rgba(233,238,255,.72)" },
  };
  const t = tones[tone] || tones.code;
  return (
    <button type="button" disabled={disabled}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "copied" : "failed");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { timer.current = null; setState(null); }, 1400);
      }}
      title={`Tap to copy ${text}`}
      style={{ fontSize: 12.5, fontWeight: 800, padding: "0 12px", borderRadius: 9,
               minHeight: 44, fontFamily: "inherit", cursor: disabled ? "default" : "pointer",
               letterSpacing: ".02em", maxWidth: "100%", overflow: "hidden",
               textOverflow: "ellipsis", whiteSpace: "nowrap",
               background: t.bg, border: t.border, color: t.color }}>
      {state === "copied" ? "✓ copied" : state === "failed" ? "copy failed" : (label || text)}
    </button>
  );
}

/**
 * @param {string[]} codes    every code this product answers to (identityFor)
 * @param {string[][]} aliases  every wording-token set filed against it
 * @param {boolean} showAliases  the leftovers/count surfaces show them; a
 *                               cramped row can ask for codes only
 * @param {string} emptyText  what to say when there is no identity at all —
 *                            silence would read as "not loaded yet"
 */
export default function IdentityLine({
  codes = [], aliases = [], showAliases = true, emptyText = "No style code on record",
  disabled = false, compact = false,
}) {
  const hasCodes = codes.length > 0;
  const hasAliases = showAliases && aliases.length > 0;
  if (!hasCodes && !hasAliases) {
    return <div style={{ fontSize: 12, color: GRAY, marginTop: 4 }}>{emptyText}</div>;
  }
  return (
    <div style={{ marginTop: 6 }}>
      {hasCodes && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {!compact && <span style={{ fontSize: 11, color: GRAY, fontWeight: 700 }}>CODE</span>}
          {codes.map((c) => (
            <Chip key={c} text={c} label={formatStyleCodeForDisplay(c) || c} tone="code" disabled={disabled} />
          ))}
        </div>
      )}
      {hasAliases && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 6 }}>
          {!compact && <span style={{ fontSize: 11, color: GRAY, fontWeight: 700 }}>LABEL SAYS</span>}
          {aliases.map((tokens, i) => (
            <Chip key={`a${i}_${tokens.join("_")}`} text={tokens.join(" ")} tone="alias" disabled={disabled} />
          ))}
        </div>
      )}
    </div>
  );
}
