// ─── IN TRANSIT ───────────────────────────────────────────────────────────────
// Everything currently sitting in the in_transit holding (dispatched, not yet
// received). Stock here is VISIBLE — never a gap. Rows aging past a threshold are
// flagged so an abandoned transfer (dispatched but never confirmed) surfaces as a
// reconciliation task rather than silently understating a hub.

import React from "react";
import { useStockCells } from "./useStock";
import { IN_TRANSIT } from "./locations";
import { Card, Empty } from "./widgets";
import { GRAY, GREEN, RED, AMBER, BORDER } from "./ui";

const STALE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

function ageLabel(updatedAt) {
  if (!updatedAt) return { text: "—", stale: false };
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return { text: "—", stale: false };
  const ms = Date.now() - t;
  const stale = ms > STALE_MS;
  const h = Math.floor(ms / 3600000);
  const text = h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
  return { text, stale };
}

export default function InTransit({ products }) {
  const transit = useStockCells(IN_TRANSIT);   // { pid: { size: cell } }
  const nameFor = (pid) => products.find(p => p.id === pid)?.name || pid;

  const rows = [];
  for (const [pid, sizes] of Object.entries(transit || {})) {
    for (const [size, cell] of Object.entries(sizes || {})) {
      if (cell && typeof cell.qty === "number" && cell.qty !== 0) {
        rows.push({ pid, size, qty: cell.qty, updatedAt: cell.updatedAt });
      }
    }
  }
  rows.sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));

  if (!rows.length) return <Empty>Nothing in transit. Dispatched transfers appear here until received.</Empty>;

  return (
    <Card>
      {rows.map((r, i) => {
        const { text, stale } = ageLabel(r.updatedAt);
        return (
          <div key={`${r.pid}-${r.size}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 2px", borderTop: i ? BORDER : "none" }}>
            <div>
              <div style={{ fontSize: 13, color: "#fff" }}>{nameFor(r.pid)}</div>
              <div style={{ fontSize: 11, color: GRAY }}>size {r.size}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 11, color: stale ? RED : AMBER }}>{stale ? `stale ${text}` : text}</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: r.qty < 0 ? RED : GREEN }}>{r.qty}</span>
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: GRAY, marginTop: 10 }}>
        Items <span style={{ color: RED }}>stale &gt; 2 days</span> likely mean a dispatch was never confirmed-received — reconcile.
      </div>
    </Card>
  );
}
