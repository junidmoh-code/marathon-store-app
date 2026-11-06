// ─── SKY — shared glass components ───────────────────────────────────────────
//
// The pieces every screen is built from (see design/DNA.md): the room, the
// header, pills, segmented toggles, chip rows, the search pill, the product
// stage (cut-out on a podium, or the full photo in a white frame) and the
// glass bottom bar. Presentation only — every handler is the caller's.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HiResPhoto } from "../assistant/HiResPhoto.jsx";
import { IconGrid, IconUser, IconSearch, IconCamera, IconFilter, IconPlus, IconCart } from "./SkyIcons.jsx";
import { brandIcon, brandTextLabel, noteUnmappedBrand } from "./brandLogos.js";

const cx = (...c) => c.filter(Boolean).join(" ");

// The room itself is a div in index.html (fixed, z-index 0, before #root).
// A screen with its own world — the customer-facing TV board, which has its
// own background manager (#724) — turns the room and the global glass layer
// off while it is mounted.
export function useSkyOff() {
  useEffect(() => {
    const el = typeof document !== "undefined" ? document.documentElement : null;
    if (!el) return undefined;
    const prev = el.dataset.sky;
    el.dataset.sky = "off";
    return () => { el.dataset.sky = prev || "on"; };
  }, []);
}

export function SkyLogo({ large = false }) {
  return (
    <div className={cx("sky-logo", large && "sky-logo--lg")} aria-label="Marathon Club" role="img">
      <span className="sky-logo__m">marathon</span>
      <span className="sky-logo__c">CLUB</span>
    </div>
  );
}

