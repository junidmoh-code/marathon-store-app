#!/usr/bin/env node
// ─── SIMPLYBLU PORTAL → CARD RECON (Mac mini, launchd com.marathon.sbportalrecon)
// Junid, 2 Nov 2026: from 3 Nov the Standard Bank tills take every card
// payment through the SimplyBLU app, so the portal is their record. At 18:00
// SAST (catch-up 18:20) this:
//   1. opens the portal in a PERSISTENT browser profile (the sign-in survives
//      between runs; Firebase keeps it), headless;
//   2. if signed out: signs in with the password saved in the macOS Keychain
//      (service "marathon-simplyblu"), if there is one — and if the portal then
//      wants a one-time PIN, or there is no saved password, it STOPS, emails
//      Junid once ("SimplyBLU needs a fresh login on the Mac mini") and exits
//      21/20. It never loops and never retries a login;
//   3. for EVERY store on the login (the header switcher — a newly linked
//      merchant appears by itself), opens the Terminal Batch Report and takes
//      the signed Metabase link the portal hands the page;
//   4. reads, as JSON from Metabase's embed API, the Terminal ID list and each
//      day's transactions (today and the two days before, from 3 Nov 2026);
//   5. hands each day to the store app's callable (cardBatchCapture
//      "portalDay") as the mailbox poller's identity — the server decides what
//      is recorded (functions/cardRecon/cardPortal.js).
// Each run's raw answer is kept under logs/sb-portal-recon/ (gitignored; no
// card numbers — the portal's list has none).
//
//   node tools/sb-portal-recon/run.mjs            # the scheduled pull
//   node tools/sb-portal-recon/run.mjs --catchup  # 18:20: only if 18:00 did not finish
//   node tools/sb-portal-recon/run.mjs --login    # a window opens; sign in by hand once
//   node tools/sb-portal-recon/run.mjs --dry-run  # read the portal, record nothing
//   node tools/sb-portal-recon/run.mjs --days 2026-11-03,2026-11-04

import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  REPORT_URL, PORTAL_ORIGIN, METABASE_HOST, KEYCHAIN_SERVICE, EXIT,
  daysToPull, dateFilter, embedTokenFromSrc, embedClaims, readDashboard, tidsFromValues, cardRows,
  parseStoreItems, classifyPage, shouldAlert, loginAlert, summaryLine, sastYmd,
  projectColumns, shouldAlertFailure, failureAlert,
} from "./core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const MODE = flag("--login") ? "login" : flag("--catchup") ? "catchup" : "run";
const DRY = flag("--dry-run");
const STATE_DIR = process.env.SB_PORTAL_STATE_DIR || join(homedir(), ".marathon", "sb-portal");
const PROFILE_DIR = process.env.SB_PORTAL_PROFILE_DIR || join(STATE_DIR, "profile");
const STATE_FILE = join(STATE_DIR, "state.json");
const LOCK_FILE = join(STATE_DIR, "run.lock");
const RUNS_DIR = join(REPO, "logs", "sb-portal-recon");
const FIREBASE_WEB_API_KEY = "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo";
const CALLABLE_URL = "https://europe-west1-marathon-club.cloudfunctions.net/cardBatchCapture";
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const PAGE_TIMEOUT_MS = 60000;
// A run that hangs (a browser that never answers) must not hold the lock for
// ever: the whole run is bounded, and a lock older than this is stale.
const RUN_LIMIT_MS = 15 * 60000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sastMinutes = (ms) => { const d = new Date(ms + 2 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// ── state (one small file, outside the repo) ─────────────────────────────────
function readState() { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function writeState(patch) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const next = { ...readState(), ...patch };
  writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  return next;
}

// ── single flight ────────────────────────────────────────────────────────────
function takeLock() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK_FILE, "wx", 0o600);
      writeFileSync(fd, String(process.pid)); closeSync(fd);
      process.on("exit", () => { try { if (readFileSync(LOCK_FILE, "utf8") === String(process.pid)) unlinkSync(LOCK_FILE); } catch { /* gone */ } });
      return true;
    } catch {
      const pid = Number(readFileSync(LOCK_FILE, "utf8"));
      let alive = false;
      try { if (pid) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
      let ageMs = 0;
      try { ageMs = Date.now() - statSync(LOCK_FILE).mtimeMs; } catch { /* gone */ }
      if (alive && ageMs > RUN_LIMIT_MS + 60000) {
        // Only a process that IS this tool is stopped: a pid reused by the OS
        // after a crash belongs to something else, and the lock is just stale
        // (CodeRabbit, #837).
        let cmd = "";
        try { cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }); } catch { /* gone */ }
        if (/sb-portal-recon\/run\.mjs/.test(cmd)) {
          log(`the run holding the lock (pid ${pid}) is ${Math.round(ageMs / 60000)} min old — stopping it`);
          try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
        }
        alive = false;
      }
      if (alive) return false;
      // Remove the lock only if it is still the one judged stale.
      try { if (Number(readFileSync(LOCK_FILE, "utf8")) === pid) unlinkSync(LOCK_FILE); } catch { /* raced */ }
    }
  }
  return false;
}

