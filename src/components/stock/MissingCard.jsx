// ─── MISSING PRODUCTS — THE CARD ──────────────────────────────────────────────
// One card, one shape, for every row of the Missing Products screen (Junid,
// 22 Nov 2026). Read at a glance on an iPhone between two shops:
//
//   a photo big enough to know the shoe · its name · what it is
//   WHY it is on the list, in plain words · how much the source holds
//   the same-name warning, with the other record's photo beside it
//   ONE primary action, and one line saying what it does
//   the quiet actions (move by hand, hide, Concrete-only) as small links
//
// Presentational only: it owns no state and decides nothing. The photo box and
// the action row have fixed sizes, so a card never changes height until its
// own panel is opened.
import React from "react";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, FONT } from "./ui";
import { PrimaryPhoto } from "../shared/PrimaryPhoto.jsx";

const PHOTO = 92;
const photoBox = { width: PHOTO, height: PHOTO, borderRadius: 13, flexShrink: 0, overflow: "hidden", background: "rgba(60,110,255,.1)" };

export function CardPhoto({ product, productId, snapshot, size = PHOTO, onTap }) {
  const live = product || (productId ? { id: productId, photoUrl: snapshot } : null);
  return (
    <div onClick={onTap} style={{ ...photoBox, width: size, height: size, cursor: onTap ? "zoom-in" : "default" }}>
      {live && <PrimaryPhoto product={live} productId={productId ?? live.id} snapshot={snapshot || null} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
    </div>
  );
}

const linkBtn = { background: "none", border: "none", color: "rgba(255,255,255,.5)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "10px 4px", minHeight: 44, fontFamily: FONT, textDecoration: "underline", textUnderlineOffset: 3 };

export const primaryBtn = (tone, disabled) => ({
  width: "100%", minHeight: 50, borderRadius: 13, fontSize: 15.5, fontWeight: 800, fontFamily: FONT,
  cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.4 : 1,
  background: tone === BLUE_L ? "rgba(60,110,255,.16)" : "rgba(74,222,128,.14)",
  border: `1px solid ${tone === BLUE_L ? "rgba(60,110,255,.55)" : "rgba(74,222,128,.5)"}`,
  color: tone,
});

/**
 * primary: { label, onClick, disabled, tone, action } — hidden while a panel is open
 * links:   [{ label, onClick, action }]
 * twin:    { product, productId, name, where } — the same-name record
 */
export default function MissingCard({
  pid, name, product, photo, meta, why, holds, twin, onPhoto, onTwinPhoto,
  primary, explains, blocked, links = [], notice, panelOpen, onClosePanel, children, select,
}) {
  return (
    <div data-card={pid} data-card-name={name} style={{ ...GLASS, marginBottom: 12, overflow: "hidden", fontFamily: FONT }}
      {...(select ? { role: "checkbox", "aria-checked": !!select.on, tabIndex: 0, onClick: select.toggle,
        onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select.toggle(); } } } : null)}>
      <div style={{ display: "flex", gap: 13, padding: "13px 13px 0", alignItems: "flex-start", cursor: select ? "pointer" : "default" }}>
        <CardPhoto product={product} productId={pid} snapshot={photo} onTap={select ? undefined : onPhoto} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15.5, color: "#fff", lineHeight: 1.25, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{name}</div>
          {meta && <div style={{ fontSize: 12, color: GRAY, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta}</div>}
          <div data-why style={{ fontSize: 13, color: "rgba(255,255,255,.85)", lineHeight: 1.35, marginTop: 6 }}>{why}</div>
          <div data-holds style={{ fontSize: 13, color: BLUE_L, fontWeight: 700, marginTop: 3 }}>{holds}</div>
        </div>
        {select && (
          <div aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 15, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16,
            border: select.on ? "1px solid rgba(74,222,128,.6)" : "1px solid rgba(255,255,255,.2)",
            background: select.on ? "rgba(74,222,128,.2)" : "rgba(255,255,255,.03)", color: select.on ? GREEN : "transparent" }}>✓</div>
        )}
      </div>

      {twin && (
        <div data-same-name style={{ display: "flex", gap: 11, alignItems: "center", margin: "11px 13px 0", padding: "9px 10px", borderRadius: 12, background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.4)" }}>
          <CardPhoto product={twin.product} productId={twin.productId} size={64} onTap={onTwinPhoto} />
          <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.4, color: "#fde68a" }}>
            <b style={{ color: AMBER }}>Same name elsewhere.</b> Another record called “{twin.name}” already has stock at {twin.where}. Compare the two photos — only ask for this one if it is a different shoe.
          </div>
        </div>
      )}

      <div style={{ padding: "12px 13px 13px" }}>
        {notice && <div data-notice style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.4, color: notice.ok ? GREEN : RED, marginBottom: 10 }}>{notice.text}</div>}
        {!select && !panelOpen && primary && (
          <>
            <button data-action={primary.action} onClick={primary.onClick} disabled={!!primary.disabled} title={primary.title || undefined} style={primaryBtn(primary.tone || GREEN, primary.disabled)}>{primary.label}</button>
            <div data-explains style={{ fontSize: 12, color: blocked ? AMBER : GRAY, lineHeight: 1.4, marginTop: 7 }}>{blocked || explains}</div>
          </>
        )}
        {!select && !panelOpen && !primary && blocked && <div data-explains style={{ fontSize: 12.5, color: AMBER, lineHeight: 1.4 }}>{blocked}</div>}
        {!select && panelOpen && (
          <>
            {children}
            <button data-action="close-panel" onClick={onClosePanel} style={{ ...linkBtn, display: "block", margin: "6px auto 0" }}>Cancel</button>
          </>
        )}
        {!select && !panelOpen && links.length > 0 && (
          <div style={{ display: "flex", gap: "0 16px", flexWrap: "wrap", marginTop: 2 }}>
            {links.map((l) => <button key={l.action} data-action={l.action} onClick={l.onClick} disabled={!!l.disabled} title={l.title || undefined} style={linkBtn}>{l.label}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}
