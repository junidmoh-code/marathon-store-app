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
  const hasCredit = words.includes("credit");
  const hasRefund = words.includes("refund");
  if (words.length <= 3 && hasCredit && !hasRefund) return { kind: "credit" };
  if (words.length <= 3 && hasRefund && !hasCredit) return { kind: "refund" };
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
  const paid = paidCents(line);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, why: "nothing to pay" };
  if (amountCents > paid) return { ok: false, why: `${rands(amountCents)} is more than the ${rands(paid)} paid for this line` };
  return { ok: true };
}

/**
 * A pick, judged. `offer.priceCents` is the alternative's unit price.
 * → { ok: true, creditCents } (creditCents ≥ 0: what the customer gets back)
 *   | { ok: false, why: "costs_more", extraCents }
 */
export function judgeSwap(line, offer) {
  const qty = Number(line?.qty) || 1;
  const paid = paidCents(line);
  const cost = (Number(offer?.priceCents) || 0) * qty;
  if (cost > paid) return { ok: false, why: "costs_more", extraCents: cost - paid };
  return { ok: true, creditCents: paid - cost };
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
  if (kind === "offer" || kind === "costs_more" || kind === "unclear") {
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