// ── the repo .env (the poller's mailbox, for the one alert email) ────────────
function repoEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(REPO, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* none */ }
  return { ...out, ...process.env };
}

async function emailJunid(msg) {
  const env = repoEnv();
  const user = env.CARD_RECON_IMAP_USER, pass = String(env.CARD_RECON_IMAP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) { log("⚠ no mailbox credentials in .env — the alert could not be emailed:", msg.subject); return false; }
  const nodemailer = (await import("nodemailer")).default;
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }, connectionTimeout: 15000, socketTimeout: 30000 });
  await t.sendMail({ from: `Marathon card recon <${user}>`, to: msg.to, subject: msg.subject, text: msg.text });
  log(`✉ emailed ${msg.to}: ${msg.subject}`);
  return true;
}

// ── the saved password (macOS Keychain; never in a file, never logged) ───────
function keychainLogin() {
  // The FILE first: save-login.sh writes it only when the Keychain was locked,
  // so it is the newer password whenever both exist (CodeRabbit, #838).
  try {
    const f = join(STATE_DIR, "credentials");
    if ((statSync(f).mode & 0o077) !== 0) { log("⚠ the credentials file is readable by others — not used; run save-login.sh again"); }
    else {
      const kv = Object.fromEntries(readFileSync(f, "utf8").split("\n").map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
      if (kv.SIMPLYBLU_EMAIL && kv.SIMPLYBLU_PASSWORD) return { email: kv.SIMPLYBLU_EMAIL, password: kv.SIMPLYBLU_PASSWORD };
    }
  } catch { /* no file */ }
  try {
    const attrs = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const acct = /"acct"<blob>="([^"]+)"/.exec(attrs)?.[1];
    const password = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
    if (acct && password) return { email: acct, password };
  } catch { /* not in the Keychain, or it is locked */ }
  return null;
}

// ── the browser ──────────────────────────────────────────────────────────────
async function openBrowser({ headless }) {
  const { chromium } = await import("playwright");
  mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(PROFILE_DIR, 0o700); } catch { /* best effort */ }
  const opts = { headless, viewport: { width: 1280, height: 900 } };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: "chrome" });
  } catch (err) {
    log(`Chrome could not be launched (${err.message.split("\n")[0]}); trying Playwright's Chromium`);
    return chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

async function pageFacts(page) {
  const embedSrc = await page.locator(`iframe[src*="${METABASE_HOST}"]`).first().getAttribute("src", { timeout: 1000 }).catch(() => null);
  const f = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")].filter((i) => i.offsetParent !== null);
    const text = (document.body && document.body.innerText) || "";
    return {
      hasPassword: inputs.some((i) => i.type === "password"),
      hasEmail: inputs.some((i) => i.type === "email"),
      hasCodeInput: inputs.some((i) => i.type !== "password" && i.type !== "email" && i.type !== "hidden" && i.type !== "checkbox"),
      otpText: /\b(otp|one[- ]time (pin|password|code)|verification code|enter the (code|pin)|pin (was )?sent|we (have )?sent)\b/i.test(text),
    };
  }).catch(() => ({}));
  return { ...f, url: page.url(), hasEmbed: !!embedSrc, embedSrc };
}

