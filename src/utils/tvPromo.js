// ─── TV PROMO BANNER — shared read contract ──────────────────────────────────
// /settings/tvPromo drives the banner across the floor of the queue board,
// written by the "TV promo banner" section of the TV Ad card:
//   { enabled, style: "tape" | "photo", photoUrl, path, name, updatedAt, updatedBy }
//  tape  → the built-in BLACK FRIDAY / COMING SOON tape (still takes itself
//          down on Black Friday — "coming soon" would be a lie after that)
//  photo → an uploaded banner image in the same place, until switched off
// An ABSENT node means "on, tape" — that is what the board did before the
// switch existed. A read error fails to the same default.
import { useEffect, useState } from "react";
import { onValue, ref } from "firebase/database";
import { database } from "../firebase";
import { showBlackFridayTape } from "../components/tv/blackFridayTape";

export const TV_PROMO_PATH = "settings/tvPromo";
export const TV_PROMO_STORAGE_DIR = "products/tv-promo";

export function normalizeTvPromo(v) {
  const raw = v && typeof v === "object" ? v : {};
  return {
    enabled: raw.enabled !== false,
    style: raw.style === "photo" ? "photo" : "tape",
    photoUrl: typeof raw.photoUrl === "string" ? raw.photoUrl : "",
    path: typeof raw.path === "string" ? raw.path : "",
    name: typeof raw.name === "string" ? raw.name : "",
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null,
  };
}

// What the floor shows now: "tape", "photo", or null (nothing — footer back).
// "photo" with no photo uploaded yet falls back to the tape rule.
export function tvPromoMode(cfg, nowMs) {
  const c = cfg || normalizeTvPromo(null);
  if (!c.enabled) return null;
  if (c.style === "photo" && c.photoUrl) return "photo";
  return showBlackFridayTape(nowMs) ? "tape" : null;
}

export function useTvPromo() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    const unsub = onValue(
      ref(database, TV_PROMO_PATH),
      (snap) => setCfg(normalizeTvPromo(snap.val())),
      () => setCfg(normalizeTvPromo(null)),
    );
    return () => unsub();
  }, []);
  return cfg;
}
