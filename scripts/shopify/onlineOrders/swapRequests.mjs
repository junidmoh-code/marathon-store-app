// ── The POS "Replace" button, applied on the Mac mini ───────────────────────
// The till cannot raise a hub order (the three-letter code registry is
// server-only) or close a Display Checks entry (callable-only), so the POS
// writes what the packer chose and the poller applies it, in its keep pass,
// through THE swap (scripts/lib/swap-line.mjs) — the function Jimmy uses:
//
//   /online_orders/{id}/swapRequests/{rid} =
//     { lineIndex, pid, size, expectPid, expectSizeKey, priceDecision?, by: {uid, name}, at,
//       state: "pending" }                                         ← the POS
//     → state "applied" { summary, appliedAt, creditCents, extraCents }   ← here
//     → state "refused" { why, refusedAt }
//
// Money (owner spec 2026-10-24): nothing is charged or credited from the POS.
//   cheaper → the difference is owed to the customer: the agent's own money()
//             slot, with no Shopify scope → "manual", and Junid is emailed the
//             exact amount (the same email the agent sends);
//   dearer  → only with the packer's second tap: "customer_pays" (Junid is
//             emailed what to collect) or "we_absorb" (recorded, no email).
// The pack (POS) refuses while any request is pending.
import { ONLINE_ORDERS_PATH, orderLabel } from "../../../src/utils/onlineOrders.js";
import { swapOnlineOrderLine } from "../../lib/swap-line.mjs";
import { money } from "../../online/agent/run.mjs";
import { rands } from "../../online/agent/core.mjs";
import { linesOf } from "./orderModel.mjs";

export const SWAP_REQUEST = Object.freeze({ PENDING: "pending", APPLYING: "applying", APPLIED: "applied", REFUSED: "refused" });
// A claim with no outcome this long (a crash mid-swap) is decided again: the
// swap's own guard (`expect`) refuses a line that already changed.
export const STUCK_APPLY_MS = 5 * 60 * 1000;

const clean = (v) => JSON.parse(JSON.stringify(v ?? null));

/** Apply every pending POS swap on this order. → true when anything was applied. */
export async function applySwapRequests(ctx, id, order) {
  const reqs = Object.entries(order?.swapRequests || {})
    .filter(([, r]) => r && (r.state === SWAP_REQUEST.PENDING || (r.state === SWAP_REQUEST.APPLYING && ctx.now - Number(r.claimedAt) >= STUCK_APPLY_MS)))
    .sort((a, b) => Number(a[1].at) - Number(b[1].at));
  let applied = false;
  for (const [rid, req] of reqs) {
    const path = `${ONLINE_ORDERS_PATH}/${id}/swapRequests/${rid}`;
    const claim = await ctx.db.ref(path).transaction((cur) => {
      if (cur == null) return null;
      const stuck = cur.state === SWAP_REQUEST.APPLYING && ctx.now - Number(cur.claimedAt) >= STUCK_APPLY_MS;
      if (cur.state !== SWAP_REQUEST.PENDING && !stuck) return undefined;
      return { ...cur, state: SWAP_REQUEST.APPLYING, claimedAt: ctx.now };
    });
    if (!claim.committed || !claim.snapshot.val()) continue;
    let out;
    // RESUME: a crash after the swap landed but before this request said so.
    // The line carries the request id the swap stamped on it — that swap was
    // THIS request: finish it (the money step is idempotent), never refuse it.
    const already = req.state === SWAP_REQUEST.APPLYING ? await ctx.get(`${ONLINE_ORDERS_PATH}/${id}/lines/${Number(req.lineIndex)}`) : null;
    if (already?.swappedFrom?.requestId === rid) {
      const o = already.resolution?.outcome || {};
      out = { ok: true, resumed: true, summary: `${orderLabel(order)} updated: ${already.swappedFrom.title || already.swappedFrom.pid} → ${already.title || already.pid} (resumed)`, creditCents: Number(o.creditCents) || 0, extraCents: Number(o.extraCents) || 0, returns: [] };
    } else {
      try {
        out = await swapOnlineOrderLine({
          db: ctx.db, orderKey: id, lineIndex: Number(req.lineIndex), newPid: String(req.pid || ""), size: req.size ?? "_",
          priceDecision: req.priceDecision || null, by: clean(req.by) || null, via: "pos", requestId: rid,
          expect: { pid: req.expectPid ?? null, sizeKey: req.expectSizeKey ?? null },
          now: ctx.now, increment: ctx.increment, log: (m) => ctx.log(`  ${m}`),
          displayFeedOn: ctx.displayFeedEnabled ? async (shop) => (await ctx.displayFeedEnabled(shop)) !== false : null,
        });
      } catch (e) {
        out = { ok: false, refused: `the swap failed: ${String(e?.message || e).slice(0, 200)}` };
      }
    }
    if (!out.ok) {
      await ctx.db.ref(path).update({ state: SWAP_REQUEST.REFUSED, why: String(out.refused || out.summary || "refused").slice(0, 400), refusedAt: ctx.now });
      ctx.log(`  ✗ ${orderLabel(order)} line ${Number(req.lineIndex) + 1}: POS swap refused — ${out.refused}`);
      continue;
    }
    applied = true;
    ctx.summary.swaps = (ctx.summary.swaps || 0) + 1;
    // The difference BEFORE the request says applied: a crash in between
    // resumes above and settles again (money() finds its own slot).
    await settleDifference(ctx, id, req, out);
    await ctx.db.ref(path).update(clean({ state: SWAP_REQUEST.APPLIED, summary: out.summary, appliedAt: ctx.now, creditCents: out.creditCents || 0, extraCents: out.extraCents || 0, returns: out.returns?.length || 0 }));
  }
  return applied;
}

