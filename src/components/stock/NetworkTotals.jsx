// ─── TOTAL STOCK ──────────────────────────────────────────────────────────────
// One page, one number per product: every size at every counted location, added
// together. It is the research pass before an order goes in, so it is a list of
// names and numbers and nothing else — no per-size split, no per-location split,
// no warnings, no diagnostics. Everything that is not a name or a number was
// taken off this screen on purpose (owner, 2026-08-22).
//
// It is a HOME-SCREEN module, not a Stock tab: it answers a buying question, not
// a warehouse one, and he goes to it directly.
//
// READ-ONLY, END TO END. This file imports no writer: no set, update, push,
// remove or runTransaction, no applyMovement. It cannot move stock, change a
// target, touch a policy or append a log. Enforced by networkTotalsReadOnly.test.js.
//
// ── WHAT IT COUNTS ───────────────────────────────────────────────────────────
// Every LIVE location except Pine and Hub 3 (countedLocations in
// networkTotalsCore.js). Studio and Base are retired into Central and drop out
// on the registry's own `active` flag, not on a list here. A negative cell counts
// as zero and is never mentioned. The scope is named in one grey line under the
// search box, because a number whose scope is invisible is a number that gets
// misread.
//
// ── WHAT IT COSTS ────────────────────────────────────────────────────────────
// Reading all of /stock is 5.36 MB and RTDB does not compress it, so nothing
// here reads the whole node. The product list is free (the app already holds
// /products in memory) and totals are fetched per product, only for the rows on
// screen — measured at ~1.2 KB a product, ~44 KB for a page of 25.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePathState } from "./useStock";
import { DEFAULT_LOCATIONS, labelFor } from "./locations";
import { Empty } from "./widgets";
import { FONT, BG, BLUE_L, GRAY, BORDER, input, bGray, tabOn, tabOff } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { sortRows, visibleProducts, countedLocations } from "./networkTotalsCore";
import { loadTotals, cachedTotals, totalsFailed, totalsReadAt, forgetTotals } from "./networkTotalsStore";

const PAGE = 25;

function Thumb({ product, size = 44 }) {
  const url = product?.photoUrl;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 10, background: "rgba(120,150,255,.08)", flexShrink: 0 }} />;
}

