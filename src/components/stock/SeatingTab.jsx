// ─── SEATING — WHERE A PRODUCT SITS, AND HOW TO CHANGE IT ────────────────────
//
// A tab inside Engine Policy, because seating IS policy: "this shop carries this
// product" is the per-product form of the per-category arming the card already
// owns. It is not a separate route and not a separate surface, and it inherits
// the card's super-admin gate — the tile, the route, this component's own check.
//
// ── WHAT IT IS ───────────────────────────────────────────────────────────────
//   Search or scan one product → one row per location, each saying whether the
//   location is seated, WHY (target row / category policy / footwear rule / size
//   run / cell only), what it holds per size, and when the cell last moved.
//   From a row: Switch Off, or Move And Switch Off.
//
// ── THE STANDING RULE OF THIS CARD APPLIES: NO PARAGRAPH ─────────────────────
// Numbers, labels, chips and controls. Every explanation lives in comments.
//
// ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────
//   • DELETE A STOCK CELL. The live rules would let it — /stock/$loc/$pid/$size
//     .write is any stockRole holder and .validate is skipped on a delete
//     (checked against /.settings/rules.json, 2026-08-24) — which is exactly
//     why the refusal has to be a rule of this screen. A delete writes no ledger
//     record and leaves no trace. Switching off writes an explicit, reversible,
//     attributed fact instead, and that fact IS the audit trail.
//   • OFFER A BULK SWEEP. Some empty seating is correct: a shop that stocks a
//     line and is simply sold out. One location at a time, every time.
//   • READ A WHOLE NODE. Stock and targets are fetched per (location, product) —
//     seven small reads for one product. /products is already subscribed
//     app-wide by useProducts() and is passed in, so the search costs nothing
//     this app was not already paying.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ref, get } from "firebase/database";
import { database } from "../../firebase";
import { searchProducts } from "../../utils/productSearch";
import { transferTargets, labelFor, DEFAULT_LOCATIONS, IN_TRANSIT } from "./locations";
import { useLocations, useEngineConfig } from "./useStock";
import { seatingRows, seatingAt, lastTouch, SEAT_REASON } from "./seatingCore";
import { ProductCard, Badge, SizeFactChip, CHIP_GRID, PhotoThumb, PhotoLightbox } from "./healthWidgets";
import { installBarcodeListener, subscribeBarcode } from "./barcodeListener";
import CameraScanner from "./CameraScanner";
import { FONT, GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGhost, bGray, input } from "./ui";
import SeatingActions from "./SeatingActions";
import { readSeatingContext } from "./seatingStore";

