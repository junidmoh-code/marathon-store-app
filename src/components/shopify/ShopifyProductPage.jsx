// ─── SHOPIFY PUBLISHING — THE PER-PRODUCT PAGE ───────────────────────────────
// One product's whole publishing workbench (owner spec 2026-08-14): the list
// on ShopifyPublishView is NAVIGATION — tapping a row lands here, where the
// name is fixed, the condition set, the photos sorted and edited, and the
// product published. Reached by hash route #shopify/{pid}, the same
// list→detail pattern as the admin catalogue's #product/{id} →
// AdminProductDetail (App.jsx); Back is window.history.back() and the list
// restores its scroll position and open category (UserManagement.jsx's
// listScrollRef treatment).
//
// The page carries: the publishing photo set (reorder / primary / remove /
// upload / AI Studio re-shoot — everything that was the row's on-demand strip),
// the editable cleaned name with the live trigger check, the original name
// for reference, the three condition chips, the generated description
// EXACTLY as it will appear on Shopify (same buildDescriptionHtml the
// reconciler pushes — single-sourced in publishShared.js), the current state,
// and ONE primary action: Publish for an awaiting product (behind the same
// going-live confirmation), the On/Off switch for a live one, the blocking
// reason and its cure for a blocked one.
//
// Writes go ONLY to /shopify_publish through the store; every colour and
// spacing value comes from stock/ui.js (PR #365/#366 design, no new tokens).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FONT, GRAY, GREEN, RED, BLUE_L, GLASS_SOLID, tabOn, tabOff, input as inputStyle, bBlue, bGray, bGreen } from "../stock/ui";
import {
  CONDITIONS, checkCleanName, blockedReason, reviewStateFor, effectiveNameFor,
  isOn, isPendingSwitch, canGoLive, effectivePhotoList, normalizedState,
  pendingProposal, proposalApplyBlocker,
} from "./shopifyPublishCore";
import { describeOff } from "./publishAudit";
import { MAX_PUBLISH_PHOTOS, buildDescriptionHtml } from "./publishShared";
import { approveName, publishProduct, setDesiredState, setCondition, setPublishPhotos,
         applyNameProposal, dismissNameProposal } from "./shopifyPublishStore";
import { uploadFileProblem, compressImageFile, uploadPublishPhoto } from "./photoTools";
import AiStudioCard from "./AiStudioCard";
import { usePermissions } from "../PermissionsContext";

// The uppercase section label used across the full-page views.
const SECTION_LABEL = {
  fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase",
  color: GRAY, fontWeight: 700,
};

