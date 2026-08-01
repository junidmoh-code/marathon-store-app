// ─── MARKETING ────────────────────────────────────────────────────────────────
// The picked-products workspace: two fixed tabs, Marketing and Display.
//
// Products get INTO these lists from the Attention grid (the ✚ on a tile).
// Reviewing them lives here, on its own card, because the two jobs belong to
// different moments — Attention is "what needs looking at", this is "what did
// we decide to do with it". Same lists, same rules, same behaviour; only the
// place you look at them has moved.
//
//   MARKETING — the week's advertising shortlist.
//   DISPLAY   — what should go out on the shop floor.
//
// Read + remove only. Adding is deliberately not offered here: you pick from
// the Attention grid where you can see the stock, the photo and the numbers,
// not from a bare list.

import React, { useMemo, useState } from "react";
import { LISTS, resolveListProducts } from "./attentionLists";
import { useAttentionLists } from "./useAttentionLists";
import { FONT, GLASS, GRAY, RED, AMBER, BLUE_L } from "./ui";

const count = (n) => new Intl.NumberFormat("en-ZA").format(n || 0);

export default function MarketingView({ products, onExit }) {
  const [openListId, setOpenListId] = useState(LISTS[0].id);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { lists, removeFromList, ready } = useAttentionLists();

  const productsById = useMemo(() => {
    const out = {};
    for (const p of products || []) if (p?.id) out[p.id] = p;
    return out;
  }, [products]);

  const open = lists.find((l) => l.id === openListId) || lists[0];
  const contents = useMemo(() => resolveListProducts(open, productsById), [open, productsById]);

  const removeItem = async (productId) => {
    setBusy(true); setError(null);
    try { await removeFromList(open.id, productId); }
    catch (err) { console.warn("Marketing: write failed:", err); setError(err?.message || "Could not save."); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: "#fff", padding: "18px 22px 44px", maxWidth: 1640, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onExit}
          style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.25)", color: BLUE_L, borderRadius: 10, padding: "9px 13px", fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: FONT }}>
          ← Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: "-.01em" }}>Marketing</div>
          <div style={{ fontSize: 12.5, color: GRAY, marginTop: 2 }}>{open?.blurb} · picked from Attention</div>
        </div>
      </div>

      {/* Both tabs are always present, whether or not anything is in them —
          they're fixed destinations, not folders that come and go. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {lists.map((l) => {
          const on = l.id === open?.id;
          return (
            <button
              key={l.id}
              onClick={() => setOpenListId(l.id)}
              aria-pressed={on}
              style={{
                ...GLASS, fontFamily: FONT, cursor: "pointer", textAlign: "left", padding: "11px 18px", minWidth: 172,
                border: on ? "1px solid rgba(74,127,255,.55)" : "1px solid rgba(255,255,255,.08)",
                background: on ? "rgba(74,127,255,.13)" : GLASS.background,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 800, color: on ? "#fff" : "#cfd8ee" }}>
                {l.label} <span style={{ color: on ? BLUE_L : GRAY, fontWeight: 700 }}>{count(l.count)}</span>
              </div>
              <div style={{ fontSize: 10.5, color: on ? BLUE_L : GRAY, marginTop: 3 }}>{l.blurb}</div>
            </button>
          );
        })}
      </div>

      {error && <div style={{ ...GLASS, padding: "10px 12px", color: RED, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!ready ? (
        <Empty>Loading…</Empty>
      ) : contents.length === 0 ? (
        <Empty>
          Nothing in {open?.label} yet — pick products with the ✚ on any card in Attention.
        </Empty>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(196px, 1fr))", gap: 13, alignItems: "start" }}>
          {contents.map((c) => (
            <div key={c.id} style={{ ...GLASS, overflow: "hidden" }}>
              <div style={{ height: 168, background: "rgba(255,255,255,.03)", position: "relative" }}>
                {c.photo ? (
                  <img src={c.photo} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                ) : (
                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,.16)", fontSize: 32, fontWeight: 800 }}>
                    {(c.name || "?").trim().charAt(0).toUpperCase()}
                  </div>
                )}
                <button
                  onClick={() => removeItem(c.id)}
                  disabled={busy}
                  title={`Remove from ${open.label}`}
                  style={{ position: "absolute", top: 7, right: 7, width: 27, height: 27, borderRadius: 8, cursor: busy ? "default" : "pointer", fontFamily: FONT, fontSize: 13, fontWeight: 800, background: "rgba(0,0,0,.72)", border: "1px solid rgba(255,255,255,.28)", color: "#fff", backdropFilter: "blur(6px)" }}
                >
                  ✕
                </button>
              </div>
              <div style={{ padding: "10px 12px 12px" }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.3, height: "2.6em", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  {c.missing ? "Removed from catalogue" : c.name}
                </div>
                {c.missing
                  ? <div style={{ fontSize: 10, color: AMBER, marginTop: 4 }}>{c.id}</div>
                  : <div style={{ fontSize: 10.5, color: GRAY, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {[c.product?.brand, c.product?.subcategory].filter(Boolean).join(" · ")}
                    </div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ ...GLASS, padding: "48px 20px", textAlign: "center", color: GRAY, fontSize: 13.5 }}>{children}</div>;
}
