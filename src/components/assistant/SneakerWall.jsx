// ─── SNEAKER WALL — the desktop Sneaker order screen as a photo wall ─────────
//
// Junid's signed-off design (2026-10-19, artboard "B — Same wall, with the
// details on touch"): store chips, one floating search bar and an order pill
// across the top; below it a 4-column wall of product photos and nothing else.
// Touching a photo opens its details over the bottom of the tile — name,
// price, size pills — and a size tap adds exactly as the old hover grid did.
//
// A PRESENTATION LAYER ONLY. Everything that decides anything arrives as a
// prop from AssistantDesktop, which takes it from AssistantView: the cart and
// quickAdd, the size gate (quickAddSizeState over sneakerOut), the search
// results, the render cap, the shop switch (still the alarming confirm), the
// checkout. No read happens here — the photos are the same MirroredImg
// thumbnails the old grid drew, for the same capped `visible` slice.
//
// TOUCH RULE. The first tap on a tile only opens its overlay; the size pills
// do not exist until it is open, so nothing can be added by the tap that
// opened it. A mouse opens it on hover. One tile is open at a time, and a
// tap anywhere outside it closes it.

import { memo, useEffect, useRef, useState } from "react";
import { MirroredImg } from "../../offline/MirroredImg.jsx";
import { labelFor } from "../stock/locations";
import { isDeactivated } from "../../utils/deactivation";
import { formatSize } from "../../utils/sizeLabel";
import OrderLinesPanel from "./OrderLinesPanel.jsx";
import { fmtR, quickAddSizeState, sizesOf } from "./assistantOrderModel";

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
  .sw-chip:focus-visible,.sw-more:focus-visible,.sw-pill:focus-visible,.sw-cam:focus-visible,.sw-tbtn:focus-visible,.sw-sz:focus-visible,.sw-ib:focus-visible,.sw-loadmore:focus-visible,.sw-back:focus-visible{outline:2px solid #b9beff;outline-offset:2px}
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
  .sw-tile{position:relative;aspect-ratio:5/4;border-radius:16px;overflow:hidden;background:#0a0a0a;content-visibility:auto;contain-intrinsic-size:auto 220px}
  .sw-tile::after{content:"";position:absolute;inset:0;border-radius:16px;pointer-events:none;z-index:3;box-shadow:inset 0 0 0 3px transparent;transition:box-shadow .12s}
  .sw-tile[data-open="true"]::after{box-shadow:inset 0 0 0 3px #5b63ff}
  .sw-tbtn{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:pointer;display:block;border-radius:16px}
  .sw-tbtn img,.sw-photo img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;opacity:0;transition:opacity .2s}
  .sw-tbtn img.ok,.sw-photo img.ok{opacity:1}
  .sw-noimg{position:absolute;inset:0;display:grid;place-items:center;padding:14px;text-align:center;color:#8b8b95;font-size:13px;font-weight:600;line-height:1.3}
  /* The overlay sits on the bottom and GROWS UPWARD over the photo when a shoe
     has more sizes than two pill rows; past the full tile it scrolls inside. */
  .sw-ov{position:absolute;left:0;right:0;bottom:0;z-index:2;max-height:100%;overflow:auto;padding:30px 12px 10px;background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,.82) 30%,rgba(0,0,0,.92) 100%);display:flex;flex-direction:column;gap:7px}
  .sw-ovhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .sw-name{font-size:14px;font-weight:600;color:#fff;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .sw-price{font-size:18px;font-weight:800;color:#b9beff;white-space:nowrap;font-variant-numeric:tabular-nums}
  .sw-price.no{font-size:12px;font-weight:700;color:#8b8b95}
  .sw-dead{margin-left:6px;font-size:10px;font-weight:800;letter-spacing:.06em;padding:2px 6px;border-radius:6px;background:rgba(150,160,190,.18);border:1px solid rgba(150,160,190,.4);color:#B9C0D4;vertical-align:middle}
  .sw-szrow{display:flex;flex-wrap:wrap;gap:5px}
  .sw-sz{position:relative;width:40px;height:38px;border-radius:10px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;font-variant-numeric:tabular-nums;padding:0;transition:background .12s,border-color .12s}
  .sw-sz:hover{background:rgba(91,99,255,.35)}
  .sw-sz.flash{background:#5b63ff;border-color:#5b63ff;font-weight:700}
  /* No stock: struck through and dim. #7a7a84, not the artboard's #6e6e78 —
     that is 4.2:1 on black; this is 4.9:1. It adds nothing; a tap opens the
     alternatives for that size. */
  .sw-sz.out{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.03);color:#7a7a84;text-decoration:line-through;font-weight:500}
  .sw-sz.out:hover{background:rgba(255,255,255,.06)}
  .sw-sz:disabled{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.03);color:#7a7a84;text-decoration:line-through;cursor:not-allowed;font-weight:500}
  .sw-tools{position:absolute;top:8px;right:8px;z-index:4;display:flex;gap:6px}
  .sw-ib{width:30px;height:30px;border-radius:15px;border:0;background:rgba(0,0,0,.6);color:#fff;display:grid;place-items:center;cursor:pointer;padding:0}
  .sw-acts{position:absolute;top:8px;left:8px;z-index:4}
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
  @media(prefers-reduced-motion:reduce){.sw-drawer,.sw-scrim{animation:none}.sw-tbtn img,.sw-photo img{transition:none}}
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
  /* THE ALTERNATIVES PANEL'S HOST (AlternativesPanel.jsx): the quick-view
     goes wide and fixed-height. The panel takes the flexible height and
     scrolls inside; the shoe's own sizes, Display Partner, quantity and Add
     become a fixed footer band that never moves with the grid. */
  .ad-root--wall .ad-sv.ad-sv--alt{width:min(1240px,calc(100vw - 52px));height:min(860px,calc(100vh - 40px));max-height:none;display:flex;flex-direction:column;overflow:hidden}
  .ad-sv--alt .ad-svimg{display:none}
  .ad-altwrap{flex:1;min-height:0;display:flex;flex-direction:column;padding-top:18px}
  .ad-alttitle{font-size:17px;font-weight:800;color:#fff;padding:0 64px 6px 22px}
  .ad-sv--alt .ad-svbody{flex:0 0 auto;border-top:1px solid #1c1c1c;padding:12px 22px 16px;display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-end;gap:10px 22px;animation:none}
  .ad-sv--alt .ad-svbody>div:first-child{flex:0 0 100%;display:flex;align-items:baseline;gap:14px}
  .ad-sv--alt .ad-svname{font-size:15px}
  .ad-sv--alt .ad-svprice{font-size:16px;margin-top:0!important}
  .ad-sv--alt .ad-svbody>div:last-child{margin-left:auto}
`;

// The photo, faded in once it has loaded so the #0a0a0a ground is the
// placeholder. A failed load keeps the ground and shows the name instead.
export function TilePhoto({ p }) {
  const [state, setState] = useState("loading");
  if (!p.photoUrl || state === "error") return <span className="sw-noimg">{p.name}</span>;
  return (
    <MirroredImg productId={p.id} src={p.photoUrl} alt="" draggable={false} loading="lazy" decoding="async"
                 className={state === "ok" ? "ok" : undefined}
                 onLoad={() => setState("ok")} onError={() => setState("error")} />
  );
}

export default function SneakerWall({
  availableShops, effectiveShop, shopRegistry, onPickShop,
  mode, setMode, onSwitchView, userEmail,
  search, setSearch, searchRef, onLabelFind,
  shownCount, visible, onShowMore, modalOpen = false,
  sizeGate, onQuickAdd, onOpenDetails, onViewPhoto, renderTileActions, onOutSize,
  grouped, units, total, onRemoveOne, onAddDisplayPartner, onCheckout,
}) {
  const [openId, setOpenId] = useState(null);     // the ONE tile showing its details
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openTileRef = useRef(null);
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

  // A new result set closes the overlay only when its tile left the wall — a
  // live stock update re-renders the list and must not shut it mid-tap.
  useEffect(() => {
    if (openId && !visible.some(p => p.id === openId)) setOpenId(null);
  }, [visible, openId]);

  // Tap outside the open tile (or the open menu) closes it. pointerdown, so a
  // tap on ANOTHER tile closes this one before its own click opens the next.
  useEffect(() => {
    if (!openId && !menuOpen) return undefined;
    if (typeof document === "undefined") return undefined;
    const h = (e) => {
      if (openId && !openTileRef.current?.contains(e.target)) setOpenId(null);
      if (menuOpen && !menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [openId, menuOpen]);

  // Escape closes, innermost first. The "/" shortcut stays AssistantDesktop's.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const h = (e) => {
      if (e.key !== "Escape" || modalOpen) return;
      if (menuOpen) setMenuOpen(false);
      else if (openId) setOpenId(null);
      else if (drawerOpen) setDrawerOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [menuOpen, openId, drawerOpen, modalOpen]);

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
              <WallTile key={p.id} p={p} open={openId === p.id} tileRef={openId === p.id ? openTileRef : undefined}
                        setOpenId={setOpenId} sizeGate={sizeGate} onQuickAdd={onQuickAdd}
                        onOpenDetails={onOpenDetails} onViewPhoto={onViewPhoto} renderTileActions={renderTileActions}
                        onOutSize={onOutSize} />
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
                               emptyHint="Tap a photo, then a size." />
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

// One tile. Memoised: opening or hovering a tile changes `open` for two tiles
// only, so the other fifty-eight skip their render on the till.
const WallTile = memo(function WallTile({ p, open, tileRef, setOpenId, sizeGate, onQuickAdd, onOpenDetails, onViewPhoto, renderTileActions, onOutSize }) {
  return (
    <div className="sw-tile" data-open={open} ref={tileRef}
         onPointerEnter={e => { if (e.pointerType === "mouse") setOpenId(p.id); }}
         onPointerLeave={e => { if (e.pointerType === "mouse") setOpenId(id => (id === p.id ? null : id)); }}>
      <button type="button" className="sw-tbtn" aria-label={p.name} aria-expanded={open}
              onFocus={() => setOpenId(p.id)} onClick={() => setOpenId(p.id)}>
        <TilePhoto key={p.photoUrl || ""} p={p} />
      </button>
      {open && <TileDetails p={p} sizeGate={sizeGate} onQuickAdd={onQuickAdd}
                            onOpenDetails={onOpenDetails} onViewPhoto={onViewPhoto}
                            renderTileActions={renderTileActions} onOutSize={onOutSize} />}
    </div>
  );
});

// The overlay on an open tile: name, price, size pills, and the affordances
// that used to live on the resting card (photo zoom, the ⓘ quick-view).
// EXPORTED: the alternatives panel opens the SAME overlay on the shoe the
// assistant picked (AlternativesPanel.jsx), so the two cannot drift.
//   onOutSize — a struck size opens the alternatives for it (it never adds);
//               absent, a struck size is simply disabled.
//   onAdded   — after an add that actually happened (the panel closes on it).
export function TileDetails({ p, sizeGate, onQuickAdd, onOpenDetails, onViewPhoto, renderTileActions, onOutSize, onAdded }) {
  const priced = typeof p.retailPrice === "number" && p.retailPrice > 0;
  return (
    <>
      {renderTileActions ? <div className="sw-acts">{renderTileActions(p)}</div> : null}
      <div className="sw-tools">
        {p.photoUrl && onViewPhoto && (
          <button type="button" className="sw-ib" aria-label={`Enlarge photo of ${p.name}`} onClick={() => onViewPhoto(p)}>
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>
        )}
        {onOpenDetails && (
          <button type="button" className="sw-ib" aria-label={`More about ${p.name}`} onClick={() => onOpenDetails(p)}>
            <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>
          </button>
        )}
      </div>
      <div className="sw-ov">
        <div className="sw-ovhead">
          <div className="sw-name">{p.name}{isDeactivated(p) ? <span className="sw-dead">DEACTIVATED</span> : null}</div>
          {priced ? <div className="sw-price">{fmtR(p.retailPrice)}</div> : <div className="sw-price no">No price set</div>}
        </div>
        <div className="sw-szrow">
          {sizesOf(p).map(sz => {
            // The same gate as the old hover grid. An out size is struck
            // through and NEVER adds. A SNEAKER out size (the gate's
            // `tappable` — never clothing, never deactivated) opens the
            // "available now instead" panel for that size, the route the old
            // hover grid's ✕ chip took; anything else out is disabled.
            const { out, tappable, dInfo, title } = quickAddSizeState(p, sz, sizeGate);
            const label = sz === "Free Size" ? "OS" : formatSize(sz);
            const altTap = out && tappable && !!onOutSize;
            return (
              <button key={sz} type="button" className={altTap ? "sw-sz out" : "sw-sz"} disabled={out && !altTap} title={title}
                      aria-label={altTap ? `Size ${label}, not available — show what is` : out ? `Size ${label}, not available` : `Add size ${label}`}
                      onClick={e => {
                        if (altTap) { onOutSize(p, sz); return; }
                        if (out) return;
                        // quickAdd returns 0 when the cart already holds
                        // everything the hub has — no flash for an add that
                        // didn't happen. Class-only flash (see the hover grid).
                        if (!onQuickAdd(p, sz, 1)) return;
                        const b = e.currentTarget;
                        b.classList?.add("flash");
                        setTimeout(() => b.classList?.remove("flash"), 430);
                        onAdded?.(p, sz);
                      }}>
                {label}
                {dInfo ? <span aria-hidden="true" style={{ position: "absolute", top: 2, right: 3, lineHeight: 1 }}><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="rgba(185,190,255,.8)" strokeWidth="3"><rect x="3" y="5" width="18" height="12" rx="2"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg></span> : null}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
