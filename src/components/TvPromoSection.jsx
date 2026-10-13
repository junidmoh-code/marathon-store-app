// ─── TV PROMO BANNER — section of the TV Ad card ─────────────────────────────
// One switch and one choice for the banner across the floor of the queue
// board: the built-in Black Friday tape, or a photo uploaded here in its place.
// Writes /settings/tvPromo (shape in src/utils/tvPromo.js).
//
// The upload is scaled to at most 1920 px wide and saved as WebP, which keeps
// a PNG's transparency (a cut-out banner stays cut out) at a fraction of the
// size. Each upload gets a new file name so a TV never shows a cached old
// banner; the replaced file is deleted after the switch-over. Storage prefix
// products/ for the same reason as the backgrounds: staff write, TVs read.
import { useState } from "react";
import { ref, update } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { database, storage, auth } from "../firebase";
import { useTvPromo, tvPromoMode, TV_PROMO_PATH, TV_PROMO_STORAGE_DIR } from "../utils/tvPromo";
import { serverNowMs } from "../utils/serverTime";

const MAX_W = 1920;

async function toBannerWebp(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, MAX_W / bmp.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read that photo."))), "image/webp", 0.9));
}

const who = () => auth.currentUser?.email || auth.currentUser?.uid || "unknown";
const card = { background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 16 };
const muted = { fontSize: 12.5, color: "rgba(255,255,255,0.5)" };

export default function TvPromoSection() {
  const cfg = useTvPromo();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  if (!cfg) return <div style={card}><div style={muted}>Loading promo banner…</div></div>;

  const save = (patch) => update(ref(database, TV_PROMO_PATH), { ...patch, updatedAt: Date.now(), updatedBy: who() })
    .catch((err) => setError(err?.message || "Save failed."));
  const showing = tvPromoMode(cfg, serverNowMs());

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setUploading(true);
    try {
      const path = `${TV_PROMO_STORAGE_DIR}/banner-${Date.now()}.webp`;
      const sRef = storageRef(storage, path);
      await uploadBytes(sRef, await toBannerWebp(file), { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" });
      const photoUrl = await getDownloadURL(sRef);
      const oldPath = cfg.path;
      await save({ photoUrl, path, name: file.name.slice(0, 80), style: "photo", enabled: true });
      if (oldPath && oldPath !== path) { try { await deleteObject(storageRef(storage, oldPath)); } catch { /* best effort: the record already points at the new file */ } }
    } catch (err) {
      setError(err?.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const styleBtn = (style, label) => (
    <button type="button" onClick={() => save({ style })} aria-pressed={cfg.style === style}
      style={{
        flex: 1, padding: "9px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13.5,
        border: "1px solid rgba(255,255,255,0.15)",
        background: cfg.style === style ? "#4A7FFF" : "rgba(0,0,0,0.3)", color: "#fff",
      }}>{label}</button>
  );

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700 }}>TV promo banner</div>
          <div style={muted}>
            {!cfg.enabled ? "Off — the TV shows its normal footer."
              : showing === "photo" ? "Showing your photo across the bottom of the TV."
              : showing === "tape" ? "Showing the Black Friday tape (it takes itself down on 27 Nov)."
              : "On, but nothing to show — the tape ends on Black Friday. Upload a photo to use instead."}
          </div>
        </div>
        <button type="button" onClick={() => save({ enabled: !cfg.enabled })} aria-label="Toggle TV promo banner"
          style={{ width: 52, height: 30, borderRadius: 15, border: "none", cursor: "pointer", position: "relative", flexShrink: 0,
            background: cfg.enabled ? "#22C55E" : "rgba(255,255,255,0.2)" }}>
          <span style={{ position: "absolute", top: 3, left: cfg.enabled ? 25 : 3, width: 24, height: 24, borderRadius: 12,
            background: "#fff", transition: "left .15s" }} />
        </button>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {styleBtn("tape", "Black Friday tape")}
        {styleBtn("photo", "My photo")}
      </div>

      {cfg.style === "photo" && (
        <>
          {cfg.photoUrl ? (
            <img src={cfg.photoUrl} alt={cfg.name || "Promo banner"}
              style={{ width: "100%", maxHeight: 160, objectFit: "contain", borderRadius: 8,
                background: "repeating-conic-gradient(#2a2a2a 0% 25%, #1c1c1c 0% 50%) 50% / 16px 16px" }} />
          ) : (
            <div style={muted}>No photo yet — until you add one, the tape shows.</div>
          )}
          <label style={{
            alignSelf: "flex-start", padding: "9px 16px", borderRadius: 8, cursor: "pointer",
            background: "#4A7FFF", color: "#fff", fontWeight: 700, fontSize: 13.5,
            opacity: uploading ? 0.6 : 1, pointerEvents: uploading ? "none" : "auto",
          }}>
            {uploading ? "Uploading…" : cfg.photoUrl ? "Replace photo" : "Add photo"}
            <input type="file" accept="image/*" onChange={onFile} disabled={uploading} style={{ display: "none" }} />
          </label>
          <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)" }}>
            Fills the strip under the fifth row. A wide banner (about 1920 × 300) fits edge to edge;
            a transparent PNG keeps its see-through parts.
          </div>
        </>
      )}
      {error && <div style={{ color: "#F87171", fontSize: 12.5 }}>{error}</div>}
    </div>
  );
}
