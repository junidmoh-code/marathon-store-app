// ─── MOVEMENT HISTORY ─────────────────────────────────────────────────────────
// Per-product view of the immutable ledger (/stock_movements). Read-only audit
// trail — newest first. This is the source of truth from which balances are
// re-derived; nothing here is editable.

import React, { useState, useMemo, useEffect } from "react";
import { ref, onValue } from "firebase/database";
import { database } from "../../firebase";
import { useMovements } from "./useStock";
import { labelFor } from "./locations";
import { Empty } from "./widgets";
import { GRAY, GREEN, RED, BLUE_L, BORDER, CARD, input } from "./ui";

// Product thumbnail — tap target in search results / selected header.
function Thumb({ url, size = 38 }) {
  if (url) return <img src={url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }}
    style={{ width: size, height: size, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />;
  return <div style={{ width: size, height: size, borderRadius: 8, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.45, flexShrink: 0 }}>👟</div>;
}

// uid → display name map from /users, so the ledger shows WHO did each entry
// (not a raw uid). Admin-readable; small node, read once and kept live.
function useUserNames() {
  const [map, setMap] = useState({});
  useEffect(() => {
    const off = onValue(ref(database, "users"), (snap) => {
      const v = snap.val() || {}, m = {};
      for (const uid of Object.keys(v)) {
        const u = v[uid] || {};
        m[uid] = u.displayName || u.username || u.name || u.email || uid.slice(0, 6);
      }
      setMap(m);
    }, () => {});
    return () => off();
  }, []);
  return map;
}

const SIGN = { received: "+", opening: "+", transfer_in: "+", return: "+", sold: "−", transfer_out: "−" };
const COLOR = { received: GREEN, opening: GREEN, transfer_in: GREEN, return: GREEN, sold: RED, transfer_out: RED, adjustment: BLUE_L };

function when(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString("en-ZA", { dateStyle: "short", timeStyle: "short" }); }
  catch { return ts; }
}

// old→new per affected location, from the before/after the writer records. One loc
// for most movements; both cells for a transfer. Returns "" for legacy entries
// written before before/after existed.
function oldNew(m, registry) {
  if (!m.before || !m.after) return "";
  const locs = Object.keys(m.after);
  if (!locs.length) return "";
  return locs
    .map(loc => `${labelFor(loc, registry)} ${m.before?.[loc] ?? "?"}→${m.after[loc]}`)
    .join(" · ");
}

export default function MovementHistory({ products, registry }) {
  const [productId, setProductId] = useState("");
  const [q, setQ] = useState("");
  const movements = useMovements(productId || undefined);
  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  const userNames = useUserNames();
  const actorOf = (m) => {
    const name = m.actor ? userNames[m.actor] : null;
    return name || m.actorRole || (m.actor ? m.actor.slice(0, 6) : "—");
  };

  // Search products by name OR any code (barcode / sku / per-size). Capped for speed.
  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const codeMatch = (p) => {
      if (!/\d/.test(term)) return false;
      const codes = [];
      if (p.barcode != null) codes.push(String(p.barcode));
      if (p.sku != null) codes.push(String(p.sku));
      if (p.barcodes && typeof p.barcodes === "object") for (const c of Object.values(p.barcodes)) if (c != null) codes.push(String(c));
      return codes.some(c => c === term || (term.length >= 3 && c.toLowerCase().includes(term)));
    };
    return [...(products || [])]
      .filter(p => p && p.id && p.name && (p.name.toLowerCase().includes(term) || codeMatch(p)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 40);
  }, [products, q]);

  return (
    <div>
      {/* Search bar */}
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search product or barcode…"
        style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />

      {/* No product chosen yet → show matching products WITH photos to pick from. */}
      {!product && (
        q.trim() === "" ? <Empty>Search for a product to see its movement history.</Empty>
        : matches.length === 0 ? <Empty>No products match “{q.trim()}”.</Empty>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {matches.map(p => (
              <button key={p.id} onClick={() => { setProductId(p.id); setQ(""); }}
                style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left", background: CARD, border: BORDER, borderRadius: 10, padding: "8px 10px", cursor: "pointer" }}>
                <Thumb url={p.photoUrl} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                  {p.category && <div style={{ fontSize: 10.5, color: GRAY }}>{p.category}</div>}
                </div>
                <span style={{ color: BLUE_L, fontSize: 12 }}>History ▸</span>
              </button>
            ))}
          </div>
        )
      )}

      {/* Selected product header — photo + name + change. */}
      {product && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: CARD, border: BORDER, borderRadius: 10, padding: "9px 11px", marginBottom: 10 }}>
          <Thumb url={product.photoUrl} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{product.name}</div>
            <div style={{ fontSize: 11, color: GRAY }}>{movements.length} movement(s)</div>
          </div>
          <button onClick={() => setProductId("")} style={{ background: "transparent", border: "1px solid rgba(60,110,255,.3)", borderRadius: 9, padding: "6px 12px", color: BLUE_L, fontSize: 12, cursor: "pointer" }}>Change</button>
        </div>
      )}

      {product && movements.length === 0 && <Empty>No movements recorded for this product yet.</Empty>}

      {product && movements.map(m => {
        const adj = m.type === "adjustment";
        const sign = adj ? (m.to ? "+" : "−") : (SIGN[m.type] || "");
        const route = m.from && m.to ? `${labelFor(m.from, registry)} → ${labelFor(m.to, registry)}`
          : m.to ? `→ ${labelFor(m.to, registry)}`
          : m.from ? `${labelFor(m.from, registry)} →` : "";
        return (
          <div key={m.id} style={{ borderBottom: BORDER, padding: "9px 4px", display: "flex", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "#fff" }}>
                <span style={{ color: COLOR[m.type] || "#fff", fontWeight: 700 }}>{m.type}</span>
                <span style={{ color: GRAY, marginLeft: 6 }}>size {m.size}</span>
              </div>
              <div style={{ fontSize: 11, color: GRAY, marginTop: 2 }}>{route}</div>
              {oldNew(m, registry) && <div style={{ fontSize: 11, color: GRAY, marginTop: 2 }}>{oldNew(m, registry)}</div>}
              {m.reason && <div style={{ fontSize: 11, color: BLUE_L, marginTop: 2 }}>“{m.reason}”</div>}
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 2 }}>
                {when(m.ts)} · by <span style={{ color: "rgba(255,255,255,.7)" }}>{actorOf(m)}</span>
              </div>
            </div>
            <div style={{ color: COLOR[m.type] || "#fff", fontWeight: 700, fontSize: 16, whiteSpace: "nowrap" }}>
              {sign}{m.qty}
            </div>
          </div>
        );
      })}
    </div>
  );
}
