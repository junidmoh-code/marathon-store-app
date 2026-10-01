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
// ── ONE THING NOTHING DOES ANY MORE, AND IT IS A REAL GAP ───────────────────
// The old Hub 1 / Hub 2 tabs also edited the hub REGISTER
// (/settings/hubSneakerCount/register): register a pair, FIX A WRONG SIZE, and
// remove a row. That is a different record from the display ledger and is not
// what this screen is about.
//
// Registering and removing survive — DisplayRecordsTab in the Stock console
// calls recordDisplayFact and removeDisplayFact. FIXING A SIZE DOES NOT.
// `editDisplaySize` now has no caller anywhere in the app, and an earlier
// version of this comment claimed Display Records covered it. It does not: that
// tab has no size-correction surface at all. Correcting a wrong register size
// is currently a remove-then-record, or nothing.
//
// Left as a stated gap rather than quietly reinstated, because restoring it is
// a product decision about a record this screen deliberately no longer owns.
// (Senior-architect review, which caught the overstatement.)
//
// ── THE ABSOLUTE RULE IS UNTOUCHED ──────────────────────────────────────────
// Nothing here picks, guesses or pre-selects a size. Every size on the record
// comes from a human tapping it, and the picker opens with nothing chosen.
// Pinned by displaySizeNeverPreselected.test.js.

import React, { useMemo, useState } from "react";
import {
  unregisteredAcrossHubs, hubForSize, filterCandidates, registeredDisplays, rowSizeText, openRowIndex,
} from "./displayRowCore";
import { registerDisplayRow, closeDisplayRow } from "./displayRowStore";
import { raiseDisplayRequest } from "./displayRequestStore";
import { wallRequestsFor, pickDisplaySourceHub } from "./displayRequestCore";
import { readyPromisedByCell } from "./availabilityCore";
import { serverNowMs } from "../../utils/serverTime";
import { useDisplayRowsState, useStockCellsState } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { GATED_SNEAKER_HUBS, isFootwearProduct } from "./availabilityCore";
import { isDeactivated } from "../../utils/deactivation";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { SizePicker, HistoryToggle } from "./displayRowUi";
import { FONT } from "./ui";
import { MirroredImg } from "../../offline/MirroredImg.jsx";

// The two walls. Pine's displays are booked at hub3, outside
// GATED_SNEAKER_HUBS, so Pine is deliberately not offered.
const STORES = ["marathon-pe", "trophy"];
const PAGE = 30;

// "11:42", in the shops' own clock whatever the device's timezone says.
const hhmm = (v) => {
  const t = typeof v === "number" ? v : Date.parse(v || "");
  return Number.isFinite(t)
    ? new Date(t).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" })
    : "";
};

