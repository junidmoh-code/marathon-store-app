// The streamed Gemini call: thought text and drafts are reported as they
// arrive, a thought part is never the output, and an image call is never retried.
import test from "node:test";
import assert from "node:assert/strict";
import { streamImage, sseSplit, foldChunk, newState } from "../newArrivals/studio/gemini-stream.mjs";

const b64 = (s) => Buffer.from(s).toString("base64");
const event = (parts, extra = {}) => `data: ${JSON.stringify({ candidates: [{ content: { parts } }], ...extra })}\n\n`;
// A streamed body cut at awkward places (mid-line), as the network delivers it.
function sseResponse(text, { status = 200, cut = 37 } = {}) {
  const bytes = Buffer.from(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += cut) chunks.push(bytes.subarray(i, i + cut));
  return { ok: status === 200, status, body: (async function* () { for (const c of chunks) yield c; })(), json: async () => JSON.parse(text) };
}
const STREAM = [
  event([{ thought: true, text: "First I look at the hoodie. " }]),
  event([{ thought: true, inlineData: { mimeType: "image/png", data: b64("draft-1") } }]),
  event([{ thought: true, text: "Then I place it." }, { thought: true, inline_data: { mime_type: "image/png", data: b64("FINAL") } }]),
  event([{ inlineData: { mimeType: "image/jpeg", data: b64("FINAL") } }, { text: "Done." }], { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5 } }),
].join("");

test("sseSplit keeps an unfinished line for the next chunk", () => {
  assert.deepEqual(sseSplit("data: {\"a\":1}\n\ndata: {\"b\""), { payloads: ["{\"a\":1}"], rest: "data: {\"b\"" });
  assert.deepEqual(sseSplit("event: x\ndata: [DONE]\n").payloads, []);
});

test("foldChunk: a thought image is a draft, never the output", () => {
  const s = newState();
  const evs = foldChunk(s, { candidates: [{ content: { parts: [{ thought: true, inlineData: { data: "AAA" } }, { inlineData: { data: "BBB" } }] } }] });
  assert.deepEqual(evs.map((e) => e.type), ["draft"]);
  assert.equal(s.image.data, "BBB");
  assert.equal(s.drafts.length, 1);
});

test("streamImage reports thoughts and drafts in order and returns the final image with its usage", async () => {
  const seen = [];
  const calls = [];
  const out = await streamImage("gemini-3-pro-image", [{ text: "p" }], { aspectRatio: "3:4", imageSize: "2K" }, {
    apiKey: "k",
    fetchImpl: async (url, init) => { calls.push({ url, init }); return sseResponse(STREAM); },
    onEvent: (ev) => seen.push(ev.type === "thought" ? `t:${ev.text}` : `d:${ev.n}`),
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-3-pro-image:streamGenerateContent\?alt=sse$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "k");
  assert.deepEqual(JSON.parse(calls[0].init.body).generationConfig, { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "3:4", imageSize: "2K" }, thinkingConfig: { includeThoughts: true } });
  assert.deepEqual(seen, ["t:First I look at the hoodie. ", "d:1", "t:Then I place it.", "d:2"]);
  assert.equal(out.buffer.toString(), "FINAL");
  assert.equal(out.thoughts, "First I look at the hoodie. Then I place it.");
  assert.equal(out.thoughtImages, 2);
  // The draft identical to the final image is the final image, not a draft.
  assert.deepEqual(out.drafts.map((d) => d.buffer.toString()), ["draft-1"]);
  assert.deepEqual(out.usage, { promptTokenCount: 9, candidatesTokenCount: 5 });
  assert.equal(out.text, "Done.");
});

test("an API error is thrown with its status and the image call is NOT retried", async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; return sseResponse(JSON.stringify({ error: { message: "The model is overloaded" } }), { status: 503 }); };
  await assert.rejects(streamImage("m", [], {}, { apiKey: "k", fetchImpl }), (e) => e.status === 503 && /overloaded/.test(e.message));
  assert.equal(n, 1);
});

test("a 400 naming the thinking field is resent once without it; any other 400 is final", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? sseResponse(JSON.stringify({ error: { message: "Unknown name thinkingConfig" } }), { status: 400 }) : sseResponse(STREAM);
  };
  const out = await streamImage("m", [], {}, { apiKey: "k", fetchImpl });
  assert.equal(bodies.length, 2);
  assert.equal("thinkingConfig" in bodies[1].generationConfig, false);
  assert.match(out.thoughtsUnsupported, /thinkingConfig/);
  let n = 0;
  await assert.rejects(streamImage("m", [], {}, { apiKey: "k", fetchImpl: async () => { n += 1; return sseResponse(JSON.stringify({ error: { message: "bad image" } }), { status: 400 }); } }), /bad image/);
  assert.equal(n, 1);
});

test("an answer with no image is a refusal, with Gemini's words", async () => {
  const text = `data: ${JSON.stringify({ candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [{ text: "I can't make that." }] } }] })}\n\n`;
  await assert.rejects(streamImage("m", [], {}, { apiKey: "k", fetchImpl: async () => sseResponse(text) }), (e) => e.refusal === true && /IMAGE_SAFETY/.test(e.message) && /can't make/.test(e.message));
});

test("no key, no call", async () => {
  await assert.rejects(streamImage("m", [], {}, { fetchImpl: async () => { throw new Error("called"); } }), /no Gemini key/);
});
