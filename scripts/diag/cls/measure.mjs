// Measures layout shift on the Missing Products screen at iPhone width.
//   CLS_SNAPSHOT=/path/snap.json node scripts/diag/cls/measure.mjs [url]
// Records EVERY layout-shift entry (input-adjacent ones too — a tap must not
// get a free pass) with the nodes that moved, and attributes each one: a shift
// whose moved nodes are all card slots below a card that is leaving, inside
// that card's leave window, is "the solved card leaving"; anything else is a
// fault. Also samples the header boxes every frame: they must never move.
import puppeteer from "puppeteer";
import { createServer } from "vite";
import { fileURLToPath } from "url";
import path from "path";
import { writeFileSync } from "fs";

const here = path.dirname(fileURLToPath(import.meta.url));
let server = null;
let url = process.argv[2];
if (!url) {
  server = await createServer({ configFile: path.join(here, "vite.config.mjs") });
  await server.listen();
  url = "http://localhost:5199/";
}
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.evaluateOnNewDocument(() => {
  window.__shifts = [];
  window.__phase = "load";
  window.__leaving = [];   // { key, from, until, top }
  window.__headerMoves = [];
  const describe = (n) => {
    if (!n || !n.closest) return { slot: null, label: n ? n.nodeName : "?" };
    const slot = n.closest("[data-slot]");
    const lab = n.closest("[data-division],[data-kind],[data-title],[data-toast],[data-skeleton],[data-needs-label],[data-empty],[data-action]");
    return { slot: slot ? slot.getAttribute("data-slot") : null, label: lab ? (lab.getAttribute("data-division") ? `division ${lab.getAttribute("data-division")}` : lab.getAttribute("data-kind") ? `kind ${lab.getAttribute("data-kind")}` : lab.hasAttribute("data-toast") ? "toast" : lab.hasAttribute("data-skeleton") ? "skeleton" : lab.hasAttribute("data-needs-label") ? "needs label" : lab.hasAttribute("data-title") ? "title" : lab.getAttribute("data-action") || lab.nodeName) : n.nodeName };
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const t = performance.now();
      const sources = (e.sources || []).map((s) => ({ ...describe(s.node), prevTop: s.previousRect.top, curTop: s.currentRect.top, prevH: s.previousRect.height, curH: s.currentRect.height }));
      // Explained by a card leaving: every moved node is a slot (or inside
      // one) BELOW a leaving slot whose window covers this moment.
      const live = window.__leaving.filter((l) => t >= l.from - 20 && t <= l.until + 120);
      // (A card that had no visible box before — coming up into view from
      // under the fold as the others rise — is part of the same move.)
      const below = (s, l) => s.prevTop >= l.top - 1 || (s.prevH === 0 && s.curTop >= l.top - 1);
      const explained = live.length > 0 && sources.length > 0 && sources.every((s) => s.slot && !live.some((l) => l.key === s.slot) && live.some((l) => below(s, l)) && s.curTop <= s.prevTop + 0.5 || (s.slot && s.prevH === 0 && live.some((l) => below(s, l))));
      window.__shifts.push({ phase: window.__phase, t: Math.round(t), value: e.value, hadRecentInput: e.hadRecentInput, explained, sources });
    }
  }).observe({ type: "layout-shift", buffered: true });
  // The header must never move: sampled every frame against its first box.
  const first = {};
  const sample = () => {
    for (const el of document.querySelectorAll("[data-division],[data-kind],[data-title],[data-list]")) {
      const k = el.getAttribute("data-division") ? `division ${el.getAttribute("data-division")}` : el.getAttribute("data-kind") ? `kind ${el.getAttribute("data-kind")}` : el.hasAttribute("data-title") ? "title" : "list top";
      const r = el.getBoundingClientRect();
      const box = `${Math.round(r.left)},${Math.round(r.top + window.scrollY)},${Math.round(r.width)},${k === "list top" ? "" : Math.round(r.height)}`;
      if (first[k] === undefined) first[k] = box; else if (first[k] !== box) { window.__headerMoves.push({ phase: window.__phase, k, from: first[k], to: box }); first[k] = box; }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});