/** The one line a request prints, from requested → sent → on the wall. */
export function requestLine(r) {
  const hub = r.order?.displayRefillHub || r.hub || null;
  const from = hub ? ` · ${labelFor(hub)}` : "";
  if (r.state === "sent") {
    return `Sent · size ${formatSize(String(r.size ?? "?"))} · ${hhmm(r.at)}${from} — on the wall`;
  }
  if (r.state === "depleted") return `Stock depleted${from} · ${hhmm(r.at)} — nothing was sent`;
  const at = hhmm(r.order?.raisedAt || r.order?.createdAt || r.at);
  // A request from before 2026-09-24 was an `incoming` order with no refill
  // schedule: it is in the order queue, NOT on the Display Refill card yet.
  if (r.order && r.order.status === "incoming" && !r.order.displayRefillScheduledAt && r.order.createdAt) {
    return `Display requested${at ? ` · ${at}` : ""}${from} — waiting in the order queue`;
  }
  const due = r.dueAtMs && r.dueAtMs > serverNowMs() ? ` — on its Display Refill card from ${hhmm(r.dueAtMs)}` : " — on its Display Refill card";
  return `Display requested${at ? ` · ${at}` : ""}${from}${due}`;
}

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
  // What a tap has just done, per `${store}::${productId}`, so the row changes
  // AT ONCE rather than when /orders comes round: { orderId, hub, at } for a
  // request raised, or { noStock: true } for a shoe no hub can give out.
  const [tapped, setTapped] = useState({});

  const { value: rows, settled: rowsLoaded } = useDisplayRowsState(true);
  const hub1 = useStockCellsState(GATED_SNEAKER_HUBS[0]);
  const hub2 = useStockCellsState(GATED_SNEAKER_HUBS[1]);

  const productsById = useMemo(() => {
    const m = new Map();
    for (const p of products || []) if (p && p.id) m.set(p.id, p);
    return m;
  }, [products]);
  const productsByIdObj = useMemo(() => Object.fromEntries(productsById), [productsById]);

  // ── THE WALL'S REQUESTS, AND WHAT A HUB CAN GIVE OUT ─────────────────────
  // Both read off what the screen already streams: /orders (the display
  // requests, from either path) and the two hubs' cells. The ready promises
  // are netted off exactly as the order screen nets them, so "holds stock"
  // means a pair the picker can actually send.
  const requests = useMemo(
    () => wallRequestsFor(orders, store, serverNowMs()),
    [orders, store]
  );
  const requestedIds = useMemo(() => {
    const ids = new Set(requests.filter((r) => r.state === "requested").map((r) => r.productId));
    // A tap only stands in until the stream has an answer for that shoe. Once
    // /orders knows about it, the stream decides — so a request that ends in
    // Stock Depleted puts the shoe back on the list without a reload.
    // (Architect review.)
    // Handed over by ORDER id, not by product: an older, resolved request for
    // the same shoe must not stand in for the one just raised. (CodeRabbit.)
    const streamed = new Set();
    for (const r of requests) {
      if (r.order?.id != null) streamed.add(String(r.order.id));
      for (const id of r.openIds || []) streamed.add(id);
    }
    for (const [k, v] of Object.entries(tapped)) {
      const i = k.indexOf("::");
      const pid = k.slice(i + 2);
      if (k.slice(0, i) === store && v.orderId && !streamed.has(String(v.orderId))) ids.add(pid);
    }
    return ids;
  }, [requests, tapped, store]);
  const hubData = useMemo(() => Object.fromEntries(
    [[GATED_SNEAKER_HUBS[0], hub1], [GATED_SNEAKER_HUBS[1], hub2]].map(([h, st]) => [h, {
      cells: st.cells, ready: !!st.settled,
      promised: readyPromisedByCell(orders, h, productsByIdObj),
    }])
  ), [hub1, hub2, orders, productsByIdObj]);

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
  // A shoe with a display request in flight is OUT of the to-do list until the
  // request is sent or cancelled; it is listed under "Requested" instead.
  const found = useMemo(
    () => filterCandidates(candidates, { q }).filter((c) => !requestedIds.has(c.productId)),
    [candidates, q, requestedIds]
  );
  const searched = useMemo(
    () => (ready ? registeredDisplays({ rows, store, productsById, q }) : []),
    [ready, rows, store, productsById, q]
  );

  // ── MORE THAN ONE RECORD FOR ONE SHOE ON THIS WALL (owner, 2026-09-24) ───
  // The Duplicate Displays tab went on 2026-09-08 when the live count was zero;
  // its job moved into the search results, which means a duplicate is only
  // seen by someone who happens to search for that shoe. The 2026-09-24 census
  // found one (Marathon PE, two open size-9 records for one Air Force 1). So a
  // wall holding any shoe with more than one open record lists those shoes at
  // the top without a search, on the same card, with the same "Not there —
  // size X" closes. Nothing is listed, and no heading shows, when there are none.
  const duplicates = useMemo(() => {
    if (!ready) return [];
    const out = [];
    for (const [key, list] of openRowIndex(rows)) {
      const i = key.indexOf("::");
      if (key.slice(0, i) !== store || list.length < 2) continue;
      const productId = key.slice(i + 2);
      const product = productsById.get(productId) || null;
      out.push({ productId, product, productName: product?.name || list[0].productName || "(name not on file)", rows: list });
    }
    return out.sort((a, b) => String(a.productName).localeCompare(String(b.productName)));
  }, [ready, rows, store, productsById]);
  const onRecord = useMemo(() => {
    const seen = new Set(duplicates.map((d) => d.productId));
    return [...duplicates, ...searched.filter((g) => !seen.has(g.productId))];
  }, [duplicates, searched]);
  const shown = found.slice(0, (page + 1) * PAGE);

  // "None in any warehouse" is an answer about the stock AT THE TAP. It stands
  // only while the live cells still say so; the moment either hub can give a
  // pair out, the row and the button come back. (CodeRabbit.)
  const noneAnywhere = (c) => !!tapped[`${store}::${c.productId}`]?.noStock
    && !pickDisplaySourceHub({ product: c.product || { id: c.productId }, hubData }).hub;

  // The Requested list: the stream's answer, plus a tap the stream has not
  // delivered yet (so the row moves the instant the request is written).
  const requestList = useMemo(() => {
    const have = new Set();
    for (const r of requests) {
      if (r.order?.id != null) have.add(String(r.order.id));
      for (const id of r.openIds || []) have.add(id);
    }
    const extra = [];
    for (const [k, v] of Object.entries(tapped)) {
      const i = k.indexOf("::");
      const pid = k.slice(i + 2);
      if (k.slice(0, i) !== store || !v.orderId || have.has(String(v.orderId))) continue;
      extra.push({ productId: pid, state: "requested", order: { id: v.orderId, displayRefillHub: v.hub, createdAt: v.at },
                   dueAtMs: v.at ? Date.parse(v.at) + 15 * 60 * 1000 : null });
    }
    // A tap the stream has not delivered yet replaces any older entry for the
    // same shoe (one row per shoe).
    const tappedPids = new Set(extra.map((e) => e.productId));
    const all = [...extra, ...requests.filter((r) => !tappedPids.has(r.productId))];
    const needle = q.trim().toLowerCase();
    return needle
      ? all.filter((r) => String(productsById.get(r.productId)?.name || r.order?.productName || "").toLowerCase().includes(needle))
      : all;
  }, [requests, tapped, store, q, productsById]);

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
    const key = `${store}::${candidate.productId}`;
    const res = await raiseDisplayRequest({
      orders, store, hubData,
      product: candidate.product || { id: candidate.productId, name: candidate.productName },
    });
    setBusy(null);
    if (res.ok) {
      setTapped((t) => ({ ...t, [key]: { orderId: res.orderId, hub: res.hub, at: res.order?.createdAt || null } }));
      setNote({ tone: res.warning ? "err" : "ok",
        text: res.warning || `${candidate.productName}: display requested from ${labelFor(res.hub)} — order #${res.orderId}. The picker chooses the size when they send it.` });
    } else if (res.noStock) {
      setTapped((t) => ({ ...t, [key]: { noStock: true } }));
      setNote({ tone: "err", text: `${candidate.productName}: none in any warehouse. Nothing was requested.` });
    } else if (res.already) {
      if (res.orderId) setTapped((t) => ({ ...t, [key]: { orderId: res.orderId, hub: null, at: null } }));
      setNote({ tone: "ok", text: `${res.message} It stays on the list under Requested.` });
    } else {
      setNote({ tone: "err", text: res.message });
    }
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
    ? <MirroredImg productId={p.id} src={p.photoUrl} alt="" style={sheet.thumb} />
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

      {/* ── REQUESTED — in flight to this wall, and sent in the last day ───── */}
      {ready && requestList.length > 0 && (
        <div style={{ ...sheet.meta, marginTop: 18, fontWeight: 600, color: DIM }}>Requested for {labelFor(store)}</div>
      )}
      {ready && requestList.map((r) => {
        const p = productsById.get(r.productId);
        return (
          <div key={`q-${r.productId}`} style={sheet.card}>
            <Thumb p={p} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={sheet.name}>{p?.name || r.order?.productName || r.productId}</div>
              <div style={{ ...sheet.meta, color: r.state === "sent" ? GOOD : r.state === "depleted" ? BAD : DIM }}>
                {requestLine(r)}{r.order?.id ? ` · #${r.order.id}` : ""}
              </div>
              {r.openIds?.length > 1 && (
                <div style={{ ...sheet.meta, color: BAD }}>
                  {`${r.openIds.length} open requests for this wall (${r.openIds.map((id) => `#${id}`).join(", ")}) — send one; mark the others Stock Depleted.`}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* ── ALREADY ON THE RECORD ─────────────────────────────────────────── */}
      {ready && duplicates.length > 0 && (
        <div style={{ ...sheet.meta, marginTop: 18, fontWeight: 600, color: BAD }}>
          {`${duplicates.length === 1 ? "1 shoe has" : `${duplicates.length} shoes have`} more than one display record on ${labelFor(store)} — keep the true size, close the rest`}
        </div>
      )}
      {ready && onRecord.map((g) => (
        <div key={`r-${g.productId}`} style={sheet.card}>
          <Thumb p={g.product} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={sheet.name}>{g.productName}</div>
            <div style={sheet.meta}>
              {g.rows.map((r) => <span key={r.rowId} style={sheet.pill}>Size {formatSize(rowSizeText(r))}</span>)}
              {g.rows.length > 1
                ? "more than one record — close the ones that are not there"
                : g.rows[0].openedVia === "send"
                  ? `on the record · sent${g.rows[0].bookedHub ? ` from ${labelFor(g.rows[0].bookedHub)}` : ""} at ${hhmm(g.rows[0].openedAt)}`
                  : "on the record"}
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
            <div style={sheet.meta}>
              {noneAnywhere(c)
                ? "none in any warehouse — nothing to send"
                : `${c.hubUnits} in the warehouse · no display record here`}
            </div>
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
                <button style={sheet.btn()} disabled={!!busy || !canRequest || noneAnywhere(c)}
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
