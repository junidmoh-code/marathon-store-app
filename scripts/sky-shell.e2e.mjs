#!/usr/bin/env node
// ─── ONE HEADER, PINNED (Junid, 6 Nov) ──────────────────────────────────────
//
// On the real sky screens (dev/sky-harness.html, which draws the SAME shell
// header App.jsx draws above every screen but home and the order view):
//   1. ONE HEADER: exactly one visible logo wordmark per screen — the sky
//      wordmark (.sky-logo__m) plus any legacy italic "marathon" left on the
//      page. Legacy rail wordmarks and "Viewing as" bars carry
//      data-legacy-header and are hidden on the sky (sky.css); a static sweep
//      below proves every legacy wordmark in src/ is tagged, for the screens the
//      harness cannot mount (they stream live data).
//   2. PINNED SHELL (Warehouse, 390x844): after a 3000px scroll the header's
//      box is unchanged and the hub selector has left the viewport.
//   3. PINNED ORDER BAND: phone 390x844 — header, search and brand strip boxes
//      unchanged after a 3000px scroll, the first card gone, band + cart bar
//      under 45% of the screen; laptop 1440x900 — header, search and brand row
//      unchanged after a 3000px scroll of the grid, the first card gone.
//
//   node scripts/sky-shell.e2e.mjs [--port 5207]
//   exit 0 = pass; 1 = an assertion failed; 2 = harness error

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "@playwright/test";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const PORT = Number(i >= 0 ? args[i + 1] : 5207);
const BASE = `http://localhost:${PORT}/dev/sky-harness.html`;

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); };

// ── static sweep: every legacy wordmark / "Viewing as:" bar is tagged ──
function* walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) yield* walk(p); else if (/\.jsx$/.test(f) && !/\.test\./.test(f)) yield p; } }
console.log("static sweep (src/)");
const untagged = [];
for (const p of walk("src")) {
  if (/components\/sky\/Sky\.jsx$|TvDisplayMockup|dev\//.test(p)) continue;        // the sky wordmark itself; the customer TV board has no shell
  const L = readFileSync(p, "utf8").split("\n");
  L.forEach((l, k) => {
    const legacyMark = /fontStyle:\s*"italic".*>marathon<\/(span|div)>/.test(l) || /<b>marathon<\/b>/.test(l);
    const viewingAs = /Viewing as:/.test(l);
    if (!legacyMark && !viewingAs) return;
    const near = L.slice(Math.max(0, k - 8), k + 1).join("\n");
    if (!/data-legacy-header/.test(near) && !/PrivacyPage/.test(near)) untagged.push(`${p}:${k + 1}`);
  });
}
check(untagged.length === 0, `every legacy wordmark / "Viewing as" bar is tagged data-legacy-header${untagged.length ? " — " + untagged.join(", ") : ""}`);

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const marks = (page) => page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") return false;
  if (el.classList.contains("sky-logo__m")) return true;
  const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
  return own.toLowerCase() === "marathon" && cs.fontStyle === "italic";
}).length);
const box = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { top: r.top, left: r.left, bottom: r.bottom, height: r.height, width: r.width } : null; }, sel);
const same = (a, b) => a && b && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.height - b.height) < 0.5 && Math.abs(a.left - b.left) < 0.5;

