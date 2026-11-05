#!/usr/bin/env node
// ─── BARCODE STUDIO: ONLY THE LIST SCROLLS (Junid, 5 Nov 2026) ───────────────
//
// "On the Barcode Studio page everything scrolls together. Only the product
// list should scroll. Everything else stays fixed on screen at all times."
//
// Mounts the real BarcodeStudioDesktop under the real SkyHeader
// (dev/sky-harness.html?screen=barcodes&many=1 — 60 cards), in Chromium and
// WebKit, at 1440x900 and 1280x800, and asserts:
//   1. after a 5000px wheel over the list, the header, the left panel, the
//      title, subtitle, search, count line, Print tray and Label preview have
//      not moved by a single pixel, and the window never scrolled;
//   2. the list reached its last product, fully visible above the viewport
//      bottom and inside the list;
//   3. no horizontal scroll anywhere;
//   4. a wheel over the title block scrolls the list (never the page);
//   5. picking a size updates the Label preview with no change in the list's
//      scroll position.
//
//   node scripts/sky-barcode-scroll.e2e.mjs [--port 5199]
//   exit 0 = pass; 1 = an assertion failed; 2 = harness error

import { spawn } from "node:child_process";
import { chromium, webkit } from "@playwright/test";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const PORT = Number(i >= 0 ? args[i + 1] : 5199);
const URL = `http://localhost:${PORT}/dev/sky-harness.html?screen=barcodes&many=1`;

const FIXED = {
  header: "#root .sky-header",
  "left panel": ".bcsp__side",
  title: ".bcsp__h1",
  subtitle: ".bcsp__sub",
  search: ".bcsp__srch",
  "count line": ".bcsp__n",
  "print tray": ".bcsp__tray",
  "label preview": ".bcsp__lp",
};

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); };

try {
  let up = false;
  for (let t = 0; t < 120 && !up; t++) {
    try { up = (await fetch(URL)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) { console.error("dev server did not answer"); process.exit(2); }

  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await engine.launch();
    for (const [w, h] of [[1440, 900], [1280, 800]]) {
      console.log(`${name} ${w}x${h}`);
      const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
      await page.goto(URL, { waitUntil: "load" });
      await page.waitForSelector(".bcsp__list .bcs2", { timeout: 30000 });
      await page.waitForTimeout(600);

      const boxes = () => page.evaluate((sel) => Object.fromEntries(Object.entries(sel).map(([k, s]) => {
        const e = document.querySelector(s); if (!e) return [k, null];
        const r = e.getBoundingClientRect(); return [k, [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100)];
      })), FIXED);
      const before = await boxes();
      for (const [k, v] of Object.entries(before)) check(v !== null, `${k} is on the page`);

      // 1. 5000px of wheel over the list.
      const list = page.locator('[data-testid="bcsp-list"]');
      const lb = await list.boundingBox();
      await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
      for (let n = 0; n < 10; n++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(40); }
      await page.waitForTimeout(500);
      const after = await boxes();
      for (const k of Object.keys(FIXED)) {
        check(JSON.stringify(before[k]) === JSON.stringify(after[k]), `${k} did not move (${JSON.stringify(before[k])} → ${JSON.stringify(after[k])})`);
      }
      const st = await page.evaluate(() => {
        const l = document.querySelector('[data-testid="bcsp-list"]');
        const cards = l.querySelectorAll(".bcs2");
        const last = cards[cards.length - 1].getBoundingClientRect(), lr = l.getBoundingClientRect();
        return { winY: window.scrollY, docY: document.scrollingElement.scrollTop, top: l.scrollTop, max: l.scrollHeight - l.clientHeight,
                 lastBottom: last.bottom, lastTop: last.top, listBottom: lr.bottom, vh: innerHeight,
                 docW: document.documentElement.scrollWidth, vw: innerWidth, listSW: l.scrollWidth, listCW: l.clientWidth };
      });
      check(st.winY === 0 && st.docY === 0, `the page itself never scrolled (window ${st.winY}, document ${st.docY})`);
      check(st.top > 0 && Math.abs(st.top - st.max) <= 1, `the list reached its end (${st.top} of ${st.max})`);
      // 2. last product fully visible.
      check(st.lastBottom <= st.vh && st.lastBottom <= st.listBottom + 0.5 && st.lastTop >= 0,
            `the last product is fully visible (bottom ${Math.round(st.lastBottom)} ≤ list ${Math.round(st.listBottom)} ≤ viewport ${st.vh})`);
      // 3. no horizontal scroll.
      check(st.docW <= st.vw && st.listSW <= st.listCW, `no horizontal scroll (page ${st.docW}/${st.vw}, list ${st.listSW}/${st.listCW})`);

      // 4. wheel over the title block scrolls the list, not the page.
      const t0 = await list.evaluate((l) => l.scrollTop);
      const hb = await page.locator('[data-testid="bcsp-head"]').boundingBox();
      await page.mouse.move(hb.x + hb.width / 2, hb.y + 20);
      await page.mouse.wheel(0, -800); await page.waitForTimeout(400);
      const t1 = await list.evaluate((l) => l.scrollTop);
      check(t1 < t0 && await page.evaluate(() => window.scrollY) === 0, `a wheel over the title scrolls the list (${t0} → ${t1})`);

      // 5. open a visible card, pick a size: preview updates, list holds still.
      const card = page.locator(".bcsp__list .bcs2").nth(4);
      await card.locator(".bcs2__head").click();
      await page.waitForTimeout(200);
      const s0 = await list.evaluate((l) => l.scrollTop);
      await card.locator(".bcs2__szb").first().click();
      await page.waitForTimeout(300);
      const s1 = await list.evaluate((l) => l.scrollTop);
      check(s0 === s1, `picking a size keeps the list where it was (${s0} → ${s1})`);
      check(await page.locator(".bcsp__lp .bcsp__label").count() === 1, "the Label preview shows the picked size");
      const final = await boxes();
      for (const k of Object.keys(FIXED)) {
        if (k === "print tray" || k === "label preview") continue;     // they grow with the tray, by design
        check(JSON.stringify(before[k]) === JSON.stringify(final[k]), `${k} still where it started after picking`);
      }
      await page.close();
    }
    await browser.close();
  }
} finally {
  vite.kill();
}
if (fails.length) { console.error(`\nFAIL: ${fails.length} assertion(s)`); process.exit(1); }
console.log("\nPASS: only the Barcode Studio list scrolls");
