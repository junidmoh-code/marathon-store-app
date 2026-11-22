// ─── MISSING PRODUCTS — ITS OWN SCREEN ────────────────────────────────────────
// Junid, 22 Nov 2026. Missing Products used to be a tab inside Inventory
// Health: three chips (Clothing / Perfume / Sneakers), a second switch for the
// division nested inside each, two different card layouts and a button that
// read "Close" where "Solve" had been. It is its own destination now — a home
// tile and a route — and it is built to be read on an iPhone between shops:
//
//   ONE switch at the top: Marathon / Concrete, each with how many are left.
//   ONE list per division — sneakers and everything else together, newest
//   upload first — with a search and two filters (category, brand).
//   ONE card shape (MissingCard.jsx): why it is here, what Central holds, one
//   action. Solve (everything that is not a sneaker) starts keeping it at a
//   shop; Request (sneakers) asks Central for the policy pairs into a hub.
//   After an action the card leaves; a strip at the top says what was just
//   queued, and "Queued & solved" keeps the rest.
//
// THIS FILE DECIDES NOTHING ABOUT STOCK. What is missing comes from the two
// cores that always decided it; what an action writes is the two hooks'
// (NetworkTransfer.jsx useProductSolve, MissingFootwear.jsx useSneakerRequest),
// unchanged. Here: which division, which cards to show, in what order.
//
// READS: exactly the nodes the old tab subscribed to through Inventory Health
// and its children — /stock, /stock_targets, /refill_requests, the small
// hidden / held / engine-config nodes — through the same shared, mirror-backed
// hooks (one listener per path for the whole app). Nothing new is opened.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { BG, FONT, GLASS, GRAY, GREEN, AMBER, BLUE_L, input } from "./ui";
import { useStockCells, useStockTargetsState, useHiddenMissingProducts, useRefillRequests, useStockHeld, useEngineConfigState } from "./useStock";
import { useMySections } from "../../utils/useMySections";
import { sectionName } from "../../utils/networkRegistry";
import { hubIds, storeIds, centralId, nameOf } from "./sectionRouting";
import { computeMissingProducts } from "./missingProductsCore";
import { computeMissingFootwear } from "./missingFootwearCore";
import { partitionHidden } from "./hiddenProductsCore";
import { partitionQueued, buildRows, filterRows, facet } from "./missingScreenCore";
import { useProductSolve } from "./NetworkTransfer";
import { useSneakerRequest } from "./MissingFootwear";
import HiddenProducts, { HoldSpot } from "./HiddenProducts";
import { PhotoLightbox } from "./healthWidgets";
import { CardPhoto } from "./MissingCard";
import { primaryPhotoUrl } from "../../utils/primaryPhoto";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";

// The division shown first, and the order of the switch: Marathon, Concrete.
const DIVISION_ORDER = [2, 1];
// How long a card this device has just queued stays off the list before the
// live request records alone decide (their echo is normally 1–2 s).
const QUEUED_HOLD_MS = 90000;
// How long "just queued" stays at the top of the list.
const NOTE_MS = 120000;
// Cards drawn at once; the rest are one tap away (a phone draws 40 instantly,
// 400 with a stutter).
const PAGE = 40;
// "Nothing is resolving" — one object, so a division with nothing in flight
// hands the Solve hook the same value on every render.
const NONE = Object.freeze({});

const select = { ...input, width: "100%", boxSizing: "border-box", fontSize: 16, minHeight: 46, padding: "10px 12px", appearance: "none", WebkitAppearance: "none" };
const tab = (on) => ({
  minHeight: 42, padding: "9px 15px", borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
  border: on ? "1px solid rgba(60,110,255,.55)" : "1px solid rgba(255,255,255,.12)",
  background: on ? "rgba(60,110,255,.16)" : "rgba(255,255,255,.03)", color: on ? BLUE_L : "rgba(255,255,255,.55)",
});

