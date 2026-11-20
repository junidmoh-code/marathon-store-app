// ─── ACTIVE STORE LAYER — the switch confirmation + the "working away" banner ─
// Mounted once by AuthGate around the whole signed-in app, so EVERY screen gets
// the same banner and the same modal (src/utils/activeStore.js holds the state).
//
//   • Modal: full screen, warning colour, large text. Only "Yes, switch to X"
//     commits; Cancel or a tap on the backdrop leaves everything as it was.
//   • Banner: while the active shop is not the home shop, a sticky bar across
//     the top of every screen — "Working in X (your store: Y)" — with a one-tap
//     "Back to Y" that needs no confirmation.
//   • A one-minute timer sends an away choice home at SA midnight.
import { useEffect, useRef } from "react";
import {
  useActiveStore, confirmSwitch, cancelSwitch, backToHome, checkDayRollover, isAwayFromHome,
} from "../utils/activeStore";
import { shopLabelOf } from "../utils/stores";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const WARN = "#ff9f0a";
const WARN_DEEP = "#ff6b00";

export const storeName = (id) => (id ? String(shopLabelOf(id) || id).toUpperCase() : "—");

export function SwitchStoreModal({ from, to, onConfirm, onCancel }) {
  const fromName = storeName(from);
  const toName = storeName(to);
  // Focus: into the dialog on open (Cancel — the safe default), Tab stays
  // inside, Escape cancels, and focus goes back to whatever opened it.
  const cardRef = useRef(null);
  const cancelRef = useRef(null);
  useEffect(() => {
    const opener = typeof document !== "undefined" ? document.activeElement : null;
    try { cancelRef.current?.focus?.(); } catch { /* no DOM focus (tests) */ }
    return () => { try { opener?.focus?.(); } catch { /* opener gone */ } };
  }, []);
  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault?.(); onCancel(); return; }
    if (e.key !== "Tab") return;
    const nodes = cardRef.current?.querySelectorAll?.("button");
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="Switching store" data-testid="store-switch-modal"
         onClick={onCancel} onKeyDown={onKeyDown}
         style={{ position: "fixed", inset: 0, zIndex: 100000, background: "rgba(0,0,0,.92)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: FONT }}>
      <div ref={cardRef} onClick={(e) => e.stopPropagation()}
           style={{ width: "100%", maxWidth: 560, boxSizing: "border-box", borderRadius: 22, padding: "30px 26px 24px",
                    background: "linear-gradient(180deg, rgba(255,159,10,.16), rgba(255,107,0,.06))",
                    border: `2px solid ${WARN}`, boxShadow: `0 0 40px rgba(255,159,10,.25)`, color: "#fff", textAlign: "center" }}>
        <div style={{ fontSize: 46, lineHeight: 1 }}>⚠️</div>
        <div style={{ marginTop: 14, fontSize: 32, fontWeight: 850, letterSpacing: "-0.01em", color: WARN }}>Switching store</div>
        <div style={{ marginTop: 16, fontSize: 21, fontWeight: 650, lineHeight: 1.4 }}>
          You are leaving <b style={{ color: "#fff" }}>{fromName}</b> and working in <b style={{ color: WARN }}>{toName}</b>.
        </div>
        <div style={{ marginTop: 12, fontSize: 19, lineHeight: 1.45, color: "rgba(255,255,255,.85)" }}>
          Everything you pick, check, hand over or order will count for <b style={{ color: WARN }}>{toName}</b>.
        </div>
        <button type="button" onClick={onConfirm} data-testid="store-switch-confirm"
                style={{ marginTop: 26, width: "100%", minHeight: 64, borderRadius: 16, border: "none", cursor: "pointer",
                         background: `linear-gradient(180deg, ${WARN}, ${WARN_DEEP})`, color: "#000",
                         fontFamily: FONT, fontSize: 21, fontWeight: 850 }}>
          Yes, switch to {toName}
        </button>
        <button type="button" ref={cancelRef} onClick={onCancel} data-testid="store-switch-cancel"
                style={{ marginTop: 12, width: "100%", minHeight: 52, borderRadius: 14, cursor: "pointer",
                         background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.2)", color: "#fff",
                         fontFamily: FONT, fontSize: 17, fontWeight: 700 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AwayBanner({ active, home, onBack }) {
  const homeName = storeName(home);
  return (
    <div role="status" data-testid="store-away-banner"
         style={{ position: "sticky", top: 0, zIndex: 99990, display: "flex", alignItems: "center", justifyContent: "center",
                  gap: 12, flexWrap: "wrap", padding: "9px 14px", fontFamily: FONT,
                  background: `linear-gradient(90deg, ${WARN_DEEP}, ${WARN})`, color: "#000",
                  boxShadow: "0 2px 14px rgba(255,107,0,.45)" }}>
      <span style={{ fontSize: 15, fontWeight: 850, letterSpacing: "0.01em" }}>
        Working in {storeName(active)} <span style={{ fontWeight: 650 }}>(your store: {homeName})</span>
      </span>
      <button type="button" onClick={onBack} data-testid="store-back-home"
              style={{ minHeight: 34, padding: "6px 14px", borderRadius: 999, cursor: "pointer", border: "2px solid #000",
                       background: "#000", color: WARN, fontFamily: FONT, fontSize: 13.5, fontWeight: 850 }}>
        Back to {homeName}
      </button>
    </div>
  );
}

export default function ActiveStoreLayer({ children }) {
  const s = useActiveStore();
  useEffect(() => {
    checkDayRollover();
    const t = setInterval(checkDayRollover, 60 * 1000);
    const onVis = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") checkDayRollover(); };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis); };
  }, []);
  return (
    <>
      {isAwayFromHome(s) && <AwayBanner active={s.activeShop} home={s.homeShop} onBack={backToHome} />}
      {children}
      {s.pending && <SwitchStoreModal from={s.activeShop} to={s.pending} onConfirm={confirmSwitch} onCancel={cancelSwitch} />}
    </>
  );
}
