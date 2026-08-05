// ─── THE STYLE-CODE BYPASS — DELIBERATE, AND COUNTABLE ───────────────────────
// Some footwear genuinely has no manufacturer style code: designer, unbranded,
// handmade. Those products can never satisfy the gate, so a bypass has to exist
// or the gate becomes a wall.
//
// ── WHY IT IS NOT A THIRD BUTTON ─────────────────────────────────────────────
// A bypass sitting as an equal option beside "scan" and "type it" becomes the
// default path inside a week — it is the one that never fails — and we are back
// to duplicates, with extra steps. So it is a subordinate text link, it costs
// more taps than doing the job properly, and it asks two questions.
//
// ── THE DUPLICATE CHECK IS NOT A FORMALITY ───────────────────────────────────
// An exempt product gets NO /style_code_index claim. The name search on this
// screen is therefore the ONLY duplicate protection it will EVER have — not the
// first line, the only line. Skipping it does not defer the problem, it removes
// it permanently. Hence: the results must have come back, and they must belong
// to the name actually being submitted.

import { useEffect, useMemo, useState } from "react";
import { EXEMPT_REASONS, EXEMPT_REASON_KEYS } from "../../config/styleCode";
import {
  bypassReadiness, BYPASS_READY, BYPASS_NEEDS_NAME,
  BYPASS_NEEDS_DUPLICATE_CHECK, BYPASS_NEEDS_REASON,
} from "./styleCodeGateLogic";
import { searchProducts } from "../../utils/productSearch";

const BLUE = "#4A7FFF";
const AMBER = "#FBBF24";
const RED = "#F87171";

const meta = { fontSize: 12, color: "rgba(233,238,255,.45)", lineHeight: 1.5 };

