// ─── THE DRIFT CHECK — TRANSPORT (Junid, 20 Nov 2026) ───────────────────────
// One cheap vision call: the original staff photo beside the generated photo,
// "is this the same product?". The decision text lives in style-kit-catalogue.mjs
// (DRIFT_PROMPT / parseDriftAnswer, pure and tested); this file only sends it.
//
// FAIL-OPEN BY DESIGN: if the check itself cannot run (network, quota, an
// unreadable answer) the photo is NOT treated as drifted — the check never
// costs Junid a second paid generation on a guess. `checked:false` says so.
import { DRIFT_MODEL, DRIFT_PROMPT, parseDriftAnswer } from "./style-kit-catalogue.mjs";

const small = async (sharp, buf) => sharp(buf).rotate().resize(768, 768, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();

/**
 * → { checked, drift, issues, usage }
 * deps: { apiKey, sharp, fetchImpl?, model?, timeoutMs? }
 */
export async function checkDrift({ original, generated }, { apiKey, sharp, fetchImpl = fetch, model = DRIFT_MODEL, timeoutMs = 45_000 } = {}) {
  if (!apiKey || !original || !generated) return { checked: false, drift: false, issues: "no key or photo for the check", usage: null };
  try {
    const [a, b] = await Promise.all([small(sharp, original), small(sharp, generated)]);
    const body = {
      contents: [{ parts: [
        { text: DRIFT_PROMPT },
        { text: "IMAGE 1 — the real product:" }, { inline_data: { mime_type: "image/jpeg", data: a.toString("base64") } },
        { text: "IMAGE 2 — the new studio photo:" }, { inline_data: { mime_type: "image/jpeg", data: b.toString("base64") } },
      ] }],
      generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
    };
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { checked: false, drift: false, issues: `drift check HTTP ${res.status}`, usage: null };
    const j = await res.json();
    const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    const v = parseDriftAnswer(text);
    if (!v) return { checked: false, drift: false, issues: "drift check answer unreadable", usage: j?.usageMetadata || null };
    return { checked: true, drift: v.drift, issues: v.issues, usage: j?.usageMetadata || null };
  } catch (e) {
    return { checked: false, drift: false, issues: `drift check failed (${String(e?.message || e).slice(0, 80)})`, usage: null };
  }
}
