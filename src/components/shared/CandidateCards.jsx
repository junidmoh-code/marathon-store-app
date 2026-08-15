// ─── CANDIDATE CARDS — the ONE "is it one of these?" list ────────────────────
// Lifted VERBATIM out of StyleCodeGate.jsx (where it was `SimilarCards`, owner
// spec 2026-08-13) so the COUNT flow renders the identical thing the admin
// intake gate does, instead of growing a second implementation of the same
// question. Admin's markup is unchanged — the two additive props below default
// to exactly the values StyleCodeGate passed implicitly, and a render test pins
// that.
//
// The row is deliberately photo-first: the operator is holding the shoe, and a
// photo is the only evidence they can actually check. Name second, the matched
// code third, and `reasons` last — that line is what tells them WHY this row is
// here, including which of a multi-token label's numbers found it
// ("… (via the label's other token A8425)", utils/linkSuggestions.js).
//
// A row is a BUTTON and nothing else. This component never writes, never
// links, never decides — the tap goes back to the caller, which owns the
// filing (recordLabelCodes / addLabelAlias in the count, ADD STOCK in intake).
//
// `suggestions` rows are the buildLinkSuggestions shape:
//   { product, code, field: "confirmed"|"pending"|null, reasons: [string] }

import { formatStyleCodeForDisplay } from "../../utils/styleCode";

const BLUE = "#4A7FFF";
const meta = { fontSize: 12, color: "rgba(233,238,255,.45)", lineHeight: 1.5 };

// `highlightId` outlines ONE row — the count's colour-affinity leader keeps the
// visual mark it had before this renderer was shared. Null (admin) renders the
// original border on every row.
export default function CandidateCards({
  suggestions,
  onPick,
  limit = 6,
  photoSize = 84,
  cta = "ADD STOCK →",
  highlightId = null,
  disabled = false,
}) {
  return (
    <>
      {suggestions.slice(0, limit).map((s) => (
        <div key={s.product.id}
          onClick={disabled ? undefined : () => onPick(s.product)}
          role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
          onKeyDown={disabled ? undefined : (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(s.product); } }}
          style={{ display: "flex", gap: 14, alignItems: "center", background: "rgba(255,255,255,.03)",
                   border: highlightId && s.product.id === highlightId
                     ? `2px solid ${BLUE}` : "1px solid rgba(120,150,255,.16)",
                   borderRadius: 14, padding: 12, cursor: disabled ? "not-allowed" : "pointer",
                   ...(disabled ? { opacity: 0.5 } : null) }}>
          <div style={{ width: photoSize, height: photoSize, flexShrink: 0, borderRadius: 12, overflow: "hidden",
                        background: "rgba(255,255,255,.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {s.product.photoUrl
              ? <img src={s.product.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span style={{ ...meta, fontSize: 9 }}>NO IMAGE</span>}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15.5, fontWeight: 750, color: "#fff", lineHeight: 1.25 }}>{s.product.name || "Unnamed product"}</div>
            {s.code && (
              <div style={{ ...meta, marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
                {formatStyleCodeForDisplay(s.code)}{s.field === "pending" ? " (pending)" : ""}
              </div>
            )}
            <div style={{ ...meta, marginTop: 4, color: "#AFC6FF" }}>{s.reasons.join(" · ")}</div>
          </div>
          <span style={{ ...meta, color: BLUE, fontWeight: 800, flexShrink: 0 }}>{cta}</span>
        </div>
      ))}
    </>
  );
}
