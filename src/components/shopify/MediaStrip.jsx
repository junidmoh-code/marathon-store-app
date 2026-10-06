// ─── SHOPIFY PUBLISHING — PHOTOS AND VIDEOS ─────────────────────────────────
// The product's whole publishing media set on the product page: one ordered
// list of photos AND videos, first = the primary photo customers see on the
// grid. It replaces the photo-only PhotoStrip and keeps its interaction
// pattern (the repo's own): tap a thumbnail to select it (white border, the
// rest dimmed — GalleryLightbox's strip from App.jsx), then act on it with
// chips. Reordering is the ‹ › pair on the selected item: big tap targets
// that work one-handed on a phone, where a drag would fight the page scroll.
//
// WHAT CANNOT HAPPEN, NOT WHAT IS WARNED ABOUT. Position 0 is always a photo:
// every move, removal and Make primary is computed first and its chip is
// DISABLED when the result would put a video first (or leave no photo), and
// the store refuses such a list anyway (mediaListProblem). A video has no
// Make primary chip at all.
//
// BANDWIDTH. Thumbnails are photos and video POSTERS (small JPEGs made on the
// phone at upload). The strip never mounts a <video>. Selecting a video shows
// a player with preload="none" and its poster: the original streams only when
// someone taps play. Nothing autoplays.
//
// Adding: Gallery (several photos and videos at once), Take photo, Record
// video. Each file runs its own queue row — hashing, checking, uploading
// (with %), or the plain reason it was refused — and only joins the list once
// its bytes are in Storage (mediaUpload.js), so a failure leaves no ghost.
//
// Editing is allowed while the listing is ON: the reconciler carries the
// change to Shopify on its next run, with no extra tap (Junid, 6 Oct 2026).
// A change of PRIMARY also becomes the app photo (Junid, 26 Sep 2026).
import React, { useEffect, useRef, useState } from "react";
import { FONT, GRAY, GREEN, RED, AMBER, BLUE_L, tabOff, bGray, bRed } from "../stock/ui";
import { photoUrlsOf, shopifyVideoProblem, MAX_PUBLISH_MEDIA, resolveMediaList, storagePathOf } from "./publishShared";
import { isOn } from "./shopifyPublishCore";
import { setPublishMedia, appendPublishMedia } from "./shopifyPublishStore";
import { prepareMediaItem, pickedKind, pickedFileProblem, newMediaId } from "./mediaUpload";
import { syncAppPhoto } from "./appPhoto";
import AiStudioCard from "./AiStudioCard";
import { moveItem, makePrimary, removeItem, replaceItem } from "./mediaEdits";
import { usePermissions } from "../PermissionsContext";
import { auth } from "../../firebase";

// What the reconciler last said about an item on Shopify, in Junid's words.
const SHOPIFY_STATE = {
  queued: { text: "waiting for its turn to go to Shopify", color: GRAY },
  uploading: { text: "sending to Shopify", color: BLUE_L },
  processing: { text: "Shopify is processing it", color: BLUE_L },
  ready: { text: "on Shopify", color: GREEN },
  failed: { text: "Shopify could not process it", color: RED },
};
export function shopifyLine(item, node) {
  const tooBig = shopifyVideoProblem(item);
  if (tooBig) return { text: tooBig, color: AMBER, tooBig: true };
  const st = node?.mediaShopify?.[item.id];
  if (st && SHOPIFY_STATE[st.status]) {
    const s = SHOPIFY_STATE[st.status];
    return { text: st.note ? `${s.text} — ${st.note}` : s.text, color: s.color };
  }
  if (node?.state === "live") return { text: "goes to Shopify at the next sync (within a few minutes)", color: GRAY };
  return { text: "goes to Shopify when the product is published", color: GRAY };
}