// ─── SUGGESTED FROM THE PHOTO ────────────────────────────────────────────────
// The vision run (scripts/shopify/vision-name.mjs) reads a product's PHOTO and
// writes a proposed listing name to /shopify_publish/{pid}/nameProposal. It
// applies nothing — this card is where the proposal becomes the name, and it
// exists because the alternative is what Junid has been looking at: a lexicon
// title built from what staff typed, which for 69% of the live storefront is
// the single word "Sneaker" plus a colour.
//
// The card shows BOTH names because the decision is a comparison, and it shows
// the model's identity guess with its own confidence because that guess is a
// GUESS — it never reaches Shopify (it goes to /product_identity for search
// only) and Junid is entitled to see how sure the model claims to be before he
// trusts the description that came with it.
//
// Two buttons, no modal: taking a name is fully undoable (the previous name is
// recorded on the proposal), so it does not earn the going-live dialog's
// friction. Nothing here can put a product on the storefront.
export function NameProposalCard({ product, node, busy, onApply, onDismiss }) {
  const proposal = pendingProposal(node);
  if (!proposal) return null;
  const gate = proposalApplyBlocker(node);
  const identity = proposal.identity;
  const conf = Number(identity?.confidence);
  return (
    <div style={{ border: "1px solid rgba(74,127,255,.35)", background: "rgba(74,127,255,.06)",
                  borderRadius: 12, padding: "12px 13px", marginTop: 10 }}>
      <div style={{ fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase",
                    color: BLUE_L, fontWeight: 800 }}>
        Suggested from the photo
      </div>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", marginTop: 8, lineHeight: 1.35,
                    overflowWrap: "break-word" }}>
        {proposal.name}
      </div>
      <div style={{ fontSize: 11.5, color: GRAY, marginTop: 6, lineHeight: 1.5 }}>
        Now: {proposal.previousName ? `“${proposal.previousName}”` : "no listing name yet"}
      </div>
      {identity?.text && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginTop: 7, lineHeight: 1.5 }}>
          The model thinks this is <span style={{ color: "#fff", fontWeight: 700 }}>{identity.text}</span>
          {Number.isFinite(conf) ? ` — ${Math.round(conf * 100)}% sure` : ""}.
          {" "}That is a guess for searching in the shop only; it never goes on the storefront.
        </div>
      )}
      {!gate.ok && (
        <div style={{ fontSize: 10.5, color: RED, marginTop: 7 }}>{gate.reason}</div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
        <button disabled={busy || !gate.ok} onClick={() => onApply(proposal.proposedAt)}
          style={{ ...bBlue, padding: "7px 12px", fontSize: "0.72rem",
                   opacity: busy || !gate.ok ? 0.5 : 1 }}>
          Use this name
        </button>
        <button disabled={busy} onClick={() => onDismiss(proposal.proposedAt)}
          style={{ ...bGray, padding: "7px 12px", fontSize: "0.72rem" }}>
          Keep the old one
        </button>
      </div>
    </div>
  );
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
// The publishing surface's rule is NO MODALS — with one deliberate exception
// (owner spec 2026-08-14): going live. Publishing puts a name on the PUBLIC
// storefront and the name is the compliance-critical field, so it is the most
// prominent thing here and the reviewer confirms it one last time. Switching
// OFF never asks (it only reduces exposure). Cancel is the default focus —
// Enter must never publish blind.
export function PublishConfirmDialog({ facts, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  // Escape CANCELS — it can never confirm. Together with Cancel holding
  // default focus, every reflex key press (Escape, Enter, Space) does the
  // safe thing: nothing goes public without a deliberate click.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.62)",
               backdropFilter: "blur(5px)", WebkitBackdropFilter: "blur(5px)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Put on the public storefront?"
        style={{ ...GLASS_SOLID, width: "100%", maxWidth: 420, padding: "22px 20px", fontFamily: FONT }}>
        <div style={SECTION_LABEL}>
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

// ─── PHOTO PICKER ────────────────────────────────────────────────────────────
// The product's publishing photo set, always visible on this page (it was the
// list row's on-demand strip until the page took over the editing). The
// interaction pattern is the repo's own: the thumbnail strip (white active
// border, dimmed rest) is GalleryLightbox's strip from App.jsx; tap a thumb
// to select it, then act on it with chips — the tap-to-act chip treatment of
// the AI Studio Style Kit reference grid. Reordering is the lightbox's ‹ ›
// glyph pair on the SELECTED thumb (no drag interaction exists anywhere in
// the repo to match). First photo is primary, marked.
//
// Every action writes the full ordered list to /shopify_publish/{pid}/photos
// through the store's transaction — NEVER to /products, never a blind set().
// Removing only removes from the publishing set (the product record and
// Storage keep the file); the last photo cannot be removed (imageless never
// ships). Locked while the listing is ON, like the name and condition.
export function PhotoStrip({ product, node, locked, onChanged }) {
  // Generating a photo SPENDS MONEY and is its own permission (`photo_generation`),
  // separate from the one that opens this page. Reaching Shopify Publishing does
  // not buy the right to spend, so the generate card is hidden unless the viewer
  // actually holds it — a button that is always going to come back
  // "permission-denied" from the function is worse than no button.
  //
  // This closes a show-and-fail that predates the split: generateProductPhotos
  // was super-admin-email-only, so every stockRole admin who reached this page
  // already saw a card that could never work for them.
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canGenerate = isSuperAdmin || hasPermission("photo_generation");
  const { photos, custom } = effectivePhotoList(product, node);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  // → true iff the list committed (callers that consume a resource on
  // success — the accept flow discarding its candidate — must not do so on a
  // refused write).
  const write = async (nextList, after) => {
    setBusy(true); setErr(null);
    try {
      const res = await setPublishPhotos(product.id, node, nextList);
      if (!res?.ok) { setErr(res?.message || "Not saved."); return false; }
      onChanged(product.id, res.node);
      after?.();
      return true;
    } catch (e) {
      setErr(String(e?.message || e));
      return false;
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
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        {photos.map((u, i) => (
          <div key={u} style={{ position: "relative" }}>
            <img src={u} alt="" loading="lazy"
              onClick={() => !locked && setSel(sel === i ? null : i)}
              style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 9,
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
              style={{ width: 84, height: 84, borderRadius: 9, cursor: "pointer", fontFamily: FONT,
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
          {canGenerate && <AiStudioCard
            product={product} node={node} sourceUrl={photos[sel]} photoCount={photos.length}
            busy={busy || uploading}
            onReplace={(url, sourceUrl) => write(photos.map((u) => (u === sourceUrl ? url : u)))}
            onAdd={(url) => write([...photos, url], () => setSel(photos.length))} />}
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>{err}</div>}
    </div>
  );
}

// ─── THE PAGE ────────────────────────────────────────────────────────────────
// `node` is the loaded /shopify_publish body (or null for a never-seen
// product) — the view mounts this page only once the body is in hand, exactly
// like a list section waits for its bodies, so the editable draft can seed
// from the node at mount. onChanged folds every committed write back into the
// view's state (the store returns the committed node — no refetch).
export default function ShopifyProductPage({ product, node, onBack, onChanged }) {
  const effective = useMemo(() => effectiveNameFor(product, node), [product, node]);
  const [draft, setDraft] = useState(effective.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(null); // "publish" | "switch-on"

  const state = reviewStateFor(node);
  const on = isOn(node);
  const pending = isPendingSwitch(node);
  const photoList = useMemo(() => effectivePhotoList(product, node), [product, node]);
  const verdict = checkCleanName(draft); // the LIVE trigger check
  const blocked = blockedReason(node);
  const isLive = state === "live";
  // Why it came off the shop, in one sentence — null while it is on. DECLARED
  // AFTER isLive, not beside `on`: a const read before its declaration is in
  // the temporal dead zone and throws at render.
  const offStory = isLive && !on ? describeOff(node) : null;
  // An edit after approval un-approves in the UI: saving returns to approving
  // until the new text is signed off, so Publish can never ship a name the
  // reviewer hasn't actually confirmed (the dialog shows the draft verbatim).
  // A live-OFF product's name is editable too (the reconciler re-syncs it at
  // turn-on) — and the switch refuses to go On while an edit sits unsaved
  // (the dialog must show the name that will ship).
  const nameLocked = isLive && on;
  const nameSaved = !!node?.cleanName && draft.trim() === node.cleanName;
  const needsSave = !nameLocked && draft.trim() !== "" && !nameSaved;

  // The source recorded on approval: an untouched saved name keeps its
  // provenance, an untouched lexicon suggestion records "lexicon", any edit
  // is "manual".
  const sourceForDraft = () =>
    node?.cleanName && draft.trim() === node.cleanName ? (node.cleanNameSource || "manual")
      : effective.source === "lexicon" && draft.trim() === effective.name ? "lexicon"
      : "manual";

  // finally-reset: the store never throws today, but a page frozen for the
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
    if (busy || !verdict.ok || !needsSave) return;
    run(() => approveName(product.id, node, draft, sourceForDraft()),
        (res) => onChanged(product.id, res.node));
  };

  // Publish: the condition gate is checked BEFORE the dialog opens — a dialog
  // stating "no condition" would be confirming a write the store refuses
  // anyway. The photo gate is the same one the reconciler enforces, surfaced
  // NOW instead of as a blocked row minutes after a script run.
  const requestPublish = () => {
    if (busy || !verdict.ok) return;
    if (!canGoLive(node)) {
      setError("Pick a condition grade first — a product cannot go live without one.");
      return;
    }
    if (photoList.photos.length === 0) {
      setError("No photos — add one above; an imageless product cannot go live.");
      return;
    }
    setConfirming("publish");
  };

  const requestSwitchOn = () => {
    if (busy) return;
    if (needsSave) { setError("Save the edited name first."); return; }
    // The name that would ship must be a real, valid one BEFORE the dialog
    // opens. A legacy node (pre-migration "draft") can reach this switch with
    // no cleanName at all, and if the lexicon can't clean its title either
    // the draft is empty — the dialog would then ask Junid to confirm putting
    // a blank name on the storefront. The dialog is exactly where the
    // compliance-critical field gets signed off; it must never be blank
    // (reviewer finding, 2026-08-14).
    const shipping = node?.cleanName || draft.trim();
    const shippingVerdict = checkCleanName(shipping);
    if (!shippingVerdict.ok) {
      setError(`Give this product a listing name first — ${shippingVerdict.problems.join(" · ")}.`);
      return;
    }
    if (photoList.photos.length === 0) {
      setError("No photos — add one above; an imageless product cannot go live.");
      return;
    }
    setConfirming("switch-on");
  };

  const confirmGoLive = () => {
    const write = confirming === "publish"
      ? () => publishProduct(product.id, node, draft, sourceForDraft())
      : () => setDesiredState(product.id, node, "on");
    run(write, (res) => onChanged(product.id, res.node));
    setConfirming(null);
  };

  const dialogName = confirming === "switch-on" ? (node?.cleanName || draft.trim()) : draft.trim();

  // ─── THE CONFIRMATION CANNOT OUTLIVE ITS FACTS ─────────────────────────────
  // The node changes UNDER this page: the reconciler runs outside the session
  // and the list refreshes pending nodes on a tick while the user sits here. A
  // dialog that opened against an awaiting product and is still on screen after
  // that product went live is stating facts that are no longer true, and
  // confirming it would fire a write the store refuses anyway.
  //
  // The test is a SNAPSHOT of the publishing state the dialog was raised
  // against, compared field by field — not a hand-written list of the
  // transitions I happened to think of. An intent flipped off in another
  // session leaves `state` and the live state untouched, so a
  // transition-by-transition check would have missed it and let the
  // confirmation re-arm a publish the operator had just cancelled elsewhere.
  const confirmBasis = useRef(null);
  const stateNow = `${normalizedState(node)}|${node?.liveState ?? "-"}|${node?.desiredState ?? "-"}`;
  useEffect(() => {
    if (!confirming) { confirmBasis.current = null; return; }
    if (confirmBasis.current === null) { confirmBasis.current = stateNow; return; }
    if (confirmBasis.current === stateNow) return;
    confirmBasis.current = null;
    setConfirming(null);
    setError("This product's publishing state changed while the confirmation was open — nothing was sent. The page below now shows where it actually is.");
  }, [confirming, stateNow]);

  // The description preview — the EXACT html the reconciler pushes, or the
  // plain reason there is none yet. buildDescriptionHtml throws on an unset
  // condition (NO default), so gate before calling.
  const descriptionHtml = CONDITIONS.includes(node?.condition) ? buildDescriptionHtml(node.condition) : null;

  const price = Number(product?.retailPrice);

  const section = (label, children) => (
    <div style={{ padding: "16px 2px 4px" }}>
      <div style={SECTION_LABEL}>{label}</div>
      <div style={{ marginTop: 9 }}>{children}</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: FONT, maxWidth: 880, margin: "0 auto", overflowX: "hidden", paddingBottom: 40 }}>
      {/* TOP BAR — same shape as the list page's (LabelPrintView treatment) */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "50px 14px 12px" }}>
        {/* A real button, not a clickable div: this is the way back out of a
            page that owns every editing action (reviewer finding,
            2026-08-14). Styled to match the other full-page views' back
            control exactly — same tokens, no new values. */}
        <button onClick={onBack} type="button"
          style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontFamily: FONT }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>← Publishing</span>
        </button>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", letterSpacing: "0.5px" }}>Viewing as:</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#4A7FFF", letterSpacing: "0.5px" }}>SHOPIFY PRODUCT</div>
        </div>
        <div style={{ width: 92 }} />
      </div>

      <div style={{ padding: "0 14px" }}>
        {/* HEADER — original name (the reference), price, state */}
        <div style={{ padding: "6px 2px 0" }}>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.4)" }}>
            In the shop system: {product.name}
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)", marginTop: 4 }}>
            {price > 0 ? `R ${price.toFixed(2)}` : "no price set"} · {photoList.photos.length} photo{photoList.photos.length === 1 ? "" : "s"}
          </div>
        </div>

        {section("Photos — first is what customers see", (
          <PhotoStrip product={product} node={node} locked={nameLocked} onChanged={onChanged} />
        ))}

        {section("Listing name — what the storefront shows", (
          <>
            <input
              value={draft}
              disabled={busy || nameLocked}
              onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                approve(); // Enter saves; it NEVER publishes — that path always goes through the dialog.
              }}
              placeholder={effective.needsAI ? `needs a name — ${effective.reason}` : "Cleaned listing name…"}
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box",
                       border: !verdict.ok && draft !== "" ? "1px solid rgba(248,113,113,.6)" : inputStyle.border }}
            />
            {!verdict.ok && draft !== "" && (
              <div style={{ fontSize: 10.5, color: RED, marginTop: 4 }}>{verdict.problems.join(" · ")}</div>
            )}
            {nameLocked ? (
              // NOT a dead sentence any more. "Switch it off to rename" was the
              // instruction that produced the whole "products go off by
              // themselves" report (docs/PUBLISH-AUTO-OFF.md): people followed
              // it, the switch recorded nothing, and the row afterwards could
              // only say "off". The action is here, it records off_to_rename,
              // and the row then says so and offers Publish once the new name
              // is saved.
              <div style={{ marginTop: 5 }}>
                <div style={{ fontSize: 10, color: GRAY }}>
                  Listing is ON — it has to come off the shop to be renamed. The reconciler
                  re-syncs the name at the next turn-on.
                </div>
                <button disabled={busy} onClick={() => run(
                  () => setDesiredState(product.id, node, "off", {
                    reasonCode: "off_to_rename",
                    detail: "switched off from the product page so its listing name could be changed",
                  }),
                  (res) => onChanged(product.id, res.node))}
                  style={{ ...bGray, padding: "7px 12px", fontSize: "0.72rem", marginTop: 7 }}>
                  Take it off the shop to rename
                </button>
              </div>
            ) : needsSave && verdict.ok ? (
              <button disabled={busy} onClick={approve}
                style={{ ...bBlue, padding: "7px 12px", fontSize: "0.72rem", marginTop: 7 }}>
                Save name
              </button>
            ) : nameSaved ? (
              <div style={{ fontSize: 10, color: GRAY, marginTop: 5 }}>Name saved.</div>
            ) : null}
            <NameProposalCard
              product={product} node={node} busy={busy}
              onApply={(seenProposedAt) => run(() => applyNameProposal(product.id, node, seenProposedAt), (res) => {
                // The input is a draft the reviewer may have typed into; the
                // saved name has just changed under it, so it follows.
                setDraft(res.node?.cleanName || draft);
                onChanged(product.id, res.node);
              })}
              onDismiss={(seenProposedAt) => run(() => dismissNameProposal(product.id, node, seenProposedAt),
                                   (res) => onChanged(product.id, res.node))}
            />
          </>
        ))}

        {section("Condition — sets the grade in the description", (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {CONDITIONS.map((c) => (
                <button key={c} disabled={busy || nameLocked}
                  onClick={() => run(() => setCondition(product.id, node, c), (res) => onChanged(product.id, res.node))}
                  style={{ ...(node?.condition === c ? tabOn : tabOff), padding: "6px 11px", fontSize: "0.72rem" }}>
                  {c}
                </button>
              ))}
            </div>
            {nameLocked && (
              <div style={{ fontSize: 10, color: GRAY, marginTop: 5 }}>
                Listing is ON — switch it off to change the condition.
              </div>
            )}
          </>
        ))}

        {section("Description — exactly as it will appear on Shopify", (
          descriptionHtml ? (
            <div
              style={{ border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "12px 14px",
                       fontSize: 12.5, lineHeight: 1.55, color: "rgba(255,255,255,.75)" }}
              // The EXACT template the reconciler pushes (publishShared.js) —
              // fixed copy plus the escaped condition string, no user html.
              dangerouslySetInnerHTML={{ __html: descriptionHtml }}
            />
          ) : (
            <div style={{ fontSize: 11.5, color: GRAY }}>
              Pick a condition grade — the description is generated from it, and there is no default.
            </div>
          )
        ))}

        {/* STATE + THE PRIMARY ACTION */}
        <div style={{ marginTop: 18, borderTop: "1px solid rgba(255,255,255,.08)", padding: "14px 2px 0" }}>
          {blocked && (
            <div style={{ fontSize: 12, color: RED, fontWeight: 700, lineHeight: 1.5 }}>
              ⛔ Blocked: {blocked}
              <div style={{ fontSize: 11, color: GRAY, fontWeight: 400, marginTop: 4 }}>
                Fix the reason above, then Publish again — publishing clears the block and the
                reconciler re-checks everything before anything goes public.
              </div>
            </div>
          )}
          {isLive && (
            <div style={{ fontSize: 11, color: GRAY, marginBottom: 8 }}>
              {on
                ? (node?.liveAt ? `Went live ${new Date(node.liveAt).toLocaleDateString()}` : "Live")
                : (offStory?.text || "On Shopify, not published")}
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
          {/* THE RETURN LEG, SAID OUT LOUD. A product taken off to be renamed,
              whose new name has since been saved, is finished waiting — and
              nothing in the app ever said so, which is why 97 of them have sat
              off since 22 August. This is a SENTENCE, not an action: nothing
              here switches a product on. */}
          {isLive && !on && offStory?.renamedSince && (
            <div style={{ fontSize: 11.5, color: GREEN, fontWeight: 700, marginBottom: 8, lineHeight: 1.5 }}>
              The new name is saved — this is ready to go back on the shop.
            </div>
          )}

          {isLive ? (
            // The on/off switch. OFF is instant intent — reversible, reduces
            // exposure, no dialog. ON re-confirms with the same dialog as
            // Publish. While pending, the switch waits for the reconciler.
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {pending && (
                <span style={{ fontSize: 11, color: BLUE_L }}>
                  Saved — waiting for the reconciler run to update Shopify.
                </span>
              )}
              <button disabled={busy || pending || on} onClick={requestSwitchOn}
                style={{ ...(on ? tabOn : tabOff), padding: "8px 16px", fontSize: "0.76rem" }}>
                On
              </button>
              <button disabled={busy || pending || !on}
                onClick={() => run(() => setDesiredState(product.id, node, "off", {
                  reasonCode: "switched_off",
                  detail: "switched off with the On/Off control on the product page",
                }), (res) => onChanged(product.id, res.node))}
                style={{ ...(!on ? tabOn : tabOff), padding: "8px 16px", fontSize: "0.76rem" }}>
                Off
              </button>
            </div>
          ) : pending ? (
            // A publish intent the reconciler hasn't applied yet — cancellable
            // without a dialog (cancelling only reduces exposure).
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: BLUE_L }}>
                Saved — waiting for the reconciler run to send it to Shopify.
              </span>
              <button disabled={busy}
                onClick={() => run(() => setDesiredState(product.id, node, "off", {
                  reasonCode: "publish_cancelled",
                  detail: "the pending publish was cancelled from the product page",
                }), (res) => onChanged(product.id, res.node))}
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: FONT,
                         fontSize: "0.76rem", fontWeight: 700, color: GRAY, padding: "8px 4px" }}>
                Cancel
              </button>
            </div>
          ) : (
            <button disabled={busy || !verdict.ok} onClick={requestPublish}
              style={{ ...bBlue, padding: "10px 18px", fontSize: "0.82rem", opacity: verdict.ok ? 1 : 0.4 }}>
              Publish
            </button>
          )}
          {error && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 8 }}>{error}</div>}
        </div>
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
