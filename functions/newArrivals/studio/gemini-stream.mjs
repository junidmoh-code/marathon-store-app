// ── GEMINI, STREAMED ────────────────────────────────────────────────────────
// The image call of the locked baseline — the same model, the same request
// body (contents + generationConfig) the Mac mini sent to :generateContent —
// sent to :streamGenerateContent instead, so the card can show Gemini's
// thought summary and its interim drafts while it works. Only the transport
// differs: the body is byte-for-byte what generateImage() built.
//
// ONE attempt per tap: an image call is never retried — a 500 or a timeout can
// come after a billed image. The one exception is a 400 naming the thinking
// field (no image made, nothing billed): the same request goes once more
// without it.
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const IMAGE_TIMEOUT_MS = 300_000;
export const THINKING_CONFIG = Object.freeze({ includeThoughts: true });

export const imagePart = (buffer, mime = "image/jpeg") => ({ inline_data: { mime_type: mime, data: Buffer.from(buffer).toString("base64") } });
export const textPart = (text) => ({ text });

/** Is this a 400 naming the thinking field (no image made, nothing billed)? Pure. */
export function thinkingRejected(e) {
  return e?.status === 400 && /thinking|includeThoughts/i.test(String(e.message || ""));
}

/** The request body. Pure — pinned by the baseline test. */
export function requestBody(parts, imageConfig, { includeThoughts = true } = {}) {
  const base = { responseModalities: ["IMAGE", "TEXT"], imageConfig };
  return { contents: [{ parts }], generationConfig: includeThoughts ? { ...base, thinkingConfig: { ...THINKING_CONFIG } } : base };
}

const isImg = (p) => !!(p && (p.inlineData || p.inline_data));
const inline = (p) => p.inlineData || p.inline_data;

/**
 * Fold one response chunk (a streamed event, or a whole non-streamed answer)
 * into the running state. Thought parts are never the output: the image is the
 * LAST non-thought inline image. Returns the events this chunk adds. Pure.
 */
export function foldChunk(state, json) {
  const events = [];
  // An error sent inside the stream (the model failed part-way).
  if (json?.error) state.error = { status: Number(json.error.code) || 500, message: String(json.error.message || "no detail") };
  if (json?.usageMetadata) state.usage = json.usageMetadata;
  if (json?.promptFeedback?.blockReason) state.blockReason = json.promptFeedback.blockReason;
  const cand = json?.candidates?.[0];
  if (cand?.finishReason) state.finishReason = cand.finishReason;
  for (const p of cand?.content?.parts || []) {
    if (p.thought === true && p.text) {
      state.thoughts += p.text;
      events.push({ type: "thought", text: p.text });
    } else if (p.thought === true && isImg(p)) {
      const d = inline(p);
      const draft = { data: d.data, mime: d.mimeType || d.mime_type || "image/png" };
      state.drafts.push(draft);
      events.push({ type: "draft", draft, n: state.drafts.length });
    } else if (isImg(p)) {
      const d = inline(p);
      state.image = { data: d.data, mime: d.mimeType || d.mime_type || "image/png" };
    } else if (p.text) {
      state.text += p.text;
    }
  }
  return events;
}

export const newState = () => ({ thoughts: "", drafts: [], image: null, text: "", usage: null, finishReason: null, blockReason: null, error: null, unread: 0, cutShort: null });

/** Split a growing SSE buffer into complete `data:` payloads + the unfinished tail. Pure. */
export function sseSplit(buffer) {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop();
  const payloads = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (body && body !== "[DONE]") payloads.push(body);
  }
  return { payloads, rest };
}

