// ─── TV BACKGROUND — section of the TV Ad card ───────────────────────────────
// Upload photos for the queue board's wall, then either pick ONE as the
// default or let them rotate on a timer. Writes /settings/tvBackgrounds
// (shape in src/utils/tvBackgrounds.js); the board picks the change up live.
//
// As many photos as you like. Each can be limited to chosen weekdays with the
// day chips under it (all on = every day); the filter row shows what a given
// day's rotation will be. On a day with no photos tagged for it, the board
// shows the every-day photos.
//
// Photos are resized in the browser before upload (1920 px long edge, JPEG) so
// a 12 MB phone photo lands on the TVs as a few hundred KB, with a 320 px
// thumbnail beside it — this grid only ever loads the thumbnails. They live
// under products/tv-backgrounds/ in Storage — the prefix staff accounts can
// already write and the TVs can already read, so no rules change is needed.
// The writes themselves are in src/utils/tvBackgroundOps.js.
import { useEffect, useMemo, useRef, useState } from "react";
import { push, ref, remove, runTransaction, update } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject, getBlob } from "firebase/storage";
import { database, storage, auth } from "../firebase";
import { serverNowMs } from "../utils/serverTime";
import {
  useTvBackgrounds, pickTvBackground, photosForDay, photoShowsOn, toggleDay, johannesburgDay,
  TV_BACKGROUNDS_PATH, MIN_ROTATE_SECONDS, WEEK_DAYS,
} from "../utils/tvBackgrounds";
import {
  uploadTvBackground, removeTvBackground, setTvBackgroundDays, swapTvBackgroundOrder,
  backfillThumbs, encodeJpeg,
} from "../utils/tvBackgroundOps";

function who() {
  return auth.currentUser?.email || auth.currentUser?.uid || "unknown";
}

