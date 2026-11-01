// The local model, over Ollama's HTTP API on the mini (localhost only). Free:
// no key, no per-call price. keep_alive is short so the model's memory goes
// back to the mini's other jobs a few minutes after the stylist is done.
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

/** One chat turn with images: returns { json, text, ms }. Throws on HTTP or JSON failure. */
export async function chatJSON({ model, system, prompt, images = [], schema, timeoutMs = 600000, temperature = 0.5 }) {
  const t0 = Date.now();
  const body = {
    model, stream: false, keep_alive: "3m", think: false,
    format: schema,
    options: { temperature, num_ctx: 16384 },
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt, images },
    ],
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
  } finally { clearTimeout(timer); }
  const raw = await res.text();
  if (!res.ok) throw new Error(`ollama ${res.status}: ${raw.slice(0, 200)}`);
  const text = (JSON.parse(raw).message || {}).content || "";
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`the model's answer was not JSON: ${text.slice(0, 160)}`); }
  return { json, text, ms: Date.now() - t0 };
}

/** True when the server answers and the model is pulled. */
export async function modelReady(model) {
  const r = await fetch(`${OLLAMA_URL}/api/tags`).then((x) => x.json());
  return (r.models || []).some((m) => m.name === model || m.model === model);
}
