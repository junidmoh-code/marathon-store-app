// ── WHAT IS KEPT OF EVERY GENERATION ────────────────────────────────────────
// The generation entry on the item (items/{pid}/generations/{genId}), the
// learning-log record (genlog/{code}) and the real cost, from the API's own
// token counts. The shapes are the Mac mini pipeline's (worker.generationEntry,
// genlog.genlogRecord, cost.costOf) for every field the card and the chain
// read. Not carried over: the checker's verdict and measurements (everything
// is manual), and the busy-tap list.
import crypto from "node:crypto";

export const GENSEQ = "new_arrivals/genSeq";
export const GENLOG = "new_arrivals/genlog";
export const THOUGHTS_LABEL = "Gemini's own account — not proof";
export const SEED_NOTE = "not set — the API picks";
export const RTDB_THOUGHTS_MAX = 4000;

/** 7 → "G-0007"; 4+ digits, zero-padded. Pure. */
export const formatCode = (n) => `G-${String(n).padStart(4, "0")}`;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// RTDB rejects undefined (the SDK throws): a JSON round trip drops it.
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;

// ── cost ─────────────────────────────────────────────────────────────────────
/** One call's usageMetadata as a priced row (image output tokens apart). Pure. */
export function usageRow(model, usage) {
  if (!usage) return null;
  const imageOut = (usage.candidatesTokensDetails || []).filter((d) => d.modality === "IMAGE").reduce((n, d) => n + (d.tokenCount || 0), 0);
  return { model, prompt: usage.promptTokenCount || 0, output: Math.max(0, (usage.candidatesTokenCount || 0) - imageOut), imageOut, thoughts: usage.thoughtsTokenCount || 0 };
}

/** USD (and rand at `usdZar`) for usage rows, at config/prices.json list prices. Pure. */
export function costOf(rows, prices, usdZar = null) {
  let usd = 0;
  const unpriced = new Set();
  for (const r of rows) {
    const p = prices.models[r.model] || (unpriced.add(r.model), prices.models.default);
    usd += (r.prompt * p.input + (r.output + r.thoughts) * p.output + r.imageOut * (p.imageOutput ?? p.output)) / 1e6;
  }
  return { usd, zar: usd * (usdZar ?? prices.usdToZar), calls: rows.length, unpriced: [...unpriced] };
}

/** The list-price estimate of ONE generation, used only when the API returned no usage. Pure. */
export function generationEstimateUsd(prices, model = "gemini-3-pro-image") {
  const p = prices.models[model] || prices.models.default;
  return (1120 * (p.imageOutput ?? p.output) + 9000 * p.input) / 1e6;
}

/**
 * The cost of one generation: REAL when the API reported usage (the day's
 * USD/ZAR rate), else the marked estimate. Pure.
 * → { usd, zar, usdZar, usdZarFallback?, estimated }
 */
export function generationCost({ model, usage, prices, fx }) {
  const live = Number(fx?.rate) > 0 && !fx.fallback;
  const usdZar = Number(fx?.rate) > 0 ? Number(fx.rate) : prices.usdToZar;
  const rate = { usdZar, ...(live ? {} : { usdZarFallback: true }) };
  const row = usageRow(model, usage);
  // Real only when the API counted the IMAGE's own tokens: without that split
  // an image would be priced as text, ten times too low.
  if (row && row.imageOut > 0) {
    const c = costOf([row], prices, usdZar);
    if (Number.isFinite(c.zar) && c.zar > 0) return { usd: r3(c.usd), zar: r2(c.zar), ...rate, estimated: false };
  }
  const usd = generationEstimateUsd(prices, model);
  return { usd: r3(usd), zar: r2(usd * usdZar), ...rate, estimated: true };
}

/** What a call that made NO image still cost (its prompt and thinking tokens), in rand; 0 when unknown. Pure. */
export function failedCallZar({ model, usage, prices, fx }) {
  const row = usageRow(model, usage);
  if (!row) return 0;
  const zar = costOf([row], prices, Number(fx?.rate) > 0 ? Number(fx.rate) : prices.usdToZar).zar;
  return Number.isFinite(zar) && zar > 0 ? r2(zar) : 0;
}

