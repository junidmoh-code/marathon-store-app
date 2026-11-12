#!/usr/bin/env node
// ─── ONE LINE PER CHIP ROW (Junid 12 Nov, item 5) ────────────────────────────
//
// "Any chip or tab group anywhere in the app is a single horizontally
// scrolling row and never wraps or overlaps."
//
// Runs the REAL App (dev/sky-app.html) over the offline synthetic database
// (dev/vite.harness.config.mjs → dev/fake-firebase/): nothing reaches Firebase
// — every non-local request fails the run.
//
// Per route, at 390x844 and 1440x900 (Chromium; --engines chromium,webkit for
// both), every chip/tab container — [data-chip-row], [role=tablist], .sky-row1
// — must lay its visible children on ONE line: they all share the same
// offsetTop (±1px; the check reads getBoundingClientRect().top relative to
// the container, which is offsetTop without the offsetParent caveat).
//
// --audit also lists UNTAGGED pill groups (3+ sibling buttons, pill-shaped)
// that wrap — the inventory used to find rows that were never tagged. Audit
// findings are printed, not failed.
//
//   node scripts/sky-chip-rows.e2e.mjs [--port 5213] [--only route,…] [--engines chromium] [--audit] [--shots DIR]
//   exit 0 = pass; 1 = a row wrapped; 2 = harness error

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, webkit } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt("--port", 5213));
const ONLY = opt("--only", null)?.split(",");
const ENGINES = opt("--engines", "chromium").split(",");
const AUDIT = args.includes("--audit");
const SHOTS = opt("--shots", null);
const BASE = `http://localhost:${PORT}/dev/sky-app.html`;
const PID = "p1790000000000";                    // the first synthetic product (dev/fake-firebase/fixture.js)

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); };

const role = (r, extra = {}) => ({ marathon_role: r, ...extra });
const stock = (tab) => ({ key: `stock-${tab}`, ls: role("stock", { "tabState:stock": tab }) });
// Every route the harness can reach: home, the admin hub, each role screen,
// each Stock tool, each Admin section, the Shopify and Social tabs.
export const ROUTES = [
  { key: "home", ls: {} },
  { key: "admin-hub", ls: {}, tap: "[data-testid=home-tile-admin]" },
  { key: "assistant", ls: role("assistant") },
  { key: "warehouse", ls: role("warehouse") },
  { key: "source", ls: role("source") },
  { key: "display-checks", ls: role("display_checks") },
  { key: "barcodes", ls: role("barcodes") },
  { key: "label-print", ls: role("label_print") },
  { key: "stock-audit", ls: role("stock_audit") },
  { key: "insights", ls: role("insights") },
  { key: "customer", ls: role("customer") },
  { key: "customers-db", ls: role("customers_db") },
  { key: "broadcast", ls: role("broadcast_groups") },
  { key: "health", ls: role("health") },
  { key: "attention", ls: role("attention") },
  { key: "marketing", ls: role("marketing") },
  { key: "total-stock", ls: role("total_stock") },
  { key: "hub-count", ls: role("hub_sneaker_count") },
  { key: "stock-hold", ls: role("stock_hold") },
  { key: "display-registration", ls: role("display_registration") },
  { key: "engine-policy", ls: role("engine_policy") },
  { key: "ai-studio", ls: role("ai_studio") },
  { key: "card-recon", ls: role("card_recon") },
  { key: "tv-ad", ls: role("tv_ad") },
  stock("transfer"), stock("intransit"), stock("locate"), stock("setqty"), stock("history"),
  stock("adjust"), stock("count"), stock("recount"), stock("excess"), stock("duplicates"), stock("displayrecs"),
  { key: "admin-products", ls: role("admin", { marathon_admin_section: "products" }) },
  { key: "admin-product-edit", ls: role("admin", { marathon_admin_section: "products" }), hash: `#product/${PID}` },
  { key: "admin-missing-prices", ls: role("admin", { marathon_admin_section: "missing-prices" }) },
  { key: "admin-assign-categories", ls: role("admin", { marathon_admin_section: "assign-categories" }) },
  { key: "admin-categories", ls: role("admin", { marathon_admin_section: "review-categories" }) },
  { key: "admin-bulk-pricing", ls: role("admin", { marathon_admin_section: "bulk-pricing" }) },
  { key: "admin-specials", ls: role("admin", { marathon_admin_section: "specials" }) },
  { key: "admin-taxonomy", ls: role("admin", { marathon_admin_section: "taxonomy" }) },
  { key: "shopify", ls: role("shopify_publish") },
  { key: "shopify-live", ls: role("shopify_publish"), tap: "[data-testid=shopify-tab-live]" },
  { key: "shopify-product", ls: role("shopify_publish"), hash: `#shopify/${PID}` },
  { key: "social", ls: role("social") },
  { key: "social-album", ls: role("social"), tap: "[data-testid=social-tab-album]" },
  { key: "social-style", ls: role("social"), tap: "[data-testid=social-tab-library]" },
  { key: "social-generate", ls: role("social"), tap: "[data-testid=social-tab-generate]" },
  { key: "social-policy", ls: role("social"), tap: "[data-testid=social-tab-policy]" },
  { key: "user-management", ls: {}, hash: "#admin/users" },
  { key: "new-arrivals", ls: {}, hash: "#new-arrivals" },
].filter((r) => !ONLY || ONLY.includes(r.key));
const SIZES = [{ w: 390, h: 844 }, { w: 1440, h: 900 }];

