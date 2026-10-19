// ─── THE STYLIST'S ONE TEXT-MODEL CALL ───────────────────────────────────────
// The scores (lib/stylist.cjs) have already chosen a shortlist of near-ties;
// this asks a small model to pick one and write the one-line styling note.
// claude-haiku-5-5 at $0.10 per million input tokens and $0.50 output, effort
// low: a call is ~1,500 tokens in and a few hundred out, a fraction of a cent.
// The lookbook engines and the social generator both use it.
"use strict";

const STYLIST_MODEL = "claude-haiku-5-5";
const IN_PER_MTOK = 0.10;
const OUT_PER_MTOK = 0.50;

/** USD for one answer's usage. Pure. */
function stylistCostUSD(usage) {
  const u = usage || {};
  return ((Number(u.input_tokens) || 0) * IN_PER_MTOK + (Number(u.output_tokens) || 0) * OUT_PER_MTOK) / 1e6;
}

/**
 * A chooser for makeLookbook / the social generator: (prompt) → { text, costUSD }.
 * Throws on any API failure; the callers keep the top score when it does.
 */
function makeStylistChooser({ Anthropic, apiKey, model = STYLIST_MODEL, timeoutMs = 45000 }) {
  return async function chooseOutfit(prompt) {
    const Ctor = Anthropic.default || Anthropic;
    const client = new Ctor({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    const msg = await client.messages.create({
      model,
      // Room for Haiku 5.5's adaptive thinking before the JSON; cost is negligible.
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    });
    if (msg.stop_reason === "refusal") throw new Error("the stylist call was refused");
    // A cut-off answer is half a JSON object: not an answer.
    if (msg.stop_reason === "max_tokens") throw new Error("the stylist's answer was cut off (max_tokens)");
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return { text, costUSD: stylistCostUSD(msg.usage), model };
  };
}

module.exports = { STYLIST_MODEL, stylistCostUSD, makeStylistChooser };
