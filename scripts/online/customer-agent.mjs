#!/usr/bin/env node
// ── The website-order customer agent (Mac mini) ─────────────────────────────
// One tick of agent/run.mjs against the live database, Shopify, the shop
// mailbox and the WhatsApp gateway. launchd runs it every 5 minutes
// (com.marathon.customeragent). docs/ONLINE-CUSTOMER-AGENT.md.
//
//   node scripts/online/customer-agent.mjs             dry run: reads everything,
//                                                      sends nothing, writes nothing
//   node scripts/online/customer-agent.mjs --commit    the real tick
//   node scripts/online/customer-agent.mjs --synthetic one end-to-end dry run on a
//        SYNTHETIC unavailable line (in memory): real alternatives, real model,
//        real email to CUSTOMER_AGENT_TEST_EMAIL only, a simulated reply.
//        Nothing is written to the database and no customer is contacted.
//
// Credentials, never printed: Shopify via scripts/shopify/env.mjs (.env);
// Firebase Admin via ADC; mail = the shop mailbox (CARD_RECON_IMAP_USER /
// CARD_RECON_IMAP_PASSWORD, .env); ANTHROPIC_API_KEY (.env);
// ~/.config/marathon/customer-agent.env: BROADCAST_SERVICE_TOKEN (WhatsApp
// gateway), CUSTOMER_AGENT_TEST_EMAIL (the synthetic run's only recipient),
// CUSTOMER_AGENT_ANTHROPIC_API_KEY (preferred over .env's ANTHROPIC_API_KEY).
import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { graphql } from "../shopify/client.mjs";
import "../shopify/env.mjs";
import { serverNowMs } from "../shopify/publishNode.mjs";
import { recordingDb } from "../shopify/onlineOrders/recordingDb.mjs";
import { fakeDb } from "../shopify/onlineOrders/fakeDb.testutil.mjs";
import { runCustomerAgent, AGENT_META } from "./agent/run.mjs";
import { findAlternatives, listingTitle, offerStillAvailable } from "./agent/alternatives.mjs";
import { grantedScopes } from "./agent/money.mjs";

const COMMIT = process.argv.includes("--commit");
const SYNTHETIC = process.argv.includes("--synthetic");
if (COMMIT && SYNTHETIC) { console.error("✗ --synthetic is a dry run; it never takes --commit"); process.exit(2); }
const NOTIFY_TO = "junidmoh@gmail.com"; // Junid's alarm inbox — fixed here, never from .env
const MODEL = "claude-sonnet-5-5";
const GATEWAY = "http://127.0.0.1:8080";
const REPO = new URL("../../", import.meta.url).pathname;
const LOG = join(REPO, "logs", "customer-agent.log");

