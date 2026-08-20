// ─── AI STUDIO, ON THE SHOPIFY PRODUCT PAGE ──────────────────────────────────
// The photo regenerator that lives in the AI Studio view, brought to the photo
// the reviewer is actually about to publish. Same two presets, same fix chips,
// same free-text instruction, same Cloud Function — the shared vocabulary and
// call-shaping are in aiStudioCore.js so neither surface can drift from the
// other. What is local to this file is the chrome: this page is built from
// stock/ui.js tokens and AI Studio is not.
//
// It REPLACES the "Clean background" action that used to sit in the photo
// strip's chip row. That action was safe and it was honest — the pixel gate
// discarded anything where the model had redrawn the product — but on real
// shop photographs it discarded everything, because a backdrop swap on a
// racked photo IS a re-render and a re-render never survives a pixel
// comparison. A tool that correctly produces nothing is not a tool.
//
// ── THE ONE RULE THIS CARD IS BUILT AROUND ───────────────────────────────────
// Nothing generated is used until Junid has seen it and said so. The function
// writes the new image to its OWN Storage object and records a proposal; it
// never edits the product, never edits the publishing set, never overwrites or
// deletes an original. This card shows the result beside the photo it was made
// from and then waits. Accepting uploads ANOTHER new object into the product's
// publishing folder with `derivedFrom` recording where it came from, and only
// then changes the publishing list. Every original survives in Storage, in the
// product record, and — if the reviewer chooses "Add as another photo" —
// in the publishing set too.
//
// ── THE FREE TEXT NEVER REACHES SHOPIFY ──────────────────────────────────────
// The instruction box feeds the image model's prompt and nothing else. The
// fields that DO travel to Shopify are the alt text (the cleaned listing name,
// which goes through the trigger validator on this same page) and the file
// name (a generated id — `gen_<ts>_<rand>.jpg` — never any typed text). So a
// brand word typed here cannot reach the storefront through this path, and
// aiStudioCore.test.js pins that.
import React, { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { FONT, GRAY, RED, BLUE_L, GREEN, bBlue, bGray, bGreen, tabOn, tabOff, input as inputStyle } from "../stock/ui";
import { uploadPublishPhoto } from "./photoTools";
import { MAX_PUBLISH_PHOTOS } from "./publishShared";
import {
  PHOTO_PRESETS, PHOTO_ENGINES, FIX_PRESETS, NOTE_MAX, STYLE_HOUSE,
  toggleFix, sanitiseNote, buildGenerateRequest, readGenerateResult,
} from "./aiStudioCore";

const SECTION_LABEL = {
  fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase",
  color: GRAY, fontWeight: 700,
};

const generateCall = httpsCallable(functions, "generateProductPhotos");

/**
 * @param product      the product record (needs `id`; `category`/`productType`
 *                     only to explain which house template will be used)
 * @param sourceUrl    the publishing photo the reviewer has selected — the
 *                     image to re-shoot, and the one the result is compared to
 * @param photoCount   how many photos the publishing set already holds, so
 *                     "Add as another photo" can be refused at the cap rather
 *                     than failing after a paid generation
 * @param busy         the parent strip is mid-write
 * @param onReplace    (newUrl, sourceUrl) => Promise<boolean> — swap this slot
 * @param onAdd        (newUrl) => Promise<boolean> — append, keeping the original
 */
export default function AiStudioCard({ product, sourceUrl, photoCount = 0, busy = false, onReplace, onAdd }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(PHOTO_PRESETS[0].key);
  const [engine, setEngine] = useState("auto");
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  // { proposedUrl, sourceUrl, engine, costUSD } — held in component state, not
  // written anywhere. The image itself is already a permanent Storage object
  // (and is listed in AI Studio's own review lane), so navigating away loses
  // the side-by-side, never the picture.
  const [candidate, setCandidate] = useState(null);

  const house = style === STYLE_HOUSE;
  const preset = PHOTO_PRESETS.find((p) => p.key === style) || PHOTO_PRESETS[0];
  const isClothing = product?.category === "Clothing" || product?.productType === "clothing";

  // A candidate belongs to ONE source photo. If the selection moves under an
  // open candidate, drop it — accepting a re-shoot of photo A into photo B's
  // slot is exactly the mix-up the side-by-side exists to prevent.
  useEffect(() => {
    setCandidate((cur) => (cur && cur.sourceUrl !== sourceUrl ? null : cur));
  }, [sourceUrl]);

  // Don't leave a stale error or a spent candidate behind a closed card.
  const closeCard = () => { setOpen(false); setCandidate(null); setErr(null); setMsg(null); };

  // Synchronous guard: a second tap lands before React re-renders the disabled
  // state, and a double generation is a double charge.
  const runningRef = useRef(false);

  const generate = async () => {
    if (runningRef.current || generating || busy || !product?.id || !sourceUrl) return;
    runningRef.current = true;
    setGenerating(true); setErr(null); setMsg(null);
    try {
      const res = await generateCall(buildGenerateRequest({
        productId: product.id, style, engine, note, sourceUrl,
      }));
      const out = readGenerateResult(res?.data, product.id);
      if (!out.ok) { setErr(out.problem); return; }
      setCandidate({ proposedUrl: out.proposedUrl, sourceUrl, engine: out.engine, costUSD: out.costUSD });
      setMsg(`Generated${out.engine ? ` on ${out.engine}` : ""} — about $${out.costUSD.toFixed(4)}${out.costLine}. Nothing has changed yet.`);
    } catch (e) {
      const m = String(e?.message || e);
      setErr(/internal|not-found/i.test(m)
        ? `${m} — is generateProductPhotos deployed?`
        : m);
    } finally {
      setGenerating(false);
      runningRef.current = false;
    }
  };

  // Copy the generated image into the product's PUBLISHING folder and hand the
  // URL to the list. The copy is deliberate: it records `derivedFrom` in the
  // object's metadata and keeps the publishing set inside the one Storage
  // prefix media.mjs allows, instead of pointing the storefront at the
  // proposal object the Studio's own review lane is also holding.
  const useIt = async (mode) => {
    if (!candidate || saving) return;
    if (mode === "add" && photoCount >= MAX_PUBLISH_PHOTOS) {
      setErr(`At most ${MAX_PUBLISH_PHOTOS} photos per product — replace one instead.`);
      return;
    }
    setSaving(true); setErr(null);
    try {
      const res = await fetch(candidate.proposedUrl);
      if (!res.ok) throw new Error(`could not read the generated image back (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = await uploadPublishPhoto(product.id, blob, { kind: "gen", derivedFrom: candidate.sourceUrl });
      // Only a COMMITTED list write consumes the candidate — a refused write
      // shows its error and keeps the side-by-side up for another go.
      const committed = mode === "add" ? await onAdd(url) : await onReplace(url, candidate.sourceUrl);
      if (committed) {
        setCandidate(null);
        setMsg(mode === "add"
          ? "Added to the publishing set. The photo it came from is still there."
          : "This slot now uses the new photo. The original is untouched in Storage and on the product record.");
      }
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const chip = (label, on, onClick, key) => (
    <button key={key ?? label} type="button" disabled={busy || generating || saving} onClick={onClick}
      style={{ ...(on ? tabOn : tabOff), padding: "5px 11px", fontSize: "0.68rem" }}>
      {on ? "✓ " : ""}{label}
    </button>
  );

  if (!sourceUrl) return null;

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)}
        style={{ ...tabOff, padding: "4px 9px", fontSize: "0.66rem" }}>
        ✦ AI Studio
      </button>
    );
  }

  return (
    <div style={{ width: "100%", marginTop: 8, border: "1px solid rgba(74,127,255,.28)", borderRadius: 13,
                  background: "rgba(74,127,255,.05)", padding: "13px 13px 14px", fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".12em", color: BLUE_L }}>✦ AI STUDIO</div>
          <div style={{ fontSize: 10.5, color: GRAY, marginTop: 2 }}>
            Re-shoots the selected photo. Nothing changes until you accept it.
          </div>
        </div>
        <button type="button" onClick={closeCard} aria-label="Close AI Studio"
          style={{ ...tabOff, padding: "3px 10px", fontSize: "0.72rem" }}>×</button>
      </div>

      <div style={SECTION_LABEL}>Preset</div>
      <div style={{ display: "flex", gap: 6, margin: "6px 0 3px" }}>
        {PHOTO_PRESETS.map((p) => chip(p.label, style === p.key, () => setStyle(p.key), p.key))}
      </div>
      <div style={{ fontSize: 10, color: GRAY, marginBottom: 11 }}>
        {preset.hint} · about ${preset.costUSD.toFixed(3)} an image
        {house && (
          <> · uses the {isClothing ? "clothing" : "sneaker"} Style Kit references
            {isClothing ? "" : ", plus this product's own box photo if one is saved"}.
            Manage the references in AI Studio.</>
        )}
      </div>

      {!house && (
        <>
          <div style={SECTION_LABEL}>Which AI</div>
          <div style={{ display: "flex", gap: 6, margin: "6px 0 11px" }}>
            {PHOTO_ENGINES.map(([val, label, hint]) =>
              chip(`${label} · ${hint}`, engine === val, () => setEngine(val), val))}
          </div>
        </>
      )}

      <div style={SECTION_LABEL}>What needs fixing <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500 }}>— tap any</span></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "6px 0 11px" }}>
        {FIX_PRESETS.map(([label, instr]) =>
          chip(label, note.includes(instr), () => setNote((n) => toggleFix(n, instr)), label))}
      </div>

      <div style={SECTION_LABEL}>Or tell it exactly what you want</div>
      <textarea
        value={note}
        disabled={busy || generating || saving}
        onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
        maxLength={NOTE_MAX}
        rows={2}
        placeholder="e.g. shoot it straight on, laces tucked in, keep the sole cream"
        style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginTop: 6,
                 fontSize: "0.8rem", resize: "vertical", fontFamily: FONT,
                 border: note.trim() ? "1px solid rgba(74,127,255,.5)" : inputStyle.border }} />
      <div style={{ fontSize: 9.5, color: GRAY, marginTop: 3 }}>
        {sanitiseNote(note).length}/{NOTE_MAX} · goes to the image model only — never to Shopify
      </div>

      <button type="button" disabled={busy || generating || saving} onClick={generate}
        style={{ ...bBlue, padding: "9px 14px", fontSize: "0.76rem", marginTop: 11,
                 opacity: generating ? 0.55 : 1, cursor: generating ? "wait" : "pointer" }}>
        {generating ? "Generating… (this takes a while)" : `✦ Regenerate — ${preset.label.toLowerCase()} (~$${preset.costUSD.toFixed(3)})`}
      </button>

      {candidate && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...SECTION_LABEL, fontSize: 9.5, marginBottom: 3 }}>The photo now</div>
              <img src={candidate.sourceUrl} alt="" style={{ width: "100%", borderRadius: 9, background: "rgba(255,255,255,.08)" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...SECTION_LABEL, fontSize: 9.5, marginBottom: 3, color: BLUE_L }}>Generated</div>
              <img src={candidate.proposedUrl} alt="" style={{ width: "100%", borderRadius: 9, background: "rgba(255,255,255,.08)" }} />
            </div>
          </div>
          <div style={{ fontSize: 10, color: GRAY, marginTop: 6, lineHeight: 1.45 }}>
            Check the product itself, not the background: the item a customer receives has to be the
            item in this picture. If a logo, a colour, a shape or any wear has changed, throw it away.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
            <button type="button" disabled={saving} onClick={() => setCandidate(null)}
              style={{ ...bGray, padding: "7px 11px", fontSize: "0.72rem" }}>Throw away</button>
            <button type="button" disabled={saving} onClick={() => useIt("add")}
              style={{ ...bGreen, padding: "7px 11px", fontSize: "0.72rem" }}>
              {saving ? "Saving…" : "Add as another photo"}
            </button>
            <button type="button" disabled={saving} onClick={() => useIt("replace")}
              style={{ ...bBlue, padding: "7px 11px", fontSize: "0.72rem" }}>
              {saving ? "Saving…" : "Use instead of this one"}
            </button>
          </div>
        </div>
      )}

      {msg && <div style={{ fontSize: 10.5, color: candidate ? BLUE_L : GREEN, marginTop: 8, fontWeight: 600 }}>{msg}</div>}
      {err && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 8 }}>{err}</div>}
    </div>
  );
}
