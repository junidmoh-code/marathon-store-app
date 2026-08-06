// ─── NEW PRODUCT FORM (rebuilt 2026-07-26) ────────────────────────────────────
// WHAT CHANGED AND WHY:
//   • The "Category…" dropdown next to Product name is GONE. It wrote to
//     /product_categories, a node with no entry in the live RTDB rules — every
//     "＋ Add new category…" push was silently denied and the node is empty to
//     this day. It looked like a control and did nothing.
//   • The "Product Type" chip row (Sneaker / Kids / Clothing / Bottoms) is GONE.
//     Category and product type were two spellings of one concept; asking twice
//     is how a bag ends up typed as a sneaker.
//   • ONE required category selector replaces both. It is a real <select> with
//     optgroups — at 31 options a chip row is a wall — and nothing is selected
//     by default, so the operator must make the call rather than inherit
//     "Sneaker" by accident.
//   • Picking a category renders ITS size breakdown from the registry with a
//     quantity box per size. One-size categories get a single Quantity field.
//   • Opening stock is no longer collapsible or optional. The size grid IS that
//     section. An explicit 0 is allowed per size (nothing forces a fake number),
//     but the section cannot be skipped: the receiving location is required.
//
// UNCHANGED ON PURPOSE: hubs (Hub 1/2/3, ≥1 required, clothing barred from
// Hub 1), pricing, the shoebox checkbox, and the auto-assigned SKU + barcode.

import { sizesOf } from "../../utils/productTaxonomy.js";
import CategorySelect from "./CategorySelect.jsx";
import SizeQtyBoxes, { totalUnits } from "./SizeQtyBoxes.jsx";
import { LocationPicker } from "../stock/widgets.jsx";
import { labelFor, transferTargets } from "../stock/locations.js";

const BLUE = "#4A7FFF";
const BLUE_L = "#6A9FFF";
const PANEL = "rgba(12,16,30,.55)";

// Section heading — uppercase, letter-spaced, with an optional required flag.
function Label({ children, required, hint }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 9 }}>
      <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase", color: "rgba(233,238,255,.62)" }}>
        {children}
      </span>
      {required && <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".06em", color: "#F87171" }}>REQUIRED</span>}
      {hint && <span style={{ fontSize: 11.5, color: "rgba(233,238,255,.34)", fontStyle: "italic" }}>{hint}</span>}
    </div>
  );
}

// Frosted-glass section panel — the Marathon Glass surface.
function Panel({ children, accent }) {
  return (
    <div style={{
      background: PANEL, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
      border: `1px solid ${accent ? "rgba(74,127,255,.30)" : "rgba(120,150,255,.16)"}`,
      borderRadius: 16, padding: "16px 16px 18px",
      boxShadow: accent ? "inset 0 1px 0 rgba(255,255,255,.05), 0 0 22px rgba(74,127,255,.08)" : "inset 0 1px 0 rgba(255,255,255,.05)",
    }}>
      {children}
    </div>
  );
}

const textField = {
  background: "#08090C", border: "2px solid rgba(74,127,255,.28)", borderRadius: 12,
  padding: "14px 16px", color: "#fff", fontSize: 16, fontWeight: 600, outline: "none",
  width: "100%", boxSizing: "border-box", minHeight: 52,
};

