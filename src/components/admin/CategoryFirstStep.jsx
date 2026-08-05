// ─── ADD PRODUCT — STEP 0: WHAT ARE YOU ADDING? ──────────────────────────────
// The style-code gate used to run BEFORE this question was asked, which meant a
// belt, a watch or a perfume could not be created at all — the operator was
// asked for a manufacturer style code that those products have never had.
//
// So the category comes first. It is the one answer that decides everything
// after it: whether a style code is asked for, which sizes appear, and how the
// product behaves in refill, Display Checks and the POS.
//
// Only a category in the ENFORCED list (live, from /config/styleCode) sends the
// operator to the style-code gate. Everything else goes straight to the product
// form with no gate and no style-code fields — exactly as it did before this
// feature existed.

import CategorySelect from "./CategorySelect";

const BLUE = "#4A7FFF";

export default function CategoryFirstStep({
  taxonomy, taxonomySource, value, onChange, onContinue, onCancel,
  enforced, configReady,
}) {
  const chosen = !!value;
  const willGate = chosen && Array.isArray(enforced) && enforced.includes(value);

  return (
    <div style={{
      background: "rgba(4,5,10,1)", border: "1px solid rgba(60,110,255,.12)", borderRadius: 18,
      padding: "22px 20px 24px", marginBottom: "1.5rem", boxShadow: "0 0 12px rgba(60,110,255,.15)",
      display: "flex", flexDirection: "column", gap: 18,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 19, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>Add Product</span>
        <span style={{ fontSize: 11.5, color: "rgba(233,238,255,.42)" }}>Step 1 · What is it?</span>
      </div>

      {taxonomySource === "fallback" && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "rgba(251,191,36,.09)",
                      border: "1px solid rgba(251,191,36,.38)", borderRadius: 12, padding: "12px 14px" }}>
          <span style={{ fontSize: 15, lineHeight: 1.2 }}>⚠️</span>
          <div style={{ fontSize: 12.5, color: "#FBBF24", lineHeight: 1.5 }}>
            <b>Using the built-in category list</b> — the live registry could not be read.
            Reload before adding products if you are not sure.
          </div>
        </div>
      )}

      <div>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase",
                      color: "rgba(233,238,255,.62)", marginBottom: 9 }}>
          Category <span style={{ color: "#F87171" }}>REQUIRED</span>
        </div>
        <CategorySelect registry={taxonomy} value={value} onChange={onChange} />
        <div style={{ marginTop: 9, fontSize: 12, color: "rgba(233,238,255,.4)", lineHeight: 1.5 }}>
          This sets the sizes and how the product is handled everywhere else.
        </div>
      </div>

      {/* Tell the operator what is coming, so the next screen is not a surprise.
          Only shown once the live config has loaded — announcing a step off a
          default we are about to replace would flash it and take it away. */}
      {chosen && configReady && (
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: willGate ? "#4A7FFF" : "rgba(233,238,255,.45)" }}>
          {willGate
            ? "Next: the style code from the inside-tongue label."
            : "No style code needed for this category — you'll go straight to the details."}
        </div>
      )}

      <button type="button" disabled={!chosen} onClick={onContinue}
        style={{ background: chosen ? BLUE : "rgba(74,127,255,.14)", border: "none",
                 color: chosen ? "#fff" : "rgba(233,238,255,.35)", borderRadius: 13,
                 padding: "16px 28px", fontSize: 15, fontWeight: 800,
                 cursor: chosen ? "pointer" : "not-allowed", minHeight: 54 }}>
        Continue
      </button>
      <button type="button" onClick={onCancel}
        style={{ background: "none", border: "none", color: "rgba(233,238,255,.4)",
                 fontSize: 12, cursor: "pointer", padding: 8 }}>
        Cancel
      </button>
    </div>
  );
}
