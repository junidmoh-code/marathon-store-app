// Pins the assistant-view photo-fit fix (App.jsx is a monolith whose views
// can't be imported in isolation, so this pins the exact style rules).
//
// Ground truth (2026-08-13, 13-photo survey of live productPhotoUrl): photos
// are predominantly 600×800 PORTRAIT. The laptop catalog card cropped them
// with a 16/11 cover box (~48% of the shoe lost); the phone/tablet 140px card
// used cover too. The fix is contain + a square desktop thumb box:
//  1. AssistantDesktop's Photo helper renders object-fit CONTAIN;
//  2. .ad-thumb is a 1/1 box (16/11 would letterbox a portrait to ~52% width);
//  3. the narrow-layout photo card image is CONTAIN in its unchanged 140px box.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");

test("AssistantDesktop Photo helper contains (never crops) the product image", () => {
  const helper = app.match(/const Photo = \(\{ p, big \}\) =>[\s\S]{0,400}?onError/);
  expect(helper, "Photo helper should exist").toBeTruthy();
  expect(helper[0]).toContain('objectFit: "contain"');
  expect(helper[0]).not.toContain('"cover"');
});

test(".ad-thumb is a square stage, not a 16/11 crop box", () => {
  const rule = app.match(/\.ad-thumb\{[^}]*\}/);
  expect(rule, ".ad-thumb rule should exist").toBeTruthy();
  expect(rule[0]).toContain("aspect-ratio:1/1");
});

test("narrow-layout photo card contains its image in the 140px box", () => {
  // The card is the only place a photoUrl img sits inside a height:140 box.
  const idx = app.indexOf("height:140");
  expect(idx).toBeGreaterThan(-1);
  const card = app.slice(idx, idx + 700);
  expect(card).toContain('objectFit:"contain"');
  expect(card).not.toContain('objectFit:"cover"');
});
