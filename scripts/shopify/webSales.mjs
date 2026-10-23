// ─── Pure matching behind web-sales-vs-app.mjs ───────────────────────────────
// Which app `sold` movement accounts for which website order line. Generous on
// purpose: a line is only reported unexplained when no sale of the product (any
// size) or of a sibling record could be the slip for it.

import { stockSizeKey } from "../../src/utils/sizeKey.js";

export const LOOKBACK_MS = 7 * 864e5;

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The keys that make two app records the same shoe: style code, normalised name. */
export function siblingKeys({ name, styleCode } = {}) {
  const keys = new Set();
  const code = typeof styleCode === "string" ? styleCode.trim().toLowerCase() : "";
  if (code) keys.add(`code:${code}`);
  // Word SET, so "Arizona Suede Taupe" and "Arizona Taupe Suede" agree.
  const words = norm(name).split(" ").filter(Boolean).sort().join(" ");
  if (words) keys.add(`name:${words}`);
  return keys;
}

/**
 * lines: [{ pid, size, qty, createdAt }] (sorted oldest first)
 * sold:  [{ productId, size, qty, ts }]
 * meta:  Map(pid → Set of sibling keys)
 * → each line with `match`: exact | wrongSize | sibling | none
 */
export function matchWebLine(lines, sold, meta = new Map()) {
  const pool = sold.map((m) => ({ pid: m.productId, size: stockSizeKey(m.size), left: Number(m.qty) || 1, at: Date.parse(m.ts) }))
    .sort((a, b) => a.at - b.at);
  // All or nothing: a line the eligible sales cannot cover in full consumes
  // nothing, so a smaller later line can still be explained by them.
  const take = (line, pred) => {
    const eligible = pool.filter((m) => m.left > 0 && m.at >= line.createdAt - LOOKBACK_MS && pred(m));
    if (eligible.reduce((n, m) => n + m.left, 0) < line.qty) return false;
    let need = line.qty;
    for (const m of eligible) {
      if (need <= 0) break;
      const n = Math.min(need, m.left);
      m.left -= n; need -= n;
    }
    return true;
  };
  const sib = (a, b) => { const ka = meta.get(a); const kb = meta.get(b); if (!ka || !kb || a === b) return false; for (const k of ka) if (kb.has(k)) return true; return false; };
  // Pass 1 for every line before any looser pass, so a loose match never
  // steals the exact sale another line needs.
  const out = lines.map((l) => ({ ...l, size: stockSizeKey(l.size), match: null }));
  for (const l of out) if (take(l, (m) => m.pid === l.pid && m.size === l.size)) l.match = "exact";
  for (const l of out) if (!l.match && take(l, (m) => m.pid === l.pid)) l.match = "wrongSize";
  for (const l of out) if (!l.match && take(l, (m) => sib(l.pid, m.pid))) l.match = "sibling";
  for (const l of out) if (!l.match) l.match = "none";
  return out;
}
