#!/usr/bin/env node
// ─── SKY-WALL v3 — THE PHONE ORDER VIEW (Junid, 6 Nov) ──────────────────────
//
// iPhone-sized, in WebKit (Safari's engine) and Chromium, at 390x844 and
// 430x932 with a notch simulated (--sky-sat 47px / --sky-sab 34px — Playwright
// cannot set env(); the app reads the insets through those variables):
//   1. SAFE AREAS: the header sits 12–16px below the inset; nothing is wider
//      than the screen.
//   2. PINNED TOP (like the laptop): the logo, store line, search and brand
//      logos stay put; only the shoes scroll, in their own area under the
//      search; the logos float over them with nothing behind them.
//   3. THE SHEET: a card tap opens it (bottom-anchored, opaque); a tap on the
//      dimmed area, the close button and a drag down on the handle each close
//      it; a long press on a size shows its count and does not select it.
//   4. LAPTOP (1440x900, 1280x800): only the sneaker grid scrolls.
// (No back-to-top and no tile three-dot are pinned on App.jsx itself, in
// src/components/sky/skyWallV3.test.jsx — the harness never had either.)
//
//   node scripts/sky-wall-v3.e2e.mjs [--port 5205]
//   exit 0 = pass; 1 = an assertion failed; 2 = harness error

import { spawn } from "node:child_process";
import { chromium, webkit } from "@playwright/test";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const PORT = Number(i >= 0 ? args[i + 1] : 5205);
const URL = `http://localhost:${PORT}/dev/sky-harness.html?screen=phone&fixture=synthetic`;
const NOTCH = 47;

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); };
const rect = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } : null; }, sel);
const open = (page) => page.locator("[data-testid=phone-popup]").count().then((n) => n > 0);

