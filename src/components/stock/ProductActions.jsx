// ─── ACT WHERE I SEE THE PRODUCT ─────────────────────────────────────────────
// (Owner spec 2026-08-31, BUILD 4.)
//
//   "I should never have to hunt through tabs for a product I am looking at."
//
// So every product card an admin can see carries the two actions that matter
// when a duplicate is in front of them: DEACTIVATE / REACTIVATE, and MERGE INTO
// ANOTHER. Both reuse what already exists — hubCleanupStore's deactivate /
// reactivate writers (one atomic multi-path update, payload owned by
// utils/deactivation.js) and the existing MergeProducts overlay, opened with
// this product already loaded as the loser. NOTHING new is written here.
//
// THREE RULES THIS FILE ENFORCES, all from the owner's spec:
//
//  1. DEACTIVATION WORKS REGARDLESS OF STOCK. "A phantom 1 unit is not a reason
//     to keep a dead product alive." The button is never disabled by a
//     quantity, and the flag write never touches a cell.
//
//  2. IF IT STILL HOLDS STOCK, THE CARD SAYS SO — per location, after the fact,
//     from a per-product read (stock/{loc}/{pid}) so this never costs a
//     whole-node read of /stock.
//
//  3. ZEROING THOSE CELLS IS A SEPARATE, DELIBERATE ACTION. Never silent, never
//     folded into the deactivate tap: its own button, its own confirm naming
//     the exact units, and every cell goes through applyMovement as a negative
//     `adjustment` carrying a reason — one movement per cell, in the ledger,
//     reversible by the same route as any other adjustment.
//
// Admin-gated (stockRole admin or super-admin) — the same gate the Leftovers
// tab's deactivate action uses.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { get, ref } from "firebase/database";
import { database } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { useLocations } from "./useStock";
import { labelFor, allLocationIds } from "./locations";
import { deactivateProduct, reactivateProduct, loadAllStock } from "./hubCleanupStore";
import { applyMovement } from "./applyMovement";
import { isDeactivated, deactivationLine } from "../../utils/deactivation";
import { decodeSizeKey } from "../../utils/sizeKey";
import { formatSize } from "../../utils/sizeLabel";
import MergeProducts from "./MergeProducts.jsx";
import { GLASS_SOLID, GRAY, GREEN, RED, AMBER, BLUE_L, BORDER, FONT, bGreen, bRed, bGray, bBlue } from "./ui";

/** Is this viewer allowed to retire products? Same gate as the Leftovers tab. */
export function useCanRetireProducts() {
  const { permRecord, isSuperAdmin } = usePermissions();
  return isSuperAdmin || permRecord?.stockRole === "admin";
}

/** The chip every surface prints on a deactivated product. One look, one word. */
export function DeactivatedChip({ small = false }) {
  return (
    <span style={{
      marginLeft: 6, fontSize: small ? 10 : 11, fontWeight: 800, letterSpacing: ".06em",
      padding: small ? "2px 6px" : "2px 7px", borderRadius: 6,
      background: "rgba(150,160,190,.18)", border: "1px solid rgba(150,160,190,.4)",
      color: "#B9C0D4", verticalAlign: "middle", whiteSpace: "nowrap",
    }}>DEACTIVATED</span>
  );
}

/**
 * The "⋯" affordance that opens the sheet. Renders NOTHING for a non-admin, so
 * a card can drop it in unconditionally.
 */
