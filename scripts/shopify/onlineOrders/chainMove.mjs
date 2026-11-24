// ── A REJECTION MOVES THE LINE ON AT ONCE (Junid, 24 Nov 2026) ───────────────
// "The moment a hub marks a website pick Out of Stock, a shop presses Not
// found, or the packer presses Not here, route the line to the next place on
// its chain that shows the size, in the same transaction or tick, not on the
// order agent's next round. Only when every place on the chain including
// Central has rejected or shows nothing does the line go to Jamie."
//
// BUILT ON THE AGENT RE-PICK (agentRepick.mjs). This module only RAISES the
// request the order agent used to raise up to 15 minutes later:
//
//   /online_orders/{id}/agentRepicks/chain_{lineIndex}_{routeGen} =
//       { lineIndex, expectPid, expectSizeKey, expectStatus, expectRouteGen,
//         exclude: [every place that already failed this line], by: "chain", at, state: "pending" }
//
// The same tick then applies it with applyAgentRepicks — the same blockers
// (the customer is being asked, money is on the line, part is in the basket,
// the order is being packed), the same one-transaction move, the same restart
// safety — and the keep pass raises the new pick: a hub order with its
// three-letter code at a hub, a strip entry at a shop or at Central. The hold
// (/online_reservations `locs`) follows the line to that ONE place; the place
// it left holds nothing for this order.
//
// WHEN THE CHAIN RUNS OUT the line is stamped
//       lines/{i}/chain = { gen, at, result: "nowhere" | "blocked", why }
// which is what Jamie waits for before offering alternatives
// (marathon-dm-agent src/jimmy/chainFirst.js). Nothing here raises a stock or
// refill request, moves stock or reads a policy.
import { ONLINE_ORDERS_PATH, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import { REPICK, REPICK_PATH, CHAIN_BY, describeRepickChecked } from "./agentRepick.mjs";

export const CHAIN_CONFIG_PATH = "config/onlineOrders/routing";
// A rejection older than this is not picked up by itself (it is a person's or Jamie's by now).
export const CHAIN_MAX_AGE_MS = 24 * 3600e3;
const PACKER_REASONS = new Set(["not_here", "damaged"]);

export const chainKey = (i, gen) => `chain_${i}_${Number(gen) || 0}`;

/**
 * Did a place just reject this line? PURE.
 * → null | { status, loc, failedAt, exclude: [loc…] }
 */
export function chainCandidate(line, nowMs) {
  const src = line?.source;
  if (!line?.pid || !line.sizeKey || !src) return null;
  const failed = line.failedPlaces && typeof line.failedPlaces === "object" ? Object.keys(line.failedPlaces) : [];
  const fresh = (at) => Number.isFinite(Number(at)) && Number(at) > 0 && nowMs - Number(at) >= 0 && nowMs - Number(at) <= CHAIN_MAX_AGE_MS;
  if ((src.status === LINE_STATUS.NOT_FOUND || src.status === LINE_STATUS.NO_STOCK) && src.locationId) {
    if (!fresh(src.failedAt)) return null;
    return { status: src.status, loc: src.locationId, failedAt: Number(src.failedAt), exclude: [...new Set([...failed, src.locationId])] };
  }
  // The packer's Not here / Damaged (the POS's own record on the line), never a line Jamie parked.
  if (src.status === LINE_STATUS.UNAVAILABLE && src.by !== "jamie" && PACKER_REASONS.has(line.unavailable?.reason)) {
    if (!fresh(line.unavailable.at)) return null;
    const from = line.unavailable.fromSource?.locationId || null;
    // Not here: the place that sent it is skipped. Damaged: that place HAD it; another piece there may be fine.
    const skip = line.unavailable.reason === "not_here" && from ? [from] : [];
    return { status: src.status, loc: from, failedAt: Number(line.unavailable.at), exclude: [...new Set([...failed, ...skip])] };
  }
  return null;
}

/**
 * Raise a chain move for every line a place just rejected and that has none
 * for this route generation yet; stamp the lines whose chain has run out.
 * → true when a request was raised (the caller applies it in this tick).
 */
export async function raiseChainMoves(ctx, id, order) {
  if (!ctx.enabled || ctx.chainOff === true) return false;
  if (ctx.chainOff === undefined) {
    try { ctx.chainOff = (await ctx.get(`${CHAIN_CONFIG_PATH}/chainOff`)) === true; } catch { ctx.chainOff = false; }
    if (ctx.chainOff) return false;
  }
  if (!order || order.packClaim || order.pack) return false;
  const reqs = order[REPICK_PATH] && typeof order[REPICK_PATH] === "object" ? order[REPICK_PATH] : {};
  let raised = false;
  const lines = linesOf(order);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cand = chainCandidate(line, ctx.now);
    if (!cand) continue;
    const gen = Number(line.routeGen) || 0;
    const rid = chainKey(i, gen);
    if (reqs[rid]) continue;
    const req = {
      lineIndex: i, expectPid: String(line.pid), expectSizeKey: String(line.sizeKey), expectStatus: cand.status, expectRouteGen: gen,
      exclude: cand.exclude, by: CHAIN_BY, at: ctx.now, state: REPICK.PENDING,
      evidence: { failed: { at: cand.loc, since: cand.failedAt }, why: "a place rejected the line: next place on its chain" },
    };
    const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/${REPICK_PATH}/${rid}`).transaction((cur) => (cur == null ? req : undefined));
    if (res.committed) { raised = true; ctx.log?.(`  → ${orderLabel(order)} line ${i + 1}: rejected at ${cand.loc || "the packer"} — asking the next place on its chain (skipping ${cand.exclude.join(", ") || "nothing"})`); }
  }
  return raised;
}

/**
 * After the requests were applied: a chain move that found nowhere (or was
 * blocked) stamps its line, once per route generation. → number stamped.
 */
export async function stampChainResults(ctx, id, order) {
  const reqs = order?.[REPICK_PATH] && typeof order[REPICK_PATH] === "object" ? order[REPICK_PATH] : {};
  const lines = linesOf(order);
  let n = 0;
  for (const [rid, req] of Object.entries(reqs)) {
    if (!req || req.by !== CHAIN_BY || (req.state !== REPICK.NOT_IN_STOCK && req.state !== REPICK.REFUSED)) continue;
    const i = Number(req.lineIndex);
    const line = lines[i];
    const gen = Number(req.expectRouteGen) || 0;
    if (!line || (Number(line.routeGen) || 0) !== gen || rid !== chainKey(i, gen) || Number(line.chain?.gen) === gen && line.chain?.rid === rid) continue;
    const nowhere = req.state === REPICK.NOT_IN_STOCK;
    const stamp = { gen, rid, at: ctx.now, result: nowhere ? "nowhere" : "blocked", why: nowhere ? `no place left on the chain shows it (${describeRepickChecked(req.checked)})` : String(req.why || "the line could not be moved") };
    const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}`).transaction((cur) => {
      if (cur == null) return null;
      if ((Number(cur.routeGen) || 0) !== gen || (cur.chain && cur.chain.rid === rid)) return undefined;
      return { ...cur, chain: stamp };
    });
    if (res.committed && res.snapshot.val()) { n += 1; ctx.log?.(`  ∎ ${orderLabel(order)} line ${i + 1}: chain ${stamp.result} — ${stamp.why}${nowhere ? "; over to Jamie for alternatives" : ""}`); }
  }
  return n;
}
