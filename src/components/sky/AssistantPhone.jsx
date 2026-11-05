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

import { useState } from "react";
import { SkyHeader, SkySearch, SkyBrandStrip, SkyStorePill, ProductStage, SkyPlus, SkyBottomBar } from "./Sky.jsx";
import { IconExpand } from "./SkyIcons.jsx";
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
  return (
    <div className="ap-root" data-testid="assistant-phone">
      <style>{AP_CSS}</style>
      {/* The store pill replaces the old ASSISTANT tag and the store row.
          Only the shops this account is assigned to; with one (auto-selected)
          it is a plain pill, so nobody can mis-pick a store that is not theirs. */}
      <SkyHeader onGrid={onExit} gridLabel="Switch view"
                 tagNode={<SkyStorePill value={effectiveShop} stores={shops} labelOf={shopLabel}
                                        onPick={(id) => { if (id !== effectiveShop) onShop(id); }}
                                        mode={mode === "clothing" ? "clothing" : mode === "cr" ? "cr" : "sneaker"}
                                        modes={onMode ? [["sneaker", "Sneakers"], ["clothing", "Clothing"]] : null} onMode={onMode} />}
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
        <SkyBrandStrip className="ap-brands" brands={brands} value={brand} onChange={onBrand} />
      ) : null}

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
                <ProductStage p={p} height="var(--ap-stage)" emoji={p.photo || "👟"} />
                {p.photoUrl && onViewPhotos && (
                  <button type="button" className="ap-zoom" aria-label={n > 1 ? `View ${n} photos` : "View full photo"}
                          onClick={(e) => { e.stopPropagation(); onViewPhotos(p); }}>
                    <IconExpand width={14} height={14} />
                    {n > 1 ? <span>{n}</span> : null}
                  </button>
                )}
                {renderActions ? renderActions(p) : null}
                <div className="ap-body">
                  <div className="sky-name ap-name">{p.name}{renderDeactivated ? renderDeactivated(p) : null}</div>
                  {dead ? <div className="ap-dead">Deactivated — no sizes on offer</div> : null}
                  <div className="ap-row">
                    {priced
                      ? <span className="sky-price ap-price">{fmtR(p.retailPrice)}</span>
                      : <span className="ap-noprice">No price set</span>}
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

// Measured off assistant-phone.png (852px wide = a 426px phone at 2x).
const AP_CSS = `
.ap-root{max-width:880px;margin:0 auto;color:var(--sky-ink);font-family:var(--sky-font);--ap-stage:clamp(112px,32vw,128px);position:relative}
.ap-root .sky-header{padding-top:calc(env(safe-area-inset-top,0px) + 16px)}
.ap-root .sky-header__c{gap:8px;margin-top:-2px}
.ap-root .sky-header .sky-round{width:37px;height:37px}
.ap-root .sky-header{--sky-logo-mid:22px}
.ap-root .sky-header .sky-round svg{width:19px;height:19px}
.ap-me{position:absolute;right:16px;top:calc(env(safe-area-inset-top,0px) + 72px);z-index:70;width:230px;border-radius:20px;padding:14px;background:var(--sky-glass-strong)!important;color:var(--sky-ink)}
.ap-mewho{font-size:16px;font-weight:800}
.ap-mesub{font-size:12px;color:var(--sky-ink-2);margin:2px 0 10px}
.ap-mebtn{width:100%;height:40px;border-radius:999px;border:1px solid #fff;background:var(--sky-glass-solid);color:var(--sky-navy);font:800 14px/1 var(--sky-font);cursor:pointer}
.ap-search{padding:12px 16px 0;max-width:560px;margin:0 auto}
.ap-search .sky-search{height:46px}
.ap-brands{margin:12px 0 -5px}
@media (min-width:768px){.ap-brands{display:none}}
.ap-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px;padding:17px 12px 0}
@media (min-width:600px){.ap-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (min-width:820px){.ap-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.ap-card{border-radius:20px;color:var(--sky-ink)}
.ap-card[aria-current="true"]{box-shadow:0 0 0 2px #fff,var(--sky-shadow-lg)}
.ap-card .sky-stage{padding-top:8px}
.ap-card .sky-podium{width:86%;bottom:6px}
.ap-card .sky-cutout{max-width:88%}
.ap-card .sky-frame{inset:8px 8px 2px;border-radius:14px}
.ap-body{padding:8px 12px 10px 16px;display:flex;flex-direction:column;gap:6px;flex:1}
/* The name + price sit on a whiter band of the card's own glass: with the
   compact top band the first row rides over the room's light strip, and the
   blue price needs the body behind it (DNA: stronger surface for dense text). */
.ap-body{background:rgba(255,255,255,.22);border-radius:0 0 20px 20px}
.ap-name{font-size:12.5px;font-weight:700;line-height:1.24;color:var(--sky-ink);-webkit-line-clamp:3}
.ap-row{display:flex;align-items:center;justify-content:space-between;margin-top:auto}
.ap-price{font-size:17.5px;color:var(--sky-navy)}
.ap-dead{font-size:11px;font-weight:700;color:var(--sky-ink-2)}
.ap-noprice{font-size:11.5px;font-weight:700;color:var(--sky-ink-2)}
.ap-zoom{position:absolute;top:8px;right:8px;z-index:2;height:28px;min-width:28px;padding:0 7px;border-radius:999px;display:inline-flex;align-items:center;gap:4px;
  border:1px solid var(--sky-rim);background:var(--sky-glass);-webkit-backdrop-filter:blur(28px) saturate(1.6) brightness(1.05);backdrop-filter:blur(28px) saturate(1.6) brightness(1.05);color:var(--sky-ink);font:800 11px/1 var(--sky-font);cursor:pointer}
.ap-empty{margin:24px 16px 0;border-radius:20px;padding:30px 16px;text-align:center;font-weight:600}
.ap-root .sky-bottombar{max-width:820px;margin:0 auto}
@media (min-width:880px){.ap-root .sky-bottombar{left:50%;right:auto;transform:translateX(-50%);width:820px}}
`;