/** A round glass button (grid, user, search). */
export function SkyRound({ label, onClick, children, className = "", buttonRef, ...rest }) {
  return (
    <button type="button" ref={buttonRef} className={cx("sky-round sky-glass", className)} aria-label={label} title={label} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/**
 * Header on every screen: round glass grid button left, the wordmark centred,
 * round glass user button right, and a small glass pill under the logo naming
 * the screen (ASSISTANT) or the device/store (2POS).
 */
export function SkyHeader({ tag, tagNode = null, onGrid, onUser, userInitial = null, large = false, gridLabel = "Home", userLabel = "Account", left = null, right = null, className = "" }) {
  return (
    <header className={cx("sky-header", className)}>
      <div className="sky-header__l">
        {left ?? (onGrid ? <SkyRound label={gridLabel} onClick={onGrid}><IconGrid /></SkyRound> : null)}
      </div>
      <div className="sky-header__c">
        <SkyLogo large={large} />
        {tagNode ?? (tag ? <span className={cx("sky-tag sky-glass", large && "sky-tag--lg")}>{tag}</span> : null)}
      </div>
      <div className="sky-header__r">
        {right}
        {onUser ? (
          <SkyRound label={userLabel} onClick={onUser} className={userInitial ? "sky-round--user" : ""}>
            {userInitial || <IconUser />}
          </SkyRound>
        ) : null}
      </div>
    </header>
  );
}

// ── THE SHELL HEADER (Junid, 6 Nov — one header per screen) ─────────────────
// The ONE header every screen wears (App.jsx draws it above the view): grid =
// home, the wordmark, the screen pill with a chevron (opens the view switcher —
// the role picker on the home page, as the old per-screen "Switch View" did)
// and the account button (the account and its one sign-out live on the home
// page). PINNED: sticky at the top, everything under it scrolls; its glass
// fades in once the page has moved, so content passing under is softened.
// Barcode Studio opts out (sticky={false}): it keeps its own fixed frame.
export function SkyShellHeader({ tag, onHome, onSwitch, onUser, sticky = true }) {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!sticky || typeof window === "undefined" || !window.addEventListener) return undefined;
    const on = () => setStuck(window.scrollY > 2);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [sticky]);
  // Publish the pinned header's height (--sky-shell-h) so full-height screens
  // (the desktop workspaces, 100vh) fit UNDER it instead of behind it.
  const barRef = useRef(null);
  useEffect(() => {
    const el = barRef.current, root = typeof document !== "undefined" ? document.documentElement : null;
    if (!sticky || !el || !root || typeof ResizeObserver === "undefined") return undefined;
    const set = () => root.style.setProperty("--sky-shell-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty("--sky-shell-h"); };
  }, [sticky]);
  return (
    <div ref={barRef} className="sky-shellbar" data-testid="sky-shellbar" data-sticky={sticky ? "true" : undefined} data-stuck={stuck ? "true" : undefined}>
      <div className="sky-shellbar__glass" aria-hidden="true" />
      <SkyHeader gridLabel="Home" onGrid={onHome} onUser={onUser || onHome} userLabel="Account"
                 tagNode={
                   <button type="button" className="sky-tag sky-glass sky-shellpill" onClick={onSwitch || onHome}
                           aria-label={`${tag} — switch view`} data-testid="screen-pill">
                     <span>{tag}</span>
                     <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                   </button>
                 } />
    </div>
  );
}

// ── THE STORE PILL (Junid, 5 Nov: compact top band) ──────────────────────────
// The pill under the wordmark names the store every order goes to, in bold
// caps with a chevron. Tapping it opens a body-level glass popover listing the
// stores (current one brighter); a pick closes it and hands the id to onPick —
// the SAME switch handler as the old store row (the red confirm), so the store
// state is untouched here. One store only: a plain pill, nothing to pick.
//
// It pulses once (600ms) on load when the store differs from the one this
// device last used (localStorage "storeAssistantShop", READ only), e.g. an
// account pinned to a different shop. Reduced motion: no pulse (CSS).
export function lastUsedStoreDiffers(current) {
  try {
    const last = typeof localStorage !== "undefined" ? localStorage.getItem("storeAssistantShop") : null;
    return !!(last && current && last !== current);
  } catch { return false; }
}

export function SkyStorePill({ value, stores, labelOf, onPick, mode = null, modes = null, onMode = null, open: openProp, onOpenChange, buttonRef: refProp, className = "", testId = "store-pill" }) {
  const own = useRef(null);
  const ref = refProp || own;
  const [openOwn, setOpenOwn] = useState(false);
  const open = openProp ?? openOwn;
  const setOpen = onOpenChange || setOpenOwn;
  const [pulse] = useState(() => lastUsedStoreDiffers(value));
  const name = value ? labelOf(value) : "Store";
  const many = Array.isArray(stores) && stores.length > 1;
  // PRODUCT TYPE lives in the pill too (Junid 5 Nov: no Sneakers/Clothing
  // toggle on the page). The pill reads "STORE · SNEAKERS"; the popover holds
  // the stores (if more than one) and the product types.
  const hasModes = Array.isArray(modes) && modes.length > 1 && typeof onMode === "function";
  const modeLabel = hasModes ? (modes.find(([v]) => v === mode) || [])[1] : null;
  const cls = cx("sky-tag sky-glass sky-storepill", pulse && "sky-storepill--pulse", className);
  if (!many && !hasModes) {
    return <span className={cls} data-testid={testId}>{name}</span>;
  }
  const label = modeLabel ? `${name} · ${modeLabel}` : name;
  return (
    <>
      <button type="button" ref={ref} className={cls}
              aria-haspopup="menu" aria-expanded={open}
              aria-label={`Ordering ${modeLabel ? modeLabel.toLowerCase() + " " : ""}for ${name}. Change${many ? " store or" : ""} products`}
              data-testid={testId} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <svg className="sky-storepill__chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <SkyPopover anchorRef={ref} open={open} onClose={() => setOpen(false)} align="center" width={240} label={many ? "Order for" : "Products"} testId="store-popover">
        {many && <div className="sky-pop__lab">Order for</div>}
        {many && stores.map((s) => (
          <button key={s.id} type="button" role="menuitemradio" className="sky-pop__i" aria-checked={value === s.id} data-group="store"
                  onClick={() => { setOpen(false); if (s.id !== value) onPick(s.id); }}>
            {labelOf(s.id)}
          </button>
        ))}
        {hasModes && <div className={cx("sky-pop__lab", many && "sky-pop__lab--gap")}>Products</div>}
        {hasModes && modes.map(([v, l]) => (
          <button key={v} type="button" role="menuitemradio" className="sky-pop__i" aria-checked={mode === v} data-group="mode"
                  onClick={() => { setOpen(false); if (v !== mode) onMode(v); }}>
            {l}
          </button>
        ))}
      </SkyPopover>
    </>
  );
}

/** Glass pill segmented toggle (Sneakers / Clothing, the store chips). */
export function SkySegmented({ options, value, onChange, className = "", size = "md", ariaLabel }) {
  return (
    <div className={cx("sky-seg sky-glass", size === "lg" && "sky-seg--lg", className)} role="group" aria-label={ariaLabel}>
      {options.map(([val, label]) => (
        <button key={val} type="button" aria-pressed={value === val} onClick={() => onChange(val)}>{label}</button>
      ))}
    </div>
  );
}

/** One brand chip: the simple-icons mark in navy, or the name in bold caps. */
export function BrandMark({ brand, title }) {
  const icon = brandIcon(brand);
  if (!icon) {
    noteUnmappedBrand(brand);
    return <span className="sky-chip__txt">{brandTextLabel(brand)}</span>;
  }
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label={title || brand} fill="currentColor"><path d={icon.path} /></svg>
  );
}