/** Wait until the page is the report, a login form or a PIN prompt. */
async function settle(page, ms = PAGE_TIMEOUT_MS) {
  const until = Date.now() + ms;
  let facts = null;
  while (Date.now() < until) {
    facts = await pageFacts(page);
    const kind = classifyPage(facts);
    if (kind !== "unknown") return { kind, facts };
    await page.waitForTimeout(1000);
  }
  return { kind: "unknown", facts };
}

async function signInSilently(page, creds) {
  await page.locator('input[type="email"]').first().fill(creds.email);
  await page.locator('input[type="password"]').first().fill(creds.password);
  await page.getByRole("button", { name: /^sign in$/i }).first().click();
  await page.waitForTimeout(3000);
  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  return settle(page);
}

/** The header switcher: the button whose text is a store name (any of `names`), else the first all-caps one. */
function switcher(page, names = []) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = names.length ? new RegExp(`^\\s*(${names.map(esc).join("|")})\\s*$`, "i") : /^\s*[A-Z0-9 &'.-]{2,40}\s*$/;
  return page.getByRole("button", { name: re }).first();
}

/** The stores on this login, from the header switcher. */
async function listStores(page) {
  await switcher(page).click({ timeout: 15000 });
  await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
  const texts = await page.locator('[role="menuitem"]').allInnerTexts();
  await page.keyboard.press("Escape");
  return parseStoreItems(texts);
}

/** Make `store` the selected one: from a freshly loaded report page, never mid-menu. */
async function selectStore(page, store, names) {
  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded" });
  const { kind } = await settle(page);
  if (kind !== "report") throw new Error(`the report did not open (${kind})`);
  const button = switcher(page, names);
  const current = (await button.innerText({ timeout: 15000 }).catch(() => "")).trim();
  if (current.toUpperCase() === String(store.name).toUpperCase()) return;
  await button.click({ timeout: 15000 });
  await page.locator('[role="menuitem"]').filter({ hasText: store.merchantNo }).first().click({ timeout: 15000 });
  // The header names the store once the switch has happened.
  await switcher(page, [store.name]).waitFor({ timeout: 30000 });
}

async function embedFor(page, store, names) {
  await selectStore(page, store, names);
  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded" });
  const { kind, facts } = await settle(page);
  if (kind !== "report") throw new Error(`the report did not open for ${store.name} (${kind})`);
  const token = embedTokenFromSrc(facts.embedSrc);
  if (!token) throw new Error(`no Metabase link on the report for ${store.name}`);
  return token;
}

// ── Metabase, as JSON ────────────────────────────────────────────────────────
async function mb(token, path) {
  const res = await fetch(`https://${METABASE_HOST}/api/embed/dashboard/${token}${path}`, { signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok && res.status !== 202) throw new Error(`Metabase answered HTTP ${res.status}`);
  return body;
}

async function readStore(token, days) {
  const dash = readDashboard(await mb(token, ""));
  if (!dash) throw new Error("the Terminal Batch Report has no transactions card any more — its layout changed");
  const tids = dash.tidParamId ? tidsFromValues(await mb(token, `/params/${dash.tidParamId}/values`)) : [];
  const byDay = {};
  for (const d of days) {
    const got = cardRows(await mb(token, `/dashcard/${dash.dashcardId}/card/${dash.cardId}?${dash.dateSlug}=${encodeURIComponent(dateFilter(d))}`));
    if (got.error) throw new Error(got.error);
    byDay[d] = got;
  }
  return { tids, byDay };
}

// ── the callable, as the mailbox poller's identity ───────────────────────────
async function idToken() {
  const req = createRequire(join(REPO, "functions", "package.json"));
  const admin = req("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
  const uid = String(repoEnv().CARD_RECON_POLLER_UID || "").trim() || "card-recon-email-poller";
  const custom = await admin.auth().createCustomToken(uid);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: custom, returnSecureToken: true }), signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`could not sign in as the poller (HTTP ${res.status})`);
  return (await res.json()).idToken;
}

