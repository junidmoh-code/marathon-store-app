#!/usr/bin/env node
// ─── THE APP DOES NOT ZOOM (Junid, 5 Nov 2026) ───────────────────────────────
//
// iPhone and iPad emulation in WebKit (Safari's engine) and a Pixel in
// Chromium, on the real sky screens (dev/sky-harness.html):
//   1. the viewport meta forbids scaling; html is touch-action: manipulation;
//   2. a pinch on the product grid is cancelled (WebKit gesturestart and a
//      two-finger / scaled touchmove are default-prevented) — and a ONE-finger
//      touchmove is not (scrolling still works);
//   3. a double-tap on a card does its normal tap and the page stays at scale 1;
//   4. focusing the search does not zoom: the field is at least 16px on touch;
//   5. inside the photo viewer, a two-finger pinch DOES zoom the photo (its own
//      transform, 1–4×), double-tap toggles 1 ↔ 2.5, and the page stays at 1.
//
//   node scripts/sky-zoom-lock.e2e.mjs [--port 5201]
//   exit 0 = pass; 1 = an assertion failed; 2 = harness error

import { spawn } from "node:child_process";
import { chromium, webkit, devices } from "@playwright/test";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const PORT = Number(i >= 0 ? args[i + 1] : 5201);
const BASE = `http://localhost:${PORT}/dev/sky-harness.html`;

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); };

// Synthetic events, so the same assertions run in both engines.
const fire = (page, sel, kind) => page.evaluate(([sel, kind]) => {
  const el = document.querySelector(sel);
  let ev;
  if (kind === "gesture") ev = new Event("gesturestart", { bubbles: true, cancelable: true });
  else {
    ev = new Event("touchmove", { bubbles: true, cancelable: true });
    const two = kind === "pinch";
    Object.defineProperty(ev, "touches", { value: two ? [{}, {}] : [{}] });
    Object.defineProperty(ev, "scale", { value: two ? 1.8 : 1 });
  }
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}, [sel, kind]);

const pointers = (page, sel, steps) => page.evaluate(([sel, steps]) => {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (const [type, id, dx, dy] of steps) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: cx + dx, clientY: cy + dy }));
  }
}, [sel, steps]);

try {
  let up = false;
  for (let t = 0; t < 120 && !up; t++) {
    try { up = (await fetch(BASE)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) { console.error("dev server did not answer"); process.exit(2); }

  const runs = [["webkit iPhone", webkit, devices["iPhone 13"]], ["webkit iPad", webkit, devices["iPad (gen 7)"]], ["chromium Pixel", chromium, devices["Pixel 7"]]];
  for (const [name, engine, device] of runs) {
    console.log(name);
    const browser = await engine.launch();
    const ctx = await browser.newContext({ ...device });
    const page = await ctx.newPage();

    // ── the grid ──
    await page.goto(`${BASE}?screen=phone&fixture=synthetic`, { waitUntil: "load" });
    await page.waitForSelector(".ap-card", { timeout: 30000 });
    const meta = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.content || "");
    check(/maximum-scale=1\b/.test(meta) && /user-scalable=no/.test(meta), `viewport meta forbids zoom (${meta})`);
    check(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction) === "manipulation", "html is touch-action: manipulation (no double-tap zoom)");
    check(await fire(page, ".ap-card", "gesture"), "a pinch gesture on the grid is cancelled (gesturestart)");
    check(await fire(page, ".ap-card", "pinch"), "a two-finger scaled touchmove on the grid is cancelled");
    check(!(await fire(page, ".ap-card", "scroll")), "a one-finger touchmove is left alone (scrolling works)");

    // double-tap on a card: its normal action, no zoom
    const card = page.locator(".ap-card").first();
    const box = await card.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 40);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 40);
    await page.waitForTimeout(400);
    check(await page.evaluate(() => (window.visualViewport ? window.visualViewport.scale : 1)) === 1, "double-tap on a card leaves the page at scale 1");
    check(await card.getAttribute("aria-current") === "true", "and the card's own tap action ran (it is the selected card)");

    // focus the search: 16px on touch, no zoom
    const input = page.locator(".ap-search input");
    await input.tap();
    await page.waitForTimeout(300);
    const fs = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check(fs >= 16, `the search field is at least 16px on touch (${fs}px), so focusing it never zooms`);
    check(await page.evaluate(() => (window.visualViewport ? window.visualViewport.scale : 1)) === 1, "focusing the search leaves the page at scale 1");

    // ── the photo viewer ──
    await page.goto(`${BASE}?screen=viewer`, { waitUntil: "load" });
    await page.waitForSelector("[data-zoom-surface]", { timeout: 30000 });
    const z = "[data-zoom-surface]";
    const scale = () => page.locator(z).getAttribute("data-zoom-scale").then(Number);
    check(await scale() === 1, "the viewer opens at 1×");
    await pointers(page, z, [["pointerdown", 1, -20, 0], ["pointerdown", 2, 20, 0], ["pointermove", 1, -60, 0], ["pointermove", 2, 60, 0], ["pointermove", 1, -90, 0], ["pointermove", 2, 90, 0], ["pointerup", 1, -90, 0], ["pointerup", 2, 90, 0]]);
    await page.waitForTimeout(300);
    const pinched = await scale();
    check(pinched > 1.5 && pinched <= 4, `a pinch inside the viewer zooms the photo (${pinched}×)`);
    await pointers(page, z, [["pointerdown", 3, 0, 0], ["pointerup", 3, 0, 0], ["pointerdown", 4, 0, 0], ["pointerup", 4, 0, 0]]);
    await page.waitForTimeout(300);
    check(await scale() === 1, "double-tap while zoomed goes back to 1×");
    await pointers(page, z, [["pointerdown", 5, 0, 0], ["pointerup", 5, 0, 0], ["pointerdown", 6, 0, 0], ["pointerup", 6, 0, 0]]);
    await page.waitForTimeout(300);
    check(await scale() === 2.5, "double-tap at 1× zooms to 2.5×");
    check(await page.evaluate(() => (window.visualViewport ? window.visualViewport.scale : 1)) === 1, "the page behind the viewer stays at scale 1");

    await browser.close();
  }
} finally {
  vite.kill();
}
if (fails.length) { console.error(`\nFAIL: ${fails.length} assertion(s)`); process.exit(1); }
console.log("\nPASS: the app does not zoom; the photo viewer does");
