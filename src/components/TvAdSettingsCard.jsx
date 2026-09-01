// ─── TV AD — admin settings card ─────────────────────────────────────────────
// Writes /settings/tvAd (see src/utils/tvAdSettings.js for the shared shape).
// The TV screen overlay (src/components/TvAdOverlay.jsx) reads this node live
// via onValue — every change here takes effect on the TV within one RTDB
// round-trip, no redeploy. Upload accepts image OR video, goes to Firebase
// Storage under tv_ads/current.<ext> (stable path, same pattern as the
// product box-photo upload: uploadBytes → getDownloadURL → write the URL).
import { useEffect, useState } from "react";
import { ref, update } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { database, storage, auth } from "../firebase";
import { useTvAdSettings } from "../utils/tvAdSettings";

const FONT = "-apple-system, BlinkMacSystemFont, sans-serif";

async function uploadTvAd(file) {
  const isVideo = file.type.startsWith("video/");
  const mediaType = isVideo ? "video" : "image";
  const ext = isVideo ? "mp4" : "jpg";
  const sRef = storageRef(storage, `tv_ads/current.${ext}`);
  await uploadBytes(sRef, file, { contentType: file.type, cacheControl: "public, max-age=604800" });
  const mediaUrl = await getDownloadURL(sRef);
  return { mediaUrl, mediaType };
}

function fieldStamp() {
  return { updatedAt: Date.now(), updatedBy: auth.currentUser?.email || auth.currentUser?.uid || "unknown" };
}

