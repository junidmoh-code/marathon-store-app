#!/usr/bin/env node
// ─── THE PHONE STORE ASSISTANT IS FROZEN (Junid, 5 Nov 2026) ─────────────────
//
// design/assistant-phone-approved-390.png and -430.png are the approved phone
// layout. This test renders the real AssistantPhone (dev/sky-harness.html,
// fixed synthetic products so it never depends on local data) at 390x844 and
// 430x932 and fails when more than 1% of the pixels drift. Product images and
// prices are masked (data changes); everything else — header, store line,
// search, brand strip, card frames, names, plus buttons — must match.
//
// Changing the phone layout needs Junid's say-so (design/DNA.md). With it:
//   node scripts/sky-phone-visual.e2e.mjs --update     (rewrites the two PNGs)
//
//   node scripts/sky-phone-visual.e2e.mjs [--port 5203]
//   exit 0 = pass; 1 = drift; 2 = harness error / missing reference

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const PORT = Number(i >= 0 ? args[i + 1] : 5203);
const UPDATE = args.includes("--update");
const URL = `http://localhost:${PORT}/dev/sky-harness.html?screen=phone&fixture=synthetic`;
const THRESHOLD = 0.01;     // 1% of the pixels
const CHANNEL = 40;         // a pixel counts as changed when a channel moves more than this (anti-aliasing noise is less)
const SIZES = [[390, 844, "design/assistant-phone-approved-390.png"], [430, 932, "design/assistant-phone-approved-430.png"]];

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
let failed = false;
try {
  let up = false;
  for (let t = 0; t < 120 && !up; t++) {
    try { up = (await fetch(URL)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) { console.error("dev server did not answer"); process.exit(2); }

  const browser = await chromium.launch();
  for (const [w, h, ref] of SIZES) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })).newPage();
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForSelector(".ap-card", { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    const shot = await page.screenshot({
      animations: "disabled", caret: "hide",
      mask: [page.locator(".ap-card .sky-stage"), page.locator(".ap-price")], maskColor: "#ff00ff",
    });
    await page.close();
    if (UPDATE) {
      await sharp(shot).png().toFile(ref);
      console.log(`  wrote ${ref}`);
      continue;
    }
    if (!existsSync(ref)) { console.error(`missing reference ${ref} — run with --update (only with Junid's say-so)`); process.exit(2); }
    const [a, b] = await Promise.all([sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(ref).ensureAlpha().raw().toBuffer({ resolveWithObject: true })]);
    if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
      console.log(`  FAIL ${w}x${h}: size ${a.info.width}x${a.info.height} vs reference ${b.info.width}x${b.info.height}`);
      failed = true; continue;
    }
    const n = a.info.width * a.info.height;
    const diff = Buffer.alloc(n * 4);
    let changed = 0;
    for (let p = 0; p < n; p++) {
      const o = p * 4;
      const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
      if (d > CHANNEL) { changed++; diff[o] = 255; diff[o + 3] = 255; } else { diff[o] = diff[o + 1] = diff[o + 2] = b.data[o] >> 2; diff[o + 3] = 255; }
    }
    const ratio = changed / n;
    const ok = ratio <= THRESHOLD;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${w}x${h}: ${(ratio * 100).toFixed(3)}% of pixels drifted (limit ${THRESHOLD * 100}%)`);
    if (!ok) {
      failed = true;
      mkdirSync("visual-report", { recursive: true });
      await sharp(shot).png().toFile(`visual-report/phone-${w}-actual.png`);
      await sharp(diff, { raw: { width: a.info.width, height: a.info.height, channels: 4 } }).png().toFile(`visual-report/phone-${w}-diff.png`);
    }
  }
  await browser.close();
} finally {
  vite.kill();
}
if (UPDATE) { console.log("\nreferences updated"); process.exit(0); }
if (failed) { console.error("\nFAIL: the phone Store Assistant drifted from the approved layout (visual-report/)"); process.exit(1); }
console.log("\nPASS: the phone Store Assistant matches the approved layout");
