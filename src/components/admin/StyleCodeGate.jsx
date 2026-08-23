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

import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import {
  normaliseStyleCode,
  formatStyleCodeForDisplay,
  isKnownStyleCodeFormat,
} from "../../utils/styleCode";
import { TongueLabelReader } from "../stock/TongueLabelReader";
import { STYLE_CODE_LOOKUP_ENABLED } from "../../config/styleCode";
import StyleCodeBypass from "./StyleCodeBypass";
import { serverNowMs } from "../../utils/serverTime";
import { auth } from "../../firebase";
import {
  resolveAddStockTarget, classifyLookupOutcome, labelPhotoEvidence,
  orderCandidatesByColourway,
  TARGET_READY, TARGET_CHOOSE,
  BLOCK_CLAIM_UNAVAILABLE, BLOCK_PRODUCT_UNAVAILABLE,
} from "./styleCodeGateLogic";
import { buildLinkSuggestions } from "../../utils/linkSuggestions";
import CandidateCards from "../shared/CandidateCards";

const resolveStyleCodeFn = httpsCallable(functions, "resolveStyleCode");
// Read-only any-token ownership — the pre-duplicate step's server half
// (review, PR #354): alias-only owners never stamp a product row, so the
// local ranking alone cannot see them.
const labelAliasFn = httpsCallable(functions, "labelAlias");

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

