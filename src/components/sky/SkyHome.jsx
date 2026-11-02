// ─── SKY HOME (design/home.png) ──────────────────────────────────────────────
//
// Four big glass tiles in a 2x2 grid in the room's middle band — Store
// Assistant, Warehouse, Display Check, Admin — each with its outline icon, its
// label and a count pill where the app already had a count. Every other home
// card (the old Operations / Insights / Administration lists and the live stock
// cards) lives one tap away in the Admin hub; the account controls (name,
// notifications, the one sign-out) live behind the user button.
//
// Presentation only. The tiles, cards and their gates are computed by
// RoleSelector exactly as before; this component only lays them out.

import { useEffect, useState } from "react";
import { SkyHeader } from "./Sky.jsx";
import { IconBag, IconBox, IconMonitorCheck, IconLayersShield, IconChevronLeft, IconClose } from "./SkyIcons.jsx";

const TILE_ICON = {
  assistant: IconBag,
  warehouse: IconBox,
  display_checks: IconMonitorCheck,
  admin: IconLayersShield,
};

export const HOME_TILE_KEYS = Object.freeze(["assistant", "warehouse", "display_checks", "admin"]);

function Tile({ tile }) {
  const Icon = TILE_ICON[tile.key] || IconBox;
  return (
    <button type="button" className="sky-tile sky-sheen" onClick={tile.onClick} data-testid={`home-tile-${tile.key}`}>
      <Icon className="sky-tile__ic" />
      <span className="sky-tile__nm">{tile.name}</span>
      {typeof tile.badge === "number" ? (
        <span className="sky-tile__ct">{tile.badge.toLocaleString("en-US")}</span>
      ) : null}
    </button>
  );
}

function MiniCard({ card }) {
  return (
    <button type="button" className="sky-mini" onClick={card.onClick} data-testid={`home-card-${card.key}`}>
      <span className="sky-mini__ic">{card.icon}</span>
      <span className="sky-mini__tx">
        <span className="sky-mini__nm">{card.name}</span>
        <span className="sky-mini__ds">{card.desc}</span>
      </span>
      {card.badge > 0 ? <span className="sky-mini__bd">{card.badge}</span> : null}
    </button>
  );
}

/**
 * @param tiles       the four primary tiles that this account may open, in order
 * @param groups      [{ label, cards }] — every other card, already gated
 * @param liveCards   React nodes (hub count, stock hold, display register)
 * @param tag         the pill under the logo (device / store, e.g. 2POS)
 * @param account     { name, initial, rows } — rows are the notification + sign-out rows
 */
