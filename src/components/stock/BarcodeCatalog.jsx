// ─── BARCODE CATALOG ──────────────────────────────────────────────────────────
// Browse-and-batch-print barcodes across the whole catalog (the standalone card to
// complement the on-save sheet in Set Qty / New Product). Search products, expand a
// product to see its sizes with current on-hand (summed across all locations),
// select sizes across one or many products, set copies per size, and print them all
// in one batch. Reuses the #73 value model + transport exactly:
//   • ensureBarcode (generate-if-missing / reuse-if-present / never regenerate) —
//     called ONLY at print time, so merely browsing never reserves codes.
//   • printLabels / TRANSPORTS (Phomemo / Xprinter) as-is.
// Admin-only. Read-only against /stock (display of on-hand); the only write is the
// barcode reservation at print, via the shared barcodeStore.

import React, { useState, useMemo } from "react";
import { useStockCells } from "./useStock";
import { ensureBarcode, getBarcode } from "./barcodeStore";
import { TRANSPORTS, printLabels, connectTransport } from "./printers";
import { Toast, Empty } from "./widgets";
import { GLASS, CARD, GRAY, GREEN, BLUE_L, AMBER, BORDER, FONT, BG, bGreen, bGhost, input } from "./ui";

const keyOf = (pid, size) => `${pid}|${size}`;

// Product thumbnail — same pattern as Transfer/Locator (product.photoUrl).
function Thumb({ product, size = 40 }) {
  const url = product?.photoUrl;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 9, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 9, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>👟</div>;
}