/**
 * The phone's brand strip: one horizontally scrolling row of round glass
 * logo pills under the search, "All" first, then every brand in `brands`
 * (brandOptions order: most products first). Same filter value as the
 * desktop chip row. Tapping the active chip again goes back to All. The
 * active chip is scrolled into view on load and whenever it changes.
 * `brands`: [[name, count], ...] with ["All", total] first.
 */
export function SkyBrandStrip({ brands, value, onChange, className = "" }) {
  const rowRef = useRef(null);
  const first = useRef(true);
  const list = (brands || []).filter(([b]) => b !== "All");
  const sig = list.map(([b]) => b).join("|");
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const chip = row.querySelector('[aria-pressed="true"]');
    if (!chip) return;
    // Scroll the ROW only (never the page): bring the chip in from whichever
    // side it is hidden on, landing on the 16px gutter like a snap stop.
    const pad = 16, l = chip.offsetLeft, r = l + chip.offsetWidth;
    let to = null;
    if (l - pad < row.scrollLeft) to = l - pad;
    else if (r + pad > row.scrollLeft + row.clientWidth) to = l - pad;
    if (to != null) {
      const reduce = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const behavior = first.current || reduce ? "auto" : "smooth";
      if (row.scrollTo) row.scrollTo({ left: Math.max(0, to), behavior }); else row.scrollLeft = Math.max(0, to);
    }
    first.current = false;
  }, [value, sig]);
  return (
    <div ref={rowRef} className={cx("sky-brandstrip", className)} role="group" aria-label="Brand" data-testid="brand-strip">
      <button type="button" className="sky-chip sky-glass sky-brandchip sky-brandchip--all" aria-pressed={value === "All"}
              onClick={() => onChange("All")}>All</button>
      {list.map(([b, n]) => (
        <button key={b} type="button" className="sky-chip sky-glass sky-brandchip" aria-pressed={value === b}
                title={`${b} (${n})`} aria-label={`${b} (${n})`} onClick={() => onChange(value === b ? "All" : b)}>
          <BrandMark brand={b} title={b} />
        </button>
      ))}
    </div>
  );
}

/**
 * The big glass search pill — icon left, then one subtle divider and the
 * pill's own buttons on the right (camera/scan, and on desktop the filter
 * beside it, inside the pill as assistant-desktop.png draws it).
 * `actions`: [{ icon: "camera"|"filter", label, onClick, ref }]
 */
