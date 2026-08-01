// ─── ATTENTION ────────────────────────────────────────────────────────────────
// The buying screen: what to reorder, what's piled up, and what isn't selling —
// as a photo-first product grid rather than a spreadsheet.
//
// Deliberately NOT part of Inventory Health. Health is the refill engine's
// control centre (targets, exceptions, auto-transfers, decision queues); this is
// the owner's merchandising read of the same /stock tree, with none of that
// machinery in the way.
//
// LAYOUT RULES this screen holds to:
//   • Every photo is the same size. The tile height is FIXED and the card never
//     stretches to its grid row, so a tall product can't make its neighbour's
//     photo a different shape.
//   • Filters are COLLAPSED behind their own value. Each control shows what it
//     is currently set to and opens on click — the long chip ladders are one
//     tap away instead of permanently filling the screen.
//   • The ✚ on a tile files a product into one of two fixed lists (Marketing
//     or Display) at /attention_lists — the ONLY thing this screen writes.
//     REVIEWING those lists lives in the Marketing workspace, not here: picking
//     belongs next to the stock and the photo, reviewing is a separate moment.
//   • The LIST is never split by location — a style is one line whose quantity
//     is everything we own, summed across every building. The CARD still says
//     where that stock sits ("269 Hub 2"). Sizes are never on the face of the
//     card — clicking a location floats them in a PORTAL, outside the grid
//     entirely, so opening one can never reflow the layout.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { get, orderByChild, query, ref, startAt } from "firebase/database";
import { database } from "../../firebase";
import { useStockCells } from "./useStock";
import {
  buildAttentionIndex, selectAttentionRows, summarise, locationBreakdown,
  soldUnitsByProduct, receivedProductIds, defaultSortFor,
  VIEW_LOW, VIEW_OVER, VIEW_DEAD, LOW_STEPS, OVER_STEPS, DEAD_MIN_STEPS,
  DEFAULT_LOW_STEP, DEFAULT_OVER_STEP, DEFAULT_DEAD_MIN, DEAD_WINDOWS, SORTS, findStep, findSort,
} from "./attentionCore";
import { TOP_CATEGORIES, UNCATEGORIZED_TOP } from "../../utils/productCategory";
import { listsHolding } from "./attentionLists";
import { useAttentionLists } from "./useAttentionLists";
import { FONT, GLASS, GLASS_SOLID, GRAY, GREEN, RED, AMBER, BLUE_L, input } from "./ui";

const DAY_MS = 86400000;
const PAGE = 48;
const PHOTO_H = 188;   // fixed — the whole point of the grid reading evenly

const VIEWS = [
  { id: VIEW_LOW,  label: "Low stock",  blurb: "Running out — reorder these" },
  { id: VIEW_OVER, label: "Overstock",  blurb: "Piled up — cash sitting still" },
  { id: VIEW_DEAD, label: "Not moving", blurb: "Real stock that isn't selling" },
];

const zar = (n) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(n || 0);
const count = (n) => new Intl.NumberFormat("en-ZA").format(n || 0);

