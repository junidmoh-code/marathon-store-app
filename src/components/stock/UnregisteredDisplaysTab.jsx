// ─── UNREGISTERED DISPLAYS — the wall walk ───────────────────────────────────
//
// (Owner spec clause 5, 2026-09-08.)
//
// Products holding stock at the serving hub with NO open display row for this
// store. A worklist you walk the wall with: search it, filter it by brand, page
// through it, and for each shoe answer one of two questions with one tap.
//
//   ON THE WALL      → pick the size (nothing is pre-picked) and it is
//                      registered on the spot. No stock moves: the pair was
//                      booked when it was received; the record catches up with
//                      what the wall already shows.
//   NOT ON THE WALL  → Request Display. This raises an ordinary display partner
//                      request into the pipeline the warehouse already works —
//                      Ready, then the refill task fifteen minutes later, then
//                      the operator picks the size at Send. Nothing about that
//                      pipeline is changed or duplicated (displayRequestStore.js).
//
// SCAN TO CHECK: photograph a tongue label and be told immediately whether that
// shoe is registered on this wall and at what size, with the same two actions on
// the result. It is the SHARED TongueLabelReader — the same three-frame burst,
// the same OCR funnel, the same alias store as every other label surface. A
// sixth copy of a label reader is how five of them stop agreeing.
//
// ── WHAT THIS LIST CAN AND CANNOT SEE ────────────────────────────────────────
// Stated in the empty state, out loud, because a worklist that quietly omits
// things is worse than no worklist:
//
//   IT CAN SEE  every product with stock at the selected hub that has no open
//               display record for the selected store.
//   IT CANNOT SEE a product whose hub stock has run out. A display standing on
//               a wall whose hub cell is now zero is REAL and is not here — the
//               list is built from hub stock because that is the only complete
//               catalogue of what could go on that wall, and a sold-out line is
//               not a candidate for a new display.
//   IT CANNOT SEE which of these is actually on the wall. Nothing in the data
//               knows. That is why it is a walk and not a report.
//
// HUB 1 AND HUB 2 ONLY, per GATED_SNEAKER_HUBS.

import React, { useMemo, useState } from "react";
import { unregisteredDisplayCandidates, filterCandidates, brandsOf, openRowsFor } from "./displayRowCore";
import { registerDisplayRow } from "./displayRowStore";
import { raiseDisplayRequest } from "./displayRequestStore";
import { useDisplayRowsState, useStockCellsState } from "./useStock";
import { GATED_SNEAKER_HUBS, isFootwearProduct } from "./availabilityCore";
// The SHARED label pipeline, whole. AssistantLabelFinder is the surface that
// wraps TongueLabelReader with the code/alias/token resolution that turns a
// label into a PRODUCT — the exact work this tab needs and must not re-write.
// src/labelReaderSurfaces.test.jsx pins that no surface grows a second copy.
import AssistantLabelFinder from "../assistant/AssistantLabelFinder";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { card, Photo, SizePicker, HistoryToggle, RowLine } from "./displayRowUi";
import { BORDER, BLUE_L, GREEN, RED, GRAY, AMBER, FONT, bGray, bBlue, input, tabOn, tabOff } from "./ui";

// The walls this screen serves. Pine's displays are booked at hub3, which is
// outside GATED_SNEAKER_HUBS, so Pine is deliberately not offered — see the
// header note rather than a silently shorter list.
const STORES = ["marathon-pe", "trophy"];
const PAGE = 40;

