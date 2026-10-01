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

import React, { useState, useMemo, useEffect } from "react";
import { ref, set } from "firebase/database";
import { database } from "../../firebase";
import { useStockCells, useLocations } from "./useStock";
import { transferTargets, labelFor } from "./locations";
import FilterPicker from "./FilterPicker";
import { ensureBarcode, getBarcode } from "./barcodeStore";
import { code128Modules } from "./barcode";
import { TRANSPORTS, printLabels, printTest, connectTransport, getXprinterDiag, defaultTransportId } from "./printers";
import { Toast, Empty } from "./widgets";
import { GLASS, CARD, GRAY, GREEN, BLUE_L, AMBER, BORDER, FONT, BG, bGreen, bGhost, input } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { isDeactivated } from "../../utils/deactivation";
import { formatSize } from "../../utils/sizeLabel";
import { SizeTag } from "../SizeTag";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";

const keyOf = (pid, size) => `${pid}|${size}`;

// Laptop breakpoint — switches Barcodes into the centered workspace layout.
function useWide(px = 1024) {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(`(min-width:${px}px)`).matches);
  useEffect(() => {
    const m = window.matchMedia(`(min-width:${px}px)`);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [px]);
  return wide;
}

// Product thumbnail — same pattern as Transfer/Locator (product.photoUrl). Tap to open full.
function Thumb({ product, size = 40, onOpen }) {
  const url = product?.photoUrl;
  if (url) return <img src={url} alt="" onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(); } : undefined}
    style={{ width: size, height: size, objectFit: "cover", borderRadius: 9, flexShrink: 0, cursor: onOpen ? "zoom-in" : "default" }}
    onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 9, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>👟</div>;
}

