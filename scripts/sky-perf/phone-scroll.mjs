#!/usr/bin/env node
// DEV ONLY — fast-scroll + photo-load measurement for the sky phone grid.
//
// Renders the real AssistantPhone in the offline harness with N synthetic
// products and ~110 KB local photos, on a mid-range-phone profile (CPU 4x
// slower via DevTools), and reports:
//   • frames: rAF intervals during a fast fling (p50 / p95 / dropped >50 ms)
//   • empty:  card-frames during the fling where a card in view showed no
//             text (content-visibility skipped) or no photo
//   • photos: time until every card in the first screen shows its photo
//
//   node scripts/sky-perf/phone-scroll.mjs --label before [--viewport phone|ipad]
//        [--net none|slow3g|offline] [--warm] [--video] [--bulk 1500] [--port 5211]
//
// --warm: a first visit (unthrottled, lets the photos land / cache), then a
// reload measured with --net applied. --net offline needs --warm to mean
// anything. Videos go to docs/sky-perf/ as mp4.
import { spawn, execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { chromium, webkit } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const PORT = Number(opt("port", 5211)), LABEL = opt("label", "run"), VIEW = opt("viewport", "phone");
const ENGINE = opt("engine", "chromium");
const NET = opt("net", "none"), BULK = Number(opt("bulk", 1500)), WARM = flag("warm"), VIDEO = flag("video");
const VP = VIEW === "ipad" ? { width: 820, height: 1180 } : { width: 390, height: 844 };
const PHOTO_PORT = PORT + 1000;
const URL = `http://localhost:${PORT}/dev/sky-harness.html?screen=phone&bulk=${BULK}&hold=1&photoHost=http://localhost:${PHOTO_PORT}`;
// The photos come from another origin that answers like Firebase Storage does
// for product photos: CORS for the app's origin and a 7-day max-age (the
// July 2026 backfill for products/{id}/photo.jpg), so "before" gets the
// browser HTTP cache it has live.
const photoServer = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  if (!/^dev\/photos\.local\/\d+\.jpg$/.test(path) || !existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800", "Access-Control-Allow-Origin": "*" });
  createReadStream(path).pipe(res);
}).listen(PHOTO_PORT);
// Chrome DevTools' own "Slow 3G" preset.
const SLOW3G = { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8 * 0.8, uploadThroughput: (500 * 1024) / 8 * 0.8 };

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const out = {};
try {
  let up = false;
  for (let t = 0; t < 120 && !up; t++) { try { up = (await fetch(URL)).ok; } catch { /* */ } if (!up) await new Promise((r) => setTimeout(r, 500)); }
  if (!up) throw new Error("dev server did not answer");
  const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
  const vdir = `docs/sky-perf/.raw-${LABEL}`;
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 2, isMobile: ENGINE !== "webkit" || undefined, hasTouch: true,
    ...(VIDEO ? { recordVideo: { dir: vdir, size: VP } } : {}) });
  // The fleet's offline-mirror switch is ON (killSwitch.js reads this cache
  // first); without it the photo cache stays off, as on a mirror-off device.
  if (!flag("mirror-off")) await ctx.addInitScript(() => localStorage.setItem("marathon-store.offlineMirror.switch", JSON.stringify({ on: true, at: Date.now() })));
  // WebKit has no DevTools protocol: no CPU or network throttling there (it
  // is run for the engine's own rendering, which is what an iPhone uses).
  let page, cdp;
  const openPage = async () => {
    page = await ctx.newPage();
    cdp = ENGINE === "webkit" ? null : await ctx.newCDPSession(page);
    if (cdp) { await cdp.send("Network.enable"); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); }
  };
  await openPage();
  const setNet = async (n) => cdp && cdp.send("Network.emulateNetworkConditions",
    n === "slow3g" ? SLOW3G : n === "offline" ? { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
      : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const boot = async (net) => {
    await setNet("none");
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    await setNet(net);
    await page.evaluate(() => window.__go());
    await page.waitForSelector(".ap-card", { timeout: 60000 });
  };
  // Every card in the scroller's visible box, and whether it shows its text
  // and a decoded photo right now.
  const VIEWSTATE = () => {
    const sc = document.querySelector(".ap-scroll"); const box = sc.getBoundingClientRect();
    const cards = [...document.querySelectorAll(".ap-card")].filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > box.top + 4 && r.top < box.bottom - 4; });
    let noText = 0, noPhoto = 0;
    for (const c of cards) {
      const name = c.querySelector(".ap-name");
      if (!name || (name.checkVisibility && !name.checkVisibility({ contentVisibilityAuto: true }))) noText++;
      const imgs = [...c.querySelectorAll("img")].filter((i) => !i.dataset.ph);
      const shown = imgs.some((i) => i.complete && i.naturalWidth > 0 && getComputedStyle(i).opacity !== "0");
      const ph = [...c.querySelectorAll("img[data-ph]")].some((i) => i.complete && i.naturalWidth > 0);
      if (!shown) noPhoto++;
      if (!shown && !ph) c.dataset.bare = "1"; else delete c.dataset.bare;
    }
    return { n: cards.length, noText, noPhoto, bare: cards.filter((c) => c.dataset.bare).length };
  };
  const firstScreen = async () => page.evaluate(async (VIEWSTATE_SRC) => {
    const vs = eval(VIEWSTATE_SRC);
    const t0 = window.__t0; let firstAll = null, firstAny = null; const deadline = performance.now() + 90000;
    while (performance.now() < deadline) {
      const s = vs();
      if (firstAny === null && s.noPhoto < s.n) firstAny = performance.now() - t0;
      if (s.n && s.noPhoto === 0) { firstAll = performance.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    const s = vs();
    return { firstPhotoMs: firstAny && Math.round(firstAny), allFirstScreenMs: firstAll && Math.round(firstAll), cardsInView: s.n, missingAtEnd: s.noPhoto };
  }, `(${VIEWSTATE.toString()})`);

  if (WARM) {
    await boot("none");
    await firstScreen();
    // let the background work (cache writes / prefetch) run a little, as a person would browse
    await page.waitForTimeout(Number(opt("settle", 8000)));
    // The measured visit is a new page in the same profile (same caches), so
    // its recording is the reload alone.
    const first = page;
    await openPage();
    await first.close();
  }
  await boot(NET);
  out.photos = await firstScreen();
  // The fling: 150 px a frame (~9,000 px/s at 60 fps) for 2.5 s, then back up.
  // Pass 1 times frames and touches nothing else; pass 2 repeats the fling and
  // samples what is ON SCREEN each frame by hit-testing a grid of points (cheap:
  // no walk over every card), counting card-frames with no text or no photo.
  const fling = (sample) => page.evaluate(async ([sample]) => {
    const sc = document.querySelector(".ap-scroll"); sc.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 600));
    const box = sc.getBoundingClientRect();
    const pts = []; for (let y = box.top + 40; y < box.bottom - 20; y += 70) for (const fx of [0.27, 0.73]) pts.push([box.left + box.width * fx, y]);
    const gaps = []; let noText = 0, noPhoto = 0, bare = 0, seen = 0, frames = 0, last = performance.now();
    const look = () => {
      const cards = new Set();
      for (const [x, y] of pts) { const c = document.elementFromPoint(x, y)?.closest?.(".ap-card"); if (c) cards.add(c); }
      for (const c of cards) {
        seen++;
        const name = c.querySelector(".ap-name");
        if (!name || !name.textContent || (name.checkVisibility && !name.checkVisibility({ contentVisibilityAuto: true }))) noText++;
        const full = [...c.querySelectorAll("img")].filter((i) => !i.dataset.ph).some((i) => i.complete && i.naturalWidth > 0 && getComputedStyle(i).opacity !== "0");
        const ph = [...c.querySelectorAll("img[data-ph]")].some((i) => i.complete && i.naturalWidth > 0);
        if (!full) noPhoto++;
        if (!full && !ph) bare++;
      }
    };
    const run = (dir, ms) => new Promise((done) => {
      const end = performance.now() + ms;
      const step = () => {
        const now = performance.now(); gaps.push(now - last); last = now;
        sc.scrollTop += dir * 150; frames++;
        if (sample) look();
        if (now < end) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
    await run(1, 2500); await new Promise((r) => setTimeout(r, 400)); last = performance.now(); await run(-1, 1200);
    gaps.sort((a, b) => a - b);
    const q = (p) => Math.round(gaps[Math.floor(gaps.length * p)] * 10) / 10;
    return sample ? { cardFramesSeen: seen, noText, noPhoto, bare }
      : { frames, p50: q(0.5), p95: q(0.95), dropped50: gaps.filter((g) => g > 50).length,
          mounted: document.querySelectorAll(".ap-card").length, photosMounted: document.querySelectorAll(".ap-card[data-photo=on]").length };
  }, [sample]);
  out.fling = await fling(false);
  out.flingEmpty = await fling(true);
  out.cache = await page.evaluate(async () => {
    if (typeof caches === "undefined") return null;
    let bytes = 0, entries = 0;
    for (const name of await caches.keys()) { const c = await caches.open(name); for (const req of await c.keys()) { const r = await c.match(req); bytes += (await r.blob()).size; entries++; } }
    return { entries, mb: Math.round(bytes / 1048576 * 10) / 10 };
  });
  await ctx.close(); await browser.close();
  if (VIDEO) {
    mkdirSync("docs/sky-perf", { recursive: true });
    const f = await page.video().path().then((p) => p.split("/").pop());
    const mp4 = `docs/sky-perf/${LABEL}.mp4`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${vdir}/${f}`, "-vf", "scale=-2:720,fps=24", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
    rmSync(vdir, { recursive: true, force: true });
    out.video = mp4;
  }
} finally { vite.kill(); photoServer.close(); }
console.log(JSON.stringify({ label: LABEL, engine: ENGINE, viewport: VIEW, net: NET, warm: WARM, bulk: BULK, ...out }, null, 1));
