// ─── THE DRIFT CHECK — TRANSPORT (Junid, 20 Nov 2026) ───────────────────────
// One cheap vision call: the original staff photo beside the generated photo,
// "is this the same product?". The decision text lives in style-kit-catalogue.mjs
// (DRIFT_PROMPT / parseDriftAnswer, pure and tested); this file only sends it.
//
// FAIL-OPEN BY DESIGN: if the check itself cannot run (network, quota, an
// unreadable answer) the photo is NOT treated as drifted — the check never
// costs Junid a second paid generation on a guess. `checked:false` says so.
import { DRIFT_MODEL, DRIFT_PROMPT, parseDriftAnswer, GARMENT_CHECK_PROMPT, GARMENT_CHECK_EDGE, parseGarmentAnswer } from "./style-kit-catalogue.mjs";

// The drift check reads 768 px thumbnails; the garment gate needs to SEE a crease, so it is sent larger ones
// (22 Nov 2026: HB301#'s fold line was invisible at 768 px and the check passed it).
export const GARMENT_THINKING = 1024;
// The middle of the photo, enlarged: where the garment hangs in every house look. Calibrated 22 Nov 2026 on HB301# —
// with this close-up the gate scores the creased photos 4 and the steamed one 2–3; without it, all of them 3.
export const CLOSE_UP = Object.freeze({ width: 0.7, height: 0.62, top: 0.2 });
const closeUp = async (sharp, buf, edge) => {
  const flat = await sharp(buf).rotate().toBuffer();
  const m = await sharp(flat).metadata();
  const w = Math.round(m.width * CLOSE_UP.width), h = Math.round(m.height * CLOSE_UP.height);
  return sharp(flat).extract({ left: Math.round((m.width - w) / 2), top: Math.round(m.height * CLOSE_UP.top), width: w, height: h })
    .resize(edge, edge, { fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
};
const small = async (sharp, buf, edge = 768) => sharp(buf).rotate().resize(edge, edge, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: edge > 768 ? 88 : 85 }).toBuffer();

/**
 * → { checked, drift, issues, usage, faults? }
 * deps: { apiKey, sharp, fetchImpl?, model?, timeoutMs?, garment? }
 * garment: true (Junid, 21–22 Nov 2026) — a clothing item: the SAME call is the garment quality gate — a crease
 *   score and a flatness score (0–10), logos/colour/product against the original, drawn lines, tilt. `drift` then
 *   means "failed the gate"; `faults` names why and `crease` / `flat` carry the scores.
 */
export async function checkDrift({ original, generated }, { apiKey, sharp, fetchImpl = fetch, model = DRIFT_MODEL, timeoutMs = 45_000, garment = false } = {}) {
  if (!apiKey || !original || !generated) return { checked: false, drift: false, issues: "no key or photo for the check", usage: null };
  try {
    const edge = garment ? GARMENT_CHECK_EDGE : 768;
    const [a, b, c] = await Promise.all([small(sharp, original, edge), small(sharp, generated, edge), garment ? closeUp(sharp, generated, edge).catch(() => null) : null]);
    const body = {
      contents: [{ parts: [
        { text: garment ? GARMENT_CHECK_PROMPT : DRIFT_PROMPT },
        { text: "IMAGE 1 — the real product:" }, { inline_data: { mime_type: "image/jpeg", data: a.toString("base64") } },
        { text: "IMAGE 2 — the new studio photo:" }, { inline_data: { mime_type: "image/jpeg", data: b.toString("base64") } },
        ...(c ? [{ text: "IMAGE 3 — a close-up of the middle of IMAGE 2:" }, { inline_data: { mime_type: "image/jpeg", data: c.toString("base64") } }] : []),
      ] }],
      // The gate is given a little room to look before it scores; the plain drift check answers at once.
      generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: garment ? GARMENT_THINKING : 0 }, ...(garment ? { temperature: 0 } : {}) },
    };
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { checked: false, drift: false, issues: `drift check HTTP ${res.status}`, usage: null };
    const j = await res.json();
    const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    const v = garment ? parseGarmentAnswer(text) : parseDriftAnswer(text);
    if (!v) return { checked: false, drift: false, issues: "drift check answer unreadable", usage: j?.usageMetadata || null };
    return { checked: true, drift: v.drift, issues: v.issues, usage: j?.usageMetadata || null, ...(garment ? { faults: v.faults, crease: v.crease ?? null, carried: v.carried ?? null, flat: v.flat ?? null } : {}) };
  } catch (e) {
    return { checked: false, drift: false, issues: `drift check failed (${String(e?.message || e).slice(0, 80)})`, usage: null };
  }
}
