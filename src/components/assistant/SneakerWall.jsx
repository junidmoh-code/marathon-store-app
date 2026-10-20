// ─── SNEAKER WALL — the desktop Sneaker order screen as a photo wall ─────────
//
// Junid's signed-off design (2026-10-19, artboard "B — Same wall, with the
// details on touch"): store chips, one floating search bar and an order pill
// across the top; below it a wall of product photos and nothing else.
//
// ROUND 3 (Junid, 2026-10-19): NO TILE OVERLAY. A tile is the photo and
// nothing else in every state — no name, no price, no size pills, no icons;
// a mouse gets a 2px #5b63ff ring and that is all. One tap or click anywhere
// on it (Enter/Space from the keyboard) opens the existing product popup —
// AssistantDesktop's quick-view, with SELECT A SIZE, Display Partner, the
// quantity stepper and Add. That popup is the ONLY way to see sizes or add,
// so the tap that opens it cannot add anything. Its large photo opens the
// full-screen lightbox. The deactivate / merge "⋯" lives in its header.
//
// A PRESENTATION LAYER ONLY. Everything that decides anything arrives as a
// prop from AssistantDesktop, which takes it from AssistantView: the cart and
// quickAdd, the size gate (quickAddSizeState over sneakerOut), the search
// results, the render cap, the shop switch (still the alarming confirm), the
// checkout. No RTDB read happens here, for the same capped `visible` slice.
//
// FULL-RESOLUTION PHOTOS (round 3, item 2). The tile draws the product's own
// photoUrl — the very file the lightbox opens — not the photo mirror's 300px
// thumbnail, which on a 274px tile at 2× was visibly soft. The thumbnail is
// kept as the OFFLINE fallback only: when the original cannot load, the tile
// drops to the device-cached copy rather than to a blank square.

import { memo, useEffect, useRef, useState } from "react";
import { HiResPhoto, tilePhotoSrc } from "./HiResPhoto.jsx";
import { labelFor } from "../stock/locations";
import OrderLinesPanel from "./OrderLinesPanel.jsx";
import { fmtR } from "./assistantOrderModel";

export { HiResPhoto, tilePhotoSrc };

