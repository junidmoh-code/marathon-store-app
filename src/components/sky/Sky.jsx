// ─── SKY — shared glass components ───────────────────────────────────────────
//
// The pieces every screen is built from (see design/DNA.md): the room, the
// header, pills, segmented toggles, chip rows, the search pill, the product
// stage (cut-out on a podium, or the full photo in a white frame) and the
// glass bottom bar. Presentation only — every handler is the caller's.

import { useEffect, useState } from "react";
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
export function SkyRound({ label, onClick, children, className = "", ...rest }) {
  return (
    <button type="button" className={cx("sky-round sky-glass sky-glass--soft", className)} aria-label={label} title={label} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/**
 * Header on every screen: round glass grid button left, the wordmark centred,
 * round glass user button right, and a small glass pill under the logo naming
 * the screen (ASSISTANT) or the device/store (2POS).
 */
export function SkyHeader({ tag, onGrid, onUser, userInitial = null, large = false, gridLabel = "Home", userLabel = "Account", left = null, right = null, className = "" }) {
  return (
    <header className={cx("sky-header", className)}>
      <div className="sky-header__l">
        {left ?? (onGrid ? <SkyRound label={gridLabel} onClick={onGrid}><IconGrid /></SkyRound> : null)}
      </div>
      <div className="sky-header__c">
        <SkyLogo large={large} />
        {tag ? <span className={cx("sky-tag sky-glass sky-glass--soft", large && "sky-tag--lg")}>{tag}</span> : null}
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

/** Glass pill segmented toggle (Sneakers / Clothing, the store chips). */
export function SkySegmented({ options, value, onChange, className = "", size = "md", ariaLabel }) {
  return (
    <div className={cx("sky-seg sky-glass sky-glass--soft", size === "lg" && "sky-seg--lg", className)} role="group" aria-label={ariaLabel}>
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

/** The big glass search pill — icon left, a camera/scan or filter button right. */
export function SkySearch({ value, onChange, placeholder = "Search products...", inputRef, onAction, action = "camera", actionLabel, large = false, className = "", inputProps = {} }) {
  const ActionIcon = action === "filter" ? IconFilter : IconCamera;
  return (
    <div className={cx("sky-search sky-glass sky-glass--soft", large && "sky-search--lg", className)}>
      <IconSearch />
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
             autoComplete="off" aria-label="Search products" {...inputProps} />
      {onAction ? (
        <button type="button" className="sky-search__btn" onClick={onAction} aria-label={actionLabel} title={actionLabel}>
          <ActionIcon />
        </button>
      ) : null}
    </div>
  );
}

// ── THE PRODUCT STAGE ─────────────────────────────────────────────────────────
// photoCutoutUrl is ADDITIVE (tools/cutouts writes it beside photoUrl, never
// over it). A cut-out stands on the podium only while it was cut from the photo
// the product shows now: photoCutoutFor names that photo, so a re-shot product
// falls back to its new full photo until tonight's pass cuts it again.
export function cutoutSrc(p) {
  const c = p?.photoCutoutUrl;
  if (typeof c !== "string" || !c) return null;
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
      <IconCart width={30} height={30} />
      <span className="sky-bottombar__div" aria-hidden="true" />
      <span style={{ fontSize: 16, fontWeight: 800 }}>{count} item{count === 1 ? "" : "s"}</span>
      <button type="button" className="sky-bottombar__cta sky-solid" onClick={onOpen} disabled={disabled}>{label}</button>
    </div>
  );
}

/** "R750" — the R, no decimals (prices are whole rand in this shop). */
export function fmtRand(n) {
  if (typeof n !== "number" || !(n > 0)) return null;
  return "R" + Math.round(n).toLocaleString("en-ZA").replace(/ /g, " ");
}
