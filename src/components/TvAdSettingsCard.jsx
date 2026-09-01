// ─── TV AD — admin settings card ─────────────────────────────────────────────
// Writes /settings/tvAd (see src/utils/tvAdSettings.js for the shared shape).
// The TV screen overlay (src/components/TvAdOverlay.jsx) reads this node live
// via onValue — every change here takes effect on the TV within one RTDB
// round-trip, no redeploy. Upload accepts image OR video, goes to Firebase
// Storage under tv_ads/current.<ext> (stable path, same pattern as the
// product box-photo upload: uploadBytes → getDownloadURL → write the URL).
import { useEffect, useState } from "react";
import { ref, update } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
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
  const [error, setError] = useState("");
  const [intervalInput, setIntervalInput] = useState("");
  const [durationInput, setDurationInput] = useState("");

  useEffect(() => {
    if (!settings) return;
    setIntervalInput(String(settings.intervalMinutes));
    setDurationInput(String(settings.durationMinutes));
  }, [settings?.intervalMinutes, settings?.durationMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
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

  const toggleEnabled = async () => {
    if (!settings) return;
    await update(ref(database, "settings/tvAd"), { enabled: !settings.enabled, ...fieldStamp() });
  };

  const commitInterval = async () => {
    const n = Math.max(1, Math.round(Number(intervalInput) || 0));
    setIntervalInput(String(n));
    await update(ref(database, "settings/tvAd"), { intervalMinutes: n, ...fieldStamp() });
  };

  const commitDuration = async () => {
    const n = Math.max(1, Math.round(Number(durationInput) || 0));
    setDurationInput(String(n));
    await update(ref(database, "settings/tvAd"), { durationMinutes: n, ...fieldStamp() });
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
            <label style={{
              display: "inline-block", marginTop: 12, padding: "9px 16px", borderRadius: 8, cursor: "pointer",
              background: "#4A7FFF", color: "#fff", fontWeight: 700, fontSize: 13.5,
              opacity: uploading ? 0.6 : 1, pointerEvents: uploading ? "none" : "auto",
            }}>
              {uploading ? "Uploading…" : "Upload image or video"}
              <input type="file" accept="image/*,video/*" onChange={onFile} disabled={uploading} style={{ display: "none" }} />
            </label>
            {error && <div style={{ color: "#F87171", fontSize: 12.5, marginTop: 8 }}>{error}</div>}
          </div>

          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 16, display: "flex", gap: 16 }}>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)", marginBottom: 6 }}>Every (minutes)</div>
              <input
                type="number" min="1" value={intervalInput}
                onChange={(e) => setIntervalInput(e.target.value)}
                onBlur={commitInterval}
                style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff" }}
              />
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)", marginBottom: 6 }}>For (minutes)</div>
              <input
                type="number" min="1" value={durationInput}
                onChange={(e) => setDurationInput(e.target.value)}
                onBlur={commitDuration}
                style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.3)", color: "#fff" }}
              />
            </label>
          </div>

        </div>
      )}
    </div>
  );
}
