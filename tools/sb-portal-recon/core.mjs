// ─── SIMPLYBLU PORTAL → CARD RECON: THE PURE PART ────────────────────────────
// Everything here is decided without a browser, a network or a clock (the
// clock is passed in). run.mjs does the IO; the store app's callable
// (cardBatchCapture action "portalDay", functions/cardRecon/cardPortal.js)
// decides what is recorded.
//
// WHAT THE PORTAL IS, as read 2 Nov 2026:
//   • www.simplyblu.co.za — Standard Bank's merchant portal (Next.js, Firebase
//     sign-in). One login holds several STORES, one per merchant number
//     (header switcher: "CONCRETE 0005377331", "THE MARATHON 0004977890").
//   • Analytics → Reports → "Monthly Card POS - Terminal Batch Report" is an
//     embedded METABASE dashboard (dashboard 47). The portal hands the page a
//     signed embed link (JWT, ~1 hour, locked to the selected store's business
//     id) for https://metabasesbsaprod.littlefish.mobi/embed/dashboard/<jwt>.
//   • Metabase's embed API answers that link with JSON, no cookie needed:
//       GET /api/embed/dashboard/<jwt>                     → dashcards, parameters
//       GET /api/embed/dashboard/<jwt>/params/<id>/values  → every Terminal ID
//       GET /api/embed/dashboard/<jwt>/dashcard/<dc>/card/<card>?date_filter=A~B
//                                                          → { data: { cols, rows } }
//     The "Card POS Transactions" card has one row per transaction with its
//     TerminalId, time (to the minute, +02:00), type, status, amount, trace id
//     and auth code. No card number.
// So the browser is needed ONLY to be signed in and to be handed the embed
// link; the data is read as data, never scraped off the page.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const portalLib = require("../../functions/lib/card-portal.cjs");

export const PORTAL_ORIGIN = "https://www.simplyblu.co.za";
export const REPORT_URL = `${PORTAL_ORIGIN}/analytics/reports/single/?type=dashboard&name=Monthly+Card+POS+-+Terminal+Batch+Report&id=47`;
export const METABASE_HOST = "metabasesbsaprod.littlefish.mobi";
export const OWNER_EMAIL = "gunidmoh@gmail.com";
export const KEYCHAIN_SERVICE = "marathon-simplyblu";

// Exit codes launchd's log and the installer read.
export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,            // anything unexpected: the 18:20 catch-up runs again
  NEEDS_LOGIN: 20,      // signed out and no saved password (or it was refused)
  OTP_REQUIRED: 21,     // the portal asked for a one-time code this cannot supply
  ALREADY_DONE: 0,
});

/** The SAST calendar day of an instant, "YYYY-MM-DD". */
export function sastYmd(ms) {
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The days a run pulls: today and the two before it, never before 3 Nov 2026. */
export function daysToPull(nowMs, back = 2) {
  return portalLib.daysToPull(sastYmd(nowMs), back);
}

/** Metabase's date filter for one day. */
export const dateFilter = (ymd) => `${ymd}~${ymd}`;

/** The embed JWT out of an iframe src, or null. */
export function embedTokenFromSrc(src) {
  try {
    const u = new URL(src);
    if (u.host !== METABASE_HOST) return null;
    const m = /^\/embed\/dashboard\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(u.pathname);
    return m ? m[1] : null;
  } catch { return null; }
}

/** The JWT's payload (unverified — only to read which store and when it expires). */
export function embedClaims(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return { businessId: p?.params?.businessid ?? null, dashboard: p?.resource?.dashboard ?? null, expMs: Number.isFinite(p?.exp) ? p.exp * 1000 : null };
  } catch { return null; }
}

/**
 * The dashboard → which card holds the transactions and which parameter is
 * which, BY NAME (slug / card name), never by the ids seen on 2 Nov 2026.
 */
export function readDashboard(dash) {
  const params = Array.isArray(dash?.parameters) ? dash.parameters : [];
  const date = params.find((p) => p.slug === "date_filter" || /date/i.test(p.type || ""));
  const tid = params.find((p) => p.slug === "terminal_id" || /terminal/i.test(p.name || p.slug || ""));
  const cards = Array.isArray(dash?.dashcards) ? dash.dashcards : (Array.isArray(dash?.ordered_cards) ? dash.ordered_cards : []);
  const txn = cards.find((c) => c?.card && /transactions/i.test(c.card.name || "") && (c.card.display === "table" || !c.card.display));
  if (!date || !txn) return null;
  return { dateSlug: date.slug, tidParamId: tid ? tid.id : null, dashcardId: txn.id, cardId: txn.card_id ?? txn.card?.id };
}

/** Metabase's parameter values → the TIDs. */
export function tidsFromValues(v) {
  const vals = Array.isArray(v?.values) ? v.values : [];
  return vals.map((x) => (Array.isArray(x) ? x[0] : x)).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
}

