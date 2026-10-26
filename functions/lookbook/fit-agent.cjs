// ─── THE STYLIST AND THE CRITIC: BUILD, SCORE, REBUILD, OR SKIP ─────────────
// One outfit, end to end, on claude-opus-5-5 (Junid, 26 Oct 2026):
//
//   1. the STYLIST builds a fit from the offered catalogue, following the
//      written rulebook (lib/fit-rulebook.md), and writes its caption;
//   2. code checks the answer (lib/fit-rules readStylistAnswer). A refused
//      answer is a failed round and its problems go back to the stylist;
//   3. the CRITIC, a separate call that sees the real product photos and
//      never the stylist's reasoning, scores colour, formality match, theme
//      name accuracy and caption accuracy 1–10;
//   4. any score under 8 is a rebuild with the critic's reasons. At most two
//      rebuilds (MAX_ROUNDS = 3), then the fit is SKIPPED: the caller posts
//      nothing styled rather than a bad fit.
//
// THE BUDGET is $0.15 per finished outfit, every call of every round
// included. Before each call its worst case (lib/fit-rules worstCaseUSD) is
// added to what has been spent; a call that could break the budget is not
// made and the fit is skipped. A refusal or an API error is a skip too: no
// other model stands in (the brief names opus-5-5 for both).
//
// Every round is returned (fit, scores, reasons, cost), so the caller logs
// the score and reasons per post.
"use strict";

const fr = require("../lib/fit-rules.cjs");

/**
 * The model call both roles use: (request) → { json, usage, costUSD }.
 * Throws on an API error, a refusal, a cut-off answer or unreadable JSON.
 */
