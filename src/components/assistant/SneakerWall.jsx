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

import { useEffect, useRef, useState } from "react";
import { MirroredImg } from "../../offline/MirroredImg.jsx";
import { labelFor } from "../stock/locations";
import { isDeactivated } from "../../utils/deactivation";
import { formatSize } from "../../utils/sizeLabel";
import OrderLinesPanel from "./OrderLinesPanel.jsx";
import { fmtR, quickAddSizeState, sizesOf } from "./assistantOrderModel";

const WALL_CSS = `
  .sw-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#0b0b0d;color:#f2f2f2;overflow:hidden}
  .sw-glow{position:absolute;left:0;right:0;top:0;height:220px;background:linear-gradient(180deg,#16161a 0%,#0b0b0d 100%);pointer-events:none}
  .sw-top{position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:26px 24px 22px}
  .sw-side{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px}
  .sw-side.r{justify-content:flex-end}
  .sw-chip{height:44px;padding:0 18px;border-radius:22px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#a9a9b3;font-size:15px;font-weight:500;cursor:pointer;font-family:inherit;white-space:nowrap;flex:0 0 auto}
  .sw-chip[aria-pressed="true"]{border-color:#5b63ff;background:rgba(91,99,255,.18);color:#dfe1ff;font-weight:600}
  .sw-chip:focus-visible,.sw-more:focus-visible,.sw-pill:focus-visible,.sw-cam:focus-visible,.sw-tbtn:focus-visible,.sw-sz:focus-visible,.sw-ib:focus-visible,.sw-loadmore:focus-visible{outline:2px solid #b9beff;outline-offset:2px}
  .sw-menuwrap{position:relative;flex:0 0 auto}
  .sw-more{width:44px;height:44px;border-radius:22px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#c9c9cf;cursor:pointer;display:grid;place-items:center}
  .sw-menu{position:absolute;top:52px;left:0;z-index:20;min-width:220px;padding:6px;border-radius:14px;background:#17171b;border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:2px}
  .sw-menu .who{padding:8px 12px 6px;font-size:11px;color:#8b8b95;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sw-menu button{display:flex;align-items:center;gap:10px;text-align:left;padding:11px 12px;border-radius:10px;border:0;background:transparent;color:#e6e6ea;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  .sw-menu button:hover,.sw-menu button:focus-visible{background:rgba(255,255,255,.07);outline:none}
  .sw-menu button[aria-current="true"]{color:#b9beff}
  .sw-search{flex:0 1 640px;min-width:280px;height:60px;display:flex;align-items:center;gap:14px;padding:0 10px 0 22px;border-radius:30px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);cursor:text}
  .sw-search:focus-within{border-color:rgba(91,99,255,.7)}
  .sw-search input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#f2f2f2;font-size:20px;font-family:inherit}
  .sw-search input::placeholder{color:#8b8b95}
  .sw-cam{width:40px;height:40px;flex:0 0 auto;border-radius:20px;border:0;background:rgba(255,255,255,.1);display:grid;place-items:center;cursor:pointer}
  .sw-pill{height:52px;padding:0 20px 0 16px;border-radius:26px;border:0;background:#5b63ff;color:#fff;font-size:17px;font-weight:700;display:flex;align-items:center;gap:12px;cursor:pointer;font-family:inherit;font-variant-numeric:tabular-nums;white-space:nowrap}
  .sw-badge{display:flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 7px;border-radius:13px;background:#fff;color:#3a40c7;font-size:14px}
  .sw-scroll{position:relative;flex:1;min-height:0;overflow:auto;padding:0 24px 24px}
  .sw-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
  /* 4:5 tiles. The photos are mostly 600×800 portrait (2026-08-13 survey):
     cover in a 4:5 box trims ~6% of a portrait's height, where the artboard's
     near-square box would cut ~20%. content-visibility skips paint for the
     rows scrolled away — the till's UHD 600 is why the old grid needed it. */
  .sw-tile{position:relative;aspect-ratio:4/5;border-radius:18px;overflow:hidden;background:#1a1a1e;content-visibility:auto;contain-intrinsic-size:auto 420px}
  .sw-tile::after{content:"";position:absolute;inset:0;border-radius:18px;pointer-events:none;z-index:3;box-shadow:inset 0 0 0 3px transparent;transition:box-shadow .12s}
  .sw-tile[data-open="true"]::after{box-shadow:inset 0 0 0 3px #5b63ff}
  .sw-tbtn{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:pointer;display:block;border-radius:18px}
  .sw-tbtn img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity .2s}
  .sw-tbtn img.ok{opacity:1}
  .sw-noimg{position:absolute;inset:0;display:grid;place-items:center;padding:18px;text-align:center;color:#6e6e78;font-size:14px;font-weight:600;line-height:1.3}
  .sw-ov{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:70px 16px 14px;background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,.82) 45%,rgba(0,0,0,.92) 100%);display:flex;flex-direction:column;gap:10px}
  .sw-ovhead{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .sw-name{font-size:16px;font-weight:600;color:#fff;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .sw-price{font-size:20px;font-weight:800;color:#b9beff;white-space:nowrap;font-variant-numeric:tabular-nums}
  .sw-price.no{font-size:13px;font-weight:700;color:#8b8b95}
  .sw-dead{margin-left:6px;font-size:10px;font-weight:800;letter-spacing:.06em;padding:2px 6px;border-radius:6px;background:rgba(150,160,190,.18);border:1px solid rgba(150,160,190,.4);color:#B9C0D4;vertical-align:middle}
  .sw-szrow{display:flex;flex-wrap:wrap;gap:6px}
  .sw-sz{position:relative;width:46px;height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;font-variant-numeric:tabular-nums;padding:0;transition:background .12s,border-color .12s}
  .sw-sz:hover{background:rgba(91,99,255,.35)}
  .sw-sz.flash{background:#5b63ff;border-color:#5b63ff;font-weight:700}
  .sw-sz:disabled{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.03);color:#6e6e78;text-decoration:line-through;cursor:not-allowed;font-weight:500}
  .sw-tools{position:absolute;top:10px;right:10px;z-index:4;display:flex;gap:6px}
  .sw-ib{width:36px;height:36px;border-radius:18px;border:0;background:rgba(0,0,0,.55);color:#fff;display:grid;place-items:center;cursor:pointer}
  .sw-acts{position:absolute;top:10px;left:10px;z-index:4}
  .sw-foot{display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 0 8px;color:#8b8b95;font-size:12px}
  .sw-loadmore{padding:13px 26px;border-radius:26px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e6e6ea;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}
  .sw-loadmore:hover{border-color:#5b63ff;background:rgba(91,99,255,.18)}
  .sw-empty{text-align:center;color:#8b8b95;padding:80px 20px;font-size:15px}
  .sw-scrim{position:fixed;inset:0;z-index:55;background:rgba(0,0,0,.45);animation:swFade .18s ease}
  .sw-drawer{position:fixed;top:0;right:0;bottom:0;z-index:56;width:min(420px,100vw);background:#111114;border-left:1px solid rgba(255,255,255,.1);box-shadow:-30px 0 80px rgba(0,0,0,.5);display:flex;flex-direction:column;animation:swSlide .24s cubic-bezier(.2,.7,.2,1)}
  .sw-dhead{display:flex;align-items:center;gap:10px;padding:22px 18px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
  .sw-dhead h2{margin:0;font-size:17px;font-weight:800}
  .sw-dclose{margin-left:auto;width:40px;height:40px;border-radius:20px;border:0;background:rgba(255,255,255,.07);color:#fff;font-size:16px;cursor:pointer}
  @keyframes swSlide{from{transform:translateX(100%)}to{transform:none}}
  @keyframes swFade{from{opacity:0}to{opacity:1}}
  @media(prefers-reduced-motion:reduce){.sw-drawer,.sw-scrim{animation:none}.sw-tbtn img{transition:none}}
`;

