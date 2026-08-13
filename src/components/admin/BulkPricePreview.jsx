// ─── BULK PRICE PREVIEW — THE CONFIRM GATE ───────────────────────────────────
// Every bulk price write shows THIS modal first: exactly which products change,
// each one's current values and new values, the count, and — honestly — which
// selected products will NOT change and why (already priced / missing the
// price / already at the target). The operator's Apply writes the previewed
// plan verbatim; Cancel writes nothing. The skip-vs-overwrite choice for
// already-priced products lives here too, defaulting to skip.

const fmt = (v) => (typeof v === "number" ? `R${v.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : "—");

const S = {
  backdrop: { position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 16 },
  sheet: { background: "#111", border: "1px solid rgba(255,255,255,.15)", borderRadius: 14, padding: 18, maxWidth: 560, width: "100%", maxHeight: "86vh", display: "flex", flexDirection: "column" },
  title: { fontSize: 15, fontWeight: 800, color: "#fff" },
  sub: { fontSize: 12, color: "rgba(255,255,255,.5)", marginTop: 3 },
  list: { overflowY: "auto", margin: "12px 0", display: "flex", flexDirection: "column", gap: 5, flex: 1, minHeight: 0 },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 9, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)" },
  name: { flex: 1, minWidth: 0, fontSize: 12.5, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  cell: { fontSize: 11.5, fontVariantNumeric: "tabular-nums", textAlign: "right", minWidth: 106 },
  warn: { background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.3)", borderRadius: 9, padding: "8px 10px", fontSize: 11.5, color: "#FBBF24", marginTop: 8 },
  btn: (primary, disabled) => ({ flex: 1, background: disabled ? "rgba(255,255,255,.06)" : primary ? "#4A7FFF" : "rgba(255,255,255,.07)", color: disabled ? "rgba(255,255,255,.3)" : "#fff", border: "1px solid " + (primary && !disabled ? "#4A7FFF" : "rgba(255,255,255,.14)"), borderRadius: 10, padding: "11px 12px", fontSize: 13, fontWeight: 700, cursor: disabled ? "default" : "pointer" }),
};

// to === undefined ⇒ this field is untouched (hidden). to === null ⇒ the
// field WILL be cleared ("not set") and renders as an explicit —.
function Delta({ label, from, to }) {
  if (to === undefined) return null;
  return (
    <div style={S.cell}>
      <span style={{ color: "rgba(255,255,255,.35)", fontSize: 10, marginRight: 5 }}>{label}</span>
      <span style={{ color: "rgba(255,255,255,.55)", textDecoration: "line-through" }}>{fmt(from)}</span>
      <span style={{ color: "rgba(255,255,255,.35)" }}> → </span>
      <span style={{ color: "#4ACA7A", fontWeight: 700 }}>{fmt(to)}</span>
    </div>
  );
}

export default function BulkPricePreview({ title, subtitle, plan, busy = false,
                                           overwrite = null, onOverwriteChange = null,
                                           confirmLabel = "Apply", onConfirm, onCancel }) {
  if (!plan) return null;
  const rows = plan.rows || [];
  const skipped = plan.skippedAlready || [];
  const missing = plan.missingPrice || [];
  const noop = plan.noop || [];
  const nothing = rows.length === 0;
  return (
    <div style={S.backdrop} onClick={busy ? undefined : onCancel}>
      <div style={S.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.title}>{title}</div>
        <div style={S.sub}>
          {subtitle ? <>{subtitle} · </> : null}
          <b style={{ color: "#fff" }}>{rows.length}</b> product{rows.length === 1 ? "" : "s"} will change
          {skipped.length > 0 && <> · {skipped.length} kept as is</>}
          {missing.length > 0 && <> · {missing.length} missing a price</>}
          {noop.length > 0 && <> · {noop.length} already there</>}
        </div>

        <div style={S.list}>
          {rows.map((r) => (
            <div key={r.pid} style={S.row}>
              {r.photoUrl ? <img src={r.photoUrl} alt="" loading="lazy" style={{ width: 30, height: 30, borderRadius: 6, objectFit: "cover", background: "rgba(255,255,255,.08)", flexShrink: 0 }} /> : null}
              <div style={S.name}>{r.name}{(r.badge || r.overwrites) ? <span style={{ color: "#FBBF24", fontSize: 10, marginLeft: 6 }}>{r.badge || "overwrites"}</span> : null}</div>
              <Delta label="Stock" from={r.fromStock} to={r.toStock} />
              <Delta label="Retail" from={r.fromRetail} to={r.toRetail} />
            </div>
          ))}
          {nothing && <div style={{ textAlign: "center", padding: "26px 0", fontSize: 12.5, color: "rgba(255,255,255,.45)" }}>Nothing to write with the current choice.</div>}
        </div>

        {skipped.length > 0 && (
          <div style={S.warn}>
            {skipped.length} selected product{skipped.length === 1 ? " already has" : "s already have"} a price and will be kept as is
            {onOverwriteChange && (
              <label style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 7, cursor: "pointer", color: "#fff" }}>
                <input type="checkbox" checked={overwrite === true} onChange={(e) => onOverwriteChange(e.target.checked)} disabled={busy} />
                Overwrite existing prices with the entered values
              </label>
            )}
          </div>
        )}
        {missing.length > 0 && (
          <div style={S.warn}>
            No price to change on: {missing.slice(0, 5).map((m) => m.name).join(", ")}{missing.length > 5 ? ` +${missing.length - 5} more` : ""} — a percentage can only move an existing price. Use Missing Prices to set one first.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={S.btn(false, busy)} disabled={busy} onClick={onCancel}>Cancel</button>
          <button style={S.btn(true, busy || nothing)} disabled={busy || nothing} onClick={onConfirm}>
            {busy ? "Writing…" : `${confirmLabel} · ${rows.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
