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
import { TRANSPORTS, printLabels, printTest, connectTransport, getXprinterDiag, defaultTransportId } from "./printers";
import { Toast, Empty } from "./widgets";
import { GLASS, CARD, GRAY, GREEN, BLUE_L, AMBER, BORDER, FONT, BG, bGreen, bGhost, input } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { formatSize } from "../../utils/sizeLabel";
import { SizeTag } from "../SizeTag";

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
        at: new Date().toISOString(),
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
  // Empty query lists products NEWEST-FIRST — a product id is "p" + Date.now()
  // at creation (App.jsx), so the id encodes the upload time; just-added
  // products sit at the top ready to select and print, instead of being buried
  // alphabetically. Ties/legacy ids fall back to name order. Location +
  // category pre-filter both; a typed search keeps its relevance ranking.
  const createdMs = (p) => { const m = /^p(\d{13})$/.exec(p?.id || ""); return m ? Number(m[1]) : 0; };
  const filtered = useMemo(() => {
    const predicate = (p) =>
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

  return (
    <div style={{ minHeight: "100vh", background: wide ? "#000" : BG, color: "#fff", fontFamily: FONT, position: "relative" }}>
      {wide && <>
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "radial-gradient(1100px 520px at 84% -12%, rgba(60,110,255,.10), transparent 58%), radial-gradient(900px 500px at 4% 0%, rgba(127,90,240,.08), transparent 52%)" }} />
        <style>{`
          .bc-card{transition:transform .18s cubic-bezier(.2,.7,.2,1),border-color .18s,box-shadow .18s}
          .bc-card:hover{transform:translateY(-3px);border-color:rgba(74,127,255,.45);box-shadow:0 16px 34px -22px rgba(60,110,255,.55)}
          @media(prefers-reduced-motion:reduce){.bc-card{transition:none}}
        `}</style>
      </>}

      {wide ? (
        <div style={{ position: "relative", maxWidth: 1080, margin: "0 auto", padding: "26px 30px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
            <button onClick={onExit} style={{ display: "flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(233,238,255,.7)", borderRadius: 10, padding: "8px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: FONT }}>← Home</button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 19, fontWeight: 800, fontStyle: "italic", letterSpacing: -.5 }}>marathon</span>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 5, color: "#4A7FFF" }}>CLUB</span>
          </div>
          <div style={{ fontSize: 25, fontWeight: 800, letterSpacing: -.5 }}>Barcodes</div>
          <div style={{ fontSize: 13, color: "rgba(233,238,255,.5)", marginTop: 4 }}>
            {canMint ? "Browse the catalogue, pick sizes, and batch-print labels." : "Re-print existing labels — new barcodes are created by warehouse/admin."}
          </div>
        </div>
      ) : (
        <div style={{ padding: "14px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={onExit} style={{ background: "none", border: "none", padding: 0, color: BLUE_L, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FONT }}>← Home</button>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Barcodes</div>
          <div style={{ minWidth: 48 }} />
        </div>
      )}

      <div style={{ position: "relative", maxWidth: wide ? 1080 : "none", margin: "0 auto", padding: wide ? "16px 30px 60px" : "4px 14px 40px", boxSizing: "border-box" }}>
      {!canMint && !wide && <div style={{ fontSize: 11, color: GRAY, marginBottom: 8 }}>Re-print existing labels — new barcodes are created by warehouse/admin.</div>}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…"
        style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />

      {/* Location + Category — collapsible cards; pick a location to see only what's
          there (per-size on-hand reflects that location). Default "All". */}
      <FilterPicker label="Location" value={loc} onChange={setLoc}
        options={[{ id: "all", label: "All locations" }, ...locations.map(l => ({ id: l.id, label: labelFor(l.id, registry) }))]} />
      {categories.length > 1 && (
        <FilterPicker label="Category" value={cat} onChange={setCat}
          options={[{ id: "all", label: "All" }, ...categories.map(c => ({ id: c, label: c }))]} />
      )}

      {/* Transport */}
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

      {/* Persistent printer diagnostic — read this back if printing misbehaves. */}
      {diagText && (
        <div style={{ marginBottom: 12, padding: "9px 11px", borderRadius: 9, background: "rgba(255,255,255,.06)", border: BORDER,
                      fontSize: 11, color: "#fff", wordBreak: "break-word", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ flex: 1, fontFamily: "monospace" }}>{diagText}</span>
          <button onClick={() => setDiagText(null)} style={{ background: "none", border: "none", color: GRAY, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>✕</button>
        </div>
      )}

      {filtered.length === 0 ? <Empty>No products match.</Empty> : (
        <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(auto-fill, minmax(320px, 1fr))" : "1fr", gap: wide ? 12 : 8, alignItems: "start", paddingBottom: selList.length ? 88 : 8 }}>
          {filtered.map(p => {
            const expanded = openId === p.id;
            const selCount = p.sizes.filter(s => sel[keyOf(p.id, s)]).length;
            return (
              <div key={p.id} className="bc-card" style={{ ...GLASS, padding: 0, overflow: "hidden" }}>
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
        <div style={{ position: "fixed", bottom: wide ? 20 : 14, zIndex: 40, ...GLASS, padding: 10, display: "flex", alignItems: "center", gap: 10,
                      left: wide ? "50%" : 12, right: wide ? "auto" : 12, transform: wide ? "translateX(-50%)" : "none", width: wide ? "min(640px, calc(100% - 60px))" : "auto",
                      boxShadow: wide ? "0 18px 44px -16px rgba(0,0,0,.7)" : undefined }}>
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
      {/* Full-screen product photo — tap anywhere to close. */}
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
