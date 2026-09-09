// ─── DISPLAY REGISTRATION — ONE SCREEN, ONE QUESTION ────────────────────────
//
// (Owner, 2026-09-08.) This screen was four tabs in a row — Hub 1, Hub 2,
// Duplicate Displays, Unregistered Displays — and the owner's instruction was
// to remove all of it and leave the wall walk, because the wall walk already
// does what the hub tabs did and there are no duplicates to clean.
//
// WHAT THAT REMOVED, AND WHY EACH ONE WENT
//
//   HUB 1 / HUB 2 — a picker for which warehouse shelf to look at. That was
//     never a question about the WALL. A display is a shoe standing in Marathon
//     PE or Trophy; which shelf it came off is bookkeeping the screen can work
//     out for itself. Both gated hubs are now walked at once, and the hub a row
//     is booked at is the hub that actually holds the size the operator picked
//     (unregisteredAcrossHubs / hubForSize).
//
//   DUPLICATE DISPLAYS — a whole tab for a state that does not exist: measured
//     live on 2026-09-08, ZERO walls hold more than one open row. Its one real
//     job, closing the extras, is here instead: a shoe whose record shows more
//     than one size lists them and closes them one at a time. So nothing is
//     lost, and a tab that is empty every day it is opened is a tab that teaches
//     people not to open tabs.
//
//   THE LABEL SCANNER — removed on the owner's instruction. The search box is
//     the whole finder now.
//
//   THE BRAND FILTER — removed. Chips that narrow a list you are already
//     searching are furniture.
//
// WHAT IS LEFT: pick a wall, type a name, act. Two stores, one input, and the
// two answers the walk actually needs — it is on the wall, or it is not.
//
// ── ONE THING THIS NO LONGER DOES ───────────────────────────────────────────
// The old Hub 1 / Hub 2 tabs also edited the hub REGISTER
// (/settings/hubSneakerCount/register) — fix a size, remove a row. That record
// is not the display ledger and is not what this screen is about; the Stock
// console's Display Records tab is where register rows are reconciled. Named
// here because "the wall walk covers the hub tabs' job" is true of registering
// a display and not of editing the register.
//
// ── THE ABSOLUTE RULE IS UNTOUCHED ──────────────────────────────────────────
// Nothing here picks, guesses or pre-selects a size. Every size on the record
// comes from a human tapping it, and the picker opens with nothing chosen.
// Pinned by displaySizeNeverPreselected.test.js.

import React, { useMemo, useState } from "react";
import {
  unregisteredAcrossHubs, hubForSize, filterCandidates, registeredDisplays, rowSizeText,
} from "./displayRowCore";
import { registerDisplayRow, closeDisplayRow } from "./displayRowStore";
import { raiseDisplayRequest } from "./displayRequestStore";
import { useDisplayRowsState, useStockCellsState } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { GATED_SNEAKER_HUBS, isFootwearProduct } from "./availabilityCore";
import { isDeactivated } from "../../utils/deactivation";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { SizePicker, HistoryToggle } from "./displayRowUi";
import { FONT } from "./ui";

// The two walls. Pine's displays are booked at hub3, outside
// GATED_SNEAKER_HUBS, so Pine is deliberately not offered.
const STORES = ["marathon-pe", "trophy"];
const PAGE = 30;

// ── PALETTE ─────────────────────────────────────────────────────────────────
// No amber anywhere (owner: "no orange colour should be used"). One ink, one
// accent, three weights of grey — the restraint IS the design.
const INK = "#F5F6F8";
const DIM = "rgba(245,246,248,.52)";
const FAINT = "rgba(245,246,248,.34)";
const LINE = "1px solid rgba(255,255,255,.09)";
const ACCENT = "#4A7FFF";
const GOOD = "#4ADE80";
const BAD = "#F87171";
const SURFACE = "rgba(255,255,255,.035)";

