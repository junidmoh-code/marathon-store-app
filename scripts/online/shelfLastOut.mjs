// ─── WHEN EACH SHELF LAST SOLD OR SENT SOMETHING OUT — kept on the Mac mini ──
// Junid, 24 Nov 2026 evening (commit 4: not-selling shelves join the shelf-check
// rotation). "Not selling" = the shelf shows stock but has had no sale and no
// outbound movement for 21 days. The cell cannot say that (any movement, an
// arrival too, stamps it), so the nightly list build keeps a small local file:
//
//   logs/shelf-last-out.json = { cursor, since, last: { "loc|pid|sizeKey": ms } }
//
// folded forward each night from the ledger rows written since `cursor` (its
// `ts` index; about 1 MB a day). The first run reads back `--seed-days` (35) once.
// `since` is how far back the file can see: a shelf with no entry has not sold
// or sent anything out since then.
//
// PURE except loadLastOut / saveLastOut / readLedgerSince (injected fetch).
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { createRequire } from "node:module";

const O = createRequire(import.meta.url)("../../functions/lib/on-the-way.cjs");

/** The shelf a movement takes units OUT of by a sale or by sending them on, or null. PURE. */
export function outboundShelf(m) {
  if (!m || typeof m !== "object" || !m.productId || !m.from) return null;
  if (m.from === "in_transit" || m.from === m.to) return null;
  if (m.type !== "sold" && m.type !== "transfer_out" && m.type !== "transfer_in") return null;
  return `${m.from}|${m.productId}|${O.sizeKeyOf(m.size)}`;
}

/** Fold ledger rows into the state. PURE (returns a new state). */
export function foldLastOut(state, movements, nowMs) {
  const last = { ...(state?.last || {}) };
  let cursor = Date.parse(state?.cursor || "") || 0;
  for (const m of Object.values(movements || {})) {
    const t = Date.parse((m && (m.ts || m.appliedAt)) || "");
    if (!Number.isFinite(t) || t > nowMs + 5 * 60e3) continue;
    if (t > cursor) cursor = t;
    const k = outboundShelf(m);
    if (k && !(Number(last[k]) >= t)) last[k] = t;
  }
  return { cursor: cursor ? new Date(cursor).toISOString() : state?.cursor || null, since: state?.since || null, last };
}

/**
 * The not-selling shelves, oldest first. PURE.
 *   held   [{ loc, pid, sizeKey, qty, at }]   shelves showing stock (the nightly sweep's cells)
 * → [{ loc, pid, sizeKey, shown, at, lastMoved }]   `at` = last sale/outbound (or how far back the file sees)
 */
export function notSelling(held, state, { nowMs, idleDays }) {
  const since = Date.parse(state?.since || "");
  const out = [];
  const idleMs = idleDays * 864e5;
  // A file that cannot yet see back far enough proves nothing about shelves without an entry.
  const seesFarEnough = Number.isFinite(since) && nowMs - since >= idleMs;
  for (const h of held || []) {
    if (!(Number(h.qty) > 0)) continue;
    const t = Number(state?.last?.[`${h.loc}|${h.pid}|${h.sizeKey}`]);
    const lastOut = Number.isFinite(t) && t > 0 ? t : seesFarEnough ? since : null;
    if (lastOut == null || nowMs - lastOut < idleMs) continue;
    out.push({ loc: h.loc, pid: h.pid, sizeKey: h.sizeKey, shown: Number(h.qty), at: lastOut, lastMoved: h.at ?? null });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Drop entries older than `keepDays` (the file stays small). PURE. */
export function pruneLastOut(state, nowMs, keepDays = 120) {
  const cut = nowMs - keepDays * 864e5;
  const last = {};
  for (const [k, t] of Object.entries(state?.last || {})) if (Number(t) >= cut) last[k] = t;
  const since = Date.parse(state?.since || "");
  return { ...state, last, since: Number.isFinite(since) && since < cut ? new Date(cut).toISOString() : state?.since || null };
}

export function loadLastOut(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
export function saveLastOut(file, state) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}
