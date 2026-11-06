#!/usr/bin/env node
// ─── ADMIN SCREENS: NO OVERLAP, CONTENT UNDER THE HEADER, ONE-LEVEL BACK ─────
// (Junid, 6 Nov — "Admin, Shopify, Social redesign + navigation")
//
// Runs the REAL App (dev/sky-app.html) over the offline synthetic database
// (dev/vite.harness.config.mjs → dev/fake-firebase/): nothing reaches Firebase
// — every non-local request fails the run.
//
// Per admin route, at 390x844 and 1440x900, in Chromium and WebKit:
//   1. NO OVERLAP: no two visible text boxes intersect (bounding boxes of the
//      text itself, clipped to their scrolling rows — a chip scrolled out of
//      its row is not "visible").
//   2. UNDER THE HEADER: the first content element starts within 24px of the
//      shell header's bottom edge, and nothing starts behind it.
// Navigation (390x844):
//   3. From a product edit page, the header's back button goes Products →
//      Admin → Home in three taps; a long-press (500ms) goes Home directly.
//
//   node scripts/sky-admin.e2e.mjs [--port 5209] [--shots DIR] [--only route,…] [--no-nav] [--engines chromium]
//   exit 0 = pass; 1 = an assertion failed; 2 = harness error

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, webkit } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt("--port", 5209));
const SHOTS = opt("--shots", null);
const ONLY = opt("--only", null)?.split(",");
const ENGINES = opt("--engines", "chromium,webkit").split(",");
const NAV = !args.includes("--no-nav");
const BASE = `http://localhost:${PORT}/dev/sky-app.html`;
const PID = "p1790000000000";                    // the first synthetic product (dev/fake-firebase/fixture.js)

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); };

// Every admin route: how to land on it (localStorage + hash, or a tap).
const ROUTES = [
  { key: "admin-home", ls: {}, tap: "[data-testid=home-tile-admin]" },
  { key: "products", ls: { marathon_role: "admin", marathon_admin_section: "products" } },
  { key: "product-edit", ls: { marathon_role: "admin", marathon_admin_section: "products" }, hash: `#product/${PID}` },
  { key: "missing-prices", ls: { marathon_role: "admin", marathon_admin_section: "missing-prices" } },
  { key: "assign-categories", ls: { marathon_role: "admin", marathon_admin_section: "assign-categories" } },
  { key: "categories", ls: { marathon_role: "admin", marathon_admin_section: "review-categories" } },
  { key: "bulk-pricing", ls: { marathon_role: "admin", marathon_admin_section: "bulk-pricing" } },
  { key: "specials", ls: { marathon_role: "admin", marathon_admin_section: "specials" } },
  { key: "taxonomy", ls: { marathon_role: "admin", marathon_admin_section: "taxonomy" } },
  { key: "shopify", ls: { marathon_role: "shopify_publish" } },
  { key: "shopify-live", ls: { marathon_role: "shopify_publish" }, tap: "[data-testid=shopify-tab-live]" },
  { key: "shopify-product", ls: { marathon_role: "shopify_publish" }, hash: `#shopify/${PID}` },
  { key: "social", ls: { marathon_role: "social" } },
  { key: "social-album", ls: { marathon_role: "social" }, tap: "[data-testid=social-tab-album]" },
  { key: "social-style", ls: { marathon_role: "social" }, tap: "[data-testid=social-tab-library]" },
  { key: "social-generate", ls: { marathon_role: "social" }, tap: "[data-testid=social-tab-generate]" },
  { key: "social-policy", ls: { marathon_role: "social" }, tap: "[data-testid=social-tab-policy]" },
].filter((r) => !ONLY || ONLY.includes(r.key));
const SIZES = [{ w: 390, h: 844 }, { w: 1440, h: 900 }];