export default function BarcodeCatalog({ products, canMint, onExit }) {
  const wide = useWide();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState(null);
  const [sel, setSel] = useState({});   // { "pid|size": { productId, productName, size, count } }
  const [transport, setTransport] = useState(defaultTransportId);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [diagText, setDiagText] = useState(null);   // persistent printer diagnostic (manual dismiss)
  const [lightbox, setLightbox] = useState(null);   // full-screen product photo url
  const [loc, setLoc] = useState("all");            // location filter — "see what's here"
  const [cat, setCat] = useState("all");            // category filter
  const [lastKey, setLastKey] = useState(null);     // last-touched size → live label preview
  const [previewCode, setPreviewCode] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!lastKey) { setPreviewCode(null); return; }
    const i = lastKey.indexOf("|");
    const pid = lastKey.slice(0, i), size = lastKey.slice(i + 1);
    getBarcode(pid, size).then(c => alive && setPreviewCode(c || null)).catch(() => alive && setPreviewCode(null));
    return () => { alive = false; };
  }, [lastKey]);
  const cells = useStockCells();        // { loc: { pid: { size: cell } } } — all locations
  const registry = useLocations();
  const locations = useMemo(() => transferTargets(registry), [registry]);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3400); };

  // Diagnostic test print: connect (inside this tap's gesture) and send a canvas-free
  // pattern (solid + stripes). If THIS prints but real labels don't, the issue is the
  // label content; if it also fails, it's protocol/BLE delivery. The result line is
  // shown in a PERSISTENT box so it can be read/screenshotted (service/char/props/bytes).
  const doTest = async () => {
    setBusy(true); setDiagText("Connecting…");
    let conn;
    try { conn = await connectTransport(transport); }
    catch (e) { setBusy(false); return setDiagText(`Connect failed: ${String(e?.message || e)}`); }
    const res = await printTest({ transport, conn });
    setBusy(false);
    setDiagText(`${res.ok ? "Test sent ✓" : "Test FAILED ✗"} — ${res.diag || res.error || "no info"}`);
    // Write the full GATT dump to RTDB so it can be read server-side (the operator
    // doesn't have to transcribe anything). Best-effort — never blocks the UI.
    try {
      await set(ref(database, "printer_diag/latest"), {
        at: serverNowIso(),
        ok: !!res.ok,
        diag: res.diag || null,
        error: res.error || null,
        dump: res.dump || null,
      });
    } catch (e) { /* diagnostic only */ }
  };

  // On-hand for a product+size. When a location is picked, show THAT location's qty
  // ("see what's there"); otherwise the total summed across every location.
  const onHand = (pid, size) => {
    if (loc !== "all") { const c = cells?.[loc]?.[pid]?.[size]; return c && typeof c.qty === "number" ? c.qty : 0; }
    let n = 0;
    for (const l of Object.keys(cells || {})) { const c = cells[l]?.[pid]?.[size]; if (c && typeof c.qty === "number") n += c.qty; }
    return n;
  };
  // Total at the picked location (for the "only what's here" filter).
  const locTotal = (pid) => Object.values(cells?.[loc]?.[pid] || {}).reduce((s, c) => s + (typeof c?.qty === "number" ? c.qty : 0), 0);

  // Category chips — data-driven from the sized catalogue.
  const categories = useMemo(() => {
    const set = new Set();
    for (const p of products || []) if (p?.category && Array.isArray(p.sizes) && p.sizes.length) set.add(String(p.category));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [products]);

  // Forgiving search (fuzzy name + barcode/sku/per-size codes; code hits first).
  // Empty query lists products NEWEST-FIRST — a product id is "p" + serverNowMs()
  // at creation (App.jsx), so the id encodes the upload time; just-added
  // products sit at the top ready to select and print, instead of being buried
  // alphabetically. Ties/legacy ids fall back to name order. Location +
  // category pre-filter both; a typed search keeps its relevance ranking.
  const createdMs = (p) => { const m = /^p(\d{13})$/.exec(p?.id || ""); return m ? Number(m[1]) : 0; };
  const filtered = useMemo(() => {
    // A DEACTIVATED product is off every staff list (owner spec 2026-09-05,
    // BUG 1). Barcodes is open to EVERY signed-in staff member — not the
    // stockRole-gated admin section — so a retired line must not be printable
    // or findable here. It stays in full in the Stock section, where its cells
    // are adjusted and its history read, and one tap in Leftovers puts it back.
    const predicate = (p) =>
      !isDeactivated(p) &&
      Array.isArray(p.sizes) && p.sizes.length &&
      (cat === "all" || p.category === cat) &&
      (loc === "all" || (cells?.[loc]?.[p.id] && locTotal(p.id) > 0));
    if (!search.trim()) {
      return [...(products || [])]
        .filter(p => p && p.id && p.name && predicate(p))
        .sort((a, b) => (createdMs(b) - createdMs(a)) || a.name.localeCompare(b.name));
    }
    return searchProducts(products, search, { limit: 500, predicate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, search, cat, loc, cells]);

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
    // Best-effort: persist the Xprinter's USB identity (VID/PID + iface/endpoints) to
    // RTDB so it can be read server-side — captured pre-claim, so even a claim failure
    // records it. Shown on screen too. Only for the Xprinter transport.
    const recordXprinterDiag = async (error) => {
      if (transport !== "xprinter") return;
      const d = getXprinterDiag();
      if (d) setDiagText(`XP-350B ${d.vendorId}/${d.productId}${error ? ` — ${error}` : ""}`);
      try { await set(ref(database, "printer_diag/xprinter"), { ...(d || {}), error: error || null }); }
      catch { /* diagnostic only */ }
    };
    let conn;
    try { conn = await connectTransport(transport); }
    catch (e) {
      setBusy(false);
      await recordXprinterDiag(String(e?.message || e));
      return flash("err", `Couldn't connect to the printer: ${String(e?.message || e)}`);
    }
    await recordXprinterDiag(null);
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

  // ── DESKTOP BARCODE STUDIO (≥1024px) — sidebar (filters + printer) · product
  //    grid · live print tray with a real Code128 label preview. Mobile below. ──
  if (wide) {
    const totalCopies = selList.reduce((s, [, it]) => s + (parseInt(it.count, 10) || 0), 0);
    const lastItem = lastKey ? sel[lastKey] : null;
    const lastP = lastItem ? products.find(p => p.id === lastItem.productId) : null;
    const catCol = (c) => /cloth|apparel|tee|hood|shirt|pant|jacket/i.test(c || "")
      ? { fg: "#C59BFF", bg: "rgba(138,109,255,.16)", tint: "rgba(138,109,255,.10)", bd: "rgba(138,109,255,.3)" }
      : { fg: "#7FA6FF", bg: "rgba(74,127,255,.16)", tint: "rgba(74,127,255,.10)", bd: "rgba(74,127,255,.3)" };
    const ohColor = (n) => n === 0 ? "#FF7A7A" : n <= 2 ? "#F5A623" : "#5FD08A";
    const selStyle = { width: "100%", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 10, color: "rgba(233,238,255,.75)", fontSize: 12.5, fontWeight: 600, padding: "10px 11px", cursor: "pointer", fontFamily: FONT, marginBottom: 6 };
    return (
      <div style={{ height: "100vh", background: "#000", color: "#f3f6ff", fontFamily: FONT, display: "grid", gridTemplateColumns: "224px minmax(0,1fr) 340px", overflow: "hidden" }}>
        <style>{`
          .bcs-card{transition:border-color .18s,box-shadow .18s}
          .bcs-card:hover{border-color:rgba(74,127,255,.4)}
          .bcs-scroll::-webkit-scrollbar,.bcs-side::-webkit-scrollbar,.bcs-tray::-webkit-scrollbar{width:9px}
          .bcs-scroll::-webkit-scrollbar-thumb,.bcs-side::-webkit-scrollbar-thumb,.bcs-tray::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:8px;border:2px solid transparent;background-clip:content-box}
          .bcs-stp button:hover{background:rgba(74,127,255,.2)}
        `}</style>

        {/* SIDEBAR */}
        <aside className="bcs-side" style={{ background: "rgba(255,255,255,.015)", borderRight: "1px solid rgba(255,255,255,.08)", padding: "22px 14px 16px", display: "flex", flexDirection: "column", gap: 5, overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 8px 8px" }}>
            <span style={{ fontSize: 19, fontWeight: 800, fontStyle: "italic", letterSpacing: -.6 }}>marathon</span>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 5, color: "#4A7FFF" }}>CLUB</span>
          </div>
          <button onClick={onExit} style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", color: "rgba(233,238,255,.6)", borderRadius: 10, padding: "9px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: FONT, marginBottom: 8 }}>← Home</button>

          <div style={{ fontSize: 9.5, letterSpacing: ".2em", textTransform: "uppercase", color: "rgba(233,238,255,.3)", padding: "10px 8px 7px", fontWeight: 700 }}>Location</div>
          <select value={loc} onChange={e => setLoc(e.target.value)} style={selStyle}>
            <option value="all">All locations</option>
            {locations.map(l => <option key={l.id} value={l.id}>{labelFor(l.id, registry)}</option>)}
          </select>
          {categories.length > 1 && <>
            <div style={{ fontSize: 9.5, letterSpacing: ".2em", textTransform: "uppercase", color: "rgba(233,238,255,.3)", padding: "10px 8px 7px", fontWeight: 700 }}>Category</div>
            <select value={cat} onChange={e => setCat(e.target.value)} style={selStyle}>
              <option value="all">All</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </>}

          <div style={{ fontSize: 9.5, letterSpacing: ".2em", textTransform: "uppercase", color: "rgba(233,238,255,.3)", padding: "12px 8px 7px", fontWeight: 700 }}>Printer</div>
          {TRANSPORTS.map(t => {
            const supported = t.supported(); const on = transport === t.id;
            const cleanLabel = t.label.replace(/\s*\((?:bluetooth|usb|ble)\)\s*$/i, "");
            return (
              <button key={t.id} onClick={() => supported && setTransport(t.id)} disabled={!supported}
                style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", cursor: supported ? "pointer" : "not-allowed", fontFamily: FONT, fontSize: 12.5, fontWeight: 600, borderRadius: 10, padding: "9px 11px",
                         background: on ? "rgba(74,127,255,.12)" : "transparent", border: on ? "1px solid rgba(74,127,255,.4)" : "1px solid transparent",
                         color: supported ? (on ? "#9DBCFF" : "rgba(233,238,255,.55)") : "rgba(255,255,255,.25)", opacity: supported ? 1 : .6 }}>
                <span style={{ flex: 1 }}>{cleanLabel}</span>
                {on && <span title="Selected printer" style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: "#4ADE80", boxShadow: "0 0 8px #4ADE80" }} />}
              </button>
            );
          })}
          {diagText && (
            <div style={{ marginTop: 8, padding: "9px 10px", borderRadius: 9, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", fontSize: 10.5, color: "#fff", wordBreak: "break-word", fontFamily: "monospace", display: "flex", gap: 6 }}>
              <span style={{ flex: 1 }}>{diagText}</span>
              <button onClick={() => setDiagText(null)} style={{ background: "none", border: "none", color: GRAY, cursor: "pointer", padding: 0 }}>✕</button>
            </div>
          )}
          <div style={{ flex: 1 }} />
          <div style={{ marginTop: 8, padding: 13, borderRadius: 13, background: "linear-gradient(160deg,rgba(74,127,255,.12),rgba(10,12,22,.3))", border: "1px solid rgba(74,127,255,.3)" }}>
            <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{totalCopies}</div>
            <div style={{ fontSize: 11, color: "rgba(233,238,255,.55)", marginTop: 3 }}>label{totalCopies !== 1 ? "s" : ""} queued · {selList.length} size{selList.length !== 1 ? "s" : ""}</div>
          </div>
        </aside>

        {/* MAIN */}
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "20px 26px 14px", borderBottom: "1px solid rgba(255,255,255,.08)", background: "radial-gradient(800px 280px at 15% -60%, rgba(74,127,255,.08), transparent)" }}>
            <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: -.4 }}>Barcode Studio</div>
            <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.55)", marginTop: 3 }}>{canMint ? "Pick sizes, set copies, and print — the label preview updates live." : "Re-print existing labels — new codes are created by warehouse/admin."}</div>
            <div style={{ marginTop: 15, position: "relative" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", opacity: .4 }}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…"
                style={{ width: "100%", background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 12, color: "#fff", fontSize: 13.5, padding: "11px 14px 11px 38px", outline: "none", fontFamily: FONT }} />
            </div>
          </div>
          <div className="bcs-scroll" style={{ flex: 1, overflow: "auto", padding: "16px 26px 40px" }}>
            <div style={{ fontSize: 11, color: "rgba(233,238,255,.3)", margin: "0 2px 12px" }}>{filtered.length} product{filtered.length !== 1 ? "s" : ""}</div>
            {filtered.length === 0 ? <Empty>No products match.</Empty> : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(288px, 1fr))", gap: 12, alignItems: "start" }}>
                {filtered.map(p => {
                  const expanded = openId === p.id;
                  const selCount = p.sizes.filter(s => sel[keyOf(p.id, s)]).length;
                  const cc = catCol(p.category);
                  return (
                    <div key={p.id} className="bcs-card" style={{ background: "rgba(255,255,255,.022)", border: `1px solid ${selCount ? "rgba(74,222,128,.4)" : "rgba(255,255,255,.08)"}`, borderRadius: 15, overflow: "hidden", boxShadow: expanded ? `inset 3px 0 0 ${cc.bd}` : "none" }}>
                      <div onClick={() => setOpenId(expanded ? null : p.id)} style={{ display: "flex", alignItems: "center", gap: 11, padding: 11, cursor: "pointer" }}>
                        <div style={{ position: "relative", flexShrink: 0 }}>
                          <Thumb product={p} onOpen={p.photoUrl ? () => setLightbox(p.photoUrl) : undefined} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 650, color: "#fff", display: "flex", alignItems: "center", gap: 7 }}>
                            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                            {p.category && <span style={{ flexShrink: 0, fontSize: 8.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 999, color: cc.fg, background: cc.bg }}>{p.category}</span>}
                          </div>
                          <div style={{ fontSize: 11, color: "rgba(233,238,255,.3)", marginTop: 2 }}>{p.sizes.length} size{p.sizes.length === 1 ? "" : "s"}{typeof p.retailPrice === "number" && p.retailPrice > 0 ? ` · R${p.retailPrice.toLocaleString("en-ZA")}` : ""}</div>
                        </div>
                        {selCount > 0 && <span style={{ background: "rgba(74,222,128,.16)", color: "#5FD08A", border: "1px solid rgba(74,222,128,.4)", borderRadius: 999, padding: "2px 9px", fontSize: 11.5, fontWeight: 800 }}>{selCount}</span>}
                        <span style={{ color: BLUE_L, transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
                      </div>
                      {expanded && (
                        <div style={{ padding: "0 11px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))", gap: 8 }}>
                          {p.sizes.map(s => {
                            const k = keyOf(p.id, s); const picked = !!sel[k]; const oh = onHand(p.id, s);
                            const cur = picked ? (parseInt(sel[k].count, 10) || 0) : 0;
                            return (
                              <div key={s} style={{ background: picked ? "rgba(74,222,128,.06)" : "rgba(255,255,255,.02)", border: picked ? "1px solid rgba(74,222,128,.5)" : "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: 8 }}>
                                <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                                  <input type="checkbox" checked={picked} onChange={() => { toggle(p, s); setLastKey(k); }} style={{ accentColor: "#4A7FFF", width: 15, height: 15 }} />
                                  <span style={{ fontSize: 12.5, color: BLUE_L, fontWeight: 700 }}><SizeTag size={s} /></span>
                                </label>
                                <div style={{ fontSize: 9, textAlign: "center", margin: "5px 0" }}>on hand <span style={{ color: ohColor(oh), fontWeight: 700 }}>{oh}</span></div>
                                {picked && (
                                  <div className="bcs-stp" style={{ display: "flex", alignItems: "center", border: "1px solid rgba(255,255,255,.14)", borderRadius: 8, overflow: "hidden" }}>
                                    <button onClick={() => { setCount(k, String(Math.max(0, cur - 1))); setLastKey(k); }} style={{ flex: "0 0 24px", height: 28, border: 0, background: "rgba(255,255,255,.04)", color: "#fff", cursor: "pointer", fontSize: 14 }}>−</button>
                                    <input type="number" inputMode="numeric" min="0" value={sel[k].count} onChange={e => { setCount(k, e.target.value); setLastKey(k); }}
                                      style={{ flex: 1, minWidth: 0, width: "100%", height: 28, textAlign: "center", border: 0, background: "rgba(0,0,0,.3)", color: "#fff", fontSize: 12.5, fontWeight: 700, outline: "none", fontFamily: FONT }} />
                                    <button onClick={() => { setCount(k, String(cur + 1)); setLastKey(k); }} style={{ flex: "0 0 24px", height: 28, border: 0, background: "rgba(255,255,255,.04)", color: "#fff", cursor: "pointer", fontSize: 14 }}>+</button>
                                  </div>
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
          </div>
        </div>

        {/* PRINT TRAY */}
        <aside className="bcs-tray" style={{ background: "rgba(255,255,255,.015)", borderLeft: "1px solid rgba(255,255,255,.08)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "18px 16px 13px", borderBottom: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", gap: 9 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Print tray</h2>
            <span style={{ fontSize: 11, fontWeight: 800, background: "rgba(74,127,255,.2)", color: "#9DBCFF", borderRadius: 999, padding: "2px 9px", fontVariantNumeric: "tabular-nums" }}>{selList.length}</span>
            {selList.length > 0 && <button onClick={() => { setSel({}); setLastKey(null); }} style={{ marginLeft: "auto", background: "transparent", border: 0, color: "rgba(233,238,255,.3)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>Clear</button>}
          </div>
          {/* Live label preview */}
          <div style={{ padding: "16px 16px 6px" }}>
            <div style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: "rgba(233,238,255,.3)", marginBottom: 9, fontWeight: 700 }}>Label preview</div>
            {lastP && lastItem ? (
              <div style={{ background: "#f7f7f2", color: "#0a0a0a", borderRadius: 8, padding: "12px 14px 10px", boxShadow: "0 12px 30px -12px rgba(0,0,0,.6)", fontFamily: "'SF Mono', ui-monospace, monospace" }}>
                <div style={{ fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: -.2 }}>{lastP.name}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 2 }}>
                  <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: -.5 }}>{formatSize(lastItem.size)}</span>
                  {typeof lastP.retailPrice === "number" && lastP.retailPrice > 0 && <span style={{ fontSize: 14, fontWeight: 800 }}>R{lastP.retailPrice.toLocaleString("en-ZA")}</span>}
                </div>
                {previewCode ? <>
                  <div style={{ display: "flex", alignItems: "stretch", height: 44, marginTop: 9 }}>
                    {code128Modules(previewCode).map((m, i) => <span key={i} style={{ width: m.width * 1.5, background: m.bar ? "#0a0a0a" : "transparent" }} />)}
                  </div>
                  <div style={{ textAlign: "center", fontSize: 10, letterSpacing: 3, marginTop: 3, fontWeight: 700 }}>{previewCode}</div>
                </> : (
                  <div style={{ fontSize: 10.5, color: "#666", textAlign: "center", padding: "16px 0 8px" }}>{canMint ? "Barcode assigned when you print." : "No code yet — a warehouse/admin must create it."}</div>
                )}
              </div>
            ) : (
              <div style={{ color: "rgba(233,238,255,.3)", fontSize: 12, textAlign: "center", padding: "28px 10px" }}>Select a size to preview its label.</div>
            )}
          </div>
          <div className="bcs-tray" style={{ flex: 1, overflow: "auto", padding: "8px 14px" }}>
            {selList.length === 0 ? (
              <div style={{ color: "rgba(233,238,255,.3)", fontSize: 12, textAlign: "center", padding: 20 }}>Tray is empty.</div>
            ) : selList.map(([k, it]) => {
              const p = products.find(x => x.id === it.productId); const cc = catCol(p?.category);
              return (
                <div key={k} onClick={() => setLastKey(k)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderTop: "1px solid rgba(255,255,255,.06)", cursor: "pointer" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: cc.fg }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.productName}</div>
                    <div style={{ fontSize: 10.5, color: "rgba(233,238,255,.4)" }}>Size {formatSize(it.size)} · ×{it.count}</div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); toggle({ id: it.productId }, it.size); if (lastKey === k) setLastKey(null); }} style={{ background: "transparent", border: 0, color: "rgba(233,238,255,.3)", cursor: "pointer", fontSize: 13 }}>✕</button>
                </div>
              );
            })}
          </div>
          <div style={{ borderTop: "1px solid rgba(255,255,255,.08)", padding: "15px 16px" }}>
            {(() => {
              const off = busy || !totalCopies;
              return (
                <button onClick={doPrint} disabled={off}
                  style={{ width: "100%", padding: 14, borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: off ? "not-allowed" : "pointer",
                           display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                           border: off ? "1px solid rgba(74,127,255,.3)" : "0",
                           background: off ? "rgba(74,127,255,.1)" : "linear-gradient(90deg,#6e7bff,#7f5af0)",
                           color: off ? "rgba(157,188,255,.85)" : "#04120a",
                           boxShadow: off ? "none" : "0 10px 26px -8px rgba(127,90,240,.7)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                  {busy ? "Printing…" : `Print ${totalCopies} label${totalCopies !== 1 ? "s" : ""}`}
                </button>
              );
            })()}
          </div>
        </aside>

        {lightbox && (
          <div onClick={() => setLightbox(null)} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out" }}>
            <img src={lightbox} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 10 }} />
          </div>
        )}
        <Toast msg={toast} />
      </div>
    );
  }

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

      <FilterPicker label="Location" value={loc} onChange={setLoc}
        options={[{ id: "all", label: "All locations" }, ...locations.map(l => ({ id: l.id, label: labelFor(l.id, registry) }))]} />
      {categories.length > 1 && (
        <FilterPicker label="Category" value={cat} onChange={setCat}
          options={[{ id: "all", label: "All" }, ...categories.map(c => ({ id: c, label: c }))]} />
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {TRANSPORTS.map(t => {
          const supported = t.supported(); const on = transport === t.id;
          return (
            <button key={t.id} onClick={() => supported && setTransport(t.id)} disabled={!supported}
              style={{ padding: "7px 11px", borderRadius: 9, cursor: supported ? "pointer" : "not-allowed", fontSize: 11.5, fontWeight: 600,
                       background: on ? "rgba(60,110,255,.2)" : "rgba(255,255,255,.04)", border: on ? "1px solid rgba(60,110,255,.6)" : BORDER,
                       color: supported ? (on ? "#fff" : GRAY) : "rgba(255,255,255,.25)" }}>
              {t.label}{!supported && <span style={{ color: GRAY, marginLeft: 5 }}>· n/a</span>}
            </button>
          );
        })}
        {transport === "phomemo" && (
          <button onClick={doTest} disabled={busy}
            style={{ padding: "7px 11px", borderRadius: 9, cursor: busy ? "default" : "pointer", fontSize: 11.5, fontWeight: 600,
                     background: "rgba(245,158,11,.14)", border: "1px solid rgba(245,158,11,.4)", color: AMBER }}>
            🔧 Test print
          </button>
        )}
      </div>

      {diagText && (
        <div style={{ marginBottom: 12, padding: "9px 11px", borderRadius: 9, background: "rgba(255,255,255,.06)", border: BORDER,
                      fontSize: 11, color: "#fff", wordBreak: "break-word", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ flex: 1, fontFamily: "monospace" }}>{diagText}</span>
          <button onClick={() => setDiagText(null)} style={{ background: "none", border: "none", color: GRAY, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>✕</button>
        </div>
      )}

      {filtered.length === 0 ? <Empty>No products match.</Empty> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: selList.length ? 84 : 8 }}>
          {filtered.map(p => {
            const expanded = openId === p.id;
            const selCount = p.sizes.filter(s => sel[keyOf(p.id, s)]).length;
            return (
              <div key={p.id} style={{ ...GLASS, padding: 0, overflow: "hidden" }}>
                <div onClick={() => setOpenId(expanded ? null : p.id)} style={{ display: "flex", alignItems: "center", gap: 11, padding: 11, cursor: "pointer" }}>
                  <Thumb product={p} onOpen={p.photoUrl ? () => setLightbox(p.photoUrl) : undefined} />
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
                            <span style={{ fontSize: 12, color: BLUE_L, fontWeight: 700 }}><SizeTag size={s} /></span>
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
      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out" }}>
          <img src={lightbox} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 10 }} />
        </div>
      )}
      <Toast msg={toast} />
    </div>
  );
}
