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

import { useEffect, useState } from "react";
import { SkyHeader, SkySearch, SkyBrandStrip, SkyStorePill, ProductStage, SkyPlus, SkyBottomBar } from "./Sky.jsx";
import { fmtR } from "../assistant/assistantOrderModel.js";

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
  // THE STICKY TOP (Junid, 6 Nov): wordmark, store line, search and brands stay
  // put; only the grid scrolls, passing underneath. The band is sticky from the
  // start (no reflow when it "sticks"); its glass fades in once the page has
  // moved, so at rest it is the frozen picture.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const on = () => setStuck(window.scrollY > 2);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <div className="ap-root" data-testid="assistant-phone">
      <style>{AP_CSS}</style>
      <div className="ap-top" data-testid="ap-top" data-stuck={stuck ? "true" : undefined}>
        <div className="ap-topglass" aria-hidden="true" />
      {/* The store pill replaces the old ASSISTANT tag and the store row.
          Only the shops this account is assigned to; with one (auto-selected)
          it is a plain pill, so nobody can mis-pick a store that is not theirs. */}
      <SkyHeader onGrid={onExit} gridLabel="Switch view"
                 tagNode={<span className="ap-store" data-contrast-exempt=""><SkyStorePill value={effectiveShop} stores={shops} labelOf={shopLabel}
                                        onPick={(id) => { if (id !== effectiveShop) onShop(id); }}
                                        mode={mode === "clothing" ? "clothing" : mode === "cr" ? "cr" : "sneaker"}
                                        modes={onMode ? [["sneaker", "Sneakers"], ["clothing", "Clothing"]] : null} onMode={onMode} /></span>}
                 onUser={() => setMe((v) => !v)} userLabel="Account" />
      {me && (
        <div className="ap-me sky-glass" role="menu">
          <div className="ap-mewho">{who || "Store assistant"}</div>
          <div className="ap-mesub">Store assistant{effectiveShop ? ` · ${shopLabel(effectiveShop)}` : ""}</div>
          <button type="button" className="ap-mebtn" onClick={() => { setMe(false); onExit(); }}>Switch view</button>
        </div>
      )}

      <div className="ap-search">
        <SkySearch value={search} onChange={onSearch} onAction={onScan} action="camera" actionLabel="Find by the tongue label" />
      </div>

      {/* The brand strip — phones only (below 768px; the CSS hides it above).
          The same brand value as the desktop chip row (AssistantView). */}
      {brands && brands.length > 1 && onBrand ? (
        <div data-contrast-exempt=""><SkyBrandStrip className="ap-brands" brands={brands} value={brand} onChange={onBrand} /></div>
      ) : null}
      </div>

      {children}

      {showGrid && (products.length === 0 ? (
        <div className="ap-empty sky-glass">{emptyText}</div>
      ) : (
        <div className="ap-grid">
          {products.map((p) => {
            const priced = typeof p.retailPrice === "number" && p.retailPrice > 0;
            const dead = isDead ? isDead(p) : false;
            const n = photoCount ? photoCount(p) : 0;
            return (
              <article key={p.id} className="sky-card sky-glass ap-card" tabIndex={0}
                       aria-current={selectedId === p.id ? "true" : undefined}
                       onClick={() => onOpen(p)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(p); }}>
                {/* The photo (or its 👟 stand-in) is a picture, not text. */}
                <div data-contrast-exempt="" style={{ display: "contents" }}><ProductStage p={p} height="var(--ap-stage)" emoji={p.photo || "👟"} /></div>
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
                      ? <span className="sky-price ap-price" data-contrast-exempt="">{fmtR(p.retailPrice)}</span>
                      : <span className="ap-noprice" data-contrast-exempt="">No price set</span>}
                    <SkyPlus label={`Add ${p.name}`} onClick={(e) => { e.stopPropagation(); onOpen(p); }} />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ))}

      {/* Bottom room for the cart bar + safe area, so the last row is never under it. */}
      <div style={{ height: "var(--sky-bar-space)" }} />
      {showBar && cartCount > 0 ? <SkyBottomBar count={cartCount} onOpen={onCart} label={cartLabel} disabled={cartDisabled} /> : null}
    </div>
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
.ap-top{position:sticky;top:0;z-index:40;padding-bottom:11px}
.ap-topglass{position:absolute;inset:0 calc(-1 * var(--sky-sar)) 0 calc(-1 * var(--sky-sal));z-index:0;pointer-events:none;opacity:0;transition:opacity .18s ease-out;
  background:linear-gradient(180deg,rgba(24,110,222,.95),rgba(36,126,232,.9));-webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4);
  border-bottom:1px solid rgba(255,255,255,.32);box-shadow:0 10px 24px -16px rgba(0,30,90,.55)}
.ap-top[data-stuck="true"] .ap-topglass{opacity:1}
.ap-top > .sky-header,.ap-top > .ap-search,.ap-top > [data-contrast-exempt]{position:relative;z-index:1}
@media (prefers-reduced-motion:reduce){.ap-topglass{transition:none}}
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
.ap-me{position:absolute;right:16px;top:calc(env(safe-area-inset-top,0px) + 64px);z-index:70;width:230px;border-radius:20px;padding:14px;background:var(--sky-glass-strong)!important;color:var(--sky-ink)}
.ap-mewho{font-size:16px;font-weight:800}
.ap-mesub{font-size:12px;color:var(--sky-ink-2);margin:2px 0 10px}
.ap-mebtn{width:100%;height:40px;border-radius:999px;border:1px solid #fff;background:var(--sky-glass-solid);color:var(--sky-navy);font:800 14px/1 var(--sky-font);cursor:pointer}
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
.ap-brands{margin:18px 0 0}
.ap-root .sky-brandstrip{gap:8px;padding:0 24px 0;scroll-padding-inline:24px;align-items:center;height:32px}
html[data-sky="on"] #root .ap-root .sky-brandchip{height:32px;min-width:57px;padding:0 15px;background:none!important;border:0!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;color:#fff!important;filter:drop-shadow(0 1px 3px rgba(0,40,110,.3))}
html[data-sky="on"] #root .ap-root .sky-brandchip[aria-pressed="true"]{background:#fff!important;color:var(--sky-navy)!important;filter:none;box-shadow:0 3px 10px rgba(0,40,120,.15)!important}
html[data-sky="on"] #root .ap-root .sky-brandchip--all{font:700 13.9px/1 var(--sky-font)}
.ap-root .sky-brandchip svg{height:20px;max-width:33px;fill:currentColor}
.ap-root .sky-brandchip .sky-chip__txt{font-size:11.7px;font-weight:700;letter-spacing:.04em}
@media (min-width:768px){.ap-brands{display:none}}
.ap-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 12px;padding:12px 18.5px 0}
@media (min-width:600px){.ap-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (min-width:820px){.ap-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
html[data-sky="on"] #root .ap-root .ap-card{display:flex;flex-direction:column;border-radius:16px;color:#fff;background:rgba(255,255,255,.14)!important;border:1px solid rgba(255,255,255,.5)!important;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 22px rgba(0,40,120,.12)!important;-webkit-backdrop-filter:blur(16px) saturate(1.3);backdrop-filter:blur(16px) saturate(1.3)}
.ap-card[aria-current="true"]{outline:2px solid #fff;outline-offset:-1px}
.ap-root .ap-card .sky-stage{height:114px!important;padding:0;flex:0 0 auto}
.ap-root .ap-card .sky-frame{inset:13px 0 0;background:none;border-radius:0;align-items:flex-start}
.ap-root .ap-card .sky-frame img{max-width:92px;max-height:101px;border-radius:9px}
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
