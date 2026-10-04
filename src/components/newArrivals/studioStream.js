// ─── A STREAMING CALLABLE, READ WITH fetch ───────────────────────────────────
// newArrivalsStudio answers while it works: each `response.sendChunk(x)` on the
// server arrives here as an SSE line `data: {"message": x}`, and the return
// value as `data: {"result": …}` (an HttpsError as `data: {"error": …}`).
// The installed Firebase JS SDK (10.x) has no streaming callable, so this
// speaks the callable protocol directly: POST { data }, the user's ID token as
// a Bearer header, Accept: text/event-stream. No Firebase import here — the
// token and fetch are injected, so it runs in tests.

/** Split a growing SSE buffer into complete `data:` payloads + the unfinished tail. Pure. */
export function sseSplit(buffer) {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop();
  const payloads = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (body) payloads.push(body);
  }
  return { payloads, rest };
}

// Past the function's own 540 s limit.
export const STREAM_TIMEOUT_MS = 570_000;

const fail = (error) => {
  const e = new Error(error?.message || "The photo service did not answer.");
  e.code = error?.status || "unknown";
  return e;
};

/**
 * Call a streaming callable. onChunk(x) for every chunk; resolves with the
 * result; rejects with the server's own message.
 *   { url, data, getToken(), fetchImpl, onChunk }
 */
export async function streamCallable({ url, data, getToken, fetchImpl = fetch, onChunk = null, timeoutMs = STREAM_TIMEOUT_MS }) {
  const token = await getToken();
  if (!token) throw fail({ message: "Sign in required.", status: "UNAUTHENTICATED" });
  // A connection that stalls (phone locked, signal lost) is ended here — a
  // little after the function's own 9-minute limit — so the card never waits for ever.
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let reader = null;
  try {
    return await read(await fetchImpl(url, {
      method: "POST", ...(ctl ? { signal: ctl.signal } : {}),
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data }),
    }), onChunk, (r) => { reader = r; });
  } finally {
    if (timer) clearTimeout(timer);
    // Whatever ended the read (an error line, a thrown error), the connection is let go.
    try { reader?.cancel?.(); } catch { /* already closed */ }
  }
}

async function read(res, onChunk, holdReader) {
  // The answer is read as it arrives, whatever content type it is labelled
  // with (a refusal sent before the stream starts comes as SSE lines under a
  // plain content type). An answer with no `data:` line at all is one JSON body.
  let result;
  let done = false;
  let sawLine = false;
  let raw = "";
  const take = (payloads) => {
    for (const body of payloads) {
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (!msg || typeof msg !== "object") continue;
      sawLine = true;
      if (msg.error) throw fail(msg.error);
      if ("result" in msg) { result = msg.result; done = true; }
      else if ("message" in msg) { try { onChunk?.(msg.message); } catch { /* the view never breaks the call */ } }
    }
  };
  const whole = (text) => {
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json && "result" in json) return json.result;
    throw fail(json?.error || { message: `The photo service answered ${res.status}.` });
  };
  if (!res.body?.getReader) {
    const text = res.text ? await res.text() : JSON.stringify(await res.json().catch(() => null));
    take(sseSplit(`${text}\n`).payloads);
    return done ? result : whole(text);
  }
  const reader = res.body.getReader();
  holdReader(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) {
      const piece = decoder.decode(value, { stream: true });
      buffer += piece;
      if (!sawLine && raw.length < 65536) raw += piece;
      if (piece.includes("\n")) {
        const { payloads, rest } = sseSplit(buffer);
        buffer = rest;
        take(payloads);
      }
    }
    if (end) break;
  }
  take(sseSplit(`${buffer}\n`).payloads);
  if (!done && !sawLine) return whole(raw);
  if (!done) throw fail({ message: "The connection closed before the photo arrived — check the card in a minute before trying again." });
  return result;
}
