#!/usr/bin/env node
// ─── SKY AVAILABILITY E2E (Junid's bug, 5 Nov 2026) ──────────────────────────
//
// "In the live app, tapping an unavailable size shows it as unavailable and
// offers the alternatives. In the sky preview I cannot see this."
//
// Opens a product with an unavailable size in the real AssistantDesktop quick
// view (dev/sky-harness.html — the app itself needs a staff sign-in), in
// Chromium and WebKit, at 1440x900 and 390x844, and asserts:
//   1. the unavailable size carries the unavailable state (aria-disabled), is
//      drawn at 35% with the diagonal strike (::after gradient), and shows a
//      full-strength navy "0" count;
//   2. an available size does NOT look like that;
//   3. tapping the unavailable size raises the same why-note copy as live and
//      opens "Available now instead" with the alternatives in it.
//
//   node scripts/sky-availability.e2e.mjs [--port 5197]
//   exit 0 = pass; 1 = an assertion failed; 2 = harness error

import { spawn } from "node:child_process";
import { chromium, webkit } from "@playwright/test";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const PORT = Number(i >= 0 ? args[i + 1] : 5197);
const URL = `http://localhost:${PORT}/dev/sky-harness.html?screen=desktop&popup=1`;
const NAVY = "rgb(0, 38, 194)";

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
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      console.log(`${name} ${w}x${h}`);
      const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
      await page.goto(URL, { waitUntil: "load" });
      await page.waitForSelector(".ad-svsz button", { timeout: 30000 });

      const out = page.locator('.ad-svsz button[aria-disabled="true"]').first();
      const avail = page.locator('.ad-svsz button[aria-disabled="false"]').first();
      check(await out.count() === 1, "an unavailable size is present");

      const look = (loc) => loc.evaluate((b) => {
        const cs = getComputedStyle(b), after = getComputedStyle(b, "::after");
        const n = b.querySelector('[data-testid="size-onhand"]');
        return { color: cs.color, bg: cs.backgroundColor, strike: after.backgroundImage, content: after.content,
                 count: n ? n.textContent : null, countColor: n ? getComputedStyle(n).color : null,
                 countOpacity: n ? getComputedStyle(n).opacity : null };
      });
      const o = await look(out), a = await look(avail);
      check(/rgba\(11, 42, 82, 0\.35\)/.test(o.color), `unavailable size number at 35% (${o.color})`);
      check(o.content !== "none" && /linear-gradient/.test(o.strike), "unavailable size has the diagonal strike");
      check(o.count === "0", `unavailable size shows a "0" count (${o.count})`);
      check(o.countColor === NAVY && o.countOpacity === "1", `the "0" is full-strength navy (${o.countColor}, ${o.countOpacity})`);
      check(!/linear-gradient/.test(a.strike) && a.color !== o.color, "an available size does not carry the unavailable look");

      // aria-disabled reads as "not enabled" to Playwright; a real tap lands (the
      // button has no disabled attribute, so the why-note can be raised).
      await out.click({ force: true });
      const note = page.getByText(/isn't available at .* right now — it can't be ordered\.|isn't at Hub 1 or Hub 2 right now — it can't be ordered\./);
      await note.first().waitFor({ timeout: 5000 }).catch(() => {});
      check(await note.count() > 0, "tapping it raises the live why-note");
      const alt = page.getByText("Available now instead");
      await alt.first().waitFor({ timeout: 5000 }).catch(() => {});
      check(await alt.count() > 0, 'tapping it opens "Available now instead"');
      check(await page.locator('button[title*="Same model"]').count() > 0, "the alternatives are listed");
      await page.close();
    }
    await browser.close();
  }
} finally {
  vite.kill();
}
if (fails.length) { console.error(`\nFAIL: ${fails.length} assertion(s)`); process.exit(1); }
console.log("\nPASS: unavailable sizes are marked and open the alternatives");
