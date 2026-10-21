import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakeDb, increment } from "../../shopify/onlineOrders/fakeDb.testutil.mjs";
import { runCustomerAgent, money } from "./run.mjs";
import {
  MAX_OUTBOUND, parseReplyCode, validateClassification, moneyAllowed, judgeSwap, acceptModelText,
  composeMessage, canSend, paidCents, stripQuoted, fallbackWords,
} from "./core.mjs";

// NO TEST HERE REACHES THE NETWORK.
let fetchGuard;
beforeEach(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchGuard.mockRestore());

const NOW = Date.parse("2026-10-22T10:00:00Z");
const H = 3600e3;
const OFFERS = [
  { pid: "ALT1", size: "M", sizeKey: "M", title: "Club Tee Navy", url: "https://marathonclub.co.za/products/club-tee-navy", priceCents: 24000, locationId: "marathon-pe", status: "display" },
  { pid: "ALT2", size: "M", sizeKey: "M", title: "Club Tee Sand", url: "https://marathonclub.co.za/products/club-tee-sand", priceCents: 30000, locationId: "hub2", status: "pick" },
];
const unavailableLine = (over = {}) => ({
  lineId: "l0", shopifyLineItemId: "gid://shopify/LineItem/2", productGid: "gid://shopify/Product/222",
  pid: "TEE", size: "M", sizeKey: "M", qty: 1, title: "Club Tee", unitPriceCents: 25000, isFootwear: false,
  source: { status: "unavailable" }, escalation: { phase: "unavailable", round: 2, idx: 2, chain: "other", home: "marathon-pe" },
  ...over,
});
function world({ line = unavailableLine(), order = {} } = {}) {
  return {
    online_orders: { 9001: {
      ref: "LEV", orderNumber: 1801, shopifyGid: "gid://shopify/Order/9001", shopifyName: "#1801", status: "picking",
      customer: { name: "Thandi Mokoena", email: "thandi@example.com", phone: "+27820000000" },
      totals: { currency: "ZAR" }, lines: [line], ...order,
    } },
    online_escalations: { "9001_0": { orderId: "9001", lineIndex: 0, ref: "LEV", phase: "unavailable" } },
  };
}