// Firebase behind the ops' io contract (see tvBackgroundOps.js).
const io = {
  newId: () => push(ref(database, `${TV_BACKGROUNDS_PATH}/photos`)).key,
  putFile: async (path, blob) => {
    const sRef = storageRef(storage, path);
    await uploadBytes(sRef, blob, { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" });
    return getDownloadURL(sRef);
  },
  deleteFile: (path) => deleteObject(storageRef(storage, path)),
  getFile: (path) => getBlob(storageRef(storage, path)),
  update: (rel, patch) => update(ref(database, rel ? `${TV_BACKGROUNDS_PATH}/${rel}` : TV_BACKGROUNDS_PATH), patch),
  remove: (rel) => remove(ref(database, `${TV_BACKGROUNDS_PATH}/${rel}`)),
  claimThumb: async (id, t) => {
    // Only the photo's own node — never the whole backgrounds node.
    const res = await runTransaction(ref(database, `${TV_BACKGROUNDS_PATH}/photos/${id}`), (cur) => {
      if (!cur || !cur.url || cur.thumbUrl) return undefined; // abort: removed, or someone else won
      return { ...cur, ...t };
    });
    return !!res.committed;
  },
  nowMs: () => serverNowMs(),
  who,
  encode: encodeJpeg,
};

const card = { background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 16 };
const muted = { fontSize: 12.5, color: "rgba(255,255,255,0.5)" };
const numInput = { width: 70, boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff" };
const chip = (on) => ({
  flex: 1, minWidth: 0, padding: "4px 0", borderRadius: 5, fontSize: 10.5, fontWeight: 700, cursor: "pointer",
  border: "none", background: on ? "rgba(74,127,255,0.85)" : "rgba(255,255,255,0.07)", color: on ? "#fff" : "rgba(255,255,255,0.4)",
});
const smallBtn = { padding: "6px 8px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "none", background: "rgba(255,255,255,0.1)", color: "#fff" };

export default function TvBackgroundsSection() {
  const cfg = useTvBackgrounds();
  const [uploading, setUploading] = useState("");
  const [confirmId, setConfirmId] = useState("");
  const [error, setError] = useState("");
  const [minInput, setMinInput] = useState("");
  const [secInput, setSecInput] = useState("");
  const [dayFilter, setDayFilter] = useState(null); // null = All, else 0–6
  // "ON TV NOW" uses the same server clock and tick as the TV itself.
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  const rotating = cfg?.mode === "rotate" && (cfg?.photos.length || 0) > 1;
  useEffect(() => {
    const t = setInterval(() => setNowMs(serverNowMs()), rotating ? 5000 : 60_000);
    return () => clearInterval(t);
  }, [rotating]);

  useEffect(() => {
    if (!cfg) return;
    setMinInput(String(Math.floor(cfg.rotateSeconds / 60)));
    setSecInput(String(cfg.rotateSeconds % 60));
  }, [cfg?.rotateSeconds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Photos from before thumbnails: make each one's thumb once, so this grid
  // stops loading full-size photos. One attempt per photo per visit.
  const triedThumbs = useRef(new Set());
  useEffect(() => {
    if (!cfg) return;
    const todo = cfg.photos.filter((p) => !p.thumbUrl && p.path && !triedThumbs.current.has(p.id));
    if (!todo.length) return;
    todo.forEach((p) => triedThumbs.current.add(p.id));
    backfillThumbs(io, todo).catch(() => {});
  }, [cfg]);

  const shown = useMemo(
    () => (!cfg ? [] : dayFilter === null ? cfg.photos : photosForDay(cfg, dayFilter)),
    [cfg, dayFilter],
  );

  if (!cfg) return <div style={card}><div style={muted}>Loading backgrounds…</div></div>;

  const fail = (fallback) => (err) => setError(err?.message || fallback);
  const save = (patch) => io.update("", { ...patch, updatedAt: serverNowMs(), updatedBy: who() })
    .catch(fail("Save failed."));
  const onScreen = pickTvBackground(cfg, nowMs);
  const today = johannesburgDay(nowMs);
  const defaultPhoto = cfg.photos.find((x) => x.id === cfg.defaultId) || cfg.photos[0];

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    if (!files.length) return;
    setError("");
    let firstId = "";
    // New photos go to the end of the rotation, in the order they were picked.
    const base = Math.max(serverNowMs(), ...cfg.photos.map((p) => p.order + 1));
    try {
      for (let i = 0; i < files.length; i++) {
        setUploading(`Uploading ${i + 1} of ${files.length}…`);
        const id = await uploadTvBackground(io, files[i], { orderBase: base + i });
        if (!firstId) firstId = id;
      }
      // The very first photo becomes the default, so an upload shows at once.
      if (firstId && !cfg.defaultId) await save({ defaultId: firstId });
    } catch (err) {
      setError(err?.message || "Upload failed.");
    } finally {
      setUploading("");
    }
  };

  const removePhoto = async (p) => {
    if (confirmId !== p.id) { setConfirmId(p.id); return; }
    setConfirmId("");
    setError("");
    try {
      await removeTvBackground(io, p, { wasDefault: cfg.defaultId === p.id });
    } catch (err) {
      setError(err?.message || "Remove failed.");
    }
  };

  const tapDay = (p, day) => {
    const next = toggleDay(p.days, day);
    if (next === undefined) { setError("A photo needs at least one day — use ✕ to remove it instead."); return; }
    setError("");
    setTvBackgroundDays(io, p.id, next).catch(fail("Save failed."));
  };

  const move = (p, dir) => {
    const i = cfg.photos.findIndex((x) => x.id === p.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cfg.photos.length) return;
    swapTvBackgroundOrder(io, cfg.photos[i], cfg.photos[j]).catch(fail("Save failed."));
  };

  const commitRotate = () => {
    const min = Math.max(0, Math.round(Number(minInput) || 0));
    const sec = Math.max(0, Math.min(59, Math.round(Number(secInput) || 0)));
    const total = Math.max(MIN_ROTATE_SECONDS, min * 60 + sec);
    setMinInput(String(Math.floor(total / 60)));
    setSecInput(String(total % 60));
    if (total !== cfg.rotateSeconds) save({ rotateSeconds: total });
  };

  const modeBtn = (mode, label) => (
    <button type="button" onClick={() => save({ mode })} aria-pressed={cfg.mode === mode}
      style={{
        flex: 1, padding: "9px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13.5,
        border: "1px solid rgba(255,255,255,0.15)",
        background: cfg.mode === mode ? "#4A7FFF" : "rgba(0,0,0,0.3)", color: "#fff",
      }}>{label}</button>
  );

  const filterBtn = (value, label) => (
    <button key={label} type="button" onClick={() => setDayFilter(value)} aria-pressed={dayFilter === value}
      style={{
        padding: "5px 9px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer",
        border: value === today && value !== null ? "1px solid rgba(34,197,94,0.6)" : "1px solid rgba(255,255,255,0.15)",
        background: dayFilter === value ? "#4A7FFF" : "rgba(0,0,0,0.3)", color: "#fff",
      }}>{label}</button>
  );

  const dayLabel = dayFilter === null ? "" : WEEK_DAYS.find((d) => d.day === dayFilter)?.label;
  const dayTagged = dayFilter === null ? 0 : cfg.photos.filter((p) => p.days.length && p.days.includes(dayFilter)).length;

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontWeight: 700 }}>TV background</div>
        <div style={muted}>
          {cfg.photos.length === 0
            ? "No photos yet — the TV shows the built-in sneaker room."
            : cfg.mode === "rotate" && cfg.photos.length > 1
              ? `${cfg.photos.length} photos. Today the TV rotates ${photosForDay(cfg, today).length} of them.`
              : `${cfg.photos.length} photo${cfg.photos.length === 1 ? "" : "s"}. One photo, always on.`}
        </div>
      </div>

      {cfg.photos.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {filterBtn(null, "All")}
          {WEEK_DAYS.map((d) => filterBtn(d.day, d.label))}
        </div>
      )}
      {dayFilter !== null && cfg.photos.length > 0 && (
        <div style={muted}>
          {shown.length === 0
            ? `Nothing on ${dayLabel} — the TV shows the built-in sneaker room.`
            : dayTagged
              ? `${dayLabel}: ${dayTagged} photo${dayTagged === 1 ? "" : "s"} picked for ${dayLabel} — the every-day photos rest that day.`
              : `No photos picked for ${dayLabel} only, so the every-day photos show.`}
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
          {shown.map((p) => {
            const isDefault = p.id === defaultPhoto?.id;
            const live = onScreen?.id === p.id;
            const idx = cfg.photos.findIndex((x) => x.id === p.id);
            return (
              <div key={p.id} style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, overflow: "hidden",
                outline: isDefault ? "2px solid #F2B33D" : "1px solid rgba(255,255,255,0.1)" }}>
                <div style={{ position: "relative" }}>
                  {/* The 320 px thumb; a photo from before thumbs shows its full
                      image until the backfill above has made one. */}
                  <img src={p.thumbUrl || p.url} alt={p.name || "TV background"} loading="lazy"
                    style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", display: "block" }} />
                  {live && <span style={{ position: "absolute", left: 6, top: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5,
                    background: "#22C55E", color: "#05210f", borderRadius: 4, padding: "2px 6px" }}>ON TV NOW</span>}
                </div>
                <div style={{ display: "flex", gap: 3, padding: "6px 6px 0" }} role="group" aria-label="Days this photo shows">
                  {WEEK_DAYS.map((d) => {
                    const on = photoShowsOn(p, d.day);
                    return (
                      <button key={d.day} type="button" onClick={() => tapDay(p, d.day)} aria-pressed={on}
                        title={on ? `Shows on ${d.label}` : `Hidden on ${d.label}`} style={chip(on)}>
                        {d.label.slice(0, 2)}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 6, padding: 6 }}>
                  {dayFilter === null && (
                    <>
                      <button type="button" onClick={() => move(p, -1)} disabled={idx <= 0} aria-label="Move earlier"
                        style={{ ...smallBtn, opacity: idx <= 0 ? 0.35 : 1 }}>◀</button>
                      <button type="button" onClick={() => move(p, 1)} disabled={idx >= cfg.photos.length - 1} aria-label="Move later"
                        style={{ ...smallBtn, opacity: idx >= cfg.photos.length - 1 ? 0.35 : 1 }}>▶</button>
                    </>
                  )}
                  <button type="button" onClick={() => save({ defaultId: p.id })} disabled={isDefault}
                    style={{ flex: 1, padding: "6px 4px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: isDefault ? "default" : "pointer",
                      border: "none", background: isDefault ? "rgba(242,179,61,0.18)" : "rgba(255,255,255,0.1)", color: isDefault ? "#F2B33D" : "#fff" }}>
                    {isDefault ? "★ Default" : "Default"}
                  </button>
                  <button type="button" onClick={() => removePhoto(p)} aria-label="Remove photo"
                    style={{ ...smallBtn,
                      background: confirmId === p.id ? "#EF4444" : "rgba(239,68,68,0.12)", color: confirmId === p.id ? "#fff" : "#F87171" }}>
                    {confirmId === p.id ? "Sure?" : "✕"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <label style={{
        alignSelf: "flex-start", padding: "9px 16px", borderRadius: 8, cursor: "pointer",
        background: "#4A7FFF", color: "#fff", fontWeight: 700, fontSize: 13.5,
        opacity: uploading ? 0.6 : 1, pointerEvents: uploading ? "none" : "auto",
      }}>
        {uploading || "Add photos"}
        <input type="file" accept="image/*" multiple onChange={onFiles} disabled={!!uploading} style={{ display: "none" }} />
      </label>

      {cfg.photos.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            {modeBtn("default", "Default photo")}
            {modeBtn("rotate", "Rotate photos")}
          </div>
          {cfg.mode === "rotate" && cfg.photos.length < 2 && (
            <div style={muted}>Add a second photo and they will start rotating.</div>
          )}
          {cfg.mode === "rotate" && (
            <div>
              <div style={{ ...muted, color: "rgba(255,255,255,0.6)", marginBottom: 6 }}>Change photo every</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="number" min="0" value={minInput} aria-label="Rotate minutes"
                  onChange={(e) => setMinInput(e.target.value)} onBlur={commitRotate} style={numInput} />
                <span style={muted}>min</span>
                <input type="number" min="0" max="59" value={secInput} aria-label="Rotate seconds"
                  onChange={(e) => setSecInput(e.target.value)} onBlur={commitRotate} style={numInput} />
                <span style={muted}>sec</span>
              </div>
            </div>
          )}
        </>
      )}
      <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)" }}>
        Landscape photos work best — the TV fills its 16:9 screen with each one. Add as many as you like.
        Tap the days under a photo to show it only on those days; on a day with none picked, the every-day photos show.
      </div>
      {error && <div style={{ color: "#F87171", fontSize: 12.5 }}>{error}</div>}
    </div>
  );
}