export default function NetworkTotals({ products = [], registry, onExit }) {
  // StockView used to hand the registry down; as a home module there is no
  // parent subscription, so read it here — through usePathState, because a bare
  // null cannot tell "not answered yet" from "empty" from "denied", and gating
  // on null would leave a user whose rules deny /locations counting forever.
  const havePropRegistry = !!(registry && Object.keys(registry).length);
  const own = usePathState("locations", !havePropRegistry);
  const reg = havePropRegistry ? registry : (own.value || null);
  const registryReady = havePropRegistry || own.settled;

  const locationIds = useMemo(() => {
    const seed = Object.fromEntries(DEFAULT_LOCATIONS.map(l => [l.id, l]));
    const map = reg && Object.keys(reg).length ? reg : seed;
    return countedLocations(Object.keys(map), map);
  }, [reg]);

  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("desc");
  const [pageSize, setPageSize] = useState(PAGE);
  const [tick, forceRender] = useState(0);
  // Bumped ONLY by Retry and Refresh. Deliberately separate from `tick`: `tick`
  // fires once per row that lands, and if the fetch effect depended on it, every
  // arriving row would re-enter the effect while its siblings were still in
  // flight — cachedTotals is still null for those, so they look "missing" again
  // and a fresh loadTotals chain is spawned per row. The reads themselves are
  // deduped by the store's inflight map, so nothing extra is DOWNLOADED, but the
  // promise chains multiply quadratically. It showed up as a test worker running
  // out of heap; on a tablet it would show up as the page locking under a thumb.
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  // Set on EVERY mount, not declared true once: StrictMode mounts, tears down
  // and remounts in development, and a flag only ever cleared would stay false
  // for the life of the instance — totals would load while the page rendered
  // nothing, in the one environment this gets iterated in.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const catalogue = useMemo(() => (products || []).filter(p => p && p.id && p.name), [products]);

  // The SAME matcher every other product search box in this app uses. No cap:
  // a cap would silently truncate the match set and then print its own truncated
  // size as the denominator. The page size is what bounds the cost.
  const matches = useMemo(
    () => searchProducts(catalogue, query, { limit: catalogue.length }),
    [catalogue, query],
  );

  const shown = useMemo(
    () => visibleProducts(catalogue, matches, query, pageSize),
    [catalogue, matches, query, pageSize],
  );

  // Fetch totals for exactly the rows on screen, and nothing else.
  useEffect(() => {
    if (!registryReady) return;
    const missing = shown.filter(p => !cachedTotals(p.id, locationIds) && !totalsFailed(p.id, locationIds)).map(p => p.id);
    if (!missing.length) return;
    setLoading(true);
    loadTotals(missing, locationIds, () => { if (mounted.current) forceRender(n => n + 1); })
      .finally(() => { if (mounted.current) { setLoading(false); forceRender(n => n + 1); } });
  }, [shown, locationIds, registryReady, reload]);

  const rows = useMemo(
    () => sortRows(shown.map(p => ({ id: p.id, name: p.name, product: p, totals: cachedTotals(p.id, locationIds), failed: totalsFailed(p.id, locationIds) })), direction),
    // `tick` is the signal that the totals cache changed under us; shown and
    // direction alone cannot observe a Map mutation.
    [shown, direction, locationIds, tick], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const pool = query.trim() ? matches.length : catalogue.length;
  const more = pageSize < pool;
  const retry = (productId) => { forgetTotals(productId, locationIds); setReload(n => n + 1); };
  const refresh = () => { forgetTotals(); setReload(n => n + 1); };

  const counted = locationIds.map(id => labelFor(id, reg)).join(", ");
  const readAt = totalsReadAt();

  // ── SCROLL, DON'T PRESS ─────────────────────────────────────────────────────
  // The next page loads on its own as he gets near the bottom. An observer on a
  // sentinel, not a scroll handler: it fires when the sentinel actually comes
  // into view, so pages arrive one at a time as he scrolls and the bytes still
  // track what he has actually looked at — the whole reason this screen does not
  // read /stock outright. rootMargin buys a page of runway so the numbers are
  // usually there by the time he reaches them.
  //
  // The button stays as a fallback for a browser with no IntersectionObserver
  // (and for the tests, which run without one). It is not the primary path.
  const sentinel = useRef(null);
  const hasObserver = typeof IntersectionObserver !== "undefined";
  useEffect(() => {
    if (!hasObserver || !more || loading) return;
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some(e => e.isIntersecting)) setPageSize(n => n + PAGE); },
      { rootMargin: "600px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasObserver, more, loading, pageSize, query]);

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <style>{`
        .ts-row{transition:border-color .15s,background .15s}
        .ts-row:hover{border-color:rgba(74,127,255,.4);background:rgba(74,127,255,.05)}
      `}</style>

      <div style={{ padding: "14px 16px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onExit} style={{ background: "none", border: "none", padding: 0, color: BLUE_L, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FONT }}>← Exit</button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Total Stock</div>
        <div style={{ minWidth: 40 }} />
      </div>

      <div style={{ maxWidth: 780, margin: "0 auto", padding: "4px 12px 40px" }}>
        <div style={{ position: "relative", marginBottom: 8 }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", opacity: .4 }}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input value={query} onChange={e => { setQuery(e.target.value); setPageSize(PAGE); }} placeholder="Search a product…"
                 style={{ ...input, width: "100%", boxSizing: "border-box", paddingLeft: 40, borderRadius: 13 }} />
        </div>

        {/* The scope of the number, in one line. Not a panel, not a warning — but
            never absent: a total whose scope is invisible gets misread. */}
        <div style={{ fontSize: 11, color: "rgba(233,238,255,.34)", marginBottom: 12, lineHeight: 1.5 }}>
          All sizes at {counted}.
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <button onClick={() => setDirection("desc")} style={direction === "desc" ? tabOn : tabOff}>Most first</button>
          <button onClick={() => setDirection("asc")} style={direction === "asc" ? tabOn : tabOff}>Least first</button>
          <div style={{ flex: 1 }} />
          {/* When it was counted. Six characters, and the difference between a
              number he can act on and a number an hour old that looks current. */}
          {readAt && !loading && (
            <span style={{ fontSize: 11, color: "rgba(233,238,255,.3)", fontVariantNumeric: "tabular-nums" }}>
              {readAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button onClick={refresh} disabled={loading} style={{ ...tabOff, opacity: loading ? .5 : 1 }}>Refresh</button>
        </div>

        {rows.length === 0 ? (
          <Empty>{query.trim() ? "No products match." : "No products."}</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map(r => <Row key={r.id} row={r} onRetry={retry} />)}
          </div>
        )}

        {more && (
          <div ref={sentinel} style={{ marginTop: 12 }}>
            {hasObserver ? (
              <div style={{ textAlign: "center", fontSize: 11.5, color: "rgba(233,238,255,.3)", padding: "10px 0" }}>
                {shown.length} of {pool}
              </div>
            ) : (
              <button onClick={() => setPageSize(n => n + PAGE)} style={{ ...bGray, width: "100%" }}>
                Show more · {shown.length} of {pool}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ row, onRetry }) {
  const t = row.totals;
  const total = t ? t.total : null;

  return (
    <div className="ts-row" style={{ background: "rgba(255,255,255,.022)", border: BORDER, borderRadius: 13, padding: 11, display: "flex", alignItems: "center", gap: 12 }}>
      <Thumb product={row.product} />
      <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {row.name}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, minWidth: 54 }}>
        {/* A read that FAILED must never render as 0 — that is a wrong number in
            front of a reorder decision. It gets a dash and a way to try again. */}
        {row.failed && total == null ? (
          <button onClick={() => onRetry(row.id)} style={{ ...bGray, padding: "6px 11px", fontSize: 11.5 }}>Retry</button>
        ) : (
          <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: total === 0 ? GRAY : "#fff" }}>
            {total == null ? "·" : total}
          </div>
        )}
      </div>
    </div>
  );
}