/**
 * ONLY THE COLUMNS THE RECORD READS leave this machine — kept on disk or sent
 * to the callable. The portal's list has no card number today; if it ever
 * grows one, it is dropped here, not stored (Sonnet architect review, #837).
 */
export function projectColumns({ cols, rows }) {
  const ix = portalLib.columnIndex(cols);
  const keep = Object.values(ix).filter((i) => i >= 0);
  const uniq = [...new Set(keep)].sort((a, b) => a - b);
  return { cols: uniq.map((i) => cols[i]), rows: rows.map((r) => uniq.map((i) => (Array.isArray(r) ? r[i] : null))) };
}

/** Should the "pull failed" email go now? Once per outage, like the login one. */
export function shouldAlertFailure(state) {
  if (!state || !Number.isFinite(state.failAlertAt)) return true;
  return Number.isFinite(state.lastOkAt) && state.lastOkAt > state.failAlertAt;
}

export function failureAlert(reason) {
  return {
    to: OWNER_EMAIL,
    subject: "SimplyBLU portal pull failed on the Mac mini",
    text: [
      "Tonight's SimplyBLU pull (18:00 and the 18:20 catch-up) did not finish:",
      `  ${String(reason || "unknown").slice(0, 500)}`,
      "",
      "The Standard Bank tills show \"Awaiting portal data\" in Card Recon until a pull works — nothing is marked clean or short meanwhile. Tomorrow's 18:00 pull re-reads the last three days by itself.",
      "Log: ~/marathon-store-app/logs/sb-portal-recon.log on the Mac mini.",
      "",
      "Sent once; not repeated until a pull has worked again.",
    ].join("\n"),
  };
}

/** The card's answer → { cols, rows } in the shape the callable takes, or an error sentence. */
export function cardRows(json) {
  if (!json || typeof json !== "object") return { error: "The portal's report answered with nothing readable." };
  if (json.error) return { error: `The portal's report refused: ${String(json.error).slice(0, 200)}` };
  const cols = (json.data?.cols || []).map((c) => c.display_name || c.name || "");
  const rows = json.data?.rows;
  if (!Array.isArray(rows) || !cols.length) return { error: "The portal's report answered without rows." };
  return { cols, rows };
}

/**
 * The store switcher's text → the stores, by their merchant numbers. The menu
 * item reads "CONCRETE\n0005377331\nRole: Administrator".
 */
export function parseStoreItems(texts) {
  const out = [];
  for (const t of texts || []) {
    const lines = String(t || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const mi = lines.findIndex((l) => /^\d{7,15}$/.test(l));
    if (mi < 1) continue;
    const name = lines[mi - 1];
    if (!out.some((s) => s.merchantNo === lines[mi])) out.push({ name, merchantNo: lines[mi] });
  }
  return out;
}

/**
 * What the page in front of us is, from a few facts the browser reports.
 * `facts`: { url, hasEmbed, hasPassword, hasEmail, otpText, hasCodeInput }.
 */
export function classifyPage(facts) {
  if (facts.hasEmbed) return "report";
  // A page with a password field is the sign-in form, whatever else it says.
  if (facts.hasPassword) return "login";
  if (facts.otpText && facts.hasCodeInput) return "otp";
  if (facts.hasEmail) return "login";
  return "unknown";
}

/**
 * Should the "SimplyBLU needs a fresh login" email go now? ONCE per outage:
 * not again until a run has succeeded since the last one was sent.
 */
export function shouldAlert(state) {
  if (!state || !Number.isFinite(state.loginAlertAt)) return true;
  return Number.isFinite(state.lastOkAt) && state.lastOkAt > state.loginAlertAt;
}

/** The alert's text — what happened and the one thing to do. */
export function loginAlert({ kind, host = "the Mac mini" }) {
  const what = kind === "otp"
    ? "The SimplyBLU portal asked for a one-time PIN, which the Mac mini cannot type."
    : "The SimplyBLU portal signed the Mac mini out and there is no saved password it can use.";
  return {
    to: OWNER_EMAIL,
    subject: "SimplyBLU needs a fresh login on the Mac mini",
    text: [
      what,
      "",
      "Until someone signs in again, the Standard Bank tills (Marathon PE Till 2, Trophy Till 2, Concrete Till 1 and 2) show \"Awaiting portal data\" in Card Recon — nothing is marked clean or short in the meantime.",
      "",
      `To fix: on ${host} (Screen Sharing), run`,
      "  node ~/marathon-store-app/tools/sb-portal-recon/run.mjs --login",
      "sign in (email, password, PIN) in the window that opens, and close it. The next 18:00 pull carries on by itself.",
      "",
      "This email is sent once; it is not repeated until a pull has worked again.",
    ].join("\n"),
  };
}

/** One run's summary line for the log. */
export function summaryLine(results) {
  return (results || []).map((r) => `${r.dayYmd}: ${r.ok ? Object.entries(r.results || {}).map(([k, v]) => `${k}=${v.outcome}${v.key ? `(${v.key})` : ""}`).join(" ") : `refused — ${r.reason}`}`).join(" | ");
}

export { portalLib };