function makeOpusCall({ Anthropic, apiKey, timeoutMs = 90000 }) {
  const Ctor = Anthropic.default || Anthropic;
  // No SDK retries: a timed-out call may still be billed, and a retry the
  // budget never priced could take a fit past $0.15. One attempt, one price.
  const client = new Ctor({ apiKey, timeout: timeoutMs, maxRetries: 0 });
  return async function call(req) {
    const msg = await client.messages.create({
      model: fr.FIT_MODEL,
      max_tokens: req.maxTokens,
      output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
      system: req.system,
      messages: req.messages,
    });
    const usage = msg.usage || {};
    const costUSD = fr.costOf(usage);
    const fail = (why) => { const e = new Error(why); e.costUSD = costUSD; e.usage = usage; throw e; };
    if (process.env.FIT_DEBUG) console.log(`fit call: ${JSON.stringify({ in: usage.input_tokens, cw: usage.cache_creation_input_tokens, cr: usage.cache_read_input_tokens, out: usage.output_tokens, think: usage.output_tokens_details && usage.output_tokens_details.thinking_tokens, usd: +costUSD.toFixed(4) })}`);
    if (msg.stop_reason === "refusal") fail("the model refused");
    if (msg.stop_reason === "max_tokens") fail("the answer was cut off (max_tokens)");
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let json;
    try { json = JSON.parse(text); } catch { fail("the answer was not JSON"); }
    return { json, usage, costUSD, cachedTokens: (Number(usage.cache_creation_input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) };
  };
}

/**
 * @param offer  { pieces, slots, core, optional, minPieces, maxPieces, season, kind, knownBrands }
 *               pieces as lib/fit-rules expects, each with photoUrl
 * @param deps   { call(req) → { json, costUSD }, photo(piece) → { base64, mediaType } | null, log? }
 * @param opts   { budgetUSD, feedback: lines from an earlier run of the same post }
 * @returns { ok: true, fit, verdict, rounds, costUSD }
 *        | { ok: false, reason, rounds, costUSD }
 *   rounds: [{ round, fit: { formula, theme, pids, hero }, problems?, scores?, min?, reasons?, seen?, fix?, error?, costUSD }]
 */
async function buildFit(offer, deps, { budgetUSD = fr.BUDGET_USD, feedback: earlier = [] } = {}) {
  const log = deps.log || (() => {});
  const rounds = [];
  const feedback = [...earlier];
  // Pieces the critic said must leave the fit: never offered back (a fixed hero excepted).
  const banned = new Set();
  let spent = 0;
  const photos = new Map();
  // The prefix each role's last call cached: a rebuild reads it at $0.20/M.
  const cached = { stylist: 0, critic: 0 };
  const worst = (req, role) => fr.worstCaseUSD(req, { cachedTokens: cached[role] });
  // A request's input at its worst (no output), and the output ceiling the
  // budget left can pay for after `keep` more dollars are held back.
  const inputWorst = (req, role) => worst({ ...req, maxTokens: 0 }, role);
  const OUT = fr.PRICE.outPerMtok / 1e6;
  const ceiling = (inUSD, max, keep = 0) => Math.min(max, Math.floor((budgetUSD - spent - inUSD - keep) / OUT));
  let criticInput = 0;
  const summary = (fit) => fit && { formula: fit.formula, theme: fit.theme, pids: fit.pieces.map((p) => p.pid), hero: fit.hero ? fit.hero.pid : null };
  const skip = (reason) => ({ ok: false, reason, rounds, costUSD: spent });

  for (let round = 1; round <= fr.MAX_ROUNDS; round++) {
    // ── THE STYLIST ────────────────────────────────────────────────────
    const sreq = fr.stylistRequest({ ...offer, feedback });
    // A round starts only when its stylist AND its critic fit, each with room
    // for MIN_OUT_TOKENS: a stylist answer the critic cannot afford to score
    // is money spent on nothing. The stylist's ceiling is what is left once
    // the critic's share is held back.
    const criticKeep = (criticInput || fr.CRITIC_INPUT_RESERVE_USD) + fr.MIN_OUT_TOKENS * OUT;
    sreq.maxTokens = ceiling(inputWorst(sreq, "stylist"), fr.STYLIST_MAX_TOKENS, criticKeep);
    if (sreq.maxTokens < fr.MIN_OUT_TOKENS) return skip(`round ${round}: a stylist call and its critic do not fit in what is left of the $${budgetUSD} budget ($${spent.toFixed(3)} spent)`);
    let answer;
    try { answer = await deps.call(sreq); } catch (e) {
      // An error with no usage (a timeout, a 5xx) may still have been billed: charged at its worst case.
      spent += e && Number.isFinite(e.costUSD) ? e.costUSD : worst(sreq, "stylist");
      rounds.push({ round, error: `stylist: ${String(e && e.message).slice(0, 160)}`, costUSD: (e && e.costUSD) || 0 });
      return skip(`the stylist call failed: ${String(e && e.message).slice(0, 160)}`);
    }
    spent += answer.costUSD;
    cached.stylist = answer.cachedTokens || 0;
    const read = fr.readStylistAnswer(answer.json, { ...offer, banned });
    if (!read.ok) {
      rounds.push({ round, fit: summary(read.fit), problems: read.problems, costUSD: answer.costUSD });
      log(`fit round ${round}: refused by the checks — ${read.problems.join("; ")}`);
      feedback.push(fr.feedbackLine(read.fit, { problems: read.problems }));
      continue;
    }
    const fit = read.fit;

    // ── THE CRITIC, with the real photos ───────────────────────────────
    const shots = [];
    for (const p of fit.pieces) {
      if (!photos.has(p.pid)) {
        let ph = null;
        try { ph = await deps.photo(p); } catch (e) { log(`fit: no photo for ${p.pid} (${String(e && e.message).slice(0, 80)})`); }
        photos.set(p.pid, ph);
      }
      const ph = photos.get(p.pid);
      if (ph) shots.push({ pid: p.pid, ...ph });
    }
    const creq = fr.criticRequest(fit, shots);
    criticInput = inputWorst(creq, "critic");
    creq.maxTokens = ceiling(criticInput, fr.CRITIC_MAX_TOKENS);
    if (creq.maxTokens < fr.MIN_OUT_TOKENS) {
      rounds.push({ round, fit: summary(fit), costUSD: answer.costUSD, error: "no budget left for the critic" });
      return skip(`round ${round}: the critic call could cost up to $${worst(creq, "critic").toFixed(3)} and $${spent.toFixed(3)} of the $${budgetUSD} budget is spent`);
    }
    let crit;
    try { crit = await deps.call(creq); } catch (e) {
      spent += e && Number.isFinite(e.costUSD) ? e.costUSD : worst(creq, "critic");
      rounds.push({ round, fit: summary(fit), error: `critic: ${String(e && e.message).slice(0, 160)}`, costUSD: answer.costUSD + ((e && e.costUSD) || 0) });
      return skip(`the critic call failed: ${String(e && e.message).slice(0, 160)}`);
    }
    spent += crit.costUSD;
    cached.critic = crit.cachedTokens || 0;
    const verdict = fr.readCriticAnswer(crit.json);
    if (verdict.ok && deps.remember) { try { await deps.remember(verdict.seen, fit.pieces); } catch (e) { log(`fit: the photo notes were not saved (${String(e && e.message).slice(0, 80)})`); } }
    const entry = { round, fit: summary(fit), costUSD: answer.costUSD + crit.costUSD };
    if (!verdict.ok) {
      rounds.push({ ...entry, error: verdict.reason });
      return skip(`the critic's answer was unreadable: ${verdict.reason}`);
    }
    rounds.push({ ...entry, scores: verdict.scores, min: verdict.min, reasons: verdict.reasons, seen: verdict.seen, fix: verdict.fix });
    log(`fit round ${round}: ${fit.theme} — colour ${verdict.scores.colour}, formality ${verdict.scores.formality}, theme ${verdict.scores.theme}, caption ${verdict.scores.caption}${verdict.pass ? " — PASS" : ` — rebuild: ${verdict.fix}`}`);
    if (verdict.pass) return { ok: true, fit, verdict, rounds, costUSD: spent };
    for (const pid of verdict.replace) if (pid !== offer.heroPid && fit.pieces.some((p) => p.pid === pid)) banned.add(pid);
    feedback.push(fr.feedbackLine(fit, { verdict }));
  }
  return skip(`no fit scored ${fr.PASS_SCORE}+ on all four after ${fr.MAX_ROUNDS} rounds`);
}

/**
 * Score a fit that was NOT built here (a post already on the feed), on the
 * same critic call: the "before" score. Returns { verdict, costUSD }.
 */
async function scoreFit(fit, deps) {
  const shots = [];
  for (const p of fit.pieces) {
    const ph = await deps.photo(p).catch(() => null);
    if (ph) shots.push({ pid: p.pid, ...ph });
  }
  const r = await deps.call(fr.criticRequest(fit, shots));
  return { verdict: fr.readCriticAnswer(r.json), costUSD: r.costUSD };
}

/** The critic's photo of a piece: its shop photo, CRITIC_PHOTO_PX on the long side, JPEG. */
function makePhotoReader(fetchImage) {
  return async function photo(piece) {
    if (!piece.photoUrl) return null;
    const sharp = require("sharp");
    const img = await fetchImage(piece.photoUrl);
    const jpg = await sharp(img.buffer).resize(fr.CRITIC_PHOTO_PX, fr.CRITIC_PHOTO_PX, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
    return { base64: jpg.toString("base64"), mediaType: "image/jpeg" };
  };
}

/** What a post records about its fit: the formula, final scores, every round. Pure. */
function criticRecord(result) {
  const r = result || {};
  const last = (r.rounds || []).filter((x) => x.scores).slice(-1)[0] || null;
  return {
    model: fr.FIT_MODEL,
    passed: Boolean(r.ok),
    rounds: (r.rounds || []).length,
    costUSD: +Number(r.costUSD || 0).toFixed(5),
    scores: last ? last.scores : null,
    reasons: last ? last.reasons : null,
    history: (r.rounds || []).map((x) => ({
      round: x.round, theme: (x.fit && x.fit.theme) || null, pids: (x.fit && x.fit.pids) || [],
      scores: x.scores || null, problems: x.problems ? x.problems.slice(0, 6) : null,
      fix: x.fix ? x.fix.slice(0, 300) : null, error: x.error || null, costUSD: +Number(x.costUSD || 0).toFixed(5),
    })),
  };
}

module.exports = { makeOpusCall, buildFit, scoreFit, makePhotoReader, criticRecord };