export default function StyleCodeBypass({ products, onCancel, onConfirm }) {
  const [name, setName] = useState("");
  const [searchedName, setSearchedName] = useState("");
  const [duplicatesShown, setDuplicatesShown] = useState(false);
  const [reason, setReason] = useState(null);

  const trimmed = name.trim();

  // Typing on after a search invalidates it — the results no longer describe
  // the product being created.
  useEffect(() => {
    if (trimmed !== searchedName) setDuplicatesShown(false);
  }, [trimmed, searchedName]);

  const matches = useMemo(() => {
    if (!searchedName) return [];
    try {
      return (searchProducts(products || [], searchedName) || []).slice(0, 8);
    } catch {
      return [];
    }
  }, [products, searchedName]);

  const readiness = bypassReadiness({
    name, duplicatesShown, searchedName, reason, validReasons: EXEMPT_REASON_KEYS,
  });
  const ready = readiness === BYPASS_READY;

  function runSearch() {
    if (trimmed.length < 3) return;
    setSearchedName(trimmed);
    setDuplicatesShown(true);
  }

  return (
    <div style={{ border: `1px solid ${AMBER}55`, background: "rgba(251,191,36,.06)",
                  borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 14.5, fontWeight: 800, color: AMBER }}>Adding without a style code</div>
      <div style={{ ...meta, lineHeight: 1.6 }}>
        This product won't be protected against duplicates the way coded products are, so the
        name check below is the <b style={{ color: "rgba(233,238,255,.7)" }}>only</b> thing standing
        between this and a second copy of a shoe we already have.
      </div>

      {/* 1 — the name */}
      <div>
        <div style={{ ...meta, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase",
                      color: "rgba(233,238,255,.55)", marginBottom: 7 }}>
          1 · What is it called?
        </div>
        <input
          placeholder="e.g. Gucci Ace Leather Sneaker"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } }}
          style={{ background: "#08090C", border: "2px solid rgba(74,127,255,.28)", borderRadius: 10,
                   padding: "13px 14px", color: "#fff", fontSize: 15, fontWeight: 600, outline: "none",
                   width: "100%", boxSizing: "border-box", minHeight: 48 }}
        />
      </div>

      {/* 2 — the duplicate check, mandatory */}
      <div>
        <div style={{ ...meta, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase",
                      color: "rgba(233,238,255,.55)", marginBottom: 7 }}>
          2 · Check we don't already have it
        </div>
        <button type="button" disabled={trimmed.length < 3} onClick={runSearch}
          style={{ background: trimmed.length < 3 ? "rgba(74,127,255,.12)" : "rgba(74,127,255,.18)",
                   border: `1px solid ${trimmed.length < 3 ? "rgba(74,127,255,.2)" : BLUE}`,
                   color: trimmed.length < 3 ? "rgba(233,238,255,.35)" : "#fff",
                   borderRadius: 10, padding: "12px 14px", fontSize: 13.5, fontWeight: 700,
                   cursor: trimmed.length < 3 ? "not-allowed" : "pointer", width: "100%", minHeight: 46 }}>
          {duplicatesShown ? "Search again" : "Search existing products"}
        </button>

        {duplicatesShown && (
          <div style={{ marginTop: 10 }}>
            {matches.length === 0 ? (
              <div style={{ ...meta, color: "#4ADE80" }}>
                ✓ No existing product matches “{searchedName}”.
              </div>
            ) : (
              <>
                <div style={{ ...meta, color: AMBER, marginBottom: 8 }}>
                  {matches.length} similar product{matches.length === 1 ? "" : "s"} already exist.
                  If one of these is the shoe in your hand, <b>cancel and add stock to it instead</b>.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                  {matches.map((m) => (
                    <div key={m.id} style={{ display: "flex", gap: 10, alignItems: "center",
                                             background: "rgba(255,255,255,.04)", borderRadius: 10, padding: 8 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 8, overflow: "hidden", flexShrink: 0,
                                    background: "rgba(255,255,255,.05)" }}>
                        {m.photoUrl && <img src={m.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "#fff", fontWeight: 600 }}>{m.name || "Unnamed"}</div>
                        <div style={{ ...meta, fontSize: 11 }}>{m.category || ""}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 3 — the reason */}
      <div>
        <div style={{ ...meta, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase",
                      color: "rgba(233,238,255,.55)", marginBottom: 7 }}>
          3 · Why is there no code?
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {EXEMPT_REASONS.map((r) => {
            const on = reason === r.key;
            return (
              <button key={r.key} type="button" onClick={() => setReason(r.key)}
                style={{ textAlign: "left", background: on ? "rgba(74,127,255,.14)" : "rgba(255,255,255,.03)",
                         border: `${on ? 2 : 1}px solid ${on ? BLUE : "rgba(120,150,255,.16)"}`,
                         borderRadius: 10, padding: "11px 13px", cursor: "pointer", minHeight: 46 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: on ? "#fff" : "rgba(233,238,255,.8)" }}>{r.label}</div>
                <div style={{ ...meta, fontSize: 11.5, marginTop: 2 }}>{r.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* What is still missing, in the order it must be done. */}
      {!ready && (
        <div style={{ ...meta, fontSize: 11.5, color: RED }}>
          {readiness === BYPASS_NEEDS_NAME && "Enter the product name first."}
          {readiness === BYPASS_NEEDS_DUPLICATE_CHECK && "Run the duplicate search for this name before continuing."}
          {readiness === BYPASS_NEEDS_REASON && "Choose a reason."}
        </div>
      )}

      <button type="button" disabled={!ready}
        onClick={ready ? () => onConfirm({ name: trimmed, reason }) : undefined}
        style={{ background: ready ? AMBER : "rgba(251,191,36,.14)", border: "none",
                 color: ready ? "#3b2c00" : "rgba(233,238,255,.35)", borderRadius: 12,
                 padding: "14px 20px", fontSize: 14.5, fontWeight: 800,
                 cursor: ready ? "pointer" : "not-allowed", minHeight: 50 }}>
        Add without a style code
      </button>
      <button type="button" onClick={onCancel}
        style={{ ...meta, background: "none", border: "none", cursor: "pointer", padding: 6 }}>
        ← Back to the style code
      </button>
    </div>
  );
}
