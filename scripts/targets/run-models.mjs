// ─── TARGETS PIPELINE · STEP 2: THREE-MODEL ANALYSIS ──────────────────────────
// Sends the SAME pre-computed demand aggregates (from extract-demand.mjs) to
// three independent AI models — Claude (Anthropic), GPT (OpenAI), Gemini
// (Google) — and collects each model's recommended target + minQty per
// (product, size, location) for marathon-pe, trophy, and hub2.
//
// The models exercise JUDGMENT only: all arithmetic (netting, velocity,
// baselines) was done deterministically in step 1. Outputs are normalized
// (ints, clamped 0..MAX) and written per provider for step 3's comparison.
//
// KEYS: pulled at runtime from Secret Manager via the firebase CLI
// (anthropic-api-key / OPENAI_API_KEY / GEMINI_API_KEY) unless already in env.
// Nothing is written to disk except normalized model output in out/ (gitignored).
//
// RUN:  node scripts/targets/run-models.mjs [--input out/demand-aggregates-X.json]
//       [--provider claude|gpt|gemini]   (default: all three in parallel)
// Per-batch checkpoints land in out/.cache-*; re-running skips finished batches.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT_DIR, { recursive: true });
const STORES = ["marathon-pe", "trophy"];
const LOCATIONS = ["marathon-pe", "trophy", "hub2"];
const BATCH_SIZE = 40;
const MAX_TARGET = 20;
const CONCURRENCY = 3;

const MODELS = {
  claude: "claude-opus-4-8",
  gpt: process.env.GPT_MODEL || "gpt-5.1",
  gemini: process.env.GEMINI_MODEL || "gemini-pro-latest",
};

// ── input ─────────────────────────────────────────────────────────────────────
const argInput = process.argv.indexOf("--input");
const inputPath = argInput > -1
  ? process.argv[argInput + 1]
  : path.join(OUT_DIR, readdirSync(OUT_DIR).filter((f) => f.startsWith("demand-aggregates-")).sort().pop() || "");
if (!inputPath || !existsSync(inputPath)) { console.error("No demand-aggregates file. Run extract-demand.mjs first."); process.exit(1); }
const { meta, products } = JSON.parse(readFileSync(inputPath, "utf8"));
const argProvider = process.argv.indexOf("--provider");
const providers = argProvider > -1 ? [process.argv[argProvider + 1]] : ["claude", "gpt", "gemini"];

// Tier A only: products with actual demand signal (sales or OOS). Products with
// stock but zero demand fall to the default run in the comparison step — an AI
// can't say anything about them that the "slow mover" rule doesn't already.
let active = products.filter((p) => Object.values(p.sizes).some((s) =>
  STORES.reduce((t, st) => t + (s[st]?.sold90 || 0), 0) + (s.oos90 || 0) > 0));
const argLimit = process.argv.indexOf("--limit");
if (argLimit > -1) active = active.slice(0, Number(process.argv[argLimit + 1]));
console.error(`${active.length} products with demand signal (of ${products.length}) → ${Math.ceil(active.length / BATCH_SIZE)} batches × ${providers.length} providers`);

// ── secrets ───────────────────────────────────────────────────────────────────
function secret(envName, secretName) {
  if (process.env[envName]) return process.env[envName];
  const out = execFileSync("firebase", ["functions:secrets:access", secretName, "--project", "marathon-club"], { encoding: "utf8" });
  return out.trim().split("\n").pop().trim();
}

// ── compact per-product encoding (explained to the models in the prompt) ──────
function encodeProduct(p) {
  const sizes = {};
  for (const [size, s] of Object.entries(p.sizes)) {
    sizes[size] = {
      pe: [s["marathon-pe"].sold90, s["marathon-pe"].sold7, s["marathon-pe"].qty, s["marathon-pe"].baselineTarget],
      tr: [s.trophy.sold90, s.trophy.sold7, s.trophy.qty, s.trophy.baselineTarget],
      oos: s.oos90, h2: s.hub2Qty, ce: s.centralQty, blh2: s.hub2BaselineTarget,
    };
  }
  return { id: p.productId, name: p.name, cat: p.subcategory, sizes };
}

