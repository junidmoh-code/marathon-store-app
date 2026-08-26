// ─── DISPLAY REGISTRATION — THE VIEW ─────────────────────────────────────────
// (Owner ask, 2026-08-26; the card is DisplayRegistrationCard.jsx.) One lane,
// three jobs, one product at a time:
//
//   1. REGISTER — new stock arrived, a pair went on a display wall: find the
//      product (name search or a label/barcode scan — the same window-level
//      scanner burst listener the count screens use), pick the size and the
//      shop wall, save. Records the FACT ONLY (register row with no movement
//      + display slot) — the pair was already booked by receiving.
//   2. FIX A SIZE — display recheck found the system says 6 and the wall
//      holds 7: pick the registered row, tap the right size. The register
//      quantity moves between size keys in one atomic multi-path update and
//      every live slot holding the old size is re-pointed.
//   3. REMOVE — the display came down or the row never matched reality.
//
// Reads: the products list (passed in), one register subscription for the
// picked hub (~172 KB, the same node the shop marker already streams) and the
// slots node (~60 KB). Writers live in displayRegistrationStore.js.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { CARD, BORDER, BLUE, BLUE_L, FONT } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { installBarcodeListener, subscribeBarcode } from "./barcodeListener";
import { lookupBarcode } from "./hubCleanupStore";
import { useDisplaySlots, useDisplayRegister } from "./useStock";
import { slotIsLive } from "./displaySlots";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { recordDisplayFact, editDisplaySize, removeDisplayFact } from "./displayRegistrationStore";

const HUBS = ["hub1", "hub2"];
const STORES = ["marathon-pe", "trophy", "marathon-pine"];
const AMBER = "#FBBF24";

const chip = (on, tone = BLUE) => ({
  padding: "10px 16px", borderRadius: 10, fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit",
  border: `2px solid ${on ? tone : "rgba(255,255,255,.14)"}`,
  background: on ? (tone === AMBER ? "rgba(251,191,36,.16)" : "rgba(74,127,255,.16)") : "rgba(255,255,255,.03)",
  color: on ? (tone === AMBER ? AMBER : BLUE_L) : "rgba(233,238,255,.6)",
});

