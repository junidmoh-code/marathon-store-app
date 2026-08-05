// ─── ADD SNEAKER — THE STYLE CODE GATE (step 1 of intake) ────────────────────
// Sneakers arrive without boxes, so there is no barcode to scan. The style code
// on the inside-tongue label is the identity, and it is now the FIRST question
// intake asks — before the name, before the photo, before the category.
//
// That ordering is the whole point. Asking for the code first is what makes it
// possible to answer "do we already have this shoe?" BEFORE anyone fills in a
// form. Ask it last and you find out you created a duplicate after the work is
// done, which is how the catalogue ends up with two records for one shoe and its
// stock split across them.
//
// ── THE THREE OUTCOMES ───────────────────────────────────────────────────────
//   ALREADY OURS  the code is claimed, or sits on a product → show that product
//                 and route to ADD STOCK. The create form never opens.
//   FOUND         the catalog knows it → the fetched name and photo are shown
//                 LARGE with explicit Confirm / Reject. Nothing is prefilled
//                 until a human says yes.
//   UNKNOWN       nobody knows it → straight to manual entry, code retained.
//
// Reject and Unknown land in the same place: the form, with the code kept. The
// code is the one thing we are certain of — it was read off the shoe — so it
// survives every path.
//
// ── WHAT THIS COMPONENT WILL NOT DO ──────────────────────────────────────────
// It never infers the CATEGORY from the code. Nike apparel prints the same 6+3
// format as Nike footwear, so a code cannot tell you what a thing is. Category
// comes from the entry point the operator chose ("Add Sneaker" ⇒ sneakers) and
// nowhere else.

import { useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import {
  normaliseStyleCode,
  formatStyleCodeForDisplay,
  isKnownStyleCodeFormat,
} from "../../utils/styleCode";
import { prepareLabelPhoto } from "../../utils/labelPhoto";
import { serverNowMs } from "../../utils/serverTime";
import {
  resolveAddStockTarget, classifyLookupOutcome, labelPhotoEvidence,
  TARGET_READY, TARGET_CHOOSE,
  BLOCK_CLAIM_UNAVAILABLE, BLOCK_PRODUCT_UNAVAILABLE,
} from "./styleCodeGateLogic";

const resolveStyleCodeFn = httpsCallable(functions, "resolveStyleCode");
const readStyleCodeLabelFn = httpsCallable(functions, "readStyleCodeLabel");

const BLUE = "#4A7FFF";
const AMBER = "#FBBF24";
const RED = "#F87171";
const GREEN = "#4ADE80";

const panel = {
  background: "rgba(4,5,10,1)", border: "1px solid rgba(60,110,255,.12)", borderRadius: 18,
  padding: "22px 20px 24px", marginBottom: "1.5rem", boxShadow: "0 0 12px rgba(60,110,255,.15)",
  display: "flex", flexDirection: "column", gap: 18,
};
const bigInput = {
  background: "#08090C", border: "2px solid rgba(74,127,255,.28)", borderRadius: 12,
  padding: "16px 18px", color: "#fff", fontSize: 20, fontWeight: 700, outline: "none",
  width: "100%", boxSizing: "border-box", minHeight: 58, letterSpacing: ".06em",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", textTransform: "uppercase",
};
const btn = (bg, color, extra = {}) => ({
  background: bg, color, border: "none", borderRadius: 13, padding: "16px 24px",
  fontSize: 15, fontWeight: 800, cursor: "pointer", minHeight: 54, width: "100%", ...extra,
});
const label = {
  fontSize: 11.5, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase",
  color: "rgba(233,238,255,.62)", marginBottom: 9,
};
const meta = { fontSize: 12, color: "rgba(233,238,255,.45)", lineHeight: 1.5 };

function Note({ tone, children }) {
  const c = tone === "bad" ? RED : tone === "warn" ? AMBER : tone === "good" ? GREEN : BLUE;
  const bg = tone === "bad" ? "rgba(248,113,113,.09)" : tone === "warn" ? "rgba(251,191,36,.09)"
    : tone === "good" ? "rgba(74,222,128,.09)" : "rgba(74,127,255,.09)";
  return (
    <div style={{ background: bg, border: `1px solid ${c}55`, borderRadius: 12, padding: "12px 14px",
                  fontSize: 12.5, color: c, lineHeight: 1.55 }}>
      {children}
    </div>
  );
}

export default function StyleCodeGate({ onCancel, onProceed, onAddStock, products }) {
  // step: "enter" → "resolving" → "found" | "existing" | "unknown"
  const [step, setStep] = useState("enter");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(null);       // "reading" | "resolving" | null
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);   // the resolveStyleCode payload
  const [labelPhoto, setLabelPhoto] = useState(null); // { dataUrl, base64, blob }
  // WHICH CODE THIS PHOTO ACTUALLY PRODUCED. The photo is EVIDENCE for one
  // specific code; if the operator then edits the field or picks a different
  // candidate, that photo is evidence for a different shoe's label and must not
  // follow the new code. Without this, styleCodeLabelPhoto could end up
  // pointing at the wrong label — defeating the entire purpose of the field —
  // and confusableRetry would stay on for a hand-typed code, which the comment
  // in lookup() explicitly says it must not. (CodeRabbit, PR #312.)
  const [photoForCode, setPhotoForCode] = useState(null); // normalised code
  const [readNote, setReadNote] = useState(null);
  const fileRef = useRef(null);

  const normalised = normaliseStyleCode(typed);
  const canSubmit = !!normalised && !busy;
  // The photo counts as evidence ONLY while the code still matches the one it
  // was read from. Everything downstream keys off this, not off labelPhoto.
  const evidencePhoto = labelPhotoEvidence({ labelPhoto, photoForCode, normalised });
  const photoMatchesCode = !!evidencePhoto;
  // Which product the operator tapped, when a code resolves to more than one.
  // Null until they choose — there is deliberately no default.
  const [selectedProductId, setSelectedProductId] = useState(null);

  // ── Tier 1–2: photograph the label ────────────────────────────────────────
  async function handleLabelPhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setError(null); setReadNote(null); setBusy("reading");
    // CLEAR THE BINDING FIRST. A retake that fails must not leave the NEW photo
    // paired with the PREVIOUS code — that was the gap the first version of this
    // guard left open. Nothing is evidence again until a read succeeds.
    setLabelPhoto(null); setPhotoForCode(null);
    try {
      // Downscaled to 1024px in the browser BEFORE it is sent anywhere.
      const photo = await prepareLabelPhoto(file);
      setLabelPhoto(photo);
      const res = await readStyleCodeLabelFn({ imageBase64: photo.base64, mimeType: "image/jpeg" });
      const data = (res && res.data) || {};
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];

      if (candidates.length === 1) {
        // VALIDATE BEFORE USE — the server already did, this is the client's own
        // guard so a bad deploy on either side cannot put prose in the field.
        const code = candidates[0];
        if (!isKnownStyleCodeFormat(code)) {
          setReadNote({ tone: "warn", text: "That photo produced something that isn't a style code. Type it instead." });
        } else {
          setTyped(formatStyleCodeForDisplay(code));
          setPhotoForCode(code); // this photo IS the evidence for this code
          setReadNote({ tone: "good", text: `Read from the label: ${formatStyleCodeForDisplay(code)}. Check it matches the shoe, then continue.` });
        }
      } else if (candidates.length > 1) {
        setReadNote({
          tone: "warn",
          text: `Found ${candidates.length} possible codes — tap the right one, or type it.`,
          options: candidates,
        });
      } else if ((data.errors || []).length) {
        setReadNote({ tone: "warn", text: "The label reader is unavailable right now. Type the code from the tongue label." });
      } else {
        setReadNote({ tone: "warn", text: "Couldn't read a code off that photo. Try a straighter, closer shot — or type it." });
      }
    } catch (err) {
      setError((err && err.message) || "Couldn't process that photo.");
    } finally {
      setBusy(null);
    }
  }

  // ── Look the code up ──────────────────────────────────────────────────────
  async function lookup() {
    if (!normalised) return;
    setError(null); setBusy("resolving");
    try {
      // confusableRetry is on ONLY when the code came off a photo — a human who
      // typed it did not misread a glyph, so manual entry never pays for the
      // variant lookups.
      const res = await resolveStyleCodeFn({ code: typed, confusableRetry: !!evidencePhoto });
      const data = (res && res.data) || {};
      setResult(data);
      setSelectedProductId(null); // a new lookup invalidates any prior choice
      // ONE place decides what the outcome means, so "the lookup broke" and
      // "the catalogue has nothing" can never be conflated. See
      // classifyLookupOutcome — an error is not an absence.
      setStep(classifyLookupOutcome({ data }));
    } catch (err) {
      setError((err && (err.message || err.code)) || "The lookup could not be completed.");
      setSelectedProductId(null);
      // The callable never answered, so we know NOTHING. Record that as a real
      // failure — a result without `errors` would render as "not in the
      // catalogue", a claim we have not earned, and would offer the create-new
      // path that produces the duplicate this feature exists to prevent.
      setResult({
        normalised,
        displayCode: formatStyleCodeForDisplay(normalised),
        found: false,
        existingProducts: [],
        errors: [{ provider: "client", message: (err && (err.message || err.code)) || "lookup failed" }],
      });
      setStep(classifyLookupOutcome({ threw: true }));
    } finally {
      setBusy(null);
    }
  }

  // The style code + provenance every downstream path carries.
  function provenance(source) {
    return {
      styleCode: result?.displayCode || formatStyleCodeForDisplay(normalised),
      styleCodeNormalised: result?.normalised || normalised,
      styleCodeSource: source,           // enum: cache | api | websearch | manual
      // SERVER-CORRECTED CLOCK, not the device's. The live rule validates
      // fetchedAt <= now + 86400000 against the SERVER clock, so a tablet
      // running fast produces a write that is silently REJECTED — the operator
      // sees a save that appears to work and a field that never lands. This
      // repo already carries a server-time anchor precisely because a till with
      // a wrong clock once corrupted the order counter. (CodeRabbit #312.)
      styleCodeFetchedAt: serverNowMs(),
      // Only when this photo is still evidence for THIS code (see photoForCode).
      labelPhoto: evidencePhoto,
    };
  }

  // Confirm the fetched identity → prefill. Category is NOT taken from here.
  function confirmFetched() {
    const m = result.model || {};
    onProceed({
      ...provenance(result.source === "cache" ? "cache" : result.source === "web-search" ? "websearch" : "api"),
      suggestedName: [m.brand, m.model, m.colorwayName].filter(Boolean).join(" ").trim() || m.model || "",
      suggestedBrand: m.brand || null,
      suggestedImageUrl: m.imageUrl || null,
      model: m,
    });
  }

  // Reject the fetched identity → manual entry, code retained.
  function rejectFetched() {
    onProceed({ ...provenance("manual"), suggestedName: "", suggestedBrand: null, suggestedImageUrl: null, model: null });
  }

  // Proceed with NO style code. Everything downstream already tolerates this:
  // buildNewProduct omits both style-code fields when there is no code, and
  // addProduct only attempts a claim when styleCodeNormalised is present.
  function skipCode() {
    onProceed({
      styleCode: "", styleCodeNormalised: "", styleCodeSource: "manual",
      styleCodeFetchedAt: serverNowMs(), labelPhoto: null,
      suggestedName: "", suggestedBrand: null, suggestedImageUrl: null, model: null,
    });
  }

  const productById = (id) => (products || []).find((p) => p && p.id === id) || null;
  const existing = result ? (result.existingProducts || []) : [];
  const claimedProduct = result && result.claim ? productById(result.claim.productId) : null;

  return (
    <div style={panel}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 19, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>Add Sneaker</span>
        <span style={{ ...meta, fontSize: 11.5 }}>Step 1 of 2 · Style code</span>
      </div>

      {/* ── STEP: ENTER ─────────────────────────────────────────────────── */}
      {step === "enter" && (
        <>
          <Note>
            Sneakers arrive without boxes, so there's no barcode. Use the <b>style code</b> on the
            inside-tongue label — it's how we tell one colourway from another.
          </Note>

          <div>
            <div style={label}>Photograph the tongue label</div>
            <input ref={fileRef} type="file" accept="image/*" capture="environment"
                   onChange={handleLabelPhoto} style={{ display: "none" }} />
            <button type="button" disabled={!!busy} onClick={() => fileRef.current && fileRef.current.click()}
              style={{ background: "rgba(60,110,255,.05)", border: "2px dashed rgba(60,110,255,.28)",
                       borderRadius: 12, padding: "20px", color: "rgba(233,238,255,.62)",
                       cursor: busy ? "default" : "pointer", fontSize: 14, fontWeight: 700,
                       width: "100%", minHeight: 68, opacity: busy ? 0.6 : 1 }}>
              {busy === "reading" ? "Reading the label…" : labelPhoto ? "Photo taken — tap to retake" : "📷  Take a photo of the label"}
            </button>
            {labelPhoto && (
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <img src={labelPhoto.dataUrl} alt="label"
                     style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 10,
                              border: "1px solid rgba(60,110,255,.25)",
                              opacity: photoMatchesCode ? 1 : 0.4 }} />
                {!photoMatchesCode && (
                  <span style={{ ...meta, color: AMBER, maxWidth: 260 }}>
                    The code was changed after this photo, so it is no longer kept as evidence for it.
                    Retake it to attach a label photo.
                  </span>
                )}
              </div>
            )}
          </div>

          {readNote && (
            <Note tone={readNote.tone}>
              {readNote.text}
              {readNote.options && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  {readNote.options.map((c) => (
                    <button key={c} type="button"
                      onClick={() => { setTyped(formatStyleCodeForDisplay(c)); setPhotoForCode(normaliseStyleCode(c)); setReadNote(null); }}
                      style={{ background: "rgba(74,127,255,.14)", border: `1px solid ${BLUE}`, color: "#fff",
                               borderRadius: 10, padding: "10px 14px", fontWeight: 800, cursor: "pointer",
                               fontFamily: "ui-monospace, monospace", minHeight: 44 }}>
                      {formatStyleCodeForDisplay(c)}
                    </button>
                  ))}
                </div>
              )}
            </Note>
          )}

          <div>
            {/* Manual entry is TIER 4: always present, never removed, and never
                shape-gated — brands mint new formats faster than any regex list
                tracks them. */}
            <div style={label}>Or type it in</div>
            <input
              placeholder="CT8527-016"
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                // Editing the code by hand ends the photo's claim to be its
                // evidence. The photo stays on screen (flagged) so the operator
                // can see what happened, but it is no longer attached.
                setPhotoForCode(null);
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) lookup(); }}
              style={bigInput}
              autoComplete="off" autoCorrect="off" spellCheck={false}
            />
            {!!normalised && (
              <div style={{ ...meta, marginTop: 8 }}>
                Will be saved as <b style={{ color: "rgba(233,238,255,.75)" }}>{normalised}</b>
                {!isKnownStyleCodeFormat(normalised) && " · unusual format, but we'll still look it up"}
              </div>
            )}
          </div>

          {error && <Note tone="bad">{error}</Note>}

          <button type="button" disabled={!canSubmit} onClick={lookup}
            style={btn(canSubmit ? BLUE : "rgba(74,127,255,.14)", canSubmit ? "#fff" : "rgba(233,238,255,.35)",
                       { cursor: canSubmit ? "pointer" : "not-allowed" })}>
            {busy === "resolving" ? "Checking…" : "Continue"}
          </button>
          {/* NO CODE AT ALL. A worn-off label, a sample, a non-sneaker that
              reached this entry point — none of those should stop a product
              being created. The style code is the PREFERRED identity, never a
              precondition for doing the job. Products saved this way simply
              carry no styleCode fields (buildNewProduct omits them) and claim
              nothing, exactly as every product did before this feature. */}
          <button type="button" onClick={skipCode}
            style={{ ...meta, background: "none", border: "1px solid rgba(120,150,255,.25)",
                     borderRadius: 10, cursor: "pointer", padding: "12px", minHeight: 44 }}>
            No readable code on this shoe — add it without one
          </button>
          <button type="button" onClick={onCancel}
            style={{ ...meta, background: "none", border: "none", cursor: "pointer", padding: 8 }}>
            Cancel
          </button>
        </>
      )}

      {/* ── STEP: ALREADY OURS — do NOT open the create form ─────────────
          THE TARGET MUST BE CERTAIN. Routing stock to the wrong twin is silent
          count corruption — a worse outcome than the duplicate product this
          feature prevents, because a duplicate is visible in the catalogue
          while a wrong count looks exactly like a normal receipt and surfaces
          weeks later as a shoe that is somehow always short. So there is no
          default and no first-match fallback: either the claim settles it, or
          the operator picks explicitly, or the button stays disabled. */}
      {step === "existing" && (() => {
        const target = resolveAddStockTarget({
          claim: result.claim,
          existingProducts: existing,
          products,
          selectedId: selectedProductId,
        });
        const mustChoose = target.kind === TARGET_CHOOSE;
        const ready = target.kind === TARGET_READY;
        const cards = existing.length ? existing : (claimedProduct ? [claimedProduct] : []);
        return (
          <>
            <Note tone="good">
              <b>We already have this shoe.</b> Add stock to it rather than creating a second record.
            </Note>

            {result.duplicate && (
              <Note tone="warn">
                <b>⚠️ {existing.length} products share this style code.</b> That's been flagged for review —
                nothing has been merged or changed.
              </Note>
            )}

            {mustChoose && (
              <Note tone="warn">
                <b>Which one are you holding?</b> Tap it. Stock will only go where you say — adding it to
                the wrong one is very hard to spot later.
              </Note>
            )}

            {cards.map((p) => {
              const full = productById(p.id) || p;
              const chosen = ready ? target.productId === p.id : selectedProductId === p.id;
              const selectable = mustChoose && !!productById(p.id);
              return (
                <div
                  key={p.id}
                  onClick={selectable ? () => setSelectedProductId(p.id) : undefined}
                  role={selectable ? "button" : undefined}
                  tabIndex={selectable ? 0 : undefined}
                  onKeyDown={selectable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedProductId(p.id); } } : undefined}
                  style={{ display: "flex", gap: 14, alignItems: "center",
                           background: chosen ? "rgba(74,127,255,.14)" : "rgba(255,255,255,.03)",
                           border: `${chosen ? 2 : 1}px solid ${chosen ? BLUE : "rgba(120,150,255,.16)"}`,
                           borderRadius: 14, padding: 12,
                           cursor: selectable ? "pointer" : "default" }}>
                  <div style={{ width: 84, height: 84, flexShrink: 0, borderRadius: 12, overflow: "hidden",
                                background: "rgba(255,255,255,.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {full.photoUrl
                      ? <img src={full.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : <span style={{ ...meta, fontSize: 9 }}>NO IMAGE</span>}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 750, color: "#fff", lineHeight: 1.25 }}>{full.name || "Unnamed product"}</div>
                    <div style={{ ...meta, marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
                      {result.displayCode}{full.category ? ` · ${full.category}` : ""}
                    </div>
                    {ready && target.basis === "claim" && target.productId === p.id && (
                      <div style={{ ...meta, marginTop: 4, color: GREEN }}>✓ This code is registered to this product</div>
                    )}
                  </div>
                  {selectable && (
                    <span style={{ ...meta, color: chosen ? BLUE : "rgba(233,238,255,.35)", fontWeight: 800 }}>
                      {chosen ? "SELECTED" : "TAP"}
                    </span>
                  )}
                </div>
              );
            })}

            {/* FAIL CLOSED. We know a product owns this code but cannot show it,
                so we refuse to send stock anywhere rather than fall back to a
                row that merely carries the same code. */}
            {target.kind === "blocked" && (
              <Note tone="bad">
                <b>Can't safely add stock here.</b><br />
                {target.reason === BLOCK_CLAIM_UNAVAILABLE
                  ? <>This code is registered to product <b>{target.productId}</b>, which isn't loaded on this
                     device. Adding stock to anything else risks putting it on the wrong shoe.</>
                  : target.reason === BLOCK_PRODUCT_UNAVAILABLE
                    ? <>The matching product isn't loaded on this device, so we can't confirm which shoe it is.</>
                    : <>No product could be confirmed for this code.</>}
                <br />Reload, or ask an admin to check it.
              </Note>
            )}

            <button type="button" disabled={!ready}
              onClick={ready ? () => onAddStock(target.productId) : undefined}
              style={btn(ready ? BLUE : "rgba(74,127,255,.14)", ready ? "#fff" : "rgba(233,238,255,.35)",
                         { cursor: ready ? "pointer" : "not-allowed" })}>
              {mustChoose ? "Select a product first" : "Add stock to this product"}
            </button>
            <button type="button" onClick={() => { setStep("enter"); setResult(null); setSelectedProductId(null); }}
              style={{ ...meta, background: "none", border: "none", cursor: "pointer", padding: 8 }}>
              ← Different code
            </button>
          </>
        );
      })()}

      {/* ── STEP: ORPHANED CLAIM ─────────────────────────────────────────── */}
      {step === "orphan" && (
        <>
          <Note tone="bad">
            <b>This style code is reserved, but the product it points at doesn't exist.</b><br />
            That happens when a save failed halfway. It needs an admin to clear the reservation —
            creating another product now would leave the same mess behind.
          </Note>
          <div style={{ ...meta, fontFamily: "ui-monospace, monospace" }}>
            {result.displayCode} → {result.claim && result.claim.productId}
          </div>
          <button type="button" onClick={() => { setStep("enter"); setResult(null); }} style={btn(BLUE, "#fff")}>
            ← Back
          </button>
        </>
      )}

      {/* ── STEP: FOUND — confirm or reject, LARGE ───────────────────────── */}
      {step === "found" && (
        <>
          {result.correctedFrom && (
            <Note tone="warn">
              Read <b>{formatStyleCodeForDisplay(result.correctedFrom)}</b> off the label, but that's not a
              real code — <b>{result.displayCode}</b> is, and it's one character away. Check the tongue
              label before confirming.
            </Note>
          )}

          <div style={{ ...label, marginBottom: 0 }}>Is this the shoe in your hand?</div>

          {/* LARGE on purpose. This is the only moment a human can catch a wrong
              match, and they can only do that if the picture is big enough to
              actually look at. */}
          <div style={{ width: "100%", aspectRatio: "1 / 1", maxHeight: 340, borderRadius: 16,
                        overflow: "hidden", background: "rgba(255,255,255,.05)",
                        display: "flex", alignItems: "center", justifyContent: "center" }}>
            {result.model && result.model.imageUrl
              ? <img src={result.model.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
              : <span style={{ ...meta }}>No catalogue photo</span>}
          </div>

          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", lineHeight: 1.25 }}>
              {[result.model?.brand, result.model?.model].filter(Boolean).join(" ") || "Unnamed"}
            </div>
            {result.model?.colorwayName && (
              <div style={{ fontSize: 14, color: "rgba(233,238,255,.7)", marginTop: 4 }}>{result.model.colorwayName}</div>
            )}
            <div style={{ ...meta, marginTop: 8, fontFamily: "ui-monospace, monospace" }}>{result.displayCode}</div>
          </div>

          <button type="button" onClick={confirmFetched} style={btn(BLUE, "#fff")}>
            ✓ Confirm — this is it
          </button>
          <button type="button" onClick={rejectFetched}
            style={btn("rgba(255,255,255,.06)", "rgba(233,238,255,.9)")}>
            ✗ Not this shoe — enter it myself
          </button>
          <div style={{ ...meta, textAlign: "center" }}>
            Rejecting keeps the style code and opens a blank form. Nothing is saved until you save it.
          </div>
        </>
      )}

      {/* ── STEP: LOOKUP UNAVAILABLE — no create path ────────────────────
          An error and an empty answer are NOT the same thing. "Not in the
          catalogue" is a claim we may only make when the lookup actually
          succeeded and came back empty. After a failure we do not know, and
          offering "enter the details" here is what produces the duplicate this
          whole feature exists to prevent — so the only ways out are retry and
          back. This mirrors the rule the resolver enforces server-side: a dead
          vendor is never reported as "no such shoe". */}
      {/* ── STEP: LOOKUP UNAVAILABLE ──────────────────────────────────────
          An error and an empty answer are still NOT the same thing, so this
          step keeps its own honest wording — "we could not check", never "not
          in the catalogue".
          ── BUT IT MUST NEVER BE A DEAD END ────────────────────────────────
          The first version offered only Retry and Back. Combined with a vendor
          that fails every call, that made it impossible to add ANY new product:
          staff were locked out of Add Product entirely. A gate whose failure
          mode is "nobody can work" is worse than the duplicate it was guarding
          against.
          And the guard was never load-bearing here anyway. Uniqueness is
          enforced by the create-once claim on /style_code_index at SAVE time,
          not by this screen: if this code already belongs to a product, the
          save is refused and the operator is routed to add stock on it. So the
          manual path is safe to offer — the database still has the last word. */}
      {step === "unavailable" && (
        <>
          <Note tone="warn">
            <b>Couldn't check the catalogue just now</b> — so we can't tell you whether we already
            have this shoe. You can still add it: if this style code turns out to belong to an
            existing product, the save will stop and point you at it.
          </Note>
          {error && <Note tone="bad">{error}</Note>}
          <div style={{ ...meta, fontFamily: "ui-monospace, monospace", fontSize: 15, color: "#fff" }}>
            {result?.displayCode || formatStyleCodeForDisplay(normalised)}
          </div>
          <button type="button" disabled={!!busy} onClick={lookup} style={btn(BLUE, "#fff")}>
            {busy === "resolving" ? "Checking…" : "Try the lookup again"}
          </button>
          <button type="button" onClick={rejectFetched}
            style={btn("rgba(255,255,255,.06)", "rgba(233,238,255,.9)")}>
            Add it anyway — enter the details
          </button>
          <button type="button" onClick={() => { setStep("enter"); setResult(null); }}
            style={{ ...meta, background: "none", border: "none", cursor: "pointer", padding: 8 }}>
            ← Back
          </button>
        </>
      )}

      {/* ── STEP: UNKNOWN — the lookup ANSWERED, and answered nothing ─────
          The one case where "not in the catalogue" is an honest statement, and
          therefore the only one that offers the create path. */}
      {step === "unknown" && (
        <>
          <Note>
            <b>Not in the catalogue.</b> Nothing's wrong — plenty of stock isn't listed. Enter the
            details by hand; the style code is saved with it.
          </Note>
          <div style={{ ...meta, fontFamily: "ui-monospace, monospace", fontSize: 15, color: "#fff" }}>
            {result?.displayCode || formatStyleCodeForDisplay(normalised)}
          </div>
          <button type="button" onClick={rejectFetched} style={btn(BLUE, "#fff")}>
            Enter the details
          </button>
          <button type="button" onClick={() => { setStep("enter"); setResult(null); }}
            style={{ ...meta, background: "none", border: "none", cursor: "pointer", padding: 8 }}>
            ← Different code
          </button>
        </>
      )}
    </div>
  );
}
