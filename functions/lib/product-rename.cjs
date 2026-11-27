// ─── RENAMING A PRODUCT — THE DECISIONS, PURE (Junid, 27 Nov 2026) ───────────
//
// The Admin product page's Name field saved on blur straight to
// /products/{pid}/name: no permission check, no record of who, and on an
// iPhone the edit was easily lost. A rename now goes through setProductName
// (functions/productType/setProductName.js), which uses this:
//
//   · WHO: the same rule as Type (product-type.cjs) — a product with stock or
//     sales (any /stock cell anywhere) may only be renamed by a manager
//     (Junid, Jafer, or MC's enrolled code-making device). A brand-new product
//     with no cells may be renamed by anyone who can edit it today.
//   · WHAT: the trimmed name. Never styleCode / styleCodeNormalised (immutable).
//     The brand/category fields the page always re-derived on a rename ride in
//     the same write, restricted to those keys (RENAME_EXTRA_KEYS) — the page's
//     existing behaviour, carried over unchanged, not new policy.
//   · NEVER A TWIN: two products with the same name collided in the Source
//     queue (the SB Dunk / Gucci slide incidents). The page refuses a name
//     another product already has, naming that product; sameName() is the one
//     comparison both sides use.
//   · WHAT ELSE MOVES: every stored identity path is keyed by pid — stock,
//     refill requests, the refill engine, displays, holds, Shopify, style-code
//     claims, barcodes. Nothing there carries the name as a key, so nothing has
//     to be rewritten. Refill requests are deliberately NOT written at all: any
//     write to /refill_requests/{id} wakes firstBatchLeg, which can raise a
//     leg, and only the scan may raise a request (Junid's rule, CLAUDE.md).
//     What a rename DOES update, in the same multi-path write:
//       – products/{pid}/previousNames — so readers that join history by the
//         name copied onto old events (insights_log) still find it;
//       – a pending AI name proposal for this product is closed, so approving
//         it later cannot silently overwrite the name chosen by hand.
//   · LOGGED: product_name_log/{pid}/{key} with from, to, when (server clock),
//     the person, the device, the uid — its own top-level node with NO client
//     rule, like product_type_log, so no device can alter an entry.
"use strict";

const { cellsExist } = require("./product-type.cjs");

const NAME_LOG_ROOT = "product_name_log";
const NAME_PROPOSALS_ROOT = "aiAssistant/nameProposals";
const MAX_NAME = 200;
const MAX_PREVIOUS = 10;
// Exactly what brandOnRename and headwearRenamePatch (src/utils) return.
const RENAME_EXTRA_KEYS = new Set(["brand", "brandFlag", "brandSource", "category", "categoryKey", "subcategory"]);

/** The comparison that decides "same name": trimmed, inner whitespace
 *  collapsed, case-insensitive. Stricter than byte-equal on purpose — the
 *  Gucci twin differed only by a trailing space. */
function nameKey(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function sameName(a, b) { return nameKey(a) !== "" && nameKey(a) === nameKey(b); }

function readName(x) {
  if (typeof x !== "string") return null;
  const t = x.trim();
  if (!t || t.length > MAX_NAME) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

function cleanExtras(extras) {
  const out = {};
  for (const [k, v] of Object.entries(extras && typeof extras === "object" ? extras : {})) {
    if (!RENAME_EXTRA_KEYS.has(k)) continue;
    if (v === null || typeof v === "boolean" || (typeof v === "string" && v.length <= 80)) out[k] = v;
  }
  return out;
}

/**
 * @returns {{ ok:false, code, message } | { ok:true, noop?:true, from, to, previousNames, extras }}
 */
function planRename(product, to, { from, cellsByLoc = {}, isManager = false, extras = null } = {}) {
  const next = readName(to);
  if (!next) return { ok: false, code: "invalid-argument", message: `A name must be 1–${MAX_NAME} characters.` };
  if (!product || typeof product !== "object") return { ok: false, code: "not-found", message: "That product no longer exists." };
  const current = typeof product.name === "string" ? product.name : "";
  if (next === current) return { ok: true, noop: true, from: current, to: next };
  // Compare-and-set on what the person was looking at — required, so a caller
  // cannot skip it. (A rename landing in the instant between this read and the
  // write is not caught; both are logged. Accepted: renames are rare and by hand.)
  if (typeof from !== "string") return { ok: false, code: "invalid-argument", message: "Which name were you changing? Reload the page and try again." };
  if (from !== current) {
    return { ok: false, code: "aborted", message: `Someone else renamed this product a moment ago, to “${current}”. Look again, then try again.` };
  }
  if (cellsExist(cellsByLoc) && !isManager) {
    return { ok: false, code: "permission-denied",
      message: "This product has stock or sales, so only Junid, Jafer or MC can rename it. Ask one of them." };
  }
  const prev = Array.isArray(product.previousNames) ? product.previousNames.filter((n) => typeof n === "string" && n) : [];
  const previousNames = current && !prev.includes(current) ? [...prev, current].slice(-MAX_PREVIOUS) : prev;
  return { ok: true, from: current, to: next, previousNames, extras: cleanExtras(extras) };
}

/** The other products (not `pid`) whose name is the same as `name`. */
function twinsOf(products, pid, name) {
  return Object.entries(products || {})
    .filter(([id, p]) => id !== pid && p && sameName(p.name, name))
    .map(([id, p]) => ({ id, name: p.name }));
}

/** The one multi-path update a rename is. */
function renameUpdate({ pid, plan, now, key, by, uid, manager, proposal, openRequests }) {
  const u = {
    [`products/${pid}/name`]: plan.to,
    [`products/${pid}/nameChangedAt`]: now,
    [`products/${pid}/previousNames`]: plan.previousNames.length ? plan.previousNames : null,
    ...Object.fromEntries(Object.entries(plan.extras || {}).map(([k, v]) => [`products/${pid}/${k}`, v])),
    [`${NAME_LOG_ROOT}/${pid}/${key}`]: {
      from: plan.from || null, to: plan.to, atMs: now,
      personName: by.personName || null, deviceId: by.deviceId || null, deviceVerified: !!by.deviceVerified,
      uid, manager: !!manager, openRefillRequests: openRequests || 0,
    },
  };
  if (proposal && proposal.status !== "approved" && proposal.status !== "rejected") {
    u[`${NAME_PROPOSALS_ROOT}/${pid}/status`] = "rejected";
    u[`${NAME_PROPOSALS_ROOT}/${pid}/rejectReason`] = "renamed by hand";
    u[`${NAME_PROPOSALS_ROOT}/${pid}/decidedAt`] = now;
  }
  return u;
}

module.exports = {
  planRename, renameUpdate, twinsOf, sameName, nameKey, readName,
  NAME_LOG_ROOT, NAME_PROPOSALS_ROOT, RENAME_EXTRA_KEYS, MAX_PREVIOUS,
};