try {
  let up = false;
  for (let t = 0; t < 120 && !up; t++) { try { up = (await fetch(BASE)).ok; } catch { /* not yet */ } if (!up) await new Promise((r) => setTimeout(r, 500)); }
  if (!up) { console.error("dev server did not answer"); process.exit(2); }

  for (const [engine, ename] of [[webkit, "webkit"], [chromium, "chromium"]]) {
    const browser = await engine.launch();
    const open = async (q, w, h, touch = false) => {
      const page = await (await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch })).newPage();
      await page.goto(`${BASE}?${q}`, { waitUntil: "load" });
      await page.waitForSelector(".sky-logo__m", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await page.evaluate(() => document.fonts.ready);
      return page;
    };

    // 1. one header per screen
    console.log(`${ename}: one header per screen`);
    for (const [q, w, h, name] of [
      ["screen=home", 1440, 900, "Home"], ["screen=home&panel=admin&mock=1", 1440, 900, "Admin hub"],
      ["screen=home", 390, 844, "Home (phone)"], ["screen=admin&fixture=synthetic", 1440, 900, "Admin · Products"],
      ["screen=admin&fixture=synthetic", 390, 844, "Admin · Products (phone)"],
      ["screen=barcodes&fixture=synthetic", 1440, 900, "Barcode Studio"], ["screen=barcodes&fixture=synthetic", 390, 844, "Barcode Studio (phone)"],
      ["screen=warehouse&fixture=synthetic", 390, 844, "Warehouse (phone)"], ["screen=warehouse&fixture=synthetic", 1024, 768, "Warehouse (1024)"],
      ["screen=phone&fixture=synthetic", 390, 844, "Store Assistant (phone)"], ["screen=desktop&fixture=synthetic", 1440, 900, "Store Assistant (laptop)"],
    ]) {
      const page = await open(q, w, h);
      const n = await marks(page);
      check(n === 1, `${name} ${w}x${h}: ${n} logo wordmark(s)`);
      await page.close();
    }

    // 2a. a full-height workspace (Admin · Products, 1440x900) fits UNDER the
    //     pinned header: no page scroll, its rail starts below the header.
    {
      const page = await open("screen=admin&fixture=synthetic", 1440, 900);
      const fit = await page.evaluate(() => {
        const bar = document.querySelector("[data-testid=sky-shellbar]").getBoundingClientRect();
        const ws = [...document.querySelectorAll("#root [style]")].find((el) => /(^|; )height: 100vh/.test(el.getAttribute("style")));
        const r = ws?.getBoundingClientRect();
        return { over: document.documentElement.scrollHeight - innerHeight, bar: bar.bottom, top: r?.top, bottom: r?.bottom };
      });
      check(fit.top != null && fit.top >= fit.bar - 1 && fit.bottom <= 900 + 1 && fit.over <= 1,
        `the Admin workspace fits under the header (starts ${fit.top?.toFixed(1)} ≥ ${fit.bar.toFixed(1)}, ends ${fit.bottom?.toFixed(1)}, page overflow ${fit.over}px)`);
      await page.close();
    }

    // 2. pinned shell header — Warehouse 390x844
    console.log(`${ename}: pinned shell header`);
    {
      const page = await open("screen=warehouse&fixture=synthetic&n=40", 390, 844, true);
      const h0 = await box(page, "[data-testid=sky-shellbar]");
      const hub0 = await box(page, ".wht-hub");
      await page.evaluate(() => window.scrollBy(0, 3000));
      await page.waitForTimeout(400);
      const h1 = await box(page, "[data-testid=sky-shellbar]"), hub1 = await box(page, ".wht-hub");
      const y = await page.evaluate(() => window.scrollY);
      check(y > 2000, `the page scrolled (${y}px)`);
      check(same(h0, h1), `the shell header's box is unchanged (${h0?.top.toFixed(1)}/${h0?.height.toFixed(1)} → ${h1?.top.toFixed(1)}/${h1?.height.toFixed(1)})`);
      check(hub1.bottom < 0 && hub0.top > h0.bottom - 1, "the hub selector started below the header and has left the viewport");
      check(await page.locator("[data-testid=sky-shellbar]").getAttribute("data-stuck") === "true", "the header's glass is on while content passes under it");
      await page.close();
    }

    // 3a. Store Assistant phone
    console.log(`${ename}: Store Assistant pinned band (phone)`);
    {
      const page = await open("screen=phone&fixture=synthetic&many=1&n=64&cart=2", 390, 844, true);
      const b0 = { band: await box(page, "[data-testid=ap-top]"), search: await box(page, ".ap-search .sky-search"), chips: await box(page, ".ap-brands"), head: await box(page, ".ap-root .sky-header") };
      const card0 = await box(page, ".ap-card");
      const band0 = Math.max(b0.band.bottom, b0.chips.bottom);
      check(card0.top >= band0 - 0.5, "the first card row starts fully below the logos");
      await page.evaluate(() => { document.querySelector("[data-testid=ap-scroll]").scrollTop = 3000; });
      await page.waitForTimeout(400);
      const b1 = { band: await box(page, "[data-testid=ap-top]"), search: await box(page, ".ap-search .sky-search"), chips: await box(page, ".ap-brands"), head: await box(page, ".ap-root .sky-header") };
      check(same(b0.head, b1.head) && same(b0.search, b1.search) && same(b0.chips, b1.chips), "header, search and brand strip boxes are unchanged after 3000px");
      check((await box(page, ".ap-card")).bottom < (await box(page, "[data-testid=ap-scroll]")).top, "the first card has left the view");
      const bar = await box(page, "[data-testid=sky-cartbar]");
      const share = (Math.max(b1.band.bottom, b1.chips.bottom) + (bar ? 844 - bar.top : 0)) / 844;
      check(bar && share < 0.45, `band + cart bar take ${(share * 100).toFixed(1)}% of the screen (< 45%)`);
      await page.close();
    }
    // 3b. Store Assistant laptop
    console.log(`${ename}: Store Assistant pinned band (laptop)`);
    {
      const page = await open("screen=desktop&fixture=synthetic&many=1&chips=ref", 1440, 900);
      const b0 = { head: await box(page, ".ad-hd"), search: await box(page, ".ad-searchwrap .sky-search"), chips: await box(page, ".ad-chips") };
      await page.evaluate(() => { document.querySelector(".ad-scroll").scrollTop = 3000; });
      await page.waitForTimeout(400);
      const b1 = { head: await box(page, ".ad-hd"), search: await box(page, ".ad-searchwrap .sky-search"), chips: await box(page, ".ad-chips") };
      check(same(b0.head, b1.head) && same(b0.search, b1.search) && same(b0.chips, b1.chips), "header, search and brand row boxes are unchanged after 3000px");
      const st = await page.evaluate(() => document.querySelector(".ad-scroll").scrollTop);
      check(st > 1000, `the grid scrolled (${st}px)`);
      check((await box(page, ".ad-card")).bottom < 0 + (await box(page, ".ad-scroll")).top, "the first card has left the view");
      await page.close();
    }
    await browser.close();
  }
} finally {
  vite.kill();
}
if (fails.length) { console.error(`\nFAIL: ${fails.length} assertion(s)`); process.exit(1); }
console.log("\nPASS: one header per screen; the header (and the order view's band) stays pinned");
