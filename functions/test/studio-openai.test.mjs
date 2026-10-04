// gpt-image-1 behind the SAME interface as Gemini: the same parts go in, the
// same result shape comes out; one attempt per tap; real cost from its usage.
import test from "node:test";
import assert from "node:assert/strict";
import { openaiImage, toPromptAndImages, sizeFor, streamRejected } from "../newArrivals/studio/openai-image.mjs";
import { imagePart, textPart } from "../newArrivals/studio/gemini-stream.mjs";
import { usageRow, costOf, generationCost } from "../newArrivals/studio/record.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prices = require("../newArrivals/studio/config/prices.json");
const b64 = (s) => Buffer.from(s).toString("base64");
const PARTS = [
  textPart("THE PROMPT — make one studio photo."),
  textPart("BACKGROUND PLATE — use exactly:"), imagePart(Buffer.from("plate")),
  textPart("GARMENT PHOTO — the real garment(s):"), imagePart(Buffer.from("garment"), "image/png"),
];
const sse = (events, { status = 200 } = {}) => {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = Buffer.from(text);
  return { ok: status === 200, status, headers: { get: () => "text/event-stream" }, body: (async function* () { for (let i = 0; i < bytes.length; i += 41) yield bytes.subarray(i, i + 41); })() };
};
const json = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => "application/json" }, json: async () => body });
const USAGE = { input_tokens: 2400, output_tokens: 6240, input_tokens_details: { text_tokens: 900, image_tokens: 1500 } };

test("the SAME parts become one prompt and the images in order — every image named by the sentence that introduced it", () => {
  const { prompt, images } = toPromptAndImages(PARTS);
  assert.equal(prompt, "THE PROMPT — make one studio photo.\n\nTHE IMAGES GIVEN, IN ORDER:\nIMAGE 1 — BACKGROUND PLATE — use exactly\nIMAGE 2 — GARMENT PHOTO — the real garment(s)");
  assert.deepEqual(images.map((i) => [i.buffer.toString(), i.mime]), [["plate", "image/jpeg"], ["garment", "image/png"]]);
  // The prompt itself is untouched: it is the first thing in the request, word for word.
  assert.ok(prompt.startsWith(PARTS[0].text));
});

test("the size is the one nearest the aspect the layout asks for", () => {
  assert.equal(sizeFor("3:4"), "1024x1536");
  assert.equal(sizeFor("4:3"), "1536x1024");
  assert.equal(sizeFor("1:1"), "1024x1024");
  assert.equal(sizeFor(undefined), "1024x1024");
});

