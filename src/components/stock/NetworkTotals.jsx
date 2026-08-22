// ─── NETWORK TOTALS — "HOW MANY DO WE HAVE" ───────────────────────────────────
// One card, one number per product: every size at every location, added
// together. Not size 6 this much and size 7 that much; not Pine has this and
// Central has that. The breakdown is the Locator's job — this screen exists for
// the research pass before an order goes in, where the total IS the answer and
// the split is noise.
//
// READ-ONLY, END TO END. This file imports no writer: no set, update, push,
// remove or runTransaction, no applyMovement, no store module that writes. It
// cannot move stock, change a target, touch a policy or append a log.
//
// ── WHAT IT COSTS, AND WHY IT IS BUILT THIS WAY ──────────────────────────────
// Reading all of /stock is 5,361,046 bytes and RTDB does not compress it. So
// nothing here reads the whole node. The product list is free (the app already
// holds /products in memory) and totals are fetched one product at a time, only
// for the rows on screen, at a measured 1,243 bytes per product across all ten
// locations. A page of 25 is ~31 KB; a search of 12 hits is ~15 KB. The footer
// prints the running figure so the cost is never invisible.
//
// The consequence, stated on the card rather than hidden: the ranking is over
// the products whose totals have arrived. "Load 25 more" extends it. There is no
// secret full read, and the screen never pretends to have ranked 4,326 products
// when it has ranked 25.
//
// ── EVERYWHERE MEANS EVERYWHERE ──────────────────────────────────────────────
// The locations summed are every id in /locations, INCLUDING the two that are
// active:false (studio, base). They were drained into Central in July 2026 and
// net to zero today, but they still hold cells, and a total that quietly skipped
// two places would be a total he could not trust. All of them are named on the
// card. Nothing is excluded.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocations } from "./useStock";
import { DEFAULT_LOCATIONS, labelFor } from "./locations";
import { Empty } from "./widgets";
import { BLUE_L, GREEN, RED, GRAY, AMBER, BORDER, input, bGray, tabOn, tabOff } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { sortRows, visibleProducts } from "./networkTotalsCore";
import { loadTotals, cachedTotals, totalsBytesRead } from "./networkTotalsStore";

const PAGE = 25;

