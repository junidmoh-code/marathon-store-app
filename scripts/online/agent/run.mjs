// ── One tick of the customer agent ──────────────────────────────────────────
// Everything is injected (db, Shopify, mail, WhatsApp, the model, the inbox,
// the clock) so the whole tick runs against fakes in tests. The code decides
// every action (core.mjs); the model only writes a greeting and a sign-off,
// and classifies a free-text reply that the code could not read.
//
// Per unavailable line (from /online_escalations):
//   no conversation  → find alternatives, open ONE conversation, send the offer
//   offering         → read replies: pick N → swap (cheaper/equal: the
//                      difference as store credit; dearer: refused, re-offered),
//                      "credit" → store credit, "refund" → refund; nothing for
//                      48 h → store credit automatically, refund still open 14 days
//   credited_window  → a "refund" within 14 days → Junid swaps it by hand
//                      (never both a credit and a refund from the code)
// Every action: logged on the line (resolution/log) and to the log file.
// Every credit or refund: Junid is emailed at once.
import { ONLINE_ORDERS_PATH, LINE_STATUS, ORDER_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { stockSizeKey } from "../../../src/utils/sizeKey.js";
import { ESCALATIONS_PATH, followUpId, followUpRecord } from "../../shopify/onlineOrders/escalate.mjs";
import { linesOf } from "../../shopify/onlineOrders/orderModel.mjs";
import {
  MAX_OUTBOUND, NO_REPLY_MS, REFUND_WINDOW_MS, paidCents, rands, parseReplyCode, validateClassification,
  canSend, moneyAllowed, judgeSwap, swapResolution, lineLedger, acceptModelText, fallbackWords, composeMessage, subjectTag, whatsappText,
} from "./core.mjs";
import { CREDIT_SCOPE, REFUND_SCOPE, issueStoreCredit, refundLine, slotRefundKey } from "./money.mjs";
import { swappedLine, swapFromRecord } from "../../lib/swap-line.mjs";

export const AGENT_META = "online_orders_meta/customerAgent";
const AGENT_STATUSES = new Set(["new", "picking", "ready", "needs_attention", "packed"]);
export const STUCK_CLAIM_MS = 10 * 60 * 1000;
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));

export async function runCustomerAgent(deps) {
  const { db, log = () => {} } = deps;
  const get = async (path) => (await db.ref(path).get()).val();
  const now = await deps.nowMs();
  const ctx = { ...deps, get, now, log, summary: { opened: 0, sent: 0, replies: 0, swaps: 0, credits: 0, refunds: 0, junid: 0, errors: [] } };
  // Junid's brake: /config/onlineOrders/agentOff true → the agent does nothing.
  if ((await get("config/onlineOrders/agentOff")) === true) { ctx.summary.off = true; return ctx.summary; }
  const reg = (await get(ESCALATIONS_PATH)) || {};
  for (const [key, row] of Object.entries(reg)) {
    if (!row || typeof row !== "object") continue;
    // needs_junid: handed to Junid — listed in Settings until he resolves it
    // by hand (the escalation's own mirror then removes the row).
    if (row.agent?.state === "needs_junid") continue;
    const open = row.phase === "unavailable" || (row.agent && row.agent.state && row.agent.state !== "closed");
    if (!open) continue;
    try {
      await handleLine(ctx, key, row);
    } catch (e) {
      ctx.summary.errors.push(`${row.ref ?? key}: ${String(e?.message || e)}`);
      log(`✗ ${row.ref ?? key}: ${String(e?.message || e)}`);
    }
  }
  return ctx.summary;
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function lineTxn(ctx, orderId, i, fn) {
  const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/lines/${i}`).transaction((cur) => {
    if (cur == null) return null;
    const out = fn(cur);
    return out === undefined ? undefined : clean(out);
  });
  return res.committed ? res.snapshot.val() : null;
}

async function record(ctx, orderId, i, ref, action, detail = {}) {
  const entry = clean({ at: ctx.now, action, ...detail });
  await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/lines/${i}/resolution/log`).push().set(entry);
  const day = new Date(ctx.now + 2 * 3600e3).toISOString().slice(0, 10);
  await ctx.db.ref(`${AGENT_META}/days/${day}`).push().set(clean({ ref, orderId, lineIndex: i, ...entry }));
  ctx.log(`${ref} line ${i + 1}: ${action}${detail.note ? ` — ${detail.note}` : ""}`);
}

async function setAgentRow(ctx, key, agent) {
  if (agent === null) { await ctx.db.ref(`${ESCALATIONS_PATH}/${key}`).set(null); return; }
  await ctx.db.ref(`${ESCALATIONS_PATH}/${key}/agent`).update(clean({ ...agent, updatedAt: ctx.now }));
}

async function tellJunid(ctx, subject, lines) {
  ctx.summary.junid++;
  try { await ctx.notifyJunid({ subject, text: lines.join("\n") }); }
  catch (e) { ctx.log(`✗ Junid not emailed (${String(e?.message || e)}): ${subject}`); }
}

const firstName = (order) => String(order.customer?.name || "").trim().split(/\s+/)[0] || null;