// ~/.config/marathon/customer-agent.env (KEY=VALUE), real env wins.
const extraEnv = join(homedir(), ".config", "marathon", "customer-agent.env");
if (existsSync(extraEnv)) {
  for (const raw of readFileSync(extraEnv, "utf8").split("\n")) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

function logLine(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  if (!COMMIT && !SYNTHETIC) return;
  try { mkdirSync(join(REPO, "logs"), { recursive: true }); appendFileSync(LOG, `${stamped}\n`); } catch { /* stdout has it */ }
}

const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const crRequire = createRequire(new URL("../cardrecon/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const liveDb = admin.database();

// ── mail (the shop mailbox) ──────────────────────────────────────────────────
function smtp() {
  const user = process.env.CARD_RECON_IMAP_USER, pass = process.env.CARD_RECON_IMAP_PASSWORD;
  if (!user || !pass) return null;
  const nodemailer = crRequire("nodemailer");
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
  return { user, send: (m) => t.sendMail({ from: `Marathon Club <${user}>`, replyTo: user, ...m }) };
}

// ── inbound replies: IMAP on the shop mailbox, read-only (never sets \Seen) ──
function imapInbox() {
  const user = process.env.CARD_RECON_IMAP_USER, pass = process.env.CARD_RECON_IMAP_PASSWORD;
  if (!user || !pass) return null;
  const { ImapFlow } = crRequire("imapflow");
  const { simpleParser } = crRequire("mailparser");
  return {
    async replies({ email, tag, sinceMs }) {
      const client = new ImapFlow({ host: process.env.CARD_RECON_IMAP_HOST || "imap.gmail.com", port: Number(process.env.CARD_RECON_IMAP_PORT || 993), secure: true, auth: { user, pass }, logger: false });
      await client.connect();
      const out = [];
      const lock = await client.getMailboxLock(process.env.CARD_RECON_IMAP_MAILBOX || "INBOX");
      try {
        const uids = await client.search({ since: new Date(sinceMs - 86400e3), from: email }, { uid: true });
        if (uids?.length) {
          for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
            const subject = msg.envelope?.subject || "";
            if (!subject.includes(tag)) continue;
            const parsed = await simpleParser(msg.source);
            // The EXACT sender (IMAP's FROM search is a substring match).
            const sender = String(parsed.from?.value?.[0]?.address || "").toLowerCase();
            if (sender !== String(email).toLowerCase()) continue;
            const when = parsed.date ? parsed.date.getTime() : 0;
            if (when && when < sinceMs) continue;
            const id = parsed.messageId || `uid-${msg.uid}`;
            out.push({ id, key: createHash("sha1").update(id).digest("hex").slice(0, 20), text: parsed.text || "", date: when });
          }
        }
      } finally { lock.release(); await client.logout().catch(() => {}); }
      return out;
    },
  };
}

// ── WhatsApp gateway (marathon-broadcast-service on this mini) ───────────────
function gateway() {
  const token = process.env.BROADCAST_SERVICE_TOKEN;
  if (!token) return null;
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    status: async () => { const r = await fetch(`${GATEWAY}/api/status`, { headers: h, signal: AbortSignal.timeout(5000) }); return r.ok ? r.json() : { connected: false }; },
    send: async (to, message) => { const r = await fetch(`${GATEWAY}/api/message`, { method: "POST", headers: h, body: JSON.stringify({ to, message }), signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`gateway HTTP ${r.status}`); },
  };
}

// ── the model: words and one classification, nothing else ───────────────────
async function claude(system, user, schema, maxTokens = 400) {
  // The agent's own key first (customer-agent.env): the repo .env's key can be
  // a different project's and was found revoked on 2026-10-21.
  const key = process.env.CUSTOMER_AGENT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no Anthropic key (CUSTOMER_AGENT_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, output_config: { format: { type: "json_schema", schema } }, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`claude HTTP ${res.status}`);
  const p = await res.json();
  const text = (p.stop_reason === "refusal" ? [] : p.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}
const WORDS_SCHEMA = { type: "object", properties: { opening: { type: "string" }, closing: { type: "string" } }, required: ["opening", "closing"], additionalProperties: false };
const CLASSIFY_SCHEMA = { type: "object", properties: { intent: { type: "string", enum: ["pick", "credit", "refund", "unclear"] }, n: { type: "integer" } }, required: ["intent", "n"], additionalProperties: false };
const WHAT = {
  offer: "the item they ordered turned out not to be available; we are offering alternatives (listed separately)",
  costs_more: "they picked an alternative that costs more than they paid; we won't charge more, so we're re-offering",
  swapped: "we swapped the item for the alternative they chose",
  credit: "they chose store credit for the missing item; it is being arranged",
  refund: "we started the refund they asked for",
  auto_credit: "they didn't reply within 48 hours so store credit is being arranged automatically",
  unclear: "we couldn't tell what they wanted from their reply; we're asking again",
  gone: "the alternative they picked has just sold out; we're re-offering",
  refund_after_credit: "they asked for a refund instead of the store credit; we're arranging it",
};
const model = {
  words: (kind, { firstName }) => claude(
    "You write the opening and closing sentences of a short customer-service email for a clothing and sneaker shop in South Africa. Warm, plain English, sincere, no exclamation-mark gushing. Never name a brand, a product, a price, an amount, a link or an email address — those are added by the shop separately. Opening: 1–2 sentences. Closing: 1 short sentence. No greeting line and no signature.",
    `Situation: ${WHAT[kind] || WHAT.unclear}. Customer's first name: ${firstName || "unknown"} (do not use it; the greeting is added separately).`,
    WORDS_SCHEMA,
  ),
  classify: (text, offers) => claude(
    "Classify a customer's email reply about an unavailable item. They were offered numbered alternatives, store credit, or a refund. Answer pick (with n = the number they chose), credit, refund, or unclear. If in any doubt, unclear. n = 0 unless intent is pick.",
    `Options offered: ${offers.map((o, i) => `${i + 1}. ${o.title}`).join("; ") || "(none)"}\n\nTheir reply:\n"""${String(text).slice(0, 2000)}"""`,
    CLASSIFY_SCHEMA, 100,
  ),
};

// ── the daily summary to Junid (first tick after 18:00 SAST) ────────────────
async function dailySummary(db, nowMs, send) {
  const sa = new Date(nowMs + 2 * 3600e3);
  if (sa.getUTCHours() < 18) return;
  const day = sa.toISOString().slice(0, 10);
  const last = (await db.ref(`${AGENT_META}/lastSummary`).get()).val() || {};
  if (last.day === day) return;
  // Everything since the previous summary — the evening after 18:00 included
  // (it lands in YESTERDAY's day node, read here too).
  const since = Number(last.at) || 0;
  const yday = new Date(nowMs + 2 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  const events = [];
  for (const d of [yday, day]) events.push(...Object.values((await db.ref(`${AGENT_META}/days/${d}`).get()).val() || {}));
  const fresh = events.filter((e) => Number(e.at) > since && Number(e.at) <= nowMs).sort((a, b) => a.at - b.at);
  const lines = fresh.length
    ? fresh.map((e) => `${new Date(e.at + 2 * 3600e3).toISOString().slice(5, 16).replace("T", " ")}  ${e.ref} line ${Number(e.lineIndex) + 1}: ${e.action}${e.note ? ` — ${e.note}` : ""}`)
    : ["No customer-agent activity since the last summary."];
  await send({ subject: `Website orders — customer agent, ${day}`, text: lines.join("\n") });
  await db.ref(`${AGENT_META}/lastSummary`).set({ day, at: nowMs });
}

// ── synthetic: an in-memory line, real everything else, one test inbox ──────
async function synthetic() {
  const to = process.env.CUSTOMER_AGENT_TEST_EMAIL;
  if (!to) { console.error("✗ CUSTOMER_AGENT_TEST_EMAIL is not set (~/.config/marathon/customer-agent.env)"); process.exit(2); }
  const pid = process.argv.find((a) => a.startsWith("--pid="))?.split("=")[1];
  const size = process.argv.find((a) => a.startsWith("--size="))?.split("=")[1];
  if (!pid || !size) { console.error("✗ --synthetic needs --pid=<app product id> --size=<size> (a real product, read-only)"); process.exit(2); }
  const product = (await liveDb.ref(`products/${pid}`).get()).val();
  const sync = (await liveDb.ref(`shopify_sync/${pid}/shopifyProductId`).get()).val();
  if (!product || !sync) { console.error(`✗ ${pid} is not a synced product`); process.exit(2); }
  const priceCents = Math.round(Number(product.price ?? product.retailPrice ?? 0) * 100) || 50000;
  const line = { lineId: "l0", shopifyLineItemId: "gid://shopify/LineItem/0", productGid: sync, pid, size, sizeKey: size, qty: 1, title: product.name, unitPriceCents: priceCents, isFootwear: /foot|sneaker|slide/i.test(`${product.category} ${product.categoryKey}`), source: { status: "unavailable" }, escalation: { phase: "unavailable" } };
  const mem = fakeDb({
    online_orders: { SYNTH: { ref: "TST", shopifyGid: "gid://shopify/Order/0", shopifyName: "#TEST", status: "picking", customer: { name: "Junid Test", email: to }, totals: { currency: "ZAR" }, lines: [line] } },
    online_escalations: { SYNTH_0: { orderId: "SYNTH", lineIndex: 0, ref: "TST", phase: "unavailable" } },
  });
  // Reads not in memory go to the live database (read-only); writes stay in memory.
  const db = { ref: (path) => {
    const m = mem.db.ref(path);
    return { ...m, get: async () => (mem.read(path) != null || /^(online_orders|online_escalations|online_orders_meta|online_reservations|shopify_inventory_dirty)/.test(path) ? m.get() : liveDb.ref(path).get()) };
  } };
  const out = smtp();
  const sent = [];
  const deps = {
    db, nowMs: async () => Date.now(), increment: (n) => ({ ".sv": { increment: n } }), log: logLine,
    mailer: async (m) => { if (m.to !== to) throw new Error("synthetic run: refusing a recipient that is not the test address"); sent.push(m); await out.send(m); },
    notifyJunid: async (m) => { sent.push({ to: "Junid (shown, not sent)", ...m }); },
    whatsapp: null, model,
    inbox: { replies: async () => [] },
    findAlternatives: ({ line: l, orderId }) => findAlternatives({ graphql, get: async (p) => (await liveDb.ref(p).get()).val(), line: l, orderId }),
    listingTitle: (l) => listingTitle(graphql, l),
    scopes: async () => grantedScopes(graphql),
    graphql: async () => { throw new Error("synthetic run: no Shopify money call is made"); },
  };
  logLine(`SYNTHETIC: ${product.name} size ${size} → ${to}`);
  await runCustomerAgent(deps);
  const offers = Object.values(mem.read("online_orders/SYNTH/lines/0/resolution/conversation/offers") || {});
  // The customer "replies" with the cheapest offer that does not cost more, else "credit".
  const ok = offers.findIndex((o) => o.priceCents <= priceCents);
  const replyText = ok >= 0 ? `${ok + 1}` : "credit";
  logLine(`SYNTHETIC: simulated reply "${replyText}"`);
  await runCustomerAgent({ ...deps, inbox: { replies: async () => [{ id: "<synthetic@reply>", key: "synthetic", text: replyText, date: Date.now() }] } });
  for (const m of sent) logLine(`SENT to ${m.to}: ${m.subject}\n${m.text}\n`);
  logLine(`SYNTHETIC: line log ${JSON.stringify(Object.values(mem.read("online_orders/SYNTH/lines/0/resolution/log") || {}).map((e) => e.action))}`);
  process.exit(0);
}

if (SYNTHETIC) await synthetic();

const mail = smtp();
const db = COMMIT ? liveDb : recordingDb(liveDb, (l) => console.log(`  [dry] ${l}`));
let scopeCache = null;
try {
  const summary = await runCustomerAgent({
    db,
    nowMs: () => serverNowMs(liveDb),
    increment: (n) => admin.database.ServerValue.increment(n),
    log: logLine,
    mailer: COMMIT ? (m) => mail.send(m) : async (m) => console.log(`  [dry] would email ${m.to}: ${m.subject}`),
    notifyJunid: COMMIT ? (m) => mail.send({ to: NOTIFY_TO, ...m }) : async (m) => console.log(`  [dry] would email Junid: ${m.subject}`),
    whatsapp: COMMIT ? gateway() : null,
    model,
    inbox: imapInbox(),
    findAlternatives: ({ line, orderId }) => findAlternatives({ graphql, get: async (p) => (await liveDb.ref(p).get()).val(), line, orderId }),
    listingTitle: (l) => listingTitle(graphql, l),
    offerStillAvailable: (a) => offerStillAvailable({ get: async (p) => (await liveDb.ref(p).get()).val(), ...a }),
    scopes: async () => (scopeCache ??= await grantedScopes(graphql)),
    graphql,
  });
  if (COMMIT && mail) await dailySummary(liveDb, await serverNowMs(liveDb), (m) => mail.send({ to: NOTIFY_TO, ...m })).catch((e) => logLine(`✗ daily summary: ${e.message}`));
  const busy = summary.opened || summary.sent || summary.replies || summary.swaps || summary.credits || summary.refunds || summary.errors.length;
  if (summary.off) { logLine("agent: OFF (/config/onlineOrders/agentOff)"); process.exit(0); }
  logLine(busy ? `agent: ${summary.opened} opened · ${summary.sent} sent · ${summary.replies} replies · ${summary.swaps} swaps · ${summary.credits} credits · ${summary.refunds} refunds · ${summary.junid} to Junid${summary.errors.length ? ` · ${summary.errors.length} ERROR(S)` : ""}${COMMIT ? "" : " — DRY RUN"}` : `agent: quiet${COMMIT ? "" : " — DRY RUN"}`);
  process.exit(summary.errors.length ? 1 : 0);
} catch (e) {
  logLine(`✗ customer agent failed: ${String(e?.message || e)}`);
  process.exit(1);
}
