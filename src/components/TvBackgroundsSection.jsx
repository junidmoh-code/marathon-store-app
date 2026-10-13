// ─── TV BACKGROUND — section of the TV Ad card ───────────────────────────────
// Upload several photos for the queue board's wall, then either pick ONE as
// the default or let them rotate on a timer. Writes /settings/tvBackgrounds
// (shape in src/utils/tvBackgrounds.js); the board picks the change up live.
//
// Photos are cropped to 1920×1080 and re-encoded as JPEG in the browser before
// upload, so a 12 MB phone photo lands on the TVs as ~400 KB. They live under
// products/tv-backgrounds/ in Storage — the prefix staff accounts can already
// write and the TVs can already read, so no rules change is needed.
import { useEffect, useState } from "react";
import { push, ref, remove, update } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { database, storage, auth } from "../firebase";
import { serverNowMs } from "../utils/serverTime";
import {
  useTvBackgrounds, pickTvBackground,
  TV_BACKGROUNDS_PATH, TV_BACKGROUNDS_STORAGE_DIR, MAX_TV_BACKGROUNDS, MIN_ROTATE_SECONDS,
} from "../utils/tvBackgrounds";

const TV_W = 1920;
const TV_H = 1080;

async function toTvJpeg(file) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = TV_W; canvas.height = TV_H;
  const s = Math.max(TV_W / bmp.width, TV_H / bmp.height);
  const w = bmp.width * s, h = bmp.height * s;
  canvas.getContext("2d").drawImage(bmp, (TV_W - w) / 2, (TV_H - h) / 2, w, h);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read that photo."))), "image/jpeg", 0.85));
}

function who() {
  return auth.currentUser?.email || auth.currentUser?.uid || "unknown";
}

const card = { background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 16 };
const muted = { fontSize: 12.5, color: "rgba(255,255,255,0.5)" };
const numInput = { width: 70, boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff" };

export default function TvBackgroundsSection() {
  const cfg = useTvBackgrounds();
  const [uploading, setUploading] = useState("");
  const [confirmId, setConfirmId] = useState("");
  const [error, setError] = useState("");
  const [minInput, setMinInput] = useState("");
  const [secInput, setSecInput] = useState("");
  // "ON TV NOW" uses the same server clock and 5 s tick as the TV itself.
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  const rotating = cfg?.mode === "rotate" && (cfg?.photos.length || 0) > 1;
  useEffect(() => {
    if (!rotating) return undefined;
    const t = setInterval(() => setNowMs(serverNowMs()), 5000);
    return () => clearInterval(t);
  }, [rotating]);

  useEffect(() => {
    if (!cfg) return;
    setMinInput(String(Math.floor(cfg.rotateSeconds / 60)));
    setSecInput(String(cfg.rotateSeconds % 60));
  }, [cfg?.rotateSeconds]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cfg) return <div style={card}><div style={muted}>Loading backgrounds…</div></div>;

  const stamp = () => ({ updatedAt: Date.now(), updatedBy: who() });
  const save = (patch) => update(ref(database, TV_BACKGROUNDS_PATH), { ...patch, ...stamp() })
    .catch((err) => setError(err?.message || "Save failed."));
  const onScreen = pickTvBackground(cfg, nowMs);
  const room = MAX_TV_BACKGROUNDS - cfg.photos.length;

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    if (!files.length) return;
    setError("");
    if (files.length > room) setError(`Only ${room} more photo${room === 1 ? "" : "s"} fit — the first ${room} will be added.`);
    const batch = files.slice(0, Math.max(0, room));
    let firstId = "";
    try {
      for (let i = 0; i < batch.length; i++) {
        setUploading(`Uploading ${i + 1} of ${batch.length}…`);
        const id = push(ref(database, `${TV_BACKGROUNDS_PATH}/photos`)).key;
        const path = `${TV_BACKGROUNDS_STORAGE_DIR}/${id}.jpg`;
        const sRef = storageRef(storage, path);
        await uploadBytes(sRef, await toTvJpeg(batch[i]), { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" });
        const url = await getDownloadURL(sRef);
        await update(ref(database, `${TV_BACKGROUNDS_PATH}/photos/${id}`), {
          url, path, name: batch[i].name.slice(0, 80), addedAt: Date.now(), addedBy: who(),
        });
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
      // File first: if that fails (network, permission) the photo stays listed
      // so the remove can be retried, rather than leaving an orphan in Storage.
      if (p.path) {
        try { await deleteObject(storageRef(storage, p.path)); }
        catch (err) { if (err?.code !== "storage/object-not-found") throw err; }
      }
      await remove(ref(database, `${TV_BACKGROUNDS_PATH}/photos/${p.id}`));
      if (cfg.defaultId === p.id) await save({ defaultId: "" });
    } catch (err) {
      setError(err?.message || "Remove failed.");
    }
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

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontWeight: 700 }}>TV background</div>
        <div style={muted}>
          {cfg.photos.length === 0
            ? "No photos yet — the TV shows the built-in sneaker room."
            : cfg.mode === "rotate" && cfg.photos.length > 1
              ? `Rotating ${cfg.photos.length} photos.`
              : "One photo, always on."}
        </div>
      </div>

      {cfg.photos.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 10 }}>
          {cfg.photos.map((p) => {
            const isDefault = p.id === (cfg.photos.find((x) => x.id === cfg.defaultId) || cfg.photos[0]).id;
            const live = onScreen?.id === p.id;
            return (
              <div key={p.id} style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, overflow: "hidden",
                outline: isDefault ? "2px solid #F2B33D" : "1px solid rgba(255,255,255,0.1)" }}>
                <div style={{ position: "relative" }}>
                  <img src={p.url} alt={p.name || "TV background"} style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", display: "block" }} />
                  {live && <span style={{ position: "absolute", left: 6, top: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5,
                    background: "#22C55E", color: "#05210f", borderRadius: 4, padding: "2px 6px" }}>ON TV NOW</span>}
                </div>
                <div style={{ display: "flex", gap: 6, padding: 6 }}>
                  <button type="button" onClick={() => save({ defaultId: p.id })} disabled={isDefault}
                    style={{ flex: 1, padding: "6px 4px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: isDefault ? "default" : "pointer",
                      border: "none", background: isDefault ? "rgba(242,179,61,0.18)" : "rgba(255,255,255,0.1)", color: isDefault ? "#F2B33D" : "#fff" }}>
                    {isDefault ? "★ Default" : "Make default"}
                  </button>
                  <button type="button" onClick={() => removePhoto(p)} aria-label="Remove photo"
                    style={{ padding: "6px 8px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "none",
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
        opacity: uploading || room <= 0 ? 0.6 : 1, pointerEvents: uploading || room <= 0 ? "none" : "auto",
      }}>
        {uploading || (room <= 0 ? `Full (${MAX_TV_BACKGROUNDS} photos)` : "Add photos")}
        <input type="file" accept="image/*" multiple onChange={onFiles} disabled={!!uploading || room <= 0} style={{ display: "none" }} />
      </label>

      {cfg.photos.length > 1 && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            {modeBtn("default", "Default photo")}
            {modeBtn("rotate", "Rotate photos")}
          </div>
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
        Landscape photos work best — each is cropped to the TV's 16:9. Up to {MAX_TV_BACKGROUNDS} photos.
      </div>
      {error && <div style={{ color: "#F87171", fontSize: 12.5 }}>{error}</div>}
    </div>
  );
}
