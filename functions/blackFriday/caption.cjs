// ── THE CAPTION (Junid, 20 Nov 2026) — pure. Same rules as marathon-group-poster src/wa/sizes.mjs (what is sent). ─
"use strict";
// Every caption that goes to a group is ONLY two lines:
//     R<stock price>
//     Available sizes: <every in-stock size, listed one by one, comma-separated>
// Never a range ("6–11" → "6, 7, 8, 9, 10, 11"); only sizes with stock (gaps left
// out: "6, 7, 9, 10"); half sizes kept as they are ("6, 6.5, 7"); clothing in size
// order ("S, M, L, XL, XXL"); a one-size item says "Available sizes: one size".
// No "BLACK FRIDAY", no 🔥, no "EACH", no "Message us to order.".

const LETTERS = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL", "6XL"];
const ALIAS = { "2XS": "XXS", "3XS": "XXXS", "2XL": "XXL", "3XL": "XXXL", XXXXL: "4XL", XXXXXL: "5XL" };
const canonLetter = (s) => ALIAS[s] || s;
const letterIdx = (s) => LETTERS.indexOf(canonLetter(s));
const NUM = /^\d+(?:\.\d+)?$/;
const isOneSize = (s) => /^(one ?size|os|n\/?a|free ?size|_)$/i.test(String(s).trim());
/** A display form of one size token: "uk 8" → "8", "6½" → "6.5", "xl" → "XL". */
function tidy(raw) {
  let s = String(raw ?? "").trim().replace(/½/g, ".5").replace(/^(uk|us|eu|sa|size)\s*/i, "");
  const up = s.toUpperCase();
  if (ALIAS[up] || LETTERS.includes(up)) s = canonLetter(up);
  if (NUM.test(s)) s = String(Number(s));
  return s;
}
/**
 * One stock size → the sizes it stands for. A range is expanded in WHOLE steps
 * ("6-11" → 6 … 11, "S-XL" → S, M, L, XL, "7-8Y" → 7, 8); anything else is kept as it is. Pure.
 */
function expandSize(raw) {
  const s0 = String(raw ?? "").trim();
  if (!s0 || isOneSize(s0)) return [];
  const m = s0.match(/^([A-Za-z0-9.½]+?)\s*[-–]\s*([A-Za-z0-9.½]+?)\s*(y|yrs|years)?$/i);
  if (m) {
    const a = tidy(m[1]), b = tidy(m[2]);
    if (NUM.test(a) && NUM.test(b) && Number(b) >= Number(a) && Number(b) - Number(a) <= 40) {
      const out = [];
      for (let x = Number(a); x <= Number(b) + 1e-9; x += 1) out.push(String(Math.round(x * 10) / 10));
      return out;
    }
    if (letterIdx(a) >= 0 && letterIdx(b) >= letterIdx(a)) return LETTERS.slice(letterIdx(a), letterIdx(b) + 1);
  }
  return [tidy(s0.replace(/\s*(y|yrs|years)$/i, ""))];
}
/** Every size, one by one, no repeats, in size order: numbers by value, then letters S→XXL, then anything else. Pure. */
function sizeList(sizes) {
  const seen = new Set();
  for (const raw of sizes || []) for (const s of expandSize(raw)) if (s) seen.add(s);
  const all = [...seen];
  const nums = all.filter((s) => NUM.test(s)).sort((a, b) => Number(a) - Number(b));
  const letters = all.filter((s) => !NUM.test(s) && letterIdx(s) >= 0).sort((a, b) => letterIdx(a) - letterIdx(b));
  const other = all.filter((s) => !NUM.test(s) && letterIdx(s) < 0);
  return [...letters, ...nums, ...other];
}
/** "6, 7, 9, 10" or "one size". sizes: the in-stock sizes of every item in the post. Pure. */
function sizesLine(sizes) {
  const l = sizeList(sizes);
  return l.length ? l.join(", ") : "one size";
}
/** "R750" (cents kept when the stock price has them: "R649.50"). Pure. */
function priceLabel(price) {
  const n = Number(price);
  return `R${Number.isInteger(n) ? n : n.toFixed(2)}`;
}
/** THE caption: two lines. Pure. */
function caption(price, sizes) {
  return `${priceLabel(price)}\nAvailable sizes: ${sizesLine(sizes)}`;
}
/** A sizes TEXT ("6, 7, 8" / "M-XL" / "one size") back to its tokens. Pure. */
const splitSizesText = (t) => String(t ?? "").split(/\s*,\s*/).filter(Boolean);

module.exports = { expandSize, sizeList, sizesLine, priceLabel, caption, splitSizesText };