export function SkySearch({ value, onChange, placeholder = "Search products...", inputRef, onAction, action = "camera", actionLabel, actions = null, large = false, className = "", inputProps = {} }) {
  const list = actions || (onAction ? [{ icon: action, label: actionLabel, onClick: onAction }] : []);
  return (
    <div className={cx("sky-search sky-glass", large && "sky-search--lg", className)}>
      <IconSearch />
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
             autoComplete="off" aria-label="Search products" {...inputProps} />
      {list.length ? <span className="sky-search__div" aria-hidden="true" /> : null}
      {list.map((a, i) => {
        const Icon = a.icon === "filter" ? IconFilter : IconCamera;
        return (
          <button key={i} type="button" ref={a.ref} className="sky-search__btn" onClick={a.onClick}
                  aria-label={a.label} title={a.label} aria-expanded={a.expanded}>
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A glass popover rendered in a PORTAL at <body>. Inside the page it sat in
 * a row of glass chips and under the fixed workspace; a backdrop-filter does
 * not run under an ancestor that has its own backdrop-filter, or a transform
 * plus overflow clipping, and the brand list came out blurred and unreadable
 * (Junid, 2026-11-02). At body level it is one strong-glass surface with crisp
 * text over the page. Positioned under its anchor; Escape or a click outside
 * closes it. Falls back to rendering in place where there is no DOM (tests).
 */
export function SkyPopover({ anchorRef, open, onClose, align = "start", width = 260, label, role = "menu", className = "", children, testId }) {
  const [pos, setPos] = useState(null);
  const canPortal = typeof document !== "undefined" && !!document.body && typeof document.body.appendChild === "function";
  useLayoutEffect(() => {
    if (!open || !canPortal) return undefined;
    const place = () => {
      const r = anchorRef?.current?.getBoundingClientRect?.();
      if (!r) return;
      const vw = window.innerWidth;
      let left = align === "end" ? r.right - width : align === "center" ? r.left + r.width / 2 - width / 2 : r.left;
      left = Math.max(12, Math.min(left, vw - width - 12));
      setPos({ top: r.bottom + 10, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, canPortal, align, width, anchorRef]);
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.addEventListener) return undefined;
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  const body = (
    <div className={cx("sky-pop", className)} role={role} aria-label={label} data-testid={testId}
         style={canPortal ? { top: pos?.top ?? -9999, left: pos?.left ?? -9999, width } : { width }}>
      {children}
    </div>
  );
  if (!canPortal) return body;
  return createPortal(<><div className="sky-pop-scrim" onClick={onClose} aria-hidden="true" />{body}</>, document.body);
}

// ── THE PRODUCT STAGE ─────────────────────────────────────────────────────────
// photoCutoutUrl is ADDITIVE (tools/cutouts writes it beside photoUrl, never
// over it). A cut-out stands on the podium only when ALL of these hold:
//   - the product is footwear (category "Footwear") — perfume, bags, clothing
//     always show their original photo (Junid, 3 Nov);
//   - the cut-out passed the quality gate: photoCutoutQuality "shoe" (a
//     "rejected" one has no URL; an old whole-object "fallback" is never shown);
//   - it was cut from the photo the product shows now (photoCutoutFor), so a
//     re-shot product shows its new full photo until tonight's pass judges it.
// Junid, 3 Nov: "let's use the original photo rather". Cut-outs are OFF —
// every card, the popup and the size sheet show the original photo. The
// fields stay in RTDB and the code stays here; true brings them back.
export const SHOW_CUTOUTS = false;

export function cutoutSrc(p) {
  if (!SHOW_CUTOUTS) return null;
  const c = p?.photoCutoutUrl;
  if (typeof c !== "string" || !c) return null;
  if (p.category !== "Footwear" || p.photoCutoutQuality !== "shoe") return null;
  if (p.photoCutoutFor && p.photoCutoutFor !== p.photoUrl) return null;
  return c;
}

/**
 * Cut-out on a podium when there is one; otherwise the existing full-
 * resolution photo (same source and cache as before — HiResPhoto) in a white
 * rounded frame filling the stage, no podium. Both states are finished looks.
 */
export function ProductStage({ p, height, emoji = "👟", podiumWidth, cutoutHeight, priority = false }) {
  const cut = cutoutSrc(p);
  const [cutFailed, setCutFailed] = useState(null);
  const useCut = cut && cutFailed !== cut;
  if (useCut) {
    return (
      <div className="sky-stage" style={{ height }} data-stage="podium">
        <span className="sky-podium" style={podiumWidth ? { width: podiumWidth } : undefined} />
        <img className="sky-cutout" src={cut} alt={p.name || ""} draggable={false}
             loading={priority ? "eager" : "lazy"} decoding="async"
             style={{ maxHeight: cutoutHeight || "78%", marginBottom: 22 }}
             onError={() => setCutFailed(cut)} />
      </div>
    );
  }
  return (
    <div className="sky-stage" style={{ height }} data-stage="frame">
      <div className="sky-frame">
        <HiResPhoto key={p.photoUrl || ""} p={p} alt={p.name || ""}
                    fallback={<span style={{ fontSize: 46 }}>{p.photo || emoji}</span>} />
      </div>
    </div>
  );
}

export function SkyPlus({ onClick, label = "Add" }) {
  return (
    <button type="button" className="sky-plus sky-solid" aria-label={label} onClick={onClick}><IconPlus /></button>
  );
}

/** Glass bottom cart bar: cart icon, item count, and a solid action pill. */
export function SkyBottomBar({ count, onOpen, label = "View order", disabled = false }) {
  return (
    <div className="sky-bottombar sky-glass sky-sheen" data-testid="sky-cartbar">
      <IconCart width={22} height={22} />
      <span className="sky-bottombar__div" aria-hidden="true" />
      <span style={{ fontSize: 14, fontWeight: 800 }}>{count} item{count === 1 ? "" : "s"}</span>
      <button type="button" className="sky-bottombar__cta sky-solid" onClick={onOpen} disabled={disabled}>{label}</button>
    </div>
  );
}

/** "R750" — the R, no decimals (prices are whole rand in this shop). */
export function fmtRand(n) {
  if (typeof n !== "number" || !(n > 0)) return null;
  return "R" + Math.round(n).toLocaleString("en-ZA").replace(/ /g, " ");
}
