// ─── BARCODE CATALOG ──────────────────────────────────────────────────────────
// Browse-and-batch-print barcodes across the whole catalog (the standalone card to
// complement the on-save sheet in Set Qty / New Product). Search products, expand a
// product to see its sizes with current on-hand (summed across all locations),
// select sizes across one or many products, set copies per size, and print them all
// in one batch. Reuses the #73 value model + transport exactly:
//   • ensureBarcode (generate-if-missing / reuse-if-present / never regenerate) —
//     called ONLY at print time, so merely browsing never reserves codes.
//   • printLabels / TRANSPORTS (Phomemo / Xprinter) as-is.
// Admin-only. Read-only against /stock (display of on-hand); the only write is the
// barcode reservation at print, via the shared barcodeStore.

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef } from "react";
import { ref, set } from "firebase/database";
import { database } from "../../firebase";
import { useStockCells, useLocations } from "./useStock";
import { transferTargets, labelFor } from "./locations";
import FilterPicker from "./FilterPicker";
import { ensureBarcode, getBarcode } from "./barcodeStore";
import { code128Modules } from "./barcode";
import { TRANSPORTS, printLabels, printTest, connectTransport, getXprinterDiag, defaultTransportId, rememberTransport } from "./printers";
import PrinterStatus from "./PrinterStatus";
import { Toast, Empty } from "./widgets";
import { GLASS, CARD, GRAY, GREEN, BLUE_L, AMBER, BORDER, FONT, BG, bGreen, bGhost, input } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { isDeactivated } from "../../utils/deactivation";
import { formatSize } from "../../utils/sizeLabel";
import { SizeTag } from "../SizeTag";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { scopedLocationIds, withinScope } from "../../utils/shopScope";
import { PrimaryPhoto } from "../shared/PrimaryPhoto.jsx";
import { primaryPhotoUrl } from "../../utils/primaryPhoto";

const keyOf = (pid, size) => `${pid}|${size}`;

// Laptop breakpoint — switches Barcodes into the centered workspace layout.
function useWide(px = 1024) {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(`(min-width:${px}px)`).matches);
  useEffect(() => {
    const m = window.matchMedia(`(min-width:${px}px)`);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [px]);
  return wide;
}

// Product thumbnail — same pattern as Transfer/Locator (product.photoUrl). Tap to open full.
function Thumb({ product, size = 40, onOpen }) {
  const url = primaryPhotoUrl(product);
  if (url) return <PrimaryPhoto product={product} alt="" onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(); } : undefined}
    style={{ width: size, height: size, objectFit: "cover", borderRadius: 9, flexShrink: 0, cursor: onOpen ? "zoom-in" : "default" }}
    onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 9, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>👟</div>;
}

// ─── THE PRODUCT CARD (sky redesign, Junid 5 Nov: "complete redesign, make it
// proper") ───────────────────────────────────────────────────────────────────
// One glass card for both layouts. Presentation only: the same handlers as the
// old row — tap the head to open/close (setOpenId), tap a size to pick it
// (toggle + setLastKey, exactly what the checkbox did), the stepper and the
// copies field write the same count, the photo opens the same lightbox.
export const BCS_CSS = `
.bcs2{border-radius:22px;color:var(--sky-ink);font-family:var(--sky-font);overflow:hidden;
  background:rgba(255,255,255,.42);border:1px solid rgba(255,255,255,.8);box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 10px 26px rgba(10,60,140,.16);
  -webkit-backdrop-filter:blur(28px) saturate(1.6) brightness(1.05);backdrop-filter:blur(28px) saturate(1.6) brightness(1.05);transition:box-shadow .18s,background .18s}
.bcs2:hover{background:rgba(255,255,255,.52)}
.bcs2[data-open="1"]{background:rgba(255,255,255,.6);box-shadow:inset 0 1px 0 #fff,0 16px 36px rgba(10,60,140,.22)}
.bcs2[data-picked="1"]{box-shadow:inset 0 0 0 2px var(--sky-navy),0 10px 26px rgba(10,60,140,.16)}
.bcs2__head{display:flex;align-items:center;gap:14px;width:100%;min-height:72px;padding:9px 16px 9px 10px;background:none;border:0;cursor:pointer;text-align:left;color:inherit;font:inherit}
.bcs2__ph{flex:0 0 auto;width:54px;height:54px;border-radius:13px;overflow:hidden;background:#fff;box-shadow:0 3px 10px rgba(10,60,140,.16);display:grid;place-items:center;font-size:24px}
.bcs2__ph img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}
.bcs2__tx{flex:1;min-width:0;display:flex;flex-direction:column}
.bcs2__nm{font-size:16px;font-weight:800;line-height:1.25;letter-spacing:-.01em;color:var(--sky-ink-deep);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bcs2__meta{margin-top:3px;font-size:14px;font-weight:600;color:var(--sky-ink)}
.bcs2__sel{flex:0 0 auto;font-size:12px;font-weight:800;color:#fff;background:var(--sky-navy);border-radius:999px;padding:4px 10px;font-variant-numeric:tabular-nums}
.bcs2__chev{flex:0 0 auto;width:22px;height:22px;display:grid;place-items:center;color:var(--sky-ink-deep);transition:transform .18s}
.bcs2[data-open="1"] .bcs2__chev{transform:rotate(90deg)}
.bcs2__sizes{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;padding:12px 12px 14px;border-top:1px solid rgba(11,42,82,.08)}
.bcs2__sz{display:flex;flex-direction:column;align-items:stretch;gap:6px;border-radius:14px;padding:9px 8px 8px;background:rgba(255,255,255,.66);border:1px solid #fff;color:var(--sky-ink)}
.bcs2__szb{display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:0;padding:0;cursor:pointer;color:inherit;font:inherit}
.bcs2__szv{font-size:18px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
.bcs2__oh{font-size:11px;font-weight:700;color:var(--sky-ink-2)}
.bcs2__oh b{font-weight:900}
.bcs2__sz[data-picked="1"]{background:var(--sky-navy);border-color:var(--sky-navy);color:#fff;box-shadow:0 10px 22px -10px rgba(0,40,170,.9)}
.bcs2__sz[data-picked="1"] .bcs2__oh,.bcs2__sz[data-picked="1"] .bcs2__oh b{color:rgba(255,255,255,.92)}
.bcs2__stp{display:flex;align-items:center;height:30px;border-radius:999px;background:#fff;overflow:hidden}
.bcs2__stp button{flex:0 0 28px;height:30px;border:0;background:none;color:var(--sky-navy);font:800 16px/1 var(--sky-font);cursor:pointer}
.bcs2__stp input{flex:1;min-width:0;width:100%;height:30px;border:0;background:none;text-align:center;color:var(--sky-ink);font:800 13px/1 var(--sky-font);outline:none;-moz-appearance:textfield}
.bcs2__stp input::-webkit-outer-spin-button,.bcs2__stp input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.bcs2 :focus-visible{outline:2px solid var(--sky-navy);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.bcs2,.bcs2__chev{transition:none}}
`;