// RTDB keys can't contain . # $ [ ] / — guard so a junk code is "not found",
// not a mis-pathed read. (Mirrors Transfer.jsx's lookupBarcode.)
const RTDB_RESERVED = /[.#$[\]/]/;

// EVERY registered location id, active or not. locations.js deliberately has no
// such export — every picker wants the active ones — but a carriage CONTEXT is
// not a picker: a deactivated warehouse (studio, base) still holds cells the
// engine counts. Falls back to the seed exactly as activeLocations does, so an
// unseeded /locations node does not silently narrow the snapshot.
function allLocationIds(registry) {
  const ids = registry && typeof registry === "object" ? Object.keys(registry) : [];
  return ids.length ? ids : DEFAULT_LOCATIONS.map((l) => l.id);
}

const TONE = {
  [SEAT_REASON.EXPLICIT_ROW]: GREEN,
  [SEAT_REASON.CATEGORY_POLICY]: GREEN,
  [SEAT_REASON.FOOTWEAR_RULE]: GREEN,
  [SEAT_REASON.SUBCATEGORY_RULE]: GREEN,
  [SEAT_REASON.CLOTHING_RULE]: GREEN,
  [SEAT_REASON.SWITCHED_OFF]: GRAY,
  [SEAT_REASON.CELL_ONLY]: AMBER,
  [SEAT_REASON.NOT_SEATED]: GRAY,
};

// ── the read ─────────────────────────────────────────────────────────────────
// Per (location, product), never per node — readSeatingContext lives in
// seatingStore.js because the move path must re-read through the SAME function
// it renders from, or the two could drift.

export default function SeatingTab({ products, viewer, flash }) {
  const registry = useLocations();
  const engineConfig = useEngineConfig();
  const [query, setQuery] = useState("");
  const [pid, setPid] = useState("");
  const [ctx, setCtx] = useState(null);        // { stock, targets }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [camera, setCamera] = useState(false);
  // The photo being looked at, if any. Looking is not choosing — see PhotoThumb.
  const [photo, setPhoto] = useState("");
  const [open, setOpen] = useState("");        // the location row with its actions expanded

  // ── TWO LISTS, AND THE DIFFERENCE IS LOAD-BEARING ──────────────────────────
  //
  // ROWS are the places a product can be SEATED: active, not in_transit.
  // DESTINATIONS are the same list — you may only send stock somewhere it can
  // be seated.
  //
  // The CONTEXT is every location that can hold a cell, in_transit and the
  // deactivated ones included, because the engine's dead-size rule counts units
  // ANYWHERE (`sizeUnitsAnywhere` walks Object.keys(stock), refill-engine.cjs
  // :409). Feeding the mirror a partial snapshot makes a size whose only units
  // are in transit read as dead, so a per-size category policy resolves 0 and
  // the row says "not carried" for a line the engine is actively seating. Six
  // category policies are armed live and /stock/in_transit holds real units.
  //
  // ── BOTH ARE MEMOISED ON A SIGNATURE, NOT ON THE REGISTRY OBJECT ──────────
  // `load` depends on contextLocations and an effect depends on `load`, so a
  // registry whose IDENTITY changes on every render would re-read /stock on
  // every render — a request loop against a shop's network. usePath hands back
  // a fresh object whenever anything under /locations changes, and a test
  // double can hand one back every time. The signature makes the lists change
  // only when the locations actually do.
  const locSig = JSON.stringify(
    Object.entries(registry || {})
      // BOTH ids. transferTargets reads `l.id` off the VALUE, while
      // allLocationIds reads the KEY, and nothing guarantees the two agree —
      // an entry whose id changed under an unchanged key would leave the digest
      // identical and the lists stale. (CodeRabbit, PR #429.)
      .map(([key, l]) => [key, l?.id, l?.active !== false, l?.kind])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  const { rowLocations, contextLocations } = useMemo(() => {
    const rows = transferTargets(registry).filter((l) => l.id !== IN_TRANSIT).map((l) => l.id);
    const ctxIds = new Set(rows);
    for (const l of allLocationIds(registry)) ctxIds.add(l);
    return { rowLocations: rows, contextLocations: [...ctxIds] };
    // registry is deliberately not a dependency — locSig is its stable digest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locSig]);

  const byId = useMemo(() => Object.fromEntries((products || []).map((p) => [p.id, p])), [products]);
  const product = pid ? byId[pid] : null;

  const matches = useMemo(
    () => (query.trim() ? searchProducts(products || [], query, { limit: 25 }) : []),
    [products, query],
  );

  // ── load ───────────────────────────────────────────────────────────────────
  // A stale response must never land on a newer product: the screen is one
  // search box and a fast scanner, so two loads in flight is the normal case,
  // not the exception.
  const loadSeq = useRef(0);
  const load = useCallback(async (nextPid) => {
    if (!nextPid || !contextLocations.length) return;
    const seq = ++loadSeq.current;
    setLoading(true); setError("");
    try {
      const next = await readSeatingContext(contextLocations, nextPid);
      if (seq !== loadSeq.current) return;
      setCtx(next);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e?.message || String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [contextLocations]);

  // Selecting a product SETS it; an effect does the reading. `load`'s identity
  // changes whenever contextLocations does, so a location activated or
  // deactivated mid-session re-reads instead of leaving a stale — possibly
  // NARROWER — snapshot behind, which is the bug class fixed above.
  // (CodeRabbit full review, PR #429.)
  // RE-SELECTING THE SAME PRODUCT MUST NOT BLANK IT. setPid is a no-op when the
  // value is unchanged, so the effect never refired — but setCtx(null) had
  // already thrown the rows away, and the screen sat empty until the product
  // was changed and changed back. A scan of the product already on screen is
  // the obvious way to hit it. Same id keeps its context and re-reads
  // explicitly. (CodeRabbit, PR #429.)
  const choose = useCallback((nextPid) => {
    setOpen("");
    if (nextPid && nextPid === pid) { load(nextPid); return; }
    // INVALIDATE ANY READ STILL IN FLIGHT FOR THE PREVIOUS PRODUCT. load()
    // bumps this itself, but the effect that calls it runs AFTER this commit —
    // and the old product's response can land in that gap, where it still
    // matches the sequence number and writes itself into state under the new
    // product's name. Bumping here closes the window at its start.
    // (CodeRabbit, PR #429.)
    loadSeq.current += 1;
    setPid(nextPid); setCtx(null);
  }, [pid, load]);

  useEffect(() => { if (pid) load(pid); }, [pid, load]);

  const refresh = useCallback(() => load(pid), [load, pid]);

  // ── scan ───────────────────────────────────────────────────────────────────
  // A code resolves through /barcodes/{code} exactly as every other scanning
  // surface does. The SIZE a per-size code carries is deliberately ignored:
  // seating is a product-level question, and narrowing to one size here would
  // answer a different one.
  const onCode = useCallback(async (code) => {
    const key = String(code ?? "").trim();
    if (!key || RTDB_RESERVED.test(key)) { setError("That code could not be read."); return; }
    try {
      const snap = await get(ref(database, `barcodes/${key}`));
      const hit = snap.exists() ? snap.val() : null;
      if (!hit?.productId) { setError(`No product is registered to ${key}.`); return; }
      if (!byId[hit.productId]) { setError("That code points at a product this list does not hold."); return; }
      setError(""); setQuery(""); choose(hit.productId);
    } catch (e) { setError(e?.message || String(e)); }
  }, [byId, choose]);

  useEffect(() => {
    const uninstall = installBarcodeListener();
    const unsub = subscribeBarcode((code) => onCode(code));
    return () => { unsub(); uninstall && uninstall(); };
  }, [onCode]);

  const full = useMemo(() => {
    if (!ctx || !product) return null;
    return { products: byId, stock: ctx.stock, targets: ctx.targets, config: engineConfig };
  }, [ctx, product, byId, engineConfig]);

  const rows = useMemo(() => (full ? seatingRows(full, rowLocations, pid) : []), [full, rowLocations, pid]);
  const seatedCount = rows.filter((r) => r.seated).length;

  return (
    <div>
      {/* ── search + scan ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: ".8rem" }}>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setError(""); }}
          placeholder="Search a product, or scan"
          aria-label="Search a product"
          style={{ ...input, flex: 1, minWidth: 0 }}
        />
        <button onClick={() => setCamera(true)} style={bGhost}>Scan</button>
      </div>

      {error && (
        <div style={{ ...GLASS, padding: ".7rem .9rem", marginBottom: ".8rem",
          border: "1px solid rgba(248,113,113,.45)", color: RED, fontSize: ".85rem" }}>{error}</div>
      )}

      <PhotoLightbox url={photo} onClose={() => setPhoto("")} />

      {camera && (
        <CameraScanner
          title="Scan a product"
          hint="Point the camera at the barcode."
          onScan={(code) => { setCamera(false); onCode(code); }}
          onClose={() => setCamera(false)}
        />
      )}

      {/* ── results ── */}
      {query.trim() && !matches.length && (
        <div style={{ color: GRAY, fontSize: ".85rem", padding: ".6rem 0" }}>No product matches that.</div>
      )}
      {query.trim() && matches.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          {/* A PICTURE BEFORE THE COMMITMENT. Names in this catalogue collide —
              colourway siblings share a style code, and twins share a name
              outright — so a text-only list asks the operator to pick blind and
              find out afterwards. The thumb answers "is this the one?" in the
              list, and opens full screen without selecting anything, because
              looking and choosing are different acts. */}
          {matches.map((p) => (
            <div
              key={p.id}
              style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}
            >
              <PhotoThumb
                url={p.photoUrl}
                alt={p.name}
                onOpen={p.photoUrl ? (u) => setPhoto(u) : undefined}
              />
              <button
                onClick={() => { setQuery(""); choose(p.id); }}
                style={{ ...bGray, flex: 1, minWidth: 0, textAlign: "left",
                  fontWeight: p.id === pid ? 800 : 600 }}
              >
                {p.name}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── the product ── */}
      {product && (
        <>
          <ProductCard
            photo={product.photoUrl}
            photos={product.photos}
            onPhotoTap={product.photoUrl ? () => setPhoto(product.photoUrl) : undefined}
            name={product.name}
            badges={<>
              <Badge tone={seatedCount ? GREEN : AMBER}>{seatedCount} seated</Badge>
              {(product.sizes || []).length > 0 && <Badge tone={BLUE_L}>{(product.sizes || []).length} sizes</Badge>}
            </>}
            sub={loading ? "reading…" : null}
            right={<button onClick={refresh} disabled={loading} style={{ ...bGhost, opacity: loading ? .5 : 1 }}>
              {loading ? "…" : "Refresh"}
            </button>}
          />

          {rows.map((seat) => (
            <SeatRow
              key={seat.loc}
              seat={seat}
              product={product}
              label={labelFor(seat.loc, registry)}
              registry={registry}
              locations={contextLocations}
              destinations={rowLocations}
              ctx={full}
              viewer={viewer}
              expanded={open === seat.loc}
              onToggle={() => setOpen(open === seat.loc ? "" : seat.loc)}
              onDone={(msg) => { flash("ok", msg); setOpen(""); refresh(); }}
              onFail={(msg) => flash("bad", msg)}
            />
          ))}
        </>
      )}

      {!product && !query.trim() && (
        <div style={{ color: GRAY, fontSize: ".85rem", padding: "1.4rem 0" }}>
          Search or scan a product to see where it is seated.
        </div>
      )}
    </div>
  );
}

// ── ONE LOCATION ─────────────────────────────────────────────────────────────
// Carried or not · why · units per size · when the cell last moved.
function SeatRow({ seat, product, label, registry, locations, destinations, ctx, viewer, expanded, onToggle, onDone, onFail }) {
  const tone = TONE[seat.reason] || GRAY;
  const touch = lastTouch(seat);
  const held = seat.sizes.filter((s) => s.hasCell);

  return (
    <div style={{ ...GLASS, padding: "12px 13px", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 120 }}>{label}</div>
        <Badge tone={tone}>{seat.label}</Badge>
        <Badge tone={seat.units > 0 ? BLUE_L : GRAY}>{seat.units} on hand</Badge>
        <button onClick={onToggle} style={bGhost} aria-expanded={expanded}>
          {expanded ? "Close" : "Change"}
        </button>
      </div>

      <div style={{ marginTop: 6, fontSize: 11, color: GRAY }}>
        {touch
          ? `${touch.sold ? "Last sold" : `Last ${String(touch.type || "moved")}`} ${fmtDay(touch.at)}`
          : "No movement recorded here"}
      </div>

      {held.length > 0 && (
        <div style={{ ...CHIP_GRID, marginTop: 8 }}>
          {held.map((s) => (
            <SizeFactChip
              key={s.sizeKey}
              size={s.size === "" ? "One size" : s.size}
              value={s.qty}
              tone={s.qty < 0 ? RED : s.qty === 0 ? GRAY : BLUE_L}
            />
          ))}
        </div>
      )}

      {expanded && (
        <SeatingActions
          seat={seat}
          product={product}
          label={label}
          registry={registry}
          locations={locations}
          destinations={destinations}
          ctx={ctx}
          viewer={viewer}
          onDone={onDone}
          onFail={onFail}
        />
      )}
    </div>
  );
}

// "12 Aug" / "12 Aug 25" — one short line, never a paragraph.
export function fmtDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const now = new Date();
  const same = d.getUTCFullYear() === now.getUTCFullYear();
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return same ? `${d.getUTCDate()} ${m}` : `${d.getUTCDate()} ${m} ${String(d.getUTCFullYear()).slice(2)}`;
}