export default function UnregisteredDisplaysTab({ products = [], orders = [], isAdmin = false }) {
  const [store, setStore] = useState(STORES[0]);
  const [hub, setHub] = useState(GATED_SNEAKER_HUBS[0]);
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [page, setPage] = useState(0);
  const [acting, setActing] = useState(null);     // productId whose size picker is open
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanned, setScanned] = useState(null);   // { product, rows }

  const { value: rows, settled: rowsLoaded } = useDisplayRowsState(true);
  const { cells, settled: cellsLoaded } = useStockCellsState(hub);

  const productsById = useMemo(() => {
    const m = new Map();
    for (const p of products || []) if (p && p.id) m.set(p.id, p);
    return m;
  }, [products]);

  const candidates = useMemo(
    () => unregisteredDisplayCandidates({ cells, rows, store, hub, productsById, isFootwear: isFootwearProduct }),
    [cells, rows, store, hub, productsById]
  );
  const brands = useMemo(() => brandsOf(candidates), [candidates]);
  const filtered = useMemo(() => filterCandidates(candidates, { q, brand }), [candidates, q, brand]);
  const shown = filtered.slice(0, (page + 1) * PAGE);

  if (!isAdmin) return <div style={{ ...card, color: GRAY, fontFamily: FONT }}>Display records are admin-only.</div>;

  const sizesOf = (product) =>
    (Array.isArray(product?.sizes) ? product.sizes : []).map(String).map((x) => x.trim()).filter((x) => x && x !== "_");

  const onWall = async (product, size) => {
    setBusy(product.id); setNote(null);
    const res = await registerDisplayRow({
      rows, store, productId: product.id, productName: product.name || "",
      size, bookedHub: hub, via: "wall_walk",
    });
    setBusy(null); setActing(null);
    if (!res.ok) { setNote({ tone: "err", text: `Could not register ${product.name}: ${res.message}` }); return; }
    setNote({ tone: "ok", text: `${product.name} size ${formatSize(size)} is now on the display record at ${labelFor(store)}. No stock moved.` });
  };

  const notOnWall = async (product) => {
    setBusy(product.id); setNote(null);
    const res = await raiseDisplayRequest({ orders, store, hub, product });
    setBusy(null);
    if (!res.ok) { setNote({ tone: res.already ? "warn" : "err", text: res.message }); return; }
    setNote({ tone: "ok", text: `Display partner requested for ${product.name} at ${labelFor(store)} — order #${res.orderId}. The warehouse picks the size when it sends it.` });
  };

  // ── SCAN TO CHECK ─────────────────────────────────────────────────────────
  // The reader hands back a product it resolved from the label. The answer is
  // read from the LEDGER, not from the catalogue: "is this shoe registered on
  // THIS wall, and at what size".
  const onScanResolved = (product) => {
    setScanOpen(false);
    if (!product?.id) { setNote({ tone: "err", text: "That label did not resolve to a product on file." }); return; }
    setScanned({ product, rows: openRowsFor(rows, store, product.id) });
  };

  const toneColor = { ok: GREEN, err: RED, warn: AMBER };

  return (
    <div style={{ fontFamily: FONT, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={card}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {STORES.map((s) => (
            <button key={s} type="button" onClick={() => { setStore(s); setPage(0); setScanned(null); }}
              style={store === s ? tabOn : tabOff}>{labelFor(s)}</button>
          ))}
          <span style={{ width: 10 }} />
          {GATED_SNEAKER_HUBS.map((h) => (
            <button key={h} type="button" onClick={() => { setHub(h); setPage(0); setScanned(null); }}
              style={hub === h ? tabOn : tabOff}>{labelFor(h)}</button>
          ))}
          <div style={{ marginLeft: "auto", fontSize: 12, color: GRAY }}>
            {rowsLoaded && cellsLoaded ? `${filtered.length} to check` : "Loading…"}
          </div>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 13, color: "rgba(233,238,255,.72)", lineHeight: 1.5 }}>
          Every shoe with stock at {labelFor(hub)} that has <b style={{ color: "#fff" }}>no display record</b> for
          {" "}{labelFor(store)}. Walk the wall with this list. <b style={{ color: "#fff" }}>Registering one moves no
          stock</b> — the pair was booked when it was received; the record simply catches up with what the wall
          already shows.
        </p>
      </div>

      {/* Scan to check */}
      <div style={card}>
        {!scanOpen ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => { setScanOpen(true); setScanned(null); setNote(null); }} style={bBlue}>
              Scan a tongue label
            </button>
            <span style={{ fontSize: 12, color: GRAY }}>
              Photograph the label on a shoe at the wall and it will say whether it is registered here, and at what size.
            </span>
          </div>
        ) : (
          <AssistantLabelFinder
            products={products}
            onFound={onScanResolved}
            onClose={() => setScanOpen(false)}
          />
        )}
        {scanned && (
          <div style={{ marginTop: 12, border: BORDER, borderRadius: 12, padding: 12, background: "rgba(255,255,255,.02)" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <Photo url={scanned.product.photoUrl || scanned.product.photo} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{scanned.product.name}</div>
                {scanned.rows.length ? (
                  <>
                    <div style={{ fontSize: 12.5, color: GREEN, fontWeight: 700, marginTop: 3 }}>
                      Registered on {labelFor(store)}'s wall
                      {scanned.rows.length > 1 ? ` — ${scanned.rows.length} records, which is one too many` : ""}
                    </div>
                    {scanned.rows.map((r) => (
                      <div key={r.rowId} style={{ marginTop: 5 }}>
                        <RowLine row={r} />
                        <HistoryToggle row={r} />
                      </div>
                    ))}
                  </>
                ) : (
                  <div style={{ fontSize: 12.5, color: AMBER, fontWeight: 700, marginTop: 3 }}>
                    Not registered on {labelFor(store)}'s wall.
                  </div>
                )}
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              {acting === `scan:${scanned.product.id}` ? (
                <SizePicker
                  sizes={sizesOf(scanned.product)}
                  busy={busy === scanned.product.id}
                  title="Which size is on the wall?"
                  note="Nothing is chosen for you — pick the size you are looking at."
                  confirmLabel="Register"
                  onPick={(sz) => onWall(scanned.product, sz)}
                  onCancel={() => setActing(null)}
                />
              ) : (
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => setActing(`scan:${scanned.product.id}`)} disabled={!!busy} style={bGray}>
                    On the wall
                  </button>
                  <button type="button" onClick={() => notOnWall(scanned.product)} disabled={!!busy} style={bGray}>
                    {busy === scanned.product.id ? "Requesting…" : "Not on the wall — request a display"}
                  </button>
                  <button type="button" onClick={() => setScanned(null)} disabled={!!busy} style={bGray}>Done</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {note && (
        <div style={{ ...card, borderColor: toneColor[note.tone] || GREEN, color: toneColor[note.tone] || GREEN, fontSize: 13, fontWeight: 700 }}>
          {note.text}
        </div>
      )}

      {/* Search + brand filter */}
      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
          placeholder="Search by name, brand or product id"
          style={{ ...input, width: "100%" }}
        />
        {brands.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" onClick={() => { setBrand(""); setPage(0); }} style={brand === "" ? tabOn : tabOff}>All brands</button>
            {brands.map((b) => (
              <button key={b} type="button" onClick={() => { setBrand(b); setPage(0); }} style={brand === b ? tabOn : tabOff}>{b}</button>
            ))}
          </div>
        )}
      </div>

      {rowsLoaded && cellsLoaded && filtered.length === 0 && (
        <div style={{ ...card, fontSize: 13, color: "rgba(233,238,255,.75)", lineHeight: 1.6 }}>
          <b style={{ color: GREEN }}>Nothing to check here.</b>
          <br /><br />
          This list holds every shoe with stock at {labelFor(hub)} that has no display record for {labelFor(store)}
          {q || brand ? ", matching your search" : ""}.
          <br /><br />
          <b style={{ color: "#fff" }}>What it cannot see:</b> a shoe whose {labelFor(hub)} stock has run out. If a pair
          is standing on the wall and the hub cell is now zero, it is real and it is not on this list — the list is
          built from hub stock because that is the only complete record of what could go on that wall. It also cannot
          tell you which of these is actually on the wall. Nothing in the data knows; that is why this is a walk.
        </div>
      )}

      {shown.map((c) => (
        <div key={c.productId} style={card}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <Photo url={c.product?.photoUrl || c.product?.photo} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{c.productName}</div>
              <div style={{ fontSize: 12.5, color: GRAY, marginTop: 2 }}>
                {c.brand ? `${c.brand} · ` : ""}{c.hubUnits} unit{c.hubUnits === 1 ? "" : "s"} at {labelFor(hub)}
              </div>
              <div style={{ fontSize: 12, color: BLUE_L, marginTop: 4 }}>
                In stock: {c.sizes.map((s) => `${formatSize(s.size ?? s.sizeKey)}×${s.qty}`).join("  ")}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            {acting === c.productId ? (
              <SizePicker
                sizes={sizesOf(c.product)}
                busy={busy === c.productId}
                title="Which size is on the wall?"
                note="Nothing is chosen for you — pick the size you are looking at. It moves no stock."
                confirmLabel="Register"
                onPick={(sz) => onWall(c.product || { id: c.productId, name: c.productName }, sz)}
                onCancel={() => setActing(null)}
              />
            ) : (
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                <button type="button" onClick={() => { setActing(c.productId); setNote(null); }} disabled={!!busy}
                  style={{ ...bGray, borderColor: "rgba(74,222,128,.45)", color: GREEN, opacity: busy ? 0.5 : 1 }}>
                  On the wall
                </button>
                <button type="button" onClick={() => notOnWall(c.product || { id: c.productId, name: c.productName })}
                  disabled={!!busy} style={{ ...bGray, opacity: busy ? 0.5 : 1 }}>
                  {busy === c.productId ? "Requesting…" : "Not on the wall — request a display"}
                </button>
              </div>
            )}
          </div>
        </div>
      ))}

      {shown.length < filtered.length && (
        <button type="button" onClick={() => setPage((p) => p + 1)} style={{ ...bGray, alignSelf: "center" }}>
          Show {Math.min(PAGE, filtered.length - shown.length)} more ({shown.length} of {filtered.length})
        </button>
      )}
    </div>
  );
}
