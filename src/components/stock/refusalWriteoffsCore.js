// ─── "WRITTEN OFF AFTER REFUSAL" — what the super-admin card shows ───────────
// The records are written by the hourly scan (functions/lib/refusal-writeoff.cjs)
// at /refill_engine/refusalWriteoffs/{id} whenever a location refused one size
// on four different days and its pre-refusal count was erased. This file turns
// them into card rows: product, size, location, units, who refused and when.
// Pure — the screen only draws what this returns, and the test pins that it
// reads exactly the fields the engine writes.

const LOC = { hub1: "Hub 1", hub2: "Hub 2", central: "Central", "marathon-pe": "Marathon PE", trophy: "Trophy" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const locName = (l) => LOC[l] || l || "—";
export const dayLabel = (d) => {
  const [, m, day] = String(d || "").split("-");
  return m ? `${Number(day)} ${MON[Number(m) - 1]}` : String(d || "");
};

// Who said no, in words. The Central queue records the account; Hub 2's
// "out of stock" on a shop order has only ever recorded the hub — name the
// hub and say no person was recorded, rather than invent a name.
export function refuserLabel(r, loc) {
  if (r?.byName) return r.byName;
  if (r?.byRole) return `${r.byRole} account`;
  const where = r?.byLoc || loc;
  return where ? `${locName(where)} staff (no name recorded)` : "no name recorded";
}

export function writeoffRows(value) {
  const list = Object.entries(value || {})
    .map(([id, r]) => (r && typeof r === "object" ? { ...r, id: r.id || id } : null))
    .filter(Boolean);
  const rows = list.map((r) => {
    const refusals = Array.isArray(r.refusals) ? r.refusals.filter(Boolean) : Object.values(r.refusals || {}).filter(Boolean);
    return {
      id: r.id,
      pid: r.pid,
      productName: r.productName || r.pid,
      size: r.size || "one size",
      location: locName(r.loc),
      units: Number(r.qty) || 0,
      left: typeof r.after === "number" ? r.after : null,
      writtenAtMs: Number(r.writtenAtMs) || Date.parse(r.writtenAt || "") || 0,
      refusals: refusals.map((x) => ({
        when: dayLabel(x.day), who: refuserLabel(x, r.loc), forShop: x.dest ? locName(x.dest) : null,
      })),
    };
  });
  rows.sort((a, b) => b.writtenAtMs - a.writtenAtMs || a.productName.localeCompare(b.productName));
  return rows;
}

// Headline for the stat card: write-offs in the last `days` days.
export function recentCount(rows, nowMs, days = 30) {
  return rows.filter((r) => nowMs - r.writtenAtMs <= days * 864e5).length;
}