export default function BarcodeCatalog({ products, canMint, onExit }) {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState(null);
  const [sel, setSel] = useState({});   // { "pid|size": { productId, productName, size, count } }
  const [transport, setTransport] = useState(() => (TRANSPORTS.find(t => t.supported())?.id) || TRANSPORTS[0].id);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const cells = useStockCells();        // { loc: { pid: { size: cell } } } — all locations
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3400); };

  // On-hand for a product+size, summed across every location (the one source of truth).
  const onHand = (pid, size) => {
    let n = 0;
    for (const loc of Object.keys(cells || {})) {
      const c = cells[loc]?.[pid]?.[size];
      if (c && typeof c.qty === "number") n += c.qty;
    }
    return n;
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...(products || [])]
      .filter(p => p && p.id && p.name && Array.isArray(p.sizes) && p.sizes.length && (!q || p.name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, search]);

  const toggle = (p, size) => setSel(s => {
    const k = keyOf(p.id, size); const next = { ...s };
    if (next[k]) delete next[k];
    else next[k] = { productId: p.id, productName: p.name, size, count: String(Math.max(1, onHand(p.id, size))) };
    return next;
  });
  const setCount = (k, v) => setSel(s => (s[k] ? { ...s, [k]: { ...s[k], count: v } } : s));
  const selList = Object.entries(sel);

  const doPrint = async () => {
    if (!selList.length) return flash("err", "Select at least one size to print.");
    setBusy(true);
    // Connect FIRST — the printer picker needs the user-tap activation, which the
    // async barcode reservations below would otherwise consume (Android Chrome).
    let conn;
    try { conn = await connectTransport(transport); }
    catch (e) { setBusy(false); return flash("err", `Couldn't connect to the printer: ${String(e?.message || e)}`); }
    const items = []; let failReserve = 0, noCode = 0;
    for (const [, it] of selList) {
      try {
        // canMint (stockRole): reserve-if-missing / reuse. Otherwise reprint-only:
        // read the existing code, never mint (which would hit the stockRole-gated
        // /barcodes write). Sizes with no code yet are skipped with a message.
        const code = canMint ? (await ensureBarcode(it.productId, it.size)).code : await getBarcode(it.productId, it.size);
        const c = parseInt(it.count, 10) || 0;
        if (!code) { noCode++; continue; }
        if (c > 0) items.push({ code, productName: it.productName, size: it.size, count: c });
      } catch { failReserve++; }
    }
    if (!items.length) {
      setBusy(false);
      return flash("err", noCode ? `No printable labels — ${noCode} size(s) have no barcode yet (a warehouse/admin user must create them first).`
                                 : `Nothing to print${failReserve ? ` (${failReserve} failed)` : " (all counts 0)"}.`);
    }
    const res = await printLabels({ items, transport, conn });
    setBusy(false);
    const skipped = [];
    if (noCode) skipped.push(`${noCode} had no code`);
    if (failReserve) skipped.push(`${failReserve} failed`);
    const extra = skipped.length ? ` · ${skipped.join(", ")}` : "";
    const diag = res.diag ? ` [${res.diag}]` : "";
    if (res.ok) flash("ok", `Sent ${res.printed} label(s) to ${TRANSPORTS.find(t => t.id === transport)?.label}${extra}.${diag}`);
    else flash("err", `Print failed: ${res.error} — codes are saved; retry.${diag}`);
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <div style={{ padding: "14px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onExit} style={{ background: "none", border: "none", padding: 0, color: BLUE_L, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FONT }}>← Home</button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Barcodes</div>
        <div style={{ minWidth: 48 }} />
      </div>
      <div style={{ padding: "4px 14px 40px" }}>
      {!canMint && <div style={{ fontSize: 11, color: GRAY, marginBottom: 8 }}>Re-print existing labels — new barcodes are created by warehouse/admin.</div>}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…"
        style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />

      {/* Transport */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {TRANSPORTS.map(t => {
          const supported = t.supported(); const on = transport === t.id;
          return (
            <button key={t.id} onClick={() => supported && setTransport(t.id)} disabled={!supported}
              style={{ padding: "7px 11px", borderRadius: 9, cursor: supported ? "pointer" : "not-allowed", fontSize: 11.5, fontWeight: 600,
                       background: on ? "rgba(60,110,255,.2)" : "rgba(255,255,255,.04)", border: on ? "1px solid rgba(60,110,255,.6)" : BORDER,
                       color: supported ? (on ? "#fff" : GRAY) : "rgba(255,255,255,.25)" }}>
              {t.label}{!t.proven && <span style={{ color: AMBER, marginLeft: 5 }}>· untested</span>}{!supported && <span style={{ color: GRAY, marginLeft: 5 }}>· n/a</span>}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? <Empty>No products match.</Empty> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: selList.length ? 84 : 8 }}>
          {filtered.map(p => {
            const expanded = openId === p.id;
            const selCount = p.sizes.filter(s => sel[keyOf(p.id, s)]).length;
            return (
              <div key={p.id} style={{ ...GLASS, padding: 0, overflow: "hidden" }}>
                <div onClick={() => setOpenId(expanded ? null : p.id)} style={{ display: "flex", alignItems: "center", gap: 11, padding: 11, cursor: "pointer" }}>
                  <Thumb product={p} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: GRAY }}>{p.sizes.length} size{p.sizes.length === 1 ? "" : "s"}</div>
                  </div>
                  {selCount > 0 && <span style={{ background: "rgba(74,222,128,.16)", color: GREEN, border: "1px solid rgba(74,222,128,.4)", borderRadius: 20, padding: "2px 9px", fontSize: 12, fontWeight: 700 }}>{selCount}</span>}
                  <span style={{ color: BLUE_L, transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
                </div>
                {expanded && (
                  <div style={{ padding: "0 11px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8 }}>
                    {p.sizes.map(s => {
                      const k = keyOf(p.id, s); const picked = !!sel[k]; const oh = onHand(p.id, s);
                      return (
                        <div key={s} style={{ background: CARD, border: picked ? "1px solid rgba(74,222,128,.5)" : BORDER, borderRadius: 10, padding: "7px 8px" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                            <input type="checkbox" checked={picked} onChange={() => toggle(p, s)} />
                            <span style={{ fontSize: 12, color: BLUE_L, fontWeight: 700 }}>{s}</span>
                          </label>
                          <div style={{ fontSize: 9, color: GRAY, margin: "3px 0", textAlign: "center" }}>on hand {oh}</div>
                          {picked && (
                            <input type="number" inputMode="numeric" min="0" value={sel[k].count}
                              onChange={e => setCount(k, e.target.value)} placeholder="copies"
                              style={{ ...input, width: "100%", boxSizing: "border-box", textAlign: "center", padding: "5px 3px", fontSize: "0.8rem" }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selList.length > 0 && (
        <div style={{ position: "fixed", left: 12, right: 12, bottom: 14, zIndex: 40, ...GLASS, padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{selList.length} size{selList.length > 1 ? "s" : ""} selected</div>
            <div style={{ fontSize: 11, color: GRAY }}>copies default to on-hand</div>
          </div>
          <button onClick={() => setSel({})} style={{ ...bGhost, padding: "8px 12px", fontSize: 12 }}>Clear</button>
          <button onClick={doPrint} disabled={busy} style={{ ...bGreen, padding: "10px 18px", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Printing…" : "Print barcodes"}
          </button>
        </div>
      )}
      </div>
      <Toast msg={toast} />
    </div>
  );
}
