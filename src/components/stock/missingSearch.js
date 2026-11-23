// ─── MISSING PRODUCTS — SEARCH (Junid, 23 Nov 2026) ───────────────────────────
// One field under Sneakers / Clothing. It filters the list ALREADY ON SCREEN:
// the card's name, and the product's brand and style code where the product
// record (already loaded for the screen) has them. Nothing is read from the
// database. Case-insensitive, matches inside words and numbers ("5919"), and
// every word typed must match somewhere ("af1 white").
//
// Pure: the screen keeps its frozen order and only hides what does not match,
// so clearing the field gives back exactly the list that was there.

// Lower case, accents off ("Adidás" = "adidas"), a non-breaking space is a space.
const fold = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ /g, " ");
// "DD1391-100" is found by "dd1391100" too: a second copy with only letters
// and digits. Used only for a term with a digit in it, so "ea" never matches
// across the word break in "nike air".
const squash = (v) => fold(v).replace(/[^a-z0-9]+/g, "");
const hasDigit = (t) => /\d/.test(t);

export function searchTerms(query) {
  return fold(query).split(/\s+/).filter(Boolean);
}

export function haystackOf(row, product) {
  const parts = [row?.name, product?.brand, product?.styleCode, product?.styleCodeNormalised];
  return { text: parts.map(fold).join(" \n "), squashed: parts.map(squash).join(" ") };
}

export function matchesSearch(terms, row, product) {
  if (!terms.length) return true;
  const hay = haystackOf(row, product);
  return terms.every((t) => hay.text.includes(t) || (hasDigit(t) && !!squash(t) && hay.squashed.includes(squash(t))));
}
