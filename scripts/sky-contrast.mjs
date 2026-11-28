#!/usr/bin/env node
// ─── SKY CONTRAST GATE ───────────────────────────────────────────────────────
//
// Junid, 2026-11-02: text on the sky glass must be READABLE — white text on
// thin glass landed on white clouds. This gate proves it on the rendered page,
// not in theory:
//
//   1. Start vite and open each route at 1440x900 and 390x844 (Playwright,
//      Chromium; --webkit adds WebKit, the iPad Safari engine).
//   2. Collect every visible element that draws text of its own.
//   3. Screenshot the page; then make ALL text transparent and screenshot
//      again — the second shot is exactly what sits behind each glyph: glass,
//      the photo through the glass, a card.
//   4. For each text element, blend its computed colour over every background
//      pixel in its box and take the 10th-percentile contrast (the worst
//      reasonable spot, ignoring a few stray pixels). Under 4.5:1 fails.
//
// Exempt by design (Junid's rule): the wordmark and the four home tiles, which
// are white with a text shadow. Inputs' typed values are not text elements.
//
// Routes are the dev harness (dev/sky-harness.html — the real components with
// fixtures; the app itself needs a staff sign-in) plus the real sign-in page.
//
//   node scripts/sky-contrast.mjs [--webkit] [--out dir] [--port 5198] [--only route,…]
//   exit 0 = every text element passes; 1 = failures (listed); 2 = harness error

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "@playwright/test";
import sharp from "sharp";

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(flag("--port", 5198));
const OUT = flag("--out", "contrast-report");
const ENGINES = args.includes("--webkit") ? [["chromium", chromium], ["webkit", webkit]] : [["chromium", chromium]];
const MIN = 4.5;
const ONLY = flag("--only", null)?.split(",");   // --only route,route (a subset, for iterating)
const SHOW = flag("--show", null)?.split("|");                // --show text|class: print the measured contrast of matching elements
const BASE = `http://localhost:${PORT}`;
const H = "/dev/sky-harness.html";

