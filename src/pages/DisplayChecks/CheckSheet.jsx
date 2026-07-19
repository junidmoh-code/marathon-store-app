// ─── DISPLAY CHECKS — CONFIRM SHEET (PR 7, the write path) ────────────────────
// The bottom sheet a staff member gets when they tap "Check Display" on an
// outstanding card. Two results, NO PIN (the server stamps the logged-in user):
//   • Display Confirmed   → result "confirmed"
//   • No Stock Available  → result "no_stock"
// Both call the server-authoritative completeDisplayCheck callable — the client
// never writes the completion itself. If a no-stock close is contradicted by
// inventory (stock > 0), the server SOFT-BLOCKS it and returns needsOverride;
// the sheet replaces its body in place with the contradiction ("inventory shows
// N × size — check the shelf again") and only re-calls with override:true if the
// staff member insists ("Still not there"). The number is the voice (§8.7).
//
// On success the sheet closes; the feed's live listener moves the card out of
// Outstanding into Completed on its own — nothing to refetch.

import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { FONT, MONO, BLUE, AMBER, INK, PANEL, META } from "./tokens";
import { formatSaTime } from "./feedModel";

const completeDisplayCheck = httpsCallable(functions, "completeDisplayCheck");
const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function CheckSheet({ store, check, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [override, setOverride] = useState(null); // { stockQty } when soft-blocked

  // Real modal semantics (a11y): trap Tab inside the sheet, close on Escape, and
  // restore focus to the trigger on unmount — otherwise keyboard users can reach
  // and activate the background feed while the sheet is open (CodeRabbit).
  const sheetRef = useRef(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const prev = typeof document !== "undefined" ? document.activeElement : null;
    const el = sheetRef.current;
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); if (!busyRef.current) onCloseRef.current(); return; }
      if (e.key !== "Tab" || !el) return;
      const f = Array.from(el.querySelectorAll(FOCUSABLE));
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    el && el.addEventListener("keydown", onKey);
    return () => { el && el.removeEventListener("keydown", onKey); prev && prev.focus && prev.focus(); };
  }, []);
  // Pull focus into the sheet on open and whenever the panel swaps (two buttons
  // ↔ the override warning), so focus never falls back to the background.
  useEffect(() => {
    const el = sheetRef.current;
    const target = (el && el.querySelector(FOCUSABLE)) || el;
    target && target.focus && target.focus();
  }, [override]);

  const name = check.productName || "Unknown";
  const size = check.size && check.size !== "_" ? String(check.size) : null;
  const soldAt = formatSaTime(check.lastSoldAt || check.firstSoldAt || check.createdAt);

  async function complete(result, force) {
    setBusy(true); setError(null);
    try {
      const res = await completeDisplayCheck({
        store, key: check.key, checkId: check.checkId, result, override: force === true,
      });
      const data = res && res.data;
      if (data && data.needsOverride) {
        // Server contradicted the no-stock claim — surface it, don't close.
        setOverride({ stockQty: Number(data.stockQty) || 0 });
        setBusy(false);
        return;
      }
      onClose(); // committed — the live feed will reflect it
    } catch (err) {
      setError((err && (err.message || err.code)) || "Couldn't save. Try again.");
      setBusy(false);
    }
  }

  const btn = (bg, color) => ({
    fontFamily: FONT, fontSize: 16, fontWeight: 750, width: "100%", padding: "16px 14px",
    borderRadius: 14, minHeight: 56, cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.6 : 1, color, background: bg, border: "none",
  });

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.6)",
               display: "flex", alignItems: "flex-end", justifyContent: "center",
               backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)" }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Complete display check: ${name}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ ...PANEL, background: "rgba(14,16,22,.94)", width: "100%", maxWidth: 520,
                 borderRadius: "20px 20px 0 0", padding: 20, display: "flex",
                 flexDirection: "column", gap: 16, maxHeight: "88vh", overflowY: "auto", outline: "none" }}
      >
        {/* Header: product identity */}
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <div style={{ width: 72, height: 72, flexShrink: 0, borderRadius: 12, overflow: "hidden",
                        background: "rgba(255,255,255,.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {check.photoUrl
              ? <img src={check.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span style={{ ...META, fontSize: 9 }}>NO IMAGE</span>}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: FONT, fontSize: 17, fontWeight: 720, color: INK, lineHeight: 1.2 }}>{name}</div>
            <div style={{ ...META, fontSize: 11, marginTop: 4, display: "flex", gap: 10 }}>
              {size && <span style={{ fontFamily: MONO }}>{size}</span>}
              {soldAt && <span>SOLD {soldAt}</span>}
            </div>
          </div>
        </div>

        {error && (
          <div style={{ ...META, color: AMBER, fontSize: 11, letterSpacing: "0.08em" }}>{String(error).toUpperCase()}</div>
        )}

        {override ? (
          // ── Soft-block: the system contradicts the no-stock claim, calmly ──
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ border: `1px solid ${AMBER}`, borderRadius: 14, padding: "16px 16px",
                          background: "rgba(232,165,74,.08)" }}>
              <div style={{ ...META, color: AMBER, fontSize: 12, letterSpacing: "0.1em" }}>INVENTORY SHOWS {override.stockQty} × {size || "—"}</div>
              <div style={{ fontFamily: FONT, fontSize: 15, color: INK, marginTop: 6 }}>Check the shelf again.</div>
            </div>
            <button type="button" disabled={busy} onClick={() => setOverride(null)} style={btn(BLUE, "#04102e")}>
              Check again
            </button>
            <button type="button" disabled={busy} onClick={() => complete("no_stock", true)}
                    style={{ ...META, fontSize: 12, letterSpacing: "0.1em", background: "none",
                             border: "none", color: "rgba(233,238,255,.5)", cursor: busy ? "default" : "pointer",
                             padding: "6px", textDecoration: "underline" }}>
              Still not there — record no stock
            </button>
          </div>
        ) : (
          // ── The two results ──
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button type="button" disabled={busy} onClick={() => complete("confirmed")} style={btn(BLUE, "#04102e")}>
              Display Confirmed
            </button>
            <button type="button" disabled={busy} onClick={() => complete("no_stock")}
                    style={btn("rgba(255,255,255,.06)", INK)}>
              No Stock Available
            </button>
            <button type="button" disabled={busy} onClick={onClose}
                    style={{ ...META, fontSize: 11, background: "none", border: "none",
                             color: "rgba(233,238,255,.4)", cursor: busy ? "default" : "pointer", padding: "8px" }}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