// In the page: every visible text box (one per text node line), clipped to
// the overflow boxes it scrolls inside, plus the first content edge.
function measure() {
  const vis = (el) => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const clipOf = (el) => {
    let r = { l: 0, t: 0, r: innerWidth, b: innerHeight };
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const b = a.getBoundingClientRect();
        r = { l: Math.max(r.l, b.left), t: Math.max(r.t, b.top), r: Math.min(r.r, b.right), b: Math.min(r.b, b.bottom) };
      }
    }
    return r;
  };
  const shell = document.querySelector("[data-testid=sky-shellbar]") || document.querySelector(".sky-home .sky-header");
  const shellBottom = shell ? shell.getBoundingClientRect().bottom : 0;
  const boxes = [];
  const walker = document.createTreeWalker(document.getElementById("root"), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || !vis(el) || el.closest("[data-contrast-exempt], .sky-shellbar, svg, option, select")) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const c = clipOf(el);
    for (const rr of range.getClientRects()) {
      const b = { l: Math.max(rr.left, c.l), t: Math.max(rr.top, c.t), r: Math.min(rr.right, c.r), b: Math.min(rr.bottom, c.b) };
      if (b.r - b.l < 2 || b.b - b.t < 2) continue;
      boxes.push({ ...b, text: n.nodeValue.trim().slice(0, 28), el });
    }
  }
  // Inputs draw text too (value / placeholder).
  for (const el of document.querySelectorAll("#root input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), #root textarea")) {
    if (!vis(el) || el.closest("[data-contrast-exempt]")) continue;
    const r = el.getBoundingClientRect(), c = clipOf(el);
    const b = { l: Math.max(r.left, c.l), t: Math.max(r.top, c.t), r: Math.min(r.right, c.r), b: Math.min(r.bottom, c.b) };
    if (b.r - b.l >= 2 && b.b - b.t >= 2) boxes.push({ ...b, text: `[${el.placeholder || el.value || "input"}]`.slice(0, 28), el });
  }
  const overlaps = [];
  const PAD = 1;                                   // sub-pixel line boxes touching is not an overlap
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.el === b.el || a.el.contains(b.el) && b.el.tagName === "INPUT" || b.el.contains(a.el) && a.el.tagName === "INPUT") continue;
    const w = Math.min(a.r, b.r) - Math.max(a.l, b.l), h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    if (w > PAD && h > PAD) overlaps.push(`"${a.text}" × "${b.text}" (${Math.round(w)}×${Math.round(h)}px)`);
  }
  // First content: the topmost visible text/control/media box below the shell.
  let first = Infinity;
  for (const b of boxes) if (b.b > shellBottom - 1) first = Math.min(first, b.t);
  for (const el of document.querySelectorAll("#root img, #root button, #root input, #root textarea")) {
    if (!vis(el) || el.closest(".sky-shellbar, .sky-home .sky-header")) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 4 && r.height > 4 && r.bottom > shellBottom - 1 && r.top < innerHeight) first = Math.min(first, r.top);
  }
  const behind = boxes.filter((b) => b.t < shellBottom - 1 && b.b > 0 && !shell?.contains(b.el)).map((b) => b.text);
  return { shellBottom: Math.round(shellBottom), first: Math.round(first), overlaps: overlaps.slice(0, 8), nOverlaps: overlaps.length, behind: behind.slice(0, 5) };
}