// ── one line ────────────────────────────────────────────────────────────────
async function handleLine(ctx, key, row) {
  const orderId = row.orderId;
  const i = Number(row.lineIndex);
  if (typeof orderId !== "string" || !Number.isInteger(i)) return;
  const raw = await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}`);
  // Every message and log names the order by its Shopify number ("#1768");
  // `ref` here is display-only (nothing below writes it back as an identifier).
  const order = raw ? { ...raw, ref: orderLabel(raw) } : null;
  const line = order ? linesOf(order)[i] : null;
  if (!order || !line) { await setAgentRow(ctx, key, null); return; }
  // Only an order still open (or packed, for its leftover lines) is the
  // agent's: cancelled, rung by hand, closed → nothing more goes to anyone.
  // An order CLOSED by settling its last line still owes the customer their
  // 14-day "refund instead" window (Sonnet final review).
  const windowOpen = order.status === "closed" && line.resolution?.conversation?.state === "credited_window";
  if ((!AGENT_STATUSES.has(order.status) && !windowOpen) || order.cancelledAfterPack) { await setAgentRow(ctx, key, null); return; }
  const conv = line.resolution?.conversation;
  if (!conv) {
    if (line.source?.status !== LINE_STATUS.UNAVAILABLE) return;
    await openConversation(ctx, key, orderId, order, i, line);
    return;
  }
  if (line.source?.status === LINE_STATUS.RESOLVED && line.escalation?.phase === "resolved" && !line.resolution?.money && conv.state !== "closed") {
    // Junid: "resolved by hand" — the agent stops and says nothing more.
    await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, state: "closed", closedAt: ctx.now, closedBy: "junid" } } }));
    await record(ctx, orderId, i, order.ref, "closed", { note: "resolved by hand" });
    await setAgentRow(ctx, key, null);
    return;
  }
  // ONE CONVERSATION PER LINE: a swapped item that later became unavailable
  // too is Junid's — the customer is never opened a second conversation.
  // A swap whose difference credit (or its message) never happened — a crash
  // between the swap and the money (Sonnet review, PR #778): finish it.
  const out = line.resolution?.outcome;
  // Only the agent's own swap (never a CLI, POS or Jamie swap: their money waits for Junid; Sonnet review of #848, 4), only
  // on the line it swapped (never a follow-up that copies its outcome: 3), and money only for its own pre-claim (the swap
  // wrote it with the line); a credit with no pre-claim is Junid's.
  const ownSwap = out?.kind === "swap" && out.via === "agent" && !order.followUpOf;
  if (ownSwap && conv.state === "closed" && !Object.values(conv.sends || {}).some((x) => x?.kind === "swapped")) {
    const pm = line.resolution?.money;
    const preclaimed = !!pm && typeof pm === "object" && pm.preclaimed === true && Number(pm.at) === Number(out.at) && pm.kind === "credit";
    const settledAlready = Object.values(line.resolution?.moneySettled || {}).some((x) => x && x.kind === "credit" && Number(x.at) === Number(out.at));
    if (out.creditCents > 0 && !preclaimed && !settledAlready && !(pm && pm.at && Number(pm.at) === Number(out.at))) await tellJunid(ctx, `Website order ${order.ref}: a swap's ${rands(out.creditCents)} credit has no record of being filed`, [`Line: ${line.title}. The customer is told of the swap only; please check Shopify and credit it by hand if it is owed.`]);
    const diff = out.creditCents > 0 && preclaimed ? await money(ctx, orderId, order, i, line, "credit", out.creditCents, "swap difference") : out.creditCents > 0 && (settledAlready || (pm && Number(pm.at) === Number(out.at))) ? (settledAlready ? { state: "done" } : pm) : null;
    // A packed order's follow-up mirror is brought in line with the parent's result too (CodeRabbit on #848).
    if (out.creditCents > 0 && (line.source?.movedTo || out.movedTo)) await syncMirror(ctx, orderId, i, { claimAt: Number(out.at), creditCents: out.creditCents, diff });
    // A pre-claim met again is NOT proof the credit was filed (CodeRabbit on #848): the customer hears the amount only when
    // money() filed it (done, or with Junid by hand); an unresolved claim is Junid's (told at once) and they hear the swap.
    await send(ctx, orderId, order, i, line, "swapped", creditWords(diff, out.creditCents));
    await setAgentRow(ctx, key, null);
    return;
  }
  if (conv.state === "closed" && line.source?.status === LINE_STATUS.UNAVAILABLE) {
    if (!line.resolution?.secondUnavailableMailedAt) {
      await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, secondUnavailableMailedAt: ctx.now } }));
      await tellJunid(ctx, `Website order ${order.ref}: the swapped item is unavailable too`, [
        `${line.title}${line.size ? ` size ${line.size}` : ""} ×${line.qty} (swapped from ${line.swappedFrom?.title || "the original"}) could not be found either.`,
        `The agent has already had its one conversation with ${order.customer?.email || "the customer"}. Please contact them by hand.`,
      ]);
      await record(ctx, orderId, i, order.ref, "second_unavailable", { note: "Junid emailed; no second conversation" });
    }
    await setAgentRow(ctx, key, { state: "needs_junid" }); // stays listed until Junid resolves it
    return;
  }
  await retryUnsent(ctx, orderId, order, i, line);
  if (conv.state === "offering") return offering(ctx, key, orderId, order, i, line);
  if (conv.state === "credited_window") return creditedWindow(ctx, key, orderId, order, i, line);
  if (conv.state === "no_contact" || conv.state === "with_junid") await setAgentRow(ctx, key, { state: "needs_junid" });
  else if (conv.state === "closed") await setAgentRow(ctx, key, null);
}

async function openConversation(ctx, key, orderId, order, i, line) {
  const email = order.customer?.email || null;
  const phone = order.customer?.phone || null;
  const tag = subjectTag(order.ref, line);
  if (!email) {
    const made = await lineTxn(ctx, orderId, i, (cur) => (cur.resolution?.conversation ? undefined : { ...cur, resolution: { ...(cur.resolution || {}), conversation: { state: "no_contact", startedAt: ctx.now, tag, outbound: 0 } } }));
    if (!made) return;
    await record(ctx, orderId, i, order.ref, "no_contact", { note: "no email on the order" });
    await tellJunid(ctx, `Website order ${order.ref}: an unavailable item, and no email to ask the customer`, [
      `${line.title}${line.size ? ` size ${line.size}` : ""} ×${line.qty} is unavailable (the escalation chain ran out).`,
      `The order has no customer email${phone ? `; phone ${phone}` : ""}. Please contact them by hand: ${rands(paidCents(line))} paid for this line.`,
    ]);
    await setAgentRow(ctx, key, { state: "needs_junid" }); // stays listed until Junid resolves it
    return;
  }
  // The storefront listing name — never the app's product name (brands).
  let itemTitle = null;
  try { itemTitle = ctx.listingTitle ? await ctx.listingTitle(line) : null; }
  catch (e) { ctx.log(`! ${order.ref}: listing name not read (${String(e?.message || e)})`); }
  let offers = [];
  try { offers = await ctx.findAlternatives({ line, orderId }); }
  catch (e) { ctx.log(`! ${order.ref}: alternatives not found (${String(e?.message || e)}) — offering credit / refund only`); }
  // ONE CONVERSATION PER LINE: created only if absent.
  const made = await lineTxn(ctx, orderId, i, (cur) => {
    if (cur.resolution?.conversation) return undefined;
    return { ...cur, resolution: { ...(cur.resolution || {}), conversation: {
      state: "offering", startedAt: ctx.now, tag, email, phone, outbound: 0, itemTitle: itemTitle || "the item you ordered",
      offers: offers.map((o) => ({ pid: o.pid, size: o.size, sizeKey: o.sizeKey, title: o.title, url: o.url, priceCents: o.priceCents, locationId: o.locationId, status: o.status, photoUrl: o.photoUrl, category: o.category, productGid: o.productGid })),
    } } };
  });
  if (!made) return;
  ctx.summary.opened++;
  await record(ctx, orderId, i, order.ref, "opened", { note: `${offers.length} alternative(s)` });
  await setAgentRow(ctx, key, { state: "offering", outbound: 0 });
  await send(ctx, orderId, order, i, made, "offer");
}