// ─── THE DESKTOP PAGE (Junid 5 Nov: "this is exactly what I want" — his
// Blue Sky Barcode Studio mock-up) ────────────────────────────────────────────
// Three columns on the bare room: a glass sidebar (wordmark, Home, Location,
// Category, Printer), the white "Barcode Studio" heading + search + count +
// a two-up grid of compact cards, and two glass cards on the right (Print
// tray, Label preview). White text sits on the sky / thin glass with the sky
// text shadow, as in the mock-up.
export const BCS_PAGE_CSS = `
/* FIXED FRAME (Junid 5 Nov): only the product list scrolls. While this page
   is mounted the document never scrolls; the frame fills the viewport under
   the header (its top is measured: --bcsp-top), three columns, one row.
   Not position:fixed — WebKit will not wheel-scroll a list inside one. */
html,body{overflow:hidden!important;overscroll-behavior:none}
.bcsp{position:relative;height:calc(100vh - var(--bcsp-top,140px));height:calc(100dvh - var(--bcsp-top,140px));display:grid;grid-template-columns:212px minmax(0,1fr) 296px;grid-template-rows:minmax(0,1fr);gap:0 26px;padding:8px 30px 0;color:#fff;font-family:var(--sky-font);box-sizing:border-box;overflow:hidden}
.bcsp *{box-sizing:border-box}
.bcsp__glass{border-radius:26px;background:rgba(255,255,255,.22);border:1px solid rgba(255,255,255,.7);box-shadow:inset 0 1px 0 rgba(255,255,255,.8),0 14px 34px rgba(10,60,140,.18);
  -webkit-backdrop-filter:blur(28px) saturate(1.6) brightness(1.05);backdrop-filter:blur(28px) saturate(1.6) brightness(1.05)}
.bcsp__w{text-shadow:var(--sky-text-shadow)}
.bcsp__side{align-self:stretch;margin-bottom:24px;overflow-y:auto;scrollbar-width:none;padding:24px 16px 18px;display:flex;flex-direction:column}
.bcsp__side::-webkit-scrollbar{display:none}
.bcsp__mark{display:flex;align-items:baseline;gap:9px;padding:0 8px 22px;color:#fff;text-shadow:var(--sky-text-shadow)}
.bcsp__mark b{font-size:25px;font-weight:900;font-style:italic;letter-spacing:-.04em}
.bcsp__mark span{font-size:11px;font-weight:800;font-style:italic;letter-spacing:.5em}
html[data-sky="on"] #root .bcsp .bcsp__home{display:flex;align-items:center;gap:8px;width:100%;height:46px;padding:0 16px;border-radius:15px;background:rgba(255,255,255,.72)!important;border:1px solid #fff!important;color:var(--sky-ink-deep)!important;font:700 16px/1 var(--sky-font);cursor:pointer;box-shadow:0 6px 16px rgba(10,60,140,.12)}
.bcsp__lab{font-size:12px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#fff;text-shadow:var(--sky-text-shadow);padding:26px 8px 10px}
.bcsp__selw{position:relative}
.bcsp__selw svg{position:absolute;right:15px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--sky-ink-deep)}
html[data-sky="on"] #root .bcsp select.bcsp__sel{-webkit-appearance:none;appearance:none;width:100%;height:48px;padding:0 40px 0 16px;border-radius:15px;background:rgba(255,255,255,.62)!important;border:1px solid #fff!important;color:var(--sky-ink-deep)!important;font:600 16px/1 var(--sky-font);cursor:pointer}
html[data-sky="on"] #root .bcsp .bcsp__pr{display:flex;align-items:center;gap:9px;width:100%;margin-bottom:6px;height:42px;padding:0 14px;border-radius:13px;text-align:left;font:600 14px/1 var(--sky-font);cursor:pointer;background:rgba(255,255,255,.4)!important;border:1px solid rgba(255,255,255,.75)!important;color:var(--sky-ink)!important}
html[data-sky="on"] #root .bcsp .bcsp__pr[data-on="1"]{background:rgba(255,255,255,.86)!important;border-color:#fff!important;color:var(--sky-ink-deep)!important;font-weight:800}
html[data-sky="on"] #root .bcsp .bcsp__pr:disabled{cursor:not-allowed;opacity:.55}
.bcsp__dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#0a6a35;box-shadow:0 0 0 3px rgba(10,106,53,.18)}
.bcsp__diag{margin-top:8px;padding:10px 11px;border-radius:12px;background:rgba(255,255,255,.8);border:1px solid #fff;color:var(--sky-ink-deep);font:600 11px/1.4 ui-monospace,monospace;word-break:break-word;display:flex;gap:6px}
html[data-sky="on"] #root .bcsp .bcsp__x{background:none!important;border:0!important;padding:0;color:var(--sky-ink)!important;cursor:pointer;font-size:13px}
.bcsp__queued{margin-top:16px;padding:14px;border-radius:16px;background:rgba(255,255,255,.72);border:1px solid #fff;color:var(--sky-ink-deep)}
.bcsp__queued b{display:block;font-size:26px;font-weight:900;line-height:1;color:var(--sky-navy);font-variant-numeric:tabular-nums}
.bcsp__queued span{display:block;margin-top:4px;font-size:12px;font-weight:600}
.bcsp__main{min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;padding-top:8px}
.bcsp__head{flex:0 0 auto}
.bcsp__h1{margin:0;font-size:34px;font-weight:800;letter-spacing:-.025em;line-height:1.1;color:#fff;text-shadow:var(--sky-text-shadow)}
.bcsp__sub{margin-top:8px;font-size:18px;font-weight:500;color:#fff;text-shadow:var(--sky-text-shadow)}
.bcsp__srch{position:relative;margin:14px 0 18px}
.bcsp__srch svg{position:absolute;z-index:1;left:18px;top:50%;transform:translateY(-50%);color:#fff;pointer-events:none}
html[data-sky="on"] #root .bcsp input.bcsp__in:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]){width:100%;height:42px;padding:0 18px 0 50px;border-radius:999px;background:rgba(255,255,255,.26)!important;border:1px solid rgba(255,255,255,.75)!important;color:#fff!important;caret-color:#fff;font:500 17px/1 var(--sky-font);outline:none;text-shadow:0 1px 6px rgba(0,40,110,.35);
  -webkit-backdrop-filter:blur(20px) saturate(1.5);backdrop-filter:blur(20px) saturate(1.5)}
html[data-sky="on"] #root .bcsp input.bcsp__in:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])::placeholder{color:rgba(255,255,255,.92)!important}
.bcsp__n{margin:34px 4px 16px;font-size:17px;font-weight:800;color:#fff;text-shadow:var(--sky-text-shadow);font-variant-numeric:tabular-nums}
.bcsp__list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:6px 4px 48px;margin:0 -4px;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 12px);mask-image:linear-gradient(to bottom,transparent 0,#000 12px)}
.bcsp__list::-webkit-scrollbar{display:none}
.bcsp__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px 20px;align-items:start}
.bcsp__right{min-height:0;height:100%;overflow-y:auto;scrollbar-width:none;display:flex;flex-direction:column;gap:26px;padding-bottom:24px}
.bcsp__right::-webkit-scrollbar{display:none}
.bcsp__tray{display:flex;flex-direction:column;min-height:240px;max-height:62%;flex:0 1 auto}
.bcsp__lp{flex:0 0 auto}
.bcsp__th{display:flex;align-items:center;gap:12px;padding:18px 18px 16px;border-bottom:1px solid rgba(255,255,255,.6)}
.bcsp__th h2{margin:0;font-size:22px;font-weight:800;letter-spacing:-.015em;color:#fff;text-shadow:var(--sky-text-shadow)}
.bcsp__badge{min-width:44px;height:30px;padding:0 12px;border-radius:999px;display:grid;place-items:center;background:rgba(255,255,255,.85);border:1px solid #fff;color:var(--sky-ink-deep);font-size:16px;font-weight:900;font-variant-numeric:tabular-nums}
html[data-sky="on"] #root .bcsp .bcsp__clear{margin-left:auto;background:rgba(255,255,255,.72)!important;border:1px solid #fff!important;color:var(--sky-ink-deep)!important;border-radius:999px;padding:6px 12px;font:700 13px/1 var(--sky-font);cursor:pointer}
.bcsp__empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:34px 16px;font-size:16px;font-weight:600;color:#fff;text-shadow:var(--sky-text-shadow);text-align:center}
.bcsp__empty svg{color:#fff;filter:drop-shadow(0 2px 8px rgba(0,40,110,.4))}
.bcsp__items{padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-height:0;overflow-y:auto;scrollbar-width:none}
.bcsp__items::-webkit-scrollbar{display:none}
.bcsp__it{display:flex;align-items:center;gap:10px;padding:9px 10px 9px 12px;border-radius:14px;background:rgba(255,255,255,.72);border:1px solid #fff;color:var(--sky-ink-deep);cursor:pointer}
.bcsp__it[data-last="1"]{background:rgba(255,255,255,.92);box-shadow:inset 0 0 0 2px var(--sky-navy)}
.bcsp__itn{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bcsp__its{font-size:12px;font-weight:600;color:var(--sky-ink-2)}
.bcsp__foot{padding:4px 14px 16px}
html[data-sky="on"] #root .bcsp .bcsp__print{width:100%;height:50px;border-radius:999px;display:flex;align-items:center;justify-content:center;gap:9px;background:var(--sky-navy)!important;border:0!important;color:#fff!important;font:800 15px/1 var(--sky-font);cursor:pointer;box-shadow:0 12px 26px -10px rgba(0,38,194,.85)}
html[data-sky="on"] #root .bcsp .bcsp__print:disabled{cursor:not-allowed;opacity:.55;box-shadow:none}
.bcsp__lp{padding:18px 18px 20px}
.bcsp__lp h2{margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-.015em;color:#fff;text-shadow:var(--sky-text-shadow)}
.bcsp__lpe{display:flex;flex-direction:column;align-items:center;gap:16px;padding:22px 6px 6px;font-size:16px;font-weight:500;color:#fff;text-shadow:var(--sky-text-shadow);text-align:center}
.bcsp__lpi{width:62px;height:62px;border-radius:16px;display:grid;place-items:center;background:rgba(255,255,255,.6);border:1px solid #fff;color:var(--sky-ink-deep);box-shadow:0 8px 20px rgba(10,60,140,.16)}
.bcsp__label{margin-top:10px;background:#f7f7f2;color:#0a0a0a;border-radius:10px;padding:12px 14px 10px;box-shadow:0 12px 30px -12px rgba(0,30,90,.5);font-family:'SF Mono',ui-monospace,monospace}
@media (max-width:1279px){.bcsp{grid-template-columns:196px minmax(0,1fr) 264px;gap:0 18px;padding:8px 18px 0}.bcsp__grid{grid-template-columns:minmax(0,1fr)}.bcsp__h1{font-size:34px}}
@media (prefers-reduced-motion:reduce){.bcsp *{transition:none!important}}
`;