export default function NewProductForm({
  styleCode, suggestedImageUrl, onChangeStyleCode,
  form, setForm,
  taxonomy, taxonomySource,
  selectedCat, formSizes, formOneSize, formIsClothing,
  selectCategory, toggleHub, toggleShoebox,
  recvQtys, setRecvQtys,
  recvLoc, setRecvLoc, recvRegistry,
  fileInputRef, handleImageUpload,
  saving, saveAttempted, onSave,
}) {
  const nameOk = !!form.name.trim();
  const catOk = !!selectedCat;
  const hubsOk = form.hubs.length > 0;
  const locOk = !!recvLoc;
  // ── THE SIZE RUN IS CHOSEN, NOT ASSUMED (owner fix 3, 2026-08-06) ──────────
  // The category defines what sizes are POSSIBLE; the operator taps the ones
  // this product actually comes in. Default: nothing selected — a deliberate
  // act. One-size categories skip the selector ("_" sentinel, unchanged).
  const sizeRun = Array.isArray(form.sizeRun) ? form.sizeRun : [];
  const chosenSizes = formOneSize ? formSizes : formSizes.filter((sz) => sizeRun.includes(String(sz)));
  const sizesOk = formOneSize || chosenSizes.length > 0;
  const toggleRunSize = (sz) => setForm((f) => {
    const cur = Array.isArray(f.sizeRun) ? f.sizeRun : [];
    return { ...f, sizeRun: cur.includes(sz) ? cur.filter((x) => x !== sz) : [...cur, sz] };
  });
  const canSave = !saving && nameOk && catOk && hubsOk && locOk && sizesOk;
  const units = totalUnits(recvQtys);
  const sizeCount = chosenSizes.length;

  return (
    <div style={{
      background: "rgba(4,5,10,1)", border: "1px solid rgba(60,110,255,.12)", borderRadius: 18,
      padding: "22px 20px 24px", marginBottom: "1.5rem", boxShadow: "0 0 12px rgba(60,110,255,.15)",
      display: "flex", flexDirection: "column", gap: 22,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 19, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>New Product</span>
        {styleCode && <span style={{ fontSize: 11.5, color: "rgba(233,238,255,.42)" }}>Step 2 of 2</span>}
      </div>

      {/* ── THE STYLE CODE, CARRIED FROM STEP 1 ────────────────────────────
          Read-only here on purpose. It is the product's identity key and it was
          already claimed against this session; letting it be edited on the form
          would let the claim and the stamp disagree. Changing it means going
          back to step 1, which re-runs the whole lookup. */}
      {styleCode && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                      background: "rgba(74,127,255,.08)", border: "1px solid rgba(74,127,255,.30)",
                      borderRadius: 12, padding: "12px 14px" }}>
          {suggestedImageUrl && (
            <img src={suggestedImageUrl} alt="" style={{ width: 44, height: 44, objectFit: "contain",
                 borderRadius: 8, background: "rgba(255,255,255,.05)" }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".09em",
                          textTransform: "uppercase", color: "rgba(233,238,255,.5)" }}>Style code</div>
            <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: 16, fontWeight: 800, color: "#fff", letterSpacing: ".05em" }}>{styleCode}</div>
          </div>
          {onChangeStyleCode && (
            <button type="button" onClick={onChangeStyleCode}
              style={{ background: "none", border: "1px solid rgba(120,150,255,.3)", borderRadius: 9,
                       color: "rgba(233,238,255,.6)", fontSize: 12, fontWeight: 700, padding: "8px 12px",
                       cursor: "pointer", minHeight: 40 }}>
              Change
            </button>
          )}
        </div>
      )}

      {/* The live registry could not be read, so the category list is the one
          baked into this build. It can disagree with the console — a category
          added or edited there since this bundle shipped will be missing or
          stale. Saving still works and still produces a self-consistent product,
          so this warns loudly rather than blocking the shop floor over a
          transient blip; but it must be impossible to miss, not a small chip. */}
      {taxonomySource === "fallback" && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "rgba(251,191,36,.09)",
                      border: "1px solid rgba(251,191,36,.38)", borderRadius: 12, padding: "12px 14px" }}>
          <span style={{ fontSize: 15, lineHeight: 1.2 }}>⚠️</span>
          <div style={{ fontSize: 12.5, color: "#FBBF24", lineHeight: 1.5 }}>
            <b>Using the built-in category list</b> — the live registry could not be read.
            Any category added or changed in the console recently may be missing or out of date here.
            Reload before adding products if you are not sure.
          </div>
        </div>
      )}

      {/* ── NAME ──────────────────────────────────────────────────────────── */}
      <div>
        <Label required>Product name</Label>
        <input
          placeholder="e.g. Nike Air Force 1 Triple White"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          style={{ ...textField, borderColor: saveAttempted && !nameOk ? "#F87171" : "rgba(74,127,255,.28)" }}
        />
      </div>

      {/* ── CATEGORY — the one product-type decision ──────────────────────── */}
      <div>
        <Label required hint="what the product actually is">Category</Label>
        <CategorySelect
          registry={taxonomy}
          value={form.categoryKey}
          onChange={selectCategory}
          invalid={saveAttempted && !catOk}
        />
        {saveAttempted && !catOk && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: "#F87171", fontWeight: 600 }}>
            Pick a category — it sets the sizes and how this product is handled everywhere else.
          </div>
        )}
      </div>

      {/* ── PHOTO ─────────────────────────────────────────────────────────── */}
      <div>
        <Label>Product photo</Label>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display: "none" }} />
        <button type="button" onClick={() => fileInputRef.current.click()}
          style={{ background: "rgba(60,110,255,.05)", border: "2px dashed rgba(60,110,255,.28)", borderRadius: 12,
                   padding: "14px 20px", color: "rgba(233,238,255,.55)", cursor: "pointer", fontSize: 13.5,
                   fontWeight: 600, width: "100%", textAlign: "center" }}>
          {form.photoUrl ? "Photo uploaded — tap to change" : "Tap to upload photo"}
        </button>
        {form.photoUrl && (
          <img src={form.photoUrl} alt="preview"
               style={{ marginTop: 10, width: 72, height: 72, objectFit: "cover", borderRadius: 12,
                        border: "1px solid rgba(60,110,255,.25)" }} />
        )}
      </div>

      {/* ── OPENING STOCK — required, always visible ──────────────────────── */}
      <div>
        <Label required hint={selectedCat ? `${selectedCat.label} · ${formOneSize ? "one size" : `${sizeCount} sizes`}` : null}>
          Opening stock
        </Label>
        <Panel accent>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase",
                          color: "rgba(233,238,255,.5)", marginBottom: 7 }}>
              Receive into <span style={{ color: "#F87171" }}>*</span>
            </div>
            <LocationPicker registry={recvRegistry} value={recvLoc} onChange={setRecvLoc} filter={transferTargets} />
            {saveAttempted && !locOk && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: "#F87171", fontWeight: 600 }}>
                Pick where this stock is landing.
              </div>
            )}
          </div>

          {!selectedCat ? (
            <div style={{ textAlign: "center", padding: "22px 12px", color: "rgba(233,238,255,.38)", fontSize: 13.5, lineHeight: 1.5 }}>
              Pick a category above and its size breakdown appears here.
            </div>
          ) : (
            <>
              {!formOneSize && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase",
                                color: "rgba(233,238,255,.5)", marginBottom: 7 }}>
                    Which sizes does this product come in? <span style={{ color: "#F87171" }}>*</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {formSizes.map((sz) => {
                      const on = sizeRun.includes(String(sz));
                      return (
                        <button key={sz} type="button" onClick={() => toggleRunSize(String(sz))}
                          style={{ minWidth: 54, minHeight: 46, borderRadius: 11, fontSize: 15, fontWeight: 800, cursor: "pointer",
                                   background: on ? "rgba(74,222,128,.18)" : "rgba(255,255,255,.04)",
                                   border: on ? "2px solid rgba(74,222,128,.7)" : "1px solid rgba(255,255,255,.16)",
                                   color: on ? "#B7F0CC" : "rgba(233,238,255,.6)" }}>
                          {sz}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 7, fontSize: 11.5, color: "rgba(233,238,255,.42)", lineHeight: 1.45 }}>
                    Only the sizes you select exist on this product — they alone get stock cells and barcodes.
                  </div>
                  {saveAttempted && !sizesOk && (
                    <div style={{ marginTop: 8, fontSize: 12.5, color: "#F87171", fontWeight: 600 }}>
                      Tap the sizes this product actually comes in.
                    </div>
                  )}
                </div>
              )}
              {(formOneSize || chosenSizes.length > 0) && (
              <SizeQtyBoxes
                sizes={chosenSizes}
                oneSize={formOneSize}
                values={recvQtys}
                onChange={(s, v) => setRecvQtys((q) => ({ ...q, [s]: v }))}
              />
              )}
              <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between",
                            gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
                <span style={{ color: "rgba(233,238,255,.42)" }}>
                  Enter <b style={{ color: "rgba(233,238,255,.62)" }}>0</b> for a size you did not receive — it still saves.
                </span>
                <span style={{ color: units > 0 ? "#4ADE80" : "rgba(233,238,255,.35)", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                  {units} unit{units === 1 ? "" : "s"} → {labelFor(recvLoc, recvRegistry) || "—"}
                </span>
              </div>
            </>
          )}
        </Panel>
      </div>

      {/* ── HUBS — unchanged behaviour ────────────────────────────────────── */}
      <div>
        <Label required hint="select at least one">Hubs</Label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[["hub1", "Hub 1"], ["hub2", "Hub 2"], ["hub3", "Hub 3"]].map(([val, label]) => {
            const disabled = formIsClothing && val === "hub1";
            const checked = form.hubs.includes(val) && !disabled;
            return (
              <button key={val} type="button" disabled={disabled} onClick={() => toggleHub(val)}
                style={{ padding: "12px 24px", borderRadius: 12, border: "2px solid",
                         borderColor: checked ? BLUE : "rgba(74,127,255,.20)",
                         background: checked ? "rgba(74,127,255,.14)" : "transparent",
                         color: disabled ? "#333" : checked ? BLUE_L : "rgba(233,238,255,.45)",
                         cursor: disabled ? "not-allowed" : "pointer", fontWeight: 700, fontSize: 14,
                         minHeight: 48, opacity: disabled ? 0.45 : 1,
                         boxShadow: checked ? "0 0 14px rgba(74,127,255,.18)" : "none",
                         transition: "border-color .14s, background .14s, color .14s" }}>
                {label}
              </button>
            );
          })}
        </div>
        {formIsClothing && (
          <div style={{ fontSize: 12, color: "rgba(233,238,255,.38)", marginTop: 9, fontStyle: "italic" }}>
            Clothing cannot be stocked at Hub 1.
          </div>
        )}
        {saveAttempted && !hubsOk && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: "#F87171", fontWeight: 600 }}>Select at least one hub.</div>
        )}
      </div>

      {/* ── PRICING — unchanged ───────────────────────────────────────────── */}
      <div>
        <Label hint="optional">Pricing (ZAR)</Label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="Stock price (R)"
                 value={form.stockPrice} onChange={(e) => setForm((f) => ({ ...f, stockPrice: e.target.value }))} style={textField} />
          <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="Retail price (R)"
                 value={form.retailPrice} onChange={(e) => setForm((f) => ({ ...f, retailPrice: e.target.value }))} style={textField} />
        </div>
      </div>

      {/* ── SHOEBOX — footwear only, unchanged ────────────────────────────── */}
      {!formIsClothing && (
        <label style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer",
                        color: "rgba(233,238,255,.8)", fontSize: 14, fontWeight: 600 }}>
          <input type="checkbox" checked={!!form.hasShoeBoxOption} onChange={toggleShoebox}
                 style={{ width: 20, height: 20, accentColor: BLUE, cursor: "pointer" }} />
          Shoebox option
          <span style={{ color: "rgba(233,238,255,.32)", fontSize: 12, fontStyle: "italic" }}>(auto-checked for footwear)</span>
        </label>
      )}

      <div style={{ fontSize: 12, color: "rgba(233,238,255,.3)", fontStyle: "italic" }}>
        SKU + barcode are assigned automatically on save.
      </div>

      <button type="button" onClick={onSave} disabled={!canSave}
        style={{ background: canSave ? BLUE : "rgba(74,127,255,.14)", border: "none",
                 color: canSave ? "#fff" : "rgba(233,238,255,.35)", borderRadius: 13,
                 padding: "16px 28px", fontSize: 15, fontWeight: 800, letterSpacing: ".01em",
                 cursor: canSave ? "pointer" : "not-allowed", minHeight: 54,
                 boxShadow: canSave ? "0 0 20px rgba(74,127,255,.28)" : "none",
                 transition: "background .14s, box-shadow .14s" }}>
        {saving ? "Saving…" : "Save Product"}
      </button>
    </div>
  );
}