// ── sending: a slot is reserved BEFORE the send; the cap is the code's ─────
async function send(ctx, orderId, order, i, line, kind, extra = {}) {
  let slot = null;
  const reserved = await lineTxn(ctx, orderId, i, (cur) => {
    const c = cur.resolution?.conversation;
    if (!c || !canSend(c)) return undefined;
    slot = (Number(c.outbound) || 0) + 1;
    return { ...cur, resolution: { ...cur.resolution, conversation: { ...c, outbound: slot, lastOutboundAt: ctx.now, sends: { ...(c.sends || {}), [slot]: { kind, at: ctx.now, ...(extra.amountCents != null ? { amountCents: extra.amountCents } : {}), ...(extra.pending ? { pending: true } : {}) } } } } };
  });
  if (!reserved) {
    await record(ctx, orderId, i, order.ref, "not_sent", { kind, note: `the ${MAX_OUTBOUND}-message cap is reached` });
    await tellJunid(ctx, `Website order ${order.ref}: the customer agent has used its ${MAX_OUTBOUND} messages`, [
      `It wanted to send "${kind}" about ${line.title}. Please contact ${order.customer?.name || "the customer"} (${order.customer?.email || order.customer?.phone || "no contact"}) by hand.`,
    ]);
    return false;
  }
  return deliver(ctx, orderId, order, i, reserved, slot, kind, extra);
}

async function deliver(ctx, orderId, order, i, line, slot, kind, extra) {
  const conv = line.resolution.conversation;
  const offers = Object.values(conv.offers || {});
  let words = fallbackWords(kind);
  try {
    const w = await ctx.model.words(kind, { firstName: firstName(order) });
    const opening = acceptModelText(w?.opening);
    const closing = acceptModelText(w?.closing, 200);
    if (opening && closing) words = { opening, closing };
  } catch (e) { ctx.log(`! ${order.ref}: model words failed (${String(e?.message || e)}) — the plain wording is used`); }
  // Before a swap the line still names the app's product: the customer sees
  // the LISTING name kept on the conversation. After a swap it is the
  // alternative's listing name already.
  const shown = line.swappedFrom ? line : { ...line, title: conv.itemTitle || "the item you ordered" };
  const mail = composeMessage(kind, { ref: order.ref, firstName: firstName(order), line: shown, offers, amountCents: extra.amountCents ?? null, words, pending: !!extra.pending });
  try {
    await ctx.mailer({ to: conv.email, subject: mail.subject, text: mail.text });
  } catch (e) {
    await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, sends: { ...cur.resolution.conversation.sends, [slot]: { ...cur.resolution.conversation.sends[slot], failedAt: ctx.now, tries: (Number(cur.resolution.conversation.sends[slot].tries) || 0) + 1 } } } } }));
    await record(ctx, orderId, i, order.ref, "send_failed", { kind, note: String(e?.message || e).slice(0, 200) });
    return false;
  }
  let whatsapp = false;
  if (conv.phone && ctx.whatsapp) {
    try {
      const st = await ctx.whatsapp.status();
      if (st?.connected) { await ctx.whatsapp.send(conv.phone, whatsappText(mail)); whatsapp = true; }
    } catch (e) { ctx.log(`! ${order.ref}: WhatsApp not sent (${String(e?.message || e)}) — email went`); }
  }
  await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, sends: { ...cur.resolution.conversation.sends, [slot]: { ...cur.resolution.conversation.sends[slot], sentAt: ctx.now, failedAt: null, whatsapp } } } } }));
  ctx.summary.sent++;
  await record(ctx, orderId, i, order.ref, "sent", { kind, n: slot, whatsapp, note: `${mail.subject} → ${conv.email}${whatsapp ? " + WhatsApp" : ""}` });
  return true;
}

// A reserved slot whose email failed is retried ONCE more (same slot, same kind).
async function retryUnsent(ctx, orderId, order, i, line) {
  const sends = line.resolution?.conversation?.sends || {};
  for (const [n, s] of Object.entries(sends)) {
    if (s && !s.sentAt && s.failedAt && (Number(s.tries) || 0) < 2) {
      await deliver(ctx, orderId, order, i, line, Number(n), s.kind, { amountCents: s.amountCents, pending: !!s.pending });
    }
  }
}

