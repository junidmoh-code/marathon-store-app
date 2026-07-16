// ============================================================================
// INITIAL DISTRIBUTION WIZARD
//
// Appears after every receiving event into Central (new product, existing
// product, clothing, shoes) and automates the transfers warehouse staff used
// to create by hand: Central → Marathon PE / Trophy / Pine / Hub 1 / Hub 2.
//
// Three layers, deliberately separated:
//   1. SUGGESTION  — distributionSuggest.js proposes quantities (V1: the
//      standard tables, nothing smarter). The wizard derives its destination
//      list from the suggestion output, so a smarter engine (per-product
//      destination sets included) drops in without touching this file.
//   2. OPERATOR    — this component: destination pills, per-size steppers,
//      live "remaining at Central", over-allocation block. The operator's
//      numbers are final.
//   3. TRANSFER    — the existing applyMovement engine, one `transfer_out`
//      per line, byte-for-byte the manual Transfer idiom: deterministic
//      movementIds via transferMovementId (retry-safe), a shared
//      link.transferId batch, ledger reason "initial_distribution".
//
// RESUMABLE, like an unfinished manual transfer: the confirmed batch is
// persisted to localStorage (transferDraft idiom, single slot) BEFORE the
// first write and re-saved after every line, so a refresh / crash / network
// drop / accidental close can never lose unfinished work. Reopening the
// wizard for the same product offers Resume (same batchId → same
// movementIds → already-landed lines are recognised as idempotent, never
// re-applied) or Discard. The draft clears ONLY when every line of the
// batch has completed successfully.
//
// Preload policy (owner-visible): the standard tables are dealt against
// Central's pool in destination order (PE → Trophy → Pine → Hub 1 → Hub 2),
// so on a short receipt the shops win the limited pool before the hub
// buffers. Purely fit-to-availability — never destination-stock-aware (V1
// owner decision: consistency over intelligence).
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { ref, onValue, push, child } from "firebase/database";
import { database } from "../../firebase";
import { decodeSizeKey } from "../../utils/sizeKey";
import { applyMovement } from "./applyMovement";
import { transferMovementId } from "./transferDraft";
import { suggestInitialDistribution, DEST_LABELS } from "./distributionSuggest";
import { GLASS_SOLID, BLUE_L, GREEN, RED, GRAY, FONT } from "./ui";
import { SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { usePermissions } from "../PermissionsContext";

const bBtn = (bg, color = "#fff") => ({
  background: bg, color, border: "none", borderRadius: 10, padding: "0.65rem 1.2rem",
  fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
});

// ---- persisted batch draft (transferDraft idiom, single slot) --------------
const DRAFT_KEY = "initial_distribution_draft_v1";
const DRAFT_SCHEMA = 1;
function loadDistDraft(productId) {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (d && d.schema === DRAFT_SCHEMA && d.productId === productId &&
        d.batchId && Array.isArray(d.pending) && d.pending.length) return d;
  } catch { /* corrupt draft = no draft */ }
  return null;
}
function saveDistDraft(draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ schema: DRAFT_SCHEMA, ...draft })); } catch { /* full/blocked storage: resume degrades, transfers stay idempotent */ }
}
function clearDistDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