export default function SkyHome({ tiles, groups, liveCards = [], tag, account, emptyMessage, initialPanel = null }) {
  const [panel, setPanel] = useState(initialPanel);   // null | "admin" | "account"
  useEffect(() => {
    if (!panel) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setPanel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  // [key, node] pairs: a card that comes and goes must not shift the others' keys.
  const live = liveCards.filter((e) => e && e[1]);
  const hubGroups = groups.filter((g) => g.cards.length > 0);
  const hasHub = hubGroups.length > 0 || live.length > 0;
  const shown = tiles.map((t) => (t.key === "admin" ? { ...t, onClick: () => setPanel("admin") } : t))
    .filter((t) => t.key !== "admin" || hasHub);

  return (
    <div className="sky-home" data-testid="sky-home">
      <style>{HOME_CSS}</style>
      <SkyHeader large tag={panel === "admin" ? "ADMIN" : tag}
                 left={panel ? (
                   <button type="button" className="sky-round sky-glass sky-glass--soft" aria-label="Back to home" title="Back" onClick={() => setPanel(null)}>
                     <IconChevronLeft />
                   </button>
                 ) : null}
                 onGrid={() => setPanel(hasHub ? "admin" : null)} gridLabel="All tools"
                 onUser={() => setPanel(panel === "account" ? null : "account")} userLabel="Account" />

      {panel === "admin" ? (
        <div className="sky-hub">
          {live.length > 0 && <div className="sky-hub__live">{live.map(([k, n]) => <div key={k} className="sky-hub__livecard">{n}</div>)}</div>}
          {hubGroups.map((g) => (
            <section key={g.label} className="sky-hub__grp">
              <h2 className="sky-hub__lab">{g.label}</h2>
              <div className="sky-hub__grid">{g.cards.map((c) => <MiniCard key={c.key} card={c} />)}</div>
            </section>
          ))}
        </div>
      ) : (
        <main className="sky-home__band">
          {shown.length === 0 ? (
            <div className="sky-panel sky-glass" style={{ textAlign: "center", fontWeight: 600 }}>{emptyMessage}</div>
          ) : (
            <div className={`sky-home__grid n${shown.length}`}>{shown.map((t) => <Tile key={t.key} tile={t} />)}</div>
          )}
        </main>
      )}

      {panel === "account" && (
        <div className="sky-acct-wrap" onClick={(e) => { if (e.currentTarget === e.target) setPanel(null); }}>
          <div className="sky-acct sky-glass sky-sheen" role="dialog" aria-label="Account">
            <button type="button" className="sky-acct__x" aria-label="Close" onClick={() => setPanel(null)}><IconClose width={18} height={18} /></button>
            <div className="sky-acct__who">
              <span className="sky-acct__av">{account.initial}</span>
              <span>
                <span className="sky-acct__nm">{account.name}</span>
                {tag ? <span className="sky-acct__tag">{tag}</span> : null}
              </span>
            </div>
            {account.rows}
          </div>
        </div>
      )}
    </div>
  );
}

const HOME_CSS = `
.sky-home .sky-round{width:46px;height:46px}
.sky-home .sky-header{padding-top:calc(env(safe-area-inset-top,0px) + 26px)}
.sky-home{min-height:100vh;min-height:100dvh;color:#fff;font-family:var(--sky-font);padding-bottom:40px}
.sky-home__band{padding:0 25px;margin-top:max(28px,calc(34vh - 152px));margin-top:max(28px,calc(34dvh - 152px))}
.sky-home__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:13px;row-gap:15px;max-width:420px;margin:0 auto}
.sky-tile{position:relative;aspect-ratio:183/180;border-radius:var(--sky-r-tile);cursor:pointer;color:#fff;font-family:var(--sky-font);
  display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:0;padding:26px 10px 0;
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.12) 70%,rgba(255,255,255,.2));
  border:1.5px solid rgba(255,255,255,.62);
  box-shadow:inset 0 0 16px 1px rgba(255,255,255,.42),inset 0 -16px 22px -10px rgba(255,255,255,.7),var(--sky-shadow);
  -webkit-backdrop-filter:blur(10px) saturate(130%);backdrop-filter:blur(10px) saturate(130%);
  transition:transform .22s cubic-bezier(.2,.7,.2,1),box-shadow .22s}
.sky-tile:hover{transform:translateY(-4px)}
.sky-tile__ic{width:58px;height:58px;stroke-width:1.5}
.sky-tile__nm{margin-top:12px;font-size:17px;font-weight:700;letter-spacing:-.015em;white-space:nowrap}
.sky-tile__ct{margin-top:14px;min-width:72px;height:35px;padding:0 15px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;
  font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;
  background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.45);box-shadow:inset 0 1px 0 rgba(255,255,255,.6)}
.sky-tile[data-testid="home-tile-display_checks"],.sky-tile[data-testid="home-tile-admin"]{padding-top:32px}
.sky-tile[data-testid="home-tile-display_checks"] .sky-tile__nm,.sky-tile[data-testid="home-tile-admin"] .sky-tile__nm{margin-top:24px}
@media (min-width:900px){
  .sky-home__band{margin-top:0;position:absolute;left:0;right:0;top:58%;transform:translateY(-100%);padding:0 32px}
  .sky-home__grid{grid-template-columns:repeat(4,minmax(0,1fr));column-gap:22px;max-width:1040px}
  .sky-home__grid.n3{grid-template-columns:repeat(3,minmax(0,1fr));max-width:780px}
  .sky-home__grid.n2{grid-template-columns:repeat(2,minmax(0,1fr));max-width:520px}
  .sky-home{position:relative}
  .sky-home .sky-logo--lg .sky-logo__m{font-size:50px}
  .sky-home .sky-logo--lg .sky-logo__c{font-size:15px;margin-top:10px}
  .sky-home .sky-header{padding:34px 48px 0}
  .sky-home .sky-round{width:58px;height:58px}
  .sky-home .sky-round svg{width:26px;height:26px}
  .sky-tile__nm{font-size:19px}
}
@media (min-width:900px) and (max-height:620px){.sky-home__band{position:static;transform:none;margin-top:36px}}
.sky-hub{max-width:1080px;margin:26px auto 0;padding:0 var(--sky-gutter) 40px}
.sky-hub__live{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-bottom:22px}
.sky-hub__grp{margin-bottom:22px}
.sky-hub__lab{margin:0 4px 10px;font:800 12px/1 var(--sky-font);letter-spacing:.2em;text-transform:uppercase;color:#fff}
.sky-hub__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.sky-mini{position:relative;display:flex;align-items:center;gap:13px;width:100%;text-align:left;cursor:pointer;color:#fff;font-family:var(--sky-font);
  padding:13px 14px;border-radius:20px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.55);
  box-shadow:var(--sky-highlight),0 10px 26px -16px rgba(0,60,170,.5);transition:transform .18s,background .18s}
.sky-mini:hover{transform:translateY(-2px);background:rgba(255,255,255,.26)}
.sky-mini:focus-visible{outline:2px solid #fff;outline-offset:3px}
.sky-mini__ic{width:42px;height:42px;flex:0 0 auto;border-radius:14px;display:grid;place-items:center;background:rgba(255,255,255,.22);border:1px solid rgba(255,255,255,.5)}
.sky-mini__ic svg{width:21px !important;height:21px !important;filter:none !important}
.sky-mini__ic svg,.sky-mini__ic svg [stroke]:not([stroke="none"]){stroke:#fff !important}
.sky-mini__ic svg [fill]:not([fill="none"]){fill:#fff !important}
.sky-mini__tx{min-width:0;flex:1}
.sky-mini__nm{display:block;font-size:14.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sky-mini__ds{display:block;font-size:12px;color:rgba(255,255,255,.86);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.sky-mini__bd{flex:0 0 auto;font-size:12.5px;font-weight:800;color:var(--sky-navy);background:#fff;border-radius:999px;padding:3px 10px;font-variant-numeric:tabular-nums}
.sky-acct-wrap{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;align-items:flex-start;padding:calc(env(safe-area-inset-top,0px) + 74px) 14px 14px}
.sky-acct{width:min(380px,100%);border-radius:24px;padding:18px 16px 16px;color:#fff;background:rgba(255,255,255,.34)}
.sky-acct__x{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,255,255,.6);background:rgba(255,255,255,.2);color:#fff;display:grid;place-items:center;cursor:pointer}
.sky-acct__who{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.sky-acct__av{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:#fff;color:var(--sky-navy);font-weight:800;font-size:19px}
.sky-acct__nm{display:block;font-size:17px;font-weight:800}
.sky-acct__tag{display:inline-block;margin-top:3px;font-size:10px;font-weight:800;letter-spacing:.06em;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.25);border:1px solid rgba(255,255,255,.5)}
@media (prefers-reduced-motion:reduce){.sky-tile,.sky-mini{transition:none}.sky-tile:hover,.sky-mini:hover{transform:none}}
`;