function harness(f, { replies = [], scopes = [], connected = false, at = NOW, model } = {}) {
  const mails = [], junid = [], wa = [], gql = [];
  const inbox = { replies: async () => replies };
  const deps = {
    db: f.db, nowMs: async () => at, increment, log: () => {},
    mailer: async (m) => { mails.push(m); },
    notifyJunid: async (m) => { junid.push(m); },
    whatsapp: { status: async () => ({ connected }), send: async (to, text) => { wa.push({ to, text }); } },
    model: model ?? {
      words: async () => ({ opening: "We are really sorry, this one slipped through our hands.", closing: "Warm regards from the team." }),
      classify: async () => ({ intent: "unclear" }),
    },
    inbox,
    findAlternatives: async () => OFFERS,
    scopes: async () => new Set(scopes),
    graphql: async (q, v) => { gql.push({ q, v }); if (/storeCreditAccountCredit/.test(q)) return { storeCreditAccountCredit: { storeCreditAccountTransaction: { id: "gid://shopify/StoreCreditAccountTransaction/1" }, userErrors: [] } }; if (/order\(id: \$id\) \{ id customer/.test(q)) return { order: { id: v.id, customer: { id: "gid://shopify/Customer/7" } } }; throw new Error(`unexpected ${q.slice(0, 40)}`); },
  };
  return { deps, mails, junid, wa, gql, run: (over = {}) => runCustomerAgent({ ...deps, ...over }) };
}
const line = (f) => f.read("online_orders/9001/lines/0");
const conv = (f) => line(f).resolution.conversation;
const reply = (text, n = 1) => ({ id: `<m${n}@x>`, key: `m${n}`, text, date: NOW + n });

describe("first message", () => {
  it("opens ONE conversation, sends the offer by email with the numbered alternatives and links; the model never writes a fact", async () => {
    const f = fakeDb(world());
    const h = harness(f);
    await h.run();
    expect(h.mails).toHaveLength(1);
    const m = h.mails[0];
    expect(m.to).toBe("thandi@example.com");
    expect(m.subject).toBe("Your order LEV — [LEV item l0]");
    expect(m.text).toContain("Hi Thandi,");
    expect(m.text).toContain("1. Club Tee Navy — R240 — https://marathonclub.co.za/products/club-tee-navy");
    expect(m.text).toContain("2. Club Tee Sand — R300 — https://marathonclub.co.za/products/club-tee-sand");
    expect(m.text).toMatch(/"credit" for store credit of R250, or "refund" for a refund of R250/);
    expect(conv(f)).toMatchObject({ state: "offering", outbound: 1, email: "thandi@example.com", tag: "[LEV item l0]" });
    // A second tick never opens another conversation or resends.
    await h.run();
    expect(h.mails).toHaveLength(1);
  });

  it("WhatsApp goes too only when the gateway says it is connected and the order has a phone", async () => {
    const off = harness(fakeDb(world()), { connected: false });
    await off.run();
    expect(off.wa).toEqual([]);
    const on = harness(fakeDb(world()), { connected: true });
    await on.run();
    expect(on.wa).toHaveLength(1);
    expect(on.wa[0].to).toBe("+27820000000");
    expect(on.wa[0].text).toMatch(/reply to the email/);
  });

  it("no email on the order → no conversation with the customer; Junid is told", async () => {
    const f = fakeDb(world({ order: { customer: { name: "X", phone: "+2782" } } }));
    const h = harness(f);
    await h.run();
    expect(h.mails).toEqual([]);
    expect(h.junid[0].subject).toMatch(/no email/);
    expect(conv(f).state).toBe("no_contact");
  });

  it("model words carrying a link or a price are refused — the plain wording goes instead", async () => {
    const f = fakeDb(world());
    const h = harness(f, { model: { words: async () => ({ opening: "Sorry! Try https://evil.example for R10", closing: "Bye" }), classify: async () => ({}) } });
    await h.run();
    expect(h.mails[0].text).not.toContain("evil");
    expect(h.mails[0].text).toContain(fallbackWords("offer").opening);
  });
});

describe("replies — read by code first", () => {
  it("'1' → swap to the cheaper alternative; the R10 difference becomes store credit; line back on the path; old hold released", async () => {
    const f = fakeDb({ ...world(), online_reservations: { TEE: { M: { 9001: { qty: 1, ref: "LEV" } } } } });
    const h = harness(f, { scopes: ["write_store_credit_account_transactions"] });
    await h.run();
    h.deps.inbox.replies = async () => [reply("1\n\nOn Tue, Marathon wrote:\n> Hi Thandi")];
    await h.run({ inbox: h.deps.inbox });
    const l = line(f);
    expect(l).toMatchObject({ pid: "ALT1", title: "Club Tee Navy", unitPriceCents: 24000, originalUnitPriceCents: 25000, source: { locationId: "marathon-pe", status: "display" } });
    expect(l.escalation).toBeUndefined();
    expect(l.resolution.money).toMatchObject({ kind: "credit", amountCents: 1000, state: "done", via: "api" });
    expect(f.read("online_reservations/TEE/M/9001")).toBeNull();
    expect(h.mails.at(-1).text).toMatch(/R10 goes back to you as store credit/);
    expect(h.junid.some((m) => /store credit R10 issued/.test(m.subject))).toBe(true);
    expect(f.read("online_escalations/9001_0")).toBeNull();
  });

  it("a dearer pick is refused politely and the choice re-offered — never charged more", async () => {
    const f = fakeDb(world());
    const h = harness(f);
    await h.run();
    await h.run({ inbox: { replies: async () => [reply("2")] } });
    expect(line(f).pid).toBe("TEE");
    expect(line(f).resolution.money).toBeUndefined();
    expect(h.mails.at(-1).text).toMatch(/costs R50 more than what you paid, and we'll never ask you to pay more/);
    expect(h.mails.at(-1).text).toContain("Your choices again:");
    expect(conv(f).state).toBe("offering");
  });

  it("'credit' with the scope missing → the slot is claimed once and Junid is emailed the exact order and amount", async () => {
    const f = fakeDb(world());
    const h = harness(f, { scopes: [] });
    await h.run();
    await h.run({ inbox: { replies: async () => [reply("Credit please")] } });
    expect(line(f).resolution.money).toMatchObject({ kind: "credit", amountCents: 25000, state: "manual", via: "junid_email", missingScope: "write_store_credit_account_transactions" });
    expect(line(f).source).toEqual({ status: "resolved" });
    const j = h.junid.find((m) => /store credit R250/.test(m.subject));
    expect(j.subject).toMatch(/BY HAND/);
    expect(j.text).toMatch(/#1801/);
    expect(h.gql).toEqual([]);
  });

  it("free text goes to ONE model classification, validated by code", async () => {
    const f = fakeDb(world());
    const h = harness(f, { model: { words: async () => ({}), classify: async () => ({ intent: "refund" }) } });
    await h.run();
    await h.run({ inbox: { replies: async () => [reply("Honestly I'd just like my money back thanks")] } });
    expect(line(f).resolution.money).toMatchObject({ kind: "refund", amountCents: 25000 });
    expect(h.mails.at(-1).text).toMatch(/It is being processed/);
  });

  it("an unclear reply seen on two ticks is answered once (the reply is claimed)", async () => {
    const f = fakeDb(world());
    const h = harness(f);
    await h.run();
    const inbox = { replies: async () => [reply("hmm what is this", 5)] };
    await h.run({ inbox });
    await h.run({ inbox });
    expect(h.mails).toHaveLength(2);
    expect(conv(f).outbound).toBe(2);
  });

  it("two agent runs at once open ONE conversation and send ONE offer", async () => {
    const f = fakeDb(world());
    const h = harness(f);
    await Promise.all([h.run(), h.run()]);
    expect(h.mails).toHaveLength(1);
    expect(conv(f).outbound).toBe(1);
  });

  it("the same reply is acted on once, however many ticks see it", async () => {
    const f = fakeDb(world());
    const h = harness(f);
    await h.run();
    const inbox = { replies: async () => [reply("credit")] };
    await h.run({ inbox });
    await h.run({ inbox });
    expect(h.junid.filter((m) => /store credit/.test(m.subject))).toHaveLength(1);
  });
});

describe("no reply in 48 hours", () => {
  it("store credit automatically, the customer told, refund still open 14 days → a later 'refund' goes to Junid, never a second money action", async () => {
    const f = fakeDb(world());
    const h = harness(f);
    await h.run();
    await h.run({ nowMs: async () => NOW + 47 * H });
    expect(line(f).resolution.money).toBeUndefined();
    await h.run({ nowMs: async () => NOW + 48 * H });
    expect(line(f).resolution.money).toMatchObject({ kind: "credit", amountCents: 25000 });
    expect(conv(f).state).toBe("credited_window");
    expect(h.mails.at(-1).text).toMatch(/reply "refund" within 14 days/);
    await h.run({ nowMs: async () => NOW + 72 * H, inbox: { replies: async () => [reply("refund", 9)] } });
    expect(line(f).resolution.money.kind).toBe("credit"); // untouched — never both
    expect(line(f).resolution.refundRequestedAfterCredit).toBeTruthy();
    expect(h.junid.at(-1).subject).toMatch(/swap the store credit for a refund/);
    expect(conv(f).outbound).toBe(3);
  });
});

describe("GUARDS — each test fails if its guard is removed", () => {
  it("credit and refund can never both be issued on one line", async () => {
    const f = fakeDb(world());
    const h = harness(f, { scopes: ["write_store_credit_account_transactions", "write_orders"] });
    const order = f.read("online_orders/9001");
    const ctx = { ...h.deps, get: async (p) => f.read(p), now: NOW, log: () => {}, summary: { credits: 0, refunds: 0, junid: 0 } };
    const first = await money(ctx, "9001", order, 0, line(f), "credit", 25000, "test");
    expect(first).toBeTruthy();
    const second = await money(ctx, "9001", order, 0, line(f), "refund", 25000, "test");
    expect(second).toBeNull();
    const again = await money(ctx, "9001", order, 0, line(f), "credit", 1, "test");
    expect(again).toBeNull();
    expect(h.gql.filter((g) => /mutation/.test(g.q))).toHaveLength(1);
  });

  it("never more than the line's paid value", () => {
    expect(moneyAllowed(null, { kind: "credit", amountCents: 25001, line: unavailableLine() }).ok).toBe(false);
    expect(moneyAllowed(null, { kind: "refund", amountCents: 25000, line: unavailableLine() }).ok).toBe(true);
    expect(moneyAllowed(null, { kind: "credit", amountCents: 0, line: unavailableLine() }).ok).toBe(false);
    // A swapped line's ceiling is what was PAID, not the new price.
    expect(moneyAllowed(null, { kind: "credit", amountCents: 25000, line: unavailableLine({ unitPriceCents: 24000, originalUnitPriceCents: 25000 }) }).ok).toBe(true);
    expect(moneyAllowed({ kind: "credit", amountCents: 1 }, { kind: "credit", amountCents: 1, line: unavailableLine() }).ok).toBe(false);
  });

  it(`never more than ${MAX_OUTBOUND} outbound messages per line`, async () => {
    const f = fakeDb(world());
    const h = harness(f);
    await h.run();
    // Three unclear replies in a row: re-offers until the cap, then Junid.
    for (let n = 1; n <= 4; n++) await h.run({ inbox: { replies: async () => [reply("what is this?", n)] } });
    expect(h.mails).toHaveLength(MAX_OUTBOUND);
    expect(conv(f).outbound).toBe(MAX_OUTBOUND);
    expect(h.junid.some((m) => /used its 3 messages/.test(m.subject))).toBe(true);
    expect(canSend({ outbound: MAX_OUTBOUND })).toBe(false);
    expect(canSend({ outbound: MAX_OUTBOUND - 1 })).toBe(true);
  });

  it("a dearer swap is refused by code whatever the model says", () => {
    expect(judgeSwap(unavailableLine(), { priceCents: 25001 })).toEqual({ ok: false, why: "costs_more", extraCents: 1 });
    expect(judgeSwap(unavailableLine(), { priceCents: 25000 })).toEqual({ ok: true, creditCents: 0 });
    expect(judgeSwap(unavailableLine({ qty: 2 }), { priceCents: 20000 })).toEqual({ ok: true, creditCents: 10000 });
  });

  it("one conversation per line: a swapped item that fails again goes to Junid, not the customer", async () => {
    const f = fakeDb(world({ line: unavailableLine({ swappedFrom: { title: "Club Tee" }, resolution: { conversation: { state: "closed", outbound: 2, email: "thandi@example.com" } } }) }));
    const h = harness(f);
    await h.run();
    expect(h.mails).toEqual([]);
    expect(h.junid[0].subject).toMatch(/swapped item is unavailable too/);
    await h.run();
    expect(h.junid).toHaveLength(1);
  });
});

describe("reply parsing (code)", () => {
  it.each([
    ["1", { kind: "pick", n: 1 }], ["  2. ", { kind: "pick", n: 2 }], ["Option 3", null], ["option 2", { kind: "pick", n: 2 }],
    ["9", null], ["credit", { kind: "credit" }], ["Credit please", { kind: "credit" }], ["REFUND!", { kind: "refund" }],
    ["credit or refund?", null], ["I want the blue one", null], ["", null],
  ])("%j → %j", (text, want) => expect(parseReplyCode(text, 2)).toEqual(want));
  it("quoted history is ignored", () => {
    expect(stripQuoted("2\n\nOn Tue 21 Oct, Marathon wrote:\n> 1. Navy")).toBe("2");
    expect(parseReplyCode("refund\n> reply credit for store credit", 2)).toEqual({ kind: "refund" });
  });
  it("the model's classification is validated", () => {
    expect(validateClassification({ intent: "pick", n: 5 }, 2)).toEqual({ kind: "unclear" });
    expect(validateClassification({ intent: "pick", n: 2 }, 2)).toEqual({ kind: "pick", n: 2 });
    expect(validateClassification({ intent: "delete-everything" }, 2)).toEqual({ kind: "unclear" });
    expect(validateClassification(null, 2)).toEqual({ kind: "unclear" });
  });
  it("model text with links, money or emails is refused", () => {
    expect(acceptModelText("Sorry about that!")).toBe("Sorry about that!");
    expect(acceptModelText("see www.x.com")).toBeNull();
    expect(acceptModelText("we owe you R250")).toBeNull();
    expect(acceptModelText("mail me@x.com")).toBeNull();
    expect(acceptModelText("x".repeat(601))).toBeNull();
  });
  it("paidCents and the message facts", () => {
    expect(paidCents(unavailableLine({ qty: 2 }))).toBe(50000);
    const m = composeMessage("credit", { ref: "LEV", firstName: null, line: unavailableLine(), amountCents: 25000, words: fallbackWords("credit") });
    expect(m.text).toContain("Store credit: R250, for Club Tee, size M.");
  });
});
