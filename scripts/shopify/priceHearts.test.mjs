// Source pins for the tile price + love heart (owner order 2026-08-26).
// Same style as homeRails.test.mjs: the theme deploys by hand-paste, so the
// repo's files are the contract and these pins keep the contract visible.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const card = readFileSync("theme/snippets/marathon-card.liquid", "utf8");
const css = readFileSync("theme/assets/marathon-storefront.css", "utf8");
const js = readFileSync("theme/assets/marathon-storefront.js", "utf8");

describe("price on the tile", () => {
  it("renders the store money format on the card media — the same filter the panel uses", () => {
    expect(card).toContain('<span class="mc-card__price">{{ product.price | money }}</span>');
    expect(css).toContain(".mc-card__price");
  });
  it("the price band never steals the tap — the tile stays one big target", () => {
    const block = css.split(".mc-card__price")[1].split("}")[0];
    expect(block).toContain("pointer-events: none");
  });
});

describe("the love heart", () => {
  it("is a SIBLING of the media link with the product id — a heart tap can never navigate", () => {
    expect(card).toContain("data-mc-love");
    expect(card).toContain('data-product-id="{{ product.id }}"');
    // The button must appear AFTER the closing </a> of the media link.
    expect(card.indexOf("data-mc-love")).toBeGreaterThan(card.indexOf("</a>"));
  });
  it("state is guarded localStorage under mc-loved, applied on load, on toggle, and after infinite-scroll appends", () => {
    expect(js).toContain('var LOVE_KEY = "mc-loved"');
    expect(js.split("applyLoved(").length - 1).toBeGreaterThanOrEqual(3);   // def + init + loadNext
    // Guarded accessors — a private window throws.
    const lovedBlock = js.split("var LOVE_KEY")[1];
    expect(lovedBlock).toContain("try {");
    expect(lovedBlock).toContain("catch (e)");
  });
  it("loved products surge to the top of the grid at load", () => {
    expect(js).toContain("function surgeLoved()");
    expect(js).toContain("grid.insertBefore(lovedCards[i], grid.firstElementChild)");
    expect(js).toContain("surgeLoved();");
  });
  it("the filled state rides aria-pressed — one source of truth for CSS and screen readers", () => {
    expect(css).toContain('.mc-love[aria-pressed="true"]');
    expect(js).toContain('b.setAttribute("aria-pressed"');
  });
});