// The photo, faded in once it has loaded so the #1a1a1e ground is the
// placeholder. A failed load keeps the ground and shows the name instead.
function TilePhoto({ p }) {
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
  shownCount, visible, onShowMore,
  sizeGate, onQuickAdd, onOpenDetails, onViewPhoto, renderTileActions,
  grouped, units, total, onRemoveOne, onAddDisplayPartner, onCheckout,
}) {
  const [openId, setOpenId] = useState(null);     // the ONE tile showing its details
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openTileRef = useRef(null);
  const menuRef = useRef(null);

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
      if (e.key !== "Escape") return;
      if (menuOpen) setMenuOpen(false);
      else if (openId) setOpenId(null);
      else if (drawerOpen) setDrawerOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [menuOpen, openId, drawerOpen]);

  const pickMenu = (fn) => { setMenuOpen(false); fn(); };

  return (
    <div className="sw-root">
      <style>{WALL_CSS}</style>
      <div className="sw-glow" aria-hidden="true" />

      {/* TOP BAR — overflow + store chips · search · order pill */}
      <div className="sw-top">
        <div className="sw-side">
          <div className="sw-menuwrap" ref={menuRef}>
            <button type="button" className="sw-more" aria-label="More: order type and switch view"
                    aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}>
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
            {menuOpen && (
              <div className="sw-menu" role="menu">
                {userEmail ? <div className="who">{userEmail.split("@")[0]} · Store assistant</div> : null}
                <button type="button" role="menuitem" aria-current={mode === "sneaker"} onClick={() => pickMenu(() => setMode("sneaker"))}>Sneaker order</button>
                <button type="button" role="menuitem" aria-current={mode === "clothing"} onClick={() => pickMenu(() => setMode("clothing"))}>Clothing order</button>
                <button type="button" role="menuitem" onClick={() => pickMenu(onSwitchView)}>Switch view</button>
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
          <button type="button" className="sw-pill" onClick={() => setDrawerOpen(true)}
                  aria-label={`Order: ${units} item${units !== 1 ? "s" : ""}, ${fmtR(total)}`}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.6a1 1 0 0 0 1-.8L21 8H6"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17.5" cy="20" r="1.3"/></svg>
            <span className="sw-badge" data-testid="order-count">{units}</span>
            <span data-testid="order-total">{fmtR(total)}</span>
          </button>
        </div>
      </div>

      {/* THE WALL */}
      <div className="sw-scroll">
        {shownCount === 0 ? (
          <div className="sw-empty">No products match.</div>
        ) : (
          <div className="sw-grid">
            {visible.map(p => {
              const open = openId === p.id;
              return (
                <div key={p.id} className="sw-tile" data-open={open} ref={open ? openTileRef : undefined}
                     onPointerEnter={e => { if (e.pointerType === "mouse") setOpenId(p.id); }}
                     onPointerLeave={e => { if (e.pointerType === "mouse") setOpenId(id => (id === p.id ? null : id)); }}>
                  <button type="button" className="sw-tbtn" aria-label={p.name} aria-expanded={open}
                          onFocus={() => setOpenId(p.id)} onClick={() => setOpenId(p.id)}>
                    <TilePhoto p={p} />
                  </button>
                  {open && <TileDetails p={p} sizeGate={sizeGate} onQuickAdd={onQuickAdd}
                                        onOpenDetails={onOpenDetails} onViewPhoto={onViewPhoto}
                                        renderTileActions={renderTileActions} />}
                </div>
              );
            })}
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
              <button type="button" className="sw-dclose" onClick={() => setDrawerOpen(false)} aria-label="Close order">✕</button>
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

// The overlay on the one open tile: name, price, size pills, and the two
// affordances that used to live on the resting card (photo zoom, and the full
// quick-view where a ✕ size explains itself and offers alternatives, and the
// Display Partner request lives).
function TileDetails({ p, sizeGate, onQuickAdd, onOpenDetails, onViewPhoto, renderTileActions }) {
  const priced = typeof p.retailPrice === "number" && p.retailPrice > 0;
  return (
    <>
      {renderTileActions ? <div className="sw-acts">{renderTileActions(p)}</div> : null}
      <div className="sw-tools">
        {p.photoUrl && (
          <button type="button" className="sw-ib" aria-label={`Enlarge photo of ${p.name}`} onClick={() => onViewPhoto(p)}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>
        )}
        <button type="button" className="sw-ib" aria-label={`More about ${p.name}`} onClick={() => onOpenDetails(p)}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>
        </button>
      </div>
      <div className="sw-ov">
        <div className="sw-ovhead">
          <div className="sw-name">{p.name}{isDeactivated(p) ? <span className="sw-dead">DEACTIVATED</span> : null}</div>
          {priced ? <div className="sw-price">{fmtR(p.retailPrice)}</div> : <div className="sw-price no">No price set</div>}
        </div>
        <div className="sw-szrow">
          {sizesOf(p).map(sz => {
            // The same gate as the old hover grid. An out size is struck
            // through and NOT tappable here (Junid's spec); its reason is in
            // the title, and the ⓘ quick-view still explains it on a tap.
            const { out, dInfo, title } = quickAddSizeState(p, sz, sizeGate);
            const label = sz === "Free Size" ? "OS" : formatSize(sz);
            return (
              <button key={sz} type="button" className="sw-sz" disabled={out} title={title}
                      aria-label={out ? `Size ${label}, not available` : `Add size ${label}`}
                      onClick={e => {
                        if (out) return;
                        // quickAdd returns 0 when the cart already holds
                        // everything the hub has — no flash for an add that
                        // didn't happen. Class-only flash (see the hover grid).
                        if (!onQuickAdd(p, sz, 1)) return;
                        const b = e.currentTarget;
                        b.classList?.add("flash");
                        setTimeout(() => b.classList?.remove("flash"), 430);
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