// ── offering: wait for a reply, or 48 h ─────────────────────────────────────
async function offering(ctx, key, orderId, order, i, line) {
  const conv = line.resolution.conversation;
  const offers = Object.values(conv.offers || {});
  const reply = await nextReply(ctx, orderId, i, conv);
  // A pick held because the line's money was unclear (review of #846, 4): tried again every run until it clears; a
  // newer reply replaces it, and it never lets the 48-hour credit run over it.
  if (!reply && conv.heldPick && Number.isInteger(Number(conv.heldPick.n))) {
    const offer = offers[Number(conv.heldPick.n) - 1];
    if (offer) return pick(ctx, key, orderId, order, i, line, offer, { held: true });
  }
  // A credit/refund answer whose settle did not finish (a failed hand-over write, a raced settle): CodeRabbit on #856. The
  // reply is already seen, so the decision kept on the line is what is tried again, every run, before the 48-hour credit
  // path can run over it.
  if (!reply && (conv.heldSettle?.kind === "credit" || conv.heldSettle?.kind === "refund")) return settle(ctx, key, orderId, order, i, line, conv.heldSettle.kind, conv.heldSettle.kind);
  if (reply && conv.heldPick) await lineTxn(ctx, orderId, i, (cur) => { const c = cur.resolution?.conversation; if (!c?.heldPick) return undefined; const { heldPick: _h, ...rest } = c; return { ...cur, resolution: { ...cur.resolution, conversation: rest } }; });
  if (reply) {
    ctx.summary.replies++;
    let decision = parseReplyCode(reply.text, offers.length);
    let via = "code";
    if (!decision) {
      via = "model";
      try { decision = validateClassification(await ctx.model.classify(reply.text, offers), offers.length); }
      catch { decision = { kind: "unclear" }; }
    }
    await record(ctx, orderId, i, order.ref, "reply", { decision: decision.kind, n: decision.n ?? null, via });
    // Kept before acting (CodeRabbit on #856): a credit/refund answer is written on the line first, so a settle that does
    // not finish is retried from it; any other answer replaces an older kept one.
    const keep = decision.kind === "credit" || decision.kind === "refund" ? { kind: decision.kind, at: ctx.now } : null;
    if (keep || conv.heldSettle) {
      const kept = await lineTxn(ctx, orderId, i, (cur) => {
        const c = cur.resolution?.conversation;
        if (!c) return undefined;
        const { heldSettle: _h, ...rest } = c;
        return { ...cur, resolution: { ...cur.resolution, conversation: keep ? { ...rest, heldSettle: keep } : rest } };
      });
      // not kept (a raced write): settled now all the same, as before; only a later failure relies on the kept answer
      void kept;
    }
    if (decision.kind === "pick") return pick(ctx, key, orderId, order, i, line, offers[decision.n - 1]);
    if (decision.kind === "credit") return settle(ctx, key, orderId, order, i, line, "credit", "credit");
    if (decision.kind === "refund") return settle(ctx, key, orderId, order, i, line, "refund", "refund");
    if (!(await send(ctx, orderId, order, i, line, "unclear"))) await setAgentRow(ctx, key, { state: "offering", needsJunid: true });
    return;
  }
  // The 48 hours run from the offer the customer actually RECEIVED. An offer
  // that never went out (both attempts failed) is Junid's, never a silent credit.
  const first = conv.sends?.[1] || (Array.isArray(conv.sends) ? conv.sends[1] : null);
  if (!first?.sentAt) {
    if (first?.failedAt && (Number(first.tries) || 0) >= 2 && !conv.undeliveredMailedAt) {
      await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, undeliveredMailedAt: ctx.now } } }));
      await tellJunid(ctx, `Website order ${order.ref}: the offer email to the customer could not be sent`, [
        `${line.title} is unavailable; the offer to ${conv.email} failed twice. Nothing has been credited. Please contact them by hand.`,
      ]);
    }
    return;
  }
  if (ctx.now - Number(first.sentAt) >= NO_REPLY_MS) {
    return settle(ctx, key, orderId, order, i, line, "credit", "auto_credit");
  }
}

async function nextReply(ctx, orderId, i, conv) {
  if (!ctx.inbox) return null;
  const seen = conv.seen || {};
  const replies = await ctx.inbox.replies({ email: conv.email, tag: conv.tag, sinceMs: Number(conv.startedAt) });
  const fresh = replies.filter((r) => r && r.id && !seen[r.key]).sort((a, b) => a.date - b.date);
  for (const r of fresh) {
    // Claim the reply once (a re-run never acts on it twice).
    const claimed = await lineTxn(ctx, orderId, i, (cur) => {
      const c = cur.resolution?.conversation;
      if (!c || c.seen?.[r.key]) return undefined;
      return { ...cur, resolution: { ...cur.resolution, conversation: { ...c, seen: { ...(c.seen || {}), [r.key]: ctx.now } } } };
    });
    if (claimed) return r;
  }
  return null;
}

// ── pick N ───────────────────────────────────────────────────────────────────
// A held pick is dropped only once it has an outcome: a committed swap, or a final answer (dearer, gone): CodeRabbit #847.
/**
 * A packed order's follow-up line carries a mirror of the parent's swap credit (store-app #847): it follows the parent's
 * result. done → the follow-up's moneySettled under p<claimAt> (stable: a recovery re-run never adds it twice); not filed
 * → the mirror goes; filed but not done → the mirror shows that state (unclear until settled). Used by the swap and by
 * its crash recovery (CodeRabbit on #848).
 */
async function syncMirror(ctx, orderId, i, { claimAt, creditCents, diff }) {
  const entry = clean({ kind: "credit", amountCents: creditCents, via: diff?.via ?? null, ref: diff?.ref ?? null, at: claimAt, ...(Number.isInteger(diff?.paidCents) ? { paidCents: diff.paidCents } : {}), onParent: `${orderId}/${i}` });
  await lineTxn(ctx, followUpId(orderId, i), 0, (line0) => {
    const cur = line0.resolution || {};
    const m = cur.money;
    const mine = m && typeof m === "object" && m.mirroredFrom === `${orderId}/${i}` && Number(m.at) === Number(claimAt);
    const { money: _m, ...rest } = cur;
    const key = `p${claimAt}`;
    let next;
    if (diff?.state === "done") next = cur.moneySettled?.[key] && !mine ? undefined : { ...(mine ? rest : cur), moneySettled: { ...(cur.moneySettled || {}), [key]: { ...entry, state: "done" } } };
    else if (!diff) next = mine ? rest : undefined;
    else next = mine || !m ? { ...cur, money: clean({ ...entry, state: diff.state || "manual", ...(diff.ambiguous != null ? { ambiguous: diff.ambiguous } : {}), mirroredFrom: `${orderId}/${i}` }) } : undefined;
    return next === undefined ? undefined : { ...line0, resolution: next };
  });
}

/**
 * What the customer may be told of a swap's credit, from what money() returned: filed (done → "on your account"; with
 * Junid by hand → "being added") → the amount; nothing filed, refused, or a claim with no result → no amount.
 */
function creditWords(diff, amountCents) {
  const filed = !!diff && ["done", "manual", "failed"].includes(diff.state); // failed: Junid was told to do it by hand
  return { amountCents: filed ? amountCents || 0 : 0, pending: filed && diff.state !== "done" };
}

