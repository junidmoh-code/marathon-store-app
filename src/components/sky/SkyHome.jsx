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
import { SkyHeader, SkyBackGrid } from "./Sky.jsx";
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

// Admin hub tile (Junid 5 Nov mock-up): clear glass, white line icon, white
// bold name, the badge a white pill. The description stays as the tooltip.
function MiniCard({ card }) {
  return (
    <button type="button" className="sky-mini" onClick={card.onClick} data-testid={`home-card-${card.key}`}
            title={card.desc || undefined} aria-label={card.desc ? `${card.name} — ${card.desc}` : undefined}>
      <span className="sky-mini__ic">{card.icon}</span>
      <span className="sky-mini__nm" data-contrast-exempt="">{card.name}</span>
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
  const [panel, setPanel] = useState(() => (initialPanel === "admin" && !groups.some((g) => g.cards.length > 0) && !liveCards.some((e) => e && e[1]) ? null : initialPanel));   // null | "admin" | "account"
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
    <div className="sky-home" data-testid="sky-home" data-panel={panel || undefined}
         style={panel === "admin" ? { "--rows": Math.max(1, Math.ceil(hubGroups.reduce((n, g) => n + g.cards.length, 0) / 4)) } : undefined}>
      <style>{HOME_CSS}</style>
      {/* Admin view = Junid's mock-up (5 Nov): the grid button (tap again =
          home), the large wordmark, no pill, no account button. */}
      <SkyHeader large tag={panel === "admin" ? null : tag}
                 left={panel === "account" ? (
                   <button type="button" className="sky-round sky-glass sky-glass--soft" aria-label="Back to home" title="Back" onClick={() => setPanel(null)}>
                     <IconChevronLeft />
                   </button>
                 ) : (
                   // Home: the plain grid (opens Admin). The Admin panel is one
                   // level down, so there it is the back button (chevron + grid):
                   // tap or hold → Home.
                   <SkyBackGrid back={panel === "admin"} className={panel === "admin" ? "sky-backgrid--ghost" : undefined} label={panel === "admin" ? "Back to Home" : "All tools"}
                                onBack={() => setPanel(panel === "admin" ? null : (hasHub ? "admin" : null))}
                                onLongPress={panel === "admin" ? () => setPanel(null) : undefined} />
                 )}
                 onUser={panel === "admin" ? undefined : () => setPanel(panel === "account" ? null : "account")} userLabel="Account" />

      {panel === "admin" ? (
        <div className="sky-hub">
          {live.length > 0 && <div className="sky-hub__live">{live.map(([k, n]) => <div key={k} className="sky-hub__livecard">{n}</div>)}</div>}
          {/* One flat grid, the groups in their order (Junid's mock-up has no
              group headings). */}
          <div className="sky-hub__grid">{hubGroups.flatMap((g) => g.cards).map((c) => <MiniCard key={c.key} card={c} />)}</div>
        </div>
      ) : (
        <main className="sky-home__band">
          {shown.length === 0 ? (
            <div className="sky-panel sky-glass sky-glass--strong" style={{ textAlign: "center", fontWeight: 600 }}>{emptyMessage}</div>
          ) : (
            <div className={`sky-home__grid n${shown.length}`}>{shown.map((t) => <Tile key={t.key} tile={t} />)}</div>
          )}
        </main>
      )}

      {panel === "account" && (
        <div className="sky-acct-wrap" onClick={(e) => { if (e.currentTarget === e.target) setPanel(null); }}>
          <div className="sky-acct sky-glass sky-glass--strong sky-sheen" role="dialog" aria-label="Account">
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
.sky-home{min-height:100vh;min-height:100dvh;color:var(--sky-ink);font-family:var(--sky-font);padding-bottom:40px}
.sky-home__band{padding:0 25px;margin-top:max(28px,calc(34vh - 152px));margin-top:max(28px,calc(34dvh - 152px))}
.sky-home__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:13px;row-gap:15px;max-width:420px;margin:0 auto}
.sky-tile{position:relative;aspect-ratio:183/180;border-radius:var(--sky-r-tile);cursor:pointer;color:#fff;text-shadow:var(--sky-text-shadow);font-family:var(--sky-font);
  display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:0;padding:26px 10px 0;
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.12) 70%,rgba(255,255,255,.2));
  border:1.5px solid rgba(255,255,255,.62);
  box-shadow:inset 0 0 16px 1px rgba(255,255,255,.42),inset 0 -16px 22px -10px rgba(255,255,255,.7),var(--sky-shadow);
  -webkit-backdrop-filter:blur(10px) saturate(130%);backdrop-filter:blur(10px) saturate(130%);
  transition:transform .22s cubic-bezier(.2,.7,.2,1),box-shadow .22s}
.sky-tile:hover{transform:translateY(-4px)}
.sky-tile__ic{width:58px;height:58px;stroke-width:1.5;filter:drop-shadow(0 2px 10px rgba(0,40,110,.45))}
.sky-tile__nm{margin-top:12px;font-size:17px;font-weight:700;letter-spacing:-.015em;white-space:nowrap}
.sky-tile__ct{margin-top:14px;min-width:72px;height:35px;padding:0 15px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;
  font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--sky-ink);text-shadow:none;
  background:var(--sky-glass-solid);border:1px solid #fff;box-shadow:inset 0 1px 0 #fff}
/* No count pills (Junid 12 Nov), so every tile centres icon + name the way
   Display Check and Admin always did. */
.sky-home .sky-tile{padding-top:32px}
.sky-home .sky-tile .sky-tile__nm{margin-top:24px}
@media (min-width:900px){
  /* Laptop home (Junid 5 Nov, plain sky): smaller tiles, centred on the screen. */
  .sky-home__band{margin-top:0;position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);padding:0 32px}
  .sky-home__grid{grid-template-columns:repeat(4,minmax(0,1fr));column-gap:18px;max-width:min(820px,54vw,96vh)}
  .sky-home__grid.n3{grid-template-columns:repeat(3,minmax(0,1fr));max-width:615px}
  .sky-home__grid.n2{grid-template-columns:repeat(2,minmax(0,1fr));max-width:410px}
  .sky-home{position:relative;height:100vh;height:100dvh;min-height:0;padding-bottom:0;overflow:hidden}   /* one screen, never scrolls (Junid 5 Nov) */
  .sky-home .sky-logo--lg .sky-logo__m{font-size:50px}
  .sky-home .sky-logo--lg .sky-logo__c{font-size:15px;margin-top:10px}
  .sky-home .sky-header{padding:34px 48px 0}
  .sky-home .sky-round{width:58px;height:58px}
  .sky-home .sky-round svg{width:26px;height:26px}
  .sky-tile__nm{font-size:17px}
  .sky-tile{padding-top:22px}
  .sky-tile__ic{width:50px;height:50px}
  .sky-tile__ct{min-width:62px;height:31px;font-size:15px;margin-top:11px}
}
@media (min-width:900px) and (max-height:560px){.sky-home__band{position:static;transform:none;margin-top:36px}}
.sky-hub{max-width:1080px;margin:26px auto 0;padding:0 var(--sky-gutter) 40px}
.sky-hub__live{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-bottom:22px}
.sky-hub__grp{margin-bottom:22px}
.sky-hub__lab{display:inline-block;margin:0 4px 10px;padding:7px 12px;border-radius:999px;font:800 11.5px/1 var(--sky-font);letter-spacing:.18em;text-transform:uppercase;color:var(--sky-ink);
  background:var(--sky-glass);border:1px solid var(--sky-rim);box-shadow:var(--sky-highlight);-webkit-backdrop-filter:blur(28px) saturate(1.6) brightness(1.05);backdrop-filter:blur(28px) saturate(1.6) brightness(1.05)}