// ── the generation entry ─────────────────────────────────────────────────────
/**
 * One kept generation, as the card and the chain read it. Pure.
 *   res: { generated: { url, path }, kind, method, layersUsed, promptVersion, packaging?, measurements? }
 */
export function generationEntry(res, { at, cost, model, reason, code = null, draftCount = 0 }) {
  const method = res.method === "split" ? "split" : "full";
  return clean({
    ...(code ? { code } : {}),
    url: res.generated.url, path: res.generated.path || null, at, model,
    promptVersion: res.promptVersion,
    method,
    ...(method === "split" ? (res.packaging ? { packaging: res.packaging } : {}) : { layers: Object.fromEntries((res.layersUsed || []).map((k) => [k, true])) }),
    how: { code: code || null, draftCount: Number(draftCount) || 0 },
    plate: res.kind ? `junid-${res.kind}` : null, kind: res.kind || null,
    costUsd: cost.usd, costZar: cost.zar, costEstimated: !!cost.estimated, usdZar: cost.usdZar,
    // The day's rate could not be looked up: the configured rate was used.
    ...(cost.usdZarFallback ? { usdZarFallback: true } : {}),
    reason,
    // EVERYTHING IS MANUAL: a photo carries no verdict at all.
    verdict: null,
    layout: res.layout || null,
    measurements: res.measurements || null,
  });
}

// ── the learning log ─────────────────────────────────────────────────────────
/** The FULL record of one kept generation (promptText included). Pure. */
export function genlogRecord({ code, pid, genId, gen, trace = null, totalMs = null }) {
  const t = trace || {};
  const req = t.request || null;
  return clean({
    code: code || null, pid, genId, at: gen.at, model: gen.model || null,
    imageSize: req?.imageConfig?.imageSize || null, aspectRatio: req?.imageConfig?.aspectRatio || null,
    resolution: t.resolution || null,
    promptVersion: gen.promptVersion || null, setup: String(gen.promptVersion || "").split(" ")[0] || null,
    layers: t.layers || null, plate: gen.plate || null, kind: gen.kind || null,
    promptText: t.promptText ?? null,
    promptSha: t.promptText ? sha(t.promptText) : null,
    inputs: t.inputs || [],
    request: req,
    seed: null, seedNote: SEED_NOTE,
    retries: 0, thoughtsResent: !!t.thoughtsUnsupported,
    usage: t.usage || null,
    costUsd: gen.costUsd ?? null, costZar: gen.costZar ?? null, usdZar: gen.usdZar ?? null, costEstimated: !!gen.costEstimated,
    ...(gen.usdZarFallback ? { usdZarFallback: true } : {}),
    ...(t.streamCutShort ? { streamCutShort: t.streamCutShort } : {}), ...(t.finishNote ? { finishNote: t.finishNote } : {}), ...(t.boxNote ? { boxNote: t.boxNote } : {}),
    timing: { requestMs: t.requestMs ?? null, totalMs },
    thoughts: t.thoughts ?? null, thoughtImages: t.thoughtImages || 0,
    drafts: (t.draftFiles || []).map((d) => ({ url: d.url, path: d.path || null })),
    method: gen.method || "full",
    ...(t.split ? { split: t.split } : {}),
    ...(t.thoughtsUnsupported ? { thoughtsUnsupported: t.thoughtsUnsupported } : {}),
    thoughtsLabel: THOUGHTS_LABEL,
    measurements: gen.measurements || null,
    transport: "streamGenerateContent (Cloud Function)",
  });
}

/** The RTDB copy: everything but promptText (its sha stays); thoughts capped. Pure. */
export function rtdbGenlog(record) {
  const { promptText, ...rest } = record;
  void promptText;
  if (typeof rest.thoughts === "string" && rest.thoughts.length > RTDB_THOUGHTS_MAX) {
    rest.thoughts = `${rest.thoughts.slice(0, RTDB_THOUGHTS_MAX)}… (full text in the stored record)`;
  }
  return clean(rest);
}
