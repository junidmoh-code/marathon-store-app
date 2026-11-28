// ─── WAREHOUSE, PHONE — THE TOP BAND (Junid, 6 Nov; revised the same day) ────
//
// The header is the SHELL's (App.jsx → SkyShellHeader: grid, wordmark, the
// WAREHOUSE pill whose chevron opens the view switcher, account). This band
// draws no header of its own and no "Switch View · Viewing as · Incoming"
// strip — the pill does Switch View, and the Incoming count is the Incoming
// chip's below. What stays: the hub pill + Switch Hub, the live line, and the
// tabs as glass tiles.
//
// Presentation only. onSwitchHub is the old "Switch Hub" (forget the hub, pick
// again), onTab the old tab strip's setMainTab; the tabs list is tabDefs,
// unchanged — this draws it, it does not decide it.

const I = {
  grid: <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9"><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></svg>,
  house: <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M3 10.5 12 4l9 6.5V20H3z" /><path d="M7.5 20v-7.5h9V20M7.5 15.5h9" /></svg>,
  swap: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>,
  chev: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>,
  right: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>,
  queue: <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 2.8 20.5 7.4v9.2L12 21.2 3.5 16.6V7.4z" /><path d="M3.5 7.4 12 12l8.5-4.6M12 12v9.2" /></svg>,
  refills: <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 3.5 20 9 14.5 9" /><path d="M19.4 14.5A8 8 0 1 1 17.7 6.4L20 9" /></svg>,
  layby: <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 3 21 7.5 12 12 3 7.5z" /><path d="M3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5" /></svg>,
  clothing: <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4l-4 4-4-4M3 7l5-3h8l5 3M3 7v13a1 1 0 001 1h16a1 1 0 001-1V7M3 7l4 4M21 7l-4 4" /></svg>,
};