export default function InitialDistributionWizard({ product, onClose }) {
  // Same actorRole resolution as every transfer-capable module (NoTargetQueue
  // et al.) — never trusted by the rules (they read the signed-in user's own
  // stockRole node), purely the ledger's audit stamp.
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);

  // An unfinished batch for THIS product resumes instead of restarting.
  const [draft] = useState(() => loadDistDraft(product.id));
  const [step, setStep] = useState(draft ? "resume" : "ask"); // resume|ask → edit → done
  const [central, setCentral] = useState(null);        // { size: qty } live, decoded
  const [dests, setDests] = useState([]);               // destination list, from the suggestion output
  const [alloc, setAlloc] = useState({});               // { dest: { size: qty } } operator numbers
  const [locsOn, setLocsOn] = useState({});             // { dest: bool }
  const [clamped, setClamped] = useState(false);        // preload reduced to fit Central
  const [busy, setBusy] = useState(false);
  const [batchId, setBatchId] = useState(draft?.batchId || null); // minted lazily at first confirm
  const [result, setResult] = useState(null);           // { moved, failed:[{dest,size,qty,reason}] }
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

  // Preload: the standard tables, dealt against Central's pool (policy in the
  // header comment). Destination list comes from the suggestion output.
  const start = () => {
    const { suggestions } = suggestInitialDistribution({ product });
    const destList = Object.keys(suggestions);
    const pool = {};
    for (const s of sizes) pool[s] = central?.[s] ?? 0;
    const nextAlloc = {}; const nextOn = {}; let didClamp = false;
    for (const dest of destList) {
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
    setDests(destList); setAlloc(nextAlloc); setLocsOn(nextOn); setClamped(didClamp); setStep("edit");
  };

  // Remaining at Central per size = on-hand minus everything allocated to
  // enabled destinations. Negative → over-allocated → Confirm blocked.
  const remaining = useMemo(() => {
    const out = {};
    for (const s of sizes) {
      let allocated = 0;
      for (const dest of dests) {
        if (locsOn[dest]) allocated += alloc[dest]?.[s] || 0;
      }
      out[s] = (central?.[s] ?? 0) - allocated;
    }
    return out;
  }, [sizes, dests, alloc, locsOn, central]);
  const overAllocated = sizes.filter((s) => remaining[s] < 0);

  const enabledLines = useMemo(() => {
    const lines = [];
    for (const dest of dests) {
      if (!locsOn[dest]) continue;
      for (const s of sizes) {
        const qty = alloc[dest]?.[s] || 0;
        if (qty > 0) lines.push({ dest, size: s, qty });
      }
    }
    return lines;
  }, [alloc, locsOn, dests, sizes]);

  const setQty = (dest, size, qty) =>
    setAlloc((a) => ({ ...a, [dest]: { ...a[dest], [size]: Math.max(0, qty) } }));

  // ---- transfer layer handoff: the operator's final lines, nothing else ----
  // The draft is written BEFORE the first movement and re-saved after every
  // line, so at any instant it holds exactly the lines not yet confirmed
  // landed. It clears ONLY when nothing is pending.
  const runTransfers = async (lines, movedBase = 0) => {
    if (busy) return;
    setBusy(true);
    const batch = batchId || push(child(ref(database), "transfers")).key;
    setBatchId(batch);
    let moved = movedBase; const failed = [];
    let pending = lines.slice();
    saveDistDraft({ productId: product.id, productName: product.name, batchId: batch, moved, pending });
    for (const { dest, size, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: product.id, size, qty,
          from: "central", to: dest, actorRole,
          reason: "initial_distribution",
          movementId: transferMovementId(batch, product.id, size, dest),
          link: { transferId: batch },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      pending = pending.filter((l) => !(l.dest === dest && l.size === size));
      if (res.ok) moved += qty;
      else {
        const line = { dest, size, qty, reason: res.reason === "insufficient_stock" ? `only ${res.available} at Central` : res.reason };
        failed.push(line);
        pending = [...pending, { dest, size, qty }];
      }
      if (pending.length) saveDistDraft({ productId: product.id, productName: product.name, batchId: batch, moved, pending });
      else clearDistDraft();
    }
    setBusy(false);
    setResult({ moved, failed });
    setStep("done");
  };

  // Failed lines stay editable before a retry (an insufficient-stock line can
  // be lowered instead of failing forever). qty 0 drops the line — and the
  // draft — for that cell.
  const setFailedQty = (idx, qty) => {
    setResult((r) => {
      const failedNext = r.failed.map((f, i) => (i === idx ? { ...f, qty: Math.max(0, qty) } : f));
      const pending = failedNext.filter((f) => f.qty > 0).map(({ dest, size, qty: q }) => ({ dest, size, qty: q }));
      if (pending.length) saveDistDraft({ productId: product.id, productName: product.name, batchId, moved: r.moved, pending });
      else clearDistDraft();
      return { ...r, failed: failedNext };
    });
  };

  const destTotals = dests
    .map((dest) => ({ dest, units: locsOn[dest] ? sizes.reduce((n, s) => n + (alloc[dest]?.[s] || 0), 0) : 0 }))
    .filter((d) => d.units > 0);
  const totalUnits = destTotals.reduce((n, d) => n + d.units, 0);
  const centralLeft = sizes.reduce((n, s) => n + Math.max(0, remaining[s]), 0);

  const pill = (on) => ({
    border: on ? "1px solid rgba(74,127,255,.65)" : "1px solid rgba(255,255,255,.14)",
    background: on ? "rgba(60,110,255,.18)" : "rgba(255,255,255,.04)",
    color: on ? "#fff" : GRAY, borderRadius: 999, padding: "6px 12px",
    fontSize: 12, fontWeight: 700, cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.6 : 1, fontFamily: FONT,
  });

  const retryLines = result ? result.failed.filter((f) => f.qty > 0).map(({ dest, size, qty }) => ({ dest, size, qty })) : [];

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

        {step === "resume" && (
          <div style={{ padding: "10px 2px 6px" }}>
            <div style={{ fontSize: 13.5, color: "#FBBF24", fontWeight: 700, marginBottom: 6 }}>Unfinished distribution found</div>
            <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 6 }}>
              {draft.pending.length} line{draft.pending.length === 1 ? "" : "s"} · {draft.pending.reduce((n, l) => n + l.qty, 0)} units were not confirmed sent
              {draft.moved > 0 ? <> ({draft.moved} units already landed and will never be re-sent)</> : null}.
            </div>
            <div style={{ fontSize: 12, color: GRAY, marginBottom: 14 }}>
              {draft.pending.map((l, i) => (
                <div key={i}>{DEST_LABELS[l.dest] || l.dest} · size {l.size} × {l.qty}</div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              {/* Discard abandons the PENDING lines (already-landed lines are in
                  the ledger regardless) and drops the batchId so a fresh run
                  can never collide with the discarded batch's movementIds. */}
              <button onClick={() => { clearDistDraft(); setBatchId(null); setStep("ask"); }} style={bBtn("rgba(255,255,255,.08)", GRAY)}>Discard Distribution</button>
              <button disabled={busy} onClick={() => runTransfers(draft.pending, draft.moved || 0)}
                      style={{ ...bBtn("#4A7FFF"), opacity: busy ? 0.5 : 1 }}>
                {busy ? "Resuming…" : "Resume Distribution"}
              </button>
            </div>
          </div>
        )}

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
              {dests.map((dest) => (
                <button key={dest} style={pill(!!locsOn[dest])} disabled={busy}
                        onClick={() => !busy && setLocsOn((l) => ({ ...l, [dest]: !l[dest] }))}>
                  {locsOn[dest] ? "✓ " : ""}{DEST_LABELS[dest] || dest}
                </button>
              ))}
            </div>

            {/* Per-destination steppers */}
            {dests.filter((d) => locsOn[d]).map((dest) => (
              <div key={dest} style={{ margin: "12px 0" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: BLUE_L, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                  {DEST_LABELS[dest] || dest} · {sizes.reduce((n, s) => n + (alloc[dest]?.[s] || 0), 0)} units
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
                ? <>Sending {totalUnits} units — {destTotals.map((d) => `${DEST_LABELS[d.dest] || d.dest} ${d.units}`).join(" · ")}. {centralLeft} stay at Central.</>
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
                <div style={{ fontSize: 12, color: GRAY, marginBottom: 4 }}>
                  Failed lines are kept safe — closing now saves them, and this product offers Resume next time. Lower a quantity (or set it to 0 to drop the line) and retry:
                </div>
                <div style={{ marginBottom: 10 }}>
                  {result.failed.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.05)" }}>
                      <div style={{ flex: 1, fontSize: 12.5, color: "#fff" }}>
                        {DEST_LABELS[f.dest] || f.dest} · size {f.size}
                        <span style={{ color: RED, marginLeft: 8, fontSize: 11.5 }}>{f.reason}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <button disabled={busy} onClick={() => setFailedQty(i, f.qty - 1)}
                                style={{ width: 24, height: 24, borderRadius: 8, border: "1px solid rgba(60,110,255,.3)", background: "rgba(60,110,255,.08)", color: BLUE_L, fontWeight: 800, cursor: "pointer" }}>−</button>
                        <span style={{ minWidth: 20, textAlign: "center", fontSize: 13.5, fontWeight: 800, color: f.qty > 0 ? "#fff" : GRAY }}>{f.qty}</span>
                        <button disabled={busy} onClick={() => setFailedQty(i, f.qty + 1)}
                                style={{ width: 24, height: 24, borderRadius: 8, border: "1px solid rgba(60,110,255,.3)", background: "rgba(60,110,255,.08)", color: BLUE_L, fontWeight: 800, cursor: "pointer" }}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button disabled={busy} onClick={() => !busy && onClose()} style={{ ...bBtn("rgba(255,255,255,.08)", GRAY), opacity: busy ? 0.5 : 1 }}>Close (keep for later)</button>
                  <button disabled={busy || retryLines.length === 0} onClick={() => runTransfers(retryLines, result.moved)}
                          style={{ ...bBtn("#4A7FFF"), opacity: busy || retryLines.length === 0 ? 0.5 : 1 }}>
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