/* ONE layer of glass (Junid 5 Nov, "too much white"): the live card draws its
   own glass box; the cell around it is bare, not a second glass frame. */
.sky-hub__livecard{display:flex}
.sky-hub__livecard>*{flex:1;margin-bottom:0 !important;border-radius:20px !important;padding:16px 18px !important;box-shadow:var(--sky-highlight),var(--sky-shadow);-webkit-backdrop-filter:blur(28px) saturate(1.6) brightness(1.05);backdrop-filter:blur(28px) saturate(1.6) brightness(1.05)}
/* Its buttons are a light rim on the card's glass, not a second white slab. */
html[data-sky="on"] #root .sky-hub__livecard button[style]{background:rgba(255,255,255,.2) !important;border-color:rgba(255,255,255,.8) !important}
html[data-sky="on"] #root .sky-hub__livecard button[style]:hover{background:rgba(255,255,255,.4) !important}
.sky-hub__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.sky-mini{position:relative;display:flex;align-items:center;gap:14px;width:100%;min-height:78px;text-align:left;cursor:pointer;color:#fff;text-shadow:var(--sky-text-shadow);font-family:var(--sky-font);
  padding:12px 14px;border-radius:22px;
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.12) 70%,rgba(255,255,255,.2));
  border:1.5px solid rgba(255,255,255,.62);
  box-shadow:inset 0 0 16px 1px rgba(255,255,255,.42),inset 0 -16px 22px -10px rgba(255,255,255,.7),var(--sky-shadow);
  -webkit-backdrop-filter:blur(10px) saturate(130%);backdrop-filter:blur(10px) saturate(130%);transition:transform .18s,background .18s}
