// ── The website-order customer agent — what the CODE decides (pure) ─────────
// The model writes words; this decides actions. Nothing here touches a
// database, the network or a clock. docs/ONLINE-CUSTOMER-AGENT.md.
//
// GUARDS (each one pinned by a test that fails if it is removed):
//   • one conversation per line
//   • at most MAX_OUTBOUND messages per line (a slot is reserved BEFORE a send)
//   • money: ONE slot per line — credit OR refund, never both — and never more
//     than what the customer paid for the line
//   • a swap that would cost the customer more is refused (never charge more)

export const MAX_OUTBOUND = 3;
export const MAX_OFFERS = 4;
export const NO_REPLY_MS = 48 * 3600 * 1000;
export const REFUND_WINDOW_MS = 14 * 24 * 3600 * 1000;
export const STOREFRONT = "https://marathonclub.co.za";

export const productUrl = (handle) => `${STOREFRONT}/products/${encodeURIComponent(String(handle))}`;

/** What the customer paid for the line, in cents (a swapped line: what was paid originally). */
export function paidCents(line) {
  const unit = Number.isInteger(line?.originalUnitPriceCents) ? line.originalUnitPriceCents : Number(line?.unitPriceCents);
  const qty = Number(line?.qty);
  if (!Number.isInteger(unit) || unit < 0 || !Number.isInteger(qty) || qty <= 0) return 0;
  return unit * qty;
}

export const rands = (cents) => `R${(Number(cents) / 100).toFixed(2).replace(/\.00$/, "")}`;

// ── THE LINE'S MONEY LEDGER (Junid, 5 Nov 2026, COMMIT 6) — ONE formula for every swap path ───────────────────────────
// swap-line.mjs (Jamie's and the POS's swaps) and this agent's pick both use it. MIRROR: marathon-dm-agent
// src/jimmy/lineLedger.js (approvals.issue re-checks a credit against it before paying) — KEEP THE TWO IN SYNC.
// Given back = completed money (state done) in resolution.money and every earlier one in resolution.moneySettled.
// Owed = paid for the line − given back − the current item's price: positive → store credit owed; negative → a difference
// to collect. A money action whose result is not known is UNCLEAR and stops every swap until it is settled:
//   manual   approved for Junid to do by hand: unclear until he says it is done (the slot then becomes done)
//   failed   unclear unless ambiguous === false (a definite refusal: nothing moved)
//   claimed  being paid now (busy); older than CLAIM_STALE_MS: unclear (the payer died mid-flight)
export const CLAIM_STALE_MS = 15 * 60e3;
export function lineLedger(line, { priceCents, now = Date.now() } = {}) {
  const qty = Number(line?.qty) || 1;
  const paid = paidCents(line);
  const m = line?.resolution?.money;
  const isObj = !!m && typeof m === "object";
  const amt = (x) => Math.max(0, Math.round(Number(x?.amountCents) || 0));
  const earlier = Object.values(line?.resolution?.moneySettled || {}).filter((x) => x && typeof x === "object" && x.state === "done");
  const settled = earlier.reduce((t, x) => t + amt(x), 0) + (isObj && m.state === "done" ? amt(m) : 0);
  const nowCents = Math.max(0, Math.round(Number(priceCents) || 0)) * qty;
  const net = paid - settled - nowCents;
  const claimedAt = Number(m?.at) || 0;
  const stale = isObj && m.state === "claimed" && claimedAt > 0 && now - claimedAt > CLAIM_STALE_MS;
  let unclearWhy = null;
  if (isObj && m.state === "manual") unclearWhy = `an earlier ${rands(amt(m))} ${m.kind || "money action"} for this line was approved for Junid to do by hand and is not marked done yet (once done in Shopify, Junid tells Jamie on his line "done #<order>")`;
  else if (isObj && m.state === "failed" && m.ambiguous !== false) unclearWhy = `an earlier ${rands(amt(m))} ${m.kind || "money action"} for this line may have gone through (its answer was lost): check it in Shopify first`;
  else if (stale) unclearWhy = `an earlier ${rands(amt(m))} ${m.kind || "money action"} for this line started at ${new Date(claimedAt + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} SAST and never finished: check it in Shopify first`;
  return {
    paidCents: paid, settledCents: settled, nowCents, creditCents: Math.max(0, net), extraCents: Math.max(0, -net),
    refundableCents: Math.max(0, paid - settled),
    busy: isObj && m.state === "claimed" && !stale,
    unclear: !!unclearWhy, unclearWhy,
    // Never moved money: superseded by the next swap (a definite refusal, or a pending request).
    supersedes: isObj && (m.state === "pending" || (m.state === "failed" && m.ambiguous === false)) ? { state: m.state, amountCents: amt(m), kind: m.kind || null } : null,
  };
}
/**
 * The line's resolution after a swap: a completed money action moves to moneySettled (counted in every later ledger, so
 * the next credit is its own action), one that never moved money is kept as supersededMoney (doNotIssue). Pure.
 * Call only when lineLedger said neither busy nor unclear.
 */
