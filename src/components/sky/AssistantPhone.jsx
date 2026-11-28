// ─── STORE ASSISTANT ORDER VIEW, PHONE (design/assistant-phone.png) ─────────
//
// The phone/iPad-portrait breakpoint of the order screen, on the sky DNA.
// Compact top band (Junid, 5 Nov): header with the STORE pill under the
// wordmark (tap → store popover), a compact Sneakers / Clothing toggle, the
// search pill with the camera (the tongue-label scan), the brand strip, two-up
// cards with a plus, and the glass cart bar. No store row, no "Place order"
// heading — the first card row sits above the fold on a phone.
//
// Presentation only. Every handler is AssistantView's own, passed straight
// through: a card or its plus opens the existing size sheet, the camera opens
// the existing label finder, a store pick asks the existing red switch-confirm,
// the bar opens the existing checkout. Nothing here reads or writes data.

import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SkyHeader, SkyBackGrid, SkySearch, SkyBrandStrip, SkyStorePill, SkyPopover, ProductStage, SkyPlus, SkyBottomBar } from "./Sky.jsx";
import { fmtR } from "../assistant/assistantOrderModel.js";
import { retailPriceOf } from "../../utils/retailPrice";
import { tilePhotoSrc } from "../assistant/HiResPhoto.jsx";
import { noteTileScroll, setTilePrefetchPlan, slowConnection } from "../../offline/tilePrefetch";

export default function AssistantPhone({
  mode, onMode,
  shops, effectiveShop, shopLabel, onShop,
  search, onSearch, onScan,
  products, selectedId, onOpen, onViewPhotos, photoCount, renderActions, renderDeactivated, isDead,
  cartCount, cartLabel = "View order", onCart, cartDisabled = false,
  brands = null, brand = "All", onBrand = null,
  onExit, who = "", children = null, emptyText = "No products match your search.", showGrid = true, showBar = true,
}) {
  const [me, setMe] = useState(false);
  // LIKE THE LAPTOP (Junid, 6 Nov): the header and the search are FIXED at the
  // top on no background; the brand logos sit on the sky with nothing
  // behind them; only the shoes scroll — in their own area (.ap-scroll) that
  // starts under the search, so nothing ever slides behind the header or the
  // search box. (A sticky band was cancelled by AssistantView's
  // overflow-x:hidden wrapper and scrolled away on real phones.)
  const topRef = useRef(null), brandsRef = useRef(null), scrollRef = useRef(null);
  const [topH, setTopH] = useState(0);
  const [brandsH, setBrandsH] = useState(0);
  useLayoutEffect(() => {
    // The brand row can go (refill mode, one brand): its height goes with it,
    // or the scroller would keep a gap where it was (CodeRabbit).
    if (!brandsRef.current) setBrandsH(0);
    const els = [[topRef.current, setTopH], [brandsRef.current, setBrandsH]].filter(([el]) => el);
    const set = () => els.forEach(([el, f]) => f(Math.round(el.getBoundingClientRect().height)));
    set();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(set);
    els.forEach(([el]) => ro.observe(el));
    return () => ro.disconnect();
  }, [brands && brands.length > 1 && onBrand ? 1 : 0]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ap-root" data-testid="assistant-phone">
      <style>{AP_CSS}</style>
      <div className="ap-top" ref={topRef} data-testid="ap-top">
      {/* The store pill replaces the old ASSISTANT tag and the store row.
          Only the shops this account is assigned to; with one (auto-selected)
          it is a plain pill, so nobody can mis-pick a store that is not theirs. */}
      <SkyHeader left={<SkyBackGrid back onBack={onExit} onLongPress={onExit} label="Back to Home" />}
                 tagNode={<span className="ap-store" data-contrast-exempt=""><SkyStorePill value={effectiveShop} stores={shops} labelOf={shopLabel}
                                        onPick={(id) => { if (id !== effectiveShop) onShop(id); }}
                                        mode={mode === "clothing" ? "clothing" : mode === "cr" ? "cr" : "sneaker"}
                                        modes={onMode ? [["sneaker", "Sneakers"], ["clothing", "Clothing"]] : null} onMode={onMode} /></span>}
                 onUser={() => setMe((v) => !v)} userLabel="Account" />
      {/* The account menu, on THE ONE OVERLAY (a bottom sheet on a phone). */}
      <SkyPopover open={me} onClose={() => setMe(false)} label="Account" testId="account-popover">
        <div className="sky-pop__who">{who || "Store assistant"}</div>
        <div className="sky-pop__sub">Store assistant{effectiveShop ? ` · ${shopLabel(effectiveShop)}` : ""}</div>
        <button type="button" className="sky-pop__i" onClick={() => { setMe(false); onExit(); }}>Switch view</button>
      </SkyPopover>

      <div className="ap-search">
        <SkySearch value={search} onChange={onSearch} onAction={onScan} action="camera" actionLabel="Find by the tongue label" />
      </div>

      </div>

      {/* The brand strip — phones only (below 768px; the CSS hides it above).
          The same brand value as the desktop chip row (AssistantView). It
          sits on the sky with no background; since 27 Nov the cards no longer
          scroll under it (the scroller starts below it). */}
      {brands && brands.length > 1 && onBrand ? (
        <div className="ap-brandsfloat" ref={brandsRef} data-contrast-exempt="" data-testid="ap-brands-float" style={{ top: topH }}>
          <SkyBrandStrip className="ap-brands" brands={brands} value={brand} onChange={onBrand} />
        </div>
      ) : null}

      {/* THE ONLY SCROLLER: everything from here down. Its top is the bottom of
          the BRAND ROW (Junid's recording, 27 Nov: cards slid under and over
          the logos and the search) — so the header block, logos included,
          stays put and the cards clip cleanly at its edge. At rest the first
          row sits exactly where it did (the 11px gap is unchanged). */}
      <div className="ap-scroll" ref={scrollRef} data-scroll="" data-testid="ap-scroll" style={{ top: topH + brandsH, paddingTop: 11 }}>

      {children}

      {showGrid && (products.length === 0 ? (
        <div className="ap-empty sky-glass">{emptyText}</div>
      ) : (
        <ApGrid products={products} scrollRef={scrollRef} selectedId={selectedId}
                handlers={{ onOpen, onViewPhotos, photoCount, renderActions, renderDeactivated, isDead }} />
      ))}

      {/* Bottom room for the cart bar + safe area, so the last row is never under it. */}
      <div style={{ height: "var(--sky-bar-space)" }} />
      </div>
      {showBar && cartCount > 0 ? <SkyBottomBar count={cartCount} onOpen={onCart} label={cartLabel} disabled={cartDisabled} /> : null}
    </div>
  );
}