.sky-mini:hover{transform:translateY(-3px);background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.18) 70%,rgba(255,255,255,.28))}
.sky-mini:focus-visible{outline:2px solid #fff;outline-offset:3px}
.sky-mini__ic{width:34px;height:34px;flex:0 0 auto;display:grid;place-items:center}
.sky-mini__ic svg{width:30px !important;height:30px !important;filter:drop-shadow(0 2px 8px rgba(0,40,110,.45)) !important;stroke-width:1.6}
.sky-mini__ic svg,.sky-mini__ic svg [stroke]:not([stroke="none"]){stroke:#fff !important}
.sky-mini__ic svg [fill]:not([fill="none"]){fill:#fff !important}
.sky-mini__nm{min-width:0;flex:1;font-size:16px;font-weight:700;letter-spacing:-.01em;line-height:1.2;overflow:hidden;text-overflow:ellipsis}
.sky-mini__bd{flex:0 0 auto;min-width:40px;height:28px;padding:0 10px;border-radius:999px;display:grid;place-items:center;font-size:14px;font-weight:800;color:var(--sky-ink-deep);text-shadow:none;
  background:rgba(255,255,255,.95);border:1px solid #fff;font-variant-numeric:tabular-nums;box-shadow:0 4px 12px rgba(10,60,140,.18)}
/* Phone: the badge rides the tile's top-right corner so the name keeps its room. */
@media (max-width:899px){.sky-mini__bd{position:absolute;top:8px;right:8px;min-width:34px;height:24px;padding:0 8px;font-size:12.5px}}
/* DESKTOP ADMIN VIEW — a carbon copy of Junid's mock-up (5 Nov), measured at
   1586x942 and written in vw (base 1586) so a smaller window scales it down
   instead of looking zoomed in. Grid 1224 wide from y=202; tiles ~290x113,
   gaps 25/23; icon 40 at 36, name 21px bold at 108; badge 30 high, 24 in
   (or in the corner, 11/12 in, when the name is long). Header: grid button
   62 at 41/13, wordmark 48px. */
@media (min-width:900px){
  /* ONE SCREEN, NEVER SCROLLS (Junid 5 Nov): --u is the mock-up's 1vw, but no
     bigger than lets every row fit the window's height (16.5u of header and
     margins + 8.6u per row of tiles; --rows is set from the tile count). */
  .sky-home[data-panel="admin"]{--u:min(1vw, calc(100vh / (16.5 + var(--rows, 4) * 8.6)));height:100vh;height:100dvh;min-height:0;overflow:hidden}
  .sky-home[data-panel="admin"] .sky-header{padding:calc(.82 * var(--u)) calc(2.59 * var(--u)) 0}
  .sky-home[data-panel="admin"] .sky-header .sky-round{width:calc(3.91 * var(--u)) !important;height:calc(3.91 * var(--u)) !important;min-width:46px;min-height:46px}
  .sky-home[data-panel="admin"] .sky-round svg{width:calc(1.7 * var(--u));height:calc(1.7 * var(--u));min-width:20px;min-height:20px}
  .sky-home[data-panel="admin"] .sky-logo--lg .sky-logo__m{font-size:calc(3.03 * var(--u))}
  .sky-home[data-panel="admin"] .sky-logo--lg .sky-logo__c{font-size:calc(.95 * var(--u));margin-top:calc(.63 * var(--u));font-style:normal;font-weight:600}
  .sky-hub{position:absolute;left:0;right:0;top:calc(12.74 * var(--u));max-width:calc(77.18 * var(--u));margin:0 auto;padding:0 0 40px}
  /* flex, not grid: an unfinished last row sits centred, so the hub stays balanced */
  .sky-hub__grid{display:flex;flex-wrap:wrap;justify-content:center;gap:calc(1.45 * var(--u)) calc(1.58 * var(--u))}
  .sky-hub__grid>.sky-mini{flex:0 0 calc((100% - 3 * 1.58 * var(--u)) / 4);width:calc((100% - 3 * 1.58 * var(--u)) / 4)}
  /* Geometry only: the glass, rim, shadow and text colour are the phone's
     (Junid 12 Nov: identical tokens at every breakpoint). */
  .sky-mini{height:calc(7.12 * var(--u));min-height:0;padding:0 calc(1.2 * var(--u)) 0 calc(2.27 * var(--u));gap:calc(1.7 * var(--u));border-radius:calc(1.39 * var(--u))}
  .sky-mini__ic{width:calc(2.65 * var(--u));height:calc(2.65 * var(--u))}
  .sky-mini__ic svg{width:calc(2.65 * var(--u)) !important;height:calc(2.65 * var(--u)) !important;stroke-width:1.9}
  .sky-mini__nm{font-size:calc(1.2 * var(--u));font-weight:700;letter-spacing:-.015em;line-height:1.15;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .sky-mini__bd{position:absolute;right:calc(1.51 * var(--u));top:50%;transform:translateY(-50%);min-width:0;height:calc(1.89 * var(--u));padding:0 calc(.76 * var(--u));border-radius:999px;
    font-size:calc(1.01 * var(--u));font-weight:800}
  .sky-mini[data-corner="1"] .sky-mini__nm{overflow:visible}
  .sky-mini:has(.sky-mini__bd):not([data-corner="1"]) .sky-mini__nm{padding-right:calc(4.2 * var(--u))}
  .sky-mini[data-corner="1"] .sky-mini__bd{top:calc(.69 * var(--u));right:calc(.76 * var(--u));transform:none}
}

.sky-acct-wrap{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;align-items:flex-start;padding:calc(env(safe-area-inset-top,0px) + 74px) 14px 14px}
.sky-acct{width:min(380px,100%);border-radius:24px;padding:18px 16px 16px;color:var(--sky-ink);background:var(--sky-glass-strong)}
.sky-acct__x{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;border:1px solid #fff;background:rgba(255,255,255,.7);color:var(--sky-ink);display:grid;place-items:center;cursor:pointer}
.sky-acct__who{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.sky-acct__av{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:var(--sky-navy);color:#fff;font-weight:800;font-size:19px}
.sky-acct__nm{display:block;font-size:17px;font-weight:800}
.sky-acct__tag{display:inline-block;margin-top:3px;font-size:10px;font-weight:800;letter-spacing:.06em;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.7);border:1px solid #fff}
@media (prefers-reduced-motion:reduce){.sky-tile,.sky-mini{transition:none}.sky-tile:hover,.sky-mini:hover{transform:none}}

/* Admin panel (Junid, 7 Nov): the back button is invisible but still there —
   tap or hold the top-left corner to go Home. */
.sky-backgrid--ghost{opacity:0 !important;background:transparent !important;border-color:transparent !important;box-shadow:none !important}
.sky-backgrid--ghost:focus-visible{opacity:1 !important}
`;
