import puppeteer from "puppeteer";

const URL = process.argv[2] || "https://marathon-club.web.app";

const browser = await puppeteer.launch({
  defaultViewport: { width: 430, height: 932, deviceScaleFactor: 2 },
});
const page = await browser.newPage();

// Boot into Admin
await page.goto(URL, { waitUntil: "networkidle2", timeout: 60_000 });
await page.evaluate(() => {
  localStorage.setItem("marathon_role", "admin");
});
await page.reload({ waitUntil: "networkidle2", timeout: 60_000 });
await new Promise(r => setTimeout(r, 3500));

// List screenshot — viewport only (first ~10 rows)
await page.screenshot({ path: "/tmp/admin-list.png" });
console.log("list: /tmp/admin-list.png");

// Click the first product row and let hashchange navigate to its detail page.
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
