// ─── ORDER LINES PANEL — the desktop order screen's cart list + Place order ──
//
// Lifted out of App.jsx's AssistantDesktop drawer (2026-10-19) so the classic
// layout's fixed drawer and the sneaker wall's slide-in drawer render the SAME
// lines, the same −/+ steppers and the same Place order button. Styling comes
// from the .ad-* rules AssistantDesktop's <style> block defines; both hosts
// render inside that root.

import { formatSize } from "../../utils/sizeLabel";
import { fmtR } from "./assistantOrderModel";

export default function OrderLinesPanel({ grouped, units, onRemoveOne, onQuickAdd, onAddDisplayPartner, onCheckout,
                                          emptyHint = "Hover a product and tap a size." }) {
  return (
    <>
      <div className="ad-dlist">
        {grouped.length === 0 ? (
          <div className="ad-empty">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: .5, marginBottom: 10 }}><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>
            <div style={{ fontWeight: 600 }}>Order is empty</div>
            <div style={{ marginTop: 4, fontSize: 11 }}>{emptyHint}</div>
          </div>
        ) : grouped.map(g => (
          <div key={g.key} className="ad-line">
            <div className="ad-li">{g.product?.photoUrl ? <img src={g.product.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (g.product?.photo || "👟")}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ad-ln">{g.product?.name}</div>
              <div className="ad-lm">
                {g.dp
                  ? <span style={{ color: "#9DBCFF" }}>Display Partner{g.size ? ` · Sz ${formatSize(g.size)}` : ""}</span>
                  : `Size ${g.size === "Free Size" ? "OS" : formatSize(g.size)} · ${typeof g.product?.retailPrice === "number" ? fmtR(g.product.retailPrice) : "—"}`}
              </div>
              <div className="ad-step">
                <button onClick={() => onRemoveOne(g.product.id, g.size, g.dp, g.pull)}>−</button>
                <span>{g.qty}</span>
                {/* A pull is ONE known unit — there is no "+" for it. */}
                {g.pull
                  ? <button disabled title="The display pair is a single known unit" style={{ opacity:.3, cursor:"not-allowed" }}>+</button>
                  : <button onClick={() => g.dp ? onAddDisplayPartner(g.product, g.size) : onQuickAdd(g.product, g.size, 1)}>+</button>}
              </div>
            </div>
            <div className="ad-lp">{g.dp ? "—" : (typeof g.product?.retailPrice === "number" ? fmtR(g.product.retailPrice * g.qty) : "—")}</div>
          </div>
        ))}
      </div>
      <div className="ad-dfoot">
        {/* Ordering system, not POS — no money total. */}
        <div className="ad-trow"><span>{units} item{units !== 1 ? "s" : ""}</span><span>{grouped.length} line{grouped.length !== 1 ? "s" : ""}</span></div>
        <button className="ad-place" disabled={!units} onClick={onCheckout}>Place order</button>
      </div>
    </>
  );
}