// ─── THE GRID: NEVER EMPTY, PHOTOS WINDOWED (Junid's recording, 27 Nov) ─────
//
// Measured in the harness (scripts/sky-perf/phone-scroll.mjs, 1,500 cards):
//   • .sky-card's `content-visibility: auto` was the blank cards — WebKit (the
//     iPhone's engine) skipped painting a card's insides until it was nearly
//     on screen, so a fling showed bare glass that filled in a second later —
//     and it was the main cost of the scroll in WebKit too. It is off here.
//   • every card's text and glass is drawn all the time: no style toggles
//     (switching a card's look re-styles the whole list in WebKit — measured).
//   • only the PHOTO is windowed: a card within WINDOW_MARGIN of the visible
//     part of the scroller (2.5 screens above and below) mounts its full photo;
//     the rest hold the stage at the same height with the placeholder. That
//     keeps the decoded full-resolution photos to a few dozen instead of 1,500
//     (a phone would otherwise hold gigabytes of bitmaps after one long scroll).
// The list is observed in chunks of CHUNK_ROWS rows; chunks are memoised, so a
// scroll re-renders only the chunks whose photos turn on or off.
export const CHUNK_ROWS = 4;
export const WINDOW_MARGIN = "250% 0px";
// save-data / 2g / slow-2g: what is on screen and one screen on, nothing more.
export const WINDOW_MARGIN_SLOW = "100% 0px";
// Prefetch: this many chunks below the window first, then the rest.
const AHEAD_CHUNKS = 3;
// How many leading chunks show photos before the observer has answered, so
// the first screen never starts without them.
// (one chunk on save-data / 2g: on screen and no more).
const INITIAL_LIVE = 3;
const INITIAL_LIVE_SLOW = 1;
// The most chunks whose photos are mounted at once (~320 photos at 2 columns).
export const MAX_LIVE_CHUNKS = 40;
const FIRST_CHUNKS = 5;
const GROW_CHUNKS = 8;