// The same containers src/styles/sky-chips.css turns into one scrolling row:
// tagged rows, tablists, .sky-row1, and legacy wrapping rows of pill buttons.
const PILL = ["999px", "20px", "99px", "100px"].map((r) => `> button[style*="border-radius: ${r}"]`).join(", ");
const ROW_SELECTOR = [
  "#root [data-chip-row]", "body > [data-chip-row]", "#root [role=tablist]", "#root .sky-row1",
  `#root [style*="flex-wrap: wrap"]:has(${PILL}):not(:has(> :not(button, [data-chip-count])))`,
].join(", ");
const LIST = args.includes("--list");

// In the page: every chip/tab container and whether its visible children
// share one line; with audit, untagged pill groups that wrap.
function measure({ audit, sel }) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    return true;
  };
  const label = (el) => {
    const id = el.getAttribute("data-testid") || el.getAttribute("aria-label") || el.className?.toString?.().split(" ")[0] || el.tagName.toLowerCase();
    const first = [...el.children].map((c) => c.textContent.trim()).filter(Boolean).slice(0, 3).join(" | ");
    return `${id}${first ? ` [${first.slice(0, 60)}]` : ""}`;
  };
  const lines = (el) => {
    const kids = [...el.children].filter((c) => vis(c) && getComputedStyle(c).position !== "absolute" && getComputedStyle(c).position !== "fixed");
    const top0 = el.getBoundingClientRect().top;
    const tops = new Set();
    for (const k of kids) tops.add(Math.round((k.getBoundingClientRect().top - top0) / 2));   // 2px buckets: sub-pixel is one line
    // Tolerate ±1px: merge neighbouring buckets.
    const sorted = [...tops].sort((a, b) => a - b);
    let n = 0, prev = -99;
    for (const t of sorted) { if (t - prev > 1) n++; prev = t; }
    return { n, kids: kids.length };
  };
  const rows = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const { n, kids } = lines(el);
    if (kids < 2) continue;
    rows.push({ label: label(el), lines: n, kids });
  }
  const untagged = [];
  if (audit) {
    const pill = (b) => {
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      return r.height <= 56 && parseFloat(cs.borderTopLeftRadius) >= Math.min(12, r.height / 2 - 1);
    };
    const seen = new Set();
    for (const b of document.querySelectorAll("#root button")) {
      const p = b.parentElement;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      if (p.closest(sel)) continue;
      const btns = [...p.children].filter((c) => c.tagName === "BUTTON" && vis(c));
      if (btns.length < 3 || btns.length < p.children.length * 0.7 || !btns.every(pill)) continue;
      const { n } = lines(p);
      if (n > 1) untagged.push(`${label(p)} — ${n} lines`);
    }
  }
  return { rows, untagged };
}

async function land(page, r) {
  await page.addInitScript((ls) => { try { localStorage.clear(); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch { /* none */ } }, r.ls);
  await page.goto(BASE + (r.hash || ""));
  await page.waitForFunction(() => (document.getElementById("root")?.innerText || "").trim().length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  if (r.tap) { await page.click(r.tap, { timeout: 8000 }); await page.waitForTimeout(900); }
}

function guardNetwork(page, where) {
  page.on("request", (q) => {
    const u = q.url();
    if (!/^(http:\/\/localhost|data:|blob:|https:\/\/fonts\.(googleapis|gstatic)\.com)/.test(u)) check(false, `${where}: no network — ${u.slice(0, 100)}`);
  });
}

// A harness already serving on the port is reused (it is not ours to stop).
let vite = null;
try { if ((await fetch(BASE)).ok) console.log(`reusing the harness on :${PORT}`); } catch {
  vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "dev/vite.harness.config.mjs", "--port", String(PORT), "--strictPort"], { stdio: ["pipe", "ignore", "inherit"] });
}
const stop = () => { try { vite?.kill(); } catch { /* gone */ } };
let code = 0;
const auditOut = [];
try {
  let up = false;
  for (let k = 0; k < 60 && !up; k++) { try { up = (await fetch(BASE)).ok; } catch { /* booting */ } if (!up) await new Promise((r) => setTimeout(r, 500)); }
  if (!up) throw new Error(`harness did not answer at ${BASE}`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  for (const name of ENGINES) {
    const browser = await (name === "webkit" ? webkit : chromium).launch();
    console.log(`\n${name}`);
    for (const s of SIZES) for (const r of ROUTES) {
      const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const where = `${name} ${r.key} ${s.w}x${s.h}`;
      guardNetwork(page, where);
      try {
        await land(page, r);
        const m = await page.evaluate(measure, { audit: AUDIT, sel: ROW_SELECTOR });
        const bad = m.rows.filter((x) => x.lines > 1);
        check(bad.length === 0, `${where}: ${m.rows.length} chip/tab row${m.rows.length === 1 ? "" : "s"} on one line${bad.length ? ` — WRAPPED: ${bad.map((b) => `${b.label} (${b.lines} lines)`).join("; ")}` : ""}`);
        if (LIST) for (const x of m.rows) console.log(`        · ${x.label} — ${x.kids} children, ${x.lines} line${x.lines === 1 ? "" : "s"}`);
        if (m.untagged.length) auditOut.push(`${where}: ${m.untagged.join("; ")}`);
        if (SHOTS && name === "chromium") await page.screenshot({ path: `${SHOTS}/${r.key}-${s.w}.png` });
      } catch (e) { check(false, `${where}: ${e.message.split("\n")[0]}`); }
      await ctx.close();
    }
    await browser.close();
  }
  if (AUDIT) {
    console.log(`\naudit — untagged pill groups that wrap (${auditOut.length}):`);
    for (const a of auditOut) console.log(`  · ${a}`);
  }
  console.log(fails.length ? `\n${fails.length} failure(s)` : "\nall chip/tab rows on one line");
  code = fails.length ? 1 : 0;
} catch (e) {
  console.error(e); code = 2;
} finally { stop(); }
process.exit(code);