export default function TvAdSettingsCard({ onExit }) {
  const settings = useTvAdSettings();
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
  const [intervalMinInput, setIntervalMinInput] = useState("");
  const [intervalSecInput, setIntervalSecInput] = useState("");
  const [durationMinInput, setDurationMinInput] = useState("");
  const [durationSecInput, setDurationSecInput] = useState("");

  useEffect(() => {
    if (!settings) return;
    setIntervalMinInput(String(Math.floor(settings.intervalSeconds / 60)));
    setIntervalSecInput(String(settings.intervalSeconds % 60));
    setDurationMinInput(String(Math.floor(settings.durationSeconds / 60)));
    setDurationSecInput(String(settings.durationSeconds % 60));
  }, [settings?.intervalSeconds, settings?.durationSeconds]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setConfirmRemove(false);
    setUploading(true);
    try {
      const { mediaUrl, mediaType } = await uploadTvAd(file);
      await update(ref(database, "settings/tvAd"), { mediaUrl, mediaType, ...fieldStamp() });
    } catch (err) {
      setError(err?.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const removeAd = async () => {
    if (!settings?.mediaUrl) return;
    if (!confirmRemove) { setConfirmRemove(true); return; }
    setConfirmRemove(false);
    setError("");
    setRemoving(true);
    try {
      const ext = settings.mediaType === "video" ? "mp4" : "jpg";
      try { await deleteObject(storageRef(storage, `tv_ads/current.${ext}`)); }
      catch { /* already gone or never existed at this ext — fine, RTDB is the source of truth for what's live */ }
      await update(ref(database, "settings/tvAd"), { mediaUrl: "", mediaType: "image", enabled: false, ...fieldStamp() });
    } catch (err) {
      setError(err?.message || "Remove failed.");
    } finally {
      setRemoving(false);
    }
  };

  const toggleEnabled = async () => {
    if (!settings) return;
    await update(ref(database, "settings/tvAd"), { enabled: !settings.enabled, ...fieldStamp() });
  };

  const commitInterval = async () => {
    const min = Math.max(0, Math.round(Number(intervalMinInput) || 0));
    const sec = Math.max(0, Math.min(59, Math.round(Number(intervalSecInput) || 0)));
    const totalSeconds = Math.max(1, min * 60 + sec);
    setIntervalMinInput(String(Math.floor(totalSeconds / 60)));
    setIntervalSecInput(String(totalSeconds % 60));
    await update(ref(database, "settings/tvAd"), { intervalSeconds: totalSeconds, ...fieldStamp() });
  };

  const commitDuration = async () => {
    const min = Math.max(0, Math.round(Number(durationMinInput) || 0));
    const sec = Math.max(0, Math.min(59, Math.round(Number(durationSecInput) || 0)));
    const totalSeconds = Math.max(1, min * 60 + sec);
    setDurationMinInput(String(Math.floor(totalSeconds / 60)));
    setDurationSecInput(String(totalSeconds % 60));
    await update(ref(database, "settings/tvAd"), { durationSeconds: totalSeconds, ...fieldStamp() });
  };

  const loaded = !!settings;

  return (
    <div style={{ minHeight: "100vh", background: "#0B0F1A", color: "#fff", fontFamily: FONT, padding: "24px 20px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>TV Ad</h1>
        {onExit && (
          <button type="button" onClick={onExit} style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>
            Close
          </button>
        )}
      </div>

      {!loaded ? (
        <div style={{ color: "rgba(255,255,255,0.5)" }}>Loading…</div>
      ) : (
        <div style={{ maxWidth: 480, display: "flex", flexDirection: "column", gap: 20 }}>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: "14px 16px" }}>
            <div>
              <div style={{ fontWeight: 700 }}>Show on TV</div>
              <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)" }}>
                {settings.enabled ? "The overlay will pop up on the queue screen." : "Off — the TV never shows the overlay."}
              </div>
            </div>
            <button
              type="button"
              onClick={toggleEnabled}
              aria-label="Toggle TV ad"
              style={{
                width: 52, height: 30, borderRadius: 15, border: "none", cursor: "pointer",
                background: settings.enabled ? "#22C55E" : "rgba(255,255,255,0.2)",
                position: "relative", flexShrink: 0,
              }}
            >
              <span style={{
                position: "absolute", top: 3, left: settings.enabled ? 25 : 3,
                width: 24, height: 24, borderRadius: 12, background: "#fff",
                transition: "left .15s",
              }}/>
            </button>
          </div>

          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Ad creative</div>
            {settings.mediaUrl ? (
              settings.mediaType === "video" ? (
                <video src={settings.mediaUrl} muted loop autoPlay playsInline style={{ width: "100%", borderRadius: 8, maxHeight: 220, objectFit: "contain", background: "#000" }} />
              ) : (
                <img src={settings.mediaUrl} alt="Current TV ad" style={{ width: "100%", borderRadius: 8, maxHeight: 220, objectFit: "contain", background: "#000" }} />
              )
            ) : (
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>No ad uploaded yet.</div>
            )}
            <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)", marginTop: 8 }}>
              {settings.updatedAt ? `Last changed ${new Date(settings.updatedAt).toLocaleString()}${settings.updatedBy ? ` by ${settings.updatedBy}` : ""}` : "Never changed."}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <label style={{
                display: "inline-block", padding: "9px 16px", borderRadius: 8, cursor: "pointer",
                background: "#4A7FFF", color: "#fff", fontWeight: 700, fontSize: 13.5,
                opacity: uploading ? 0.6 : 1, pointerEvents: uploading ? "none" : "auto",
              }}>
                {uploading ? "Uploading…" : "Upload image or video"}
                <input type="file" accept="image/*,video/*" onChange={onFile} disabled={uploading} style={{ display: "none" }} />
              </label>
              {settings.mediaUrl && (
                <button
                  type="button"
                  onClick={removeAd}
                  disabled={removing}
                  style={{
                    padding: "9px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13.5,
                    background: confirmRemove ? "#EF4444" : "rgba(239,68,68,0.12)",
                    color: confirmRemove ? "#fff" : "#F87171",
                    border: confirmRemove ? "none" : "1px solid rgba(239,68,68,0.3)",
                    opacity: removing ? 0.6 : 1,
                  }}
                >
                  {removing ? "Removing…" : confirmRemove ? "Tap again to confirm" : "Remove ad"}
                </button>
              )}
            </div>
            {error && <div style={{ color: "#F87171", fontSize: 12.5, marginTop: 8 }}>{error}</div>}
          </div>

          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)", marginBottom: 6 }}>Every</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="number" min="0" value={intervalMinInput} aria-label="Interval minutes"
                  onChange={(e) => setIntervalMinInput(e.target.value)}
                  onBlur={commitInterval}
                  style={{ width: 70, boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff" }}
                />
                <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)" }}>min</span>
                <input
                  type="number" min="0" max="59" value={intervalSecInput} aria-label="Interval seconds"
                  onChange={(e) => setIntervalSecInput(e.target.value)}
                  onBlur={commitInterval}
                  style={{ width: 70, boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff" }}
                />
                <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)" }}>sec</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)", marginBottom: 6 }}>For</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="number" min="0" value={durationMinInput} aria-label="Duration minutes"
                  onChange={(e) => setDurationMinInput(e.target.value)}
                  onBlur={commitDuration}
                  style={{ width: 70, boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff" }}
                />
                <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)" }}>min</span>
                <input
                  type="number" min="0" max="59" value={durationSecInput} aria-label="Duration seconds"
                  onChange={(e) => setDurationSecInput(e.target.value)}
                  onBlur={commitDuration}
                  style={{ width: 70, boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff" }}
                />
                <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)" }}>sec</span>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
