// ============================================================================
// INITIAL DISTRIBUTION WIZARD
//
// Appears after every receiving event into Central (new product, existing
// product, clothing, shoes) and automates the transfers warehouse staff used
// to create by hand: Central → Marathon PE / Trophy / Pine / Hub 1 / Hub 2.
//
// Three layers, deliberately separated:
//   1. SUGGESTION  — distributionSuggest.js proposes quantities (V1: the
//      standard tables, nothing smarter). Swappable without touching 2 or 3.
//   2. OPERATOR    — this component: destination pills, per-size steppers,
//      live "remaining at Central", over-allocation block. The operator's
//      numbers are final.
//   3. TRANSFER    — the existing applyMovement engine, one `transfer_out`
//      per line, byte-for-byte the manual Transfer idiom: deterministic
//      movementIds (retry-safe), a shared link.transferId batch, ledger
//      reason "initial_distribution". No new transfer logic, no new paths.
//
// Skip is always safe: nothing is written until Confirm. Failed lines are
// listed and retryable in place — retries reuse the same movementIds, so a
// line that actually landed is never applied twice.
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { ref, onValue, push, child } from "firebase/database";
import { database } from "../../firebase";
import { decodeSizeKey, stockSizeKey } from "../../utils/sizeKey";
import { applyMovement } from "./applyMovement";
import { suggestInitialDistribution, DISTRIBUTION_DESTS, DEST_LABELS } from "./distributionSuggest";
import { GLASS_SOLID, BLUE_L, GREEN, RED, GRAY, FONT } from "./ui";
import { SizeStepperChip, CHIP_GRID } from "./healthWidgets";

const bBtn = (bg, color = "#fff") => ({
  background: bg, color, border: "none", borderRadius: 10, padding: "0.65rem 1.2rem",
  fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
});

