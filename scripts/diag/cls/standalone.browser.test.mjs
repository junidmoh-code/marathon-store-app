// Missing Products in a real browser, as the INSTALLED iPhone app draws it
// (Junid, 23 Nov 2026): 390×844, standalone, the status bar and the home
// indicator simulated as safe-area insets (47 / 34 px). The real screen and
// the real app-shell CSS over the harness's fake database and a made-up
// fixture — nothing here talks to Firebase.
//
// Skips (does not fail) when Chrome can't be started on this machine.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { buildFixture, FIXTURE_NAMES } from "./fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const INSET = { top: 47, bottom: 34 };
const VIEW = { width: 390, height: 844 };

let browser = null, server = null, page = null, tmp = null, skip = null;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mp-standalone-"));
  const snap = path.join(tmp, "snap.json");
  writeFileSync(snap, JSON.stringify(buildFixture()));
  process.env.CLS_SNAPSHOT = snap;
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  } catch (e) { skip = `no browser: ${e.message}`; return; }
  const { createServer } = await import("vite");
  server = await createServer({ configFile: path.join(here, "vite.config.mjs"), server: { port: 5188, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  page = await browser.newPage();
  await page.emulate({
    viewport: { ...VIEW, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: INSET.top, bottom: INSET.bottom, left: 0, right: 0 } });
  } catch (e) { skip = `this Chrome cannot simulate safe-area insets: ${e.message}`; return; }
  await page.emulateMediaFeatures([{ name: "display-mode", value: "standalone" }]).catch(() => {});
  await page.evaluateOnNewDocument(() => {
    window.__shifts = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shifts.push({ value: e.value, recent: e.hadRecentInput }); }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => [...document.querySelectorAll("[data-division-count]")].every((n) => /^\d+$/.test(n.textContent.trim())), { timeout: 120000, polling: 100 });
  await page.click("[data-kind=clothing]");
  await page.waitForFunction((n) => document.querySelectorAll("[data-card]").length >= n, { timeout: 60000, polling: 100 }, 10);
  await new Promise((r) => setTimeout(r, 400));
}, 240000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const names = () => page.$$eval("[data-card]", (ns) => ns.map((n) => n.getAttribute("data-card-name")));
const boxes = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-division],[data-kind],[data-search],[data-search-input],[data-title]")]
  .map((n) => { const r = n.getBoundingClientRect(); return [n.getAttribute("data-division") ? `d${n.getAttribute("data-division")}` : n.getAttribute("data-kind") || [...n.attributes].map((a) => a.name).find((a) => a.startsWith("data-")), `${r.left},${r.top},${r.width},${r.height}`]; })));
const type = async (text) => { await page.click("[data-search-input]"); await page.keyboard.type(text, { delay: 15 }); await new Promise((r) => setTimeout(r, 250)); };
const clear = async () => { await page.click("[data-action=clear-search]"); await new Promise((r) => setTimeout(r, 250)); };

describe("Missing Products, installed on an iPhone (390×844, insets 47 / 34)", () => {
  it("six or more whole cards fit between the header and the home indicator", async (ctx) => {
    if (skip) return ctx.skip(skip);
    const m = await page.evaluate((bottomInset) => {
      const header = Math.max(...[...document.querySelectorAll("[data-kind],[data-search]")].map((n) => n.getBoundingClientRect().bottom));
      const edge = window.innerHeight - bottomInset;
      return { header, edge, whole: [...document.querySelectorAll("[data-card]")].map((n) => n.getBoundingClientRect()).filter((r) => r.top >= header - 0.5 && r.bottom <= edge + 0.5).length };
    }, INSET.bottom);
    expect(m.whole).toBeGreaterThanOrEqual(6);
  });

  it("every card is the same height, a one-word name and a name far longer than two lines alike", async (ctx) => {
    if (skip) return ctx.skip(skip);
    const h = await page.$$eval("[data-card]", (ns) => ns.map((n) => [n.getAttribute("data-card-name"), n.getBoundingClientRect().height, n.querySelector("[data-name]").getBoundingClientRect().height]));
    expect(h.map((x) => x[0])).toEqual(expect.arrayContaining(["Tee", FIXTURE_NAMES[4]]));
    expect(new Set(h.map((x) => x[1])).size).toBe(1);
    expect(new Set(h.map((x) => x[2])).size).toBe(1);
  });

  it("every tap target on a card and in the header is at least 40 px tall", async (ctx) => {
    if (skip) return ctx.skip(skip);
    const small = await page.$$eval("[data-card] button, [data-division], [data-kind], [data-action=exit]", (ns) => ns.map((n) => n.getBoundingClientRect().height).filter((h) => h < 40));
    expect(small).toEqual([]);
  });

  it("the first control sits wholly below the status bar, also once the list is scrolled", async (ctx) => {
    if (skip) return ctx.skip(skip);
    const top = () => page.evaluate(() => Math.min(...[...document.querySelectorAll("button, input")].map((b) => b.getBoundingClientRect()).filter((r) => r.bottom > 0 && r.height > 0).map((r) => r.top)));
    expect(await top()).toBeGreaterThanOrEqual(INSET.top);
    await page.evaluate(() => window.scrollTo(0, 600));
    await new Promise((r) => setTimeout(r, 200));
    const sticky = await page.$eval("[data-division]", (n) => n.getBoundingClientRect().top);
    expect(sticky).toBeGreaterThanOrEqual(INSET.top);
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 200));
  });

  it("search filters by name and by number, causes zero layout shift, and clearing gives back the same order", async (ctx) => {
    if (skip) return ctx.skip(skip);
    const before = await names();
    const header = await boxes();
    const shifts0 = await page.evaluate(() => window.__shifts.length);
    await type("5919");
    expect(await names()).toEqual(["Sweatshirt 25919 yomo stylish cream white"]);
    expect(await boxes()).toEqual(header);                       // focusing and typing moved nothing above the list
    await clear();
    await type("JACKET");
    expect(await names()).toEqual(["Varsity Jacket", "Puffer Jacket Stone", "Denim Jacket Washed Blue"]);
    expect(await boxes()).toEqual(header);
    await type(" denim");                                       // every word must match
    expect(await names()).toEqual(["Denim Jacket Washed Blue"]);
    await clear();
    await type("zzzz");
    expect(await page.$eval("[data-nothing-found]", (n) => n.textContent)).toBe("Nothing found");
    expect(await page.$("[data-card]")).toBeNull();
    await clear();
    expect(await page.$("[data-action=clear-search]")).toBeNull();
    expect(await names()).toEqual(before);
    expect(await boxes()).toEqual(header);
    // No layout shift that the user didn't cause by typing (CLS counts these).
    const late = await page.evaluate((n) => window.__shifts.slice(n).filter((s) => !s.recent), shifts0);
    expect(late).toEqual([]);
  });

  it("the toast sits wholly above the home indicator", async (ctx) => {
    if (skip) return ctx.skip(skip);
    await page.click("[data-card] [data-dest]");
    await page.click("[data-card] [data-action=solve]");
    await page.waitForSelector("[data-toast]", { timeout: 20000 });
    const r = await page.$eval("[data-toast]", (n) => { const b = n.getBoundingClientRect(); return { bottom: b.bottom, h: window.innerHeight }; });
    expect(r.bottom).toBeLessThanOrEqual(r.h - INSET.bottom);
  });
});