function Thumb({ product, size = 44 }) {
  const url = product?.photoUrl;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 10, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.46, flexShrink: 0 }}>📦</div>;
}

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 102400 ? 1 : 0)} KB`);

export default function NetworkTotals({ products = [], registry }) {
  const liveRegistry = useLocations();
  const reg = registry && Object.keys(registry).length ? registry : liveRegistry;

  // EVERY registered location, active or not — see the header note. Falls back to
  // the seed before /locations is readable so the card never silently sums a
  // subset of the network.
  const registrySettled = !!(reg && Object.keys(reg).length);
  const locationIds = useMemo(() => {
    const ids = registrySettled ? Object.keys(reg) : DEFAULT_LOCATIONS.map(l => l.id);
    return [...ids].sort();
  }, [reg, registrySettled]);

  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("desc");
  const [pageSize, setPageSize] = useState(PAGE);
  const [tick, forceRender] = useState(0);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const catalogue = useMemo(
    () => (products || []).filter(p => p && p.id && p.name),
    [products],
  );

  // The SAME matcher every other product search box in this app uses. Not a
  // second search with its own idea of what "af1" means.
  const matches = useMemo(
    () => searchProducts(catalogue, query, { limit: 60 }),
    [catalogue, query],
  );

  const shown = useMemo(
    () => visibleProducts(catalogue, matches, query, pageSize),
    [catalogue, matches, query, pageSize],
  );

  // Fetch totals for exactly the rows on screen, and nothing else.
  useEffect(() => {
    // Do NOT sum against a guessed location set. Until /locations has answered,
    // the seed is only good enough to LABEL the card; a total computed from it
    // would be cached and wrong the day a location is added.
    if (!registrySettled) return;
    const missing = shown.filter(p => !cachedTotals(p.id)).map(p => p.id);
    if (!missing.length) return;
    setLoading(true);
    loadTotals(missing, locationIds, () => { if (mounted.current) forceRender(n => n + 1); })
      .finally(() => { if (mounted.current) { setLoading(false); forceRender(n => n + 1); } });
  }, [shown, locationIds, registrySettled]);

  const rows = useMemo(
    () => sortRows(shown.map(p => ({ id: p.id, name: p.name, product: p, totals: cachedTotals(p.id) })), direction),
    // forceRender is the signal that the cache changed under us; shown/direction
    // alone cannot see a Map mutation.
    // `tick` is the signal that the totals cache changed under us; shown and
    // direction alone cannot observe a Map mutation.
    [shown, direction, tick], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const settled = rows.filter(r => r.totals);
  const more = !query.trim() && pageSize < catalogue.length;

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <style>{`
        .nt-row{transition:border-color .15s,background .15s}
        .nt-row:hover{border-color:rgba(74,127,255,.4);background:rgba(74,127,255,.05)}
      `}</style>

      {/* SEARCH */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", opacity: .4 }}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a product, or scroll the list…"
               style={{ ...input, width: "100%", boxSizing: "border-box", paddingLeft: 40, borderRadius: 13 }} />
      </div>

      {/* WHAT "EVERYWHERE" MEANS — named, not implied. */}
      <div style={{ ...({ border: BORDER }), borderRadius: 13, padding: "11px 13px", marginBottom: 12, background: "rgba(255,255,255,.022)" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: GRAY, letterSpacing: .3, textTransform: "uppercase" }}>
          Everywhere = all {locationIds.length} locations, added together
        </div>
        <div style={{ fontSize: 12, color: "rgba(233,238,255,.62)", marginTop: 5, lineHeight: 1.5 }}>
          {locationIds.map(id => labelFor(id, reg)).join(" · ")}
        </div>
        <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.4)", marginTop: 6, lineHeight: 1.5 }}>
          Every size at every one of them, summed. Nothing is left out — Studio and Base
          are retired into Central and normally sit at zero, but they are counted so the
          number is the whole network. Negative counts are added as they are, never
          rounded up to zero.
        </div>
      </div>

      {/* SORT */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <button onClick={() => setDirection("desc")} style={direction === "desc" ? tabOn : tabOff}>Most first</button>
        <button onClick={() => setDirection("asc")} style={direction === "asc" ? tabOn : tabOff}>Least first</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: GRAY, fontVariantNumeric: "tabular-nums" }}>
          {loading ? "counting…" : `${settled.length} counted`}
        </span>
      </div>

      {/* LIST */}
      {rows.length === 0 ? (
        <Empty>{query.trim() ? "No products match." : "No products."}</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map(r => <Row key={r.id} row={r} reg={reg} />)}
        </div>
      )}

      {more && (
        <button onClick={() => setPageSize(n => n + PAGE)} style={{ ...bGray, width: "100%", marginTop: 12 }}>
          Load 25 more · ranking {shown.length} of {catalogue.length} products
        </button>
      )}

      <div style={{ fontSize: 11, color: "rgba(233,238,255,.32)", marginTop: 14, lineHeight: 1.6, textAlign: "center" }}>
        Ranked over the {settled.length} product{settled.length === 1 ? "" : "s"} counted so far
        {query.trim() ? " in this search" : ` of ${catalogue.length}`}. This screen only reads —
        it never moves stock. {kb(totalsBytesRead())} of stock data read on this page so far.
      </div>
    </div>
  );
}

function Row({ row, reg }) {
  const t = row.totals;
  const total = t ? t.total : null;
  const colour = total == null ? GRAY : total < 0 ? RED : total === 0 ? GRAY : "#fff";

  return (
    <div className="nt-row" style={{ background: "rgba(255,255,255,.022)", border: BORDER, borderRadius: 13, padding: 11, display: "flex", alignItems: "center", gap: 12 }}>
      <Thumb product={row.product} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.name}</div>
        <div style={{ fontSize: 11.5, color: GRAY, marginTop: 3 }}>
          {t == null ? "counting…"
            : t.cellCount === 0 ? "no stock recorded anywhere"
            : `${t.cellCount} cell${t.cellCount === 1 ? "" : "s"} across ${t.locationCount} location${t.locationCount === 1 ? "" : "s"}`}
        </div>
        {/* A total dragged down by a negative cell is telling him something real.
            Show WHERE and HOW MUCH rather than quietly clamping it away. */}
        {t && t.negatives.length > 0 && (
          <div style={{ fontSize: 11, color: AMBER, marginTop: 4, lineHeight: 1.45 }}>
            includes {t.negativeUnits} from {t.negatives.length} negative cell{t.negatives.length === 1 ? "" : "s"}
            {" · "}
            {t.negatives.slice(0, 3).map(n => `${labelFor(n.locationId, reg)} ${String(n.sizeKey).replace(/_/g, ".")}: ${n.qty}`).join(" · ")}
            {t.negatives.length > 3 ? ` · +${t.negatives.length - 3} more` : ""}
          </div>
        )}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, minWidth: 62 }}>
        <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: colour }}>
          {total == null ? "·" : total}
        </div>
        <div style={{ fontSize: 10, color: "rgba(233,238,255,.3)", marginTop: 3 }}>
          {total == null ? "" : total === 1 ? "unit" : "units"}
        </div>
      </div>
    </div>
  );
}