const fmtDuration = (ms) => {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

function Thumb({ item, index, selected, dim, line, onSelect, fallbackPoster = null }) {
  const video = item.type === "video";
  // A video's thumbnail is its poster drawn at upload, else Shopify's own
  // preview frame once it has processed the video — never the video itself.
  const poster = item.posterUrl || fallbackPoster;
  return (
    <div style={{ position: "relative" }}>
      <button type="button" onClick={onSelect} aria-label={`${video ? "Video" : "Photo"} ${index + 1}${index === 0 ? ", primary" : ""}`}
        style={{ width: 84, height: 84, padding: 0, borderRadius: 9, overflow: "hidden", cursor: "pointer",
                 background: "rgba(255,255,255,.08)", border: selected ? "2px solid #fff" : "2px solid transparent",
                 opacity: dim ? 0.55 : 1, display: "block" }}>
        {video && !poster ? (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                        color: "#fff", fontSize: 26 }}>▶</div>
        ) : (
          <img src={video ? poster : item.url} alt="" loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        )}
      </button>
      {index === 0 && (
        <div style={{ position: "absolute", left: 3, bottom: 3, fontSize: 8, fontWeight: 800, color: GREEN,
                      background: "rgba(0,0,0,.62)", borderRadius: 5, padding: "1px 4px", pointerEvents: "none" }}>
          PRIMARY
        </div>
      )}
      {video && (
        <div style={{ position: "absolute", left: 3, top: 3, fontSize: 8, fontWeight: 800, color: "#fff",
                      background: "rgba(0,0,0,.62)", borderRadius: 5, padding: "1px 4px", pointerEvents: "none" }}>
          ▶ VIDEO{item.durationMs ? ` ${fmtDuration(item.durationMs)}` : ""}
        </div>
      )}
      {line?.tooBig && (
        <div style={{ position: "absolute", right: 3, bottom: 3, fontSize: 8, fontWeight: 800, color: AMBER,
                      background: "rgba(0,0,0,.7)", borderRadius: 5, padding: "1px 4px", pointerEvents: "none" }}>
          NOT ON SHOPIFY
        </div>
      )}
    </div>
  );
}

const PHASE_TEXT = {
  waiting: "waiting", hashing: "checking the file", checking: "checking it isn't another product's",
  uploading: "uploading", paused: "paused — no connection; resumes by itself", poster: "saving the preview",
  saving: "adding to the list", done: "added", failed: "not added",
};

