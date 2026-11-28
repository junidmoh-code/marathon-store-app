// ─── LOAD THE LIVE TV BOARD AS A STAFF ACCOUNT (diagnosis, 28 Nov 2026) ──────
//
//   PW_DIR=<dir with node_modules/playwright-core> node scripts/tv/probe-board-as-staff.mjs [url]
//
// The owner account's board works; a staff account's board on the store TV
// showed 0 in every column with "Updating…" stuck. This opens the LIVE app in
// a fresh headless Chrome, signs in through the real Login form as a
// throwaway staff account, opens "TV Display" (the DISPLAY role, exactly as a
// staff-signed-in TV does), and reports what the board shows plus every
// console warning/error (PERMISSION_DENIED, listener cancels).
//
// Personas: staff with no shop pin (like the `tv`/`mike` accounts), staff
// pinned to marathon-pe, and the anonymous #tv kiosk.
//
// It WRITES to live: one Auth account per staff persona (signUp with the
// public web key) and its /users/{uid} record (owner token), both deleted at
// the end, plus whatever /mirror_devices record the app itself writes for the
// probe device (also deleted). Nothing else. No token, uid or row is printed.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const require = createRequire(`${process.env.PW_DIR || process.cwd()}/`);
const { chromium } = require("playwright-core");

const URL_BASE = process.argv[2] || "https://marathon-club.web.app";
const API_KEY = "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo"; // public web key
const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const IDT = "https://identitytoolkit.googleapis.com/v1";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WAIT_MS = Number(process.env.WAIT_MS || 90_000);

function ownerToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const out = execFileSync("curl", ["-sS", "-X", "POST", "https://oauth2.googleapis.com/token",
    "-d", "client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    "-d", "client_secret=j9iVZfS8kkCEFUPaAeJV0sAi", "-d", "grant_type=refresh_token",
    "--data-urlencode", `refresh_token=${cfg.tokens.refresh_token}`], { encoding: "utf8" });
  return JSON.parse(out).access_token;
}
const OWNER = ownerToken();
const H = { Authorization: `Bearer ${OWNER}` };
const idt = async (path, body) => (await fetch(`${IDT}/${path}?key=${API_KEY}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

async function makeStaff(record) {
  const username = `tvprobe${randomBytes(3).toString("hex")}`;
  const pin = String(1000 + (randomBytes(2).readUInt16BE() % 9000));
  const acct = await idt("accounts:signUp", { email: `${username}@marathon.internal`, password: `pin-${pin}`, returnSecureToken: true });
  if (!acct.localId) throw new Error(`signUp failed: ${JSON.stringify(acct).slice(0, 200)}`);
  const r = await fetch(`${DB}/users/${acct.localId}.json`, { method: "PUT", headers: H, body: JSON.stringify({
    username, displayName: "TV probe (auto-deleted)", createdAt: Date.now(), ...record }) });
  if (!r.ok) throw new Error(`users write ${r.status}`);
  return { username, pin, uid: acct.localId, idToken: acct.idToken };
}
async function dropStaff(s) {
  await fetch(`${DB}/users/${s.uid}.json`, { method: "DELETE", headers: H });
  await idt("accounts:delete", { idToken: s.idToken });
  const devs = await (await fetch(`${DB}/mirror_devices.json?orderBy="uid"&equalTo=${encodeURIComponent(JSON.stringify(s.uid))}`, { headers: H })).json().catch(() => null);
  for (const id of Object.keys(devs && typeof devs === "object" && !devs.error ? devs : {})) {
    await fetch(`${DB}/mirror_devices/${id}.json`, { method: "DELETE", headers: H });
  }
  const left = await (await fetch(`${DB}/users/${s.uid}.json`, { headers: H })).json();
  console.log(`  cleanup: /users record ${left === null ? "gone" : "STILL THERE"}; auth account deleted`);
}

async function readBoard(page) {
  return page.evaluate(() => {
    const t = (el) => (el ? el.textContent.trim() : null);
    const counts = [...document.querySelectorAll(".qb-col")].map((c) => `${t(c.querySelector(".qb-col-title"))}=${t(c.querySelector(".qb-col-count"))}`);
    return {
      counts,
      conn: t(document.querySelector(".qb-conn")),
      status: t(document.querySelector("[data-testid=board-status]")),
      pill: t(document.querySelector("[data-testid=resume-updating]")),
      body: counts.length ? null : document.body.innerText.slice(0, 200),
    };
  });
}

async function run(label, { staff = null, hash = "" }) {
  console.log(`\n── ${label}`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") logs.push(`${m.type()}: ${m.text().slice(0, 220)}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 220)}`));
  await ctx.addInitScript(() => { try { localStorage.setItem("marathon_role", "display"); } catch { /* */ } });
  await page.goto(`${URL_BASE}/${hash}`, { waitUntil: "domcontentloaded" });
  if (staff) {
    await page.waitForSelector("input[type=password]", { timeout: 30_000 });
    const inputs = await page.$$("input");
    await inputs[0].fill(staff.username);
    await page.fill("input[type=password]", staff.pin);
    await page.click("button[type=submit]");
  }
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < WAIT_MS) {
    await page.waitForTimeout(15_000);
    last = await readBoard(page).catch((e) => ({ error: String(e) }));
    console.log(`  t+${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(last));
  }
  const seen = [...new Set(logs)].filter((l) => !/fonts\.g|favicon|preload/i.test(l));
  console.log(`  console (${seen.length} distinct):`);
  for (const l of seen.slice(0, 25)) console.log(`    ${l}`);
  await browser.close();
  return last;
}

const staffOpen = await makeStaff({ permissions: ["product_admin"], permFlags: { product_admin: true }, role: "admin" });
const staffPinned = await makeStaff({ permissions: ["product_admin"], permFlags: { product_admin: true }, role: "store_assistant", destShop: "marathon-pe" });
try {
  await run("staff, no shop pin (like tv / mike), TV Display role", { staff: staffOpen });
  await run("staff pinned to marathon-pe, TV Display role", { staff: staffPinned });
  await run("anonymous #tv kiosk", { hash: "?kiosk=1#tv" });
} finally {
  await dropStaff(staffOpen);
  await dropStaff(staffPinned);
}
