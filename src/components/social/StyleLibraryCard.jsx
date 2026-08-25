// ─── THE STYLE REFERENCE LIBRARY ─────────────────────────────────────────────
// Junid asked for this weeks ago and it was never built. It is where he keeps
// the photographs AND VIDEOS he likes the look of — a note on each, a few loose
// tags — and it is what the generator reads to know what "our posts look like".
//
// ── HOW IT DIFFERS FROM THE AI STUDIO STYLE KIT ──────────────────────────────
// The Style Kit (App.jsx StyleKitPanel, /aiAssistant/styleKit) is a locked,
// curated set of at most six scene references per template, sent to Nano Banana
// Pro to re-shoot ONE PRODUCT for the catalogue. It is a product-photography
// jig, and adding forty inspiration shots to it would make catalogue photos
// worse.
//
// This library is the opposite in temperament: open, growing, tagged, and it
// holds video — things Junid liked, whatever they are. The generator draws
// SOCIAL composition from here (which references it sends is chosen by
// functions/lib/social-select.cjs at generation time), and leaves the Style Kit
// alone. Two libraries, two jobs; neither writes to the other.
//
// ── WHY VIDEOS DO NOT COST ANYTHING TO BROWSE ────────────────────────────────
// The hard requirement: no video bodies loaded for the grid. A grid of forty
// <video src> elements starts forty range requests as soon as it paints, on a
// phone, over a South African mobile connection.
//
// So the poster frame is captured ONCE, here, at upload — the one moment the
// video is already decoded in this browser — downscaled to a JPEG, and stored
// beside it. The grid renders that JPEG with loading="lazy". A video body is
// fetched only when Junid taps a tile to actually watch it, and only that one.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FONT, GRAY, GREEN, RED, AMBER, BLUE_L, GLASS, tabOn, tabOff, input as inputStyle, bBlue, bGray, bRed } from "../stock/ui";
import RowBoundary from "./RowBoundary";
import {
  loadRefPage, mergeRefPage, addStyleRef, editStyleRef, deleteStyleRef,
  parseTags, resolveRefExt, REF_NOTE_MAX, REF_PAGE_SIZE,
} from "./socialStore";

// Poster/thumbnail geometry. 640px on the long edge is plenty for a grid tile
// and for the "recently liked" strip on the Generate tab, and small enough that
// a page of 24 is a couple of hundred kilobytes.
const THUMB_MAX = 640;
const THUMB_QUALITY = 0.82;

/** Draw a source (image or video element) onto a canvas, downscaled, as JPEG. */
function canvasToJpeg(source, w, h) {
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", THUMB_QUALITY));
}

/**
 * A still from a video file, WITHOUT uploading the video first.
 *
 * Seeking to 0 gives a black frame on a great many phone recordings (the first
 * frame is the sensor still waking up), so we seek a little way in — but not
 * past the end of a very short clip, which would leave `seeked` never firing
 * and the promise hanging. Everything is behind a timeout and the object URL is
 * always revoked, so a file the browser cannot decode fails in a few seconds
 * with a message instead of wedging the uploader.
 */
function videoPoster(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const done = (blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    const timer = setTimeout(() => done(null), 15000);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onerror = () => done(null);
    video.onloadedmetadata = () => {
      const d = Number(video.duration);
      video.currentTime = Number.isFinite(d) && d > 0 ? Math.min(1, d / 4) : 0;
    };
    video.onseeked = async () => {
      try { done(await canvasToJpeg(video, video.videoWidth, video.videoHeight)); }
      catch { done(null); }
    };
    video.src = url;
  });
}

/** A downscaled JPEG copy of an image file, for the grid. */
function imagePoster(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    let settled = false;
    const done = (blob) => { if (settled) return; settled = true; clearTimeout(timer); URL.revokeObjectURL(url); resolve(blob); };
    const timer = setTimeout(() => done(null), 15000);
    img.onerror = () => done(null);
    img.onload = async () => {
      try { done(await canvasToJpeg(img, img.naturalWidth, img.naturalHeight)); }
      catch { done(null); }
    };
    img.src = url;
  });
}

const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "3gp"]);