export default function MediaStrip({ product, node, onChanged }) {
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canGenerate = isSuperAdmin || hasPermission("photo_generation");
  const { items } = resolveMediaList(node, product);
  const [sel, setSel] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [queue, setQueue] = useState([]); // [{ key, label, kind, phase, done, total, error, cancel }]
  const nodeRef = useRef(node);
  useEffect(() => { nodeRef.current = node; }, [node]);
  const runningRef = useRef(false);
  const galleryRef = useRef(null);
  const photoCamRef = useRef(null);
  const videoCamRef = useRef(null);
  const live = isOn(node);
  const selected = sel !== null ? items[sel] : null;
  useEffect(() => { setConfirmRemove(false); }, [sel]);
  useEffect(() => { if (sel !== null && sel >= items.length) setSel(null); }, [sel, items.length]);

  // After any committed write: fold the node back, and if the PRIMARY changed,
  // the app photo follows.
  const afterWrite = async (res, oldPrimary) => {
    nodeRef.current = res.node;
    onChanged(product.id, res.node);
    const newPrimary = photoUrlsOf(resolveMediaList(res.node, product).items)[0] || null;
    if (newPrimary && newPrimary !== oldPrimary) {
      // One retry: the list is already saved, and the app photo must follow it.
      let app = await syncAppPhoto(product.id, product, oldPrimary, newPrimary);
      if (!app.ok) app = await syncAppPhoto(product.id, product, oldPrimary, newPrimary);
      if (!app.ok) setErr(app.message);
      else if (app.changed) setNote("The new primary photo is now the product's photo in the app too.");
    }
  };

  // → true iff the list committed.
  const write = async (next, after) => {
    if (!next) return false;
    setBusy(true); setErr(null); setNote(null);
    const oldPrimary = photoUrlsOf(items)[0] || null;
    try {
      // The basis is the SAME snapshot `items` came from (the rendered node):
      // a write computed from a list that has since grown must be refused,
      // never silently drop what was added in between.
      const res = await setPublishMedia(product.id, node, next);
      if (!res?.ok) { setErr(res?.message || "Not saved."); return false; }
      await afterWrite(res, oldPrimary);
      after?.();
      return true;
    } catch (e) {
      setErr(String(e?.message || e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // ── ADDING ──────────────────────────────────────────────────────────────────
  const patchRow = (key, patch) => setQueue((q) => q.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // ONE pump drains the pending rows in order, whatever batch they came from:
  // files picked while an upload is still running join the same line.
  const pendingRef = useRef([]);
  const pump = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      while (pendingRef.current.length) {
        const row = pendingRef.current.shift();
        patchRow(row.key, { phase: "hashing" });
        try {
          const current = resolveMediaList(nodeRef.current, product).items;
          const item = await prepareMediaItem(product.id, row.file, {
            existing: current,
            uid: auth.currentUser?.uid || null,
            onStep: ({ phase, done, total }) => patchRow(row.key, { phase, done, total }),
            registerCancel: (fn) => patchRow(row.key, { cancel: fn }),
          });
          patchRow(row.key, { phase: "saving", cancel: null });
          const oldPrimary = photoUrlsOf(current)[0] || null;
          const res = await appendPublishMedia(product.id, nodeRef.current, [item], product);
          if (!res?.ok) throw new Error(res?.message || "Not saved.");
          await afterWrite(res, oldPrimary);
          patchRow(row.key, { phase: "done" });
        } catch (e) {
          const canceled = /canceled|cancelled/i.test(String(e?.code || e?.message || ""));
          patchRow(row.key, { phase: "failed", cancel: null,
                              error: canceled ? "Cancelled — nothing was added." : String(e?.message || e) });
        }
      }
    } finally {
      runningRef.current = false;
      // Finished rows fade from the queue; refusals stay until dismissed.
      setTimeout(() => setQueue((q) => q.filter((r) => r.phase !== "done")), 2500);
    }
  };

  const onPicked = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setErr(null); setNote(null);
    // Files still waiting in the queue count against Shopify's cap too.
    const room = MAX_PUBLISH_MEDIA - items.length - pendingRef.current.length;
    // With no photo in the list yet a video cannot go first, so photos go first.
    const hasPhoto = items.some((m) => m.type === "photo");
    const ordered = hasPhoto ? files : [...files.filter((f) => pickedKind(f) === "photo"), ...files.filter((f) => pickedKind(f) !== "photo")];
    const rows = ordered.map((file, i) => {
      const kind = pickedKind(file);
      const problem = pickedFileProblem(file) || (i >= room ? `Shopify takes at most ${MAX_PUBLISH_MEDIA} photos and videos per product.` : null);
      return { key: `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`, kind: kind || "file",
               label: `${kind === "video" ? "Video" : "Photo"} ${i + 1} of ${ordered.length}${kind === "video" ? ` · ${fmtBytes(file.size)}` : ""}`,
               phase: problem ? "failed" : "waiting", error: problem, file };
    });
    setQueue((q) => [...q.filter((r) => r.phase !== "done"), ...rows]);
    pendingRef.current.push(...rows.filter((r) => r.phase === "waiting"));
    pump();
  };
  const uploading = queue.some((r) => !["done", "failed"].includes(r.phase));

  const chip = (label, onClick, enabled = true, style = {}) => (
    <button key={label} type="button" disabled={busy || !enabled} onClick={onClick}
      style={{ ...tabOff, padding: "6px 11px", fontSize: "0.7rem", opacity: busy || !enabled ? 0.45 : 1, ...style }}>
      {label}
    </button>
  );

  const i = sel;
  const back = i !== null ? moveItem(items, i, -1) : null;
  const fwd = i !== null ? moveItem(items, i, 1) : null;
  const prim = i !== null ? makePrimary(items, i) : null;
  const rem = i !== null ? removeItem(items, i) : null;
  const line = selected ? shopifyLine(selected, node) : null;
  const photoCount = items.filter((m) => m.type === "photo").length;

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        {items.map((m, k) => (
          <Thumb key={m.id} item={m} index={k} selected={sel === k} dim={sel !== null && sel !== k}
            line={m.type === "video" ? shopifyLine(m, node) : null}
            fallbackPoster={node?.mediaShopify?.[m.id]?.previewUrl || null}
            onSelect={() => setSel(sel === k ? null : k)} />
        ))}
      </div>

      {/* ADD — gallery (several at once), take a photo, record a video. Plain
          image and video types, not a narrow list: a narrow accept list is
          what greys an iPhone's HEIC camera roll out of the picker. The real
          gates run on whatever comes back (pickedFileProblem). */}
      <input ref={galleryRef} type="file" accept="image/*,video/*" multiple onChange={onPicked} style={{ display: "none" }} />
      <input ref={photoCamRef} type="file" accept="image/*" capture="environment" onChange={onPicked} style={{ display: "none" }} />
      <input ref={videoCamRef} type="file" accept="video/*" capture="environment" onChange={onPicked} style={{ display: "none" }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 }}>
        <button type="button" disabled={busy} onClick={() => galleryRef.current?.click()} style={{ ...bGray, padding: "8px 12px", fontSize: "0.74rem" }}>
          ＋ From gallery
        </button>
        <button type="button" disabled={busy} onClick={() => photoCamRef.current?.click()} style={{ ...bGray, padding: "8px 12px", fontSize: "0.74rem" }}>
          📷 Take photo
        </button>
        <button type="button" disabled={busy} onClick={() => videoCamRef.current?.click()} style={{ ...bGray, padding: "8px 12px", fontSize: "0.74rem" }}>
          🎥 Record video
        </button>
      </div>

      {queue.length > 0 && (
        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
          {queue.map((r) => {
            const pct = r.total ? Math.floor((100 * (r.done || 0)) / r.total) : null;
            return (
              <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11,
                                        color: r.phase === "failed" ? RED : r.phase === "done" ? GREEN : GRAY }}>
                <span style={{ fontWeight: 700, color: "#dfe7ff" }}>{r.label}</span>
                <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  {r.phase === "failed" ? r.error : PHASE_TEXT[r.phase] || r.phase}
                  {["uploading", "hashing", "paused"].includes(r.phase) && pct != null ? ` ${pct}%` : ""}
                </span>
                {r.cancel && r.phase !== "done" && (
                  <button type="button" onClick={() => r.cancel()} style={{ ...tabOff, padding: "3px 8px", fontSize: "0.62rem" }}>Cancel</button>
                )}
                {r.phase === "failed" && (
                  <button type="button" onClick={() => setQueue((q) => q.filter((x) => x.key !== r.key))}
                    style={{ ...tabOff, padding: "3px 8px", fontSize: "0.62rem" }}>OK</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 10, color: GRAY, marginTop: 6, lineHeight: 1.5 }}>
        {items.length} item{items.length === 1 ? "" : "s"} · {photoCount} photo{photoCount === 1 ? "" : "s"} · {items.length - photoCount} video{items.length - photoCount === 1 ? "" : "s"}.{" "}
        {live
          ? "Live on the shop — changes reach Shopify by themselves at the next sync, within a few minutes."
          : "Goes to Shopify, in this order, when the product is published."}
        {uploading ? " Keep this page open until uploads finish." : ""}
      </div>

      {selected && (
        <div style={{ marginTop: 9, border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "10px 11px" }}>
          {selected.type === "video" && (
            // Plays ONLY on a tap: preload="none" with the poster, so nothing
            // of the original is fetched until then. playsInline for iPhone.
            <video key={selected.id} src={selected.url} poster={selected.posterUrl || node?.mediaShopify?.[selected.id]?.previewUrl || undefined}
              preload="none" controls playsInline
              style={{ width: "100%", maxHeight: 360, borderRadius: 8, background: "#000", display: "block", marginBottom: 8 }} />
          )}
          <div style={{ fontSize: 11, color: GRAY, lineHeight: 1.5 }}>
            {selected.type === "video" ? "Video" : "Photo"} {i + 1} of {items.length}
            {i === 0 ? " — the primary photo (the grid tile and the app photo)" : ""}
            {selected.type === "video" && selected.bytes ? ` · ${fmtBytes(selected.bytes)}` : ""}
            {selected.type === "video" && selected.width ? ` · ${selected.width}×${selected.height}` : ""}
            {selected.type === "video" && selected.durationMs ? ` · ${fmtDuration(selected.durationMs)}` : ""}
            {line && <div style={{ color: line.color, fontWeight: 700 }}>Shopify: {line.text}</div>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
            {chip("‹ Move", () => write(back, () => setSel(i - 1)), !!back)}
            {chip("Move ›", () => write(fwd, () => setSel(i + 1)), !!fwd)}
            {selected.type === "photo" && chip("Make primary", () => write(prim, () => setSel(0)), !!prim)}
            {!confirmRemove
              ? chip("Remove…", () => setConfirmRemove(true), !!rem)
              : (
                <>
                  <span style={{ fontSize: 11, color: "#dfe7ff", alignSelf: "center" }}>
                    Remove this {selected.type} from the shop{i === 0 ? " (the next photo becomes primary)" : ""}?
                  </span>
                  <button type="button" disabled={busy} onClick={() => write(rem, () => setSel(null))}
                    style={{ ...bRed, padding: "6px 11px", fontSize: "0.7rem" }}>Remove</button>
                  {chip("Keep", () => setConfirmRemove(false))}
                </>
              )}
          </div>
          {!rem && items.length > 0 && (
            <div style={{ fontSize: 10, color: GRAY, marginTop: 5 }}>
              {photoCount <= 1 && selected.type === "photo"
                ? "This is the only photo — add another before removing it. A product always has a photo first."
                : ""}
            </div>
          )}
          {selected.type === "photo" && canGenerate && (
            <div style={{ marginTop: 6 }}>
              <AiStudioCard
                product={product} node={node} sourceUrl={selected.url} photoCount={items.length}
                isPrimary={i === 0} busy={busy || uploading}
                onReplace={(url, sourceUrl, meta = {}) => write(replaceItem(items, sourceUrl, {
                  id: newMediaId(), type: "photo", url, path: storagePathOf(url) || undefined, sha256: meta.sha256,
                  source: "ai", derivedFrom: sourceUrl, addedBy: auth.currentUser?.uid || undefined,
                }))}
                onAdd={async (url, meta = {}) => {
                  const oldPrimary = photoUrlsOf(items)[0] || null;
                  setBusy(true); setErr(null);
                  try {
                    const res = await appendPublishMedia(product.id, nodeRef.current, [{
                      id: newMediaId(), type: "photo", url, path: storagePathOf(url) || undefined,
                      sha256: meta.sha256, source: "ai", derivedFrom: selected.url,
                      ...(auth.currentUser?.uid ? { addedBy: auth.currentUser.uid } : {}),
                    }], product);
                    if (!res?.ok) { setErr(res?.message || "Not saved."); return false; }
                    await afterWrite(res, oldPrimary);
                    setSel(resolveMediaList(res.node, product).items.length - 1);
                    return true;
                  } finally { setBusy(false); }
                }} />
            </div>
          )}
        </div>
      )}
      {note && <div style={{ fontSize: 11, color: GREEN, fontWeight: 700, marginTop: 6 }}>{note}</div>}
      {err && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
