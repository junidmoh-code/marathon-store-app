// ─── THE ONE PLACE A PRODUCT NAME IS MADE CUSTOMER-FACING ────────────────────
// Stored names carry internal artefacts. Measured against the 821 live product
// names on 2026-08-24:
//
//   102  leading or trailing whitespace   " New Era 59FIFTY…", "Timberland dark brown "
//    63  internal style-code hashes       "Adidas Tracksuit Grey #2506"
//    20  trailing duplicate markers       "Diesel Jeans-4"
//    14  doubled spaces                   "Nike Air Force 1 shell  Cream Brown"
//     3  trailing duplicate digits        "Nike Tech Fleece Tracksuit Brown 2"
//
// These are how the shop tells two near-identical records apart. They are not
// something a customer should ever read, and they are currently reaching the
// weekly ad captions and the website.
//
// ── WHY THIS FILE IS PLAIN COMMONJS, AND WHERE IT LIVES ──────────────────────
// Written ONCE, deliberately. The Cloud Functions runtime is CommonJS and
// cannot synchronously import ESM, so a canonical ESM module could not be the
// single source for it. Plain .cjs with no dependencies is the one shape every
// consumer here can reach:
//
//   functions/index.js        require("./lib/product-name.cjs")
//   scripts/**/*.mjs          createRequire(import.meta.url)  — the existing
//                             pattern used by socialStockParity.diff.test.js
//   src/** (tests + Vite)     same createRequire, or a direct import
//
// The storefront work should ADOPT this file rather than write a third copy.
//
// ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────
// It does not invent, translate, reorder or title-case. A name it does not
// recognise as artefact-bearing comes back unchanged apart from whitespace.
// Being too eager here is worse than being too shy: stripping a real model
// number turns "G-Star Raw Cargo Jean GS-5211" into a different product.
"use strict";

// ── STYLE CODES ──────────────────────────────────────────────────────────────
// A '#' token is always an internal reference in this catalogue — "#2506",
// "#Y8161-1", "#950". Removed wherever it appears, not only at the end,
// because "DIESEL JEAN BLUE  #Y8161-1" puts it mid-string with the doubled
// space around it.
const HASH_CODE = /\s*#\S+/g;

// ── TRAILING DUPLICATE MARKERS ───────────────────────────────────────────────
// "Diesel Jeans-4" and "Nike Tech Fleece Tracksuit Brown 2" are the same
// product recorded twice. But "Replay jeans dark green B1113-3" and "G-Star Raw
// Cargo Jean GS-5211" end the same way and those ARE the product — the code is
// how you order it.
//
// The discriminator is the token the number is attached to. A marker hangs off
// a WORD ("Jeans-4", "Brown 2"); a style code hangs off a token that already
// contains digits ("B1113-3", "GS-5211"). So a trailing number is only removed
// when what precedes it is purely alphabetic.
const TRAILING_MARKER = /\b([A-Za-z]+)[-\s](\d{1,2})\s*$/;

// Sizes and volumes are never markers: "125ML", "90ML", "Air Force 1".
const KEEPS_ITS_NUMBER = /\b(\d+\s?ml|\d+\s?g|air\s*force\s*1|air\s*max\s*\d+|\d{3,})\s*$/i;

/**
 * A product name fit to print. Never invents, never reorders, never re-cases.
 *
 * @param {string} raw  products/{pid}/name as stored
 * @returns {string}    the customer-facing name; "" for unusable input
 */
function cleanProductName(raw) {
  if (typeof raw !== "string") return "";
  let s = raw;

  s = s.replace(HASH_CODE, " ");

  // Whitespace last-but-one, so the collapse also tidies what removal left.
  s = s.replace(/[ \s]+/g, " ").trim();

  if (!KEEPS_ITS_NUMBER.test(s)) {
    const m = s.match(TRAILING_MARKER);
    // Only strip when the word before the number is alphabetic AND the word
    // itself is not the whole name — "Jordan 1" must survive.
    if (m && s.slice(0, m.index).trim().length > 0) {
      s = (s.slice(0, m.index) + m[1]).replace(/\s+/g, " ").trim();
    }
  }

  return s;
}

/** True when cleaning would change the stored name — for reporting/backfills. */
function isDirtyProductName(raw) {
  return typeof raw === "string" && raw.length > 0 && cleanProductName(raw) !== raw;
}

module.exports = { cleanProductName, isDirtyProductName };
