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
import { ONLINE_ORDERS_PATH, LINE_STATUS, ORDER_STATUS } from "../../../src/utils/onlineOrders.js";
import { stockSizeKey } from "../../../src/utils/sizeKey.js";
import { ESCALATIONS_PATH, followUpId, followUpRecord } from "../../shopify/onlineOrders/escalate.mjs";
import { linesOf } from "../../shopify/onlineOrders/orderModel.mjs";
import {
  MAX_OUTBOUND, NO_REPLY_MS, REFUND_WINDOW_MS, paidCents, rands, parseReplyCode, validateClassification,
  canSend, moneyAllowed, judgeSwap, acceptModelText, fallbackWords, composeMessage, subjectTag, whatsappText,
} from "./core.mjs";
import { CREDIT_SCOPE, REFUND_SCOPE, issueStoreCredit, refundLine } from "./money.mjs";

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
  const order = await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}`);
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
  if (out?.kind === "swap" && conv.state === "closed" && !Object.values(conv.sends || {}).some((x) => x?.kind === "swapped")) {
    const diff = out.creditCents > 0 ? await money(ctx, orderId, order, i, line, "credit", out.creditCents, "swap difference") : null;
    await send(ctx, orderId, order, i, line, "swapped", { amountCents: out.creditCents || 0, pending: !!diff && diff.via !== "api" });
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
  if (conv.state === "no_contact") await setAgentRow(ctx, key, { state: "needs_junid" });
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
async function pick(ctx, key, orderId, order, i, line, offer) {
  const judged = judgeSwap(line, offer);
  if (!judged.ok) {
    await record(ctx, orderId, i, order.ref, "swap_refused", { note: `${offer.title} costs ${rands(judged.extraCents)} more — never charge more` });
    await send(ctx, orderId, order, i, line, "costs_more", { amountCents: judged.extraCents });
    return;
  }
  // The offer may be days old: the unit is checked again NOW.
  if (ctx.offerStillAvailable && !(await ctx.offerStillAvailable({ offer, line, orderId }))) {
    await record(ctx, orderId, i, order.ref, "swap_refused", { note: `${offer.title} is no longer in stock` });
    await send(ctx, orderId, order, i, line, "gone");
    return;
  }
  // The swap: the line becomes the new item, routed where the offer found it.
  const fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}`);
  const packed = fresh?.status === ORDER_STATUS.PACKED;
  const swappedFrom = { pid: line.pid, size: line.size ?? null, sizeKey: line.sizeKey ?? null, title: line.title, unitPriceCents: line.unitPriceCents };
  const newLine = (cur) => {
    const { escalation: _e, escalationOverride: _o, ...rest } = cur;
    return {
      ...rest,
      pid: offer.pid, size: offer.size, sizeKey: offer.sizeKey || stockSizeKey(offer.size), title: offer.title,
      photoUrl: offer.photoUrl ?? null, category: offer.category ?? cur.category ?? null,
      unitPriceCents: offer.priceCents,
      originalUnitPriceCents: Number.isInteger(cur.originalUnitPriceCents) ? cur.originalUnitPriceCents : cur.unitPriceCents,
      swappedFrom, routeGen: (Number(cur.routeGen) || 0) + 1,
      escalationGen: (Number(cur.escalationGen) || 0) + 1,
      source: { locationId: offer.locationId, status: offer.status },
      resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, state: "closed", closedAt: ctx.now }, outcome: { kind: "swap", pid: offer.pid, size: offer.size, creditCents: judged.creditCents, at: ctx.now } },
    };
  };
  if (packed) {
    // The parcel has gone: the new item ships on its own.
    const fid = followUpId(orderId, i);
    const parentLine = linesOf(fresh)[i];
    const follow = followUpRecord({ order: fresh, orderId, i, line: newLine(parentLine), parentLine, nowMs: ctx.now });
    const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${fid}`).transaction((cur) => (cur == null ? clean(follow) : undefined));
    if (!res.committed && !res.snapshot.val()) return;
    await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/followUps/${fid}`).set(true);
    await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, source: { status: LINE_STATUS.MOVED, movedTo: fid }, resolution: { ...cur.resolution, conversation: { ...cur.resolution.conversation, state: "closed", closedAt: ctx.now }, outcome: { kind: "swap", pid: offer.pid, size: offer.size, creditCents: judged.creditCents, at: ctx.now, movedTo: fid } } }));
  } else {
    const done = await lineTxn(ctx, orderId, i, (cur) => (cur.resolution?.conversation?.state === "offering" ? newLine(cur) : undefined));
    if (!done) return;
    // RACE: a pack may have landed between the read and the swap. A packed
    // order never ships a pick: the swapped line moves to a follow-up.
    const after = await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}`);
    if (after?.status === ORDER_STATUS.PACKED && !after.packedLines?.[i]) {
      const fid = followUpId(orderId, i);
      const moving = linesOf(after)[i];
      const follow = followUpRecord({ order: after, orderId, i, line: moving, parentLine: moving, nowMs: ctx.now });
      const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${fid}`).transaction((cur) => (cur == null ? clean(follow) : undefined));
      if (res.committed || res.snapshot.val()) {
        await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/followUps/${fid}`).set(true);
        await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, source: { status: LINE_STATUS.MOVED, movedTo: fid } }));
      }
    }
  }
  // The old item's hold goes; the poller writes the new one this tick.
  if (line.pid && line.sizeKey) await ctx.db.ref(`online_reservations/${line.pid}/${line.sizeKey}/${orderId}`).set(null);
  for (const pid of new Set([line.pid, offer.pid].filter(Boolean))) await ctx.db.ref(`shopify_inventory_dirty/${pid}`).set(ctx.increment(1));
  ctx.summary.swaps++;
  await record(ctx, orderId, i, order.ref, "swapped", { note: `${line.title} → ${offer.title} at ${offer.locationId}${packed ? " (ships as a follow-up)" : ""}` });
  const swapped = { ...line, ...newLine(line) };
  const diff = judged.creditCents > 0 ? await money(ctx, orderId, order, i, swapped, "credit", judged.creditCents, "swap difference") : null;
  await send(ctx, orderId, order, i, swapped, "swapped", { amountCents: judged.creditCents, pending: !!diff && diff.via !== "api" });
  await setAgentRow(ctx, key, null);
}

// ── credit / refund ─────────────────────────────────────────────────────────
async function settle(ctx, key, orderId, order, i, line, kind, messageKind) {
  let amount = paidCents(line);
  const res = await money(ctx, orderId, order, i, line, kind, amount, messageKind === "auto_credit" ? "no reply in 48 hours" : `the customer chose ${kind}`);
  if (!res) return;
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
export async function money(ctx, orderId, order, i, line, kind, amountCents, why) {
  // RESUME: the same action already claimed (a crash after the claim): never
  // a second Shopify call. A claim with no outcome for 10 minutes is Junid's.
  const existing = (await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}/lines/${i}/resolution/money`)) || null;
  if (existing && existing.kind === kind && Number(existing.amountCents) === amountCents) {
    if (existing.state === "claimed" && ctx.now - Number(existing.at) >= STUCK_CLAIM_MS && !existing.stuckMailedAt) {
      await lineTxn(ctx, orderId, i, (cur) => ({ ...cur, resolution: { ...cur.resolution, money: { ...cur.resolution.money, stuckMailedAt: ctx.now } } }));
      await tellJunid(ctx, `Website order ${order.ref}: CHECK SHOPIFY — a ${kind} of ${rands(amountCents)} may or may not have gone through`, [
        `The agent claimed this ${kind} at ${new Date(Number(existing.at)).toISOString()} and stopped before recording the result.`,
        `Line: ${line.title} ×${line.qty}. Check the Shopify order ${order.shopifyName || ""}; it will NOT be tried again.`,
      ]);
    }
    return { ...existing, resumed: true, via: existing.via || "junid_email" };
  }
  let refused = null;
  const claimed = await lineTxn(ctx, orderId, i, (cur) => {
    const verdict = moneyAllowed(cur.resolution?.money, { kind, amountCents, line: cur });
    if (!verdict.ok) { refused = verdict.why; return undefined; }
    return { ...cur, resolution: { ...(cur.resolution || {}), money: { kind, amountCents, state: "claimed", at: ctx.now, why } } };
  });
  if (!claimed) {
    await record(ctx, orderId, i, order.ref, "money_refused", { kind, amountCents, note: refused || "the line moved" });
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
        : await refundLine(ctx.graphql, { orderGid: order.shopifyGid, lineItemId: line.shopifyLineItemId, quantity: Number(line.qty) || 1, amountCents });
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
