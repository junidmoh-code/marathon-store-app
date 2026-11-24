// ─── WEBSITE UNAVAILABLE LINES — Jamie's alternative offers (READ ONLY) ───────
//
//   node scripts/audit/web-unavailable/jamie-offers.mjs <cacheDir> [~/marathon-dm-agent/data/agent.db]
//
// Reads Jamie's own SQLite file with `sqlite3 -readonly` (no write is possible)
// and leaves <cacheDir>/jamie_offers.json: one record per line Jamie offered
// alternatives for, since order #1768. No database or network read at all.
//
// WHY SEVERAL TABLES. No one table is the history of an offer:
//   jimmy_offers          the latest state per (order, line, ordered product)
//   jimmy_sends           every message sent, with its ref "offer:<order>:<line>…"
//   jamie_offer_delivery  one row per round (the round times jimmy_offers overwrites)
//   alt_sent              the first set of options of each offer
//   alt_products          brand family per product (for "same brand or not")
//   sent                  the product photos sent on WhatsApp just before an offer
//   jimmy_voice_log       which model wrote each message
//   messages              what the customer said back
//   jamie_ship_without / jamie_line_choices   how a decline or a silence was settled
//
// PRIVACY. Phone numbers, emails and names are used only to join the tables
// and are NOT written to the output. A customer's own words are kept (they are
// the answer to "what did they say when declining"), cut to 220 characters.
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CACHE = process.argv[2];
const DB = process.argv[3] || join(homedir(), "marathon-dm-agent", "data", "agent.db");
if (!CACHE) { console.error("usage: jamie-offers.mjs <cacheDir> [agent.db]"); process.exit(2); }
const FIRST_ORDER = 1768;
const q = (sql) => { const out = execFileSync("sqlite3", ["-readonly", "-json", DB, sql], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }); return out.trim() ? JSON.parse(out) : []; };
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
// Email addresses and long digit runs (phone numbers, confirmation codes) never leave this file.
const cut = (s, n = 220) => String(s || "").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\+?\d[\d ]{8,}\d/g, "[number]").replace(/\s+/g, " ").trim().slice(0, n);
const SAST = 2 * 3600e3;

const offers = q("select * from jimmy_offers").filter((r) => Number(String(r.order_number).replace(/\D/g, "")) >= FIRST_ORDER);
const sends = q("select id, channel, person, kind, sub, text, at, ref, wa_mid, ack from jimmy_sends where ref like 'offer%'");
const acks = new Map(q("select mid, ack, delivered_at, read_at from jimmy_wa_acks").map((a) => [a.mid, a]));
const rounds = q("select order_key, line_index, pid, round_at, state, delivered_at, ack from jamie_offer_delivery");
const altSent = q("select order_key, line_index, pid_out, picks, at, outcome, picked_pid from alt_sent order by at");
const brand = new Map(q("select pid, brand, brand_family, category_key, price_cents from alt_products").map((p) => [p.pid, p]));
const voice = q("select at, channel, refs, model from jimmy_voice_log where kinds like '%offer%' and outcome = 'sent'");
const shipWithout = new Map(q("select order_key, line_index, pid, why, state from jamie_ship_without").map((r) => [`${r.order_key}:${r.line_index}:${r.pid}`, r]));
const choices = new Map(q("select order_key, line_index, choice, state from jamie_line_choices").map((r) => [`${r.order_key}:${r.line_index}`, r]));

// "offer:<order>:<line>[+<line>…][:r<N>][:followup|:reply]" → { key, lines, tail }
const parseRef = (ref) => { const m = /^offer(?:-followup)?:([^:]+):([\d+]+)(.*)$/.exec(ref || ""); return m ? { key: m[1], lines: m[2].split("+").map(Number), tail: m[3] || "", followup: /followup/.test(ref) } : null; };
const sendsBy = new Map();
for (const s of sends) { const r = parseRef(s.ref); if (!r) continue; for (const line of r.lines) { const k = `${r.key}:${line}`; if (!sendsBy.has(k)) sendsBy.set(k, []); sendsBy.get(k).push({ ...s, ...r }); } }
const threadMsgs = (thread, from, to) => q(`select role, text, at from messages where thread = '${String(thread).replace(/'/g, "''")}' and at > ${from} and at < ${to} order by at limit 40`);
const photosIn = (thread, from, to) => q(`select count(*) n from sent where thread = '${String(thread).replace(/'/g, "''")}' and at > ${from} and at < ${to} and ref like '%"type":"product"%'`)[0]?.n || 0;

