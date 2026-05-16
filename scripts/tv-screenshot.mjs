import puppeteer from "puppeteer";

const URL = process.argv[2] || "https://marathon-club.web.app";
const OUT = process.argv[3] || "/tmp/tv-display-1920x1080.png";

const browser = await puppeteer.launch({
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();

await page.goto(URL, { waitUntil: "networkidle2", timeout: 60_000 });
await page.evaluate(() => localStorage.setItem("marathon_role", "display"));
await page.reload({ waitUntil: "networkidle2", timeout: 60_000 });

await new Promise(r => setTimeout(r, 4000));

const layout = await page.evaluate(() => {
  const root = document.documentElement;
  // Heuristic: section rows are the children of the sections wrapper (flex
  // column inside the page root). Look up siblings of the time element via
  // structural traversal.
  const rows = Array.from(document.querySelectorAll("body div")).filter(d => {
    const cs = getComputedStyle(d);
    if (cs.display !== "flex") return false;
    if (cs.flexDirection !== "row") return false;
    // section rows have a flex:1 1 0 with non-zero height ~227 and a width
    // close to viewport-minus-padding (1920-48=1872).
    return Math.abs(d.offsetWidth - 1872) < 4 && d.offsetHeight > 100 && d.offsetHeight < 400;
  });
  return {
    viewportW:  window.innerWidth,
    viewportH:  window.innerHeight,
    scrollW:    root.scrollWidth,
    scrollH:    root.scrollHeight,
    hasVScroll: root.scrollHeight > window.innerHeight,
    hasHScroll: root.scrollWidth  > window.innerWidth,
    rowHeights: rows.map(r => r.offsetHeight),
    rowCount:   rows.length,
  };
});
console.log(JSON.stringify(layout, null, 2));

await page.screenshot({ path: OUT });
console.log("screenshot:", OUT);
await browser.close();