// ─── SIMILAR-PRODUCT CARDS — the pre-duplicate question, one renderer ────────
// (Owner spec 2026-08-13.) Ranked near matches from linkSuggestions.js —
// exact/pending codes, per-size families, one-character misreads, truncated
// reads, the label's printed model name. Shown wherever intake is about to
// open the create form: tapping a card routes to ADD STOCK on that product
// instead. Photo first — the operator is holding the shoe.
//
// THE RENDERER NOW LIVES IN shared/CandidateCards.jsx (2026-08-15). It was
// lifted VERBATIM so the count flow shows the identical list instead of a
// second implementation of the same question; the defaults there are exactly
// what this call site used to pass inline (84px photo, "ADD STOCK →", 6 rows),
// and styleCodeGateSimilar.render.test.jsx pins that this gate's output is
// unchanged. This wrapper keeps the gate's own onAddStock(id) contract.
function SimilarCards({ suggestions, onAddStock }) {
  return <CandidateCards suggestions={suggestions} onPick={(p) => onAddStock(p.id)} />;
}

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
  // Everything ELSE the label offered — colourway line, UPC, model name —
  // extracted by the same read that produced the code. Evidence from the same
  // photo, so it follows the photo's binding: cleared on retake, carried only
  // while the photo still matches the code. The UPC is NON-AUTHORITATIVE by
  // design (this stock reuses one UPC across a size run) — stored, never keyed.
  const [labelExtras, setLabelExtras] = useState(null); // { colorway, upc, modelName }
  // EVERY code-shaped token this label printed (multi-token labels — the
  // Diesel Big D case, owner spec 2026-08-08). Whichever token becomes the
  // canonical code, the others ride into the save as labelOtherCodes and are
  // filed as identities of the same product; evidence-bound to the photo like
  // everything else read off it.
  const [labelAllCodes, setLabelAllCodes] = useState(null);
  // The bypass panel. Deliberately NOT a step in the main flow — it is opened
  // from a subordinate link, and closing it returns to the style code.
  const [bypassOpen, setBypassOpen] = useState(false);
  const [readNote, setReadNote] = useState(null);
  // The pre-form duplicate question (capture-only mode): the payload held back
  // while the operator answers "is it one of these?", plus the ranked matches.
  const [similarStep, setSimilarStep] = useState(null); // { payload, suggestions }

  const normalised = normaliseStyleCode(typed);
  const canSubmit = !!normalised && !busy;
  // The photo counts as evidence ONLY while the code still matches the one it
  // was read from. Everything downstream keys off this, not off labelPhoto.
  const evidencePhoto = labelPhotoEvidence({ labelPhoto, photoForCode, normalised });
  const photoMatchesCode = !!evidencePhoto;
  // Which product the operator tapped, when a code resolves to more than one.
  // Null until they choose — there is deliberately no default.
  const [selectedProductId, setSelectedProductId] = useState(null);

  // ── Tier 1–2: photograph the label — THE SHARED READER ───────────────────
  // This gate used to own a second capture implementation: one file-input
  // photo, no burst, no QR step, and a "Found N possible codes — tap the right
  // one" question. It is now a consumer of the ONE reader every other surface
  // uses (stock/TongueLabelReader.jsx: three-frame burst, ≤1024px downscale,
  // image-hash OCR cache, deterministic head-of-set — never a question). What
  // stays here is what is THIS surface's job: binding the read to the photo as
  // evidence, and keeping the code field the operator can still edit by hand.
  function clearLabelEvidence() {
    // CLEAR THE BINDING FIRST. A retake that fails must not leave the NEW photo
    // paired with the PREVIOUS code — nothing is evidence again until a read
    // succeeds.
    setLabelPhoto(null); setPhotoForCode(null); setLabelExtras(null); setLabelAllCodes(null);
  }
  function takeLabelExtras(meta) {
    const tokens = Array.isArray(meta && meta.tokens) && meta.tokens.length ? meta.tokens : null;
    const colorway = (meta && meta.colorway) || null;
    const upc = (meta && meta.upc) || null;
    const modelName = (meta && meta.modelName) || null;
    // Whatever else this label printed. Server-validated; null means the
    // label simply doesn't print it (most don't). The label's stable word set
    // (owner spec 2026-08-13) feeds the pre-duplicate ranking's name tier.
    setLabelExtras(colorway || upc || modelName || tokens ? { colorway, upc, modelName, tokens } : null);
  }
  function takeLabelRead(code, meta = {}) {
    setError(null); setReadNote(null);
    if (meta.source !== "label") {
      // The reader's own typed escape is hidden here (typed={false}); a
      // non-label source can only be a programmatic caller — treat as typed.
      setTyped(formatStyleCodeForDisplay(code)); clearLabelEvidence();
      return;
    }
    clearLabelEvidence();
    const normalisedCode = normaliseStyleCode(code);
    // VALIDATE BEFORE USE — the reader already did, this is the gate's own
    // guard so a bad deploy on either side cannot put prose in the field.
    if (!normalisedCode || !isKnownStyleCodeFormat(normalisedCode)) {
      setReadNote({ tone: "warn", text: "That photo produced something that isn't a style code. Type it instead." });
      return;
    }
    setLabelPhoto(meta.labelPhoto || null);
    takeLabelExtras(meta);
    const all = Array.isArray(meta.allCodes) && meta.allCodes.length > 1 ? meta.allCodes : null;
    setLabelAllCodes(all);
    setTyped(formatStyleCodeForDisplay(normalisedCode));
    setPhotoForCode(normalisedCode); // this photo IS the evidence for this code
    // ONE line here; the reader above already shows the override chips for a
    // multi-code label, so this note never repeats that question's wording.
    const others = all ? all.length - 1 : 0;
    setReadNote({
      tone: "good",
      text: others > 0
        ? `Read from the label: ${formatStyleCodeForDisplay(normalisedCode)} — and ${others} other number${others === 1 ? "" : "s"} on it ${others === 1 ? "is" : "are"} saved with it. Check it matches the shoe, then continue.`
        : `Read from the label: ${formatStyleCodeForDisplay(normalisedCode)}. Check it matches the shoe, then continue.`,
    });
  }
  // A label with NO code-shaped token but readable wording (≥2 tokens seen in
  // two of three frames). The gate cannot pass on wording alone — the style
  // code is the point of this step — so it keeps the wording as evidence and
  // says plainly what the ways forward are (type the code, or the bypass).
  function takeLabelTokens(tokens, meta = {}) {
    setError(null);
    clearLabelEvidence();
    setLabelPhoto(meta.labelPhoto || null);
    takeLabelExtras({ ...meta, tokens });
    setReadNote({
      tone: "warn",
      text: `No style code on that label — its wording (${tokens.slice(0, 6).join(" ")}) was read. If the label prints a code, type it below; if this shoe has none, use “This shoe has no readable style number”.`,
    });
  }

  // Server half of the pre-duplicate question (review, PR #354): alias-only
  // owners never stamp a product row, so the local ranking cannot see them.
  // Mutates the given suggestion list in place; a failed call leaves it
  // standing. Shared by the capture-only and enforced roads.
  async function addServerOwners(list) {
    try {
      const { data } = await labelAliasFn({
        action: "resolveAnyCode",
        codes: [normalised, ...((photoMatchesCode && labelAllCodes) || [])],
      });
      for (const o of (data && Array.isArray(data.owners) ? data.owners : [])) {
        const p = products.find((x) => x && x.id === o.productId);
        if (p && !list.some((s) => s.product.id === p.id)) {
          list.unshift({
            product: p, code: normaliseStyleCode(o.code) || null, field: "confirmed",
            tier: "exact", score: 105,
            reasons: ["a number on this label already identifies this product"],
          });
        }
      }
    } catch { /* the local ranking still stands */ }
    return list;
  }

  // ── Look the code up ──────────────────────────────────────────────────────
  async function lookup() {
    if (!normalised) return;

    // ── CAPTURE-ONLY MODE ────────────────────────────────────────────────────
    // No round trip, no confirm screen, no comparison. The code goes straight
    // onto the form. There is nothing to look it up against — no product carries
    // a code yet — and the vendor route we call 403s regardless, so the only
    // thing the lookup can produce today is a screen between staff and their
    // job. See config/styleCode.js for why this is off and what turns it on.
    //
    // Uniqueness is unaffected: the create-once claim on /style_code_index still
    // runs at SAVE time and still refuses a code that already belongs to another
    // product. This skips the preview, not the guard.
    if (!STYLE_CODE_LOOKUP_ENABLED) {
      const payload = {
        styleCode: formatStyleCodeForDisplay(normalised),
        styleCodeNormalised: normalised,
        styleCodeSource: "manual",
        styleCodeFetchedAt: serverNowMs(),
        labelPhoto: evidencePhoto,
        // Multi-token label: the other tokens ride along (photo-evidence-bound)
        // so the save can file them as identities of this same product.
        labelOtherCodes: (photoMatchesCode && labelAllCodes
          && labelAllCodes.filter((c) => normaliseStyleCode(c) !== normalised)) || null,
        suggestedName: "", suggestedBrand: null, suggestedImageUrl: null, model: null,
      };
      // ── DUPLICATE CHECK BEFORE THE FORM OPENS (owner spec 2026-08-13) ──────
      // Capture-only mode skips the lookup entirely, so until now the FIRST
      // exact-owner check was the create-once claim at SAVE time — and a
      // per-size sibling, a one-character misread or a truncated read of an
      // existing product's code was never checked at all. That is exactly how
      // one shoe becomes two records. The same ranking the count's link panel
      // runs (linkSuggestions.js — in-memory catalogue, zero reads) asks
      // FIRST; the operator decides. Nothing blocks: "it's a new shoe" is one
      // tap away, and the save-time claim still guards uniqueness.
      // weak rows (shared prefix / shared substring — browsing evidence, see
      // linkSuggestions.js) are dropped HERE: this step BLOCKS with a question,
      // and prefix-cousins would trip it on almost every registration. The
      // loose colourCode tier is NOT weak and does reach it — that is the
      // 745SFA/745SMA label that used to sail into the create form. The count
      // panel keeps the weak rows; only this gate filters.
      const similar = buildLinkSuggestions({
        kind: "code", normalised, includeExact: true,
        modelName: (photoMatchesCode && labelExtras && labelExtras.modelName) || null,
        // EVERY token the label printed asks the duplicate question too (owner
        // spec 2026-08-13): the shoe may be registered under its production
        // line while the operator holds the article code. Photo-evidence-bound
        // like everything read off the label.
        allCodes: (photoMatchesCode && labelAllCodes) || null,
        tokens: (photoMatchesCode && labelExtras && labelExtras.tokens) || null,
        products,
      }).filter((s) => !s.weak);
      // ── ALIAS-ONLY OWNERSHIP IS INVISIBLE TO THE LOCAL SCAN (review,
      // PR #354) ── the count flow files code aliases that never stamp a
      // product row, so the in-memory ranking above cannot see them. One
      // any-token round trip asks the server; a known owner blocks HERE,
      // photo-first, instead of surfacing post-hoc as a duplicate pair after
      // the record exists. Runs on BOTH roads (capture-only and enforced —
      // architect review: fixing only one would re-open the gap the day the
      // lookup flag flips). Best-effort: a failed call leaves the local
      // ranking standing.
      await addServerOwners(similar);
      if (similar.length) {
        setSimilarStep({ payload, suggestions: similar });
        setStep("similar");
        return;
      }
      onProceed(payload);
      return;
    }

    setError(null); setBusy("resolving");
    // The near-match ranking runs on the ENFORCED path too (owner spec
    // 2026-08-13): a Lacoste per-size sibling label is a code the resolver has
    // never seen — the external catalogue may even confirm it as its own SKU —
    // and both roads led straight to the create form. The list renders inside
    // the "unknown" and "found" steps; the resolver's own outcome still rules.
    setSimilarStep({
      payload: null,
      // Same weak-row filter as the capture path — this list renders inside
      // the resolver's own steps and must carry the same meaning there.
      // addServerOwners runs here too (architect review, PR #354): the
      // alias-only gap must not re-open the day the lookup flag flips on.
      suggestions: await addServerOwners(buildLinkSuggestions({
        kind: "code", normalised, includeExact: true,
        modelName: (photoMatchesCode && labelExtras && labelExtras.modelName) || null,
        // Same pooling as the capture path — the list must carry the same
        // meaning on both roads (owner spec 2026-08-13).
        allCodes: (photoMatchesCode && labelAllCodes) || null,
        tokens: (photoMatchesCode && labelExtras && labelExtras.tokens) || null,
        products,
      }).filter((s) => !s.weak)),
    });
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
      // The label's own extras follow the same evidence rule: they came off the
      // photo, so they travel only while the photo still matches the code.
      labelColorway: (photoMatchesCode && labelExtras && labelExtras.colorway) || null,
      labelUpc: (photoMatchesCode && labelExtras && labelExtras.upc) || null,
      labelModelName: (photoMatchesCode && labelExtras && labelExtras.modelName) || null,
      // The label's OTHER code-shaped tokens (multi-token labels). The save
      // files every one as an identity of the new product — whichever token
      // was picked can no longer split one shoe into two records (owner spec
      // 2026-08-08). Same evidence rule as everything read off the photo.
      labelOtherCodes: (photoMatchesCode && labelAllCodes
        && labelAllCodes.filter((c) => normaliseStyleCode(c) !== (result?.normalised || normalised))) || null,
    };
  }

  // Confirm the fetched identity → prefill. Category is NOT taken from here.
  function confirmFetched() {
    const m = result.model || {};
    onProceed({
      ...provenance(result.source === "cache" ? "cache" : result.source === "web-search" ? "websearch" : "api"),
      // PREFER THE VENDOR'S OWN FULL NAME. On the StockX route `model` already
      // contains the brand ("Jordan 4 Retro"), so composing brand + model reads
      // "Jordan Jordan 4 Retro". `name` is the complete title
      // ("Jordan 4 Retro Red Thunder"). The composed form stays as the fallback
      // for cached rows written by the old endpoint, which carry no `name`.
      suggestedName: m.name
        || [m.brand, m.model, m.colorwayName].filter(Boolean).join(" ").trim()
        || m.model || "",
      suggestedBrand: m.brand || null,
      suggestedImageUrl: m.imageUrl || null,
      model: m,
    });
  }

  // Reject the fetched identity → manual entry, code retained.
  function rejectFetched() {
    onProceed({ ...provenance("manual"), suggestedName: "", suggestedBrand: null, suggestedImageUrl: null, model: null });
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
            {!STYLE_CODE_LOOKUP_ENABLED && <>
              <br /><br />The code is <b>saved with the product</b>. We're not looking it up against
              the catalogue yet, so you go straight to the details.
            </>}
          </Note>

          <div>
            <div style={label}>Photograph the tongue label</div>
            {/* THE SHARED READER — the same component, burst and cache as the
                count, register, merge picker and assistant finder. The gate
                owns the code field below, so the reader's typed escape is off. */}
            <TongueLabelReader busy={!!busy} typed={false} onCode={takeLabelRead} onTokens={takeLabelTokens} />
            {labelPhoto && (
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {labelPhoto.dataUrl && (
                  <img src={labelPhoto.dataUrl} alt="label"
                       style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 10,
                                border: "1px solid rgba(60,110,255,.25)",
                                opacity: photoMatchesCode ? 1 : 0.4 }} />
                )}
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
            {busy === "resolving" ? "Checking…"
              : STYLE_CODE_LOOKUP_ENABLED ? "Continue" : "Save this code and continue"}
          </button>
          {/* ── THE BYPASS ────────────────────────────────────────────────
              A SUBORDINATE LINK, never a button of equal weight beside scan and
              manual entry. The one that never fails becomes the default within a
              week if it looks as easy as doing the job properly — so it reads as
              an exception, and costs more taps. */}
          {!bypassOpen && (
            <button type="button" onClick={() => setBypassOpen(true)}
              style={{ ...meta, fontSize: 12, background: "none", border: "none",
                       color: "rgba(233,238,255,.42)", cursor: "pointer", padding: "10px 4px",
                       textDecoration: "underline", textUnderlineOffset: 3, alignSelf: "center" }}>
              This shoe has no style code
            </button>
          )}

          {bypassOpen && (
            <StyleCodeBypass
              products={products}
              onCancel={() => setBypassOpen(false)}
              onConfirm={({ name, reason }) => onProceed({
                styleCode: "", styleCodeNormalised: "", styleCodeSource: "manual",
                styleCodeFetchedAt: serverNowMs(), labelPhoto: null,
                // The exemption, recorded so the bypass rate is countable.
                exempt: { reason, by: auth.currentUser?.uid ?? null, at: serverNowMs() },
                suggestedName: name, suggestedBrand: null, suggestedImageUrl: null, model: null,
              })}
            />
          )}

          <button type="button" onClick={onCancel}
            style={{ ...meta, background: "none", border: "none", cursor: "pointer", padding: 8 }}>
            Cancel
          </button>
        </>
      )}

      {/* ── STEP: SIMILAR — close matches found BEFORE the form opens ─────
          (Owner spec 2026-08-13.) Capture-only mode used to go straight to the
          create form; the only guard was the exact claim at save time. These
          are the near matches that guard can never see — exact codes still
          awaiting confirmation, per-size siblings, one-character misreads,
          truncated reads, the label's own printed model name. Tapping one
          routes to ADD STOCK on that product; "it's a new shoe" continues to
          the form with the code kept. Nothing is decided silently. */}
      {step === "similar" && similarStep && (
        <>
          <Note tone="warn">
            <b>Check before creating a new product.</b> {similarStep.suggestions.length === 1
              ? "One product in the catalogue looks like this code's shoe."
              : `${similarStep.suggestions.length} products in the catalogue look like this code's shoe.`}{" "}
            A duplicate splits one shoe's stock across two records — if it's one of these, add stock
            to it instead.
          </Note>

          <SimilarCards suggestions={similarStep.suggestions} onAddStock={onAddStock} />

          <button type="button" onClick={() => { setSimilarStep(null); onProceed(similarStep.payload); }}
            style={btn("rgba(74,222,128,.14)", "#B7F0CC", { border: "2px solid rgba(74,222,128,.5)" })}>
            None of these — it's a new shoe, open the form
          </button>
          <button type="button" onClick={() => { setSimilarStep(null); setStep("enter"); }}
            style={{ ...meta, background: "none", border: "none", cursor: "pointer", padding: 8 }}>
            ← Different code
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
        // ORDERED, never filtered: the label's colourway line (when it printed
        // one) puts the likely match first. Selection stays with the human and
        // with resolveAddStockTarget's fail-closed rules — ordering is cosmetic
        // by contract.
        const cards = orderCandidatesByColourway(
          existing.length ? existing : (claimedProduct ? [claimedProduct] : []),
          labelExtras && photoMatchesCode ? labelExtras.colorway : null
        );
        const ownerCount = Array.isArray(result.owners) ? result.owners.length : 0;
        return (
          <>
            <Note tone="good">
              <b>We already have this shoe.</b> Add stock to it rather than creating a second record.
            </Note>

            {ownerCount > 1 && !result.duplicate && (
              <Note>
                <b>{ownerCount} colourways share this style code</b> — that's how this stock is labelled,
                nothing is wrong. Pick the one you're holding.
              </Note>
            )}

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
            {/* NONE OF THESE — a NEW colourway of an already-claimed code.
                (Owner spec 2026-08-07: same code + different colourway is NOT
                a duplicate.) Subordinate on purpose — add-stock is the common
                case; this is the escape for the shoe the catalogue lacks. The
                form opens with the code kept and a sibling marker: the save
                registers this product as a SIBLING owner instead of losing the
                create-once claim race and alerting about a merge. */}
            {result.claim && result.claim.productId && (
              <button type="button"
                onClick={() => onProceed({
                  ...provenance("manual"),
                  sibling: { primaryId: result.claim.productId },
                  suggestedName: [
                    (labelExtras && photoMatchesCode && labelExtras.modelName) || "",
                    (labelExtras && photoMatchesCode && labelExtras.colorway) || "",
                  ].filter(Boolean).join(" ").trim(),
                  suggestedBrand: null, suggestedImageUrl: null, model: null,
                })}
                style={{ ...meta, fontSize: 12, background: "none", border: "none",
                         color: "rgba(233,238,255,.42)", cursor: "pointer", padding: "10px 4px",
                         textDecoration: "underline", textUnderlineOffset: 3, alignSelf: "center" }}>
                None of these — it's a new colourway of this code
              </button>
            )}
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

          {/* The vendor knowing the code does NOT mean WE don't have the shoe:
              a per-size sibling's label is its own SKU out there but the same
              physical shoe in here. Confirming would create the duplicate. */}
          {similarStep && similarStep.suggestions.length > 0 && (
            <>
              <Note tone="warn">
                <b>We may already have this shoe</b> — the code is close to {similarStep.suggestions.length === 1
                  ? "one product" : `${similarStep.suggestions.length} products`} in our own catalogue.
                If it's one of these, add stock to it instead of confirming a new record.
              </Note>
              <SimilarCards suggestions={similarStep.suggestions} onAddStock={onAddStock} />
            </>
          )}

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
          {similarStep && similarStep.suggestions.length > 0 && (
            <>
              <Note tone="warn">
                <b>But check these first</b> — some brands print a different code per size, and a
                one-character misread looks exactly like a new code. If it's one of these, add stock
                instead of creating a duplicate.
              </Note>
              <SimilarCards suggestions={similarStep.suggestions} onAddStock={onAddStock} />
            </>
          )}
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