export function swapResolution(resolution, { now, outcome, closeConversation = null }) {
  const cur = resolution || {};
  const m = cur.money;
  const done = !!m && typeof m === "object" && m.state === "done";
  const { money: _old, ...rest } = cur;
  const conv = cur.conversation;
  return {
    ...rest,
    ...(done ? { moneySettled: { ...(cur.moneySettled || {}), [`m${now}`]: m } } : {}),
    ...(m && !done ? { supersededMoney: { ...m, supersededAt: now, doNotIssue: true } } : {}),
    outcome,
    ...(closeConversation && conv && conv.state !== "closed" ? { conversation: { ...conv, state: "closed", closedAt: now, closedBy: closeConversation } } : {}),
  };
}

// ── Replies ──────────────────────────────────────────────────────────────────
/**
 * The customer's reply, read by CODE. Only the newest text (quoted history
 * stripped). → { kind: "pick", n } | { kind: "credit" } | { kind: "refund" }
 * | null (free text — one model classification decides).
 */
export function stripQuoted(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^On .+wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From:\s/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

export function parseReplyCode(text, offerCount) {
  const t = stripQuoted(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const words = t.split(" ");
  // A bare number, or "option 2" / "number 3" / "no 1" — and nothing else.
  const m = t.match(/^(?:option |number |no |nr |#)?([1-9])$/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= offerCount ? { kind: "pick", n } : null;
  }
  // Only the bare choice and polite filler — "no refund", "not credit", or
  // anything longer goes to the classifier (Sonnet review, PR #778).
  const FILLER = new Set(["please", "store", "a", "the", "thanks", "thank", "you", "ok", "okay", "i", "want", "would", "like", "id", "d", "prefer"]);
  const hasCredit = words.includes("credit");
  const hasRefund = words.includes("refund");
  const onlyFiller = words.every((w) => w === "credit" || w === "refund" || FILLER.has(w));
  if (!onlyFiller) return null;
  if (hasCredit && !hasRefund) return { kind: "credit" };
  if (hasRefund && !hasCredit) return { kind: "refund" };
  return null;
}

/** The model's classification, validated by code. Anything off → unclear. */
export function validateClassification(raw, offerCount) {
  const intent = raw?.intent;
  if (intent === "pick") {
    const n = Number(raw.n);
    return Number.isInteger(n) && n >= 1 && n <= offerCount ? { kind: "pick", n } : { kind: "unclear" };
  }
  if (intent === "credit" || intent === "refund") return { kind: intent };
  return { kind: "unclear" };
}

// ── Guards ───────────────────────────────────────────────────────────────────
/** May one more message go to this line's customer? */
export function canSend(conversation) {
  return (Number(conversation?.outbound) || 0) < MAX_OUTBOUND;
}

/**
 * May this money action happen? `money` is the line's resolution.money slot.
 * → { ok: true } | { ok: false, why }
 */
export function moneyAllowed(money, { kind, amountCents, line }) {
  if (kind !== "credit" && kind !== "refund") return { ok: false, why: "unknown money action" };
  if (money) return { ok: false, why: `this line already has a ${money.kind} (${rands(money.amountCents)}) — never both, never twice` };
  // What is left of what was paid, after money already given back for this line (the ledger, COMMIT 6).
  const left = lineLedger(line, { priceCents: 0 }).refundableCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, why: "nothing to pay" };
  if (amountCents > left) return { ok: false, why: `${rands(amountCents)} is more than the ${rands(left)} left of what was paid for this line` };
  return { ok: true };
}

/**
 * A pick, judged. `offer.priceCents` is the alternative's unit price.
 * → { ok: true, creditCents } (creditCents ≥ 0: what the customer gets back)
 *   | { ok: false, why: "costs_more", extraCents }
 */
export function judgeSwap(line, offer, { now = Date.now() } = {}) {
  // The ledger (COMMIT 6): against what is left of what was paid, never the full price paid.
  const lg = lineLedger(line, { priceCents: Number(offer?.priceCents) || 0, now });
  if (lg.busy || lg.unclear) return { ok: false, why: "money_unclear", note: lg.unclearWhy || "money for this line is being issued right now" };
  // Everything paid for the line was given back already: nothing is left to swap against (never "costs more" to the customer).
  if (lg.paidCents > 0 && lg.refundableCents === 0) return { ok: false, why: "money_unclear", note: `the line was refunded in full (${rands(lg.settledCents)}): nothing is left to swap against` };
  if (lg.extraCents > 0) return { ok: false, why: "costs_more", extraCents: lg.extraCents };
  return { ok: true, creditCents: lg.creditCents };
}

// ── Messages — the code owns every fact; the model only greets and closes ──
const LINK_OR_MONEY = /(https?:\/\/|www\.|\bR\s?\d|\d+[.,]\d{2}\b|@)/i;

/**
 * The model's words, accepted only if they carry no link, no money and no
 * email address (every fact comes from the code), and are short. → string | null
 */
export function acceptModelText(text, maxLen = 600) {
  const t = String(text ?? "").trim();
  if (!t || t.length > maxLen) return null;
  if (LINK_OR_MONEY.test(t)) return null;
  return t;
}

const FALLBACK = {
  offer: { opening: "We're so sorry — the item below from your order turned out not to be available after all. We looked everywhere for it before writing to you.", closing: "Thank you for your patience, and sorry again." },
  costs_more: { opening: "Thank you for choosing so quickly.", closing: "Sorry about that." },
  gone: { opening: "Thank you for choosing so quickly.", closing: "Sorry about that." },
  swapped: { opening: "Done — we've swapped the item on your order.", closing: "Thank you for sticking with us." },
  credit: { opening: "Thank you for letting us know — store credit it is.", closing: "Thank you, and sorry again for the trouble." },
  refund: { opening: "We've started your refund for this item.", closing: "Sorry again for the trouble." },
  auto_credit: { opening: "We didn't hear back from you, so we're making sure you're not out of pocket for the missing item.", closing: "Sorry again for the trouble." },
  unclear: { opening: "Thanks for your reply — we just want to be sure we do the right thing.", closing: "Thank you." },
  refund_after_credit: { opening: "No problem — we'll swap the store credit for a refund instead.", closing: "Sorry again for the trouble." },
};

export function fallbackWords(kind) {
  return FALLBACK[kind] || FALLBACK.unclear;
}

const itemWords = (line) => `${line.title}${line.size && line.size !== "_" ? `, size ${line.size}` : ""}${Number(line.qty) > 1 ? ` (×${line.qty})` : ""}`;

/**
 * The full message. `kind` picks the facts; `words` = { opening, closing }
 * from the model (already accepted) or the fallback.
 */
export function composeMessage(kind, { ref, firstName, line, offers = [], amountCents = null, words, refundWindowDays = 14, pending = false }) {
  // `pending`: the store credit is being added by hand (the API scope is not
  // granted, or Shopify refused) — never told as done when it is not.
  const creditState = pending ? "It is being added to your account and will show there within a day." : "It is on your account now.";
  const hi = firstName ? `Hi ${firstName},` : "Hi,";
  const parts = [hi, "", words.opening, ""];
  const tag = subjectTag(ref, line);
  if (kind === "offer" || kind === "costs_more" || kind === "unclear" || kind === "gone") {
    if (kind === "gone") parts.push("That one has just sold out, so we can't swap to it.", "");
    if (kind === "costs_more") parts.push(`That one costs ${rands(amountCents)} more than what you paid, and we'll never ask you to pay more — so we can't swap to it.`, "");
    parts.push(`The item: ${itemWords(line)}.`, "");
    if (offers.length) {
      parts.push(kind === "offer" ? "These are in stock in your size and close in price:" : "Your choices again:");
      offers.forEach((o, i) => parts.push(`  ${i + 1}. ${o.title} — ${rands(o.priceCents)} — ${o.url}`));
      parts.push("");
      parts.push(`Reply with the number you want (1${offers.length > 1 ? `–${offers.length}` : ""}), or the word "credit" for store credit of ${rands(paidCents(line))}, or "refund" for a refund of ${rands(paidCents(line))}.`);
    } else {
      parts.push(`Reply "credit" for store credit of ${rands(paidCents(line))}, or "refund" for a refund of ${rands(paidCents(line))}.`);
    }
    parts.push(`If we don't hear from you in 48 hours we'll put ${rands(paidCents(line))} on your account as store credit, and you can still ask for a refund instead for 14 days after that.`);
  } else if (kind === "swapped") {
    parts.push(`Your new item: ${itemWords(line)}. It ships to you as soon as it is packed.`);
    if (amountCents > 0) parts.push(`It costs less than what you paid, so ${rands(amountCents)} goes back to you as store credit. ${creditState}`);
  } else if (kind === "credit" || kind === "auto_credit") {
    parts.push(`Store credit: ${rands(amountCents)}, for ${itemWords(line)}. ${creditState}`);
    if (kind === "auto_credit") parts.push(`If you'd rather have a refund, reply "refund" within ${refundWindowDays} days.`);
  } else if (kind === "refund") {
    parts.push(`Refund: ${rands(amountCents)}, for ${itemWords(line)}. It is being processed and goes back to the card or account you paid with.`);
  } else if (kind === "refund_after_credit") {
    parts.push(`Refund: ${rands(amountCents)}, for ${itemWords(line)}. It is being processed, and the store credit is taken off when it goes through.`);
  }
  parts.push("", words.closing, "", "Marathon Club");
  return { subject: `Your order ${ref} — ${tag}`, text: parts.join("\n") };
}

/** The tag every message on this line carries; replies are matched by it. */
export function subjectTag(ref, line) {
  return `[${ref} item ${String(line?.lineId || "").replace(/[^\w-]/g, "") || "?"}]`;
}

/** The WhatsApp twin of an email: same facts, says replies go by email (no inbound path). */
export function whatsappText(mail) {
  return `${mail.text}\n\n(Please reply to the email we sent you — this WhatsApp number can't read replies.)`;
}
