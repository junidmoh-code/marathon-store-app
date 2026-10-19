// v2 style tags for test fixtures: what the name reads, as a men's piece.
// The stylist removes any piece whose gender is unknown (lib/stylist.cjs
// menswearRefusal), so a fixture that is not about gender says "mens".
"use strict";
const styleTags = require("../../lib/style-tags.cjs");

function mensTags({ name = "", websiteName = "", brand = "", categoryKey = "" } = {}, over = {}) {
  const t = styleTags.nameTags({ name, websiteName, brand, categoryKey });
  return { ...t, gender: "mens", cut: "none", headwear: t.headwear || "cap", knit: false, source: "vision", ...over };
}

/** Map pid → men's tags for buildCandidates-shaped rows, keeping any given. */
function mensTagMap(candidates, given = new Map()) {
  const out = new Map(given);
  for (const c of candidates || []) {
    if (!c || out.has(c.pid)) continue;
    const p = c.product || {};
    out.set(c.pid, mensTags({ name: p.name, websiteName: c.name, brand: p.brand, categoryKey: p.categoryKey }));
  }
  return out;
}

/** social_lookbook/styleTags records (v2) for an RTDB fixture's products. */
function mensTagRecords(products, live = {}) {
  const out = {};
  for (const [pid, p] of Object.entries(products || {})) {
    const { source, ...t } = mensTags({ name: p.name, websiteName: live[pid] && live[pid].cleanName, brand: p.brand, categoryKey: p.categoryKey });
    out[pid] = { v: 2, ...t, source };
  }
  return out;
}

module.exports = { mensTags, mensTagMap, mensTagRecords };
