// ─── ATTENTION ────────────────────────────────────────────────────────────────
// The buying screen: what to reorder, what's piled up, and what isn't selling —
// as a photo-first product grid rather than a spreadsheet.
//
// Deliberately NOT part of Inventory Health. Health is the refill engine's
// control centre (targets, exceptions, auto-transfers, decision queues); this is
// the owner's merchandising read of the same /stock tree, with none of that
// machinery in the way.
//
// Three views over one row shape — Low stock · Overstock · Not moving — each
// filterable by location scope, quantity rung, category, brand and free text,
// and sortable by quantity, cash value, name or size spread. Every row carries
// its photo, its size spread, where the stock physically sits, and the cash tied
// up in it at cost.
//
// Desktop-first: the grid is sized for a laptop and up, which is where buying
// decisions actually get made.

import React, { useEffect, useMemo, useState } from "react";
import { get, orderByChild, query, ref, startAt } from "firebase/database";
import { database } from "../../firebase";
import { useStockCells } from "./useStock";
import {
  buildAttentionIndex, selectAttentionRows, summarise, brandOptions,
  soldUnitsByProduct, receivedProductIds,
  VIEW_LOW, VIEW_OVER, VIEW_DEAD, LOW_STEPS, OVER_STEPS, DEFAULT_LOW_STEP, DEFAULT_OVER_STEP,
  DEAD_WINDOWS, SORTS, SCOPE_ALL, SCOPE_SHOPS, SCOPE_WAREHOUSE, SHOP_LOCATIONS, locationLabel,
} from "./attentionCore";
import { TOP_CATEGORIES, UNCATEGORIZED_TOP } from "../../utils/productCategory";
import { FONT, GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, tabOn, tabOff, input } from "./ui";

const DAY_MS = 86400000;

// Rows render in pages so a 1,600-style list can't stall the tab; "Show more"
// walks it. Photos are lazy so the cost of a page is DOM, not bandwidth.
const PAGE = 48;

const VIEWS = [
  { id: VIEW_LOW,  label: "Low stock",  blurb: "Running out — reorder these" },
  { id: VIEW_OVER, label: "Overstock",  blurb: "Piled up — cash sitting still" },
  { id: VIEW_DEAD, label: "Not moving", blurb: "In stock, but not selling" },
];

const WAREHOUSE_LOCATIONS = ["hub1", "hub2", "hub3", "central", "base", "studio"];

const zar = (n) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(n || 0);
const count = (n) => new Intl.NumberFormat("en-ZA").format(n || 0);