test("one call to the edit endpoint with the real photos as input; partial images are drafts; the result has Gemini's shape", async () => {
  const calls = [], seen = [];
  const out = await openaiImage("gpt-image-1", PARTS, { aspectRatio: "3:4", imageSize: "2K" }, {
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return sse([{ type: "image_edit.partial_image", b64_json: b64("draft-1") }, { type: "image_edit.partial_image", b64_json: b64("FINAL") }, { type: "image_edit.completed", b64_json: b64("FINAL"), usage: USAGE }]);
    },
    onEvent: (ev) => seen.push(`${ev.type}:${ev.n}`),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  const form = calls[0].init.body;
  assert.equal(form.get("model"), "gpt-image-1");
  assert.equal(form.get("size"), "1024x1536");
  assert.equal(form.get("quality"), "high");
  assert.equal(form.get("input_fidelity"), "high", "the product is kept, not re-imagined");
  assert.equal(form.getAll("image[]").length, 2);
  assert.ok(String(form.get("prompt")).startsWith("THE PROMPT"));
  assert.deepEqual(seen, ["draft:1", "draft:2"]);
  assert.equal(out.buffer.toString(), "FINAL");
  // A draft identical to the final image is the final image, not a draft.
  assert.deepEqual(out.drafts.map((d) => d.buffer.toString()), ["draft-1"]);
  assert.equal(out.thoughts, null);
  assert.deepEqual(out.usage, USAGE);
  assert.equal(out.request.provider, "openai");
  for (const k of ["buffer", "mime", "drafts", "usage", "requestMs", "request", "thoughtImages"]) assert.ok(k in out, k);
});

test("an API error is thrown with its status and the image call is NOT retried; a content refusal is a refusal", async () => {
  let n = 0;
  await assert.rejects(openaiImage("gpt-image-1", PARTS, {}, { apiKey: "k", fetchImpl: async () => { n += 1; return json({ error: { message: "The server is overloaded" } }, 503); } }), (e) => e.status === 503 && !e.refusal);
  assert.equal(n, 1);
  await assert.rejects(openaiImage("gpt-image-1", PARTS, {}, { apiKey: "k", fetchImpl: async () => json({ error: { message: "Your request was rejected by the safety system", code: "moderation_blocked" } }, 400) }), (e) => e.refusal === true);
});

test("a 400 about the streaming fields (no image made) is sent once more without them; any other 400 is final", async () => {
  const forms = [];
  const out = await openaiImage("gpt-image-1", PARTS, {}, { apiKey: "k", fetchImpl: async (url, init) => {
    forms.push(init.body);
    return forms.length === 1 ? json({ error: { message: "Unknown parameter: 'partial_images'." } }, 400) : json({ data: [{ b64_json: b64("FINAL") }], usage: USAGE });
  } });
  assert.equal(forms.length, 2);
  assert.equal(forms[1].get("stream"), null);
  assert.equal(out.buffer.toString(), "FINAL");
  assert.equal(streamRejected({ status: 400, message: "bad image" }), false);
});

test("no key, no call; no input photo, no call (gpt-image-1 must work FROM the real photo)", async () => {
  const fetchImpl = async () => { throw new Error("called"); };
  await assert.rejects(openaiImage("gpt-image-1", PARTS, {}, { fetchImpl }), /no OpenAI key/);
  await assert.rejects(openaiImage("gpt-image-1", [textPart("only words")], {}, { apiKey: "k", fetchImpl }), /needs the product photo/);
});

test("the connection breaks after the image arrived: the paid image is kept; before it: an error", async () => {
  const breaking = (events, failAfterEvents) => {
    const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
    return { ok: true, status: 200, headers: { get: () => "text/event-stream" }, body: (async function* () { for (let i = 0; i < failAfterEvents; i++) yield Buffer.from(text[i]); throw new Error("socket hang up"); })() };
  };
  const ev = [{ type: "image_edit.completed", b64_json: b64("FINAL"), usage: USAGE }, { type: "x" }];
  const out = await openaiImage("gpt-image-1", PARTS, {}, { apiKey: "k", fetchImpl: async () => breaking(ev, 1) });
  assert.equal(out.buffer.toString(), "FINAL");
  assert.match(out.cutShort, /socket hang up/);
  await assert.rejects(openaiImage("gpt-image-1", PARTS, {}, { apiKey: "k", fetchImpl: async () => breaking(ev, 0) }), /socket hang up/);
});

test("REAL cost from OpenAI's own token counts: text in $5, image in $10, image out $40 per million", () => {
  const row = usageRow("gpt-image-1", USAGE);
  assert.deepEqual(row, { model: "gpt-image-1", prompt: 900, imageIn: 1500, output: 0, imageOut: 6240, thoughts: 0 });
  assert.ok(Math.abs(costOf([row], prices).usd - (900 * 5 + 1500 * 10 + 6240 * 40) / 1e6) < 1e-12);
  const cost = generationCost({ model: "gpt-image-1", usage: USAGE, prices, fx: { rate: 17 } });
  assert.equal(cost.estimated, false);
  assert.equal(cost.usd, 0.269);
  assert.equal(cost.zar, 4.57);
  // Gemini's rows are priced exactly as before.
  assert.equal(generationCost({ model: "gemini-3-pro-image", usage: { promptTokenCount: 9000, candidatesTokenCount: 1200, thoughtsTokenCount: 300, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }] }, prices, fx: { rate: 17.5 } }).zar, 2.75);
});