// Columns as the CSS grid lays them out (the same breakpoints as .ap-grid).
export function apColumns(width) { return width >= 820 ? 4 : width >= 600 ? 3 : 2; }
function useColumns() {
  const get = () => (typeof window === "undefined" ? 2 : apColumns(window.innerWidth || 390));
  const [cols, setCols] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || !window.addEventListener) return undefined;
    const on = () => setCols(get());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return cols;
}

export function chunkList(products, size) {
  const out = [];
  for (let i = 0; i < products.length; i += size) out.push(products.slice(i, i + size));
  return out;
}

function ApGrid({ products, scrollRef, selectedId, handlers }) {
  const cols = useColumns();
  const size = cols * CHUNK_ROWS;
  const chunks = useMemo(() => chunkList(products, size), [products, size]);
  // The handlers change identity on every parent render; the chunks read them
  // through this ref so a cart or stock update does not re-render 1,500 cards.
  const h = useRef(handlers);
  h.current = handlers;
  const [live, setLive] = useState(() => new Set(Array.from({ length: slowConnection() ? INITIAL_LIVE_SLOW : INITIAL_LIVE }, (_, i) => i)));
  // FIRST PAINT FAST: the first FIRST_CHUNKS chunks (about three screens) are
  // drawn at once; the rest of the list follows GROW_CHUNKS at a time in idle
  // slots straight after — small commits, so the first screen and its photos
  // never wait on 1,500 cards and a commit never blocks a frame for long. The
  // list simply grows below; nothing is drawn empty.
  const [drawnN, setDrawnN] = useState(FIRST_CHUNKS);
  // A new list (search, brand, shop, division) starts small again, so a switch
  // to another long list is never one 1,500-card commit — but only while the
  // list is near its top: a stock update re-sorting the list under someone
  // scrolled far down must not pull the floor out from under them.
  const lastList = useRef(products);
  if (lastList.current !== products) {
    lastList.current = products;
    const el = scrollRef.current;
    const nearTop = !el || el.scrollTop < (el.clientHeight || 800);
    if (nearTop && drawnN !== FIRST_CHUNKS) setDrawnN(FIRST_CHUNKS);
  }
  const lastScroll = useRef(0);
  useEffect(() => {
    if (drawnN >= chunks.length) return undefined;
    const idle = typeof requestIdleCallback === "function"
      ? (f) => { const h = requestIdleCallback(f, { timeout: 200 }); return () => cancelIdleCallback(h); }
      : (f) => { const h = setTimeout(f, 16); return () => clearTimeout(h); };
    // While the list is being scrolled, grow only when the drawn part is
    // running out (under three screens left below); otherwise wait for a pause.
    let cancel = null, timer = null;
    const step = () => {
      const el = scrollRef.current;
      const scrolling = Date.now() - lastScroll.current < 250;
      const left = el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0;
      if (scrolling && el && left > el.clientHeight * 3) { timer = setTimeout(() => { cancel = idle(step); }, 150); return; }
      setDrawnN((n) => n + GROW_CHUNKS);
    };
    cancel = idle(step);
    return () => { if (cancel) cancel(); if (timer) clearTimeout(timer); };
  }, [drawnN, chunks.length]);   // eslint-disable-line react-hooks/exhaustive-deps
  const drawn = drawnN >= chunks.length ? chunks : chunks.slice(0, drawnN);
  const io = useRef(null);
  const els = useRef(new Map());
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      setLive(new Set(chunks.map((_, i) => i)));   // no observer: every photo on, as before
      return undefined;
    }
    // A transition: a chunk's photos turning on (or off) 2.5 screens away is never
    // urgent, so React renders it in slices and the scroll keeps its frames.
    const obs = new IntersectionObserver((entries) => startTransition(() => {
      setLive((prev) => {
        let next = null, near = 0;
        for (const e of entries) {
          const i = Number(e.target.dataset.chunk);
          // Grow-only: a photo, once mounted, stays. Unmounting it off screen
          // made WebKit decode it again on the way back (measured: the scroll
          // stalled on every chunk); the browser already drops decoded
          // bitmaps of off-screen images under memory pressure.
          if (!e.isIntersecting || prev.has(i)) continue;
          next ||= new Set(prev);
          next.add(i);
          near = i;
        }
        // …but not without limit (architect review): past MAX_LIVE_CHUNKS the
        // chunks FARTHEST from the one just reached let their photos go, so a
        // scroll through 1,500 cards holds ~320 photos, not all of them.
        if (next && next.size > MAX_LIVE_CHUNKS) {
          const far = [...next].sort((a, b) => Math.abs(b - near) - Math.abs(a - near));
          for (const c of far) { if (next.size <= MAX_LIVE_CHUNKS) break; next.delete(c); }
        }
        return next || prev;
      });
    }), { root, rootMargin: slowConnection() ? WINDOW_MARGIN_SLOW : WINDOW_MARGIN });
    io.current = obs;
    els.current.forEach((el) => obs.observe(el));
    return () => { obs.disconnect(); io.current = null; };
  }, [scrollRef, chunks.length]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Prefetch (tilePrefetch.js): held while the list scrolls; re-planned when
  // the window moves or the list changes — rows below the window first.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return undefined;
    const on = () => { lastScroll.current = Date.now(); noteTileScroll(); };
    root.addEventListener("scroll", on, { passive: true });
    return () => root.removeEventListener("scroll", on);
  }, [scrollRef]);
  useEffect(() => {
    const t = setTimeout(() => {
      const last = live.size ? Math.max(...live) : -1;
      const item = (p) => ({ id: p.id, src: tilePhotoSrc(p) });
      const ahead = chunks.slice(last + 1, last + 1 + AHEAD_CHUNKS).flat().map(item);
      const rest = [...chunks.slice(last + 1 + AHEAD_CHUNKS), ...chunks.slice(0, last + 1)].flat().map(item);
      setTilePrefetchPlan({ ahead, rest });
    }, 300);
    return () => clearTimeout(t);
  }, [live, chunks]);
  const refFor = (i) => (el) => {
    const m = els.current;
    const old = m.get(i);
    if (old === el) return;
    if (old && io.current) io.current.unobserve(old);
    if (el) { m.set(i, el); if (io.current) io.current.observe(el); } else m.delete(i);
  };
  return (
    <div className="ap-grid-wrap">
      {drawn.map((items, i) => (
        <ApChunk key={i} index={i} items={items} live={live.has(i)} h={h} chunkRef={refFor(i)}
                 selectedId={items.some((p) => p.id === selectedId) ? selectedId : null} />
      ))}
    </div>
  );
}