export default function MissingProductsScreen({ products = [], onExit }) {
  const { registry: network, sections: mySections } = useMySections();
  const allStock = useStockCells();
  const targetsState = useStockTargetsState();
  const hiddenMap = useHiddenMissingProducts();
  const requests = useRefillRequests();
  const heldLines = useStockHeld();
  const cfg = useEngineConfigState().raw;
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const CENTRAL = centralId(network);

  const divisions = useMemo(
    () => DIVISION_ORDER.filter((s) => mySections.includes(s) && (storeIds(network, { section: s }).length > 0 || hubIds(network, { section: s }).length > 0)),
    [network, mySections],
  );
  const [pick, setPick] = useState(null);
  const section = divisions.includes(pick) ? pick : divisions[0];

  // Never count against a half-loaded /stock: a zero then would say "nothing
  // is missing" at the moment nothing is known.
  const stockReady = !!allStock && Object.keys(allStock).length > 0;

  // Cards this device has just queued, per division: `${section}|${pid}`.
  const [justQueued, setJustQueued] = useState({});
  const queueTimers = useRef({});
  // Cards just solved, hidden at once, per division (useProductSolve's
  // `resolving`): { [section]: { pid: "pending" | "done" } }. Per division so
  // a Marathon solve never hides the same product's card on Concrete.
  const [resolving, setResolving] = useState({});
  const [solvedSession, setSolvedSession] = useState([]);
  const [notes, setNotes] = useState([]);   // what was just requested: { id, pid, name, msg }
  const noteTimers = useRef({});
  useEffect(() => () => {
    for (const t of Object.values(queueTimers.current)) clearTimeout(t);
    for (const t of Object.values(noteTimers.current)) clearTimeout(t);
  }, []);

  // ── EVERY DIVISION'S CARDS, ONCE — the counts and the list read the same ──
  // THE WALKS (the catalogue against /stock) are memoised on what they read,
  // and nothing else: a request echo, a just-queued mark or a card resolving
  // re-runs only the cheap partition below, never the walk.
  const walked = useMemo(() => {
    const out = {};
    for (const sec of divisions) {
      const hubs = hubIds(network, { section: sec });
      // Marathon's is the call this list has always made; Concrete's names
      // its section and takes the engine config (central-fed shops).
      const all = !stockReady ? [] : sec === 2
        ? computeMissingProducts({ allStock, products })
        : computeMissingProducts({ allStock, products, network, section: sec, centralFed: cfg });
      const sneakers = !stockReady ? [] : computeMissingFootwear({ allStock, products, hubs, heldLines, central: CENTRAL });
      out[sec] = { all, sneakers, hubs };
    }
    return out;
  }, [divisions, stockReady, allStock, products, network, cfg, heldLines, CENTRAL]);

  const lists = {};
  for (const sec of divisions) {
    const { all, sneakers: allSneakers, hubs } = walked[sec];
    // HIDE — a view filter, strictly downstream of the compute (hiddenProductsCore.js).
    const visible = partitionHidden(all, hiddenMap).visible;
    const local = Object.fromEntries(Object.keys(justQueued).filter((k) => k.startsWith(`${sec}|`)).map((k) => [k.slice(String(sec).length + 1), true]));
    const sneakers = partitionQueued(allSneakers, requests, hubs, local);
    const gone = resolving[sec] || {};
    lists[sec] = { all, visible, sneakers, hubs, count: visible.filter((c) => !gone[c.pid]).length + sneakers.todo.length };
  }

  const onQueued = (sec) => (pid, hubs, msg) => {
    const k = `${sec}|${pid}`;
    setJustQueued((m) => ({ ...m, [k]: true }));
    clearTimeout(queueTimers.current[k]);
    queueTimers.current[k] = setTimeout(() => setJustQueued((m) => { const n = { ...m }; delete n[k]; return n; }), QUEUED_HOLD_MS);
    const id = `${k}|${Date.now()}`;
    setNotes((l) => [{ id, pid, section: sec, name: byId.get(pid)?.name || pid, msg }, ...l].slice(0, 5));
    noteTimers.current[id] = setTimeout(() => setNotes((l) => l.filter((x) => x.id !== id)), NOTE_MS);
  };

  const [view, setView] = useState("todo");   // "todo" | "done" | "hidden"
  const [lightbox, setLightbox] = useState(null);
  const onPhoto = (p) => { const url = primaryPhotoUrl(p) || p?.photoUrl; if (url) setLightbox(url); };

  const hiddenCards = useMemo(() => {
    const seen = new Set();
    return divisions.flatMap((s) => walked[s]?.all || []).filter((c) => (seen.has(c.pid) ? false : (seen.add(c.pid), true)));
  }, [divisions, walked]);

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "12px 12px 80px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <button data-action="exit" onClick={onExit} style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.25)", color: BLUE_L, borderRadius: 11, padding: "10px 14px", minHeight: 44, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: FONT }}>← Back</button>
          <div style={{ fontSize: 19, fontWeight: 800 }}>Missing Products</div>
        </div>

        {/* THE ONE SWITCH: which division's list, and how many are left on each. */}
        <div role="tablist" aria-label="Division" style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(divisions.length, 1)}, 1fr)`, gap: 8, marginBottom: 12, position: "sticky", top: 0, zIndex: 5, background: BG, padding: "6px 0" }}>
          {divisions.map((sec) => {
            const on = sec === section;
            return (
              <button key={sec} role="tab" aria-selected={on} data-division={sec} onClick={() => { setPick(sec); setView("todo"); }}
                style={{ minHeight: 64, borderRadius: 15, cursor: "pointer", fontFamily: FONT, textAlign: "center", padding: "8px 6px",
                  border: on ? "1px solid rgba(60,110,255,.75)" : "1px solid rgba(255,255,255,.12)",
                  background: on ? "rgba(60,110,255,.22)" : "rgba(255,255,255,.03)", color: on ? "#fff" : "rgba(255,255,255,.55)" }}>
                <div style={{ fontSize: 16, fontWeight: 800 }}>{sectionName(network, sec)}</div>
                <div data-division-count={sec} style={{ fontSize: 12.5, fontWeight: 700, marginTop: 2, color: on ? BLUE_L : "rgba(255,255,255,.45)" }}>
                  {stockReady ? `${lists[sec].count} missing` : "…"}
                </div>
              </button>
            );
          })}
        </div>

        {!divisions.length && <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 14 }}>No division is open to this account.</div>}

        {section != null && (
          <DivisionList key={section} section={section} network={network} products={products} byId={byId} allStock={allStock}
            list={lists[section]} stockReady={stockReady} targetsState={targetsState} hiddenMap={hiddenMap} hiddenCards={hiddenCards}
            resolving={resolving[section] || NONE}
            setResolving={(fn) => setResolving((all) => {
              const cur = all[section] || NONE;
              const next = typeof fn === "function" ? fn(cur) : fn;
              return next === cur ? all : { ...all, [section]: next };
            })}
            solvedSession={solvedSession} setSolvedSession={setSolvedSession}
            notes={notes.filter((n) => n.section === section)} dismissNote={(id) => setNotes((l) => l.filter((x) => x.id !== id))}
            onQueued={onQueued(section)} view={view} setView={setView} onPhoto={onPhoto} />
        )}
      </div>
      <PhotoLightbox url={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

// One division's list. Keyed by the division, so switching starts every open
// panel, tick and filter afresh — nothing chosen on Marathon can ride into a
// Concrete confirm.
function DivisionList({ section, network, products, byId, allStock, list, stockReady, targetsState, hiddenMap, hiddenCards, resolving, setResolving, solvedSession, setSolvedSession, notes, dismissNote, onQueued, view, setView, onPhoto }) {
  const division = sectionName(network, section);
  const solve = useProductSolve({
    products, category: "all", allStock, cards: list.visible, section,
    targets: targetsState.value, targetsSettled: targetsState.settled, targetsError: targetsState.error,
    solvedSession, setSolvedSession, resolving, setResolving, onOpenSolved: () => setView("done"), onPhoto,
  });
  const request = useSneakerRequest({ products, section, cards: list.sneakers.todo, onQueued, onPhoto });

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(
    () => buildRows({ productCards: solve.cards, sneakerCards: solve.selectMode ? [] : request.cards, byId, categoryKeyOf: effectiveCategoryKey }),
    [solve.cards, request.cards, solve.selectMode, byId],
  );
  const categories = useMemo(() => facet(rows, "category"), [rows]);
  const brands = useMemo(() => facet(rows, "brand"), [rows]);
  // A filter whose last card has just left falls back to "all" rather than
  // showing an empty list under a value that is no longer offered.
  const cat = categories.some((c) => c.value === category) ? category : "";
  const br = brands.some((b) => b.value === brand) ? brand : "";
  const filtered = useMemo(() => filterRows(rows, { search, category: cat, brand: br }), [rows, search, cat, br]);
  const filtering = !!(search.trim() || cat || br);

  // Marking to hide works on the WHOLE division's list ("Mark all" marks every
  // card), so the search and filters are cleared and put away while marking —
  // a filtered view must never sit over a wider selection.
  // (The page limit stays: "Mark all" marks by product, not by what is drawn.)
  useEffect(() => { if (solve.selectMode) { setSearch(""); setCategory(""); setBrand(""); } setShown(PAGE); }, [solve.selectMode]);

  const waiting = list.sneakers.waiting;
  const hiddenCount = Object.keys(hiddenMap || {}).length;

  return (
    <>
      <div style={{ display: "flex", gap: 7, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button data-view="todo" onClick={() => setView("todo")} style={tab(view === "todo")}>To do</button>
        <button data-view="done" onClick={() => setView("done")} style={tab(view === "done")}>Queued &amp; solved{waiting.length ? ` (${waiting.length} waiting)` : ""}</button>
        {/* Once OPEN the hidden tab announces itself; its entrance stays the
            unlabelled press-and-hold spot at the end of this row
            (HiddenProducts.jsx HoldSpot — discretion, not access control). */}
        {view === "hidden" && <button data-view="hidden" onClick={() => setView("hidden")} style={tab(true)}>Hidden ({hiddenCount})</button>}
        <HoldSpot onTrigger={() => setView("hidden")} />
      </div>

      {view === "hidden" && <HiddenProducts products={products} cards={hiddenCards} hiddenMap={hiddenMap} />}

      {view === "done" && (
        <>
          <div style={{ fontSize: 13, fontWeight: 800, margin: "2px 2px 8px" }}>Waiting at Central — {division}</div>
          {!waiting.length && <div style={{ ...GLASS, padding: 14, color: GRAY, fontSize: 13, marginBottom: 14 }}>No sneaker request from this list is waiting at Central.</div>}
          {waiting.map(({ card, queue }) => (
            <div key={card.pid} data-waiting={card.pid} style={{ ...GLASS, display: "flex", gap: 11, alignItems: "center", padding: "10px 12px", marginBottom: 8 }}>
              <CardPhoto product={byId.get(card.pid)} productId={card.pid} snapshot={card.photo} size={52} />
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4 }}>
                <b>{card.name}</b>
                <div style={{ color: GRAY, fontSize: 12.5 }}>
                  {queue
                    ? `${queue.units} pair${queue.units === 1 ? "" : "s"} requested into ${queue.hubs.map((h) => nameOf(h, network)).join(" and ")} — ${queue.sizes.map((x) => `${x.size}×${x.qty}`).join(" · ")}. Central picks it from Source; it comes back to the list if the request is cancelled.`
                    : "Requested a moment ago — Central picks it from Source."}
                </div>
              </div>
            </div>
          ))}
          <div style={{ fontSize: 13, fontWeight: 800, margin: "16px 2px 8px" }}>Solved</div>
          {solve.solvedView}
        </>
      )}

      {view === "todo" && (
        <>
          {solve.viewOnly}
          {/* JUST QUEUED — the card has left the list; this says what happened to it. */}
          {notes.map((n) => (
            <div key={n.id} data-just-queued={n.pid} style={{ ...GLASS, display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", marginBottom: 8, border: "1px solid rgba(74,222,128,.4)" }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4, color: "rgba(255,255,255,.8)" }}>
                <b style={{ color: GREEN }}>Queued ✓</b> <b style={{ color: "#fff" }}>{n.name}</b> — {n.msg}
              </div>
              <button aria-label="Dismiss" onClick={() => dismissNote(n.id)} style={{ background: "none", border: "none", color: GRAY, fontSize: 20, lineHeight: 1, cursor: "pointer", minWidth: 40, minHeight: 40, fontFamily: FONT }}>×</button>
            </div>
          ))}
          {solve.strip}

          {!solve.selectMode && <>
          <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }} placeholder={`Search ${division}'s list…`} aria-label="Search"
            enterKeyHint="search" autoCapitalize="none" autoCorrect="off"
            style={{ ...input, width: "100%", boxSizing: "border-box", fontSize: 16, minHeight: 46, marginBottom: 8 }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <select aria-label="Category" value={cat} onChange={(e) => { setCategory(e.target.value); setShown(PAGE); }} style={select}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.value} value={c.value}>{c.value} ({c.count})</option>)}
            </select>
            <select aria-label="Brand" value={br} onChange={(e) => { setBrand(e.target.value); setShown(PAGE); }} style={select}>
              <option value="">All brands</option>
              {brands.map((b) => <option key={b.value} value={b.value}>{b.value} ({b.count})</option>)}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 2px 10px", minHeight: 40 }}>
            <div data-list-count style={{ flex: 1, fontSize: 12.5, color: GRAY }}>
              {!stockReady ? "Loading live stock…" : filtering ? `${filtered.length} of ${rows.length} shown · newest uploads first` : `${rows.length} missing from ${division} · newest uploads first`}
            </div>
            {filtering && <button data-action="clear-filters" onClick={() => { setSearch(""); setCategory(""); setBrand(""); }} style={{ ...tab(false), minHeight: 38, padding: "7px 12px", fontSize: 12.5 }}>Clear</button>}
          </div>
          </>}
          {solve.selectBar}
          {solve.selectMode && <div style={{ fontSize: 12, color: AMBER, margin: "0 2px 8px" }}>Marking to hide — sneakers are left out here; they have no Hide.</div>}

          {stockReady && !filtered.length && (
            <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 14, lineHeight: 1.45 }}>
              {filtering ? "Nothing on this list matches." : waiting.length
                ? `Nothing left to do for ${division} — the rest is queued at Central.`
                : `Nothing is missing from ${division}.`}
            </div>
          )}
          {filtered.slice(0, shown).map((r) => (r.kind === "sneaker" ? request.renderCard(r.card) : solve.renderCard(r.card)))}
          {filtered.length > shown && (
            <button data-action="show-more" onClick={() => setShown((n) => n + PAGE)} style={{ ...tab(false), display: "block", width: "100%", minHeight: 50, marginTop: 4 }}>
              Show {Math.min(PAGE, filtered.length - shown)} more ({filtered.length - shown} left)
            </button>
          )}
          {solve.bulkBar}
        </>
      )}
    </>
  );
}