export default function DisplayRegistrationView({ products = [], onExit }) {
  const [hub, setHub] = useState("hub1");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [size, setSize] = useState("");
  const [store, setStore] = useState("marathon-pe");
  const [editing, setEditing] = useState(null);   // { fromSizeKey } — the row being resized
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);         // { tone: "ok"|"err", text }
  const searchRef = useRef(null);

  const slots = useDisplaySlots(true);
  const register = useDisplayRegister(hub, true);

  const results = useMemo(() => (query.trim() ? searchProducts(products, query, { limit: 12 }) : []), [products, query]);

  // Scanner: window-level burst listener (never while typing in an input —
  // the listener itself refuses focused fields, so the search box keeps
  // plain keyboard entry). A scan resolves through /barcodes and lands on
  // the product directly.
  useEffect(() => {
    const uninstall = installBarcodeListener();
    const unsub = subscribeBarcode(async (value) => {
      try {
        const hit = await lookupBarcode(String(value));
        const pid = hit?.productId;
        const p = pid ? products.find((x) => x.id === pid) : null;
        if (p) { pick(p); setNote(null); }
        else setNote({ tone: "err", text: `Scan ${value} matched no product — search by name instead.` });
      } catch {
        setNote({ tone: "err", text: "Scan lookup failed — search by name instead." });
      }
    });
    return () => { unsub(); uninstall(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  const pick = (p) => { setSelected(p); setQuery(""); setSize(""); setEditing(null); setNote(null); };

  const realSizes = useMemo(() =>
    (selected?.sizes || []).map(String).map((s) => s.trim()).filter((s) => s && s !== "_"), [selected]);

  // The product's current display facts at this hub: register rows (the
  // store-less majority) joined with the live slots (store known).
  const facts = useMemo(() => {
    if (!selected) return [];
    const out = {};
    for (const [key, row] of Object.entries(register || {})) {
      const i = key.lastIndexOf("__");
      if (i <= 0 || key.slice(0, i) !== selected.id) continue;
      const sizeKey = key.slice(i + 2);
      out[sizeKey] = { sizeKey, size: row?.size || sizeKey.replace(/(\d)_(\d)/g, "$1.$2"), qty: Number(row?.qty) || 0, stores: [] };
    }
    for (const [st, byPid] of Object.entries(slots || {})) {
      const slot = byPid?.[selected.id];
      if (!slotIsLive(slot) || slot.bookedHub !== hub) continue;
      (out[slot.sizeKey] ||= { sizeKey: slot.sizeKey, size: slot.size, qty: 0, stores: [] }).stores.push(st);
    }
    return Object.values(out).filter((f) => f.qty > 0 || f.stores.length > 0);
  }, [selected, register, slots, hub]);

  const slotStoresFor = (sizeKey) => (facts.find((f) => f.sizeKey === sizeKey)?.stores) || [];

  const doRegister = async () => {
    if (!selected || !size || busy) return;
    setBusy(true);
    const res = await recordDisplayFact({ hub, product: selected, size, store: store || null });
    setBusy(false);
    setNote(res.ok
      ? { tone: "ok", text: `Registered: size ${formatSize(size)} on the display${store ? ` at ${labelFor(store)}` : ""}.` }
      : { tone: "err", text: res.message || "Could not save — try again." });
    if (res.ok) setSize("");
  };

  const doEdit = async (toSize) => {
    if (!selected || !editing || busy) return;
    setBusy(true);
    const res = await editDisplaySize({
      hub, product: selected, fromSizeKey: editing.fromSizeKey, toSize,
      slotStores: slotStoresFor(editing.fromSizeKey),
    });
    setBusy(false);
    setNote(res.ok
      ? { tone: "ok", text: `Fixed: the display is size ${formatSize(toSize)} now.` }
      : { tone: "err", text: res.message || "Could not save — try again." });
    if (res.ok) setEditing(null);
  };

  const doRemove = async (f) => {
    if (!selected || busy) return;
    setBusy(true);
    const res = await removeDisplayFact({ hub, product: selected, sizeKey: f.sizeKey, slotStores: f.stores });
    setBusy(false);
    setNote(res.ok
      ? { tone: "ok", text: `Removed the size ${formatSize(f.size)} display record.` }
      : { tone: "err", text: res.message || "Could not save — try again." });
  };

  return (
    <div style={{ minHeight: "100vh", background: "#000", fontFamily: FONT, color: "#fff", padding: "18px 16px 60px", maxWidth: 620, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={AMBER} strokeWidth="2.2"><rect x="3" y="5" width="18" height="12" rx="2"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
          <div style={{ fontWeight: 800, fontSize: 18 }}>Display Registration</div>
        </div>
        <button onClick={onExit} style={{ background: "transparent", border: "1px solid rgba(255,255,255,.18)", color: "rgba(255,255,255,.7)", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>Exit</button>
      </div>

      {/* hub picker */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {HUBS.map((h) => (
          <button key={h} onClick={() => { setHub(h); setEditing(null); }} style={chip(hub === h)}>{h === "hub1" ? "Hub 1" : "Hub 2"}</button>
        ))}
      </div>

      {/* search / scan */}
      <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, or scan the label / barcode…"
        style={{ width: "100%", boxSizing: "border-box", padding: "13px 14px", borderRadius: 12, border: BORDER, background: CARD, color: "#fff", fontSize: 15, fontFamily: "inherit", marginBottom: 8 }} />
      {results.length > 0 && (
        <div style={{ background: CARD, border: BORDER, borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
          {results.map((p) => (
            <button key={p.id} onClick={() => pick(p)}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,.05)", color: "#fff", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
              {p.photoUrl ? <img src={p.photoUrl} alt="" style={{ width: 34, height: 44, objectFit: "cover", borderRadius: 6 }} /> : <span style={{ width: 34, textAlign: "center" }}>👟</span>}
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</span>
            </button>
          ))}
        </div>
      )}

      {note && (
        <div style={{ background: note.tone === "ok" ? "rgba(74,222,128,.1)" : "rgba(248,113,113,.1)", border: `1px solid ${note.tone === "ok" ? "rgba(74,222,128,.4)" : "rgba(248,113,113,.4)"}`, color: note.tone === "ok" ? "#4ADE80" : "#F87171", borderRadius: 10, padding: "9px 12px", fontSize: 12.5, fontWeight: 700, marginBottom: 12 }}>
          {note.text}
        </div>
      )}

      {selected && (
        <div style={{ background: CARD, border: BORDER, borderRadius: 14, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
            {selected.photoUrl ? <img src={selected.photoUrl} alt="" style={{ width: 52, height: 68, objectFit: "cover", borderRadius: 8 }} /> : null}
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{selected.name}</div>
              <div style={{ color: "rgba(255,255,255,.45)", fontSize: 11.5 }}>{hub === "hub1" ? "Hub 1" : "Hub 2"} display records</div>
            </div>
          </div>

          {/* current facts */}
          {facts.length > 0 ? facts.map((f) => (
            <div key={f.sizeKey} style={{ border: "1px solid rgba(251,191,36,.3)", background: "rgba(251,191,36,.05)", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: AMBER }}>
                  Size {formatSize(f.size)}{f.qty > 1 ? ` ×${f.qty}` : ""}
                  <span style={{ color: "rgba(233,238,255,.55)", fontWeight: 600 }}>
                    {" "}— {f.stores.length ? `on ${f.stores.map((s) => labelFor(s)).join(", ")}'s display` : "shop not recorded"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { setEditing(editing?.fromSizeKey === f.sizeKey ? null : { fromSizeKey: f.sizeKey }); setNote(null); }}
                    style={{ ...chip(editing?.fromSizeKey === f.sizeKey, AMBER), padding: "6px 10px", fontSize: 11.5 }}>Change size</button>
                  <button onClick={() => doRemove(f)} disabled={busy}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(248,113,113,.4)", background: "rgba(248,113,113,.08)", color: "#F87171", fontWeight: 700, fontSize: 11.5, cursor: "pointer", fontFamily: "inherit" }}>Remove</button>
                </div>
              </div>
              {editing?.fromSizeKey === f.sizeKey && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: "rgba(233,238,255,.5)", fontWeight: 700, marginBottom: 6 }}>WHAT SIZE IS ACTUALLY ON THE DISPLAY?</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {realSizes.map((s) => (
                      <button key={s} onClick={() => doEdit(s)} disabled={busy} style={chip(false, AMBER)}>{formatSize(s)}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )) : (
            <div style={{ color: "rgba(255,255,255,.4)", fontSize: 12.5, marginBottom: 10 }}>No display registered for this product at {hub === "hub1" ? "Hub 1" : "Hub 2"} yet.</div>
          )}

          {/* register new */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,.07)" }}>
            <div style={{ fontSize: 11, color: "rgba(233,238,255,.5)", fontWeight: 700, marginBottom: 6 }}>REGISTER A DISPLAY — WHICH SIZE WENT ON THE WALL?</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {realSizes.map((s) => (
                <button key={s} onClick={() => setSize(size === s ? "" : s)} style={chip(size === s)}>{formatSize(s)}</button>
              ))}
              {!realSizes.length && <div style={{ color: AMBER, fontSize: 12 }}>This product has no sizes on record — fix the product first.</div>}
            </div>
            <div style={{ fontSize: 11, color: "rgba(233,238,255,.5)", fontWeight: 700, marginBottom: 6 }}>WHOSE DISPLAY WALL?</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {STORES.map((st) => (
                <button key={st} onClick={() => setStore(store === st ? "" : st)} style={chip(store === st)}>{labelFor(st)}</button>
              ))}
            </div>
            <button onClick={doRegister} disabled={!size || busy}
              style={{ width: "100%", padding: "12px", borderRadius: 11, border: "none", fontFamily: "inherit",
                       background: size && !busy ? "#4ADE80" : "rgba(255,255,255,.06)",
                       color: size && !busy ? "#04351a" : "rgba(233,238,255,.3)", fontWeight: 800, fontSize: 14, cursor: size && !busy ? "pointer" : "not-allowed" }}>
              {size ? `Register size ${formatSize(size)} on the display` : "Pick a size"}
            </button>
            <div style={{ color: "rgba(255,255,255,.35)", fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
              Records the display fact only — no stock is added or moved. New-stock pairs are already booked by receiving.
            </div>
          </div>
        </div>
      )}

      {!selected && !results.length && (
        <div style={{ textAlign: "center", color: "rgba(255,255,255,.35)", padding: "3rem 1rem", fontSize: 13 }}>
          Scan a shoe's label or barcode, or search its name, to register or fix its display size.
        </div>
      )}
    </div>
  );
}