// The price difference, after the swap landed (never before: a refused swap owes nothing).
async function settleDifference(ctx, id, req, out) {
  const i = Number(req.lineIndex);
  const fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
  if (!fresh) return;
  const order = { ...fresh, ref: orderLabel(fresh) };
  const line = linesOf(fresh)[i];
  const who = req.by?.name || "the packer";
  const tell = async (subject, lines) => {
    if (!ctx.send) { ctx.log(`  ⚠ ${order.ref}: Junid NOT emailed (no mail sender on this machine): ${subject}`); return; }
    try { await ctx.send({ subject, text: lines.join("\n") }); }
    catch (e) { ctx.log(`  ✗ ${order.ref}: Junid not emailed (${String(e?.message || e)}): ${subject}`); }
  };
  if (out.creditCents > 0) {
    // THE AGENT'S MONEY PATH, with no Shopify scope: one money slot on the line
    // (credit, never twice, never more than paid), state "manual", and the
    // agent's own "PLEASE DO THIS BY HAND" email to Junid. No credit moves here.
    const agentCtx = {
      db: ctx.db, get: ctx.get, now: ctx.now, log: ctx.log,
      summary: { credits: 0, refunds: 0, junid: 0 },
      scopes: async () => new Set(),
      notifyJunid: async (m) => tell(m.subject, [m.text, "", `Swapped at the POS by ${who}: ${out.summary}`]),
    };
    const slot = await money(agentCtx, id, order, i, line, "credit", out.creditCents, `swap difference — swapped at the POS by ${who}`);
    // The line's one money slot was already used (an earlier credit): the
    // guard refused a second one — Junid still has to hear what is owed.
    if (!slot) await tell(`Website order ${order.ref}: ${rands(out.creditCents)} owed to the customer — NOT recorded (the line already has a money action)`, [out.summary, `Swapped at the POS by ${who}. Check the order and settle the difference by hand.`]);
    return;
  }
  if (out.extraCents > 0 && req.priceDecision === "customer_pays") {
    await tell(`Website order ${order.ref}: the customer agreed to pay ${rands(out.extraCents)} more — collect it`, [
      `${out.summary}`,
      `Swapped at the POS by ${who}. The new item costs ${rands(out.extraCents)} more than what was paid; the customer agreed to pay the difference.`,
      "Nothing was charged from the POS — please collect it (payment link or EFT).",
    ]);
  }
}