export const ROUTES = [
  ["sign-in", "/"],
  ["home", `${H}?screen=home`],
  ["home-admin-hub", `${H}?screen=home&panel=admin`],
  ["admin-products", `${H}?screen=admin`],
  ["assistant", `${H}?screen=desktop&chips=ref`],
  ["assistant-brands", `${H}?screen=desktop&chips=ref&brands=1`],
  ["assistant-popup", `${H}?screen=desktop&popup=1`],
  // The unavailable size tapped: the why-note and "Available now instead".
  ["assistant-popup-out", `${H}?screen=desktop&popup=1&out=1`],
  ["assistant-phone", `${H}?screen=phone&cart=2`],
  ["barcode-cards", `${H}?screen=barcodes&open=1`],
  // Barcode Studio as it opens (Junid 12 Nov, design/barcode-studio.png):
  // white titles, labels and empty-state text on the saturated blue panels.
  ["barcode-studio", `${H}?screen=barcodes`],
  ["assistant-phone-brands", `${H}?screen=phone&chips=ref&brand=Reebok`],
  // Warehouse (Junid 6 Nov): one glass level per nesting, navy ink on glass.
  ["warehouse", `${H}?screen=warehouse`],
  ["assistant-phone-sheet", `${H}?screen=phone&sheet=1`],
  // THE ONE OVERLAY (Junid 6 Nov): each overlay opened, its text sampled over
  // the panel (the page behind is under the scrim and not sampled).
  ["overlay-picker-phone", `${H}?screen=phone&pill=1`],
  ["overlay-confirm-phone", `${H}?screen=phone&switch=1&cart=2`],
  ["overlay-account-phone", `${H}?screen=phone&me=1`],
  ["overlay-picker-desktop", `${H}?screen=desktop&chips=ref&pill=1`],
  ["overlay-confirm-desktop", `${H}?screen=desktop&chips=ref&switch=1`],
  ["overlay-account-desktop", `${H}?screen=desktop&chips=ref&me=1`],
];
// --admin: the admin screens (Junid 6 Nov — admin design system), on the REAL
// App over the offline synthetic database (dev/sky-app.html under
// dev/vite.harness.config.mjs). Each route lands by localStorage (+ hash, + a
// tap). In this mode inputs (their value text), disabled controls and
// destructive buttons are judged too — the brief names all three.
const ADMIN = args.includes("--admin");
const A = "/dev/sky-app.html";
const PID = "p1790000000000";
export const ADMIN_ROUTES = [
  ["admin-home", A, { ls: {}, tap: "[data-testid=home-tile-admin]" }],
  ["admin-products", A, { ls: { marathon_role: "admin", marathon_admin_section: "products" } }],
  ["admin-product-edit", `${A}#product/${PID}`, { ls: { marathon_role: "admin" } }],
  ["admin-missing-prices", A, { ls: { marathon_role: "admin", marathon_admin_section: "missing-prices" } }],
  ["admin-assign-categories", A, { ls: { marathon_role: "admin", marathon_admin_section: "assign-categories" } }],
  ["admin-categories", A, { ls: { marathon_role: "admin", marathon_admin_section: "review-categories" } }],
  ["admin-bulk-pricing", A, { ls: { marathon_role: "admin", marathon_admin_section: "bulk-pricing" } }],
  ["admin-specials", A, { ls: { marathon_role: "admin", marathon_admin_section: "specials" } }],
  ["admin-taxonomy", A, { ls: { marathon_role: "admin", marathon_admin_section: "taxonomy" } }],
  ["shopify", A, { ls: { marathon_role: "shopify_publish" } }],
  ["shopify-live", A, { ls: { marathon_role: "shopify_publish" }, tap: "[data-testid=shopify-tab-live]" }],
  ["shopify-product", `${A}#shopify/${PID}`, { ls: { marathon_role: "shopify_publish" } }],
  ["social", A, { ls: { marathon_role: "social" } }],
  ["social-album", A, { ls: { marathon_role: "social" }, tap: "[data-testid=social-tab-album]" }],
  ["social-style", A, { ls: { marathon_role: "social" }, tap: "[data-testid=social-tab-library]" }],
  ["social-generate", A, { ls: { marathon_role: "social" }, tap: "[data-testid=social-tab-generate]" }],
  ["social-policy", A, { ls: { marathon_role: "social" }, tap: "[data-testid=social-tab-policy]" }],
  // Junid 12 Nov: Barcode Studio and the Labels screen on the real App.
  ["barcode-studio-app", A, { ls: { marathon_role: "barcodes" } }],
  ["labels", A, { ls: { marathon_role: "label_print" } }],
];
export const SIZES = [[1440, 900], [390, 844]];
// Routes that are also judged at a size beyond SIZES (Junid 12 Nov: Barcode
// Studio at 1280x800, the second laptop size of his reference).
export const EXTRA_SIZES = {
  "barcode-cards": [[1280, 800]],
  "barcode-studio": [[1280, 800]],
  "barcode-studio-app": [[1280, 800]],
};
const ALL_SIZES = [...SIZES, ...Object.values(EXTRA_SIZES).flat()]
  .filter((s, i, a) => a.findIndex((t) => t[0] === s[0] && t[1] === s[1]) === i);
const routeAtSize = (name, w, h) => SIZES.some(([a, b]) => a === w && b === h)
  || (EXTRA_SIZES[name] || []).some(([a, b]) => a === w && b === h);
const EXEMPT = ".sky-logo, .sky-tile, [data-contrast-exempt]";

// ── WCAG relative luminance / contrast ──
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => { const [x, y] = a > b ? [a, b] : [b, a]; return (x + 0.05) / (y + 0.05); };