const WALL_CSS = `
  /* TRUE BLACK (Junid, 2026-10-19): ground #000, tile placeholder #0a0a0a,
     drawer and modal surfaces #050505 with a 1px #1c1c1c border. Every grey
     caption is at least 4.5:1 on its ground (#8b8b95 on #000 = 6.2:1). */
  .sw-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#000;color:#f2f2f2;overflow:hidden}
  /* COMPACT TOP BAR — one 44px line, 12px above and below, so the wall shows
     three full rows at 1440×900 and at 1280×800. */
  .sw-top{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;height:44px;box-sizing:content-box;padding:12px 16px}
  .sw-side{flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:6px}
  .sw-side.r{flex:0 0 auto;justify-content:flex-end}
  .sw-chip{height:32px;padding:0 14px;border-radius:16px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#a9a9b3;font-size:13.5px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;flex:0 0 auto}
  .sw-chip[aria-pressed="true"]{border-color:#5b63ff;background:rgba(91,99,255,.18);color:#dfe1ff;font-weight:600}
  .sw-chip:focus-visible,.sw-more:focus-visible,.sw-pill:focus-visible,.sw-cam:focus-visible,.sw-tile:focus-visible,.sw-loadmore:focus-visible{outline:2px solid #b9beff;outline-offset:2px}
  .sw-menuwrap{position:relative;flex:0 0 auto}
  .sw-more{width:32px;height:32px;border-radius:16px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#c9c9cf;cursor:pointer;display:grid;place-items:center;padding:0}
  .sw-menu{position:absolute;top:40px;left:0;z-index:20;min-width:220px;padding:6px;border-radius:14px;background:#050505;border:1px solid #1c1c1c;box-shadow:0 24px 60px rgba(0,0,0,.8);display:flex;flex-direction:column;gap:2px}
  .sw-menu .who{padding:8px 12px 6px;font-size:11px;color:#8b8b95;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sw-menu button{display:flex;align-items:center;gap:10px;text-align:left;padding:11px 12px;border-radius:10px;border:0;background:transparent;color:#e6e6ea;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  .sw-menu button:hover,.sw-menu button:focus-visible{background:rgba(255,255,255,.07);outline:none}
  .sw-menu button[aria-current="true"]{color:#b9beff}
  .sw-search{flex:1 1 auto;max-width:520px;min-width:220px;height:36px;display:flex;align-items:center;gap:10px;padding:0 4px 0 14px;border-radius:18px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);cursor:text}
  .sw-search:focus-within{border-color:rgba(91,99,255,.7)}
  .sw-search input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#f2f2f2;font-size:15px;font-family:inherit}
  .sw-search input::placeholder{color:#8b8b95}
  .sw-cam{width:28px;height:28px;flex:0 0 auto;border-radius:14px;border:0;background:rgba(255,255,255,.1);display:grid;place-items:center;cursor:pointer;padding:0}
  .sw-pill{height:36px;padding:0 14px 0 11px;border-radius:18px;border:0;background:#5b63ff;color:#fff;font-size:14.5px;font-weight:700;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;font-variant-numeric:tabular-nums;white-space:nowrap}
  .sw-badge{display:flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#fff;color:#3a40c7;font-size:12.5px}
  .sw-scroll{position:relative;flex:1;min-height:0;overflow:auto;padding:0 16px 16px}
  /* FIVE COLUMNS OF 5:4 TILES. At 1440×900: 274×219 tiles, three full rows
     in 745px. At 1280×800 five columns still (242×194, 668px) — four would
     need 819px, more than the screen. Four only below 1200px. */
  .sw-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
  @media(max-width:1199px){.sw-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
  /* cover, centred (Junid's spec). content-visibility skips paint for rows
     scrolled away — the till's UHD 600 is why the old grid needed it. */
  .sw-tile{position:relative;display:block;width:100%;aspect-ratio:5/4;border-radius:16px;overflow:hidden;background:#0a0a0a;border:0;padding:0;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 220px}
  /* The only resting-state change a tile has: a 2px accent ring on hover. */
  .sw-tile::after{content:"";position:absolute;inset:0;border-radius:16px;pointer-events:none;z-index:3;box-shadow:inset 0 0 0 2px transparent;transition:box-shadow .12s}
  .sw-tile:hover::after,.sw-tile:focus-visible::after{box-shadow:inset 0 0 0 2px #5b63ff}
  .sw-tile img,.sw-photo img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;opacity:0;transition:opacity .2s}
  .sw-tile img.ok,.sw-photo img.ok{opacity:1}
  .sw-noimg{position:absolute;inset:0;display:grid;place-items:center;padding:14px;text-align:center;color:#8b8b95;font-size:13px;font-weight:600;line-height:1.3}
  .sw-foot{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 0 6px;color:#8b8b95;font-size:12px}
  .sw-loadmore{padding:11px 24px;border-radius:22px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e6e6ea;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}
  .sw-loadmore:hover{border-color:#5b63ff;background:rgba(91,99,255,.18)}
  .sw-empty{text-align:center;color:#8b8b95;padding:80px 20px;font-size:15px}
  .sw-scrim{position:fixed;inset:0;z-index:55;background:rgba(0,0,0,.6);animation:swFade .18s ease}
  .sw-drawer{position:fixed;top:0;right:0;bottom:0;z-index:56;width:min(420px,100vw);background:#050505;border-left:1px solid #1c1c1c;box-shadow:-30px 0 80px rgba(0,0,0,.6);display:flex;flex-direction:column;animation:swSlide .24s cubic-bezier(.2,.7,.2,1)}
  .sw-dhead{display:flex;align-items:center;gap:10px;padding:22px 18px 14px;border-bottom:1px solid #1c1c1c}
  .sw-dhead h2{margin:0;font-size:17px;font-weight:800}
  .sw-dclose{margin-left:auto;width:40px;height:40px;border-radius:20px;border:0;background:rgba(255,255,255,.07);color:#fff;font-size:16px;cursor:pointer}
  @keyframes swSlide{from{transform:translateX(100%)}to{transform:none}}
  @keyframes swFade{from{opacity:0}to{opacity:1}}
  @media(prefers-reduced-motion:reduce){.sw-drawer,.sw-scrim{animation:none}.sw-tile img,.sw-photo img{transition:none}}
  /* THE SHARED .ad-* SURFACES, WHEN THEY OPEN OVER THE WALL — the quick-view,
     checkout and shop-switch modals and the drawer's lines. Scoped to the
     wall's root so Clothing order's layout is untouched. Captions drawn at
     30–40% white measured 2.3–3.4:1 on #050505; lifted to 55% (5.5:1). */
  .ad-root--wall{background:#000}
  .ad-root--wall .ad-stage{background:rgba(0,0,0,.78)}
  .ad-root--wall .ad-sv{background:#050505;border:1px solid #1c1c1c}
  .ad-root--wall .ad-svimg,.ad-root--wall .ad-li{background:#0a0a0a}
  .ad-root--wall .ad-line{background:#0a0a0a;border-color:#1c1c1c}
  .ad-root--wall .ad-dfoot{border-top-color:#1c1c1c}
  .ad-root--wall .ad-qlab,.ad-root--wall .ad-empty,.ad-root--wall .ad-lm,.ad-root--wall .ad-trow{color:rgba(233,238,255,.55)}
  .ad-root--wall .ad-noprice{color:rgba(233,238,255,.55)!important}
  /* THE POPUP OVER THE WALL keeps its normal size (820px wide, centred) and
     never grows past 85vh — the alternatives strip inside it scrolls
     sideways, the popup does not grow for it (round 3, item 10). */
  .ad-root--wall .ad-sv{max-height:85vh;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}
  /* minmax(0,…) and min-width:0 keep the strip's 18 tiles from sizing the
     column: the row scrolls inside the body instead of widening it. */
  .ad-root--wall .ad-svbody,.ad-root--wall .ad-svbody>div{min-width:0}
  @media(max-width:680px){.ad-root--wall .ad-sv{grid-template-columns:minmax(0,1fr)}}
  /* Deactivate / merge (admin only) — moved off the tile into the header. */
  .ad-svacts{position:absolute;top:14px;right:54px;z-index:2}
  /* The name block (and the back link) clear the ⋯ and ✕ in the corner. */
  .ad-root--wall .ad-svbody>div:first-child{padding-right:72px}
  /* "← back to <the shoe you came from>" after an alternative swapped in. */
  .ad-svback{display:inline-flex;align-items:center;gap:4px;max-width:100%;margin:0 0 10px;padding:0;border:0;background:transparent;color:#b9beff;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ad-svback:focus-visible{outline:2px solid #b9beff;outline-offset:2px;border-radius:4px}
`;