/** A pick that did not commit is HELD and tried again (review of #847, 1); after 3 tries Junid is told once, in the app. */
async function holdPick(ctx, orderId, order, i, line, offer, why) {
  const offers = Object.values(line.resolution?.conversation?.offers || {});
  const n = offers.findIndex((o) => o && o.pid === offer.pid && String(o.size ?? "") === String(offer.size ?? "")) + 1;
  let tries = 0;
  await lineTxn(ctx, orderId, i, (cur) => {
    const c = cur.resolution?.conversation;
    if (!c) return undefined;
    tries = (Number(c.heldPick?.tries) || 0) + 1;
    return { ...cur, resolution: { ...cur.resolution, conversation: { ...c, heldPick: { n: n || c.heldPick?.n || null, pid: offer.pid, at: c.heldPick?.at || ctx.now, tries, why: String(why).slice(0, 200) } } } };
  });
  await record(ctx, orderId, i, order.ref, "swap_refused", { note: `${offer.title}: not swapped yet (${why}); held, tried again` });
  if (tries === 3) await tellJunid(ctx, `Website order ${order.ref}: the customer's pick ${offer.title} would not go on (3 tries)`, [`Line: ${line.title}${line.size ? ` size ${line.size}` : ""}. Last reason: ${why}. It is still held and tried again each run; nothing was said to the customer.`]);
}
const clearHeld = (ctx, orderId, i) => lineTxn(ctx, orderId, i, (cur) => { const c = cur.resolution?.conversation; if (!c?.heldPick) return undefined; const { heldPick: _h, ...rest } = c; return { ...cur, resolution: { ...cur.resolution, conversation: rest } }; });