try {
  let up = false;
  for (let t = 0; t < 120 && !up; t++) {
    try { up = (await fetch(URL)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) { console.error("dev server did not answer"); process.exit(2); }

  for (const [engine, ename] of [[webkit, "webkit"], [chromium, "chromium"]]) {
    const browser = await engine.launch();
    for (const [w, h] of [[390, 844], [430, 932]]) {
      console.log(`${ename} ${w}x${h}`);
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: ename === "chromium" ? true : undefined });
      const page = await ctx.newPage();
      await page.goto(`${URL}&n=16`, { waitUntil: "load" });
      await page.addStyleTag({ content: `:root{--sky-sat:${NOTCH}px!important;--sky-sab:34px!important}` });
      await page.waitForSelector(".ap-card", { timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);

      // 1. safe areas
      const round = await rect(page, ".ap-root .sky-header .sky-round");
      const logo = await rect(page, ".ap-root .sky-logo");
      check(round && round.top >= NOTCH + 12 && round.top <= NOTCH + 22, `header buttons sit below the notch with a 12–16px gap (top ${round?.top.toFixed(1)})`);
      check(logo && logo.top >= NOTCH + 8, `the wordmark clears the notch (top ${logo?.top.toFixed(1)})`);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(wide <= 0, `nothing runs off the sides (overflow ${wide}px)`);

      // 2. pinned top, like the laptop: only the shoes scroll (.ap-scroll),
      //    the logos float over them with nothing behind them.
      const before = { top: await rect(page, "[data-testid=ap-top]"), search: await rect(page, ".ap-search .sky-search"), chips: await rect(page, ".ap-brands"), card: await rect(page, ".ap-card") };
      await page.evaluate(() => { document.querySelector("[data-testid=ap-scroll]").scrollTop = 420; });
      await page.waitForTimeout(400);
      const after = { top: await rect(page, "[data-testid=ap-top]"), search: await rect(page, ".ap-search .sky-search"), chips: await rect(page, ".ap-brands"), card: await rect(page, ".ap-card") };
      check(Math.abs(after.top.top) < 0.5 && Math.abs(after.top.height - before.top.height) < 0.5, `the header stays at the top with the same height (${before.top.height.toFixed(1)} → ${after.top.height.toFixed(1)})`);
      check(Math.abs(after.search.top - before.search.top) < 0.5 && Math.abs(after.chips.top - before.chips.top) < 0.5, "the search box and the brand logos do not move");
      check(after.card.top < before.card.top - 300, "the shoes scrolled under the logos");
      check(await page.evaluate(() => window.scrollY) === 0, "the page itself never scrolls");
      const behind = await page.evaluate(() => ["[data-testid=ap-top]", "[data-testid=ap-brands-float]", ".ap-brands"].map((sel) => {
        const c = getComputedStyle(document.querySelector(sel));
        return `${c.backgroundColor}|${c.backgroundImage}|${c.backdropFilter || c.webkitBackdropFilter || "none"}`;
      }));
      check(behind.every((x) => /^rgba\(0, 0, 0, 0\)\|none\|none$/.test(x)), `nothing behind the header, search or logos (${behind.join(" · ")})`);
      const scrollTop = (await rect(page, "[data-testid=ap-scroll]")).top;
      check(Math.abs(scrollTop - after.search.bottom) < 14, "the shoes' area starts under the search box (nothing slides behind the header)");
      await page.evaluate(() => { document.querySelector("[data-testid=ap-scroll]").scrollTop = 0; });
      await page.waitForTimeout(300);

      // 3. the sheet
      const tapCard = async () => { const b = await page.locator(".ap-card").nth(0).boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + 40); await page.waitForTimeout(450); };
      await tapCard();
      check(await open(page), "a card tap opens the sheet");
      const sh = await rect(page, "[data-testid=phone-popup]");
      check(sh && Math.abs(sh.bottom - h) < 1.5, `the sheet is anchored to the bottom (bottom ${sh?.bottom.toFixed(1)} of ${h})`);
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=phone-popup]")).backgroundImage);
      check(!/rgba\(/.test(bg), "the sheet is solid (no see-through stops)");
      const blur = await page.evaluate(() => { const c = getComputedStyle(document.querySelector(".sky-sheetscrim")); return (c.backdropFilter || c.webkitBackdropFilter || "") + "|" + c.backgroundColor; });
      check(/blur/.test(blur) && /rgba/.test(blur), `the grid behind dims and blurs (${blur})`);

      // long press a size: the count shows, nothing is selected
      const sz = page.locator("[data-testid=phone-popup] .sky-szq").first();
      const sb = await sz.boundingBox();
      await sz.dispatchEvent("pointerdown", { pointerId: 9, pointerType: "touch", clientX: sb.x + 10, clientY: sb.y + 10 });
      await page.waitForTimeout(650);
      await sz.dispatchEvent("pointerup", { pointerId: 9, pointerType: "touch" });
      await sz.dispatchEvent("click");
      check(await page.locator("[data-testid=size-peek]").count() === 1, "a long press on a size shows its count");
      check(await sz.getAttribute("aria-pressed") === "false", "and does not select it");
      check(await page.evaluate(() => getComputedStyle(document.querySelector(".sky-szq__n")).display) === "none", "counts are hidden on the pills");

      // close: dimmed area
      await page.touchscreen.tap(w / 2, 30);
      await page.waitForTimeout(350);
      check(!(await open(page)), "a tap on the dimmed area closes it");
      // close: the button
      await tapCard();
      await page.locator("[data-testid=sheet-close]").click();
      await page.waitForTimeout(350);
      check(!(await open(page)), "the close button closes it");
      // close: drag the handle down
      await tapCard();
      const hb = await page.locator(".sky-sheet__handle").boundingBox();
      const x = hb.x + hb.width / 2, y = hb.y + hb.height / 2;
      const ev = (type, dy) => page.locator(".sky-sheet__handle").dispatchEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y + dy, bubbles: true });
      await ev("pointerdown", 0);
      for (const dy of [10, 40, 80, 130, 180]) { await ev("pointermove", dy); await page.waitForTimeout(16); }
      await ev("pointerup", 180);
      await page.waitForTimeout(350);
      check(!(await open(page)), "dragging the handle down closes it");
      // a short drag springs back
      await tapCard();
      await ev("pointerdown", 0);
      await page.waitForTimeout(300);
      for (const dy of [10, 30, 50]) { await ev("pointermove", dy); await page.waitForTimeout(40); }
      await ev("pointerup", 50);
      await page.waitForTimeout(350);
      check(await open(page), "a short slow drag springs back (stays open)");
      await ctx.close();
    }
    // 4. THE LAPTOP ORDER SCREEN (Junid's mock-up, 6 Nov): only the sneakers
    //    scroll — the wordmark, pills, search and brand row stay put.
    for (const [w, h] of [[1440, 900], [1280, 800]]) {
      console.log(`${ename} laptop ${w}x${h}`);
      const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
      await page.goto(URL.replace("screen=phone&fixture=synthetic", "screen=desktop&fixture=synthetic&chips=ref"), { waitUntil: "load" });
      await page.waitForSelector(".ad-card", { timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const s0 = await rect(page, ".ad-searchwrap .sky-search"), c0 = await rect(page, ".ad-chips"), g0 = await rect(page, ".ad-card");
      const b = await page.locator(".ad-scroll").boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + 200);
      for (let k = 0; k < 6; k++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
      await page.waitForTimeout(400);
      const s1 = await rect(page, ".ad-searchwrap .sky-search"), c1 = await rect(page, ".ad-chips"), g1 = await rect(page, ".ad-card");
      const st = await page.evaluate(() => [document.querySelector(".ad-scroll").scrollTop, window.scrollY, document.querySelector(".ad-root").scrollTop]);
      check(st[0] > 100, `the sneaker grid scrolls (scrollTop ${st[0]})`);
      check(g1.top < g0.top - 100, "the cards moved");
      check(Math.abs(s1.top - s0.top) < 0.5 && Math.abs(c1.top - c0.top) < 0.5, "the search box and brand row did not move");
      check(st[1] === 0 && st[2] === 0, "the page itself never scrolls");
      await page.close();
    }
    await browser.close();
  }
} finally {
  vite.kill();
}
if (fails.length) { console.error(`\nFAIL: ${fails.length} assertion(s)`); process.exit(1); }
console.log("\nPASS: safe areas, sticky header and the bottom sheet");