export default function WarehouseTop({ hubLabel, tabs = [], tab, onTab, onSwitchHub }) {
  return (
    <div className="wht">
      <div className="wht-row wht-row--hub">
        <button type="button" className="wht-hub" onClick={onSwitchHub} aria-label={`${hubLabel} — switch hub`}>
          <span>{hubLabel}</span><i aria-hidden="true" />{I.chev}
        </button>
        <button type="button" className="wht-pill wht-pill--sm" onClick={onSwitchHub}>{I.swap}<span>Switch Hub</span></button>
      </div>

      <div className="wht-live" data-contrast-exempt=""><i aria-hidden="true" />Update order status in real time.</div>

      <div className="wht-tiles" role="tablist" style={{ gridTemplateColumns: `repeat(${Math.max(1, tabs.length)}, minmax(0, 1fr))` }}>
        {tabs.map(([key, label, badge]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="wht-tile" onClick={() => onTab(key)}>
            {I[key] || I.queue}
            <span className="wht-tlab">{label}</span>
            {badge != null && badge > 0 && <span className="wht-badge">{badge}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ONE GLASS LEVEL PER NESTING (Junid, 6 Nov — "too white"): the hub pill,
// Switch Hub, the tiles, the chips and the Today group are standard glass
// (0.40) with navy ink; the order cards INSIDE the Today group are not another
// glass layer — a 1px rim on the same surface, 12px apart. Mark as Sent is
// solid navy, Mark as Out of Stock a soft red glass with navy text, the rest
// navy outlines with no fill. The selected chip is solid navy.
export const WAREHOUSE_SKY_CSS = `
.wh-sky{background:transparent!important;color:var(--sky-ink);padding-left:var(--sky-sal);padding-right:var(--sky-sar)}
.wht{padding:2px 0 4px}
.wht-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:0 14px}
.wht-row--hub .wht-pill--sm{grid-column:3}
.wht-glass,.wht-hub,.wht-pill,.wht-tile{background:var(--sky-glass);border:1px solid var(--sky-rim);box-shadow:var(--sky-highlight),0 6px 16px -10px rgba(0,40,120,.35);
  -webkit-backdrop-filter:blur(24px) saturate(1.5);backdrop-filter:blur(24px) saturate(1.5);color:var(--sky-ink)}
.wht-hub{display:inline-flex;align-items:center;gap:11px;height:36px;padding:0 13px 0 17px;border-radius:999px;cursor:pointer;font:800 14px/1 var(--sky-font)}
.wht-hub i{width:1px;height:16px;background:rgba(11,42,82,.25)}
.wht-pill{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 13px;border-radius:999px;cursor:pointer;font:700 12px/1 var(--sky-font);white-space:nowrap}
.wht-pill svg,.wht-hub svg{flex:0 0 auto;color:var(--sky-navy)}
.wht-live{display:flex;align-items:center;gap:10px;padding:0 19px;margin-top:15px;font:500 12px/1.2 var(--sky-font);color:#fff;text-shadow:0 1px 4px rgba(0,30,90,.35)}
.wht-live i{width:8px;height:8px;border-radius:50%;background:#33d17a;box-shadow:0 0 8px rgba(51,209,122,.8)}
.wht-tiles{display:grid;gap:10px;padding:0 15px;margin-top:15px}
.wht-tile{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:62px;padding:8px 6px;border-radius:18px;cursor:pointer;
  font:700 11.5px/1.15 var(--sky-font);text-align:center}
.wht-tile svg{width:22px;height:22px;color:var(--sky-navy)}
.wht-tile[aria-selected="true"]{border:1.5px solid var(--sky-navy)}
.wht-tlab{max-width:90%}
.wht-badge{position:absolute;top:7px;right:9px;min-width:20px;height:20px;padding:0 6px;border-radius:999px;display:grid;place-items:center;background:var(--sky-navy);color:#fff;font:800 11px/1 var(--sky-font)}
/* The tab row (Incoming · Ready · Out of Stock · All). */
.wh-sky .wh-chips{display:flex;gap:8px;padding:14px 15px 12px!important;overflow-x:auto;scrollbar-width:none}
html[data-sky="on"] #root .wh-sky .wh-chip{height:30px;padding:0 6px 0 13px!important;border-radius:999px!important;font:700 12px/1 var(--sky-font)!important;color:var(--sky-ink)!important;
  background:var(--sky-glass)!important;border:1px solid var(--sky-rim)!important;box-shadow:var(--sky-highlight)}
html[data-sky="on"] #root .wh-sky .wh-chip > span{min-width:22px;width:auto!important;height:20px!important;padding:0 6px;border-radius:999px!important;background:rgba(11,42,82,.1)!important;color:var(--sky-ink)!important;font-size:10.5px!important}
html[data-sky="on"] #root .wh-sky .wh-chip[data-on]{background:var(--sky-navy)!important;color:#fff!important;border-color:var(--sky-navy)!important}
html[data-sky="on"] #root .wh-sky .wh-chip[data-on] > span{background:rgba(255,255,255,.22)!important;color:#fff!important}
/* The Today group: standard glass, the ONE glass level. */
html[data-sky="on"] #root .wh-sky [data-day-section]{background:var(--sky-glass)!important;border:1px solid var(--sky-rim)!important;border-radius:20px!important;box-shadow:var(--sky-highlight),0 10px 24px -16px rgba(0,40,120,.4)!important;
  -webkit-backdrop-filter:blur(24px) saturate(1.5);backdrop-filter:blur(24px) saturate(1.5)}
html[data-sky="on"] #root .wh-sky [data-day-head]{border-bottom:1px solid rgba(11,42,82,.12)}
html[data-sky="on"] #root .wh-sky [data-day-head] > div:first-child > div:first-child{font-size:16px!important;font-weight:800!important;color:var(--sky-ink)!important}
html[data-sky="on"] #root .wh-sky [data-day-head] > div:first-child > div:nth-child(2){background:rgba(11,42,82,.08)!important;border-color:rgba(11,42,82,.2)!important;color:var(--sky-ink)!important}
html[data-sky="on"] #root .wh-sky [data-day-head] svg{color:var(--sky-ink)!important;stroke:var(--sky-ink)!important}
/* Order cards: NOT another glass layer — a 1px rim on the group's surface. */
html[data-sky="on"] #root .wh-sky [data-order-card]{background:transparent!important;border:1px solid rgba(11,42,82,.16)!important;border-radius:16px!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
html[data-sky="on"] #root .wh-sky [data-order-card] > div:first-child{display:none}
html[data-sky="on"] #root .wh-sky [data-order-card] > div:nth-child(2) > div:first-child{background:transparent!important;box-shadow:none!important;border:0!important}
html[data-sky="on"] #root .wh-sky [data-order-card] > div:nth-child(2) > div:nth-child(2) > div:not(:first-child),
html[data-sky="on"] #root .wh-sky [data-order-card] > div:nth-child(2) > div:nth-child(2) > div:first-child > div:first-child,
html[data-sky="on"] #root .wh-sky [data-order-card] > div:nth-child(2) > div:nth-child(2) > div:first-child > div:last-child{color:var(--sky-ink)!important}
html[data-sky="on"] #root .wh-sky [data-order-card] > div:nth-child(2) svg{color:var(--sky-ink)}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button{min-height:36px;padding:0 6px!important;white-space:nowrap;border-radius:999px!important;font-size:11.5px!important;font-weight:700!important;letter-spacing:-.01em;
  color:var(--sky-navy)!important;background:transparent!important;border:1.5px solid var(--sky-navy)!important;box-shadow:none!important}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button *{color:inherit!important}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button.wh-act--sent{background:var(--sky-navy)!important;border-color:var(--sky-navy)!important;color:#fff!important}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button.wh-act--oos{background:rgba(255,120,140,.24)!important;border:1px solid rgba(225,60,80,.45)!important;color:var(--sky-ink)!important}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button:disabled{opacity:.5}
`;