function Tile({ entry, onOpen, onEdit, onDelete, busy }) {
  const [playing, setPlaying] = useState(false);
  const isVideo = entry.type === "video";
  const [draftNote, setDraftNote] = useState(null);
  const [draftTags, setDraftTags] = useState(null);
  const dirty = draftNote !== null || draftTags !== null;

  return (
    <div style={{ ...GLASS, padding: 8, display: "flex", flexDirection: "column", gap: 6, opacity: entry.enabled === false ? 0.45 : 1 }}>
      <div style={{ position: "relative", aspectRatio: "3 / 4", borderRadius: 10, overflow: "hidden", background: "rgba(255,255,255,.04)" }}>
        {/* A video body is fetched only after a deliberate tap, and only this one. */}
        {isVideo && playing ? (
          <video src={entry.url} controls autoPlay playsInline
                 style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <>
            <img src={entry.thumbUrl || entry.url} alt="" loading="lazy"
                 onClick={() => (isVideo ? setPlaying(true) : onOpen(entry))}
                 style={{ width: "100%", height: "100%", objectFit: "cover", cursor: "pointer" }} />
            {isVideo && (
              <span style={{ position: "absolute", left: 7, bottom: 7, fontSize: 9, fontWeight: 800, letterSpacing: ".1em",
                             background: "rgba(0,0,0,.6)", border: "1px solid rgba(255,255,255,.25)", borderRadius: 6, padding: "2px 6px" }}>
                ▶ VIDEO
              </span>
            )}
          </>
        )}
      </div>

      <textarea
        value={draftNote !== null ? draftNote : (entry.note || "")}
        placeholder="Note (optional)"
        maxLength={REF_NOTE_MAX}
        rows={2}
        onChange={(e) => setDraftNote(e.target.value)}
        style={{ ...inputStyle, fontSize: "0.74rem", padding: "7px 9px", resize: "vertical" }}
      />
      <input
        value={draftTags !== null ? draftTags : (entry.tags || []).join(", ")}
        placeholder="tags, comma separated"
        onChange={(e) => setDraftTags(e.target.value)}
        style={{ ...inputStyle, fontSize: "0.72rem", padding: "6px 9px" }}
      />

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {dirty && (
          <button disabled={busy}
                  onClick={async () => {
                    await onEdit(entry.id, {
                      ...(draftNote !== null ? { note: draftNote } : {}),
                      ...(draftTags !== null ? { tags: draftTags } : {}),
                    });
                    setDraftNote(null); setDraftTags(null);
                  }}
                  style={{ ...bBlue, padding: "5px 10px", fontSize: "0.7rem" }}>Save</button>
        )}
        <button disabled={busy} onClick={() => onEdit(entry.id, { enabled: entry.enabled === false })}
                style={{ ...(entry.enabled === false ? tabOff : tabOn), padding: "5px 10px", fontSize: "0.7rem" }}>
          {entry.enabled === false ? "Off" : "On"}
        </button>
        <button disabled={busy} onClick={() => onDelete(entry)} style={{ ...bRed, padding: "5px 10px", fontSize: "0.7rem" }}>Delete</button>
      </div>
    </div>
  );
}

