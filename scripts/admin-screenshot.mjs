import puppeteer from "puppeteer";

const URL = process.argv[2] || "https://marathon-club.web.app";

const browser = await puppeteer.launch({
  defaultViewport: { width: 430, height: 932, deviceScaleFactor: 2 },
});
const page = await browser.newPage();

// Boot into Admin
await page.goto(URL, { waitUntil: "networkidle0", timeout: 60_000 });
await page.evaluate(() => {
  localStorage.setItem("marathon_role", "admin");
});
await page.reload({ waitUntil: "networkidle0", timeout: 60_000 });
await new Promise(r => setTimeout(r, 3500));

// List screenshot — viewport only (first ~10 rows)
await page.screenshot({ path: "/tmp/admin-list.png" });
console.log("list: /tmp/admin-list.png");

// Pick first product id (from rendered list) and navigate to its detail
const firstId = await page.evaluate(() => {
  // The chevron-right SVG sits inside each row card; rows are siblings.
  // Easiest: read window state via the products list — but products aren't
  // exposed. Fallback to walking DOM: rows have a known role pattern.
  // Hack: find divs that contain ProductPhoto img + chevron-right.
  const candidates = Array.from(document.querySelectorAll("div"));
  for (const d of candidates) {
    const svgs = d.querySelectorAll("svg");
    const imgs = d.querySelectorAll("img");
    if (imgs.length === 1 && svgs.length === 1) {
      // crude — probably a row; check its inline style for cursor:pointer
      if ((d.style.cursor || "") === "pointer") return null; // we don't get id here
    }
  }
  return null;
});

// Simpler: just set hash to a known pattern. We need a real product id.
// Easiest path: read products from Firebase via the page's own database
// connection isn't accessible. So inspect href/state from the row click.
// Instead, just click the first matching row and let hashchange happen.
const clicked = await page.evaluate(() => {
  // Find a div that looks like AdminProductRow: cursor:pointer + img + chevron.
  const all = Array.from(document.querySelectorAll("div"));
  for (const d of all) {
    if ((d.style.cursor || "") !== "pointer") continue;
    if (!d.querySelector("img")) continue;
    if (!d.querySelector("svg polyline")) continue;
    d.click();
    return true;
  }
  return false;
});

if (clicked) {
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: "/tmp/admin-detail.png", fullPage: true });
  // Also a viewport-only crop for quick scan
  await page.screenshot({ path: "/tmp/admin-detail-top.png" });
  console.log("detail: /tmp/admin-detail.png  (hash=", await page.evaluate(() => location.hash), ")");
} else {
  console.log("(no rows to click — list might be empty)");
}

await browser.close();