export function ProductActionsButton({ product, products, onChanged, style }) {
  const canRetire = useCanRetireProducts();
  const [open, setOpen] = useState(false);
  if (!canRetire || !product || !product.id) return null;
  return (
    <>
      <button
        aria-label={`Actions for ${product.name}`}
        title="Deactivate, reactivate or merge this product"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        style={{
          width: 30, height: 30, borderRadius: 8, cursor: "pointer", padding: 0,
          border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.55)",
          color: "#fff", fontSize: 16, fontWeight: 800, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center", ...style,
        }}>⋯</button>
      {open && (
        <ProductActionSheet product={product} products={products}
                            onChanged={onChanged} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// A stopPropagation wrapper: these sheets open from cards whose own onClick adds
// the product to a cart. Every click inside must die here.
const swallow = (e) => e.stopPropagation();

export function ProductActionSheet({ product, products = [], onChanged, onClose }) {
  const canRetire = useCanRetireProducts();
  const registry = useLocations();
  const [held, setHeld] = useState(null);         // null = still reading
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);         // { tone, text }
  const [confirmZero, setConfirmZero] = useState(false);
  const [merge, setMerge] = useState(false);
  const [mergeStock, setMergeStock] = useState(null);

  const deactivated = isDeactivated(product);
  // A STABLE location list. useLocations() hands back a fresh object on every
  // fire, so memoising on `registry` itself would make `locs` — and therefore
  // the read effect below — new on every render, and the effect would re-read
  // forever. Key on the DIGEST of the ids, exactly as SeatingTab does.
  const locSig = allLocationIds(registry).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const locs = useMemo(() => locSig.split("|").filter(Boolean), [locSig]);

  // PER-PRODUCT reads, one per location — never a whole-node read of /stock.
  const readHeld = useCallback(async () => {
    if (!product?.id || !locs.length) return;
    const rows = await Promise.all(locs.map(async (loc) => {
      const snap = await get(ref(database, `stock/${loc}/${product.id}`)).catch(() => null);
      const cells = (snap && snap.exists() && snap.val()) || null;
      if (!cells) return null;
      const sizes = Object.entries(cells)
        .filter(([k, c]) => k !== "_meta" && c && typeof c === "object" && typeof c.qty === "number" && c.qty > 0)
        .map(([sizeKey, c]) => ({ sizeKey, qty: c.qty }));
      if (!sizes.length) return null;
      return { loc, sizes, qty: sizes.reduce((t, s) => t + s.qty, 0) };
    }));
    setHeld(rows.filter(Boolean).sort((a, b) => b.qty - a.qty));
  }, [product?.id, locs]);

  useEffect(() => { readHeld().catch(() => setHeld([])); }, [readHeld]);

  const totalHeld = (held || []).reduce((t, r) => t + r.qty, 0);

  const doToggle = async () => {
    if (busy || !canRetire) return;
    setBusy(true);
    setNote(null);
    const res = deactivated ? await reactivateProduct(product.id) : await deactivateProduct(product.id);
    setBusy(false);
    if (!res.ok) { setNote({ tone: "err", text: `Could not save: ${res.reason}` }); return; }
    setNote({
      tone: "ok",
      text: deactivated
        ? "Reactivated — it is orderable again."
        : totalHeld > 0
          ? `Deactivated. It still holds ${totalHeld} unit${totalHeld === 1 ? "" : "s"} — zero them below if that is right.`
          : "Deactivated — it is off every ordering list.",
    });
    if (onChanged) onChanged();
  };

  // ZEROING — a SEPARATE deliberate act. One negative adjustment per cell,
  // through applyMovement, each carrying the reason. Never bundled with the
  // flag write, never automatic, and it reports partial failure honestly.
  const doZero = async () => {
    if (busy || !canRetire || !totalHeld) return;
    setBusy(true);
    setNote(null);
    const reason = "Deactivated finished line — cells zeroed deliberately";
    let done = 0;
    const failed = [];
    for (const row of held) {
      for (const cell of row.sizes) {
        const res = await applyMovement({
          type: "adjustment",
          productId: product.id,
          size: decodeSizeKey(cell.sizeKey),
          qty: cell.qty,
          from: row.loc,
          reason,
          actorRole: "admin",
          expect: { qty: cell.qty },   // refuse if the cell moved since we read it
        });
        if (res.ok) done += 1;
        else failed.push(`${labelFor(row.loc, registry)} ${formatSize(decodeSizeKey(cell.sizeKey))}: ${res.reason}`);
      }
    }
    setConfirmZero(false);
    await readHeld().catch(() => {});
    setBusy(false);
    setNote(failed.length
      ? { tone: "err", text: `Zeroed ${done} cell${done === 1 ? "" : "s"}; ${failed.length} refused — ${failed[0]}` }
      : { tone: "ok", text: `Zeroed ${done} cell${done === 1 ? "" : "s"} — every one is a movement in the ledger.` });
    if (onChanged) onChanged();
  };

  const openMerge = async () => {
    setBusy(true);
    // The merge screen wants the network stock picture; it asks for it itself
    // via onEnsureStock, but pre-loading here keeps its first paint complete.
    const loaded = await loadAllStock(locs).catch(() => null);
    setMergeStock(loaded);
    setBusy(false);
    setMerge(true);
  };

  if (merge) {
    return (
      <div onClick={swallow}>
        <MergeProducts initialLoser={product} products={products} allStock={mergeStock} registry={registry}
                       onEnsureStock={async () => {
                         const loaded = await loadAllStock(locs);
                         setMergeStock(loaded);
                         return loaded;
                       }}
                       onClose={() => { setMerge(false); onClose && onClose(); }}
                       onMerged={() => { setMerge(false); if (onChanged) onChanged(); onClose && onClose(); }} />
      </div>
    );
  }

  return (
    <div onClick={(e) => { swallow(e); onClose && onClose(); }}
         style={{ position: "fixed", inset: 0, zIndex: 1400, background: "rgba(0,0,0,.8)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FONT }}>
      <div onClick={swallow} style={{ ...GLASS_SOLID, width: "min(520px, 100%)", maxHeight: "86vh", overflowY: "auto", padding: 18 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
          {product.photoUrl
            ? <img src={product.photoUrl} alt="" style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} />
            : <div style={{ width: 60, height: 60, borderRadius: 10, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, flexShrink: 0 }}>👟</div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", lineHeight: 1.25 }}>
              {product.name}{deactivated && <DeactivatedChip />}
            </div>
            {deactivated && <div style={{ fontSize: 12, color: GRAY, marginTop: 3 }}>{deactivationLine(product)}</div>}
          </div>
          <button onClick={() => onClose && onClose()} style={{ ...bGray, padding: "6px 10px" }}>Close</button>
        </div>

        {/* WHAT IT STILL HOLDS — said plainly, never used to block the action. */}
        <div style={{ border: BORDER, borderRadius: 12, padding: 12, marginBottom: 14 }}>
          {held === null ? (
            <div style={{ fontSize: 12.5, color: GRAY }}>Checking what it holds…</div>
          ) : totalHeld === 0 ? (
            <div style={{ fontSize: 12.5, color: GRAY }}>Holds no stock anywhere.</div>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: AMBER, marginBottom: 6 }}>
                Still holds {totalHeld} unit{totalHeld === 1 ? "" : "s"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {held.map((r) => (
                  <span key={r.loc} style={{ fontSize: 11.5, fontWeight: 700, color: BLUE_L, background: "rgba(74,127,255,.1)", border: "1px solid rgba(74,127,255,.3)", borderRadius: 999, padding: "3px 9px" }}>
                    {labelFor(r.loc, registry)} {r.qty}
                    <span style={{ color: GRAY, fontWeight: 600 }}>
                      {" "}({r.sizes.map((s) => `${formatSize(decodeSizeKey(s.sizeKey))}×${s.qty}`).join(" ")})
                    </span>
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: GRAY, marginTop: 8, lineHeight: 1.45 }}>
                Stock does not block deactivation — a phantom unit is not a reason to keep a dead
                product alive. Zeroing these cells is a separate, deliberate action below.
              </div>
            </>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <button disabled={busy} onClick={doToggle}
                  style={{ ...(deactivated ? bGreen : bRed), padding: "13px 14px", fontSize: "0.95rem", opacity: busy ? 0.55 : 1 }}>
            {deactivated ? "Reactivate — put it back on the lists" : "Deactivate — retire this finished line"}
          </button>

          <button disabled={busy} onClick={openMerge}
                  style={{ ...bBlue, padding: "13px 14px", fontSize: "0.95rem", opacity: busy ? 0.55 : 1 }}>
            Merge into another product…
          </button>

          {totalHeld > 0 && (confirmZero ? (
            <div style={{ border: "1px solid rgba(248,113,113,.4)", borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 12.5, color: "#fff", marginBottom: 10, lineHeight: 1.5 }}>
                Zero <strong>{totalHeld}</strong> unit{totalHeld === 1 ? "" : "s"} across{" "}
                {held.length} location{held.length === 1 ? "" : "s"}? Each cell is written as a
                negative adjustment with a reason — it lands in the ledger and can be adjusted back.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={busy} onClick={doZero} style={{ ...bRed, flex: 1 }}>
                  {busy ? "Zeroing…" : "Yes, zero them"}
                </button>
                <button disabled={busy} onClick={() => setConfirmZero(false)} style={{ ...bGray, flex: 1 }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button disabled={busy} onClick={() => setConfirmZero(true)}
                    style={{ ...bGray, padding: "11px 14px", opacity: busy ? 0.55 : 1 }}>
              Zero its {totalHeld} remaining unit{totalHeld === 1 ? "" : "s"} (separate action)
            </button>
          ))}
        </div>

        {note && (
          <div style={{ marginTop: 12, fontSize: 12.5, fontWeight: 600, color: note.tone === "err" ? RED : GREEN }}>
            {note.text}
          </div>
        )}
      </div>
    </div>
  );
}