const sheet = {
  page: { minHeight: "100vh", background: "#000", color: INK, fontFamily: FONT,
          padding: "22px 18px 72px", maxWidth: 640, margin: "0 auto",
          WebkitFontSmoothing: "antialiased", letterSpacing: "-0.01em" },
  h1: { fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", margin: 0 },
  sub: { fontSize: 13, color: DIM, marginTop: 4, lineHeight: 1.45 },
  seg: { display: "inline-flex", background: "rgba(255,255,255,.06)", borderRadius: 999,
         padding: 3, gap: 3, marginTop: 20 },
  segBtn: (on) => ({
    border: "none", cursor: "pointer", fontFamily: "inherit",
    padding: "8px 20px", borderRadius: 999, fontSize: 14, fontWeight: 600,
    letterSpacing: "-0.01em",
    background: on ? INK : "transparent",
    color: on ? "#0A0A0C" : DIM,
    transition: "background .15s ease, color .15s ease",
  }),
  search: { width: "100%", boxSizing: "border-box", marginTop: 18,
            padding: "14px 16px", borderRadius: 14, border: LINE,
            background: SURFACE, color: INK, fontSize: 16, fontFamily: "inherit",
            outline: "none", letterSpacing: "-0.01em" },
  card: { border: LINE, borderRadius: 16, padding: 14, marginTop: 10,
          background: SURFACE, display: "flex", gap: 13, alignItems: "flex-start" },
  name: { fontSize: 15, fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.3 },
  meta: { fontSize: 12.5, color: FAINT, marginTop: 3 },
  row: { display: "flex", gap: 8, marginTop: 11, flexWrap: "wrap" },
  btn: (tone) => ({
    border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
    padding: "9px 15px", borderRadius: 11, fontSize: 13.5, letterSpacing: "-0.01em",
    background: tone === "primary" ? ACCENT : "rgba(255,255,255,.07)",
    color: tone === "primary" ? "#fff" : INK,
  }),
  note: (tone) => ({ marginTop: 16, padding: "12px 14px", borderRadius: 12, fontSize: 13.5, lineHeight: 1.5,
                     background: tone === "err" ? "rgba(248,113,113,.10)" : "rgba(74,222,128,.10)",
                     color: tone === "err" ? BAD : GOOD }),
  empty: { textAlign: "center", color: FAINT, padding: "56px 12px", fontSize: 13.5, lineHeight: 1.6 },
  thumb: { width: 46, height: 58, objectFit: "cover", borderRadius: 9, flexShrink: 0,
           background: "rgba(255,255,255,.05)" },
  pill: { display: "inline-block", padding: "3px 9px", borderRadius: 999, fontSize: 11.5,
          fontWeight: 600, background: "rgba(255,255,255,.07)", color: DIM, marginRight: 6 },
};

export default function DisplayRegistrationView({ products = [], orders = [], ordersScope = null, onExit }) {
  const { permRecord, isSuperAdmin } = usePermissions();
  const isAdmin = isSuperAdmin || permRecord?.stockRole === "admin";

  const [store, setStore] = useState(() => (ordersScope && STORES.includes(ordersScope) ? ordersScope : STORES[0]));
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [acting, setActing] = useState(null);      // productId whose picker is open
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  const { value: rows, settled: rowsLoaded } = useDisplayRowsState(true);
  const hub1 = useStockCellsState(GATED_SNEAKER_HUBS[0]);
  const hub2 = useStockCellsState(GATED_SNEAKER_HUBS[1]);

  const productsById = useMemo(() => {
    const m = new Map();
    for (const p of products || []) if (p && p.id) m.set(p.id, p);
    return m;
  }, [products]);

  // BOTH LEDGER AND CELLS MUST HAVE ANSWERED. With the ledger unanswered every
  // shoe reads as "no display record", and a tap would open a SECOND row beside
  // one already there — the duplicate this screen exists to prevent, created by
  // the screen itself.
  const ready = rowsLoaded && hub1.settled && hub2.settled;

  const candidates = useMemo(
    () => (ready
      ? unregisteredAcrossHubs({
          cellsByHub: { [GATED_SNEAKER_HUBS[0]]: hub1.cells, [GATED_SNEAKER_HUBS[1]]: hub2.cells },
          rows, store, productsById, hubs: GATED_SNEAKER_HUBS,
          // A DEACTIVATED line is never offered a new display. It still holds
          // warehouse stock, so it would otherwise sit at the top of a wall walk
          // asking to be put on a shelf the business has retired it from.
          // (deactivationRead.test.js pins this shape across every list.)
          predicate: (p) => isFootwearProduct(p) && !isDeactivated(p),
        })
      : []),
    [ready, hub1.cells, hub2.cells, rows, store, productsById]
  );

  // Typing searches BOTH sides at once: shoes with no record, and shoes that
  // have one. One box, because "is this on the wall?" is one question and the
  // operator does not know the answer before they ask.
  const found = useMemo(() => filterCandidates(candidates, { q }), [candidates, q]);
  const onRecord = useMemo(
    () => (ready ? registeredDisplays({ rows, store, productsById, q }) : []),
    [ready, rows, store, productsById, q]
  );
  const shown = found.slice(0, (page + 1) * PAGE);

  const sizesOf = (product) =>
    (Array.isArray(product?.sizes) ? product.sizes : []).map(String).map((x) => x.trim()).filter((x) => x && x !== "_");

  // /orders is store-scoped at the rule layer, so a shop-scoped device cannot
  // see another wall's open requests and must not raise one it cannot fence.
  const canRequest = !ordersScope || ordersScope === store;

  const onWall = async (candidate, size, existingRow = null) => {
    setBusy(candidate.productId); setNote(null);
    // The hub that HOLDS the picked size — not a hub the operator guessed at.
    // For a correction the row keeps the hub it already had, including null.
    const bookedHub = existingRow ? (existingRow.bookedHub ?? null) : hubForSize(candidate, size);
    const res = await registerDisplayRow({
      rows, store, productId: candidate.productId,
      productName: candidate.productName || candidate.product?.name || "",
      size, bookedHub, via: "wall_walk",
    });
    setBusy(null); setActing(null);
    setNote(res.ok
      ? { tone: "ok", text: `${candidate.productName} · size ${formatSize(size)} is on ${labelFor(store)}'s record. No stock moved.` }
      : { tone: "err", text: res.message });
  };

  const notOnWall = async (candidate) => {
    setBusy(candidate.productId); setNote(null);
    const res = await raiseDisplayRequest({
      orders, store, // The hub that holds ANY of this shoe's stock. It carries no size — a
      // display request never names one — so the first size's hub is simply the
      // shelf the warehouse will pick from.
      hub: candidate.sizes?.[0]?.hub || GATED_SNEAKER_HUBS[0],
      product: candidate.product || { id: candidate.productId, name: candidate.productName },
    });
    setBusy(null);
    setNote(res.ok
      ? { tone: "ok", text: `Display partner requested — order #${res.orderId}. The warehouse picks the size when it sends it.` }
      : { tone: res.already ? "err" : "err", text: res.message });
  };

  const closeRow = async (row, reason) => {
    setBusy(row.productId); setNote(null);
    const res = await closeDisplayRow({ rows, row, reason, via: "wall_walk", detail: { reason, store } });
    setBusy(null); setActing(null);
    setNote(res.ok
      ? { tone: res.warning ? "err" : "ok", text: res.warning || `Closed the size ${formatSize(rowSizeText(row))} record. No stock moved.` }
      : { tone: "err", text: res.message });
  };

  const Thumb = ({ p }) => (p?.photoUrl
    ? <img src={p.photoUrl} alt="" style={sheet.thumb} />
    : <div style={{ ...sheet.thumb, display: "grid", placeItems: "center", fontSize: 20 }}>👟</div>);

  return (
    <div style={sheet.page}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 style={sheet.h1}>Display Registration</h1>
          <div style={sheet.sub}>What is standing on the wall, and what is not.</div>
        </div>
        <button onClick={onExit} style={{ ...sheet.btn(), padding: "8px 14px", color: DIM }}>Exit</button>
      </div>

      <div style={sheet.seg}>
        {STORES.map((s) => (
          <button key={s} onClick={() => { setStore(s); setActing(null); setNote(null); setPage(0); }}
                  style={sheet.segBtn(store === s)}>{labelFor(s)}</button>
        ))}
      </div>

      <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}
             placeholder="Search a shoe…" style={sheet.search} />

      {note && <div style={sheet.note(note.tone)}>{note.text}</div>}

      {!ready && <div style={sheet.empty}>Loading…</div>}

      {/* ── ALREADY ON THE RECORD ─────────────────────────────────────────── */}
      {ready && onRecord.map((g) => (
        <div key={`r-${g.productId}`} style={sheet.card}>
          <Thumb p={g.product} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={sheet.name}>{g.productName}</div>
            <div style={sheet.meta}>
              {g.rows.map((r) => <span key={r.rowId} style={sheet.pill}>Size {formatSize(rowSizeText(r))}</span>)}
              {g.rows.length > 1 ? "more than one record — close the ones that are not there" : "on the record"}
            </div>
            {acting === `fix-${g.productId}` ? (
              <SizePicker sizes={sizesOf(g.product)} busy={busy === g.productId}
                          title="Which size is actually on the wall?"
                          note={`The record says ${g.rows.map((r) => formatSize(rowSizeText(r))).join(", ")}. Picking replaces it. No stock moves.`}
                          confirmLabel="Register"
                          onPick={(sz) => onWall({ productId: g.productId, productName: g.productName, product: g.product, sizes: [] }, sz, g.rows[0])}
                          onCancel={() => setActing(null)} />
            ) : (
              <div style={sheet.row}>
                <button style={sheet.btn()} disabled={!!busy} onClick={() => setActing(`fix-${g.productId}`)}>Different size</button>
                {g.rows.map((r) => (
                  <button key={r.rowId} style={sheet.btn()} disabled={!!busy}
                          onClick={() => closeRow(r, "returned")}>
                    {g.rows.length > 1 ? `Not there — size ${formatSize(rowSizeText(r))}` : "Not on the wall any more"}
                  </button>
                ))}
                <HistoryToggle row={g.rows[0]} />
              </div>
            )}
          </div>
        </div>
      ))}

      {/* ── NOT ON THE RECORD — the walk ──────────────────────────────────── */}
      {ready && shown.map((c) => (
        <div key={c.productId} style={sheet.card}>
          <Thumb p={c.product} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={sheet.name}>{c.productName}</div>
            <div style={sheet.meta}>{c.hubUnits} in the warehouse · no display record here</div>
            {acting === c.productId ? (
              <SizePicker sizes={sizesOf(c.product)} busy={busy === c.productId}
                          title="Which size is on the wall?"
                          note="Nothing is chosen for you — pick the size you are looking at. No stock moves."
                          confirmLabel="Register"
                          onPick={(sz) => onWall(c, sz)}
                          onCancel={() => setActing(null)} />
            ) : (
              <div style={sheet.row}>
                <button style={sheet.btn("primary")} disabled={!!busy} onClick={() => setActing(c.productId)}>On the wall</button>
                <button style={sheet.btn()} disabled={!!busy || !canRequest}
                        title={canRequest ? "" : `Switch to ${labelFor(store)} on that device to request for this wall.`}
                        onClick={() => notOnWall(c)}>Not on the wall</button>
              </div>
            )}
          </div>
        </div>
      ))}

      {ready && found.length > shown.length && (
        <button style={{ ...sheet.btn(), width: "100%", marginTop: 12 }} onClick={() => setPage((p) => p + 1)}>
          Show {Math.min(PAGE, found.length - shown.length)} more
        </button>
      )}

      {ready && !shown.length && !onRecord.length && (
        <div style={sheet.empty}>
          {q
            ? "Nothing matches that here."
            : `Every shoe in the warehouse already has a display record for ${labelFor(store)}. Search to correct one.`}
          <div style={{ marginTop: 10, color: "rgba(245,246,248,.24)" }}>
            This list can only see shoes the warehouse still holds. A display whose warehouse stock has run out is real and is not here.
          </div>
        </div>
      )}

      {!isAdmin && <div style={{ ...sheet.empty, paddingTop: 24 }}>Registering is admin-only.</div>}
    </div>
  );
}