async function pick(ctx, key, orderId, order, i, line, offer, { held = false } = {}) {
  const judged = judgeSwap(line, offer, { now: ctx.now });
  if (!judged.ok && judged.why === "money_unclear") {
    // An earlier credit or refund on this line has no known result (COMMIT 6 ledger): nothing is swapped on a guess. The
    // pick is HELD on the conversation and tried again each run (review of #846, 4); Junid is told once.
    if (held) return; // still unclear: held, nothing new said
    const offers = Object.values(line.resolution?.conversation?.offers || {});
    const n = offers.findIndex((o) => o && o.pid === offer.pid && String(o.size ?? "") === String(offer.size ?? "")) + 1;
    await lineTxn(ctx, orderId, i, (cur) => (cur.resolution?.conversation ? { ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, heldPick: { n: n || null, pid: offer.pid, at: ctx.now } } } } : undefined));
    await record(ctx, orderId, i, order.ref, "swap_refused", { note: `${offer.title}: not swapped yet, ${judged.note}` });
    await tellJunid(ctx, `Website order ${order.ref}: the customer picked ${offer.title}, NOT swapped yet`, [`Line: ${line.title}${line.size ? ` size ${line.size}` : ""}.`, `${judged.note}. Settle that first (Jamie: "money #${order.orderNumber || order.ref} went" or "did not go"); the pick is kept and goes on by itself once it is settled.`]);
    return;
  }
  if (!judged.ok && judged.why === "refunded_full") {
    // Refunded in full: a final answer, said plainly to the customer and to Junid, never held (review of #847, 2).
    if (held) await clearHeld(ctx, orderId, i);
    await record(ctx, orderId, i, order.ref, "swap_refused", { note: `${offer.title}: ${judged.note}` });
    await send(ctx, orderId, order, i, line, "refunded_full");
    await tellJunid(ctx, `Website order ${order.ref}: the customer picked ${offer.title}, but everything paid for the line was given back already`, [`Line: ${line.title}. ${judged.note}. The customer was told nothing is left to swap; nothing was changed.`]);
    return;
  }
  if (!judged.ok) {
    if (held) await clearHeld(ctx, orderId, i); // a final answer: never retried twice
    await record(ctx, orderId, i, order.ref, "swap_refused", { note: `${offer.title} costs ${rands(judged.extraCents)} more — never charge more` });
    await send(ctx, orderId, order, i, line, "costs_more", { amountCents: judged.extraCents });
    return;
  }
  // The offer may be days old: the unit is checked again NOW.
  if (ctx.offerStillAvailable && !(await ctx.offerStillAvailable({ offer, line, orderId }))) {
    if (held) await clearHeld(ctx, orderId, i);
    await record(ctx, orderId, i, order.ref, "swap_refused", { note: `${offer.title} is no longer in stock` });
    await send(ctx, orderId, order, i, line, "gone");
    return;
  }
  // The swap: the line becomes the new item, routed where the offer found it.
  const fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}`);
  const packed = fresh?.status === ORDER_STATUS.PACKED;
  // THE swap's own line builder (scripts/lib/swap-line.mjs): a customer's pick
  // leaves the same record as Jimmy's or the POS "Replace".
  const swappedFrom = swapFromRecord(line, { at: ctx.now, by: "customer agent", via: "agent" });
  const outcome = { kind: "swap", pid: offer.pid, size: offer.size, creditCents: judged.creditCents, at: ctx.now, by: "customer agent", via: "agent" };
  // The credit a cheaper pick owes is CLAIMED in the swap's own write (review of #847, 5): a crash after the swap and before
  // the payment leaves a claim (paid once, or Junid's), never an unrecorded debt or a second payment.
  const creditClaim = judged.creditCents > 0 ? { kind: "credit", amountCents: judged.creditCents, state: "claimed", at: ctx.now, why: "swap difference", preclaimed: true } : null;
  // The line's money moves the same way as on every swap (COMMIT 6): a done credit to moneySettled, never left in place.
  const newLine = (cur, claim = creditClaim) => {
    const nl = swappedLine(cur, { ...offer, sizeKey: offer.sizeKey || stockSizeKey(offer.size) }, {
      swappedFrom, outcome,
      resolution: swapResolution(cur.resolution, { now: ctx.now, outcome, closeConversation: "agent" }),
    });
    return claim ? { ...nl, resolution: { ...nl.resolution, money: claim } } : nl;
  };
  // A follow-up's copy of the parent's claim: a mirror (never paid itself; settled with its parent).
  const mirrorOf = (claim) => (claim ? { ...claim, mirroredFrom: `${orderId}/${i}` } : null);
  let followed = packed; // a follow-up carries the new item (packed at the read, or the pack race below)
  if (packed) {
    // The parcel has gone: the new item ships on its own.
    const fid = followUpId(orderId, i);
    const parentLine = linesOf(fresh)[i];
    // The follow-up's copy of the credit claim is written WITH the follow-up, before Shopify is called (review of #847, 4).
    const follow = followUpRecord({ order: fresh, orderId, i, line: newLine(parentLine, mirrorOf(creditClaim)), parentLine, nowMs: ctx.now });
    const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${fid}`).transaction((cur) => (cur == null ? clean(follow) : undefined));
    if (!res.committed && !res.snapshot.val()) return holdPick(ctx, orderId, order, i, line, offer, "the follow-up could not be made");
    await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/followUps/${fid}`).set(true);
    // The parent line settles its money the same way (review of #846, 3): its done slot to moneySettled, so the follow-up's
    // credit below is its own action; the money is re-checked as on the unpacked path.
    // The parent claims the credit in the same write, and only while the customer is still choosing (review of #847, 7).
    const parentOk = await lineTxn(ctx, orderId, i, (cur) => (cur.resolution?.conversation?.state !== "offering" || JSON.stringify(cur.resolution?.money ?? null) !== JSON.stringify(line.resolution?.money ?? null) ? undefined : ({ ...cur, source: { status: LINE_STATUS.MOVED, movedTo: fid }, resolution: { ...swapResolution(cur.resolution, { now: ctx.now, outcome: { ...outcome, movedTo: fid }, closeConversation: "agent" }), ...(creditClaim ? { money: creditClaim } : {}) } })));
    if (!parentOk) {
      // The parent's money changed meanwhile (CodeRabbit on #847): the follow-up just made is undone, nothing reported.
      if (res.committed) {
        await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${fid}`).set(null);
        await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/followUps/${fid}`).set(null);
      }
      return holdPick(ctx, orderId, order, i, line, offer, "the line's money changed meanwhile");
    }
    if (held) await clearHeld(ctx, orderId, i);
  } else {
    // The ledger was judged on the line as read: money that moved since makes it stale (never a wrong credit; COMMIT 6).
    const sameMoney = (cur) => JSON.stringify(cur.resolution?.money ?? null) === JSON.stringify(line.resolution?.money ?? null);
    const done = await lineTxn(ctx, orderId, i, (cur) => (cur.resolution?.conversation?.state === "offering" && sameMoney(cur) ? newLine(cur) : undefined));
    if (!done) return holdPick(ctx, orderId, order, i, line, offer, "the line changed meanwhile"); // never dropped silently
    if (held) await clearHeld(ctx, orderId, i); // committed: the held pick has its outcome
    // RACE: a pack may have landed between the read and the swap. A packed
    // order never ships a pick: the swapped line moves to a follow-up.
    const after = await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}`);
    if (after?.status === ORDER_STATUS.PACKED && !after.packedLines?.[i]) {
      const fid = followUpId(orderId, i);
      const moving = linesOf(after)[i];
      // The swapped line carries the credit claim: the follow-up's copy is a mirror (paid once, on the parent).
      const mm = moving?.resolution?.money;
      const movingLine = mm && mm.state === "claimed" ? { ...moving, resolution: { ...moving.resolution, money: mirrorOf(mm) } } : moving;
      const follow = followUpRecord({ order: after, orderId, i, line: movingLine, parentLine: moving, nowMs: ctx.now });
      const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${fid}`).transaction((cur) => (cur == null ? clean(follow) : undefined));
      if (res.committed || res.snapshot.val()) {
        await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/followUps/${fid}`).set(true);
        await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, source: { status: LINE_STATUS.MOVED, movedTo: fid } }));
        followed = true; // the pack race made one too: it gets the parent-credit history as well (CodeRabbit on #847)
      }
    }
  }
  // The old item's hold goes; the poller writes the new one this tick.
  if (line.pid && line.sizeKey) await ctx.db.ref(`online_reservations/${line.pid}/${line.sizeKey}/${orderId}`).set(null);
  for (const pid of new Set([line.pid, offer.pid].filter(Boolean))) await ctx.db.ref(`shopify_inventory_dirty/${pid}`).set(ctx.increment(1));
  ctx.summary.swaps++;
  await record(ctx, orderId, i, order.ref, "swapped", { note: `${line.title} → ${offer.title} at ${offer.locationId}${packed ? " (ships as a follow-up)" : ""}` });
  const swapped = { ...line, ...newLine(line) };
  const diff = creditClaim ? await money(ctx, orderId, order, i, swapped, "credit", judged.creditCents, "swap difference", { claimedAt: creditClaim.at }) : null;
  // A packed order's item ships as a follow-up: a credit paid on the parent line is in the follow-up line's money history
  // too, so its next swap counts it (one ledger across parent and follow-up; CodeRabbit on #847).
  // Its own key (never the moved parent slot's m<now>; CodeRabbit on #847). A credit not done yet (by hand, an unclear
  // answer) is mirrored as the follow-up line's money slot, so a swap there waits until it is settled (Junid's
  // settle_line_money settles the mirror too).
  // The follow-up's mirror follows the parent's result: done → its moneySettled (own key), else the same state.
  if (followed && creditClaim) await syncMirror(ctx, orderId, i, { claimAt: creditClaim.at, creditCents: judged.creditCents, diff });
  // The customer hears of a credit only as far as money() really filed it (review of #847, 6): none filed → no amount
  // (Junid hears); filed but not done → "being added"; done → "on your account".
  if (creditClaim && !diff) await tellJunid(ctx, `Website order ${order.ref}: ${rands(judged.creditCents)} store credit owed after the swap was NOT filed`, [`Line: ${line.title} → ${offer.title}. The customer was told of the swap, not of the credit. Please credit it by hand or tell Jamie.`]);
  await send(ctx, orderId, order, i, swapped, "swapped", creditWords(diff, judged.creditCents));
  await setAgentRow(ctx, key, null);
}