// ── Movement ledger, windowed ────────────────────────────────────────────────
// One-shot, and only for the Not-moving view. /stock_movements is a large
// append-only ledger; a live subscription to all of it would be far more than a
// buying screen needs. The range query runs server-side on `ts` (the node
// carries .indexOn: "ts"), so only the window transfers — and `ts` is an ISO
// string, hence the ISO bound.
function useSoldWindow({ enabled, days, reloadToken }) {
  const [state, setState] = useState({ movements: null, sinceMs: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const sinceMs = Date.now() - days * DAY_MS;
    get(query(ref(database, "stock_movements"), orderByChild("ts"), startAt(new Date(sinceMs).toISOString())))
      .then((snap) => {
        if (cancelled) return;
        setState({ movements: snap.val() || {}, sinceMs });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Attention: movement read failed:", err);
        setError(err);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [enabled, days, reloadToken]);

  // Filtered against the SAME cutoff the query used, so the sold set can never
  // include a movement from outside the window.
  const soldMap = useMemo(() => soldUnitsByProduct(state.movements, state.sinceMs), [state]);
  const arrivedSet = useMemo(() => receivedProductIds(state.movements, state.sinceMs), [state]);

  return { soldMap, arrivedSet, ready: state.movements !== null, loading, error };
}

export default function AttentionView({ products, onExit }) {
  const [view, setView] = useState(VIEW_LOW);
  const [scope, setScope] = useState(SCOPE_ALL);
  const [lowStepId, setLowStepId] = useState(DEFAULT_LOW_STEP);
  const [overStepId, setOverStepId] = useState(DEFAULT_OVER_STEP);
  const [category, setCategory] = useState("all");
  const [brand, setBrand] = useState("all");
  const [sortId, setSortId] = useState("qtyAsc");
  const [search, setSearch] = useState("");
  const [days, setDays] = useState(DEAD_WINDOWS[0].days);
  const [hideJustArrived, setHideJustArrived] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [reloadToken, setReloadToken] = useState(0);

  const dead = view === VIEW_DEAD;
  const stockTree = useStockCells();
  const { soldMap, arrivedSet, ready: movementsReady, loading: movementsLoading, error: movementsError } =
    useSoldWindow({ enabled: dead, days, reloadToken });

  const productsById = useMemo(() => {
    const out = {};
    for (const p of products || []) if (p?.id) out[p.id] = p;
    return out;
  }, [products]);

  const index = useMemo(() => buildAttentionIndex(stockTree), [stockTree]);
  const stockReady = stockTree && Object.keys(stockTree).length > 0;

  // Rows BEFORE the brand filter — the brand picker is built from these, so it
  // only ever offers brands that would actually return something.
  const rowsPreBrand = useMemo(() => {
    if (!stockReady) return [];
    if (dead && !movementsReady) return [];
    return selectAttentionRows({
      index, productsById, view, scope, lowStepId, overStepId,
      category, brand: "all", search, sortId,
      soldMap, arrivedSet, hideJustArrived,
    });
  }, [stockReady, dead, movementsReady, index, productsById, view, scope, lowStepId,
      overStepId, category, search, sortId, soldMap, arrivedSet, hideJustArrived]);

  const brands = useMemo(() => brandOptions(rowsPreBrand), [rowsPreBrand]);
  const rows = useMemo(
    () => (brand === "all" ? rowsPreBrand : rowsPreBrand.filter((r) => r.brand === brand)),
    [rowsPreBrand, brand],
  );
  const stats = useMemo(() => summarise(rows), [rows]);

  // A brand that's no longer offered would silently show zero rows.
  useEffect(() => {
    if (brand !== "all" && !brands.some((b) => b.brand === brand)) setBrand("all");
  }, [brands, brand]);

  // Any filter change starts the list from the top again.
  useEffect(() => { setLimit(PAGE); },
    [view, scope, lowStepId, overStepId, category, brand, search, sortId, days, hideJustArrived]);

  const busy = !stockReady || (dead && movementsLoading);
  const shown = rows.slice(0, limit);
  const activeView = VIEWS.find((v) => v.id === view);

  const chip = (on) => ({ ...(on ? tabOn : tabOff), padding: "6px 12px", fontSize: "0.78rem" });

  return (
    <div style={{ fontFamily: FONT, color: "#fff", padding: "18px 22px 40px", maxWidth: 1680, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onExit} style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.25)", color: BLUE_L, borderRadius: 10, padding: "9px 13px", fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: FONT }}>← Back</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: "-.01em" }}>Attention</div>
          <div style={{ fontSize: 12.5, color: GRAY, marginTop: 2 }}>{activeView?.blurb}</div>
        </div>
        <button
          onClick={() => setReloadToken((n) => n + 1)}
          disabled={busy}
          style={{ background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.14)", color: "#dfe7ff", borderRadius: 10, padding: "9px 14px", fontWeight: 700, fontSize: 12.5, cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1, fontFamily: FONT }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* View switcher */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {VIEWS.map((v) => {
          const on = view === v.id;
          return (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              aria-pressed={on}
              style={{
                ...GLASS, fontFamily: FONT, cursor: "pointer", textAlign: "left",
                padding: "11px 16px", minWidth: 176,
                border: on ? "1px solid rgba(74,127,255,.55)" : "1px solid rgba(255,255,255,.08)",
                background: on ? "rgba(74,127,255,.13)" : GLASS.background,
              }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 800, color: on ? "#fff" : "#cfd8ee" }}>{v.label}</div>
              <div style={{ fontSize: 10.5, color: on ? BLUE_L : GRAY, marginTop: 3 }}>{v.blurb}</div>
            </button>
          );
        })}
      </div>

      {/* Headline numbers for the current filter */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 14 }}>
        <Kpi label="Styles" value={busy ? "…" : count(stats.styles)} tone={BLUE_L} />
        <Kpi label="Units" value={busy ? "…" : count(stats.units)} tone="#fff" />
        <Kpi
          label="Cash at cost"
          value={busy ? "…" : zar(stats.value)}
          tone={view === VIEW_OVER ? AMBER : GREEN}
          sub={stats.valueMissing > 0 ? `${count(stats.valueMissing)} of ${count(stats.styles)} have no cost price` : "all styles priced"}
        />
      </div>

      {/* Filters */}
      <div style={{ ...GLASS, padding: "13px 15px", marginBottom: 16, display: "flex", flexDirection: "column", gap: 11 }}>
        <FilterRow label="Where">
          <button onClick={() => setScope(SCOPE_ALL)} style={chip(scope === SCOPE_ALL)}>Everywhere</button>
          <button onClick={() => setScope(SCOPE_SHOPS)} style={chip(scope === SCOPE_SHOPS)}>All shops</button>
          <button onClick={() => setScope(SCOPE_WAREHOUSE)} style={chip(scope === SCOPE_WAREHOUSE)}>All warehouse</button>
          <span style={{ width: 1, alignSelf: "stretch", background: "rgba(255,255,255,.1)", margin: "0 3px" }} />
          {SHOP_LOCATIONS.map((loc) => (
            <button key={loc} onClick={() => setScope(loc)} style={chip(scope === loc)}>{locationLabel(loc)}</button>
          ))}
          {WAREHOUSE_LOCATIONS.map((loc) => (
            <button key={loc} onClick={() => setScope(loc)} style={chip(scope === loc)}>{locationLabel(loc)}</button>
          ))}
        </FilterRow>

        {view === VIEW_LOW && (
          <FilterRow label="At or under">
            {LOW_STEPS.map((s) => (
              <button key={s.id} onClick={() => setLowStepId(s.id)} style={chip(lowStepId === s.id)}>{s.label}</button>
            ))}
          </FilterRow>
        )}
        {view === VIEW_OVER && (
          <FilterRow label="At or over">
            {OVER_STEPS.map((s) => (
              <button key={s.id} onClick={() => setOverStepId(s.id)} style={chip(overStepId === s.id)}>{s.label}</button>
            ))}
          </FilterRow>
        )}
        {dead && (
          <FilterRow label="No sales in">
            {DEAD_WINDOWS.map((w) => (
              <button key={w.days} onClick={() => setDays(w.days)} style={chip(days === w.days)}>{w.label}</button>
            ))}
            <span style={{ width: 1, alignSelf: "stretch", background: "rgba(255,255,255,.1)", margin: "0 3px" }} />
            <button
              onClick={() => setHideJustArrived((v) => !v)}
              style={chip(hideJustArrived)}
              title="Stock delivered inside the window hasn't had a chance to sell yet"
            >
              Hide just arrived
            </button>
          </FilterRow>
        )}

        <FilterRow label="Type">
          <button onClick={() => setCategory("all")} style={chip(category === "all")}>All</button>
          {[...TOP_CATEGORIES, UNCATEGORIZED_TOP].map((c) => (
            <button key={c} onClick={() => setCategory(c)} style={chip(category === c)}>{c}</button>
          ))}
        </FilterRow>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ ...input, padding: "8px 11px", fontSize: "0.82rem", minWidth: 170 }}>
            <option value="all">All brands</option>
            {brands.map((b) => <option key={b.brand} value={b.brand}>{b.brand} ({b.count})</option>)}
          </select>
          <select value={sortId} onChange={(e) => setSortId(e.target.value)} style={{ ...input, padding: "8px 11px", fontSize: "0.82rem", minWidth: 160 }}>
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, brand, type…"
            aria-label="Search products"
            style={{ ...input, padding: "8px 12px", fontSize: "0.85rem", flex: "1 1 240px", minWidth: 200 }}
          />
        </div>
      </div>

      {/* Results */}
      {movementsError && dead ? (
        <Empty tone={RED}>Couldn’t load the movement history{movementsError.message ? ` — ${movementsError.message}` : ""}.</Empty>
      ) : busy ? (
        <Empty>Loading stock…</Empty>
      ) : rows.length === 0 ? (
        <Empty>
          {search.trim()
            ? `Nothing matches “${search.trim()}”.`
            : dead
              ? `Everything in stock here has sold in the last ${days} days.`
              : "Nothing in this range — try a different quantity or location."}
        </Empty>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(268px, 1fr))", gap: 13 }}>
            {shown.map((r) => <AttentionCard key={r.id} row={r} view={view} />)}
          </div>
          {rows.length > shown.length && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
              <button
                onClick={() => setLimit((n) => n + PAGE)}
                style={{ background: "rgba(74,127,255,.12)", border: "1px solid rgba(74,127,255,.4)", color: BLUE_L, borderRadius: 11, padding: "11px 20px", fontWeight: 700, fontSize: "0.85rem", cursor: "pointer", fontFamily: FONT }}
              >
                Show more — {count(rows.length - shown.length)} left
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterRow({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: GRAY, textTransform: "uppercase", letterSpacing: ".06em", minWidth: 74 }}>{label}</span>
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <div style={{ ...GLASS, padding: "13px 15px" }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: GRAY, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ fontSize: 25, fontWeight: 800, color: tone, marginTop: 5, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: GRAY, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function Empty({ children, tone = GRAY }) {
  return <div style={{ ...GLASS, padding: "44px 20px", textAlign: "center", color: tone, fontSize: 13.5 }}>{children}</div>;
}

// One product. Photo-first, then the numbers a buying decision needs: how many,
// where they are, which sizes are left, and what it's worth at cost.
function AttentionCard({ row, view }) {
  const [failed, setFailed] = useState(false);
  const showPhoto = row.photo && !failed;
  const tone = view === VIEW_LOW ? RED : view === VIEW_OVER ? AMBER : BLUE_L;

  return (
    <div style={{ ...GLASS, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", aspectRatio: "1 / 1", background: "rgba(255,255,255,.03)" }}>
        {showPhoto ? (
          <img
            src={row.photo}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,.18)", fontSize: 40, fontWeight: 800 }}>
            {(row.name || "?").trim().charAt(0).toUpperCase()}
          </div>
        )}

        {/* Quantity badge — the number the whole screen is about. */}
        <div style={{ position: "absolute", top: 9, left: 9, background: "rgba(0,0,0,.72)", border: `1px solid ${tone}66`, borderRadius: 10, padding: "5px 10px", backdropFilter: "blur(6px)" }}>
          <span style={{ fontSize: 17, fontWeight: 800, color: tone }}>{count(row.total)}</span>
          <span style={{ fontSize: 10, color: GRAY, marginLeft: 4 }}>{row.total === 1 ? "unit" : "units"}</span>
        </div>

        {row.justArrived && (
          <div style={{ position: "absolute", top: 9, right: 9, background: "rgba(0,0,0,.72)", border: `1px solid ${GREEN}66`, color: GREEN, borderRadius: 999, padding: "4px 9px", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>
            just arrived
          </div>
        )}
      </div>

      <div style={{ padding: "11px 12px 12px", display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
            {row.name}
          </div>
          <div style={{ fontSize: 10.5, color: GRAY, marginTop: 3 }}>
            {[row.brand, row.subcategory || row.category].filter(Boolean).join(" · ")}
          </div>
        </div>

        {/* Money + shop/hub split */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 8 }}>
          <div>
            <div style={{ fontSize: 9.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em" }}>At cost</div>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: row.costValue == null ? GRAY : "#fff" }}>
              {row.costValue == null ? "—" : zar(row.costValue)}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em" }}>Shop / Hub</div>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>
              <span style={{ color: row.shop > 0 ? GREEN : GRAY }}>{count(row.shop)}</span>
              <span style={{ color: GRAY, margin: "0 4px" }}>/</span>
              <span style={{ color: row.warehouse > 0 ? BLUE_L : GRAY }}>{count(row.warehouse)}</span>
            </div>
          </div>
        </div>

        {/* Sizes left */}
        {row.sizes.length > 0 && (
          <div>
            <div style={{ fontSize: 9.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 5 }}>Sizes left</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {row.sizes.slice(0, 10).map((s) => (
                <span key={s.size} style={{ fontSize: 10.5, border: "1px solid rgba(74,127,255,.26)", background: "rgba(74,127,255,.08)", borderRadius: 7, padding: "3px 7px", whiteSpace: "nowrap" }}>
                  <b style={{ color: "#fff" }}>{s.size}</b>
                  <span style={{ color: GRAY, marginLeft: 4 }}>{s.qty}</span>
                </span>
              ))}
              {row.sizes.length > 10 && <span style={{ fontSize: 10.5, color: GRAY, alignSelf: "center" }}>+{row.sizes.length - 10}</span>}
            </div>
          </div>
        )}

        {/* Where it physically is */}
        {row.locations.length > 0 && (
          <div style={{ marginTop: "auto" }}>
            <div style={{ fontSize: 9.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 5 }}>Where</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {row.locations.slice(0, 4).map((l) => (
                <span key={l.loc} style={{ fontSize: 10, border: `1px solid ${l.shop ? "rgba(74,222,128,.3)" : "rgba(255,255,255,.14)"}`, background: l.shop ? "rgba(74,222,128,.08)" : "rgba(255,255,255,.04)", color: l.shop ? GREEN : "#cfd8ee", borderRadius: 7, padding: "3px 7px", whiteSpace: "nowrap" }}>
                  {l.label} <b>{l.qty}</b>
                </span>
              ))}
              {row.locations.length > 4 && <span style={{ fontSize: 10, color: GRAY, alignSelf: "center" }}>+{row.locations.length - 4}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
