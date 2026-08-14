// ─── SHOPIFY PUBLISHING — THE FULL-PAGE TAB ──────────────────────────────────
// Junid's review surface for the one-way Shopify push (owner spec 2026-08-14):
// a home-row entry opens THIS page, where the whole catalogue is reviewable
// one name at a time. Layout is one column — a sticky header (search + state
// filter) over the catalogue grouped into collapsible category sections, all
// collapsed until opened.
//
// The primary path is the KEYBOARD: Enter approves the name under the cursor
// and moves focus to the next unreviewed one — thousands of names get through
// on Enter alone. The row's button is the single PUBLISH action (the old
// Approve → Nominate → Live chain is collapsed): it opens the one confirmation
// dialog this page allows and then writes desiredState INTENT only. The
// owner-run reconciler (scripts/shopify/reconcile.mjs) is what actually talks
// to Shopify — the browser cannot hold the client secret and NEVER calls
// Shopify — and the row shows pending until it confirms. The Live filter
// splits into On and Off groups; each live row carries an on/off switch
// (off is instant intent, on re-confirms like Publish).
//
// LOAD DISCIPLINE (hard requirement — this is the read pattern that keeps the
// Firebase bill flat): nothing whole-node, nothing eager.
//   · The catalogue itself arrives via the app-wide /products subscription in
//     App.jsx (the `products` prop) — this page adds NO catalogue read.
//   · /shopify_publish is read in three partial slices (see the store):
//     indexed per-state queries for the pipeline, a REST shallow KEY list for
//     the awaiting-review counts, and per-pid bodies fetched only when a
//     category section expands. Thumbnails carry loading="lazy".
//
// Structure and styling match the existing full-page views: the top bar and
// Thumb follow LabelPrintView.jsx, rows use the home list's separator
// treatment (RoleCard in App.jsx), and every colour/spacing value comes from
// stock/ui.js. Writes go ONLY to /shopify_publish, through the store.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FONT, GRAY, GREEN, RED, BLUE_L, GLASS_SOLID, tabOn, tabOff, input as inputStyle, bBlue, bGray, bGreen } from "../stock/ui";
import { cleanTitleFor } from "../../utils/shopifyTriggers";
import {
  CONDITIONS, STATE_FILTERS, checkCleanName, blockedReason, reviewStateFor, matchesStateFilter,
  normalizedState, isOn, isPendingSwitch, canGoLive, batchSelectBlocker, effectivePhotoList,
} from "./shopifyPublishCore";
import { RECONCILE_MAX_APPLY, MAX_PUBLISH_PHOTOS } from "./publishShared";
import {
  loadPipelineNodes, loadPublishKeys, loadNodesFor, approveName, publishProduct, setDesiredState, setCondition,
  setPublishPhotos,
} from "./shopifyPublishStore";
import { uploadFileProblem, compressImageFile, uploadPublishPhoto } from "./photoTools";
import { isCleanBackgroundAvailable, cleanBackground } from "./geminiClean";

const UNCAT = "Uncategorised";

// Row state chips — live/blocked keep the old pipeline colours; the review
// states use the neutral text tones from stock/ui's buttons. "publishing" and
// "switching" are the pending marker: an intent written, the reconciler not
// yet run.
const STATE_BADGE = {
  awaiting:   { label: "awaiting review", color: GRAY,    border: "rgba(255,255,255,.18)" },
  approved:   { label: "approved",        color: "#dfe7ff", border: "rgba(255,255,255,.3)" },
  publishing: { label: "publishing…",     color: BLUE_L,  border: "rgba(74,127,255,.5)" },
  switching:  { label: "switching…",      color: BLUE_L,  border: "rgba(74,127,255,.5)" },
  on:         { label: "ON — LIVE",       color: GREEN,   border: "rgba(74,222,128,.8)" },
  off:        { label: "off",             color: GRAY,    border: "rgba(255,255,255,.18)" },
  blocked:    { label: "blocked",         color: RED,     border: "rgba(248,113,113,.55)" },
};

// The chip a node shows: pending intent wins (that's what Junid is waiting
// on), then on/off for live products, then the review state.
function chipFor(state, node) {
  if (isPendingSwitch(node)) return state === "live" ? "switching" : "publishing";
  if (state === "live") return isOn(node) ? "on" : "off";
  return state;
}

function StateChip({ chip }) {
  const b = STATE_BADGE[chip] || STATE_BADGE.awaiting;
  return (
    <span style={{ fontSize: 9.5, fontWeight: 800, color: b.color, border: `1px solid ${b.border}`,
                   borderRadius: 8, padding: "3px 7px", whiteSpace: "nowrap", flexShrink: 0 }}>
      {b.label.toUpperCase()}
    </span>
  );
}