async function land(page, r) {
  await page.addInitScript((ls) => { try { localStorage.clear(); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch { /* none */ } }, r.ls);
  await page.goto(BASE + (r.hash || ""));
  await page.waitForSelector(".sky-logo__m", { timeout: 30000 });
  await page.waitForTimeout(1500);
  if (r.tap) { await page.click(r.tap, { timeout: 8000 }); await page.waitForTimeout(900); }
}

function guardNetwork(page, where) {
  page.on("request", (q) => {
    const u = q.url();
    if (!/^(http:\/\/localhost|data:|blob:|https:\/\/fonts\.(googleapis|gstatic)\.com)/.test(u)) check(false, `${where}: no network — ${u.slice(0, 100)}`);
  });
  page.on("pageerror", (e) => check(false, `${where}: page error — ${e.message.slice(0, 160)}`));
}

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "dev/vite.harness.config.mjs", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const stop = () => { try { vite.kill(); } catch { /* gone */ } };
let code = 0;
try {
  for (let k = 0; k < 60; k++) { try { if ((await fetch(BASE)).ok) break; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 500)); }
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
        const m = await page.evaluate(measure);
        check(m.nOverlaps === 0, `${where}: no overlapping text${m.nOverlaps ? ` — ${m.nOverlaps}: ${m.overlaps.join("; ")}` : ""}`);
        check(m.first <= m.shellBottom + 24 && m.behind.length === 0,
          `${where}: content starts ${m.first - m.shellBottom}px under the header (≤24)${m.behind.length ? `; behind it: ${m.behind.join(", ")}` : ""}`);
        if (SHOTS && name === "chromium") await page.screenshot({ path: `${SHOTS}/${r.key}-${s.w}.png` });
      } catch (e) { check(false, `${where}: ${e.message.split("\n")[0]}`); }
      await ctx.close();
    }
    if (NAV && name === "chromium") {
      console.log("\nnavigation (390x844)");
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      guardNetwork(page, "nav");
      await land(page, ROUTES.find((r) => r.key === "product-edit") || { ls: { marathon_role: "admin" }, hash: `#product/${PID}` });
      const where = async () => page.evaluate(() => ({
        home: !!document.querySelector("[data-testid=sky-home]"), panel: document.querySelector("[data-testid=sky-home]")?.dataset.panel || null,
        hash: location.hash, products: !!document.querySelector("[data-testid=admin-product-list]"),
        edit: /^#product\//.test(location.hash) }));
      const back = "[data-testid=sky-back]";
      check((await where()).edit, "starts on the product edit page");
      check(await page.locator(`${back} [data-testid=sky-back-chevron]`).count() === 1, "the back button shows the chevron beside the grid");
      await page.click(back); await page.waitForTimeout(700);
      let w = await where();
      check(!w.edit && w.products && !w.home, `tap 1 → Products (${JSON.stringify(w)})`);
      await page.click(back); await page.waitForTimeout(700);
      w = await where();
      check(w.home && w.panel === "admin", `tap 2 → Admin (${JSON.stringify(w)})`);
      await page.click("[data-testid=sky-home] [data-testid=sky-back]"); await page.waitForTimeout(700);
      w = await where();
      check(w.home && !w.panel, `tap 3 → Home (${JSON.stringify(w)})`);
      check(await page.locator("[data-testid=sky-home] [data-testid=sky-back-chevron]").count() === 0, "Home shows the plain grid (no chevron)");
      // Long-press from a product edit page → Home in one go.
      await page.evaluate((pid) => { localStorage.setItem("marathon_role", "admin"); location.hash = `#product/${pid}`; }, PID);
      await page.reload(); await page.waitForSelector(back); await page.waitForTimeout(1200);
      check((await where()).edit, "long-press: starts on the product edit page");
      const bb = await page.locator(back).boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up(); await page.waitForTimeout(700);
      w = await where();
      check(w.home && !w.panel && !w.edit, `long-press → Home directly (${JSON.stringify(w)})`);
      // The OS back still works as before: open a product from the list, history.back() returns to the list.
      await page.evaluate(() => localStorage.setItem("marathon_role", "admin"));
      await page.reload(); await page.waitForTimeout(1500);
      await page.click("[data-testid=admin-product-list] > *:first-child"); await page.waitForTimeout(800);
      check((await where()).edit, "a row opens the product edit page");
      await page.goBack(); await page.waitForTimeout(800);
      w = await where();
      check(!w.edit && w.products, `browser back → Products (${JSON.stringify(w)})`);
      await ctx.close();
    }
    await browser.close();
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
  code = fails.length ? 1 : 0;
} catch (e) {
  console.error(e); code = 2;
} finally { stop(); }
process.exit(code);