export default function InitialDistributionWizard({ product, onClose, actorRole }) {
  const [step, setStep] = useState("ask");            // ask → edit → done
  const [central, setCentral] = useState(null);        // { size: qty } live, decoded
  const [alloc, setAlloc] = useState({});              // { dest: { size: qty } } operator numbers
  const [locsOn, setLocsOn] = useState({});            // { dest: bool }
  const [clamped, setClamped] = useState(false);       // preload reduced to fit Central
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);          // { moved, failed:[{dest,size,qty,reason}] }
  const sizes = Array.isArray(product?.sizes) && product.sizes.length ? product.sizes : [];

  // Live Central on-hand for this one product — a single-node subscription,
  // same source of truth as Locator/SetQuantity (never a /stock-wide read).
  useEffect(() => {
    const unsub = onValue(ref(database, `stock/central/${product.id}`), (snap) => {
      const out = {};
      for (const [k, cell] of Object.entries(snap.val() || {})) {
        out[decodeSizeKey(k)] = Math.max(0, Number(cell?.qty) || 0);
      }
      setCentral(out);
    }, () => setCentral({}));
    return unsub;
  }, [product.id]);

  // Preload: the standard tables, dealt against Central's pool in destination
  // order so the initial screen is never in an impossible over-allocated
  // state on a partial shipment. Purely a fit-to-availability clamp — NOT a
  // smart suggestion (V1 owner decision: consistency over intelligence).
  const start = () => {
    const { suggestions } = suggestInitialDistribution({ product });
    const pool = {};
    for (const s of sizes) pool[s] = central?.[s] ?? 0;
    const nextAlloc = {}; const nextOn = {}; let didClamp = false;
    for (const dest of DISTRIBUTION_DESTS) {
      const lines = {}; let suggestedAny = false;
      for (const s of sizes) {
        const want = suggestions[dest]?.[s] ?? 0;
        if (want > 0) suggestedAny = true;
        const give = Math.min(want, pool[s]);
        if (give < want) didClamp = true;
        lines[s] = give;
        pool[s] -= give;
      }
      nextAlloc[dest] = lines;
      nextOn[dest] = suggestedAny; // shoes: hubs on, shops off (still selectable)
    }
    setAlloc(nextAlloc); setLocsOn(nextOn); setClamped(didClamp); setStep("edit");
  };

  // Remaining at Central per size = on-hand minus everything allocated to
  // enabled destinations. Negative → over-allocated → Confirm blocked.
  const remaining = useMemo(() => {
    const out = {};
    for (const s of sizes) {
      let allocated = 0;
      for (const dest of DISTRIBUTION_DESTS) {
        if (locsOn[dest]) allocated += alloc[dest]?.[s] || 0;
      }
      out[s] = (central?.[s] ?? 0) - allocated;
    }
    return out;
  }, [sizes, alloc, locsOn, central]);
  const overAllocated = sizes.filter((s) => remaining[s] < 0);

  const enabledLines = useMemo(() => {
    const lines = [];
    for (const dest of DISTRIBUTION_DESTS) {
      if (!locsOn[dest]) continue;
      for (const s of sizes) {
        const qty = alloc[dest]?.[s] || 0;
        if (qty > 0) lines.push({ dest, size: s, qty });
      }
    }
    return lines;
  }, [alloc, locsOn, sizes]);

  const setQty = (dest, size, qty) =>
    setAlloc((a) => ({ ...a, [dest]: { ...a[dest], [size]: Math.max(0, qty) } }));

  // ---- transfer layer handoff: the operator's final lines, nothing else ----
  const [batchId] = useState(() => push(child(ref(database), "transfers")).key);
  const runTransfers = async (lines) => {
    setBusy(true);
    let moved = result?.moved || 0; const failed = [];
    for (const { dest, size, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: product.id, size, qty,
          from: "central", to: dest, actorRole,
          reason: "initial_distribution",
          movementId: `${batchId}:${dest}:${product.id}:${stockSizeKey(size)}`,
          link: { transferId: batchId },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += qty;
      else failed.push({ dest, size, qty, reason: res.reason === "insufficient_stock" ? `only ${res.available} at Central` : res.reason });
    }
    setBusy(false);
    setResult({ moved, failed });
    setStep("done");
  };

  const destTotals = DISTRIBUTION_DESTS
    .map((dest) => ({ dest, units: locsOn[dest] ? sizes.reduce((n, s) => n + (alloc[dest]?.[s] || 0), 0) : 0 }))
    .filter((d) => d.units > 0);
  const totalUnits = destTotals.reduce((n, d) => n + d.units, 0);
  const centralLeft = sizes.reduce((n, s) => n + Math.max(0, remaining[s]), 0);

  const pill = (on) => ({
    border: on ? "1px solid rgba(74,127,255,.65)" : "1px solid rgba(255,255,255,.14)",
    background: on ? "rgba(60,110,255,.18)" : "rgba(255,255,255,.04)",
    color: on ? "#fff" : GRAY, borderRadius: 999, padding: "6px 12px",
    fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
         onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()}
           style={{ ...GLASS_SOLID, width: "100%", maxWidth: 560, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 16, maxHeight: "88vh", overflowY: "auto" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          {product.photoUrl
            ? <img src={product.photoUrl} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }}
                   style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
            : <div style={{ width: 40, height: 40, borderRadius: 8, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>📦</div>}
          <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            Initial distribution — {product.name}
          </div>
          <button onClick={() => !busy && onClose()} style={{ background: "none", border: "none", color: GRAY, fontSize: 18, cursor: "pointer", flexShrink: 0 }}>✕</button>
        </div>

        {step === "ask" && (
          <div style={{ padding: "10px 2px 6px" }}>
            <div style={{ fontSize: 13.5, color: "#fff", marginBottom: 6 }}>This product has been received successfully.</div>
            <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 16 }}>Would you like to distribute it now? Skip keeps everything at Central — nothing is created.</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={bBtn("rgba(255,255,255,.08)", GRAY)}>Skip for Now</button>
              <button onClick={start} disabled={central == null}
                      style={{ ...bBtn("#4A7FFF"), opacity: central == null ? 0.5 : 1 }}>Start Distribution</button>
            </div>
          </div>
        )}

        {step === "edit" && (
          <div>
            {clamped && (
              <div style={{ fontSize: 11.5, color: "#FBBF24", margin: "6px 0 2px" }}>
                Central holds less than the standard run — some quantities were reduced to fit. Adjust freely.
              </div>
            )}
            {/* Destination pills */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0 4px" }}>
              {DISTRIBUTION_DESTS.map((dest) => (
                <button key={dest} style={pill(!!locsOn[dest])}
                        onClick={() => setLocsOn((l) => ({ ...l, [dest]: !l[dest] }))}>
                  {locsOn[dest] ? "✓ " : ""}{DEST_LABELS[dest]}
                </button>
              ))}
            </div>

            {/* Per-destination steppers */}
            {DISTRIBUTION_DESTS.filter((d) => locsOn[d]).map((dest) => (
              <div key={dest} style={{ margin: "12px 0" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: BLUE_L, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                  {DEST_LABELS[dest]} · {sizes.reduce((n, s) => n + (alloc[dest]?.[s] || 0), 0)} units
                </div>
                <div style={CHIP_GRID}>
                  {sizes.map((s) => (
                    <SizeStepperChip key={s} size={s} qty={alloc[dest]?.[s] || 0}
                      max={(alloc[dest]?.[s] || 0) + Math.max(0, remaining[s])}
                      onChange={(q) => setQty(dest, s, q)} disabled={busy} />
                  ))}
                </div>
              </div>
            ))}

            {/* Live remaining at Central */}
            <div style={{ margin: "14px 0 6px", padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(255,255,255,.09)", background: "rgba(255,255,255,.03)" }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, color: GRAY, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Remaining at Central</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {sizes.map((s) => (
                  <span key={s} style={{ fontSize: 12, fontWeight: 700, borderRadius: 8, padding: "4px 9px",
                    color: remaining[s] < 0 ? "#fff" : remaining[s] === 0 ? GRAY : GREEN,
                    background: remaining[s] < 0 ? "rgba(220,60,60,.35)" : "rgba(255,255,255,.05)" }}>
                    {s}: {remaining[s]}
                  </span>
                ))}
              </div>
              {overAllocated.length > 0 && (
                <div style={{ fontSize: 11.5, color: RED, marginTop: 8 }}>
                  More allocated than Central holds for size{overAllocated.length > 1 ? "s" : ""} {overAllocated.join(", ")} — reduce before confirming.
                </div>
              )}
            </div>

            {/* Summary + confirm */}
            <div style={{ fontSize: 12.5, color: GRAY, margin: "8px 0" }}>
              {destTotals.length
                ? <>Sending {totalUnits} units — {destTotals.map((d) => `${DEST_LABELS[d.dest]} ${d.units}`).join(" · ")}. {centralLeft} stay at Central.</>
                : "Nothing allocated yet — everything stays at Central."}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 10 }}>
              <button onClick={() => !busy && onClose()} style={bBtn("rgba(255,255,255,.08)", GRAY)}>Cancel</button>
              <button disabled={busy || overAllocated.length > 0 || enabledLines.length === 0}
                      onClick={() => runTransfers(enabledLines)}
                      style={{ ...bBtn("#22B36B"), opacity: busy || overAllocated.length > 0 || enabledLines.length === 0 ? 0.45 : 1 }}>
                {busy ? "Creating transfers…" : `Create ${enabledLines.length} transfer line${enabledLines.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}

        {step === "done" && result && (
          <div style={{ padding: "10px 2px 6px" }}>
            <div style={{ fontSize: 13.5, color: result.failed.length ? "#FBBF24" : GREEN, fontWeight: 700, marginBottom: 8 }}>
              {result.moved} units distributed{result.failed.length ? ` — ${result.failed.length} line(s) failed` : " — done"}
            </div>
            {result.failed.length > 0 && (
              <>
                <div style={{ fontSize: 12, color: GRAY, marginBottom: 8 }}>
                  {result.failed.map((f, i) => (
                    <div key={i}>{DEST_LABELS[f.dest]} · size {f.size} × {f.qty} — {f.reason}</div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button onClick={onClose} style={bBtn("rgba(255,255,255,.08)", GRAY)}>Close</button>
                  <button disabled={busy} onClick={() => runTransfers(result.failed)}
                          style={{ ...bBtn("#4A7FFF"), opacity: busy ? 0.5 : 1 }}>
                    {busy ? "Retrying…" : "Retry failed lines"}
                  </button>
                </div>
              </>
            )}
            {result.failed.length === 0 && (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button onClick={onClose} style={bBtn("#4A7FFF")}>Done</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