// tilePhotoSrc and HiResPhoto live in ./HiResPhoto.jsx (the classic grid's
// cards draw the same full-resolution photo since 2026-10-20).

// The tile's photo, faded in once it has loaded so the #0a0a0a ground is the
// placeholder. With no photo at all the ground shows the name instead.
export function TilePhoto({ p }) {
  const [ok, setOk] = useState(false);
  return <HiResPhoto p={p} className={ok ? "ok" : undefined} onLoad={() => setOk(true)}
                     fallback={<span className="sw-noimg">{p.name}</span>} />;
}

export default function SneakerWall({
  availableShops, effectiveShop, shopRegistry, onPickShop,
  mode, setMode, onSwitchView, userEmail,
  search, setSearch, searchRef, onLabelFind,
  shownCount, visible, onShowMore, modalOpen = false, popupOpen = false,
  onOpenDetails, onQuickAdd,
  grouped, units, total, onRemoveOne, onAddDisplayPartner, onCheckout,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The tile whose popup is open, so focus returns to it when the popup
  // closes rather than dropping to <body>.
  const lastTile = useRef(null);
  const menuRef = useRef(null);
  const scrollRef = useRef(null);
  const drawerCloseRef = useRef(null);
  const pillRef = useRef(null);

  // A new result set starts at the top — the cap resets to one page, and a
  // scrolled-down wall would otherwise land on empty space.
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [shownCount, search]);

  // The drawer takes focus on open and hands it back to the pill on close.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (drawerOpen) drawerCloseRef.current?.focus?.();
    else if (wasOpen.current) pillRef.current?.focus?.();
    wasOpen.current = drawerOpen;
  }, [drawerOpen]);

  // Only the product popup hands focus back — closing checkout or the shop
  // confirm must not pull focus to a tile from an earlier popup.
  const wasPopup = useRef(false);
  useEffect(() => {
    if (!popupOpen && wasPopup.current && lastTile.current?.isConnected) lastTile.current.focus?.();
    wasPopup.current = popupOpen;
  }, [popupOpen]);

  // Tap outside the open menu closes it.
  useEffect(() => {
    if (!menuOpen) return undefined;
    if (typeof document === "undefined") return undefined;
    const h = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [menuOpen]);

  // Escape closes, innermost first. The popup's own Escape is AssistantDesktop's
  // (modalOpen), as is the "/" shortcut.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const h = (e) => {
      if (e.key !== "Escape" || modalOpen) return;
      if (menuOpen) setMenuOpen(false);
      else if (drawerOpen) setDrawerOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [menuOpen, drawerOpen, modalOpen]);

  const pickMenu = (fn) => { setMenuOpen(false); fn(); };

  return (
    <div className="sw-root">
      <style>{WALL_CSS}</style>

      {/* TOP BAR — overflow + store chips · search · order pill */}
      <div className="sw-top">
        <div className="sw-side">
          <div className="sw-menuwrap" ref={menuRef}>
            <button type="button" className="sw-more" aria-label="More: order type and switch view"
                    aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}>
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
            {menuOpen && (
              <div className="sw-menu">
                {userEmail ? <div className="who">{userEmail.split("@")[0]} · Store assistant</div> : null}
                <button type="button" aria-current={mode === "sneaker"} onClick={() => pickMenu(() => setMode("sneaker"))}>Sneaker order</button>
                <button type="button" aria-current={mode === "clothing"} onClick={() => pickMenu(() => setMode("clothing"))}>Clothing order</button>
                <button type="button" onClick={() => pickMenu(onSwitchView)}>Switch view</button>
              </div>
            )}
          </div>
          {(availableShops || []).map(s => (
            <button key={s.id} type="button" className="sw-chip" aria-pressed={effectiveShop === s.id}
                    onClick={() => { if (s.id !== effectiveShop) onPickShop(s.id); }}>
              {labelFor(s.id, shopRegistry)}
            </button>
          ))}
        </div>

        <label className="sw-search">
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#c9c9cf" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search products or brands…" aria-label="Search products or brands" autoComplete="off" />
          {onLabelFind && (
            <button type="button" className="sw-cam" onClick={onLabelFind} aria-label="Find by the tongue label" title="Find by the tongue label">
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dcdce2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
            </button>
          )}
        </label>

        <div className="sw-side r">
          <button type="button" ref={pillRef} className="sw-pill" onClick={() => setDrawerOpen(true)}
                  aria-label={`Order: ${units} item${units !== 1 ? "s" : ""}, ${fmtR(total)}`}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.6a1 1 0 0 0 1-.8L21 8H6"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17.5" cy="20" r="1.3"/></svg>
            <span className="sw-badge" data-testid="order-count">{units}</span>
            <span data-testid="order-total">{fmtR(total)}</span>
          </button>
        </div>
      </div>

      {/* THE WALL */}
      <div className="sw-scroll" ref={scrollRef}>
        {shownCount === 0 ? (
          <div className="sw-empty">No products match.</div>
        ) : (
          <div className="sw-grid">
            {visible.map(p => (
              <WallTile key={p.id} p={p} onOpen={onOpenDetails} lastTile={lastTile} />
            ))}
          </div>
        )}
        {shownCount > 0 && (
          <div className="sw-foot">
            <span>{visible.length < shownCount ? `Showing ${visible.length} of ${shownCount}` : `${shownCount} product${shownCount !== 1 ? "s" : ""}`}</span>
            {visible.length < shownCount && (
              <button type="button" className="sw-loadmore" onClick={onShowMore}>Load more</button>
            )}
          </div>
        )}
      </div>

      {/* ORDER DRAWER — the same lines and the same Place order as before. */}
      {drawerOpen && (
        <>
          <div className="sw-scrim" onClick={() => setDrawerOpen(false)} />
          <aside className="sw-drawer" role="dialog" aria-modal="true" aria-label="Order">
            <div className="sw-dhead">
              <h2>Order</h2><span className="ad-dn">{units}</span>
              <button type="button" ref={drawerCloseRef} className="sw-dclose" onClick={() => setDrawerOpen(false)} aria-label="Close order">✕</button>
            </div>
            <div className="ad-dbody">
              <OrderLinesPanel grouped={grouped} units={units} onRemoveOne={onRemoveOne} onQuickAdd={onQuickAdd}
                               onAddDisplayPartner={onAddDisplayPartner} onCheckout={onCheckout}
                               emptyHint="Tap a photo to pick a size." />
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

// One tile: a single button holding the photo and nothing else. Memoised, so
// a cart or stock update re-renders none of the sixty tiles on the till.
const WallTile = memo(function WallTile({ p, onOpen, lastTile }) {
  return (
    <button type="button" className="sw-tile" aria-label={p.name} aria-haspopup="dialog"
            onClick={e => { lastTile.current = e.currentTarget; onOpen(p); }}>
      <TilePhoto key={p.photoUrl || ""} p={p} />
    </button>
  );
});