async function once(model, body, { apiKey, fetchImpl, timeoutMs, onEvent }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const state = newState();
  try {
    const res = await fetchImpl(`${BASE}/${model}:streamGenerateContent?alt=sse`, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const detail = (Array.isArray(json) ? json[0] : json)?.error?.message || "no detail";
      const err = new Error(`Gemini ${model} ${res.status}: ${detail}`.slice(0, 300));
      err.status = res.status;
      throw err;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const take = async (payloads) => {
      for (const body of payloads) {
        let json;
        // A line that cannot be read is counted: with no image at the end it is a broken stream, not a refusal.
        try { json = JSON.parse(body); } catch { state.unread += 1; continue; }
        for (const ev of foldChunk(state, json)) { try { await onEvent?.(ev); } catch { /* the card's view never affects the generation */ } }
      }
    };
    try {
      for await (const chunk of res.body) {
        const piece = decoder.decode(chunk, { stream: true });
        buffer += piece;
        // Only a chunk that ends a line is worth splitting (the image is ONE multi-megabyte line).
        if (!piece.includes("\n")) continue;
        const { payloads, rest } = sseSplit(buffer);
        buffer = rest;
        await take(payloads);
      }
      await take(sseSplit(`${buffer}\n`).payloads);
    } catch (e) {
      // THE IMAGE IS PAID FOR once it has arrived: a connection that breaks (or
      // times out) after it is kept, never thrown away.
      if (!state.image) throw e;
      state.cutShort = String(e?.message || e).slice(0, 120);
    }
    return state;
  } finally { clearTimeout(timer); }
}

/**
 * One image generation, streamed. onEvent({ type: "thought", text } |
 * { type: "draft", draft: { data, mime }, n }) is called as Gemini works.
 * → { buffer, mime, text, thoughts, thoughtImages, drafts, request, usage, requestMs, thoughtsUnsupported }
 * Throws with `refusal` when the model answered and made no image; with
 * `status` for an API error.
 */
export async function streamImage(model, parts, imageConfig, opts = {}) {
  const { apiKey, fetchImpl = fetch, timeoutMs = IMAGE_TIMEOUT_MS, onEvent = null } = opts;
  if (!apiKey) throw new Error("no Gemini key");
  const withThoughts = opts.includeThoughts !== false;
  let body = requestBody(parts, imageConfig, { includeThoughts: withThoughts });
  let thoughtsUnsupported = null;
  const t0 = Date.now();
  let state;
  try {
    state = await once(model, body, { apiKey, fetchImpl, timeoutMs, onEvent });
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error(`Gemini ${model} gave no photo within ${Math.round(timeoutMs / 1000)}s`);
      err.status = 504;
      throw err;
    }
    if (!withThoughts || !thinkingRejected(e)) throw e;
    thoughtsUnsupported = String(e.message).slice(0, 300);
    body = requestBody(parts, imageConfig, { includeThoughts: false });
    state = await once(model, body, { apiKey, fetchImpl, timeoutMs, onEvent });
  }
  const requestMs = Date.now() - t0;
  if (!state.image) {
    // The stream itself failed (an error inside it, an unreadable line, or it
    // simply stopped): infrastructure — never reported as Gemini declining.
    if (state.error || state.unread || (!state.finishReason && !state.blockReason)) {
      const err = new Error(state.error ? `Gemini ${model} ${state.error.status}: ${state.error.message}`.slice(0, 300) : `the connection to Gemini ${model} broke before the photo arrived`);
      err.status = state.error ? state.error.status : 502;
      err.usage = state.usage;
      throw err;
    }
    const why = state.finishReason || state.blockReason;
    const err = new Error(`generation returned no image (${why})${state.text ? `: ${state.text.trim().slice(0, 200)}` : ""}`);
    err.refusal = true;
    err.usage = state.usage;
    throw err;
  }
  // A draft identical to the final image IS the final image, not a draft.
  const drafts = state.drafts.filter((d) => d.data && d.data !== state.image.data)
    .map((d) => ({ buffer: Buffer.from(d.data, "base64"), mime: d.mime }));
  return {
    buffer: Buffer.from(state.image.data, "base64"), mime: state.image.mime, text: state.text.trim(),
    thoughts: state.thoughts.trim() || null, thoughtImages: state.drafts.length, drafts,
    request: body.generationConfig, usage: state.usage, requestMs, thoughtsUnsupported,
    ...(state.cutShort ? { cutShort: state.cutShort } : {}),
  };
}