async function waitFor(url, ms = 60000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not answer at ${url}`);
}

async function textElements(page, strict = false) {
  return page.evaluate(([EXEMPT, strict]) => {
    const out = [];
    const vw = innerWidth, vh = innerHeight;
    // Strict (admin): the value text of every field is judged like any text.
    if (strict) {
      for (const el of document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]), textarea, select")) {
        if (el.closest(EXEMPT) || !el.value) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
        const b = el.getBoundingClientRect();
        const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0, fs = parseFloat(cs.fontSize);
        const cy = b.top + b.height / 2;
        const x0 = Math.max(0, b.left + pl), x1 = Math.min(vw, b.right - pr), y0 = Math.max(0, cy - fs * 0.45), y1 = Math.min(vh, cy + fs * 0.45);
        if (x1 - x0 < 3 || y1 - y0 < 4) continue;
        const top = document.elementFromPoint((x0 + x1) / 2, cy);
        if (!top || (top !== el && !el.contains(top))) continue;
        const m = cs.color.match(/rgba?\(([^)]+)\)/);
        if (!m) continue;
        const [r, g, bb, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        out.push({ text: `[field] ${String(el.value).slice(0, 40)}`, tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60),
                   box: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)], color: [r, g, bb, a * (Number(cs.opacity) || 1)],
                   size: fs, weight: Number(cs.fontWeight) || 400 });
      }
    }
    for (const el of document.querySelectorAll("body *")) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "INPUT", "TEXTAREA", "SELECT", "OPTION", "svg"].includes(el.tagName)) continue;
      if (el.closest(EXEMPT) || el.closest("[aria-hidden='true']")) continue;
      // WCAG 1.4.3 exempts inactive controls; screen-reader-only text is not seen.
      // The navy "0" on an unavailable size IS the signal, so it is checked anyway.
      // Strict (admin) mode judges disabled controls too.
      if (!strict && el.closest("button:disabled, [aria-disabled='true'], [disabled]") && !el.closest("[data-contrast-check]")) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      // Hidden by an ANCESTOR's opacity (the hover quick-add strip at rest).
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      // Only the box of the text itself (a Range over the element's own text).
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 2 && r.height > 4);
      if (!rects.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of rects) { x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
      // Clip to the element's own box: an ellipsis-truncated name's text range
      // runs on past the card, over whatever lies beyond it.
      x0 = Math.max(0, x0, box.left); y0 = Math.max(0, y0, box.top); x1 = Math.min(vw, x1, box.right); y1 = Math.min(vh, y1, box.bottom);
      if (x1 - x0 < 3 || y1 - y0 < 4) continue;
      // Hidden behind something else (an open popover, a modal)? Then it is not what the eye reads.
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top || (top !== el && !el.contains(top))) continue;   // covered, or scrolled out of its container
      // A chip running off the edge of a one-line scrolling row, under that
      // row's edge fade (data-fade, src/utils/chipRowFade.js), is the "more
      // this way" signal, not text to read — skipped only when its text box
      // reaches into a faded edge zone (22px) of its own row.
      // Likewise text cut by the edge of a sideways-scrolling row (part of it
      // scrolled out of view): the eye reads it when it is scrolled in.
      // Only inside a chip / tab row — any other clipped text is still judged.
      let cut = false;
      const chipRow = el.closest("[data-chip-row], [role='tablist'], [data-fade], .wh-chips");
      if (chipRow) for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll") {
          const rb = p.getBoundingClientRect();
          if (x0 < rb.left - 0.5 || x1 > rb.right + 0.5) cut = true;
          break;
        }
      }
      if (cut) continue;
      const fadeRow = el.closest("[data-fade]");
      if (fadeRow) {
        const rb = fadeRow.getBoundingClientRect(), f = fadeRow.dataset.fade || "";
        if ((f.includes("l") && x0 < rb.left + 22) || (f.includes("r") && x1 > rb.right - 22)) continue;
      }
      const m = cs.color.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const [r, g, b, a0 = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      // An ancestor's opacity (a disabled button at .55) fades the ink too.
      let a = a0;
      for (let p = el; p && p !== document.body; p = p.parentElement) a *= Number(getComputedStyle(p).opacity) || 1;
      if (a === 0) continue;
      out.push({ text: el.textContent.trim().slice(0, 48), tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60),
                 box: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)], color: [r, g, b, a],
                 size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400 });
    }
    return out;
  }, [EXEMPT, strict]);
}

async function rawShot(page) {
  const buf = await page.screenshot();
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

function judge(el, bg, dpr) {
  const [x0, y0, x1, y1] = el.box.map((v) => Math.round(v * dpr));
  const [tr, tg, tb, ta] = el.color;
  const vals = [];
  const step = Math.max(1, Math.round(2 * dpr));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * bg.w + x) * 3;
      const br = bg.data[i], bgg = bg.data[i + 1], bb = bg.data[i + 2];
      const r = tr * ta + br * (1 - ta), g = tg * ta + bgg * (1 - ta), b = tb * ta + bb * (1 - ta);
      vals.push(contrast(lum(r, g, b), lum(br, bgg, bb)));
    }
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length * 0.1)] : 99;
}

async function run() {
  mkdirSync(OUT, { recursive: true });
  const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", ...(ADMIN ? ["--config", "dev/vite.harness.config.mjs"] : []), "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  const report = { min: MIN, results: [], failures: 0 };
  try {
    await waitFor(`${BASE}${ADMIN ? A : H}`);
    for (const [ename, engine] of ENGINES) {
      const browser = await engine.launch();
      for (const [w, h] of ALL_SIZES) {
        const dpr = w < 600 ? 2 : 1;
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
        for (const [name, path, setup] of (ADMIN ? ADMIN_ROUTES : ROUTES)) {
          if (!routeAtSize(name, w, h) || (ONLY && !ONLY.includes(name))) continue;
          const page = await ctx.newPage();
          if (setup) await page.addInitScript((ls) => { try { localStorage.clear(); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch { /* none */ } }, setup.ls || {});
          await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 90000 }).catch(() => {});
          await page.waitForTimeout(2500);
          if (setup?.tap) {
            const ok = await page.click(setup.tap, { timeout: 8000 }).then(() => true, () => false);
            if (!ok) { report.failures++; console.log(`  FAIL ${ename} ${name} ${w}x${h}: could not open (${setup.tap})`); }
            await page.waitForTimeout(1200);
          }
          // An overlay route must actually HAVE its overlay open — else the
          // gate would pass by sampling nothing.
          if (name.startsWith("overlay-")) {
            const open = await page.evaluate(() => !!document.querySelector(".sky-ovl"));
            if (!open) { report.failures++; console.log(`  FAIL ${ename} ${name} ${w}x${h}: the overlay did not open`); }
          }
          // Backdrop-filter must actually run: report any glass surface whose
          // computed backdrop filter came out "none".
          const deadGlass = await page.evaluate(() => [...document.querySelectorAll(".sky-glass, .sky-pop")]
            .filter((e) => { const cs = getComputedStyle(e); return (cs.backdropFilter || cs.webkitBackdropFilter || "none") === "none"; }).length);
          const els = await textElements(page, ADMIN);
          const shot = await page.screenshot();
          writeFileSync(join(OUT, `${ename}-${name}-${w}x${h}.png`), shot);
          await page.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}input::placeholder,textarea::placeholder{color:transparent!important}" });
          await page.waitForTimeout(150);
          const bg = await rawShot(page);
          const fails = [];
          for (const el of els) {
            const c = judge(el, bg, dpr);
            if (SHOW && SHOW.some((s) => el.cls.includes(s) || el.text.includes(s))) console.log(`   ·  ${Math.round(c * 100) / 100}:1  <${el.tag}.${el.cls.split(" ")[0]}> "${el.text}"`);
            if (c < MIN) fails.push({ ...el, contrast: Math.round(c * 100) / 100 });
          }
          report.results.push({ engine: ename, route: name, size: `${w}x${h}`, checked: els.length, failures: fails, deadGlass });
          report.failures += fails.length;
          console.log(`${ename} ${name} ${w}x${h}: ${els.length} text elements, ${fails.length} under ${MIN}:1${deadGlass ? `, ${deadGlass} glass surfaces without backdrop-filter` : ""}`);
          for (const f of fails.slice(0, 12)) console.log(`   ${f.contrast}:1  <${f.tag}.${f.cls.split(" ")[0]}> "${f.text}"`);
          await page.close();
        }
        await ctx.close();
      }
      await browser.close();
    }
  } catch (e) {
    console.error(String(e?.stack || e));
    vite.kill();
    process.exit(2);
  }
  vite.kill();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
  console.log(report.failures ? `FAIL: ${report.failures} text elements under ${MIN}:1` : `PASS: every text element is at least ${MIN}:1`);
  process.exit(report.failures ? 1 : 0);
}

run();