const t0 = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
// Load is done when both division counts are numbers and the list shows cards.
await page.waitForFunction(() => [...document.querySelectorAll("[data-division-count]")].every((n) => /^\d+$/.test(n.textContent.trim())) && document.querySelector("[data-slot]"), { timeout: 180000, polling: 100 });
const loadMs = Date.now() - t0;
await new Promise((r) => setTimeout(r, 2500));   // let the data settle (re-passes, echoes)
const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-division-count]")].map((n) => [n.getAttribute("data-division-count"), n.textContent.trim()])));
await page.screenshot({ path: path.join(process.env.CLS_OUT || "/tmp", "mp-load.png") });

const phase = (p) => page.evaluate((x) => { window.__phase = x; }, p);
const tapSel = async (sel) => { await page.tap(sel); await new Promise((r) => setTimeout(r, 900)); };

await phase("switch division");
for (const d of ["1", "2", "1", "2"]) await tapSel(`[data-division="${d}"]`);
await phase("switch kind");
for (const k of ["clothing", "sneakers", "clothing", "sneakers"]) await tapSel(`[data-kind="${k}"]`);
await page.screenshot({ path: path.join(process.env.CLS_OUT || "/tmp", "mp-sneakers.png") });

// TEN SOLVES IN A ROW on Concrete clothing (each card's first live button).
await tapSel(`[data-division="1"]`); await tapSel(`[data-kind="clothing"]`);
await phase("ten solves");
const solved = [];
for (let i = 0; i < 10; i++) {
  const target = await page.evaluate(() => {
    for (const slot of document.querySelectorAll("[data-slot]")) {
      if (slot.style.height === "0px") continue;
      const b = slot.querySelector("button[data-dest]:not([disabled])");
      const r = slot.getBoundingClientRect();
      if (b && r.top >= 0 && r.bottom <= window.innerHeight) return { key: slot.getAttribute("data-slot"), dest: b.getAttribute("data-dest"), top: r.top, name: slot.querySelector("[data-card]").getAttribute("data-card-name") };
    }
    return null;
  });
  if (!target) break;
  const before = await page.evaluate(() => [...document.querySelectorAll("[data-slot]")].filter((s) => s.style.height !== "0px").map((s) => s.getAttribute("data-slot")));
  // the leave window opens when the write lands (fake latency 250 ms + reads) and lasts the transition
  await page.evaluate((k, top) => { window.__leaving.push({ key: k, from: performance.now(), until: performance.now() + 2500, top }); }, target.key, target.top);
  await page.tap(`[data-slot="${target.key}"] button[data-dest="${target.dest}"]`);
  await page.waitForFunction((k) => { const s = document.querySelector(`[data-slot="${k}"]`); return !s || s.style.height === "0px"; }, { timeout: 15000 }, target.key);
  await new Promise((r) => setTimeout(r, 700));
  const after = await page.evaluate(() => [...document.querySelectorAll("[data-slot]")].filter((s) => s.style.height !== "0px").map((s) => s.getAttribute("data-slot")));
  const expected = before.filter((k) => k !== target.key);
  const toast = await page.evaluate(() => document.querySelector("[data-toast]")?.textContent || null);
  solved.push({ name: target.name, dest: target.dest, orderKept: JSON.stringify(after.slice(0, expected.length)) === JSON.stringify(expected.slice(0, after.length)), toast });
}
await page.screenshot({ path: path.join(process.env.CLS_OUT || "/tmp", "mp-after-solves.png") });
const shifts = await page.evaluate(() => window.__shifts);
const headerMoves = await page.evaluate(() => window.__headerMoves);
const sum = (xs) => Math.round(xs.reduce((t, s) => t + s.value, 0) * 10000) / 10000;
const byPhase = {};
for (const p of ["load", "switch division", "switch kind", "ten solves"]) {
  const xs = shifts.filter((s) => s.phase === p);
  byPhase[p] = { entries: xs.length, total: sum(xs), fromSolvedCardLeaving: sum(xs.filter((s) => s.explained)), other: sum(xs.filter((s) => !s.explained)), otherEntries: xs.filter((s) => !s.explained).slice(0, 5) };
}
const out = { loadMs, counts, byPhase, headerMoves, solved, errors: errors.slice(0, 10) };
writeFileSync(path.join(process.env.CLS_OUT || "/tmp", "mp-cls.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close();
if (server) await server.close();