const ApChunk = memo(function ApChunk({ index, items, live, h, chunkRef, selectedId }) {
  return (
    <div className="ap-grid ap-chunk" data-chunk={index} ref={chunkRef}>
      {/* The first chunk is the first screen: its photos ask with high priority. */}
      {items.map((p) => <ApCard key={p.id} p={p} live={live} h={h.current} selected={selectedId === p.id} priority={index === 0} />)}
    </div>
  );
}, (a, b) => a.items === b.items && a.live === b.live && a.selectedId === b.selectedId && a.index === b.index);

function ApCard({ p, live, h, selected, priority }) {
  const { onOpen, onViewPhotos, photoCount, renderActions, renderDeactivated, isDead } = h;
  const price = retailPriceOf(p);   // docs/ASSISTANT-NO-PRICE-SET.md
  const priced = price !== null;
  const dead = isDead ? isDead(p) : false;
  const n = photoCount ? photoCount(p) : 0;
  return (
    <article className="sky-card sky-glass sky-sheen ap-card" tabIndex={0} data-photo={live ? "on" : "off"}
             aria-current={selected ? "true" : undefined}
             onClick={() => onOpen(p)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(p); }}>
      {/* The photo (or its 👟 stand-in) is a picture, not text. Outside the
          window: the same-height stage. */}
      {live
        ? <div data-contrast-exempt="" style={{ display: "contents" }}><ProductStage p={p} height="var(--ap-stage)" emoji={p.photo || "👟"} tile priority={priority} /></div>
        : <div className="sky-stage" style={{ height: "var(--ap-stage)" }} data-stage="waiting" aria-hidden="true"><span className="ap-waiting" /></div>}
      {p.photoUrl && onViewPhotos && (
        <button type="button" className="ap-zoom" aria-label={n > 1 ? `View ${n} photos` : "View full photo"}
                onClick={(e) => { e.stopPropagation(); onViewPhotos(p); }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M20 20l-4.6-4.6M10.5 8v5M8 10.5h5" /></svg>
          {n > 1 ? <span>{n}</span> : null}
        </button>
      )}
      {renderActions ? renderActions(p) : null}
      <div className="ap-body">
        <div className="sky-name ap-name" data-contrast-exempt="">{p.name}{renderDeactivated ? renderDeactivated(p) : null}</div>
        {dead ? <div className="ap-dead" data-contrast-exempt="">Deactivated — no sizes on offer</div> : null}
        <div className="ap-row">
          {priced
            ? <span className="sky-price ap-price" data-contrast-exempt="">{fmtR(price)}</span>
            : <span className="ap-noprice" data-contrast-exempt="">No price set</span>}
          <SkyPlus label={`Add ${p.name}`} onClick={(e) => { e.stopPropagation(); onOpen(p); }} />
        </div>
      </div>
    </article>
  );
}

