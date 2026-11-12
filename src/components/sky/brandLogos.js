// ─── BRAND LOGOS FOR THE CHIP ROW ────────────────────────────────────────────
//
// assistant-desktop.png shows brand chips as LOGOS, not names. The marks come
// from simple-icons (npm, CC0). Only the icons listed here are imported, so
// the bundle carries these few paths and not the other ~3,400.
//
// The table maps OUR brand field values (src/utils/brands.js spells them) to a
// simple-icons icon. A brand simple-icons does not carry — Lacoste, Boss,
// Diesel, Armani, Gucci and most fashion houses: they ask simple-icons not to
// list them — falls back to its name in bold caps, exactly as the BOSS and
// DIESEL chips in the reference are drawn.

import {
  siNike, siJordan, siAdidas, siPuma, siNewbalance, siReebok, siFila,
  siUnderarmour, siThenorthface, siZara, siDior, siHermes,
} from "simple-icons";

export const BRAND_ICON = Object.freeze({
  "Nike": siNike,
  "Jordan": siJordan,
  "Adidas": siAdidas,
  "Puma": siPuma,
  "New Balance": siNewbalance,
  "Reebok": siReebok,
  "Fila": siFila,
  "Under Armour": siUnderarmour,
  "The North Face": siThenorthface,
  "Zara": siZara,
  "Dior": siDior,
  "Hermès": siHermes,
});

// The short caps a text chip shows ("Hugo Boss" reads BOSS on the reference).
const TEXT_LABEL = Object.freeze({
  "Boss": "BOSS",
  "Louis Vuitton": "LV",
  "Dolce & Gabbana": "D&G",
  "Calvin Klein": "CK",
  "Comme des Garçons": "CDG",
  "Tommy Hilfiger": "TOMMY",
  "Ralph Lauren": "RALPH LAUREN",
  "Needs brand": "NEEDS BRAND",
});

export function brandIcon(brand) {
  return BRAND_ICON[brand] || null;
}

export function brandTextLabel(brand) {
  return TEXT_LABEL[brand] || String(brand || "").toUpperCase();
}

// Logged once per brand per page load, so whoever extends the table can see
// which brands are drawing as text.
const logged = new Set();
export function noteUnmappedBrand(brand) {
  if (!brand || BRAND_ICON[brand] || logged.has(brand)) return;
  logged.add(brand);
  if (typeof console !== "undefined") console.info(`[sky] brand chip "${brand}" has no simple-icons mark — drawn as text`);
}