export default function StyleLibraryCard({ onNotice, notice }) {
  const [refs, setRefs] = useState(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [tagFilter, setTagFilter] = useState(null);
  const fileRef = useRef(null);

  const loadFirst = useCallback(async () => {
    setError(null);
    try {
      const { refs: page, done: d } = await loadRefPage({});
      setRefs(page);
      setDone(d);
    } catch (err) {
      setRefs([]);
      setError(String(err?.message || err));
    }
  }, []);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  const loadMore = async () => {
    if (!refs || !refs.length) return;
    const oldest = refs[refs.length - 1].addedAt;
    setBusy(true);
    try {
      // `held` lets the store tell a boundary re-fetch (see loadRefPage — the
      // cursor is inclusive on purpose) apart from a genuine end of list.
      const { refs: page, done: d } = await loadRefPage({ before: oldest, held: refs });
      setRefs((cur) => mergeRefPage(cur, page));
      setDone(d);
    } catch (err) {
      setError(String(err?.message || err));
    } finally { setBusy(false); }
  };

  const handleFiles = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    let ok = 0;
    const failures = [];
    for (const [i, file] of files.entries()) {
      setProgress(`Adding ${i + 1} of ${files.length}…`);
      const ext = resolveRefExt(file);
      const isVideo = ext ? VIDEO_EXTS.has(ext) : false;
      // The poster is captured BEFORE the upload: if the browser cannot read a
      // frame from a video we refuse the whole entry rather than index a video
      // the grid would have to decode to show.
      const thumbBlob = isVideo ? await videoPoster(file) : await imagePoster(file);
      const res = await addStyleRef(file, { note, tags, thumbBlob });
      if (res.ok) ok++;
      else failures.push(`${file.name}: ${res.message}`);
    }
    setProgress(null);
    setBusy(false);
    setNote(""); setTags("");
    await loadFirst();
    if (failures.length) onNotice({ kind: "err", text: `Added ${ok}. ${failures.length} failed — ${failures[0]}` });
    else onNotice({ kind: "ok", text: `Added ${ok} reference${ok === 1 ? "" : "s"}.` });
  };

  const onEdit = async (id, fields) => {
    const res = await editStyleRef(id, fields);
    if (res.ok === false) onNotice({ kind: "err", text: res.message });
    else await loadFirst();
  };

  const onDelete = async (entry) => {
    const res = await deleteStyleRef(entry);
    if (res.ok === false) onNotice({ kind: "err", text: res.message });
    else { onNotice({ kind: "ok", text: "Deleted." }); await loadFirst(); }
  };

  // Tag chips are built from what has actually been typed — no fixed
  // vocabulary, because the brief asked for light FREE-TEXT tags.
  const allTags = useMemo(() => {
    const seen = new Map();
    for (const r of refs || []) for (const t of r.tags || []) seen.set(t, (seen.get(t) || 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [refs]);

  const shown = useMemo(
    () => (refs || []).filter((r) => !tagFilter || (r.tags || []).includes(tagFilter)),
    [refs, tagFilter]
  );

  return (
    <div style={{ padding: "12px 14px 0" }}>
      <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.6, marginBottom: 12 }}>
        Photos and videos you like the look of. The generator uses these as style reference
        when it composes a post. Add anything — a shot from another shop, a video that has the
        right feel, one of your own you were happy with.
      </div>

      <div style={{ ...GLASS, padding: 12, marginBottom: 14 }}>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for what you're about to add (optional)"
          maxLength={REF_NOTE_MAX}
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: "0.82rem" }}
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="Tags, comma separated (optional) — e.g. flat lay, outdoor, moody"
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: "0.8rem", marginTop: 8 }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button disabled={busy} onClick={() => fileRef.current?.click()} style={bBlue}>
            {busy ? (progress || "Working…") : "Add photos or videos"}
          </button>
          {parseTags(tags).length > 0 && (
            <span style={{ fontSize: 11, color: GRAY }}>tags: {parseTags(tags).join(" · ")}</span>
          )}
        </div>
        <input ref={fileRef} type="file" multiple accept="image/*,video/*" onChange={handleFiles} style={{ display: "none" }} />
      </div>

      {notice && (
        <div style={{ fontSize: 12, fontWeight: 700, padding: "6px 2px 10px", color: notice.kind === "err" ? RED : GREEN }}>
          {notice.text}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: RED, fontWeight: 700, padding: "12px 2px", lineHeight: 1.5 }}>
          Couldn't load the library: {error}
          <div style={{ color: GRAY, fontWeight: 400, marginTop: 6 }}>
            If this says permission denied, the /social_style_refs console rule has not been
            pasted yet — run <code>node scripts/social/print-social-rules.mjs</code>.
          </div>
        </div>
      )}

      {allTags.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          <button onClick={() => setTagFilter(null)} style={{ ...(tagFilter ? tabOff : tabOn), padding: "5px 11px", fontSize: "0.72rem" }}>All</button>
          {allTags.map(([t, n]) => (
            <button key={t} onClick={() => setTagFilter(t === tagFilter ? null : t)}
                    style={{ ...(tagFilter === t ? tabOn : tabOff), padding: "5px 11px", fontSize: "0.72rem" }}>
              {t} {n}
            </button>
          ))}
        </div>
      )}

      {refs === null && !error && <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>Loading…</div>}
      {refs && refs.length === 0 && !error && (
        <div style={{ fontSize: 12.5, color: GRAY, padding: "18px 2px", lineHeight: 1.6 }}>
          Nothing yet. Add the first few and the generator will start drawing on them.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(196px, 42vw), 1fr))", gap: 10 }}>
        {/* One tile per boundary, same reasoning as the queue rows: a
            reference with a shape the tile cannot render is one broken tile
            with a Delete button, not a dead library tab. Delete is the right
            action here — unlike a post, a style reference carries nothing
            worth keeping once it cannot be shown. */}
        {shown.map((entry) => (
          <RowBoundary key={entry.id} recordId={entry.id} label="reference" busy={busy}
                       actionLabel="Delete it" onAction={() => onDelete(entry)}>
            <Tile entry={entry} busy={busy}
                  onOpen={() => window.open(entry.url, "_blank", "noopener")}
                  onEdit={onEdit} onDelete={onDelete} />
          </RowBoundary>
        ))}
      </div>

      {refs && refs.length > 0 && !done && (
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
          <button disabled={busy} onClick={loadMore} style={bGray}>
            {busy ? "Loading…" : `Load ${REF_PAGE_SIZE} more`}
          </button>
        </div>
      )}
    </div>
  );
}