const SYSTEM_PROMPT = `You are an inventory planner for a South African clothing retail network: two shops — "marathon-pe" (Marathon PE, the bigger shop) and "trophy" (Trophy) — replenished daily from hub "hub2", which is replenished from warehouse "central". An automated refill engine will keep every location at the targets you set.

Your job: for each product and size, recommend an integer stock TARGET (desired on-hand qty) and MINQTY (urgency floor: below it, refills become high-priority) for marathon-pe, trophy, and hub2.

DATA (all math pre-computed — do NOT re-derive; exercise judgment only). Per product, per size:
- pe / tr: [soldWindow, soldLast7, currentQty, baselineTarget] for each shop
- soldWindow = return-netted units sold in the last ${meta.actualLedgerDays} days (LIMITATION: only ${meta.actualLedgerDays} days of ledger history exists — no seasonality is knowable; treat soldLast7 vs soldWindow as the only trend signal)
- currentQty may reflect counting errors; negative counts were clamped to 0 upstream
- baselineTarget = round(dailyVelocity × 2) — a mechanical 2-days-of-cover baseline
- oos: count of "out of stock" demand events (unfulfilled demand — a size that was never in stock can have sales of 0 but real demand)
- h2 / ce: current qty at hub2 / central warehouse
- blh2: mechanical hub2 baseline = 2 days of BOTH shops' combined velocity

RULES:
1. Owner's default run per shop is M=3, L=3, XL=2, XXL=2, XXXL=1 (S=2 where stocked). Deviate ONLY with evidence: strong sellers deserve more, slow movers less. Goal ≈ 2 days of cover per shop with minimal overstock; hub2 should buffer ~2 days of both shops combined.
2. Steady sellers: target ≥ baseline, usually baseline+1 for safety stock on fast movers. One-off spikes (soldWindow high but soldLast7 = 0) deserve caution.
3. Slow movers (≤1 sale in the window at a shop): target 1-2 at that shop, 0-1 if the other shop sells it better.
4. A shop that has NEVER sold a product's size and holds no stock of it: target 0 there is acceptable (don't force every product into both shops).
5. oos > 0 with low sales = suppressed demand — lean higher.
6. minQty = ceil(target/2) unless you have a reason otherwise.
7. target 0..${MAX_TARGET} only. Do not recommend hub2 targets for products central+hub2 combined cannot support (h2+ce=0 and no sales → all zeros).
8. Keep "reasoning" under 120 characters per product.

Return ONLY the JSON matching the schema — one entry per product given, ALL sizes provided, all three locations (marathon-pe, trophy, hub2).`;

// ── strict output schema (array-based: dynamic keys aren't allowed) ───────────
const SIZE_ENTRY = {
  type: "object", additionalProperties: false,
  properties: { size: { type: "string" }, target: { type: "integer" }, minQty: { type: "integer" } },
  required: ["size", "target", "minQty"],
};
const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    targets: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          productId: { type: "string" },
          stores: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: {
                location: { type: "string", enum: LOCATIONS },
                sizes: { type: "array", items: SIZE_ENTRY },
              },
              required: ["location", "sizes"],
            },
          },
          reasoning: { type: "string" },
        },
        required: ["productId", "stores", "reasoning"],
      },
    },
  },
  required: ["targets"],
};

const batchUserMessage = (batch) =>
  `Recommend targets for these ${batch.length} products:\n${JSON.stringify(batch.map(encodeProduct))}`;

// ── providers ─────────────────────────────────────────────────────────────────
async function callClaude(batch, keys) {
  const stream = keys.anthropic.messages.stream({
    model: MODELS.claude,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: batchUserMessage(batch) }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("claude refusal");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { parsed: JSON.parse(text), usage: { in: msg.usage.input_tokens, out: msg.usage.output_tokens } };
}

async function callGpt(batch, keys) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.openai}` },
    body: JSON.stringify({
      model: MODELS.gpt,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: batchUserMessage(batch) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "stock_targets", strict: true, schema: SCHEMA } },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404 || /model/i.test(body) && res.status === 400) {
      const list = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${keys.openai}` } }).then((r) => r.json());
      const ids = (list.data || []).map((m) => m.id).filter((id) => /^gpt|^o\d/.test(id)).sort().join(", ");
      throw new Error(`OpenAI model ${MODELS.gpt} unavailable. Set GPT_MODEL. Available: ${ids}`);
    }
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return { parsed: JSON.parse(data.choices[0].message.content), usage: { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens } };
}