// ── credit / refund ─────────────────────────────────────────────────────────
async function settle(ctx, key, orderId, order, i, line, kind, messageKind) {
  // What is left of what was paid for the line (the ledger; review of #846, 5): never the full price again after a credit.
  const lg0 = lineLedger(line, { priceCents: 0, now: ctx.now });
  // A refund goes back to the order's own payment only, never above what it took (Sonnet review of #848, 1); a difference
  // collected on its own PayFast payment is Junid's to give back there.
  let amount = kind === "refund" ? lg0.refundToOriginalCents : lg0.refundableCents;
  const heldBack = kind === "refund" ? lg0.refundableCents - lg0.refundToOriginalCents : 0;
  if (!(amount > 0)) {
    // Told once (CodeRabbit on #847): a marker on the conversation, so the next run (or the 48-hour credit) is silent.
    if (line.resolution?.conversation?.nothingLeftAt) return;
    if (heldBack > 0) {
      // Nothing can go back to the order's own payment, but a difference paid separately is still owed (CodeRabbit on #851).
      // The conversation is Junid's now (CodeRabbit on #851): never "offering", so no 48-hour credit can pay the same money
      // he refunds by hand.
      // Only once the hand-over is WRITTEN (Sonnet review of #851): a failed write leaves the conversation as it was, so nothing
      // is said and the next run tries again; never told Junid while the 48-hour credit could still pay the same money.
      const handed = await lineTxn(ctx, orderId, i, (cur) => (cur.resolution?.conversation ? { ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, nothingLeftAt: ctx.now, state: "with_junid", withJunidAt: ctx.now } } } : undefined));
      if (!handed) return;
      await record(ctx, orderId, i, order.ref, "money_refused", { kind, amountCents: 0, note: `${rands(heldBack)} was paid on its own PayFast payment; Junid's to refund there` });
      await tellJunid(ctx, `Website order ${order.ref}: refund asked; ${rands(heldBack)} left, paid on its own PayFast payment`, [`Line: ${line.title}. Nothing is left to refund to the order's payment; the customer's ${rands(heldBack)} difference was paid on a separate PayFast payment. Refund it there by hand, or tell Jamie to credit it. Nothing was sent to the customer.`]);
      await setAgentRow(ctx, key, { state: "needs_junid" });
      return;
    }
    await lineTxn(ctx, orderId, i, (cur) => (cur.resolution?.conversation ? { ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, nothingLeftAt: ctx.now } } } : undefined));
    await record(ctx, orderId, i, order.ref, "money_refused", { kind, amountCents: 0, note: "nothing is left of what was paid for this line" });
    await tellJunid(ctx, `Website order ${order.ref}: ${kind} asked, but nothing is left to give back on ${line.title}`, [`Everything paid for the line was given back already; nothing was sent to the customer.`]);
    await setAgentRow(ctx, key, { state: "offering", needsJunid: true });
    return;
  }
  const res = await money(ctx, orderId, order, i, line, kind, amount, messageKind === "auto_credit" ? "no reply in 48 hours" : `the customer chose ${kind}`);
  if (!res) {
    // Refused. A money slot already on the line: Junid hears once, in the app; the line merely changed meanwhile (the
    // claim's write aborted): tried again next run, nothing said (Sonnet review of #848, minor).
    const lr = ctx.lastMoneyRefusal && ctx.lastMoneyRefusal.orderId === orderId && ctx.lastMoneyRefusal.i === i ? ctx.lastMoneyRefusal : null;
    ctx.lastMoneyRefusal = null;
    if (!lr || lr.race) return; // the write raced (or a resumed claim): tried again next run, nothing said
    if (!line.resolution?.conversation?.settleRefusedAt) {
      await lineTxn(ctx, orderId, i, (cur) => (cur.resolution?.conversation ? { ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, settleRefusedAt: ctx.now } } } : undefined));
      await tellJunid(ctx, `Website order ${order.ref}: the customer asked for ${kind}, but it was refused`, [`Line: ${line.title}. Why: ${lr.why}. Nothing was sent to the customer; settle the line's money first (Jamie: "money #${order.orderNumber || order.ref} went" or "did not go").`]);
    }
    return;
  }
  if (heldBack > 0) await tellJunid(ctx, `Website order ${order.ref}: refund of ${rands(amount)} filed; ${rands(heldBack)} more was paid separately`, [`Line: ${line.title}. The customer also paid a ${rands(heldBack)} difference on its own PayFast payment for the swap; a refund never goes above what the order's payment took, so that part is NOT in this refund. Refund it on that PayFast payment by hand, or tell Jamie to credit it.`]);
  // What Shopify actually refunded (it may suggest less than the line).
  if (Number.isInteger(res.paidCents) && res.paidCents > 0) amount = res.paidCents;
  const windowUntil = messageKind === "auto_credit" ? ctx.now + REFUND_WINDOW_MS : null;
  await lineTxn(ctx, orderId, i, (cur) => ({
    ...cur,
    source: { status: LINE_STATUS.RESOLVED },
    resolution: { ...cur.resolution, outcome: { kind: messageKind, amountCents: amount, at: ctx.now }, conversation: { ...cur.resolution.conversation, state: windowUntil ? "credited_window" : "closed", ...(windowUntil ? { refundWindowUntil: windowUntil } : { closedAt: ctx.now }) } },
  }));
  await send(ctx, orderId, order, i, line, messageKind, { amountCents: amount, pending: res.via !== "api" });
  await setAgentRow(ctx, key, windowUntil ? { state: "credited_window", until: windowUntil } : null);
}

async function creditedWindow(ctx, key, orderId, order, i, line) {
  const conv = line.resolution.conversation;
  const reply = await nextReply(ctx, orderId, i, conv);
  if (reply) {
    ctx.summary.replies++;
    const d = parseReplyCode(reply.text, 0) || validateClassification(await ctx.model.classify(reply.text, []).catch(() => null), 0);
    await record(ctx, orderId, i, order.ref, "reply", { decision: d.kind, via: "after_credit" });
    if (d.kind === "refund" && ctx.now <= Number(conv.refundWindowUntil)) {
      // NEVER BOTH: the code issued the credit; the swap to a refund is Junid's.
      const m = line.resolution?.money;
      await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, refundRequestedAfterCredit: { at: ctx.now }, conversation: { ...cur.resolution.conversation, state: "closed", closedAt: ctx.now } } }));
      await tellJunid(ctx, `Website order ${order.ref}: swap the store credit for a refund — ${rands(m?.amountCents ?? paidCents(line))}`, [
        `${order.customer?.name || "The customer"} (${conv.email}) asked for a refund within the ${Math.round(REFUND_WINDOW_MS / 86400e3)}-day window after the automatic store credit.`,
        `Item: ${line.title}${line.size ? ` size ${line.size}` : ""} ×${line.qty}. Shopify order ${order.shopifyName || order.orderNumber || ""}.`,
        `Store credit issued: ${rands(m?.amountCents ?? 0)} (${m?.via === "api" ? `Shopify transaction ${m.ref || "?"}` : "by you, from the earlier email"}).`,
        `Please: take that store credit back, then refund ${rands(m?.amountCents ?? paidCents(line))} for this line. The code never issues both.`,
      ]);
      await send(ctx, orderId, order, i, line, "refund_after_credit", { amountCents: m?.amountCents ?? paidCents(line) });
      await setAgentRow(ctx, key, null);
      return;
    }
    await tellJunid(ctx, `Website order ${order.ref}: a reply after the store credit`, [`From ${conv.email}:`, "", String(reply.text).slice(0, 2000)]);
  }
  if (ctx.now > Number(conv.refundWindowUntil)) {
    await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, state: "closed", closedAt: ctx.now } } }));
    await record(ctx, orderId, i, order.ref, "closed", { note: "refund window over" });
    await setAgentRow(ctx, key, null);
  }
}