const out = [];
for (const r of offers) {
  const k = `${r.order_key}:${r.line_index}`;
  const mine = (sendsBy.get(k) || []).sort((a, b) => a.at - b.at);
  const offerMsgs = mine.filter((s) => s.kind === "lifecycle" && !s.followup && !/followup/.test(s.sub || ""));
  const first = offerMsgs[0] || null;
  const myRounds = rounds.filter((x) => x.order_key === r.order_key && x.line_index === r.line_index && x.pid === r.pid).sort((a, b) => a.round_at - b.round_at);
  const firstOfferAt = first?.at || myRounds[0]?.round_at || r.offered_at || null;
  const channel = first?.channel || r.channel || "";
  const thread = channel === "email" ? (r.email ? `email:${r.email}` : null) : (r.phone ? `whatsapp:${r.phone}` : null);
  const waThread = r.phone ? `whatsapp:${r.phone}` : null;
  const settleAt = r.answered_at || (firstOfferAt ? firstOfferAt + 10 * 864e5 : null);
  // The customer's words: on the offer's own channel and, for an emailed offer, on WhatsApp too.
  let replies = [];
  if (firstOfferAt) for (const t of new Set([thread, waThread, r.email ? `email:${r.email}` : null].filter(Boolean))) replies.push(...threadMsgs(t, firstOfferAt, (settleAt || firstOfferAt) + 6 * 3600e3).filter((m) => m.role === "user"));
  replies.sort((a, b) => a.at - b.at);
  const firstSet = J(altSent.find((a) => a.order_key === r.order_key && a.line_index === r.line_index && a.pid_out === r.pid)?.picks, null);
  const all = J(r.offers, []);
  const set = (firstSet && firstSet.length ? firstSet : all.slice(0, 3)).map((o) => ({ pid: o.pid, name: o.name, priceCents: Number(o.priceCents) || null }));
  const myBrand = brand.get(r.pid)?.brand_family || brand.get(r.pid)?.brand || null;
  const sameBrand = set.map((o) => { const b = brand.get(o.pid)?.brand_family || brand.get(o.pid)?.brand || null; return myBrand && b ? b === myBrand : null; });
  const diffs = set.map((o) => (o.priceCents != null && r.price_cents ? o.priceCents - r.price_cents : null)).filter((x) => x != null);
  const ack = first?.wa_mid ? acks.get(first.wa_mid) : null;
  const photoCount = channel === "whatsapp" && waThread && firstOfferAt ? photosIn(waThread, firstOfferAt - 4 * 60e3, firstOfferAt + 60e3) : 0;
  const v = first ? voice.filter((x) => (x.refs || "").includes(`offer:${r.order_key}:`) && Math.abs(x.at - first.at) < 90e3)[0] : null;
  const sw = shipWithout.get(`${r.order_key}:${r.line_index}:${r.pid}`);
  const ch = choices.get(k);
  const note = String(r.note || "");
  const replied = replies.length > 0;
  let result;
  if (["applied", "awaiting_pay"].includes(r.state)) result = "accepted";
  else if (/^credit/.test(r.state)) result = /timeout/.test(sw?.why || note) ? "no_reply" : "declined";
  else if (r.state === "expired") result = replied ? "declined" : "no_reply";
  else if (r.state === "waiting") result = "declined"; // chose to wait for the item itself
  else if (r.state === "withdrawn") result = /refund/i.test(note) ? "declined" : /cancel/i.test(note) ? "cancelled" : /by hand/i.test(note) ? "by_hand" : "withdrawn";
  else if (r.state === "offered") result = firstOfferAt && Date.now() - firstOfferAt < 48 * 3600e3 ? "pending" : replied ? "declined" : "no_reply";
  else result = "other";
  const pickedOpt = r.picked ? all[r.picked - 1] : null;
  out.push({
    orderKey: r.order_key, line: r.line_index, pid: r.pid, orderNumber: r.order_number, item: cut(r.item, 80), size: r.size, kind: r.kind, reason: cut(r.reason, 80),
    state: r.state, result, settledHow: sw?.why ? `ship without: ${cut(sw.why, 60)}` : ch?.choice ? `chose ${ch.choice}` : cut(note, 90),
    firstOfferAt, channel, rounds: Math.max(myRounds.length, offerMsgs.length, 1), messagesSent: mine.length,
    followUps: mine.filter((s) => s.followup || /followup/.test(s.sub || "")).length,
    delivered: ack ? ack.ack >= 2 : null, read: ack ? ack.ack >= 3 || !!ack.read_at : null,
    optionsFirst: set.length, optionsTotal: all.length,
    sameBrandOptions: sameBrand.filter((x) => x === true).length, brandKnown: sameBrand.some((x) => x != null),
    paidCents: r.price_cents || null, priceDiffs: diffs, allSamePrice: diffs.length ? diffs.every((d) => d === 0) : null, anyDearer: diffs.some((d) => d > 0), anyCheaper: diffs.some((d) => d < 0),
    photos: channel === "whatsapp" ? photoCount : (/photos? (above|attached)/i.test(first?.text || r.text || "") ? -1 : 0), // -1 = the email says "photos attached" (attachments are not logged)
    model: v?.model || null,
    hourSast: firstOfferAt ? new Date(firstOfferAt + SAST).getUTCHours() : null, weekday: firstOfferAt ? new Date(firstOfferAt + SAST).getUTCDay() : null,
    firstReplyAt: replies[0]?.at || null, answeredAt: r.answered_at || null,
    pickedDiffCents: pickedOpt?.priceCents != null && r.price_cents ? pickedOpt.priceCents - r.price_cents : null,
    pickedSameBrand: pickedOpt ? ((brand.get(pickedOpt.pid)?.brand_family || null) === myBrand && !!myBrand) : null,
    pickedNumber: r.picked || null,
    customerSaid: replies.slice(0, 4).map((m) => cut(m.text)),
    offerText: cut(first?.text || r.text, 400),
  });
}
writeFileSync(join(CACHE, "jamie_offers.json"), JSON.stringify({ at: Date.now(), offers: out }));
const cnt = (a) => a.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});
console.log(`offers since #${FIRST_ORDER}: ${out.length}`, cnt(out.map((o) => o.result)), cnt(out.map((o) => o.channel)), cnt(out.map((o) => String(o.model))));
