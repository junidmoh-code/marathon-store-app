// ─── WEBSITE UNAVAILABLE LINES — shared pure helpers ─────────────────────────
// No IO here. Used by the collector (which products to read) and the analysis.

/** A line status that means "the place could not produce it". */
export const FAILED_STATUSES = Object.freeze(["unavailable", "no_stock", "not_found", "needs_attention", "resolving", "resolved"]);

export const linesOf = (order) => {
  const L = order?.lines;
  if (!L) return [];
  return (Array.isArray(L) ? L : Object.keys(L).sort((a, b) => a - b).map((k) => L[k])).map((l, i) => (l ? { ...l, _i: i } : null)).filter(Boolean);
};

/** Every product id that appears on a website order, including what a line was swapped from. */
export function pidsOnOrders(orders) {
  const out = new Set();
  for (const o of Object.values(orders)) for (const l of linesOf(o)) {
    for (const p of [l.pid, l.originalPid, l.swappedFrom?.pid]) if (p) out.add(p);
  }
  return out;
}

/** "{orderId}:{line}:{unit}:{routeGen}" (an /online_order_refs owner) → parts. */
export function parseRefOwner(owner) {
  const [orderId, line, unit, gen] = String(owner || "").split(":");
  return { orderId, line: Number(line), unit: Number(unit), gen: Number(gen) || 0 };
}

/** "online__{orderId}__{line}[_r{gen}]" (a website-pick display check) → parts. */
export function parseCheckKey(key) {
  const m = /^online__(.+?)__(\d+)(?:_r(\d+))?$/.exec(String(key || ""));
  return m ? { orderId: m[1], line: Number(m[2]), gen: Number(m[3]) || 0 } : null;
}

/** The products that had a failed line: what the collector reads stock and names for. */
export function failedPids(orders, hubOrders = {}, checks = {}) {
  const out = new Set();
  for (const o of Object.values(orders)) for (const l of linesOf(o)) {
    const failedNow = FAILED_STATUSES.includes(l.source?.status);
    const failedBefore = l.swappedFrom || l.unavailable || l.failedPlaces || l.repick || l.escalation || l.escalationOverride || l.orderNow || (Number(l.routeGen) || 0) > 0;
    if (failedNow || failedBefore) for (const p of [l.pid, l.originalPid, l.swappedFrom?.pid]) if (p) out.add(p);
  }
  for (const h of Object.values(hubOrders)) if (h && (h.status === "out_of_stock" || h.outOfStock) && h.productId) out.add(h.productId);
  for (const c of Object.values(checks)) if (c && c.result === "not_found" && (c.productId || c.pid)) out.add(c.productId || c.pid);
  return out;
}