const IcoChevDown = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>;
const IcoPrinter = ({ s = 16 }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2.5" /><rect x="7" y="14" width="10" height="7" rx="1" /></svg>;

// Presentation of the desktop Barcode Studio. Every value and handler comes
// from BarcodeCatalog unchanged (the dev harness mounts it with fixtures).
export function BarcodeStudioDesktop(v) {
  const { onExit, loc, setLoc, locOptions, categories, cat, setCat, transport, setTransport, diagText, setDiagText,
          totalCopies, canMint, search, setSearch, filtered, openId, setOpenId, sel, onHand, toggle, setCount,
          lastKey, setLastKey, lastItem, lastP, previewCode, selList, clearSel, busy, doPrint, onPhoto } = v;
  // The frame starts where the header ends; measured, not guessed, and
  // re-measured on resize. Wheel over the title/search/count scrolls the list.
  const frameRef = useRef(null);
  const listRef = useRef(null);
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    // The page cannot scroll while this frame is up, so the frame's own top
    // is exactly the height of everything above it (the header).
    const measure = () => {
      const top = Math.round(el.getBoundingClientRect().top);
      el.style.setProperty("--bcsp-top", `${Math.max(0, top)}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const forwardWheel = (e) => {
    const list = listRef.current;
    if (list && !list.contains(e.target)) list.scrollTop += e.deltaY;
  };
  return (
    <div className="bcsp" data-testid="barcode-studio" ref={frameRef}>
      <style>{BCS_CSS}</style>
      <style>{BCS_PAGE_CSS}</style>

      <aside className="bcsp__side bcsp__glass">
        <div className="bcsp__mark" data-contrast-exempt=""><b>marathon</b><span>CLUB</span></div>
        <button type="button" className="bcsp__home" onClick={onExit}>← Home</button>

        <div className="bcsp__lab" data-contrast-exempt="">Location</div>
        <div className="bcsp__selw">
          <select className="bcsp__sel" value={loc} onChange={(e) => setLoc(e.target.value)} aria-label="Location">
            {locOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <IcoChevDown />
        </div>
        {categories.length > 1 && <>
          <div className="bcsp__lab" data-contrast-exempt="">Category</div>
          <div className="bcsp__selw">
            <select className="bcsp__sel" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="all">All</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <IcoChevDown />
          </div>
        </>}

        {/* No printer section (Junid 5 Nov: "make it clean, Xprinter is auto
            connected"): on a laptop the USB label printer is always used — it
            reconnects to the printer this computer already allowed, asks once
            at the first print otherwise, and falls back to the system printer
            by itself. Errors still show below. */}
        {diagText && (
          <div className="bcsp__diag">
            <span style={{ flex: 1 }}>{diagText}</span>
            <button type="button" className="bcsp__x" aria-label="Dismiss" onClick={() => setDiagText(null)}>✕</button>
          </div>
        )}
        <div style={{ flex: 1 }} />
        {totalCopies > 0 && (
          <div className="bcsp__queued">
            <b>{totalCopies}</b>
            <span>label{totalCopies !== 1 ? "s" : ""} queued · {selList.length} size{selList.length !== 1 ? "s" : ""}</span>
          </div>
        )}
      </aside>

      <main className="bcsp__main" onWheel={forwardWheel}>
        <div className="bcsp__head" data-testid="bcsp-head">
        <h1 className="bcsp__h1" data-contrast-exempt="">Barcode Studio</h1>
        {/* Junid 5 Nov: no subtitle, no product count — the list gets the room.
            The reprint-only note stays for accounts that cannot create codes. */}
        {!canMint && <div className="bcsp__sub" data-contrast-exempt="">Re-print existing labels — new codes are created by warehouse/admin.</div>}
        <div className="bcsp__srch">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7.5" /><path d="M20.5 20.5l-4.2-4.2" /></svg>
          <input className="bcsp__in" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products..." aria-label="Search products" />
        </div>
        </div>
        <div className="bcsp__list" ref={listRef} data-testid="bcsp-list">
        {filtered.length === 0 ? <Empty>No products match.</Empty> : (
          <div className="bcsp__grid">
            {filtered.map((p) => (
              <BcsCard key={p.id} p={p} expanded={openId === p.id} sel={sel} onHand={onHand}
                       onToggleOpen={() => setOpenId(openId === p.id ? null : p.id)}
                       onPick={(sz, k) => { toggle(p, sz); setLastKey(k); }}
                       onCount={(k, val) => { setCount(k, val); setLastKey(k); }}
                       onPhoto={p.photoUrl ? () => onPhoto(p.photoUrl) : undefined} />
            ))}
          </div>
        )}
        </div>
      </main>

      <aside className="bcsp__right">
        <section className="bcsp__tray bcsp__glass" aria-label="Print tray">
          <div className="bcsp__th">
            <h2 data-contrast-exempt="">Print tray</h2>
            <span className="bcsp__badge">{selList.length}</span>
            {selList.length > 0 && <button type="button" className="bcsp__clear" onClick={clearSel}>Clear</button>}
          </div>
          {selList.length === 0 ? (
            <div className="bcsp__empty" data-contrast-exempt=""><IcoPrinter s={44} />Tray is empty.</div>
          ) : <>
            <div className="bcsp__items">
              {selList.map(([k, it]) => (
                <div key={k} className="bcsp__it" data-last={lastKey === k ? "1" : undefined} onClick={() => setLastKey(k)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="bcsp__itn">{it.productName}</div>
                    <div className="bcsp__its">Size {formatSize(it.size)} · ×{it.count}</div>
                  </div>
                  <button type="button" className="bcsp__x" aria-label="Remove" onClick={(e) => { e.stopPropagation(); toggle({ id: it.productId }, it.size); if (lastKey === k) setLastKey(null); }}>✕</button>
                </div>
              ))}
            </div>
            <div className="bcsp__foot">
              <button type="button" className="bcsp__print" onClick={doPrint} disabled={busy || !totalCopies}>
                <IcoPrinter />
                {busy ? "Printing…" : `Print ${totalCopies} label${totalCopies !== 1 ? "s" : ""}`}
              </button>
            </div>
          </>}
        </section>

        <section className="bcsp__lp bcsp__glass" aria-label="Label preview">
          <h2 data-contrast-exempt="">Label preview</h2>
          {lastP && lastItem ? (
            <div className="bcsp__label">
              <div style={{ fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: -.2 }}>{lastP.name}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 2 }}>
                <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: -.5 }}>{formatSize(lastItem.size)}</span>
                {typeof lastP.retailPrice === "number" && lastP.retailPrice > 0 && <span style={{ fontSize: 14, fontWeight: 800 }}>R{lastP.retailPrice.toLocaleString("en-ZA")}</span>}
              </div>
              {previewCode ? <>
                <div style={{ display: "flex", alignItems: "stretch", height: 44, marginTop: 9 }}>
                  {code128Modules(previewCode).map((m, i) => <span key={i} style={{ width: m.width * 1.5, background: m.bar ? "#0a0a0a" : "transparent" }} />)}
                </div>
                <div style={{ textAlign: "center", fontSize: 10, letterSpacing: 3, marginTop: 3, fontWeight: 700 }}>{previewCode}</div>
              </> : (
                <div style={{ fontSize: 10.5, color: "#555", textAlign: "center", padding: "16px 0 8px" }}>{canMint ? "Barcode assigned when you print." : "No code yet — a warehouse/admin must create it."}</div>
              )}
            </div>
          ) : (
            <div className="bcsp__lpe" data-contrast-exempt="">
              <span className="bcsp__lpi"><svg width="30" height="26" viewBox="0 0 30 26" fill="currentColor"><rect x="2" y="2" width="3" height="22" rx="1.5" /><rect x="8" y="2" width="3" height="22" rx="1.5" /><rect x="14" y="2" width="3" height="22" rx="1.5" /><rect x="20" y="2" width="3" height="22" rx="1.5" /><rect x="26" y="2" width="3" height="22" rx="1.5" /></svg></span>
              Select a size to preview its label.
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

// On-hand ink that reads on glass (the old red/amber/green were for black).
const ohInk = (n) => (n === 0 ? "#a4161a" : n <= 2 ? "#7a4b00" : "#0a6a35");

export function BcsCard({ p, expanded, sel, onToggleOpen, onPick, onCount, onHand, onPhoto }) {
  const selCount = p.sizes.filter((s) => sel[keyOf(p.id, s)]).length;
  const url = primaryPhotoUrl(p);
  return (
    <div className="bcs2" data-open={expanded ? "1" : undefined} data-picked={selCount ? "1" : undefined} data-testid="bcs-card">
      <button type="button" className="bcs2__head" aria-expanded={expanded} onClick={onToggleOpen}>
        <span className="bcs2__ph">
          {url
            ? <PrimaryPhoto product={p} alt="" onClick={onPhoto ? (e) => { e.stopPropagation(); onPhoto(); } : undefined}
                            onError={(e) => { e.currentTarget.style.display = "none"; }} />
            : "👟"}
        </span>
        <span className="bcs2__tx">
          <span className="bcs2__nm" title={p.name}>{p.name}</span>
          <span className="bcs2__meta">{p.sizes.length} size{p.sizes.length === 1 ? "" : "s"}</span>
        </span>
        {selCount > 0 && <span className="bcs2__sel">{selCount} picked</span>}
        <span className="bcs2__chev" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </span>
      </button>
      {expanded && (
        <div className="bcs2__sizes">
          {p.sizes.map((s) => {
            const k = keyOf(p.id, s); const picked = !!sel[k]; const oh = onHand(p.id, s);
            const cur = picked ? (parseInt(sel[k].count, 10) || 0) : 0;
            return (
              <div key={s} className="bcs2__sz" data-picked={picked ? "1" : undefined}>
                <button type="button" className="bcs2__szb" role="checkbox" aria-checked={picked}
                        aria-label={`Size ${formatSize(s)}, ${oh} on hand`} onClick={() => onPick(s, k)}>
                  <span className="bcs2__szv"><SizeTag size={s} /></span>
                  <span className="bcs2__oh">on hand <b style={picked ? undefined : { color: ohInk(oh) }}>{oh}</b></span>
                </button>
                {picked && (
                  <div className="bcs2__stp">
                    <button type="button" aria-label="One fewer copy" onClick={() => onCount(k, String(Math.max(0, cur - 1)))}>−</button>
                    <input type="number" inputMode="numeric" min="0" aria-label="Copies" value={sel[k].count} onChange={(e) => onCount(k, e.target.value)} />
                    <button type="button" aria-label="One more copy" onClick={() => onCount(k, String(cur + 1))}>+</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// myShop: the viewer's destShop. A one-shop account sees its own shop and its
// back-stock hubs only — in the location chips and in every on-hand figure.
export default function BarcodeCatalog({ products, canMint, onExit, myShop = null }) {
  const wide = useWide();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState(null);
  const [sel, setSel] = useState({});   // { "pid|size": { productId, productName, size, count } }
  const [transport, setTransportState] = useState(defaultTransportId);
  const setTransport = (id) => { rememberTransport(id); setTransportState(id); };
  // Laptop Barcode Studio: always the USB label printer (Junid 5 Nov), when
  // this browser can drive it; the phone keeps its picker (Phomemo there).
  const xprinterOk = TRANSPORTS.some((t) => t.id === "xprinter" && t.supported());
  useEffect(() => { if (wide && xprinterOk && transport !== "xprinter") setTransportState("xprinter"); }, [wide, xprinterOk, transport]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [diagText, setDiagText] = useState(null);   // persistent printer diagnostic (manual dismiss)
  const [lightbox, setLightbox] = useState(null);   // full-screen product photo url
  const [loc, setLoc] = useState("all");            // location filter — "see what's here"
  const [cat, setCat] = useState("all");            // category filter
  const [lastKey, setLastKey] = useState(null);     // last-touched size → live label preview
  const [previewCode, setPreviewCode] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!lastKey) { setPreviewCode(null); return; }
    const i = lastKey.indexOf("|");
    const pid = lastKey.slice(0, i), size = lastKey.slice(i + 1);
    getBarcode(pid, size).then(c => alive && setPreviewCode(c || null)).catch(() => alive && setPreviewCode(null));
    return () => { alive = false; };
  }, [lastKey]);
  const allCells = useStockCells();     // { loc: { pid: { size: cell } } } — all locations
  const registry = useLocations();
  const scope = useMemo(() => scopedLocationIds(myShop), [myShop]);
  const cells = useMemo(() => (scope ? Object.fromEntries(Object.entries(allCells || {}).filter(([l]) => scope.includes(l))) : allCells), [allCells, scope]);
  const locations = useMemo(() => withinScope(transferTargets(registry), myShop), [registry, myShop]);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3400); };

  // Diagnostic test print: connect (inside this tap's gesture) and send a canvas-free
  // pattern (solid + stripes). If THIS prints but real labels don't, the issue is the
  // label content; if it also fails, it's protocol/BLE delivery. The result line is
  // shown in a PERSISTENT box so it can be read/screenshotted (service/char/props/bytes).
  const doTest = async () => {
    setBusy(true); setDiagText("Connecting…");
    let conn;
    try { conn = await connectTransport(transport); }
    catch (e) { setBusy(false); return setDiagText(`Connect failed: ${String(e?.message || e)}`); }
    const res = await printTest({ transport, conn });
    setBusy(false);
    setDiagText(`${res.ok ? "Test sent ✓" : "Test FAILED ✗"} — ${res.diag || res.error || "no info"}`);
    // Write the full GATT dump to RTDB so it can be read server-side (the operator
    // doesn't have to transcribe anything). Best-effort — never blocks the UI.
    try {
      await set(ref(database, "printer_diag/latest"), {
        at: serverNowIso(),
        ok: !!res.ok,
        diag: res.diag || null,
        error: res.error || null,
        dump: res.dump || null,
      });
    } catch (e) { /* diagnostic only */ }
  };

  // On-hand for a product+size. When a location is picked, show THAT location's qty
  // ("see what's there"); otherwise the total summed across every location.
  const onHand = (pid, size) => {
    if (loc !== "all") { const c = cells?.[loc]?.[pid]?.[size]; return c && typeof c.qty === "number" ? c.qty : 0; }
    let n = 0;
    for (const l of Object.keys(cells || {})) { const c = cells[l]?.[pid]?.[size]; if (c && typeof c.qty === "number") n += c.qty; }
    return n;
  };
  // Total at the picked location (for the "only what's here" filter).
  const locTotal = (pid) => Object.values(cells?.[loc]?.[pid] || {}).reduce((s, c) => s + (typeof c?.qty === "number" ? c.qty : 0), 0);

  // Category chips — data-driven from the sized catalogue.
  const categories = useMemo(() => {
    const set = new Set();
    for (const p of products || []) if (p?.category && Array.isArray(p.sizes) && p.sizes.length) set.add(String(p.category));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [products]);

  // Forgiving search (fuzzy name + barcode/sku/per-size codes; code hits first).
  // Empty query lists products NEWEST-FIRST — a product id is "p" + serverNowMs()
  // at creation (App.jsx), so the id encodes the upload time; just-added
  // products sit at the top ready to select and print, instead of being buried
  // alphabetically. Ties/legacy ids fall back to name order. Location +
  // category pre-filter both; a typed search keeps its relevance ranking.
  const createdMs = (p) => { const m = /^p(\d{13})$/.exec(p?.id || ""); return m ? Number(m[1]) : 0; };
  const filtered = useMemo(() => {
    // A DEACTIVATED product is off every staff list (owner spec 2026-09-05,
    // BUG 1). Barcodes is open to EVERY signed-in staff member — not the
    // stockRole-gated admin section — so a retired line must not be printable
    // or findable here. It stays in full in the Stock section, where its cells
    // are adjusted and its history read, and one tap in Leftovers puts it back.
    const predicate = (p) =>
      !isDeactivated(p) &&
      Array.isArray(p.sizes) && p.sizes.length &&
      (cat === "all" || p.category === cat) &&
      (loc === "all" || (cells?.[loc]?.[p.id] && locTotal(p.id) > 0));
    if (!search.trim()) {
      return [...(products || [])]
        .filter(p => p && p.id && p.name && predicate(p))
        .sort((a, b) => (createdMs(b) - createdMs(a)) || a.name.localeCompare(b.name));
    }
    return searchProducts(products, search, { limit: 500, predicate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, search, cat, loc, cells]);

  const toggle = (p, size) => setSel(s => {
    const k = keyOf(p.id, size); const next = { ...s };
    if (next[k]) delete next[k];
    else next[k] = { productId: p.id, productName: p.name, size, count: String(Math.max(1, onHand(p.id, size))) };
    return next;
  });
  const setCount = (k, v) => setSel(s => (s[k] ? { ...s, [k]: { ...s[k], count: v } } : s));
  const selList = Object.entries(sel);

  const doPrint = async () => {
    if (!selList.length) return flash("err", "Select at least one size to print.");
    setBusy(true);
    // Connect FIRST — the printer picker needs the user-tap activation, which the
    // async barcode reservations below would otherwise consume (Android Chrome).
    // Best-effort: persist the USB printer's identity (VID/PID + iface/endpoints, or
    // every failed attempt) to RTDB so it can be read server-side. The on-screen
    // status line under the printer buttons carries the same detail.
    const recordXprinterDiag = async (error) => {
      if (transport !== "xprinter") return;
      const d = getXprinterDiag();
      if (error) setDiagText(error);
      try { await set(ref(database, "printer_diag/xprinter"), { ...(d || {}), error: error || null }); }
      catch { /* diagnostic only */ }
    };
    let conn;
    try { conn = await connectTransport(transport); }
    catch (e) {
      setBusy(false);
      await recordXprinterDiag(String(e?.message || e));
      return flash("err", `Couldn't connect to the printer: ${String(e?.message || e)}`);
    }
    await recordXprinterDiag(null);
    const items = []; let failReserve = 0, noCode = 0;
    for (const [, it] of selList) {
      try {
        // canMint (stockRole): reserve-if-missing / reuse. Otherwise reprint-only:
        // read the existing code, never mint (which would hit the stockRole-gated
        // /barcodes write). Sizes with no code yet are skipped with a message.
        const code = canMint ? (await ensureBarcode(it.productId, it.size)).code : await getBarcode(it.productId, it.size);
        const c = parseInt(it.count, 10) || 0;
        if (!code) { noCode++; continue; }
        if (c > 0) items.push({ code, productName: it.productName, size: it.size, count: c });
      } catch { failReserve++; }
    }
    if (!items.length) {
      setBusy(false);
      return flash("err", noCode ? `No printable labels — ${noCode} size(s) have no barcode yet (a warehouse/admin user must create them first).`
                                 : `Nothing to print${failReserve ? ` (${failReserve} failed)` : " (all counts 0)"}.`);
    }
    const res = await printLabels({ items, transport, conn });
    setBusy(false);
    const skipped = [];
    if (noCode) skipped.push(`${noCode} had no code`);
    if (failReserve) skipped.push(`${failReserve} failed`);
    const extra = skipped.length ? ` · ${skipped.join(", ")}` : "";
    const diag = res.diag ? ` [${res.diag}]` : "";
    if (res.ok) flash("ok", `Sent ${res.printed} label(s) to ${res.routeLabel || TRANSPORTS.find(t => t.id === transport)?.label}${extra}.${diag}`);
    else flash("err", `Print failed: ${res.error} — codes are saved; retry.${diag}`);
  };

  // ── DESKTOP BARCODE STUDIO (≥1024px) — sidebar (filters + printer) · product
  //    grid · live print tray with a real Code128 label preview. Mobile below. ──
  if (wide) {
    const totalCopies = selList.reduce((s, [, it]) => s + (parseInt(it.count, 10) || 0), 0);
    const lastItem = lastKey ? sel[lastKey] : null;
    const lastP = lastItem ? products.find(p => p.id === lastItem.productId) : null;
    const locOptions = [{ id: "all", label: "All locations" }, ...locations.map(l => ({ id: l.id, label: labelFor(l.id, registry) }))];
    return (
      <>
        <BarcodeStudioDesktop onExit={onExit} loc={loc} setLoc={setLoc} locOptions={locOptions} categories={categories} cat={cat} setCat={setCat}
          transport={transport} setTransport={setTransport} diagText={diagText} setDiagText={setDiagText} totalCopies={totalCopies} canMint={canMint}
          search={search} setSearch={setSearch} filtered={filtered} openId={openId} setOpenId={setOpenId} sel={sel} onHand={onHand}
          toggle={toggle} setCount={setCount} lastKey={lastKey} setLastKey={setLastKey} lastItem={lastItem} lastP={lastP} previewCode={previewCode}
          selList={selList} clearSel={() => { setSel({}); setLastKey(null); }} busy={busy} doPrint={doPrint} onPhoto={setLightbox} />
        {lightbox && (
          <div onClick={() => setLightbox(null)} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out" }}>
            <img src={lightbox} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 10 }} />
          </div>
        )}
        <Toast msg={toast} />
      </>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <style>{BCS_CSS}</style>
      {/* Below 1024px the stacked layout stays; only the header holds still
          (Junid 5 Nov), on a soft blur strip so cards pass under it cleanly. */}
      <style>{`html[data-sky="on"] #root .sky-header{position:sticky;top:0;z-index:30;padding-bottom:8px;-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);background:rgba(255,255,255,.1)}`}</style>
      <div style={{ padding: "14px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onExit} style={{ background: "none", border: "none", padding: 0, color: BLUE_L, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FONT }}>← Home</button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Barcodes</div>
        <div style={{ minWidth: 48 }} />
      </div>
      <div style={{ padding: "4px 14px 40px" }}>
      {!canMint && <div style={{ fontSize: 11, color: GRAY, marginBottom: 8 }}>Re-print existing labels — new barcodes are created by warehouse/admin.</div>}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…"
        style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />

      <FilterPicker label="Location" value={loc} onChange={setLoc}
        options={[{ id: "all", label: "All locations" }, ...locations.map(l => ({ id: l.id, label: labelFor(l.id, registry) }))]} />
      {categories.length > 1 && (
        <FilterPicker label="Category" value={cat} onChange={setCat}
          options={[{ id: "all", label: "All" }, ...categories.map(c => ({ id: c, label: c }))]} />
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {TRANSPORTS.map(t => {
          const supported = t.supported(); const on = transport === t.id;
          return (
            <button key={t.id} onClick={() => supported && setTransport(t.id)} disabled={!supported}
              style={{ padding: "7px 11px", borderRadius: 9, cursor: supported ? "pointer" : "not-allowed", fontSize: 11.5, fontWeight: 600,
                       background: on ? "rgba(60,110,255,.2)" : "rgba(255,255,255,.04)", border: on ? "1px solid rgba(60,110,255,.6)" : BORDER,
                       color: supported ? (on ? "#fff" : GRAY) : "rgba(255,255,255,.25)" }}>
              {t.label}{!supported && <span style={{ color: GRAY, marginLeft: 5 }}>· n/a</span>}
            </button>
          );
        })}
        {transport === "phomemo" && (
          <button onClick={doTest} disabled={busy}
            style={{ padding: "7px 11px", borderRadius: 9, cursor: busy ? "default" : "pointer", fontSize: 11.5, fontWeight: 600,
                     background: "rgba(245,158,11,.14)", border: "1px solid rgba(245,158,11,.4)", color: AMBER }}>
            🔧 Test print
          </button>
        )}
      </div>
      {transport === "xprinter" && <PrinterStatus style={{ marginBottom: 12 }} />}

      {diagText && (
        <div style={{ marginBottom: 12, padding: "9px 11px", borderRadius: 9, background: "rgba(255,255,255,.06)", border: BORDER,
                      fontSize: 11, color: "#fff", wordBreak: "break-word", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ flex: 1, fontFamily: "monospace" }}>{diagText}</span>
          <button onClick={() => setDiagText(null)} style={{ background: "none", border: "none", color: GRAY, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>✕</button>
        </div>
      )}

      {filtered.length === 0 ? <Empty>No products match.</Empty> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: selList.length ? 84 : 8 }}>
          {filtered.map(p => (
            <BcsCard key={p.id} p={p} expanded={openId === p.id} sel={sel} onHand={onHand}
                     onToggleOpen={() => setOpenId(openId === p.id ? null : p.id)}
                     onPick={(sz) => toggle(p, sz)}
                     onCount={(k, v) => setCount(k, v)}
                     onPhoto={p.photoUrl ? () => setLightbox(p.photoUrl) : undefined} />
          ))}
        </div>
      )}

      {selList.length > 0 && (
        <div style={{ position: "fixed", left: 12, right: 12, bottom: 14, zIndex: 40, ...GLASS, padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{selList.length} size{selList.length > 1 ? "s" : ""} selected</div>
            <div style={{ fontSize: 11, color: GRAY }}>copies default to on-hand</div>
          </div>
          <button onClick={() => setSel({})} style={{ ...bGhost, padding: "8px 12px", fontSize: 12 }}>Clear</button>
          <button onClick={doPrint} disabled={busy} style={{ ...bGreen, padding: "10px 18px", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Printing…" : "Print barcodes"}
          </button>
        </div>
      )}
      </div>
      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out" }}>
          <img src={lightbox} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 10 }} />
        </div>
      )}
      <Toast msg={toast} />
    </div>
  );
}