// Same thumbnail treatment as LabelPrintView, plus lazy loading — rows exist
// by the hundred per section and must not fetch a photo until scrolled to.
// Shows the PUBLISHING primary (first of the effective photo set), so a
// custom-ordered set changes what the row leads with — the thumb never lies
// about what the storefront would lead with.
function Thumb({ p, node }) {
  const primary = effectivePhotoList(p, node).photos[0];
  if (primary) {
    return <img src={primary} alt="" loading="lazy"
                style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 10, flexShrink: 0 }}
                onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  }
  return <div style={{ width: 44, height: 44, borderRadius: 10, background: "rgba(120,150,255,.08)",
                       display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{p?.photo || "👟"}</div>;
}

// The name Junid is signing off for a product: an already-saved cleanName
// wins, else the lexicon's automatic clean, else empty (needs typing).
function effectiveNameFor(product, node) {
  if (node?.cleanName) return { name: node.cleanName, source: node.cleanNameSource || "manual" };
  const lex = cleanTitleFor(product);
  if (!lex.needsAI) return { name: lex.title, source: "lexicon" };
  return { name: "", source: "manual", needsAI: true, reason: lex.reason };
}

// What the storefront would show — the facts the confirmation dialog states.
// The photo count prices the EFFECTIVE publishing set (custom list when one
// exists, else the record's photos) — the same set the reconciler pushes.
function publicFacts(product, node, name) {
  const price = Number(product?.retailPrice);
  return {
    name,
    condition: node?.condition || null,
    price: price > 0 ? `R ${price.toFixed(2)}` : "no price set",
    photoCount: effectivePhotoList(product, node).photos.length,
  };
}

// ─── THE ONE CONFIRMATION DIALOG ─────────────────────────────────────────────
// This page's rule is NO MODALS — with one deliberate exception (owner spec
// 2026-08-14): going live. Publishing puts a name on the PUBLIC storefront
// and the name is the compliance-critical field, so it is the most prominent
// thing here and the reviewer confirms it one last time. Nothing else on the
// page may grow a dialog; switching OFF never asks (it only reduces
// exposure). Cancel is the default focus — Enter must never publish blind.
function PublishConfirmDialog({ facts, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.62)",
               backdropFilter: "blur(5px)", WebkitBackdropFilter: "blur(5px)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ ...GLASS_SOLID, width: "100%", maxWidth: 420, padding: "22px 20px", fontFamily: FONT }}>
        <div style={{ fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700 }}>
          Put on the public storefront?
        </div>
        <div style={{ fontSize: 19, fontWeight: 800, color: "#fff", marginTop: 10, lineHeight: 1.3, overflowWrap: "break-word" }}>
          {facts.name}
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.75)", marginTop: 12 }}>
          {facts.condition || "— no condition set —"}
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.75)", marginTop: 4 }}>
          {facts.price} · {facts.photoCount} photo{facts.photoCount === 1 ? "" : "s"}
        </div>
        <div style={{ fontSize: 11.5, color: GRAY, marginTop: 12, lineHeight: 1.45 }}>
          This makes the product publicly visible on the online store, under exactly the
          name above. Check the name once more — it is what the compliance rules protect.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button ref={cancelRef} onClick={onCancel} disabled={busy} style={{ ...bGray, flex: 1 }}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{ ...bGreen, flex: 1 }}>
            {busy ? "Saving…" : "Put it live"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── PHOTO STRIP ─────────────────────────────────────────────────────────────
// The row's publishing photo set, opened on demand. Interaction pattern is
// the repo's own: the thumbnail strip (52px thumbs, white active border,
// dimmed rest) is GalleryLightbox's strip from App.jsx; tap a thumb to
// select it, then act on it with chips — the tap-to-act chip treatment of
// the AI Studio Style Kit reference grid. Reordering is the lightbox's ‹ ›
// glyph pair on the SELECTED thumb (no drag interaction exists anywhere in
// the repo to match). First photo is primary, marked.
//
// Every action writes the full ordered list to /shopify_publish/{pid}/photos
// through the store's transaction — NEVER to /products, never a blind set().
// Removing only removes from the publishing set (the product record and
// Storage keep the file); the last photo cannot be removed (imageless never
// ships). Locked while the listing is ON, like the name and condition.
function PhotoStrip({ product, node, locked, onChanged }) {
  const { photos, custom } = effectivePhotoList(product, node);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const write = async (nextList, after) => {
    setBusy(true); setErr(null);
    try {
      const res = await setPublishPhotos(product.id, node, nextList);
      if (!res?.ok) { setErr(res?.message || "Not saved."); return; }
      onChanged(product.id, res.node);
      after?.();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= photos.length) return;
    const next = [...photos];
    [next[i], next[j]] = [next[j], next[i]];
    write(next, () => setSel(j));
  };
  const makePrimary = (i) => {
    const next = [photos[i], ...photos.filter((_, k) => k !== i)];
    write(next, () => setSel(0));
  };
  const removeAt = (i) => {
    if (photos.length === 1) {
      setErr("A product never ships imageless — add another photo before removing this one.");
      return;
    }
    write(photos.filter((_, k) => k !== i), () => setSel(null));
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = uploadFileProblem(file);
    if (problem) { setErr(problem); return; }
    if (photos.length >= MAX_PUBLISH_PHOTOS) { setErr(`At most ${MAX_PUBLISH_PHOTOS} photos per product.`); return; }
    setUploading(true); setErr(null);
    try {
      const blob = await compressImageFile(file);
      const url = await uploadPublishPhoto(product.id, blob);
      await write([...photos, url]);
    } catch (ex) {
      setErr(String(ex?.message || ex));
    } finally {
      setUploading(false);
    }
  };

  const chip = (label, onClick, disabled = false) => (
    <button key={label} disabled={busy || uploading || disabled} onClick={onClick}
      style={{ ...tabOff, padding: "4px 9px", fontSize: "0.66rem" }}>
      {label}
    </button>
  );

  return (
    <div style={{ marginTop: 8, padding: "8px 0 2px", borderTop: "1px solid rgba(255,255,255,.04)" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        {photos.map((u, i) => (
          <div key={u} style={{ position: "relative" }}>
            <img src={u} alt="" loading="lazy"
              onClick={() => !locked && setSel(sel === i ? null : i)}
              style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 9,
                       cursor: locked ? "default" : "pointer", background: "rgba(255,255,255,.08)",
                       border: sel === i ? "2px solid #fff" : "2px solid transparent",
                       opacity: sel === null || sel === i ? 1 : 0.55 }} />
            {i === 0 && (
              <div style={{ position: "absolute", left: 2, bottom: 2, fontSize: 8, fontWeight: 800,
                            color: GREEN, background: "rgba(0,0,0,.62)", borderRadius: 5, padding: "1px 4px" }}>
                PRIMARY
              </div>
            )}
          </div>
        ))}
        {!locked && (
          <>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp"
              onChange={handleFile} style={{ display: "none" }} />
            <button disabled={busy || uploading} onClick={() => fileRef.current?.click()}
              style={{ width: 52, height: 52, borderRadius: 9, cursor: "pointer", fontFamily: FONT,
                       background: "rgba(255,255,255,.03)", border: "1px dashed rgba(255,255,255,.18)",
                       color: GRAY, fontSize: 20 }}>
              {uploading ? "…" : "＋"}
            </button>
          </>
        )}
      </div>
      {locked && (
        <div style={{ fontSize: 10, color: GRAY, marginTop: 5 }}>
          Listing is ON — switch it off to change photos. The reconciler re-syncs them at the next turn-on.
        </div>
      )}
      {!locked && (
        <div style={{ fontSize: 10, color: GRAY, marginTop: 5 }}>
          {custom
            ? "Custom publishing set — the product record's own photos are untouched."
            : "Showing the product record's photos. Any change saves a publishing copy; the record is never edited."}
        </div>
      )}
      {!locked && sel !== null && photos[sel] && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
          {chip("‹ Move", () => move(sel, -1), sel === 0)}
          {chip("Move ›", () => move(sel, 1), sel === photos.length - 1)}
          {chip("Make primary", () => makePrimary(sel), sel === 0)}
          {chip("Remove from publish set", () => removeAt(sel))}
          <CleanBackgroundAction
            productId={product.id} originalUrl={photos[sel]}
            busy={busy || uploading} setErr={setErr}
            onReplace={(url, sourceUrl) => write(photos.map((u) => (u === sourceUrl ? url : u)))} />
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>{err}</div>}
    </div>
  );
}

// ─── CLEAN BACKGROUND (Gemini) ───────────────────────────────────────────────
// One photo at a time, no bulk generate. The flow the truthfulness rule
// demands (see geminiClean.js): generate → AUTOMATIC subject-preservation
// gate (a result whose product region changed is discarded with a logged
// reason and never shown) → side-by-side against the original → EXPLICIT
// accept. Accepting uploads a NEW Storage object beside the original
// (derivedFrom recorded) and swaps only this slot of the publishing set —
// the original photo survives in the record, in Storage, everywhere.
// Without GEMINI_API_KEY at build time the chip is disabled with a plain
// message and the rest of the strip works untouched.
function CleanBackgroundAction({ productId, originalUrl, busy, setErr, onReplace }) {
  const available = isCleanBackgroundAvailable();
  const [generating, setGenerating] = useState(false);
  const [candidate, setCandidate] = useState(null); // { blob, previewUrl, metrics, sourceUrl }
  const [saving, setSaving] = useState(false);

  const discardCandidate = () => {
    setCandidate((cur) => {
      if (cur) URL.revokeObjectURL(cur.previewUrl);
      return null;
    });
  };

  // A candidate belongs to ONE source photo. If the selection moves under an
  // open candidate, drop it — accepting a cleaned copy of photo A into photo
  // B's slot would be exactly the mix-up the side-by-side exists to prevent.
  useEffect(() => {
    if (candidate && candidate.sourceUrl !== originalUrl) discardCandidate();
  }, [originalUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  // Unmount revokes an un-actioned candidate's object URL (state updaters
  // don't run after unmount, so track the URL in a ref).
  const previewRef = useRef(null);
  previewRef.current = candidate?.previewUrl || null;
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);

  const generate = async () => {
    if (generating || busy) return;
    setGenerating(true); setErr(null);
    try {
      const res = await cleanBackground(originalUrl);
      if (!res.ok) {
        setErr(`The generated image changed the product and was discarded (${res.reason}). The original stays as it is — you can try again.`);
        return;
      }
      setCandidate({ ...res, sourceUrl: originalUrl });
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setGenerating(false);
    }
  };

  const accept = async () => {
    if (!candidate || saving) return;
    setSaving(true); setErr(null);
    try {
      const url = await uploadPublishPhoto(productId, candidate.blob, { kind: "gen", derivedFrom: candidate.sourceUrl });
      await onReplace(url, candidate.sourceUrl);
      discardCandidate();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button disabled={!available || busy || generating}
        onClick={generate}
        title={available ? undefined : "GEMINI_API_KEY was not set when this app was built — the action is disabled."}
        style={{ ...tabOff, padding: "4px 9px", fontSize: "0.66rem", opacity: available ? 1 : 0.4 }}>
        {generating ? "Generating…" : "Clean background"}
      </button>
      {!available && (
        <span style={{ fontSize: 10, color: GRAY, alignSelf: "center" }}>
          background cleanup off — no GEMINI_API_KEY at build
        </span>
      )}
      {candidate && (
        <div style={{ width: "100%", marginTop: 7 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700, marginBottom: 3 }}>Original</div>
              <img src={candidate.sourceUrl} alt="" style={{ width: "100%", borderRadius: 9, background: "rgba(255,255,255,.08)" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700, marginBottom: 3 }}>Cleaned background</div>
              <img src={candidate.previewUrl} alt="" style={{ width: "100%", borderRadius: 9, background: "rgba(255,255,255,.08)" }} />
            </div>
          </div>
          <div style={{ fontSize: 10, color: GRAY, marginTop: 5 }}>
            The product region matched the original (checked automatically). Look once more — accept only if the item is untouched.
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button disabled={saving} onClick={discardCandidate} style={{ ...bGray, padding: "7px 11px", fontSize: "0.72rem" }}>Discard</button>
            <button disabled={saving} onClick={accept} style={{ ...bBlue, padding: "7px 11px", fontSize: "0.72rem" }}>
              {saving ? "Saving…" : "Use cleaned photo"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── BATCH CONFIRMATION ──────────────────────────────────────────────────────
// The SAME going-live confirmation as the single publish — same overlay, same
// Cancel-default-focus, same "public storefront" statement — listing every
// product about to go on, each under its cleaned name (every one is a
// compliance decision; the list is the last look). A batch of N is N
// independent publish intents: the reconciler validates each product on its
// own and any one can be refused (blocked) without touching the others.
function BatchPublishConfirmDialog({ items, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.62)",
               backdropFilter: "blur(5px)", WebkitBackdropFilter: "blur(5px)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ ...GLASS_SOLID, width: "100%", maxWidth: 460, padding: "22px 20px", fontFamily: FONT }}>
        <div style={{ fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700 }}>
          Put {items.length} product{items.length === 1 ? "" : "s"} on the public storefront?
        </div>
        <div style={{ maxHeight: "42vh", overflowY: "auto", marginTop: 12 }}>
          {items.map((it) => (
            <div key={it.pid} style={{ padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", lineHeight: 1.3, overflowWrap: "break-word" }}>
                {it.name}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.75)", marginTop: 2 }}>
                {it.condition} · {it.price}
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: GRAY, marginTop: 12, lineHeight: 1.45 }}>
          Every product above becomes publicly visible on the online store, under exactly the
          name shown. Check each name once more — the names are what the compliance rules protect.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button ref={cancelRef} onClick={onCancel} disabled={busy} style={{ ...bGray, flex: 1 }}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{ ...bGreen, flex: 1 }}>
            {busy ? "Saving…" : `Put ${items.length} live`}
          </button>
        </div>
      </div>
    </div>
  );
}

// One product's review row. Everything is inline: the cleaned name is a live
// input with the trigger check on every keystroke, condition is three chips,
// the primary action is PUBLISH (behind the page's one confirmation dialog).
// Live rows carry the on/off switch instead — off writes intent immediately,
// on re-confirms with the same dialog.
// `selection` (optional) is the batch-publish hook: { selected, blocker,
// atCap, onToggle }. blocker non-null ⇒ the checkbox is disabled and the row
// says why inline (never a silent skip). Checkbox styling matches the
// SpecialsTab batch rows (PR #355) — the repo's existing select-for-batch
// interaction.
function ProductReviewRow({ product, node, onApproved, onChanged, onSkip, inputRef, selection }) {
  const effective = useMemo(() => effectiveNameFor(product, node), [product, node]);
  const [draft, setDraft] = useState(effective.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(null); // "publish" | "switch-on"
  const [showPhotos, setShowPhotos] = useState(false); // the row's photo strip, opened on demand

  const state = reviewStateFor(node);
  const on = isOn(node);
  const pending = isPendingSwitch(node);
  const photoList = useMemo(() => effectivePhotoList(product, node), [product, node]);
  const verdict = checkCleanName(draft); // the LIVE trigger check
  const blocked = blockedReason(node);
  const isLiveRow = state === "live";
  // An edit after approval un-approves in the UI: Enter returns to approving
  // until the new text is signed off, so Publish can never ship a name the
  // reviewer hasn't actually confirmed (the dialog shows the draft verbatim).
  // A live-OFF row's name is editable too (the reconciler re-syncs it at
  // turn-on) — Enter is its save path, and the switch refuses to go On while
  // an edit sits unsaved (the dialog must show the name that will ship).
  const editable = state === "approved" || (isLiveRow && !on);
  const dirty = editable && draft.trim() !== String(node?.cleanName || "");
  const enterApproves = state === "awaiting" || dirty;

  // The source recorded on approval: an untouched saved name keeps its
  // provenance, an untouched lexicon suggestion records "lexicon", any edit
  // is "manual".
  const sourceForDraft = () =>
    node?.cleanName && draft.trim() === node.cleanName ? (node.cleanNameSource || "manual")
      : effective.source === "lexicon" && draft.trim() === effective.name ? "lexicon"
      : "manual";

  // finally-reset: the store never throws today, but a row frozen for the
  // session because a future caller broke that invariant is too costly.
  const run = async (fn, after) => {
    setBusy(true); setError(null);
    try {
      const res = await fn();
      if (!res?.ok) { setError(res?.message || "Not saved."); return; }
      after?.(res);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    if (busy || !verdict.ok || !enterApproves) return;
    run(() => approveName(product.id, node, draft, sourceForDraft()),
        (res) => onApproved(product.id, res.node));
  };

  // Publish click: the condition gate is checked BEFORE the dialog opens — a
  // dialog stating "no condition" would be confirming a write the store
  // refuses anyway. The dialog is the only thing between here and intent.
  const requestPublish = () => {
    if (busy || !verdict.ok) return;
    if (!canGoLive(node)) {
      setError("Pick a condition grade first — a product cannot go live without one.");
      return;
    }
    // Same gate the reconciler enforces, surfaced NOW instead of as a
    // blocked row minutes after a script run: imageless never ships.
    if (effectivePhotoList(product, node).photos.length === 0) {
      setError("No photos — open the photo strip and add one; an imageless product cannot go live.");
      return;
    }
    setConfirming("publish");
  };

  const confirmGoLive = () => {
    const write = confirming === "publish"
      ? () => publishProduct(product.id, node, draft, sourceForDraft())
      : () => setDesiredState(product.id, node, "on");
    run(write, (res) => onChanged(product.id, res.node));
    setConfirming(null);
  };

  const dialogName = confirming === "switch-on" ? (node?.cleanName || draft.trim()) : draft.trim();

  return (
    <div style={{ display: "flex", gap: 11, padding: "12px 2px", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      {selection && (
        <input type="checkbox"
          checked={selection.selected}
          disabled={busy || !!selection.blocker || (selection.atCap && !selection.selected)}
          onChange={selection.onToggle}
          aria-label={`Select ${product.name || product.id} for batch publish`}
          title={selection.blocker || (selection.atCap && !selection.selected
            ? `Selection is capped at ${RECONCILE_MAX_APPLY} per batch` : undefined)}
          style={{ width: 16, height: 16, accentColor: BLUE_L, cursor: selection.blocker ? "not-allowed" : "pointer",
                   flexShrink: 0, alignSelf: "center", opacity: selection.blocker ? 0.4 : 1 }} />
      )}
      <Thumb p={product} node={node} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: "rgba(255,255,255,.3)",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {product.name}
          </div>
          <StateChip chip={chipFor(state, node)} />
        </div>
        <input
          ref={inputRef}
          value={draft}
          disabled={busy || (isLiveRow && on)}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            // Enter approves; on a row already approved and untouched it just
            // advances, so walking a mixed list never stalls the flow. Enter
            // NEVER publishes — that path always goes through the dialog.
            if (enterApproves) approve(); else onSkip(product.id);
          }}
          placeholder={effective.needsAI ? `needs a name — ${effective.reason}` : "Cleaned listing name…"}
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginTop: 6,
                   border: !verdict.ok && draft !== "" ? "1px solid rgba(248,113,113,.6)" : inputStyle.border }}
        />
        {!verdict.ok && draft !== "" && (
          <div style={{ fontSize: 10.5, color: RED, marginTop: 4 }}>{verdict.problems.join(" · ")}</div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, marginTop: 7 }}>
          {CONDITIONS.map((c) => (
            <button key={c} disabled={busy}
              onClick={() => run(() => setCondition(product.id, node, c), (res) => onChanged(product.id, res.node))}
              style={{ ...(node?.condition === c ? tabOn : tabOff), padding: "4px 9px", fontSize: "0.68rem" }}>
              {c.split(" — ")[0]}
            </button>
          ))}
          <button disabled={busy}
            onClick={() => setShowPhotos((v) => !v)}
            style={{ ...(showPhotos ? tabOn : tabOff), padding: "4px 9px", fontSize: "0.68rem" }}>
            Photos · {photoList.photos.length}
          </button>
          <div style={{ flex: 1 }} />
          {isLiveRow ? (
            // The on/off switch. OFF is instant intent — reversible, reduces
            // exposure, no dialog. ON re-confirms with the same dialog as
            // Publish. While pending, the switch waits for the reconciler.
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {pending && (
                <span style={{ fontSize: 10.5, color: BLUE_L }}>
                  Saved — waiting for the reconciler run to update Shopify.
                </span>
              )}
              <button disabled={busy || pending || on}
                onClick={() => {
                  if (dirty) { setError("Save the edited name first (press Enter in the name field)."); return; }
                  setConfirming("switch-on");
                }}
                style={{ ...(on ? tabOn : tabOff), padding: "4px 11px", fontSize: "0.68rem" }}>
                On
              </button>
              <button disabled={busy || pending || !on}
                onClick={() => run(() => setDesiredState(product.id, node, "off"), (res) => onChanged(product.id, res.node))}
                style={{ ...(!on ? tabOn : tabOff), padding: "4px 11px", fontSize: "0.68rem" }}>
                Off
              </button>
            </div>
          ) : pending ? (
            // A publish intent the reconciler hasn't applied yet — cancellable
            // without a dialog (cancelling only reduces exposure). The plain
            // sentence is deliberate (owner feedback 2026-08-14): the chip
            // alone read as "in progress", and Junid didn't know a separate
            // reconciler run had to happen before anything reached Shopify.
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 10.5, color: BLUE_L }}>
                Saved — waiting for the reconciler run to send it to Shopify.
              </span>
              <button disabled={busy}
                onClick={() => run(() => setDesiredState(product.id, node, "off"), (res) => onChanged(product.id, res.node))}
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: FONT,
                         fontSize: "0.72rem", fontWeight: 700, color: GRAY, padding: "7px 4px" }}>
                Cancel
              </button>
            </div>
          ) : (
            <button disabled={busy || !verdict.ok}
              onClick={requestPublish}
              style={{ ...bBlue, padding: "7px 12px", fontSize: "0.76rem", opacity: verdict.ok ? 1 : 0.4 }}>
              Publish
            </button>
          )}
        </div>
        {showPhotos && (
          <PhotoStrip product={product} node={node} locked={isLiveRow && on} onChanged={onChanged} />
        )}
        {selection?.blocker && (
          <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>
            Can't batch-select — {selection.blocker}.
          </div>
        )}
        {node?.condition && (
          <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>{node.condition}</div>
        )}
        {isLiveRow && (
          // The live row's provenance line: when it went ON (the reconciler's
          // liveAt stamp) and the direct Shopify admin link. Both are stamped
          // at confirm time — a row confirmed before this shipped shows
          // neither, honestly, until its next reconcile.
          <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>
            {on
              ? (node?.liveAt ? `Went live ${new Date(node.liveAt).toLocaleDateString()}` : "Live")
              : "On Shopify, not published"}
            {node?.adminUrl && (
              <>
                {" · "}
                <a href={node.adminUrl} target="_blank" rel="noreferrer" style={{ color: BLUE_L }}>
                  Shopify admin ↗
                </a>
              </>
            )}
          </div>
        )}
        {blocked && (
          <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>⛔ {blocked}</div>
        )}
        {error && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>{error}</div>}
      </div>
      {confirming && (
        <PublishConfirmDialog
          facts={publicFacts(product, node, dialogName)}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={confirmGoLive}
        />
      )}
    </div>
  );
}

// Home-badge hook: how many products have never been seen by the review flow.
// One shallow KEY read (session-cached in the store) against the in-memory
// catalogue — no bodies, no extra catalogue read. null until known (the row
// simply shows no badge while loading, matching the other home badges' "no
// count, no badge" behaviour).
export function useShopifyAwaitingCount(products, enabled) {
  const [keys, setKeys] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let on = true;
    loadPublishKeys().then((k) => { if (on) setKeys(k); }).catch(() => {});
    return () => { on = false; };
  }, [enabled]);
  return useMemo(() => {
    if (!enabled || !keys) return null;
    let n = 0;
    for (const p of products || []) if (p?.id && !keys.has(p.id)) n += 1;
    return n;
  }, [enabled, keys, products]);
}

export default function ShopifyPublishView({ products = [], onExit }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState("all");

  // The search drives section matching (and, when narrow enough, section
  // auto-open + body fetches) — debounce it so a fast typist doesn't fan out
  // work on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [keys, setKeys] = useState(null);          // Set<pid> — pids with ANY node
  const [pipeline, setPipeline] = useState(null);  // {pid: node} for live/blocked (+legacy)
  // Batch publish (owner spec 2026-08-14): selection lives at page level so it
  // survives collapsing a section; capped at the reconciler's per-run cap.
  const [selected, setSelected] = useState(() => new Set());
  const [batchNotice, setBatchNotice] = useState(null);
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [nodes, setNodes] = useState({});          // every node body this session has loaded
  const [open, setOpen] = useState(() => new Set());
  const [loadError, setLoadError] = useState(null);       // mount reads failed — page unusable
  const [sectionError, setSectionError] = useState(null); // a body batch failed — clears on the next good batch
  const inputRefs = useRef(new Map());             // pid -> input element
  const refCallbacks = useRef(new Map());          // pid -> STABLE ref callback (see refFor)
  const requestedPids = useRef(new Set());         // in-flight/done per-pid body fetches
  const autoFocusCat = useRef(null);               // focus first awaiting row once this category loads

  // Mount reads: shallow keys + the indexed pipeline queries. Both are
  // partial by design — never get(/shopify_publish).
  useEffect(() => {
    let on = true;
    Promise.all([loadPublishKeys({ fresh: true }), loadPipelineNodes()])
      .then(([k, pipe]) => {
        if (!on) return;
        setKeys(new Set(k));
        setPipeline(pipe);
        setNodes((prev) => ({ ...pipe, ...prev }));
      })
      .catch((e) => { if (on) setLoadError(String(e?.message || e)); });
    return () => { on = false; };
  }, []);

  // The catalogue grouped by its existing category field, subcategory kept for
  // the in-section subheaders. Categories and their products sort by name.
  const sections = useMemo(() => {
    const byCat = new Map();
    for (const p of products) {
      if (!p?.id || !p?.name) continue;
      const cat = String(p.category || UNCAT);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(p);
    }
    const cmp = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
    return [...byCat.entries()]
      .sort(([a], [b]) => cmp(a, b))
      .map(([cat, list]) => ({
        cat,
        list: list.sort((a, b) =>
          cmp(a.subcategory || "", b.subcategory || "") || cmp(a.name, b.name)),
      }));
  }, [products]);

  // Per-section view data under the current search + filter. Counts come from
  // cheap sources only: key ABSENCE prices "awaiting", the pipeline queries
  // price live/blocked, "all" is the catalogue itself. (A node holding only a
  // condition counts as seen here even though its row still says "awaiting"
  // once its body loads — the honest number needs bodies, and bodies are
  // strictly on-expand. The count is an approximation; the ROWS are always
  // judged from real fields.)
  // `pending` = displayed pids whose body is still unfetched — the section
  // renders rows only once it hits zero, so a row never mounts with a node it
  // doesn't have yet (its editable draft is seeded from the node at mount).
  const q = debouncedQuery.trim().toLowerCase();
  const viewSections = useMemo(() => {
    return sections.map(({ cat, list }) => {
      const matched = q
        ? list.filter((p) =>
            String(p.name || "").toLowerCase().includes(q) ||
            String(nodes[p.id]?.cleanName || "").toLowerCase().includes(q))
        : list;
      let count;
      if (filter === "all") count = matched.length;
      else if (filter === "awaiting") {
        // Key absence, refined by any bodies already loaded: a node that
        // exists but was never name-approved (condition-only) still awaits
        // review, and pricing it from keys alone would hide its whole
        // section under this filter.
        count = keys ? matched.filter((p) =>
          !keys.has(p.id) ||
          (nodes[p.id] !== undefined && reviewStateFor(nodes[p.id]) === "awaiting")).length : null;
      }
      else count = pipeline ? matched.filter((p) => pipeline[p.id] && reviewStateFor(pipeline[p.id]) === filter).length : null;
      const pending = keys ? matched.filter((p) => keys.has(p.id) && nodes[p.id] === undefined).length : 0;
      return { cat, list, matched, count, pending };
    }).filter((s) => (q ? s.matched.length > 0 : true))
      .filter((s) => (filter === "all" ? true : s.count !== 0));
  }, [sections, q, filter, keys, pipeline, nodes]);

  // The Live filter abandons category sections for the owner's real question
  // — what is ON the storefront and what is OFF — as two collapsible groups
  // (same header treatment as the category sections). Bodies are already in
  // hand: the pipeline query loads every live node at mount. Pending rows
  // group under their CONFIRMED side — the truthful one until the reconciler
  // says otherwise.
  const liveGroups = useMemo(() => {
    if (filter !== "live") return null;
    const byId = new Map();
    for (const p of products) if (p?.id) byId.set(p.id, p);
    const on = [];
    const off = [];
    for (const [pid, n] of Object.entries(nodes)) {
      if (!n || normalizedState(n) !== "live") continue;
      const p = byId.get(pid);
      if (!p) continue;
      if (q && !(String(p.name || "").toLowerCase().includes(q) ||
                 String(n.cleanName || "").toLowerCase().includes(q))) continue;
      (isOn(n) ? on : off).push(p);
    }
    const cmp = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
    on.sort(cmp); off.sort(cmp);
    return [
      { key: "__liveOn",  label: "On — visible to customers", list: on },
      { key: "__liveOff", label: "Off — on Shopify, not published", list: off },
    ];
  }, [filter, products, nodes, q]);

  // A section is effectively open when toggled open, or when a search has
  // narrowed the page far enough that showing the matches outright is cheap.
  // A broad search (a one-letter query can match most of the catalogue)
  // leaves sections collapsed — auto-opening them all would fan out a body
  // fetch per reviewed match, exactly the eager load this page must not do.
  const totalMatches = q ? viewSections.reduce((n, s) => n + s.matched.length, 0) : 0;
  const searchExpands = q !== "" && totalMatches <= 60;
  const isOpen = (cat) => searchExpands || open.has(cat);

  // On-expand fetch: bodies for exactly the pids a section is about to
  // display that we don't hold yet. Tracked PER PID (not per category) so a
  // search-narrowed fetch never masks the rest of the category, and a later
  // full expand fetches only what's still missing. Missing bodies (deleted
  // between the shallow read and the get) are recorded as null so `pending`
  // can settle.
  useEffect(() => {
    if (!keys) return;
    for (const { cat, matched } of viewSections) {
      if (!isOpen(cat)) continue;
      const want = matched
        .filter((p) => keys.has(p.id) && nodes[p.id] === undefined && !requestedPids.current.has(p.id))
        .map((p) => p.id);
      if (!want.length) continue;
      for (const pid of want) requestedPids.current.add(pid);
      loadNodesFor(want)
        .then(({ nodes: got, failed }) => {
          setNodes((prev) => {
            const next = { ...prev };
            for (const pid of want) {
              if (!failed.includes(pid)) next[pid] = got[pid] || null;
            }
            return next;
          });
          if (failed.length) {
            for (const pid of failed) requestedPids.current.delete(pid); // let a re-open retry
            setSectionError(`${failed.length} product record(s) didn't load — reopen the section or adjust the search to retry`);
          } else {
            setSectionError(null); // a clean batch clears the stale banner
          }
        })
        .catch((e) => {
          for (const pid of want) requestedPids.current.delete(pid);
          setSectionError(String(e?.message || e));
        });
    }
  }, [viewSections, keys, open, q]); // eslint-disable-line react-hooks/exhaustive-deps

  // The reconciler runs in Junid's terminal, outside this session — without a
  // listener (deliberately: reads stay one-shot and partial) the pending
  // marker would only ever clear on a full reload. Window focus is the
  // natural "I ran the script, back to the page" moment: refetch ONLY the
  // pids currently pending (a handful of bodies, never the node).
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onFocus = () => {
      const pendingPids = Object.entries(nodes)
        .filter(([, n]) => isPendingSwitch(n))
        .map(([pid]) => pid);
      if (!pendingPids.length) return;
      loadNodesFor(pendingPids)
        .then(({ nodes: got, failed }) => {
          setNodes((prev) => {
            const next = { ...prev };
            for (const pid of pendingPids) if (!failed.includes(pid)) next[pid] = got[pid] || null;
            return next;
          });
          setPipeline((prev) => {
            if (!prev) return prev;
            const next = { ...prev };
            for (const pid of pendingPids) {
              if (failed.includes(pid)) continue;
              const n = got[pid];
              if (n && normalizedState(n) !== "awaiting") next[pid] = n; else delete next[pid];
            }
            return next;
          });
        })
        .catch(() => {}); // a failed refresh just keeps showing pending
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [nodes]);

  // Ordered pids of rows currently on screen whose state is "awaiting" — the
  // Enter key walks this list.
  const visibleRows = useMemo(() => {
    const rows = [];
    for (const { cat, matched, pending } of viewSections) {
      if (!isOpen(cat) || pending !== 0) continue;
      for (const p of matched) {
        const st = reviewStateFor(nodes[p.id]);
        if (matchesStateFilter(filter, st)) rows.push({ pid: p.id, cat, state: st });
      }
    }
    return rows;
  }, [viewSections, open, q, nodes, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fold a completed write straight into local state. The store's
  // transactions return the committed node, so no refetch is needed — and
  // none must happen: keys and nodes update in ONE batch, because a keys-only
  // update would flip the section's `pending` and unmount every row (killing
  // the Enter flow's focus) until a refetch landed.
  const applyWrite = (pid, node) => {
    setKeys((prev) => (prev ? new Set(prev).add(pid) : prev));
    // Keep the pipeline map (which prices the live/blocked filter counts) in
    // step with the write — otherwise a fresh block is invisible to the
    // Blocked filter, and an unblock leaves a phantom count behind.
    setPipeline((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      if (node && normalizedState(node) !== "awaiting") next[pid] = node;
      else delete next[pid];
      return next;
    });
    if (node !== undefined) {
      setNodes((prev) => ({ ...prev, [pid]: node || null }));
    } else {
      // A store result without a node (shouldn't happen) — refetch to stay honest.
      loadNodesFor([pid])
        .then(({ nodes: got, failed }) => {
          if (!failed.length) setNodes((prev) => ({ ...prev, [pid]: got[pid] || null }));
        })
        .catch(() => {});
    }
  };

  // ─── Batch-publish selection ───────────────────────────────────────────────
  // Only awaiting-review rows in the CATEGORY sections are selectable — every
  // name is a compliance decision and the category boundary is the review
  // unit, so there is no cross-category select-all and no batch in the Live
  // view. A row that fails the same gates the publish write enforces
  // (condition unset, no valid name) gets a disabled checkbox with the reason
  // inline — never a silent skip.
  const selectionEligible = (node) => {
    const st = reviewStateFor(node);
    return (st === "awaiting" || st === "approved") && !isPendingSwitch(node);
  };
  // Prune the selection whenever ANY node update disqualifies a selected row
  // — local writes and external ones alike (the window-focus refetch can pull
  // in a reconciler-side block; publishing that stale selection would clear
  // the validator's refusal and re-queue the very product it refused).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const pid of prev) {
        const node = nodes[pid];
        if (node !== undefined && !selectionEligible(node)) next.delete(pid);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  // The freshest nodes, readable from inside runBatch's long-lived closure.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const capNotice = () =>
    setBatchNotice(`Selection is capped at ${RECONCILE_MAX_APPLY} — the reconciler applies at most ${RECONCILE_MAX_APPLY} products per run.`);
  const toggleSelect = (pid, blocker) => {
    if (selected.has(pid)) {
      const next = new Set(selected);
      next.delete(pid);
      setSelected(next);
      return;
    }
    if (blocker) return;
    if (selected.size >= RECONCILE_MAX_APPLY) { capNotice(); return; }
    setSelected(new Set(selected).add(pid));
  };
  // Per-render cache: the blocker needs the lexicon (effectiveNameFor) and
  // the photo list, and both selectionFor and the section select-all walk the
  // same rows — compute each pid once per render, not twice.
  const blockerCache = new Map();
  const blockerFor = (p) => {
    if (!blockerCache.has(p.id)) {
      const node = nodes[p.id] || null;
      blockerCache.set(p.id, batchSelectBlocker(
        node, effectiveNameFor(p, node).name, effectivePhotoList(p, node).photos.length));
    }
    return blockerCache.get(p.id);
  };
  const selectionFor = (p) => {
    if (filter === "live") return undefined;
    const node = nodes[p.id] || null;
    if (!selectionEligible(node)) return undefined;
    const blocker = blockerFor(p);
    return {
      selected: selected.has(p.id),
      blocker,
      atCap: selected.size >= RECONCILE_MAX_APPLY,
      onToggle: () => toggleSelect(p.id, blocker),
    };
  };
  // The per-category select-all: adds this section's currently-selectable
  // rows (blocked/ineligible ones stay out and keep their inline reason)
  // until the cap says stop.
  const selectAllIn = (pids) => {
    const next = new Set(selected);
    let capped = false;
    for (const pid of pids) {
      if (next.size >= RECONCILE_MAX_APPLY) { capped = true; break; }
      next.add(pid);
    }
    setSelected(next);
    if (capped) capNotice();
  };

  const productById = useMemo(() => {
    const m = new Map();
    for (const p of products) if (p?.id) m.set(p.id, p);
    return m;
  }, [products]);
  // What the batch dialog states, per product: the cleaned name that will
  // ship (saved name or lexicon — never an unsaved row draft), condition,
  // price. Built from the same effectiveNameFor the rows use.
  const batchItems = useMemo(() => {
    return [...selected].map((pid) => {
      const p = productById.get(pid);
      if (!p) return null;
      const node = nodes[pid] || null;
      const eff = effectiveNameFor(p, node);
      const price = Number(p.retailPrice);
      return {
        pid, node, name: eff.name, source: eff.source,
        condition: node?.condition || "— no condition set —",
        price: price > 0 ? `R ${price.toFixed(2)}` : "no price set",
      };
    }).filter(Boolean);
  }, [selected, nodes, productById]);

  // Sequential on purpose: each publishProduct is its own transaction with
  // its own server-side refusals, and a failure only skips ITS product — the
  // batch is N independent intents, exactly like the reconciler treats them.
  const runBatch = async () => {
    if (batchBusy) return;
    setBatchBusy(true);
    const failures = [];
    let okCount = 0;
    for (const it of batchItems) {
      // Re-check against the FRESHEST node before each write: a row the
      // reconciler blocked (or another session published) since the dialog
      // opened must be skipped, not silently re-queued with its refusal
      // reason wiped.
      const freshest = nodesRef.current[it.pid] === undefined ? it.node : nodesRef.current[it.pid];
      if (!selectionEligible(freshest)) {
        failures.push(`${it.name || it.pid} — its state changed since selection, skipped`);
        continue;
      }
      const res = await publishProduct(it.pid, freshest, it.name, it.source); // eslint-disable-line no-await-in-loop
      if (res?.ok) { okCount += 1; applyWrite(it.pid, res.node); }
      else failures.push(`${it.name || it.pid} — ${res?.message || "not saved"}`);
    }
    setBatchBusy(false);
    setBatchConfirm(false);
    setBatchNotice(
      [
        okCount ? `${okCount} publish intent${okCount === 1 ? "" : "s"} saved — nothing reaches Shopify until the reconciler runs.` : "",
        failures.length ? `${failures.length} not saved: ${failures.join("; ")}` : "",
      ].filter(Boolean).join(" ")
    );
  };

  // Enter's advance: focus the next awaiting row after the approved one; when
  // the open sections are exhausted, open the next category that still has
  // unreviewed products and focus its first row once its bodies load.
  const advanceFrom = (pid) => {
    if (filter === "live") return; // the On/Off groups have no review walk
    const awaiting = visibleRows.filter((r) => r.state === "awaiting" && r.pid !== pid);
    const idx = visibleRows.findIndex((r) => r.pid === pid);
    const next = awaiting.find((r) => visibleRows.findIndex((v) => v.pid === r.pid) > idx) || awaiting[0];
    if (next) {
      const el = inputRefs.current.get(next.pid);
      if (el) { el.focus(); el.scrollIntoView({ block: "center" }); return; }
    }
    if (keys) {
      // Next category to open: one that still has products never seen (no
      // node key), or whose LOADED bodies still read awaiting. Unloaded
      // node-bearing pids are approximated as reviewed — the honest answer
      // needs their bodies, which are strictly on-expand; a category that is
      // wholly condition-only nodes would be skipped here and reached by a
      // manual expand instead.
      const openCats = new Set([...open]);
      const candidate = viewSections.find(({ cat, matched }) =>
        !openCats.has(cat) && matched.some((p) =>
          !keys.has(p.id) ||
          (nodes[p.id] !== undefined && reviewStateFor(nodes[p.id]) === "awaiting")));
      if (candidate) {
        autoFocusCat.current = candidate.cat;
        setOpen((prev) => new Set(prev).add(candidate.cat));
      }
    }
  };

  const onApproved = (pid, node) => { applyWrite(pid, node); advanceFrom(pid); };

  // Complete the section-hop: once the auto-opened category's bodies are in
  // (pending === 0), put the cursor on its first unreviewed row.
  useEffect(() => {
    const cat = autoFocusCat.current;
    if (!cat || !keys) return;
    const section = viewSections.find((s) => s.cat === cat);
    if (!section || section.pending !== 0) return;
    autoFocusCat.current = null;
    const first = section.matched.find((p) => reviewStateFor(nodes[p.id]) === "awaiting");
    const el = first && inputRefs.current.get(first.id);
    if (el) { el.focus(); el.scrollIntoView({ block: "center" }); }
  }, [viewSections, nodes, keys]);

  // Ref callbacks must keep a stable identity per pid: a fresh arrow every
  // render makes React detach (null) and re-attach every row ref on each
  // re-render, and the approve continuation can observe the emptied Map in
  // that window — Enter would approve but never advance.
  const refFor = (pid) => {
    let cb = refCallbacks.current.get(pid);
    if (!cb) {
      cb = (el) => {
        if (el) {
          inputRefs.current.set(pid, el);
        } else {
          inputRefs.current.delete(pid);
          refCallbacks.current.delete(pid); // unmount frees the closure too
        }
      };
      refCallbacks.current.set(pid, cb);
    }
    return cb;
  };

  const toggle = (cat) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    return next;
  });

  // One section/group header row — the home list's row treatment (RoleCard):
  // name, right-aligned count badge, chevron. Shared by the category sections
  // and the Live view's On/Off groups.
  const sectionHeader = (key, label, count, opened, extra = null) => (
    <div onClick={() => toggle(key)}
      style={{ display: "flex", alignItems: "center", gap: 11, padding: "13px 2px",
               cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      <div style={{ flex: 1, fontSize: 15, fontWeight: 500, color: "rgba(255,255,255,.9)" }}>{label}</div>
      {extra}
      {count != null && count !== 0 && (
        <div style={{ minWidth: 28, height: 28, padding: "0 8px", boxSizing: "border-box", borderRadius: 999,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                      background: "rgba(60,110,255,.18)", color: "#6A9FFF",
                      boxShadow: "0 0 8px rgba(60,110,255,.3),inset 0 0 6px rgba(60,110,255,.15)" }}>
          {count}
        </div>
      )}
      <span style={{ color: "rgba(255,255,255,.18)", fontSize: 14,
                     transform: opened ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: FONT, maxWidth: 880, margin: "0 auto", overflowX: "hidden", paddingBottom: 40 }}>
      {/* TOP BAR — same shape as the other full-page views (LabelPrintView) */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "50px 14px 12px" }}>
        <div onClick={onExit}
          style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>← Switch View</span>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", letterSpacing: "0.5px" }}>Viewing as:</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#4A7FFF", letterSpacing: "0.5px" }}>SHOPIFY PUBLISHING</div>
        </div>
        <div style={{ width: 92 }} />
      </div>

      {/* STICKY HEADER — search + state filter, nothing else */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: "#000", padding: "10px 14px 12px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products…"
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {STATE_FILTERS.map(({ key, label }) => (
            <button key={key} onClick={() => setFilter(key)}
              style={{ ...(filter === key ? tabOn : tabOff), padding: "6px 12px", fontSize: "0.74rem" }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "6px 14px 0" }}>
        {loadError && (
          <div style={{ fontSize: 12, color: RED, fontWeight: 700, padding: "12px 2px" }}>
            Couldn't load the publishing pipeline: {loadError}
          </div>
        )}
        {sectionError && (
          <div style={{ fontSize: 12, color: RED, fontWeight: 700, padding: "12px 2px" }}>
            {sectionError}
          </div>
        )}
        {!loadError && (!keys || !pipeline) && (
          <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>Loading pipeline…</div>
        )}

        {/* LIVE FILTER — the On / Off groups replace the category sections */}
        {keys && pipeline && liveGroups && (
          liveGroups.every((g) => g.list.length === 0) ? (
            <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>
              {q ? "No live products match." : "Nothing on Shopify yet."}
            </div>
          ) : (
            liveGroups.map(({ key, label, list }) => {
              const opened = isOpen(key);
              return (
                <div key={key}>
                  {sectionHeader(key, label, list.length, opened)}
                  {opened && list.length === 0 && (
                    <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 2px" }}>Nothing here.</div>
                  )}
                  {opened && list.map((p) => (
                    <ProductReviewRow
                      key={p.id}
                      product={p}
                      node={nodes[p.id] || null}
                      onApproved={onApproved}
                      onChanged={applyWrite}
                      onSkip={advanceFrom}
                      inputRef={refFor(p.id)}
                    />
                  ))}
                </div>
              );
            })
          )
        )}

        {keys && pipeline && !liveGroups && viewSections.length === 0 && (
          <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>
            {q ? "No products match." : "Nothing to show under this filter."}
          </div>
        )}

        {keys && pipeline && !liveGroups && viewSections.map(({ cat, matched, count, pending }) => {
          const opened = isOpen(cat);
          // The category's select-all: only rows that would render under the
          // current filter, are awaiting review, and pass the batch gates.
          // Appears once the section's bodies are in — eligibility needs them.
          const selectable = opened && pending === 0
            ? matched.filter((p) => {
                const node = nodes[p.id] || null;
                return matchesStateFilter(filter, reviewStateFor(node)) &&
                       selectionEligible(node) &&
                       !blockerFor(p);
              })
            : [];
          const unselected = selectable.filter((p) => !selected.has(p.id));
          const selectAllBtn = unselected.length > 0 ? (
            <button onClick={(e) => { e.stopPropagation(); selectAllIn(unselected.map((p) => p.id)); }}
              style={{ ...tabOff, padding: "4px 10px", fontSize: "0.66rem" }}>
              Select all
            </button>
          ) : null;
          return (
            <div key={cat}>
              {sectionHeader(cat, cat, count, opened, selectAllBtn)}

              {opened && pending !== 0 && (
                <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 2px" }}>Loading section…</div>
              )}
              {opened && pending === 0 && (() => {
                const rows = matched.filter((p) => matchesStateFilter(filter, reviewStateFor(nodes[p.id])));
                if (rows.length === 0) {
                  return <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 2px" }}>Nothing here under this filter.</div>;
                }
                let lastSub = null;
                return rows.map((p) => {
                  const sub = String(p.subcategory || "");
                  const showSub = sub !== lastSub && sub !== "";
                  lastSub = sub;
                  return (
                    <React.Fragment key={p.id}>
                      {showSub && (
                        <div style={{ fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase",
                                      color: "rgba(233,238,255,.3)", fontWeight: 700, padding: "12px 2px 2px" }}>
                          {sub}
                        </div>
                      )}
                      <ProductReviewRow
                        product={p}
                        node={nodes[p.id] || null}
                        onApproved={onApproved}
                        onChanged={applyWrite}
                        onSkip={advanceFrom}
                        inputRef={refFor(p.id)}
                        selection={selectionFor(p)}
                      />
                    </React.Fragment>
                  );
                });
              })()}
            </div>
          );
        })}

        {batchNotice && (
          <div style={{ fontSize: 12, color: BLUE_L, fontWeight: 700, padding: "12px 2px", overflowWrap: "break-word" }}>
            {batchNotice}
            <button onClick={() => setBatchNotice(null)}
              style={{ background: "none", border: "none", color: GRAY, cursor: "pointer",
                       fontFamily: FONT, fontSize: 11, marginLeft: 8 }}>✕</button>
          </div>
        )}
      </div>

      {/* BATCH BAR — sticky while anything is selected: the running count,
          the cap (stated, and shared with the reconciler so the two cannot
          disagree), and the one Publish Selected action behind the same
          going-live confirmation as a single publish. */}
      {selected.size > 0 && (
        <div style={{ position: "sticky", bottom: 10, zIndex: 30, ...GLASS_SOLID, margin: "14px 14px 0",
                      padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>
            {selected.size} of {RECONCILE_MAX_APPLY} selected
          </span>
          <span style={{ fontSize: 10.5, color: GRAY }}>
            cap {RECONCILE_MAX_APPLY} — matches the reconciler's per-run cap
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setSelected(new Set())} disabled={batchBusy}
            style={{ ...bGray, padding: "8px 12px", fontSize: "0.76rem" }}>Clear</button>
          <button onClick={() => setBatchConfirm(true)} disabled={batchBusy || batchItems.length === 0}
            style={{ ...bGreen, padding: "8px 12px", fontSize: "0.76rem" }}>
            Publish selected…
          </button>
        </div>
      )}
      {batchConfirm && (
        <BatchPublishConfirmDialog
          items={batchItems}
          busy={batchBusy}
          onCancel={() => setBatchConfirm(false)}
          onConfirm={runBatch}
        />
      )}
    </div>
  );
}
