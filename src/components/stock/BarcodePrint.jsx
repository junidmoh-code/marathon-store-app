// ─── BARCODE PRINT ────────────────────────────────────────────────────────────
// Inline print sheet opened after a Set Qty save. On open it ENSURES a barcode for
// each saved size (reserve-if-missing / reuse-if-present via barcodeStore — this is
// "generated the first time it's needed"), previews each Code 128, and prints. Per-
// size copy count defaults to the units just ADDED in that save (the positive
// delta — the new physical items needing labels) and is overridable. Printing is
// optional and isolated: if no printer is reachable the codes are still reserved,
// stored and indexed, and the on-screen barcodes can be scanned directly.

import React, { useState, useEffect } from "react";
import { ensureBarcodes } from "./barcodeStore";
import Barcode from "./BarcodeView";
import { TRANSPORTS, printLabels, defaultTransportId, isTransportUsable, isWindowsPlatform } from "./printers";
import { Toast } from "./widgets";
import { GLASS_SOLID, bGreen, bGhost, GRAY, GREEN, AMBER, BLUE_L, input } from "./ui";

export default function BarcodePrint({ product, items, onClose }) {
  // items: [{ size, added }] — the sizes just saved, and units added per size.
  const [codes, setCodes] = useState(null);     // { size: { code, reused } } | null
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(() => Object.fromEntries(items.map(it => [it.size, true])));
  const [counts, setCounts] = useState(() => Object.fromEntries(items.map(it => [it.size, String(Math.max(0, it.added || 0))])));
  const [transport, setTransport] = useState(defaultTransportId);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3800); };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await ensureBarcodes(product.id, items.map(it => it.size));
        if (alive) setCodes(res);
      } catch (e) {
        if (alive) setErr(String(e?.message || e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const doPrint = async () => {
    if (!codes) return;
    const toPrint = items
      .filter(it => sel[it.size])
      .map(it => ({ code: codes[it.size]?.code, productName: product.name, size: it.size, count: parseInt(counts[it.size], 10) || 0 }))
      .filter(it => it.code && it.count > 0);
    if (!toPrint.length) return flash("err", "Select at least one size with a count above 0.");
    setBusy(true);
    const res = await printLabels({ items: toPrint, transport });
    setBusy(false);
    if (res.ok) flash("ok", `Sent ${res.printed} label(s) to ${TRANSPORTS.find(t => t.id === transport)?.label}.`);
    else flash("err", `Print failed: ${res.error} — codes are saved; you can retry or scan on screen.`);
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
         onClick={() => !busy && onClose()}>
      <div onClick={e => e.stopPropagation()} style={{ ...GLASS_SOLID, width: "100%", maxWidth: 560, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 16, maxHeight: "86vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Print barcodes — {product.name}</div>
          <button onClick={() => !busy && onClose()} style={{ background: "none", border: "none", color: GRAY, fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ fontSize: 11, color: GRAY, marginBottom: 12 }}>
          One permanent barcode per size (reused on every reprint). Count defaults to the units you just added.
        </div>

        {/* Transport */}
        <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>Printer</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {TRANSPORTS.map(t => {
            const usable = isTransportUsable(t.id);
            const blockedOnWindows = t.id === "xprinter" && isWindowsPlatform();
            const on = transport === t.id;
            return (
              <button key={t.id} onClick={() => usable && setTransport(t.id)} disabled={!usable}
                style={{ padding: "8px 12px", borderRadius: 10, cursor: usable ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600,
                         background: on ? "rgba(60,110,255,.2)" : "rgba(255,255,255,.04)",
                         border: on ? "1px solid rgba(60,110,255,.6)" : "1px solid rgba(60,110,255,.15)",
                         color: usable ? (on ? "#fff" : GRAY) : "rgba(255,255,255,.25)" }}>
                {t.label}{!t.proven && <span style={{ color: AMBER, marginLeft: 6 }}>· untested</span>}
                {blockedOnWindows ? <span style={{ color: GRAY, marginLeft: 6 }}>· use System printer</span>
                  : (!usable && <span style={{ color: GRAY, marginLeft: 6 }}>· n/a</span>)}
              </button>
            );
          })}
        </div>

        {/* Per-size rows */}
        {err && <div style={{ color: "#F87171", fontSize: 12.5, padding: "10px 0" }}>Could not reserve barcodes: {err}</div>}
        {!err && !codes && <div style={{ color: GRAY, fontSize: 12.5, padding: "16px 0", textAlign: "center" }}>Reserving barcodes…</div>}
        {!err && codes && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map(it => {
              const entry = codes[it.size];
              const checked = !!sel[it.size];
              return (
                <div key={it.size} style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(255,255,255,.03)", border: "1px solid rgba(60,110,255,.15)", borderRadius: 10, padding: 10 }}>
                  <input type="checkbox" checked={checked} onChange={e => setSel(s => ({ ...s, [it.size]: e.target.checked }))} style={{ width: 18, height: 18 }} />
                  <div style={{ minWidth: 44 }}>
                    <div style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}>{it.size}</div>
                    <div style={{ color: GRAY, fontSize: 10 }}>+{Math.max(0, it.added || 0)} added</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, opacity: checked ? 1 : 0.4 }}>
                    {entry?.code ? <Barcode value={entry.code} height={42} moduleWidth={1.6} /> : <span style={{ color: "#F87171", fontSize: 11 }}>no code</span>}
                    {entry?.reused && <div style={{ color: BLUE_L, fontSize: 9, marginTop: 2 }}>existing code (reused)</div>}
                  </div>
                  <div style={{ width: 64 }}>
                    <div style={{ fontSize: 9, color: GRAY, marginBottom: 2, textAlign: "center" }}>copies</div>
                    <input type="number" inputMode="numeric" min="0" value={counts[it.size]} disabled={!checked}
                      onChange={e => setCounts(c => ({ ...c, [it.size]: e.target.value }))}
                      style={{ ...input, width: "100%", boxSizing: "border-box", textAlign: "center", padding: "7px 4px" }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={() => !busy && onClose()} style={{ ...bGhost, flex: 1 }}>Done</button>
          <button onClick={doPrint} disabled={busy || !codes} style={{ ...bGreen, flex: 2, opacity: (busy || !codes) ? 0.5 : 1 }}>
            {busy ? "Printing…" : "Print selected"}
          </button>
        </div>
        <div style={{ fontSize: 10, color: GRAY, marginTop: 10 }}>
          Codes are reserved &amp; saved as soon as this opens — printing is optional. If a printer fails, the on-screen
          barcode above is scannable and reprinting reuses the same code. {TRANSPORTS.some(t => !t.proven) && <span style={{ color: AMBER }}>USB (Xprinter) is untested until hardware is available.</span>}
        </div>
      </div>
      <Toast msg={toast} />
    </div>
  );
}
