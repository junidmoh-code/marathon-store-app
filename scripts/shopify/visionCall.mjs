// ── THE VISION TRANSPORT — one photo in, one model answer out ────────────────
// Lifted verbatim out of vision-name.mjs (2026-09-06) when the attribute
// extractor needed the same call. It is the SAME pipeline, not a second one:
// same model pin, same thinking config, same retry discipline, same cost
// accounting. Every comment below records a failure that was actually paid for.
//
// PURE TRANSPORT. It knows nothing about names, attributes or products — the
// caller supplies the prompt and reads the text back.
import { visionModel, THINKING_CONFIG, costFromUsage } from "../../src/utils/visionNaming.js";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// ── The photo download is the fragile step ───────────────────────────────────
// It fails for reasons that have nothing to do with this program: on the first
// full naming run 2,479 of 2,916 products failed with a bare "fetch failed"
// because the machine's network dropped mid-run. None of them reached the API,
// so nothing was charged — but the run reported 85% failure for a transient
// cause. A bounded retry with backoff turns that into a pause instead of a loss.
export async function fetchWithRetry(url, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
  }
  throw new Error(`could not fetch the photo after ${attempts} attempts (${String(last?.message || last)})`);
}

/**
 * One photo, one prompt, one answer.
 *
 * @param photoUrl   the product photo to read
 * @param prompt     the instruction text
 * @param opts.extra additional text parts, appended in order (a retry note, a
 *                   shape hint) — each is its own part, as the naming runner
 *                   has always sent them
 * @param opts.apiKey  GEMINI_API_KEY
 * @param opts.model   defaults to the pinned model
 * @param opts.temperature  defaults to 0.4, the naming runner's value
 * @param opts.onCost  called with the USD this call actually cost, from the
 *                     model's OWN reported usage — so drift between the quoted
 *                     constant and reality is visible rather than assumed
 * @returns the response text
 */
export async function callVision(photoUrl, prompt, opts = {}) {
  const { apiKey, extra = [], temperature = 0.4, onCost } = opts;
  const model = opts.model || visionModel(process.env);
  if (!apiKey) throw new Error("no API key supplied to callVision");

  const img = await fetchWithRetry(photoUrl);
  const mimeType = img.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const data = Buffer.from(await img.arrayBuffer()).toString("base64");
  const parts = [{ inlineData: { mimeType, data } }, { text: prompt }];
  for (const t of extra) if (t) parts.push({ text: t });

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
      // Thinking is billed at the OUTPUT rate and measured 46% more expensive
      // for an answer of the same quality. See THINKING_CONFIG.
      thinkingConfig: { ...THINKING_CONFIG },
    },
  });

  let res, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${API}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: AbortSignal.timeout(90000),
      });
      break;
    } catch (e) {
      lastErr = e;
      // A TIMEOUT IS NOT A TRANSPORT FAILURE. The retry above exists for errors
      // that prove the request never reached the server; a timeout proves
      // nothing of the kind — the server may have accepted it and generated an
      // answer, which has already been CHARGED. Retrying then pays for the same
      // photo twice. One photo lost is cheaper than an unbounded double-charge,
      // and the next run picks it up because nothing was written for it.
      if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new Error(`the request timed out after 90s — not retried, because a timed-out ` +
                        `generation may already have been charged`);
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  if (!res) throw new Error(`could not reach Gemini after 3 attempts (${String(lastErr?.message || lastErr)})`);
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  if (!text) {
    const why = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || "no text in response";
    throw new Error(`Gemini returned nothing usable (${why})`);
  }
  if (onCost) onCost(costFromUsage(json.usageMetadata), json.usageMetadata);
  return text;
}