/**
 * THE MONEY GUARD. One slot per line, claimed in a transaction BEFORE any
 * Shopify call: credit OR refund, never both, never twice, never more than
 * was paid. Junid is emailed on every one. → the slot, or null when refused.
 */
export async function money(ctx, orderId, order, i, line, kind, amountCents, why, { claimedAt = null } = {}) {
  // RESUME: the same action already claimed (a crash after the claim): never
  // a second Shopify call. A claim with no outcome for 10 minutes is Junid's.
  const existing = (await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}/lines/${i}/resolution/money`)) || null;
  // The claim THIS swap wrote with the line (preclaimed, its own time): paid now, once (review of #847, 5).
  const preclaimed = !!existing && claimedAt != null && existing.preclaimed === true && existing.state === "claimed" && Number(existing.at) === Number(claimedAt) && existing.kind === kind && Number(existing.amountCents) === amountCents;
  if (!preclaimed && existing && existing.kind === kind && Number(existing.amountCents) === amountCents) {
    // A swap's own pre-claim met again (the run that wrote it stopped before paying; CodeRabbit on #848): Junid at once.
    if (existing.state === "claimed" && (existing.preclaimed === true || ctx.now - Number(existing.at) >= STUCK_CLAIM_MS) && !existing.stuckMailedAt) {
      await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, money: { ...cur.resolution.money, stuckMailedAt: ctx.now } } }));
      await tellJunid(ctx, `Website order ${order.ref}: CHECK SHOPIFY — a ${kind} of ${rands(amountCents)} may or may not have gone through`, [
        `The agent claimed this ${kind} at ${new Date(Number(existing.at)).toISOString()} and stopped before recording the result.`,
        `Line: ${line.title} ×${line.qty}. Check the Shopify order ${order.shopifyName || ""}; it will NOT be tried again.`,
      ]);
    }
    return { ...existing, resumed: true, via: existing.via || "junid_email" };
  }
  let refused = null;
  const claimed = preclaimed ? { resolution: { money: existing } } : await lineTxn(ctx, orderId, i, (cur) => {
    const verdict = moneyAllowed(cur.resolution?.money, { kind, amountCents, line: cur });
    if (!verdict.ok) { refused = verdict.why; return undefined; }
    return { ...cur, resolution: { ...(cur.resolution || {}), money: { kind, amountCents, state: "claimed", at: ctx.now, why } } };
  });
  if (!claimed) {
    await record(ctx, orderId, i, order.ref, "money_refused", { kind, amountCents, note: refused || "the line moved" });
    // Which it was, for the caller (CodeRabbit on #851): the ledger's own refusal, or a write that merely raced.
    ctx.lastMoneyRefusal = { orderId, i, kind, why: refused || null, race: !refused };
    return null;
  }
  const scopes = ctx.scopes ? await ctx.scopes() : new Set();
  const need = kind === "credit" ? CREDIT_SCOPE : REFUND_SCOPE;
  let slot;
  if (!scopes.has(need)) {
    slot = { state: "manual", via: "junid_email", missingScope: need };
  } else {
    let r;
    try {
      r = kind === "credit"
        ? await issueStoreCredit(ctx.graphql, { orderGid: order.shopifyGid, amountCents, currency: order.totals?.currency || "ZAR" })
        : await refundLine(ctx.graphql, { orderGid: order.shopifyGid, lineItemId: line.shopifyLineItemId, quantity: Number(line.qty) || 1, amountCents,
          idempotencyKey: slotRefundKey({ orderId, lineIndex: i, claimedAt: claimed.resolution.money.at }) });
    } catch (e) {
      r = { ok: false, error: String(e?.message || e), ambiguous: true };
    }
    slot = r.ok ? { state: "done", via: "api", ref: r.id ?? null, ...(r.amountCents ? { paidCents: r.amountCents } : {}) } : { state: "failed", via: "junid_email", error: String(r.error).slice(0, 300), ambiguous: !!r.ambiguous };
  }
  ctx.summary[kind === "credit" ? "credits" : "refunds"]++;
  await record(ctx, orderId, i, order.ref, kind, { amountCents, note: `${rands(amountCents)} — ${slot.via === "api" ? "done on Shopify" : slot.state === "failed" ? `Shopify refused: ${slot.error}` : `scope ${need} not granted: Junid emailed`}` });
  const action = kind === "credit" ? "store credit" : "refund";
  await tellJunid(ctx, `Website order ${order.ref}: ${action} ${rands(amountCents)} ${slot.via === "api" ? "issued" : "— PLEASE DO THIS BY HAND"}`, [
    `Order ${order.ref} (Shopify ${order.shopifyName || order.orderNumber || ""}), ${order.customer?.name || ""} ${order.customer?.email || ""}`.trim(),
    `Line: ${line.title}${line.size ? ` size ${line.size}` : ""} ×${line.qty}, paid ${rands(paidCents(line))}.`,
    `Action: ${action} of ${rands(amountCents)} — ${why}.`,
    slot.via === "api"
      ? `Done through the Shopify Admin API (${slot.ref || "no id returned"}).`
      : slot.state === "failed"
        ? `Shopify refused or did not answer: ${slot.error}${slot.ambiguous ? " — it MAY have gone through; check the order before doing it by hand." : ""} It will not be retried.`
        : `The app is not allowed to do this yet (Shopify scope ${need} not granted). Please do it in the Shopify admin.`,
  ]);
  // Junid is told FIRST (above): a write failing here can never hide money
  // that moved.
  await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, money: { ...cur.resolution.money, ...slot } } }));
  return { ...claimed.resolution.money, ...slot };
}
