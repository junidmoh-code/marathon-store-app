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
import { swapOnlineOrderLine, afterSwap } from "../../lib/swap-line.mjs";
import { money } from "../../online/agent/run.mjs";
import { rands } from "../../online/agent/core.mjs";
import { linesOf } from "./orderModel.mjs";

export const SWAP_REQUEST = Object.freeze({ PENDING: "pending", APPLYING: "applying", APPLIED: "applied", REFUSED: "refused", CANCELLED: "cancelled" });
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
      // The clean-up again (idempotent): old hub order / strip entry, return
      // to shelf, holds — whatever the crash left undone.
      const o = already.resolution?.outcome || {};
      const fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
      const to = `${already.title || already.pid}${already.size && already.size !== "_" ? ` ${already.size}` : ""}`;
      const done = await afterSwap({ db: ctx.db, orderKey: id, i: Number(req.lineIndex), order: fresh || order, swappedFrom: already.swappedFrom, to, newPid: already.pid, newSizeKey: already.sizeKey, by: clean(req.by) || null, via: "pos", now: ctx.now, inc: ctx.increment, route: already.source });
      out = { ok: true, resumed: true, summary: `${orderLabel(order)} updated: ${already.swappedFrom.title || already.swappedFrom.pid} → ${to} (resumed)`, creditCents: Number(o.creditCents) || 0, extraCents: Number(o.extraCents) || 0, returns: done.returns };
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
        // The line may already be swapped (a failure in the clean-up after it):
        // never call that "refused" — the request stays claimed and the next
        // tick past STUCK_APPLY_MS resumes it above.
        const stamped = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}/lines/${Number(req.lineIndex)}/swappedFrom/requestId`).catch(() => null);
        if (stamped === rid) { ctx.log(`  ✗ ${orderLabel(order)}: swap landed but its clean-up failed (${String(e?.message || e)}) — resumed on a later tick`); continue; }
        out = { ok: false, refused: `the swap failed: ${String(e?.message || e).slice(0, 200)}` };
      }
    }
    if (!out.ok && out.moneyBusy) {
      // A payment for the line being made this very minute: NOT a refusal (money never blocks packing, Junid 15 Nov
      // 2026). The request goes back to pending and is applied on a later tick; the packer sees "Replacing…".
      await ctx.db.ref(path).update({ state: SWAP_REQUEST.PENDING, claimedAt: null, retriedAt: ctx.now });
      ctx.log(`  … ${orderLabel(order)} line ${Number(req.lineIndex) + 1}: POS swap waits a tick (money in flight)`);
      continue;
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
    await settleDifference(ctx, id, { ...req, id: rid }, out);
    await mailLineMoneyChanges(ctx, id, await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`).catch(() => null)).catch((e) => ctx.log(`  ✗ ${orderLabel(order)}: money email check failed (${String(e?.message || e)}); retried next tick`));
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
    // Once per request, whatever a resume does.
    const mark = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/swapRequests/${req.id || ""}/collectMailedAt`).transaction((cur) => (cur == null ? ctx.now : undefined));
    if (req.id && !mark.committed) return;
    await tell(`Website order ${order.ref}: the customer agreed to pay ${rands(out.extraCents)} more — collect it`, [
      `${out.summary}`,
      `Swapped at the POS by ${who}. The new item costs ${rands(out.extraCents)} more than what was paid; the customer agreed to pay the difference.`,
      "Nothing was charged from the POS — please collect it (payment link or EFT).",
    ]);
  }
}

// ── Money after a swap, told to Junid by email — never on the packing screen (Junid, 15 Nov 2026) ───────────────────
// A swap VOIDS an unsettled credit/refund task (core.mjs swapResolution → resolution.moneyVoided) and may find a credit
// already given is now too big (resolution.owedToUs). Each is emailed to Junid ONCE, here, for every swap path (the POS,
// Jamie's CLI, the agent): the poller's keep pass calls this for every open order. Nothing here blocks anything.
// A pending request Junid never saw, or a definite refusal, moved nothing and was never his to do: no email (review of #909, 4).
const voidNeedsMail = (v) => v.state !== "pending" && !(v.state === "failed" && v.ambiguous === false);
export async function mailLineMoneyChanges(ctx, id, order) {
  if (!order) return 0;
  let sent = 0;
  const ref = orderLabel(order);
  const num = order.orderNumber || String(order.shopifyName || "").replace(/\D/g, "") || id;
  const lines = linesOf(order);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const res = l?.resolution;
    if (!res || typeof res !== "object") continue;
    const base = `${ONLINE_ORDERS_PATH}/${id}/lines/${i}/resolution`;
    for (const [k, v] of Object.entries(res.moneyVoided || {})) {
      if (!v || typeof v !== "object" || v.mailedAt || v.state === "done" || !voidNeedsMail(v)) continue;
      const amt = Math.max(0, Math.round(Number(v.amountCents) || 0));
      if (!amt) continue;
      if (!ctx.send) { ctx.log(`  ⚠ ${ref}: cancelled ${rands(amt)} ${v.kind || "money"} task NOT emailed (no mail sender); retried next tick`); continue; }
      // Claimed once (a crash or a second poller never mails twice).
      const claim = await ctx.db.ref(`${base}/moneyVoided/${k}/mailedAt`).transaction((cur) => (cur == null ? ctx.now : undefined));
      if (!claim.committed) continue;
      const nowMoney = res.money && typeof res.money === "object" ? ` A new ${rands(res.money.amountCents)} ${res.money.kind || "credit"} task replaces it (you get its own email).` : " Nothing is owed to the customer for this line now.";
      const mayHaveGone = v.state === "manual"
        ? `If you ALREADY did it in Shopify, tell Jamie "money #${num} went": it is then recorded and anything too much is recorded as owed back to us.`
        : `It may or may not have gone through (${v.state}): check Shopify. If it went, tell Jamie "money #${num} went".`;
      try {
        await ctx.send({ subject: `Website order ${ref}: CANCEL the ${rands(amt)} ${v.kind || "money"} — not needed any more`, text: [
          `Line ${i + 1}: the customer's item changed (now ${l.title || l.pid}${l.size && l.size !== "_" ? ` size ${l.size}` : ""}, ${rands((Number(l.unitPriceCents) || 0) * (Number(l.qty) || 1))}).`,
          `The ${rands(amt)} ${v.kind || "money"} task (${v.why || "swap difference"}) is cancelled: do NOT do it.${nowMoney}`,
          mayHaveGone,
          "Packing was never held up by this.",
        ].join("\n") });
        sent++;
      } catch (e) {
        await ctx.db.ref(`${base}/moneyVoided/${k}/mailedAt`).set(null).catch(() => {});
        ctx.log(`  ✗ ${ref}: cancelled-task email failed (${String(e?.message || e)}); retried next tick`);
      }
    }
    const owed = res.owedToUs;
    const owedCents = owed && typeof owed === "object" ? Math.max(0, Math.round(Number(owed.amountCents) || 0)) : 0;
    if (owedCents > 0 && Number(res.owedToUsMailedCents) !== owedCents) {
      if (!ctx.send) { ctx.log(`  ⚠ ${ref}: ${rands(owedCents)} owed back to us NOT emailed (no mail sender); retried next tick`); continue; }
      const claim = await ctx.db.ref(`${base}/owedToUsMailedCents`).transaction((cur) => (Number(cur) === owedCents ? undefined : owedCents));
      if (!claim.committed) continue;
      try {
        await ctx.send({ subject: `Website order ${ref}: ${rands(owedCents)} owed back to us (store credit given is too much now)`, text: [
          `Line ${i + 1}: now ${l.title || l.pid}${l.size && l.size !== "_" ? ` size ${l.size}` : ""}, ${rands((Number(l.unitPriceCents) || 0) * (Number(l.qty) || 1))}.`,
          `Store credit already given for this line is ${rands(owedCents)} more than the price difference now (credit = paid − what ships).`,
          "Recorded on the order as owed back to us. The order packs as normal; how to recover it is your call.",
        ].join("\n") });
        sent++;
      } catch (e) {
        await ctx.db.ref(`${base}/owedToUsMailedCents`).set(null).catch(() => {});
        ctx.log(`  ✗ ${ref}: owed-back email failed (${String(e?.message || e)}); retried next tick`);
      }
    }
  }
  return sent;
}
