// Missing Products as the INSTALLED iPhone app sees it: 390×844, the status
// bar and home indicator simulated as safe-area insets (47 / 34 px, iPhone
// 12–16). Takes a screenshot and measures how many whole cards are visible
// between the bottom of the header and the top of the home-indicator inset,
// and where the first control and the toast sit against the insets.
//   CLS_SNAPSHOT=/path/snap.json node scripts/diag/cls/standalone.mjs out.png [url]
// Local only. Reads the snapshot file; never talks to Firebase.
import puppeteer from "puppeteer";
import { createServer } from "vite";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || "standalone.png";
let url = process.argv[3];
let server = null;
if (!url) {
  server = await createServer({ configFile: path.join(here, "vite.config.mjs") });
  await server.listen();
  url = "http://localhost:5199/";
}
const INSET = { top: 47, bottom: 34 };
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});
const cdp = await page.createCDPSession();
let insets = "none";
try {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: INSET.top, bottom: INSET.bottom, left: 0, right: 0 } });
  insets = "cdp";
} catch (e) { insets = `unsupported (${e.message})`; }
try { await page.emulateMediaFeatures([{ name: "display-mode", value: "standalone" }]); } catch { /* not every build knows it */ }
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => document.querySelector("[data-card]") || document.querySelector("[data-empty]"), { timeout: 180000, polling: 200 });
await new Promise((r) => setTimeout(r, 1500));
// Show the list that has cards (an empty Sneakers list measures nothing).
if (await page.$("[data-empty]")) {
  await page.click("[data-kind=clothing]");
  await page.waitForFunction(() => document.querySelector("[data-card]"), { timeout: 60000, polling: 200 });
  await new Promise((r) => setTimeout(r, 800));
}
const m = await page.evaluate((INSET) => {
  const vh = window.innerHeight;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top,0px);width:1px";
  document.body.appendChild(probe);
  const envTop = probe.getBoundingClientRect().height; probe.remove();
  const buttons = [...document.querySelectorAll("button, input")].filter((b) => b.getBoundingClientRect().height > 0);
  const first = buttons.map((b) => b.getBoundingClientRect()).sort((a, b) => a.top - b.top)[0];
  const sticky = [...document.querySelectorAll("[data-kind], [data-search]")].map((n) => n.getBoundingClientRect().bottom);
  const headerBottom = Math.max(...sticky);
  const bottomEdge = vh - INSET.bottom;
  const cards = [...document.querySelectorAll("[data-card]")].map((n) => n.getBoundingClientRect());
  const whole = cards.filter((r) => r.top >= headerBottom - 0.5 && r.bottom <= bottomEdge + 0.5).length;
  const heights = [...new Set(cards.map((r) => Math.round(r.height)))];
  // A location name that does not fit whole: its text, measured in the chip's own font, against the room inside the chip's padding.
  const ctx2 = document.createElement("canvas").getContext("2d");
  const clipped = [...document.querySelectorAll("[data-dest]")].filter((b) => {
    const cs = getComputedStyle(b); ctx2.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const room = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return ctx2.measureText(b.getAttribute("aria-label")).width > room;
  }).map((b) => b.getAttribute("aria-label")).filter((v, i, a) => a.indexOf(v) === i);
  return { clipped, envTop, firstControlTop: first ? first.top : null, headerBottom, bottomEdge, wholeCards: whole, cardHeights: heights };
}, INSET);
await page.screenshot({ path: out });
console.log(JSON.stringify({ insets, ...m, out }));
await browser.close();
if (server) await server.close();