async function callGemini(batch, keys) {
  // Gemini's schema dialect: no additionalProperties / no $refs — inline subset.
  const gSchema = JSON.parse(JSON.stringify(SCHEMA, (k, v) => (k === "additionalProperties" ? undefined : v)));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${keys.gemini}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: batchUserMessage(batch) }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: gSchema, maxOutputTokens: 32000 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) {
      const list = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keys.gemini}`).then((r) => r.json());
      const ids = (list.models || []).map((m) => m.name.replace("models/", "")).filter((n) => /gemini/.test(n)).join(", ");
      throw new Error(`Gemini model ${MODELS.gemini} unavailable. Set GEMINI_MODEL. Available: ${ids}`);
    }
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  return { parsed: JSON.parse(text), usage: { in: data.usageMetadata?.promptTokenCount, out: data.usageMetadata?.candidatesTokenCount } };
}

const CALLERS = { claude: callClaude, gpt: callGpt, gemini: callGemini };

// ── normalization: clamp ints, drop unknown ids/locations, count dropouts ─────
function normalize(parsed, batch, dropLog) {
  const validIds = new Set(batch.map((p) => p.productId));
  const sizesById = new Map(batch.map((p) => [p.productId, new Set(Object.keys(p.sizes))]));
  const out = {};
  for (const t of parsed.targets || []) {
    if (!validIds.has(t.productId)) { dropLog.unknownProduct++; continue; }
    const okSizes = sizesById.get(t.productId);
    out[t.productId] = { reasoning: String(t.reasoning || "").slice(0, 200) };
    for (const st of t.stores || []) {
      if (!LOCATIONS.includes(st.location)) { dropLog.unknownLocation++; continue; }
      const loc = {};
      for (const s of st.sizes || []) {
        if (!okSizes.has(String(s.size))) { dropLog.unknownSize++; continue; }
        const target = Math.min(MAX_TARGET, Math.max(0, Math.round(Number(s.target) || 0)));
        const minQty = Math.min(target, Math.max(0, Math.round(Number(s.minQty) || 0)));
        loc[String(s.size)] = { target, minQty };
      }
      out[t.productId][st.location] = loc;
    }
  }
  for (const id of validIds) if (!out[id]) dropLog.missingProduct++;
  return out;
}

// ── run ───────────────────────────────────────────────────────────────────────
const batches = [];
for (let i = 0; i < active.length; i += BATCH_SIZE) batches.push(active.slice(i, i + BATCH_SIZE));
const date = meta.windowEndSa;

async function runProvider(provider, keys) {
  const results = {}; const dropLog = { unknownProduct: 0, unknownLocation: 0, unknownSize: 0, missingProduct: 0 };
  const usage = { in: 0, out: 0 };
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const i = next++;
      const b = batches[i];
      const cachePath = path.join(OUT_DIR, `.cache-${provider}-${date}-${i}-${b.length}-${b[0].productId}.json`);
      let result;
      if (existsSync(cachePath)) {
        result = JSON.parse(readFileSync(cachePath, "utf8"));
      } else {
        for (let attempt = 1; ; attempt++) {
          try { result = await CALLERS[provider](batches[i], keys); break; }
          catch (e) {
            if (attempt >= 3) throw new Error(`${provider} batch ${i}: ${e.message}`);
            console.error(`  ${provider} batch ${i} attempt ${attempt} failed (${String(e.message).slice(0, 120)}), retrying...`);
            await new Promise((r) => setTimeout(r, 15000 * attempt));
          }
        }
        writeFileSync(cachePath, JSON.stringify(result));
      }
      Object.assign(results, normalize(result.parsed, batches[i], dropLog));
      usage.in += result.usage?.in || 0; usage.out += result.usage?.out || 0;
      console.error(`  ${provider}: batch ${i + 1}/${batches.length} done`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const outPath = path.join(OUT_DIR, `targets-${provider}-${date}.json`);
  writeFileSync(outPath, JSON.stringify({ provider, model: MODELS[provider], generatedAt: new Date().toISOString(), input: path.basename(inputPath), usage, dropLog, targets: results }, null, 1));
  console.error(`${provider} DONE → ${outPath}  (products: ${Object.keys(results).length}, tokens in/out: ${usage.in}/${usage.out}, drops: ${JSON.stringify(dropLog)})`);
}

const keys = {};
if (providers.includes("claude")) keys.anthropic = new Anthropic({ apiKey: secret("ANTHROPIC_API_KEY", "anthropic-api-key") });
if (providers.includes("gpt")) keys.openai = secret("OPENAI_API_KEY", "OPENAI_API_KEY");
if (providers.includes("gemini")) keys.gemini = secret("GEMINI_API_KEY", "GEMINI_API_KEY");

const settled = await Promise.allSettled(providers.map((p) => runProvider(p, keys)));
let failed = false;
settled.forEach((s, idx) => { if (s.status === "rejected") { failed = true; console.error(`PROVIDER ${providers[idx]} FAILED: ${s.reason?.message || s.reason}`); } });
process.exit(failed ? 1 : 0);
