// Pins the assistant-view photo-fit rule (2026-08-13 survey: live product
// photos are predominantly 600×800 PORTRAIT — a cover box crops ~half the
// shoe). Carried onto the sky redesign (2026-11-02): every order-view card and
// the product popup draw the product through ProductStage, which shows either
// the cut-out on a podium or the full photo CONTAINED in a white frame.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles/sky.css", import.meta.url), "utf8");
const stage = readFileSync(new URL("./components/sky/Sky.jsx", import.meta.url), "utf8");
const phone = readFileSync(new URL("./components/sky/AssistantPhone.jsx", import.meta.url), "utf8");

test("the framed photo and the cut-out are CONTAINED, never cropped", () => {
  const frameImg = css.match(/\.sky-frame img \{[^}]*\}/);
  expect(frameImg, ".sky-frame img rule").toBeTruthy();
  expect(frameImg[0]).toContain("object-fit: contain");
  const cut = css.match(/\.sky-cutout \{[^}]*\}/);
  expect(cut[0]).toContain("object-fit: contain");
  expect(css).not.toMatch(/\.sky-(frame img|cutout) \{[^}]*object-fit: cover/);
});

test("the stage draws the FULL-RESOLUTION photo (HiResPhoto), never a thumbnail", () => {
  expect(stage).toContain("<HiResPhoto key={p.photoUrl || \"\"} p={p}");
});

test("desktop cards, the popup and the phone cards all use the stage", () => {
  expect(app).toContain('<ProductStage p={p} height="var(--ad-stage)"');
  expect(app).toContain("<ProductStage p={qv} height=\"100%\"");
  expect(phone).toContain('<ProductStage p={p} height="var(--ap-stage)"');
});