// Junid's minimal phone mock-up (5 Nov, "do it with precision"), measured on a
// 393pt-wide iPhone: 17px header gutters with BARE white grid/account icons; the
// wordmark 117 wide; the store line as plain white caps, no pill; the search a
// faint glass bar 357x36 at 18px gutters, white icon/placeholder/camera, no
// divider; brands: a white "All" pill (52x29) then bare white logos; cards
// 172 wide, 12/14 gaps, 16px radius, pale glass; the photo ~92x101 centred 13px
// down, 9px radius; name 11.5px white, 2 lines; price 15.5px bold white; a 25px
// glass plus 9.5px from the edge. White text on the sky is exempt from the
// contrast gate, as the home tiles are.
const AP_CSS = `
.ap-root{max-width:880px;margin:0 auto;color:#fff;font-family:var(--sky-font);position:relative;padding-left:var(--sky-sal);padding-right:var(--sky-sar)}
/* Sticky top band (Junid 6 Nov): stays put, the grid passes under it; its glass fades in once scrolled. */
.ap-top{position:fixed;top:0;left:0;right:0;z-index:40;max-width:880px;margin:0 auto;padding-left:var(--sky-sal);padding-right:var(--sky-sar)}
.ap-brandsfloat{position:fixed;left:0;right:0;z-index:39;max-width:880px;margin:0 auto;padding:18px var(--sky-sar) 0 var(--sky-sal);background:none;pointer-events:none}
.ap-brandsfloat .sky-brandstrip{pointer-events:auto}
.ap-root .ap-brandsfloat .sky-brandchip:not([aria-pressed="true"]){filter:drop-shadow(0 1px 3px rgba(0,30,90,.6)) drop-shadow(0 0 8px rgba(0,30,90,.3))!important}
.ap-scroll{position:fixed;left:0;right:0;bottom:0;max-width:880px;margin:0 auto;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;
  padding-left:var(--sky-sal);padding-right:var(--sky-sar);scrollbar-width:none;
  -webkit-mask-image:linear-gradient(180deg,transparent 0,#000 10px);mask-image:linear-gradient(180deg,transparent 0,#000 10px)}
.ap-scroll::-webkit-scrollbar{display:none}
.ap-root .sky-header{padding:calc(var(--sky-sat) + 14px) 17px 0;--sky-logo-mid:20px}
.ap-root .sky-header__c{gap:0;margin-top:0}
html[data-sky="on"] #root .ap-root .sky-header .sky-round{width:36px;height:36px;background:none!important;border:0!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;color:#fff!important;filter:drop-shadow(0 1px 4px rgba(0,40,110,.35))}
.ap-root .sky-header .sky-round svg{width:22px;height:22px;color:#fff;stroke:#fff}
.ap-root .sky-header .sky-logo__m{font-size:25px}
.ap-root .sky-header .sky-logo__c{font-size:8.5px;margin-top:4px}
.ap-store{display:block;margin-top:5px}
html[data-sky="on"] #root .ap-root .ap-store .sky-storepill{height:auto;min-width:0;padding:3px 6px;background:none!important;border:0!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;
  color:#fff!important;font:600 12.2px/1.2 var(--sky-font);letter-spacing:.045em;text-shadow:0 1px 6px rgba(0,40,110,.35);gap:7px}
.ap-store .sky-storepill__chev{width:11px;height:11px;stroke-width:2.6}
.ap-search{padding:14px 18px 0;max-width:560px;margin:0 auto}
html[data-sky="on"] #root .ap-root .ap-search .sky-search{height:36px;padding:0 4px 0 15px;gap:11px;background:rgba(255,255,255,.18)!important;border:1px solid rgba(255,255,255,.55)!important;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 18px rgba(0,40,120,.1)!important}
.ap-root .ap-search .sky-search > svg{width:15px;height:15px;color:#fff;filter:drop-shadow(0 1px 3px rgba(0,40,110,.3))}
html[data-sky="on"] #root .ap-root .ap-search .sky-search input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]){color:#fff!important;caret-color:#fff;font:400 12.75px/1 var(--sky-font);background:transparent!important;border:0!important}
html[data-sky="on"] #root .ap-root .ap-search .sky-search input::placeholder{color:rgba(255,255,255,.95)!important}
/* Touch screens: the field is 16px (iOS never zooms on focus) drawn at 72% so
   it reads 12.75px (Junid 6 Nov: type up 11%). */
@media (pointer: coarse){.ap-root .ap-search .sky-search input{transform:scale(.797);transform-origin:left center;width:calc(100% / .797);margin-right:calc(-100% / .797 + 100%)}}
.ap-root .ap-search .sky-search__div{display:none}
.ap-root .ap-search .sky-search__btn{width:30px;height:30px;color:#fff}
.ap-root .ap-search .sky-search__btn svg{width:17px;height:17px;color:#fff;stroke:#fff}
.ap-brands{margin:0}
.ap-root .sky-brandstrip{gap:8px;padding:0 24px 0;scroll-padding-inline:24px;align-items:center;height:32px}
html[data-sky="on"] #root .ap-root .sky-brandchip{height:32px;min-width:57px;padding:0 15px;background:none!important;border:0!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;color:#fff!important;filter:drop-shadow(0 1px 3px rgba(0,40,110,.3))}
html[data-sky="on"] #root .ap-root .sky-brandchip[aria-pressed="true"]{background:#fff!important;color:var(--sky-navy)!important;filter:none;box-shadow:0 3px 10px rgba(0,40,120,.15)!important}
html[data-sky="on"] #root .ap-root .sky-brandchip--all{font:700 13.9px/1 var(--sky-font)}
.ap-root .sky-brandchip svg{height:20px;max-width:33px;fill:currentColor}
.ap-root .sky-brandchip .sky-chip__txt{font-size:11.7px;font-weight:700;letter-spacing:.04em}
@media (min-width:768px){.ap-brands{display:none}}
.ap-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 12px;padding:12px 18.5px 0}
/* Chunks of the one grid (ApGrid): the same columns and gaps, 14px between chunks. */
.ap-chunk{padding-top:0}
.ap-grid-wrap > .ap-chunk:first-child{padding-top:12px}
.ap-chunk + .ap-chunk{margin-top:14px}
@media (min-width:600px){.ap-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (min-width:820px){.ap-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
/* Product cards wear the Home tile's glass (Junid, 7 Nov — IMG_3894): lit top
   hairline (sky-sheen), clear-to-frosted gradient, bright rim, inner glow
   rising from the bottom edge, soft blue drop shadow. */
html[data-sky="on"] #root .ap-root .ap-card{position:relative;display:flex;flex-direction:column;border-radius:24px;color:#fff;
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.12) 70%,rgba(255,255,255,.2))!important;
  border:1.5px solid rgba(255,255,255,.62)!important;
  box-shadow:inset 0 0 16px 1px rgba(255,255,255,.42),inset 0 -16px 22px -10px rgba(255,255,255,.7),var(--sky-shadow)!important;
  -webkit-backdrop-filter:blur(10px) saturate(130%);backdrop-filter:blur(10px) saturate(130%)}
.ap-card[aria-current="true"]{outline:2px solid #fff;outline-offset:-1px}
/* Windowed grid (ApGrid): never skip a card's insides. */
.ap-root .ap-card{content-visibility:visible}
.ap-root .ap-card .sky-stage{height:114px!important;padding:0;flex:0 0 auto}
.ap-root .ap-card .sky-frame{inset:13px 0 0;background:none;border-radius:0;align-items:flex-start}
.ap-root .ap-card .sky-frame img{max-width:92px;max-height:101px;border-radius:9px}
/* TilePhoto: placeholder and full photo stacked in one cell, the photo fading
   in over it; the placeholder has the photo's own size (or is the held
   thumbnail, blurred), so nothing moves. The glass block shows only while
   nothing at all is known yet. White on the sky — no new colour. */
.ap-root .tile{display:grid;justify-items:center;align-items:start;border-radius:9px;overflow:hidden}
.ap-root .tile > *{grid-area:1/1}
.ap-root .tile__full{transition:opacity .28s ease}
.ap-root .ap-waiting{position:absolute;top:13px;left:50%;margin-left:-40px;width:80px;height:96px;border-radius:9px;background:rgba(255,255,255,.26)}
.ap-root .tile__ph--blur{filter:blur(5px)}
.ap-root .tile__shim{width:80px;height:96px;border-radius:9px;background:rgba(255,255,255,.26);animation:tile-shim 1.4s ease-in-out infinite}
@keyframes tile-shim{50%{background:rgba(255,255,255,.4)}}
@media (prefers-reduced-motion:reduce){.ap-root .tile__full{transition:none}.ap-root .tile__shim{animation:none}}
.ap-root .ap-card .sky-podium{width:70%;bottom:2px}
.ap-root .ap-card .sky-cutout{max-width:80%}
.ap-body{padding:7px 9.5px 8.5px 15.5px;display:flex;flex-direction:column;gap:7px;flex:1;background:none}
.ap-name{font-size:12.75px;font-weight:500;line-height:14.9px;color:#fff;-webkit-line-clamp:2;text-shadow:0 1px 4px rgba(0,40,110,.25)}
.ap-row{display:flex;align-items:center;justify-content:space-between;margin-top:auto}
.ap-price{font-size:17.25px;font-weight:700;color:#fff;letter-spacing:-.005em;text-shadow:0 1px 4px rgba(0,40,110,.25)}
.ap-dead,.ap-noprice{font-size:11.7px;font-weight:600;color:rgba(255,255,255,.92)}
html[data-sky="on"] #root .ap-root .ap-card .sky-plus{width:25px;height:25px;background:rgba(255,255,255,.22)!important;border:1px solid rgba(255,255,255,.6)!important;box-shadow:none!important;color:#fff!important}
.ap-root .ap-card .sky-plus svg{width:13px;height:13px;stroke:#fff;stroke-width:1.8}
.ap-zoom{position:absolute;top:15px;left:calc(50% - 40px);z-index:2;height:16px;min-width:16px;padding:0 4px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;gap:3px;
  border:0;background:rgba(0,0,0,.42);color:#fff;font:700 9px/1 var(--sky-font);cursor:pointer}
.ap-zoom::before{content:"";position:absolute;inset:-12px}
.ap-empty{margin:24px 16px 0;border-radius:16px;padding:30px 16px;text-align:center;font-weight:600}
.ap-root .sky-bottombar{max-width:820px;margin:0 auto}
@media (min-width:880px){.ap-root .sky-bottombar{left:50%;right:auto;transform:translateX(-50%);width:820px}}
`;
