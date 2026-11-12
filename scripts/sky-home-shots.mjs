#!/usr/bin/env node
// ─── HOME SCREENSHOTS: owner and lowest-access staff, phone and desktop ──────
// Real App over the offline harness (dev/vite.harness.config.mjs). Shoots Home
// and the Admin hub as the owner, and Home as the store-assistant-only staff
// account (localStorage harness_user=staff), at 390x844 and 1440x900, and
// asserts the Display Check tile is there for both and the Shipment Release +
// Hub Count cards are on the owner's Admin hub.
//   node scripts/sky-home-shots.mjs --shots DIR [--prefix after] [--port 5213] [--no-assert]
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt("--port", 5213));
const SHOTS = opt("--shots", "home-shots");
const PREFIX = opt("--prefix", "after");
const ASSERT = !args.includes("--no-assert");
const BASE = `http://localhost:${PORT}/dev/sky-app.html`;
mkdirSync(SHOTS, { recursive: true });

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); };

const vite = spawn("npx", ["vite", "--config", "dev/vite.harness.config.mjs", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
const stopVite = () => { try { process.kill(-vite.pid); } catch { /* gone */ } };
process.on("exit", stopVite);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("vite did not start")), 60000);
  vite.stdout.on("data", (d) => { if (String(d).includes("Local")) { clearTimeout(t); res(); } });
});
const browser = await chromium.launch();
try {
  for (const who of ["owner", "staff"]) {
    for (const { w, h } of [{ w: 390, h: 844 }, { w: 1440, h: 900 }]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      await page.addInitScript((u) => { try { localStorage.clear(); if (u === "staff") localStorage.setItem("harness_user", "staff"); } catch { /* none */ } }, who);
      await page.goto(BASE);
      await page.waitForSelector("[data-testid=sky-home]", { timeout: 30000 });
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `${SHOTS}/${PREFIX}-home-${who}-${w}x${h}.png` });
      if (ASSERT) check(await page.locator("[data-testid=home-tile-display_checks]").count() === 1, `${who} ${w}x${h}: Display Check tile on Home`);
      if (who === "owner") {
        await page.click("[data-testid=home-tile-admin]");
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `${SHOTS}/${PREFIX}-adminhub-${who}-${w}x${h}.png` });
        if (ASSERT) {
          check(await page.locator("[data-testid=home-card-stock_hold]").count() === 1, `${who} ${w}x${h}: Shipment Release card on the Admin hub`);
          check(await page.locator("[data-testid=home-card-hub_sneaker_count]").count() === 1, `${who} ${w}x${h}: Hub Count card on the Admin hub`);
        }
      } else if (await page.locator("[data-testid=home-tile-display_checks]").count()) {
        await page.click("[data-testid=home-tile-display_checks]");
        await page.waitForTimeout(1500);
        check(await page.locator("[data-testid=sky-home]").count() === 0, `${who} ${w}x${h}: Display Check opens (left Home)`);
        await page.screenshot({ path: `${SHOTS}/${PREFIX}-displaycheck-${who}-${w}x${h}.png` });
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  stopVite();
}
console.log(fails.length ? `\n${fails.length} failure(s)` : "\nall ok");
process.exit(fails.length ? 1 : 0);