async function portalDay(token, data) {
  const res = await fetch(CALLABLE_URL, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data: { action: "portalDay", ...data } }), signal: AbortSignal.timeout(280000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`the callable refused: ${body?.error?.message || `HTTP ${res.status}`}`);
  return body.result;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const nowMs = Date.now();
  const today = sastYmd(nowMs);
  // launchd fires --catchup at 18:00 AND 18:20. Before 18:15 SAST it is the
  // 18:00 pull and always runs; from 18:15 it runs unless an 18:20 pull has
  // already finished today. A manual or --days run never counts as "today's".
  if (MODE === "catchup" && sastMinutes(nowMs) >= 18 * 60 + 15 && readState().lastOkDay === today) { log(`catch-up: today's pull already finished — nothing to do`); return EXIT.OK; }
  if (!takeLock()) { log("another pull is running — this one stops"); return EXIT.OK; }

  const ctx = await openBrowser({ headless: MODE !== "login" });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.goto(REPORT_URL, { waitUntil: "domcontentloaded" });
    let { kind } = await settle(page);

    if (MODE === "login") {
      log("Sign in to SimplyBLU in the window (email, password and the PIN). Waiting up to 15 minutes…");
      const until = Date.now() + 15 * 60000;
      while (kind !== "report" && Date.now() < until) {
        await page.waitForTimeout(3000);
        if (!page.url().startsWith(`${PORTAL_ORIGIN}/auth`)) await page.goto(REPORT_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
        ({ kind } = await settle(page, 10000));
      }
      if (kind !== "report") { log("✗ not signed in after 15 minutes"); return EXIT.NEEDS_LOGIN; }
      const stores = await listStores(page).catch(() => []);
      log(`✓ signed in — stores on this login: ${stores.map((s) => `${s.name} ${s.merchantNo}`).join(", ") || "(could not read the switcher)"}`);
      writeState({ loginAt: Date.now() });
      return EXIT.OK;
    }

    if (kind === "login") {
      const st = readState();
      // A sign-in already failed (a PIN demanded, or the password refused) and
      // nobody has signed in since: trying again would only send Junid another
      // PIN — or lock the account on a wrong password — every evening. Stop.
      if (Number.isFinite(st.loginBlockedAt) && !(st.loginAt > st.loginBlockedAt) && !(st.lastOkAt > st.loginBlockedAt)) {
        return await signedOut(st.loginBlockedKind || "login");
      }
      const creds = keychainLogin();
      if (!creds) return await signedOut("login");
      log("signed out — signing in with the saved password");
      try { ({ kind } = await signInSilently(page, creds)); }
      catch (err) { log(`the saved-password sign-in failed: ${err.message.split("\n")[0]}`); return await signedOut("login"); }
      if (kind === "otp") return await signedOut("otp");
      if (kind !== "report") return await signedOut("login");
      log("✓ signed in again without a PIN");
    }
    if (kind === "otp") return await signedOut("otp");
    if (kind !== "report") throw new Error(`the portal did not open the report (${page.url().replace(/\?.*/, "")})`);

    let stores = await listStores(page).catch((err) => { log(`⚠ store switcher unreadable (${err.message.split("\n")[0]}) — reading the selected store only`); return []; });
    const days = opt("--days") ? opt("--days").split(",").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : daysToPull(nowMs);
    if (!days.length) { log("no day to pull yet (the portal is the record from 2026-11-03)"); return EXIT.OK; }
    const sources = {}; // day → [source]
    const raw = { at: new Date(nowMs).toISOString(), days, stores: [] };
    if (!stores.length) stores = [{ name: null, merchantNo: null, current: true }];
    // ONE STORE'S FAILURE NEVER STOPS THE OTHERS: what was read is recorded,
    // and the failure is said (Sonnet architect review, #837). A store that
    // could not be read sends nothing — its tills stay "awaiting", never zero.
    const storeErrors = [];
    for (const store of stores) {
      let token, got;
      try {
        token = store.current
          ? embedTokenFromSrc((await pageFacts(page)).embedSrc)
          : await embedFor(page, store, stores.map((x) => x.name).filter(Boolean));
        if (!token) throw new Error("no Metabase link on the report");
        got = await readStore(token, days);
      } catch (err) {
        storeErrors.push(`${store.name || "selected store"}: ${err.message.split("\n")[0]}`);
        log(`✗ ${store.name || "selected store"} could not be read: ${err.message.split("\n")[0]}`);
        continue;
      }
      const claims = embedClaims(token);
      for (const d of days) got.byDay[d] = projectColumns(got.byDay[d]);
      log(`${store.name || "(selected store)"} ${store.merchantNo || ""}: terminals ${got.tids.join(", ") || "none"}; ${days.map((d) => `${d} ${got.byDay[d].rows.length} rows`).join(", ")}`);
      raw.stores.push({ ...store, businessId: claims?.businessId ?? null, tids: got.tids, byDay: got.byDay });
      for (const d of days) {
        (sources[d] ||= []).push({ business: { name: store.name, merchantNo: store.merchantNo }, tids: got.tids, cols: got.byDay[d].cols, rows: got.byDay[d].rows });
      }
    }
    mkdirSync(RUNS_DIR, { recursive: true });
    const rawFile = join(RUNS_DIR, `${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(rawFile, JSON.stringify(raw), { mode: 0o600 });
    log(`raw answer kept: ${rawFile}`);
    if (DRY) { log("dry run — nothing recorded"); return storeErrors.length ? EXIT.FAILED : EXIT.OK; }
    if (!raw.stores.length) throw new Error(`no store could be read (${storeErrors.join("; ")})`);

    const tok = await idToken();
    const results = [];
    for (const d of days) {
      if (!sources[d]) continue;
      const out = await portalDay(tok, { dayYmd: d, sources: sources[d] });
      results.push({ dayYmd: d, ...out });
    }
    log(`recorded: ${summaryLine(results)}`);
    writeFileSync(rawFile.replace(/\.json$/, ".result.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
    const bad = results.filter((r) => !r.ok || Object.values(r.results || {}).some((v) => v.outcome === "error" || v.outcome === "refused"));
    if (bad.length || storeErrors.length) {
      throw new Error(`${bad.length} day(s) not fully recorded${storeErrors.length ? `; ${storeErrors.join("; ")}` : ""} — the catch-up / next run tries again`);
    }
    // Only the 18:20 run closes the day: the 18:00 run leaves 18:20 to pull
    // again, which is what makes an empty day final (lib/card-portal.cjs).
    writeState({ lastOkAt: Date.now(), ...(MODE === "catchup" && !opt("--days") && sastMinutes(nowMs) >= 18 * 60 + 15 ? { lastOkDay: today } : {}) });
    return EXIT.OK;
  } catch (err) {
    try {
      mkdirSync(RUNS_DIR, { recursive: true });
      const shot = join(RUNS_DIR, `failure-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      await ctx.pages()[0]?.screenshot({ path: shot });
      log(`screenshot of the failure: ${shot}`);
    } catch { /* best effort */ }
    throw err;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function signedOut(kind) {
  // Remembered whether or not an email goes: the next scheduled run does not
  // try the password again until someone signs in (--login) (CodeRabbit, #837).
  const state = writeState({ loginBlockedAt: Date.now(), loginBlockedKind: kind });
  log(kind === "otp" ? "✗ the portal wants a one-time PIN — stopping (no retry)" : "✗ signed out and no usable saved password — stopping");
  if (shouldAlert(state)) {
    try { if (await emailJunid(loginAlert({ kind }))) writeState({ loginAlertAt: Date.now(), loginAlertKind: kind }); }
    catch (err) { log(`⚠ the alert email failed: ${err.message}`); }
  } else {
    log("(Junid was already emailed for this; not again until a pull works)");
  }
  return kind === "otp" ? EXIT.OTP_REQUIRED : EXIT.NEEDS_LOGIN;
}

// The whole run is bounded: a hung browser cannot hold the lock for ever.
const watchdog = setTimeout(() => { log(`✗ the run passed ${RUN_LIMIT_MS / 60000} minutes — stopping`); process.exit(EXIT.FAILED); }, RUN_LIMIT_MS);
watchdog.unref();

main().then((code) => process.exit(code ?? 0)).catch(async (err) => {
  log(`✗ ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`);
  // The 18:20 catch-up is the last try of the evening: if it fails too, Junid
  // is told once (not again until a pull works).
  // Both fires run with --catchup; only the 18:20 one (or later) is the last try.
  const sastMin = (() => { const d = new Date(Date.now() + 2 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
  if (MODE === "catchup" && !DRY && sastMin >= 18 * 60 + 15 && shouldAlertFailure(readState())) {
    try { if (await emailJunid(failureAlert(err && err.message))) writeState({ failAlertAt: Date.now() }); }
    catch (e) { log(`⚠ the failure email failed: ${e.message}`); }
  }
  process.exit(EXIT.FAILED);
});
