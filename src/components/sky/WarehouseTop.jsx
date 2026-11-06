// ─── WAREHOUSE, PHONE — THE TOP BAND (Junid's mock-up, 6 Nov) ────────────────
//
// Header (grid · wordmark · account) with the WAREHOUSE pill; a row of three
// glass pills — Switch View, "Viewing as WAREHOUSE", the incoming count; the
// hub pill and Switch Hub; the live line; then the tabs as three glass tiles
// (Order Queue · Display Refills · Layby, and CR Orders on a CR hub).
//
// Presentation only. Every handler is WarehouseView's own: onExit is the old
// "← Switch View", onSwitchHub the old "Switch Hub" (forget the hub, pick
// again), onTab the old tab strip's setMainTab. The tabs list is tabDefs,
// unchanged — this draws it, it does not decide it.

import { SkyHeader } from "./Sky.jsx";

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

export default function WarehouseTop({ hubLabel, incomingCount = 0, tabs = [], tab, onTab, onExit, onSwitchHub, role = "WAREHOUSE" }) {
  return (
    <div className="wht" data-contrast-exempt="">
      <SkyHeader onGrid={onExit} gridLabel="Switch view" onUser={onExit} userLabel="Account"
                 tagNode={<button type="button" className="wht-role" onClick={onExit} aria-label={`Viewing as ${role.toLowerCase()} — switch view`}>{role}{I.chev}</button>} />

      <div className="wht-row">
        <button type="button" className="wht-pill" onClick={onExit}>{I.grid}<span>Switch View</span></button>
        <div className="wht-pill wht-pill--on" aria-label={`Viewing as ${role}`}>
          {I.house}
          <span className="wht-two"><small>Viewing as</small><b>{role}</b></span>
        </div>
        <div className="wht-pill wht-pill--count" aria-label={`${incomingCount} incoming`}>
          <i className="wht-dot" aria-hidden="true" />
          <span className="wht-two"><b>{incomingCount}</b><small>Incoming</small></span>
          {I.right}
        </div>
      </div>

      <div className="wht-row wht-row--hub">
        <button type="button" className="wht-hub" onClick={onSwitchHub} aria-label={`${hubLabel} — switch hub`}>
          <span>{hubLabel}</span><i aria-hidden="true" />{I.chev}
        </button>
        <button type="button" className="wht-pill wht-pill--sm" onClick={onSwitchHub}>{I.swap}<span>Switch Hub</span></button>
      </div>

      <div className="wht-live"><i aria-hidden="true" />Update order status in real time.</div>

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

export const WAREHOUSE_SKY_CSS = `
.wh-sky{background:transparent!important;color:#fff;padding-left:var(--sky-sal);padding-right:var(--sky-sar)}
.wht{padding:0 0 4px}
.wht .sky-header{padding:calc(var(--sky-sat) + 14px) 16px 0}
html[data-sky="on"] #root .wht .sky-header__l .sky-round{width:40px;height:40px;color:#fff!important;background:rgba(255,255,255,.16)!important;border:1px solid rgba(255,255,255,.5)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.35)!important}
html[data-sky="on"] #root .wht .sky-header__r .sky-round{width:40px;height:40px;color:#fff!important;background:none!important;border:0!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
.wht .sky-round svg{width:21px;height:21px;color:#fff;stroke:#fff}
.wht .sky-logo__m{font-size:27px}
.wht .sky-logo__c{font-size:9px;margin-top:4px}
.wht-role{display:inline-flex;align-items:center;gap:8px;margin-top:9px;height:27px;padding:0 13px 0 16px;border-radius:999px;cursor:pointer;
  font:700 12.5px/1 var(--sky-font);letter-spacing:.02em;color:#fff;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.55);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 16px -8px rgba(0,40,120,.4)}
.wht-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:0 14px;margin-top:20px}
.wht-pill{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:40px;padding:0 11px;min-width:0;border-radius:999px;cursor:pointer;color:#fff;
  font:600 12px/1 var(--sky-font);background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.5);box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 6px 16px -10px rgba(0,40,120,.45);white-space:nowrap}
.wht-pill svg{flex:0 0 auto}
.wht-row:first-of-type .wht-pill > svg:first-child{width:18px;height:18px}
.wht-pill--on{cursor:default;height:44px;padding:0 9px;background:rgba(255,255,255,.24);border:1.5px solid rgba(255,255,255,.85);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 0 18px rgba(170,220,255,.45)}
.wht-pill--count{cursor:default;gap:7px;padding:0 8px 0 10px}
.wht-two{display:flex;flex-direction:column;align-items:flex-start;gap:2px;line-height:1}
.wht-two small{font:500 11px/1.1 var(--sky-font);color:rgba(255,255,255,.92)}
.wht-two b{font:700 13px/1.1 var(--sky-font);letter-spacing:.02em}
.wht-pill--count .wht-two b{font-size:13.5px}
.wht-dot{width:8px;height:8px;border-radius:50%;background:#dfe9ff;box-shadow:0 0 8px rgba(255,255,255,.9)}
.wht-row--hub{grid-template-columns:auto 1fr auto;margin-top:17px}
.wht-row--hub .wht-pill--sm{grid-column:3}
.wht-hub{display:inline-flex;align-items:center;gap:11px;height:36px;padding:0 13px 0 17px;border-radius:999px;cursor:pointer;color:#fff;
  font:700 14px/1 var(--sky-font);background:linear-gradient(180deg,#123a8a,#0b2a6e);border:1px solid rgba(255,255,255,.35);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 8px 18px -10px rgba(0,20,70,.7)}
.wht-hub i{width:1px;height:16px;background:rgba(255,255,255,.35)}
.wht-pill--sm{height:34px;font-size:12px}
.wht-live{display:flex;align-items:center;gap:10px;padding:0 19px;margin-top:15px;font:500 12px/1.2 var(--sky-font);color:rgba(255,255,255,.95)}
.wht-live i{width:8px;height:8px;border-radius:50%;background:#33d17a;box-shadow:0 0 8px rgba(51,209,122,.8)}
.wht-tiles{display:grid;gap:10px;padding:0 15px;margin-top:15px}
.wht-tile{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:62px;padding:8px 6px;border-radius:18px;cursor:pointer;color:#fff;
  font:600 11.5px/1.15 var(--sky-font);text-align:center;background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.45);box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 8px 18px -12px rgba(0,40,120,.45)}
.wht-tile[aria-selected="true"]{background:rgba(255,255,255,.22);border-color:rgba(255,255,255,.85)}
.wht-tile svg{width:22px;height:22px}
.wht-tlab{max-width:90%}
.wht-badge{position:absolute;top:7px;right:9px;min-width:20px;height:20px;padding:0 6px;border-radius:999px;display:grid;place-items:center;background:#fff;color:#0b2a6e;font:800 11px/1 var(--sky-font)}
/* The queue under it: chips, the day groups, the order cards. */
.wh-sky .wh-chips{display:flex;gap:8px;padding:14px 15px 12px!important;overflow-x:auto;scrollbar-width:none}
html[data-sky="on"] #root .wh-sky .wh-chip{height:30px;padding:0 6px 0 13px!important;border-radius:999px!important;font:600 12px/1 var(--sky-font)!important;color:#fff!important;
  background:rgba(255,255,255,.14)!important;border:1px solid rgba(255,255,255,.5)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
html[data-sky="on"] #root .wh-sky .wh-chip > span{min-width:22px;width:auto!important;height:20px!important;padding:0 6px;border-radius:999px!important;background:rgba(255,255,255,.28)!important;color:#fff!important;font-size:10.5px!important}
html[data-sky="on"] #root .wh-sky .wh-chip[data-on]{background:#fff!important;color:#0b2a6e!important;border-color:#fff!important}
html[data-sky="on"] #root .wh-sky .wh-chip[data-on] > span{background:#1d3fb8!important;color:#fff!important}
html[data-sky="on"] #root .wh-sky [data-day-section]{background:rgba(255,255,255,.12)!important;border:1px solid rgba(255,255,255,.45)!important;border-radius:20px!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
html[data-sky="on"] #root .wh-sky [data-day-head]{border-bottom:1px solid rgba(255,255,255,.2)}
html[data-sky="on"] #root .wh-sky [data-day-head] > div:first-child > div:first-child{font-size:16px!important;font-weight:800!important;color:#fff!important}
html[data-sky="on"] #root .wh-sky [data-day-head] > div:first-child > div:nth-child(2){background:rgba(255,255,255,.2)!important;border-color:rgba(255,255,255,.5)!important;color:#fff!important}
html[data-sky="on"] #root .wh-sky [data-order-card]{background:rgba(255,255,255,.12)!important;border:1px solid rgba(255,255,255,.5)!important;border-radius:18px!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 8px 18px -12px rgba(0,40,120,.4)}
html[data-sky="on"] #root .wh-sky [data-order-card] > div:first-child{display:none}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button{min-height:34px;border-radius:999px!important;font-size:12px!important;font-weight:600!important;color:#fff!important;
  background:rgba(255,255,255,.14)!important;border:1px solid rgba(255,255,255,.45)!important}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button.wh-act--sent{background:rgba(205,250,228,.85)!important;border-color:rgba(255,255,255,.9)!important;color:#0d6b3a!important}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button.wh-act--oos{background:rgba(255,218,228,.85)!important;border-color:rgba(255,255,255,.9)!important;color:#c0182c!important}
html[data-sky="on"] #root .wh-sky [data-order-card] .wh-actgrid > button:disabled{opacity:.55}
`;
