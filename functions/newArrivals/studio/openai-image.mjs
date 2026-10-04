// ── OPENAI gpt-image-1, behind the SAME interface as Gemini ─────────────────
// streamImage(model, parts, imageConfig, opts) in gemini-stream.mjs is the
// interface every generation goes through. This is its OpenAI twin: the same
// `parts` (the prompt, then each image with the sentence that says what it is)
// and the same `imageConfig` go in; the same result shape comes out. Nothing
// above it — the full method, the split method, the cut-out, the source-photo
// rule, the record — knows which provider made the photo.
//
// gpt-image-1 works FROM the real photos: the image-edit endpoint takes the
// product photo, the backdrop, the reference and the box as input images
// (input_fidelity high, so the product is kept, not re-imagined). It takes ONE
// prompt, so the sentence that introduced each image in the Gemini request
// becomes a numbered line of that prompt, in the same order as the images.
//
// ONE attempt per tap, as with Gemini: never retried — a failure can come
// after a billed image. The one exception is a 400 naming the streaming
// fields (no image made): the same request goes once more without them.
const URL_EDITS = "https://api.openai.com/v1/images/edits";
export const OPENAI_TIMEOUT_MS = 300_000;
export const OPENAI_QUALITY = "high";
export const OPENAI_FIDELITY = "high";
export const PARTIAL_IMAGES = 2;

// The sizes gpt-image-1 makes: the one nearest the aspect asked for.
const SIZES = { portrait: "1024x1536", landscape: "1536x1024", square: "1024x1024" };
/** "3:4" → "1024x1536". Pure. */
export function sizeFor(aspectRatio) {
  const [w, h] = String(aspectRatio || "1:1").split(":").map(Number);
  if (!(w > 0 && h > 0) || w === h) return SIZES.square;
  return w < h ? SIZES.portrait : SIZES.landscape;
}

/**
 * Gemini-style parts → ONE prompt + the images in order. The first text part
 * is the prompt; every later text part is the label of the image(s) that
 * follow it. Pure.
 * → { prompt, images: [{ buffer, mime }] }
 */
export function toPromptAndImages(parts) {
  const texts = [], images = [], lines = [];
  let label = null;
  for (const p of parts || []) {
    const inline = p && (p.inline_data || p.inlineData);
    if (inline) {
      images.push({ buffer: Buffer.from(inline.data, "base64"), mime: inline.mime_type || inline.mimeType || "image/jpeg" });
      lines.push(`IMAGE ${images.length} — ${label || "another image for the label above"}`);
      label = null;
    } else if (p && p.text) {
      if (!texts.length && !images.length) texts.push(String(p.text)); else label = String(p.text).replace(/:\s*$/, "");
    }
  }
  const prompt = images.length ? `${texts[0] || ""}\n\nTHE IMAGES GIVEN, IN ORDER:\n${lines.join("\n")}` : texts[0] || "";
  return { prompt, images };
}

const ext = (mime) => (/png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : "jpg");

function formOf({ model, prompt, images, size, stream }) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", OPENAI_QUALITY);
  form.append("input_fidelity", OPENAI_FIDELITY);
  form.append("output_format", "jpeg");
  if (stream) { form.append("stream", "true"); form.append("partial_images", String(PARTIAL_IMAGES)); }
  images.forEach((im, i) => form.append("image[]", new Blob([im.buffer], { type: im.mime }), `image-${i + 1}.${ext(im.mime)}`));
  return form;
}

/** Is this a 400 about the streaming fields (no image made, nothing billed)? Pure. */
export function streamRejected(e) {
  return e?.status === 400 && /stream|partial_images/i.test(String(e.message || ""));
}