// ── Movement ledger, windowed ────────────────────────────────────────────────
// One-shot, and only for the Not-moving view. A live subscription to the whole
// append-only ledger would be far more than a buying screen needs. The range
// query runs server-side on `ts` (the node carries .indexOn: "ts"), and `ts` is
// an ISO string — hence the ISO bound.
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
  const [lowStepId, setLowStepId] = useState(DEFAULT_LOW_STEP);
  const [overStepId, setOverStepId] = useState(DEFAULT_OVER_STEP);
  const [deadMinId, setDeadMinId] = useState(DEFAULT_DEAD_MIN);
  const [category, setCategory] = useState("all");
  const [sortId, setSortId] = useState(null);         // null = the view's own default
  const [search, setSearch] = useState("");
  const [days, setDays] = useState(DEAD_WINDOWS[0].days);
  const [hideJustArrived, setHideJustArrived] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [reloadToken, setReloadToken] = useState(0);
  const resultsRef = useRef(null);
  // Picking only. The lists themselves are REVIEWED in the Marketing
  // workspace — this screen just files products into them.
  const { lists, addToList, removeFromList } = useAttentionLists();

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
  const effectiveSort = sortId || defaultSortFor(view);

  const rows = useMemo(() => {
    if (!stockReady) return [];
    if (dead && !movementsReady) return [];
    return selectAttentionRows({
      index, productsById, view, lowStepId, overStepId, deadMinId,
      category, search, sortId: effectiveSort,
      soldMap, arrivedSet, hideJustArrived,
    });
  }, [stockReady, dead, movementsReady, index, productsById, view, lowStepId, overStepId,
      deadMinId, category, search, effectiveSort, soldMap, arrivedSet, hideJustArrived]);

  const stats = useMemo(() => summarise(rows), [rows]);

  // Changing a filter resets paging and scrolls the grid back into view. Without
  // the scroll, picking an option while deep in a long list left the viewport
  // parked past the new (shorter) results — the page HAD updated, but from where
  // the operator was sitting it looked like nothing had happened. `search` is
  // excluded deliberately: scrolling on every keystroke is hostile.
  useEffect(() => {
    setLimit(PAGE);
    resultsRef.current?.scrollIntoView({ block: "start" });
  }, [view, lowStepId, overStepId, deadMinId, category, sortId, days, hideJustArrived]);

  useEffect(() => { setLimit(PAGE); }, [search]);

  const busy = !stockReady || (dead && movementsLoading);
  const shown = rows.slice(0, limit);
  const activeView = VIEWS.find((v) => v.id === view);

  return (
    <div style={{ fontFamily: FONT, color: "#fff", padding: "18px 22px 44px", maxWidth: 1640, margin: "0 auto" }}>
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

      {/* View switcher — the one control that stays open, because it's the question being asked */}
      <div style={{ display: "flex", gap: 8, marginBottom: 13, flexWrap: "wrap" }}>
        {VIEWS.map((v) => {
          const on = view === v.id;
          return (
            <button
              key={v.id}
              onClick={() => { setView(v.id); setSortId(null); }}
              aria-pressed={on}
              style={{
                ...GLASS, fontFamily: FONT, cursor: "pointer", textAlign: "left", padding: "10px 16px", minWidth: 168,
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

      {/* Filters — each shows its current value and opens on click */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        {view === VIEW_LOW && (
          <Picker label="Quantity" value={findStep(LOW_STEPS, lowStepId, DEFAULT_LOW_STEP).label}
                  options={LOW_STEPS.map((s) => ({ id: s.id, label: s.label }))}
                  selected={lowStepId} onPick={setLowStepId} />
        )}
        {view === VIEW_OVER && (
          <Picker label="Quantity" value={findStep(OVER_STEPS, overStepId, DEFAULT_OVER_STEP).label}
                  options={OVER_STEPS.map((s) => ({ id: s.id, label: s.label }))}
                  selected={overStepId} onPick={setOverStepId} />
        )}
        {dead && (
          <>
            <Picker label="No sales in" value={`${days} days`}
                    options={DEAD_WINDOWS.map((w) => ({ id: String(w.days), label: w.label }))}
                    selected={String(days)} onPick={(id) => setDays(Number(id))} />
            <Picker label="At least" value={findStep(DEAD_MIN_STEPS, deadMinId, DEFAULT_DEAD_MIN).label}
                    options={DEAD_MIN_STEPS.map((s) => ({ id: s.id, label: s.label }))}
                    selected={deadMinId} onPick={setDeadMinId}
                    hint="A style down to its last one or two has nearly sold out — it isn't stagnant." />
          </>
        )}

        <Picker label="Type" value={category === "all" ? "All types" : category}
                options={[{ id: "all", label: "All types" }, ...[...TOP_CATEGORIES, UNCATEGORIZED_TOP].map((c) => ({ id: c, label: c }))]}
                selected={category} onPick={setCategory} />

        <Picker label="Sort" value={findSort(effectiveSort).label}
                options={SORTS.map((s) => ({ id: s.id, label: s.label }))}
                selected={effectiveSort} onPick={setSortId} />

        {dead && (
          <button
            onClick={() => setHideJustArrived((v) => !v)}
            title="Stock delivered inside the window hasn't had a chance to sell yet"
            style={{
              borderRadius: 10, padding: "9px 13px", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT,
              background: hideJustArrived ? "rgba(74,127,255,.16)" : "rgba(255,255,255,.04)",
              border: hideJustArrived ? "1px solid rgba(74,127,255,.5)" : "1px solid rgba(255,255,255,.12)",
              color: hideJustArrived ? BLUE_L : GRAY,
            }}
          >
            {hideJustArrived ? "✓ " : ""}Hide just arrived
          </button>
        )}

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          aria-label="Search products"
          style={{ ...input, padding: "8px 12px", fontSize: "0.85rem", flex: "1 1 190px", minWidth: 160, maxWidth: 320 }}
        />
      </div>

      {/* Headline numbers for the current filter */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Kpi label="Styles" value={busy ? "…" : count(stats.styles)} tone={BLUE_L} />
        <Kpi label="Units" value={busy ? "…" : count(stats.units)} tone="#fff" />
        <Kpi
          label="Cash at cost"
          value={busy ? "…" : zar(stats.value)}
          tone={view === VIEW_LOW ? GREEN : AMBER}
          sub={stats.valueMissing > 0 ? `${count(stats.valueMissing)} of ${count(stats.styles)} have no cost price` : "all styles priced"}
        />
      </div>

      {/* Results */}
      <div ref={resultsRef} style={{ scrollMarginTop: 14 }} />
      {movementsError && dead ? (
        <Empty tone={RED}>Couldn’t load the movement history{movementsError.message ? ` — ${movementsError.message}` : ""}.</Empty>
      ) : busy ? (
        <Empty>Loading stock…</Empty>
      ) : rows.length === 0 ? (
        <Empty>
          {search.trim()
            ? `Nothing matches “${search.trim()}”.`
            : dead
              ? `Nothing with ${findStep(DEAD_MIN_STEPS, deadMinId, DEFAULT_DEAD_MIN).label} has sat unsold for ${days} days.`
              : "Nothing in this range — try a different quantity."}
        </Empty>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))", gap: 12, alignItems: "start" }}>
            {shown.map((r) => (
              <AttentionCard
                key={r.id}
                row={r}
                view={view}
                lists={lists}
                onAdd={addToList}
                onRemove={removeFromList}
              />
            ))}
          </div>
          {rows.length > shown.length && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
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

// A filter that shows its own value and opens on click. Keeps the long ladders
// (the quantity rungs, the category list) off the screen until wanted, without
// hiding WHICH option is active — the trigger is the answer.
function Picker({ label, value, options, selected, onPick, hint, scroll }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={box} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 8, fontFamily: FONT, cursor: "pointer",
          background: open ? "rgba(74,127,255,.14)" : "rgba(255,255,255,.04)",
          border: open ? "1px solid rgba(74,127,255,.5)" : "1px solid rgba(255,255,255,.12)",
          borderRadius: 10, padding: "7px 12px",
        }}
      >
        <span style={{ fontSize: 9.5, fontWeight: 800, color: GRAY, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#fff" }}>{value}</span>
        <span style={{ fontSize: 9, color: GRAY, transform: open ? "rotate(180deg)" : "none", transition: "transform 120ms" }}>▼</span>
      </button>

      {open && (
        <div style={{
          ...GLASS_SOLID, position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 40,
          minWidth: 200, maxWidth: 300, padding: 6,
          maxHeight: scroll ? 320 : undefined, overflowY: scroll ? "auto" : undefined,
        }}>
          {hint && <div style={{ fontSize: 10.5, color: GRAY, padding: "6px 9px 8px", lineHeight: 1.45 }}>{hint}</div>}
          {options.map((o) => {
            const on = o.id === selected;
            return (
              <button
                key={o.id}
                onClick={() => { onPick(o.id); setOpen(false); }}
                style={{
                  display: "block", width: "100%", textAlign: "left", fontFamily: FONT, cursor: "pointer",
                  background: on ? "rgba(74,127,255,.16)" : "transparent",
                  border: "none", borderRadius: 8, padding: "9px 10px",
                  color: on ? "#fff" : "#cfd8ee", fontSize: 12.5, fontWeight: on ? 800 : 600,
                }}
              >
                {on ? "✓ " : ""}{o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <div style={{ ...GLASS, padding: "12px 15px" }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: GRAY, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: tone, marginTop: 5, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: GRAY, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function Empty({ children, tone = GRAY }) {
  return <div style={{ ...GLASS, padding: "48px 20px", textAlign: "center", color: tone, fontSize: 13.5 }}>{children}</div>;
}

// One product. The photo tile is a FIXED height and never stretches, so the grid
// reads as one even wall of images regardless of how much text sits underneath.
function AttentionCard({ row, view, lists, onAdd, onRemove }) {
  const [failed, setFailed] = useState(false);
  const showPhoto = row.photo && !failed;
  const tone = view === VIEW_LOW ? RED : view === VIEW_OVER ? AMBER : BLUE_L;
  // Shaped HERE, not in the selector: only the ~48 cards on screen pay for it,
  // instead of every one of the thousands of rows a filter can match.
  const locations = useMemo(() => locationBreakdown(row.entry.byLocation), [row.entry]);

  return (
    <div style={{ ...GLASS, overflow: "hidden" }}>
      <div style={{ position: "relative", height: PHOTO_H, background: "rgba(255,255,255,.03)", flexShrink: 0 }}>
        {showPhoto ? (
          <img
            src={row.photo}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,.16)", fontSize: 38, fontWeight: 800 }}>
            {(row.name || "?").trim().charAt(0).toUpperCase()}
          </div>
        )}

        <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(0,0,0,.74)", border: `1px solid ${tone}66`, borderRadius: 9, padding: "4px 9px" }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: tone }}>{count(row.total)}</span>
          <span style={{ fontSize: 9.5, color: GRAY, marginLeft: 4 }}>{row.total === 1 ? "unit" : "units"}</span>
        </div>

        <div style={{ position: "absolute", bottom: 8, right: 8 }}>
          <AddToList productId={row.id} lists={lists} onAdd={onAdd} onRemove={onRemove} />
        </div>

        {row.justArrived && (
          <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,.74)", border: `1px solid ${GREEN}66`, color: GREEN, borderRadius: 999, padding: "3px 8px", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>
            new
          </div>
        )}
      </div>

      <div style={{ padding: "10px 12px 12px" }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.3, height: "2.6em", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
          {row.name}
        </div>
        <div style={{ fontSize: 10.5, color: GRAY, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {[row.brand, row.subcategory || row.category].filter(Boolean).join(" · ")}
        </div>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, borderTop: "1px solid rgba(255,255,255,.07)", marginTop: 9, paddingTop: 8 }}>
          <span style={{ fontSize: 9.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em" }}>At cost</span>
          <span style={{ fontSize: 13, fontWeight: 800, color: row.costValue == null ? GRAY : "#fff" }}>
            {row.costValue == null ? "—" : zar(row.costValue)}
          </span>
        </div>

        {/* WHERE — quantity first, then the place: "269 Hub 2". No size
            breakdown on the face of the card; tapping a location floats it,
            because sizes are a follow-up question, not something worth spending
            the grid's whole surface on. */}
        {locations.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10 }}>
            {locations.map((l) => (
              <LocChip key={l.loc} label={l.label} qty={l.qty} shop={l.shop} sizes={l.sizes} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// "✚" on a product tile: send this product to Marketing or Display. Exactly
// two choices, always both, so picking is one tap and there's no naming step.
// The menu ticks whichever list already holds it, so the button also answers
// "have I already picked this?" — and tapping a ticked list takes it back out.
//
// Portalled for the same reason as the size panel: a menu laid out inside the
// card would be clipped by its neighbours and would drag the grid around.
function AddToList({ productId, lists, onAdd, onRemove }) {
  const [rect, setRect] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = rect !== null;

  const holding = useMemo(() => listsHolding(lists, productId), [lists, productId]);
  const inAny = holding.size > 0;
  const close = () => { setRect(null); setError(null); };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const onScroll = () => close();
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  // Every write is awaited and its failure surfaced. A pick that silently
  // failed to save is worse than one that never appeared to.
  const toggle = async (listId) => {
    setBusy(true); setError(null);
    try {
      if (holding.has(listId)) await onRemove(listId, productId);
      else await onAdd(listId, productId);
    } catch (err) {
      console.warn("Attention: list write failed:", err);
      setError(err?.message || "Could not save.");
    } finally { setBusy(false); }
  };

  const PANEL_W = 216;
  const left = rect ? Math.max(8, Math.min(rect.right - PANEL_W, window.innerWidth - PANEL_W - 8)) : 0;
  const below = rect ? rect.bottom + 190 < window.innerHeight : false;

  return (
    <>
      <button
        onClick={(e) => (open ? close() : setRect(e.currentTarget.getBoundingClientRect()))}
        title={inAny ? "Picked — tap to change" : "Add to Marketing or Display"}
        aria-expanded={open}
        style={{
          width: 28, height: 28, borderRadius: 9, cursor: "pointer", fontFamily: FONT,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 15, fontWeight: 800, lineHeight: 1,
          background: inAny ? "rgba(74,222,128,.9)" : "rgba(0,0,0,.72)",
          border: inAny ? `1px solid ${GREEN}` : "1px solid rgba(255,255,255,.28)",
          color: inAny ? "#04140a" : "#fff",
          backdropFilter: "blur(6px)",
        }}
      >
        {inAny ? "✓" : "+"}
      </button>

      {open && createPortal(
        <>
          {/* Full-screen catcher: one click anywhere else closes the menu. */}
          <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 4500 }} />
          <div style={{
            ...GLASS_SOLID, position: "fixed", left, zIndex: 4600,
            ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
            width: PANEL_W, padding: 7,
          }}>
            <div style={{ fontSize: 9.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", padding: "4px 7px 7px" }}>
              Add to
            </div>
            {lists.map((l) => {
              const on = holding.has(l.id);
              return (
                <button
                  key={l.id}
                  onClick={() => toggle(l.id)}
                  disabled={busy}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    fontFamily: FONT, cursor: busy ? "default" : "pointer", border: "none", borderRadius: 8,
                    padding: "10px 9px", background: on ? "rgba(74,222,128,.14)" : "transparent",
                    color: on ? "#fff" : "#cfd8ee",
                  }}
                >
                  <span style={{ color: on ? GREEN : "rgba(255,255,255,.25)", fontSize: 13 }}>{on ? "✓" : "＋"}</span>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: on ? 800 : 700 }}>{l.label}</span>
                    <span style={{ display: "block", fontSize: 10, color: GRAY, marginTop: 1 }}>{l.blurb}</span>
                  </span>
                  <span style={{ fontSize: 10, color: GRAY }}>{l.count}</span>
                </button>
              );
            })}
            {error && <div style={{ fontSize: 10.5, color: RED, padding: "6px 8px 2px" }}>{error}</div>}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

// A location on a product card — "269 Hub 2". Shops are tinted green so stock
// on a shop floor reads differently from stock in a warehouse at a glance.
//
// The size breakdown appears ONLY on click, and is rendered through a PORTAL as
// a fixed-position panel — not inside the card. Anything laid out within the
// card (even absolutely positioned) is at the mercy of the grid: it can be
// clipped by a neighbour's stacking context, and it drags the card's own
// geometry around. Escaping to the body means the grid NEVER reflows, whatever
// the panel does. It is also capped in height and scrolls internally, so a
// 20-size product can't produce a panel the length of the page.
//
// Moving the pointer off dismisses it, as do Escape, scrolling, resizing and a
// second click — a read-only panel shouldn't need a deliberate close.
function LocChip({ label, qty, shop, sizes }) {
  const [rect, setRect] = useState(null);
  const accent = shop ? GREEN : BLUE_L;
  const open = rect !== null;

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setRect(null);
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    // `true` — catch scrolling in any ancestor, not just the window, since a
    // fixed panel would otherwise hang in place while the grid moves under it.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = (e) => {
    if (open) { setRect(null); return; }
    setRect(e.currentTarget.getBoundingClientRect());
  };

  const PANEL_W = 232;
  const PANEL_MAX_H = 168;
  // Flip above the chip when there isn't room below, and keep the panel inside
  // the viewport horizontally so a card at the right edge doesn't push it off.
  const below = rect ? rect.bottom + PANEL_MAX_H + 10 < window.innerHeight : true;
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_W - 8)) : 0;

  return (
    <span style={{ display: "inline-block" }} onMouseLeave={() => setRect(null)}>
      <button
        onClick={toggle}
        aria-expanded={open}
        title={`Sizes at ${label}`}
        style={{
          fontFamily: FONT, cursor: "pointer", fontSize: 10.5, borderRadius: 6, padding: "3px 7px", whiteSpace: "nowrap",
          background: open ? `${accent}26` : "rgba(255,255,255,.04)",
          border: open ? `1px solid ${accent}` : "1px solid rgba(255,255,255,.12)",
          color: open ? "#fff" : "#cfd8ee",
        }}
      >
        <b style={{ color: accent }}>{qty}</b> {label}
      </button>

      {open && createPortal(
        <div
          role="tooltip"
          style={{
            ...GLASS_SOLID, position: "fixed", left, zIndex: 4000,
            ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
            width: PANEL_W, maxHeight: PANEL_MAX_H, overflowY: "auto", padding: "8px 9px",
            pointerEvents: "none",
          }}
        >
          <div style={{ fontSize: 9.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>
            {label} · {qty} {qty === 1 ? "unit" : "units"}
          </div>
          {sizes.length === 0 ? (
            <div style={{ fontSize: 10.5, color: GRAY }}>No sizes recorded.</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {sizes.map((sz) => (
                <span key={sz.size} style={{ fontSize: 10.5, border: `1px solid ${accent}40`, background: `${accent}14`, borderRadius: 6, padding: "3px 7px", whiteSpace: "nowrap" }}>
                  <b style={{ color: "#fff" }}>{sz.size}</b>
                  <span style={{ color: GRAY, marginLeft: 4 }}>{sz.qty}</span>
                </span>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