async function once(model, req, { apiKey, fetchImpl, timeoutMs, onEvent, stream }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const state = { image: null, drafts: [], usage: null, cutShort: null };
  try {
    const res = await fetchImpl(URL_EDITS, { method: "POST", signal: ctl.signal, headers: { Authorization: `Bearer ${apiKey}` }, body: formOf({ model, ...req, stream }) });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const err = new Error(`OpenAI ${model} ${res.status}: ${json?.error?.message || "no detail"}`.slice(0, 300));
      err.status = res.status;
      // The model answered and declined (its content rules): a verdict on this photo, not an outage.
      if (res.status === 400 && /moderation|safety|content policy|rejected/i.test(String(json?.error?.message || json?.error?.code || ""))) err.refusal = true;
      throw err;
    }
    const type = String(res.headers?.get?.("content-type") || "");
    if (!stream || !type.includes("text/event-stream")) {
      const json = await res.json();
      const b64 = json?.data?.[0]?.b64_json;
      if (b64) state.image = { data: b64, mime: "image/jpeg" };
      state.usage = json?.usage || null;
      return state;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const take = async (text) => {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const body = line.slice(5).trim();
        if (!body || body === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(body); } catch { continue; }
        if (ev?.error) { const err = new Error(`OpenAI ${model}: ${ev.error.message || "stream error"}`.slice(0, 300)); err.status = 502; throw err; }
        if (/partial_image$/.test(String(ev?.type || "")) && ev.b64_json) {
          const draft = { data: ev.b64_json, mime: "image/jpeg" };
          state.drafts.push(draft);
          try { await onEvent?.({ type: "draft", draft, n: state.drafts.length }); } catch { /* the card's view never affects the generation */ }
        } else if (/completed$/.test(String(ev?.type || "")) && ev.b64_json) {
          state.image = { data: ev.b64_json, mime: "image/jpeg" };
          if (ev.usage) state.usage = ev.usage;
        }
      }
    };
    try {
      for await (const chunk of res.body) {
        const piece = decoder.decode(chunk, { stream: true });
        buffer += piece;
        if (!piece.includes("\n")) continue;
        const cut = buffer.lastIndexOf("\n");
        const ready = buffer.slice(0, cut + 1);
        buffer = buffer.slice(cut + 1);
        await take(ready);
      }
      await take(buffer);
    } catch (e) {
      // THE IMAGE IS PAID FOR once it has arrived: a connection that breaks after it is kept.
      if (!state.image) throw e;
      state.cutShort = String(e?.message || e).slice(0, 120);
    }
    return state;
  } finally { clearTimeout(timer); }
}

/**
 * One image from gpt-image-1 — the same call shape and result shape as
 * gemini-stream.streamImage. onEvent({ type: "draft", draft, n }) as partial
 * images arrive (gpt-image-1 gives no thought summary).
 */
export async function openaiImage(model, parts, imageConfig, opts = {}) {
  const { apiKey, fetchImpl = fetch, timeoutMs = OPENAI_TIMEOUT_MS, onEvent = null } = opts;
  if (!apiKey) throw new Error("no OpenAI key");
  const { prompt, images } = toPromptAndImages(parts);
  if (!images.length) throw new Error("gpt-image-1 needs the product photo to work from");
  const req = { prompt, images, size: sizeFor(imageConfig?.aspectRatio) };
  const t0 = Date.now();
  let state, streamed = true;
  try {
    state = await once(model, req, { apiKey, fetchImpl, timeoutMs, onEvent, stream: true });
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error(`OpenAI ${model} gave no photo within ${Math.round(timeoutMs / 1000)}s`);
      err.status = 504;
      throw err;
    }
    if (!streamRejected(e)) throw e;
    streamed = false;
    state = await once(model, req, { apiKey, fetchImpl, timeoutMs, onEvent, stream: false });
  }
  if (!state.image) {
    const err = new Error(`the connection to OpenAI ${model} ended before the photo arrived`);
    err.status = 502;
    err.usage = state.usage;
    throw err;
  }
  const drafts = state.drafts.filter((d) => d.data !== state.image.data).map((d) => ({ buffer: Buffer.from(d.data, "base64"), mime: d.mime }));
  return {
    buffer: Buffer.from(state.image.data, "base64"), mime: state.image.mime, text: "",
    thoughts: null, thoughtImages: state.drafts.length, drafts,
    request: { provider: "openai", size: req.size, quality: OPENAI_QUALITY, input_fidelity: OPENAI_FIDELITY, output_format: "jpeg", images: images.length, ...(streamed ? { stream: true, partial_images: PARTIAL_IMAGES } : {}) },
    usage: state.usage, requestMs: Date.now() - t0, thoughtsUnsupported: null,
    ...(state.cutShort ? { cutShort: state.cutShort } : {}),
  };
}
