// ─── TV QUEUE BOARD ───────────────────────────────────────────────────────────
// The customer pickup board on the store TVs (#tv kiosk, ?section=1#tv, and the
// in-app DISPLAY role). DISPLAY-ONLY: it draws the `orders` it is handed and
// writes nothing. Everything about WHICH orders appear — refill carts dropped,
// the Hub 2 hold, the 8-min ready/out-of-stock and 15-min tomorrow auto-clear,
// layby pulls — is decided upstream in App.jsx's TvWithAutoCollect, and the
// bandwidth-scoped listener (useTvOrders' key range) is upstream of that. This
// file is the look: a 1920×1080 stage — Junid's concrete-wall photo with its lit
// MARATHON sign, four glass columns with lit rims — scaled to whatever the TV's
// viewport is, never scrolling.
//
// Columns: Incoming (incoming) · Ready for pickup (ready) · Out of stock
// (out_of_stock) · Scheduled for tomorrow (coming_tomorrow — the warehouse's
// existing "available tomorrow" outcome). Five newest rows each; the count is the
// column's full total. Row shaping lives in ./tv/queueBoardRows.js.

import { useEffect, useMemo, useState } from "react";
import { onValue, ref } from "firebase/database";
import { database } from "../firebase";
import TvSpecialsRail from "./TvSpecialsRail";
import TvAdOverlay from "./TvAdOverlay";
import { serverNowMs } from "../utils/serverTime";
import { buildBoard, clockText, dateText, pageRows } from "./tv/queueBoardRows";
import { DEMO_BOARD, isDemoMode } from "./tv/queueBoardDemo";
import { useTvPromo, tvPromoMode } from "../utils/tvPromo";
import { useTvBackgrounds, pickTvBackground, photosForDay, johannesburgDay } from "../utils/tvBackgrounds";
import { tvBackgroundCache } from "./tv/tvBackgroundCache";
// The wall: Junid's sneaker-room photo (Nike box walls, the reader in the
// middle), 1920×1080. It carries no sign, so the lit MARATHON / STORE
// OPERATIONS sign is drawn on top, and the photo is dimmed so the glass and
// the white numbers read. The earlier concrete wall (queue-wall.jpg) stays in
// assets but is no longer imported.
import wallPhoto from "../assets/tv/queue-wall-sneakers.jpg";
const WALL_DIM = "linear-gradient(180deg, rgba(8,6,6,0.5) 0%, rgba(8,6,6,0.18) 40%, rgba(8,6,6,0.28) 100%)";

const STAGE_W = 1920;
const STAGE_H = 1080;
const PAGE_MS = 8000;

const FONT_BODY    = "'Archivo', 'Helvetica Neue', Arial, sans-serif";

const COLORS = {
  red:   "#E5484D",
  green: "#3DD68C",
  amber: "#F2B33D",
  cream: "#E8D3B0",
  text:  "#F7F3EE",
  soft:  "rgba(247,243,238,0.72)",
  faint: "rgba(247,243,238,0.5)",
};

// ─── ICONS ────────────────────────────────────────────────────────────────────
// Inline outline SVG — no icon font on TV signage.
const Outline = ({ color, size, strokeWidth = 1.7, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
       strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const BoxIcon = (p) => (
  <Outline {...p}>
    <path d="M12 2.8l8.2 4.1v10.2L12 21.2l-8.2-4.1V6.9z" />
    <path d="M3.8 6.9L12 11l8.2-4.1" />
    <path d="M12 11v10.2" />
  </Outline>
);
const CheckCircleIcon = (p) => (
  <Outline {...p}>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M7.8 12.3l2.9 2.9 5.6-6" />
  </Outline>
);
const AlertCircleIcon = (p) => (
  <Outline {...p}>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M12 7.2v6.2" />
    <path d="M12 16.6v.2" />
  </Outline>
);
const CalendarIcon = (p) => (
  <Outline {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Outline>
);
const ClockIcon = (p) => (
  <Outline {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3 2" />
  </Outline>
);
const Chevron = ({ color }) => (
  <Outline color={color} size={22} strokeWidth={1.8}>
    <path d="M9.5 6l6 6-6 6" />
  </Outline>
);

// ─── COLUMNS ──────────────────────────────────────────────────────────────────
const COLUMNS = [
  { id: "incoming", title: "INCOMING ORDERS",        subtitle: "NEW ORDERS RECEIVED",  accent: COLORS.red,   Icon: BoxIcon,         marker: "dot" },
  { id: "ready",    title: "READY FOR PICKUP",       subtitle: "READY FOR COLLECTION", accent: COLORS.green, Icon: CheckCircleIcon, marker: "dot" },
  { id: "oos",      title: "OUT OF STOCK",           subtitle: "CURRENTLY UNAVAILABLE",accent: COLORS.amber, Icon: AlertCircleIcon, marker: "dot" },
  { id: "tomorrow", title: "SCHEDULED FOR TOMORROW", subtitle: "ORDERS SCHEDULED",     accent: COLORS.cream, Icon: CalendarIcon,    marker: "clock" },
];

// Order numbers are 3 digits ("071") or a layby ("L-366"); an unusually long
// layby number steps the type down instead of colliding with the time.
function numberSize(n) {
  const len = String(n).length;
  if (len <= 5) return 62;
  if (len === 6) return 54;
  return 46;
}

function Row({ row, column, index, live }) {
  return (
    <div className="qb-row" style={{ animationDelay: `${index * 70}ms` }}>
      <span className="qb-num" style={{ fontSize: numberSize(row.number) }}>{row.number}</span>
      <span className="qb-meta">
        {column.marker === "clock"
          ? <ClockIcon color={COLORS.soft} size={22} />
          : <span className={live ? "qb-dot qb-dot-live" : "qb-dot"}
                  style={{ background: column.accent, boxShadow: `0 0 10px ${column.accent}aa`, color: column.accent }} />}
        <span className="qb-meta-text">{row.meta}</span>
      </span>
      <Chevron color={COLORS.soft} />
    </div>
  );
}

function Column({ column, data, pageTick }) {
  const { Icon } = column;
  const { page, pages, rows } = pageRows(data, pageTick);
  return (
    <section className="qb-col" aria-label={column.title}
             style={{ "--qb-i": COLUMNS.indexOf(column), "--qb-accent": column.accent }}>
      <header className="qb-col-head">
        <Icon color={column.accent} size={52} strokeWidth={1.5} />
        <div className="qb-col-titles">
          <div className="qb-col-title">{column.title}</div>
          <div className="qb-col-sub">{column.subtitle}</div>
        </div>
        <div className="qb-col-count">{data.total}</div>
      </header>
      <div className="qb-rule" style={{ background: column.accent, boxShadow: `0 0 16px ${column.accent}88, 0 0 3px ${column.accent}` }} />
      <div className="qb-rows">
        {rows.map((row, i) => (
          <Row key={row.key} row={row} column={column} index={i} live={page === 0 && i === 0} />
        ))}
      </div>
      {pages > 1 && (
        <div className="qb-pages" aria-hidden="true">
          {Array.from({ length: pages }, (_, i) => (
            <span key={i} className="qb-page-dot"
                  style={i === page ? { background: column.accent, boxShadow: `0 0 8px ${column.accent}88` } : null} />
          ))}
        </div>
      )}
    </section>
  );
}

// Clock in its own component with its own 1 s tick, so the minute flips on time
// without re-rendering the four glass columns every second. Server-corrected
// (serverNowMs), shown in SAST, so a TV with a wrong clock or timezone still
// shows the store's time.
function BoardClock() {
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  useEffect(() => {
    const t = setInterval(() => setNowMs(serverNowMs()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="qb-clock">
      <div className="qb-clock-time">{clockText(nowMs)}</div>
      <div className="qb-clock-date">{dateText(nowMs)}</div>
    </div>
  );
}

// How big to draw the 1920×1080 stage (photo + board, scaled TOGETHER so the
// photo's sign always sits above the columns). As big as "cover" — the photo
// filling the screen edge to edge — but never so big that the board itself is
// cut off: the content (columns, footer, clock) spans x 101…1833 and y 50…940,
// i.e. at most 873 px from the centre sideways, 490 px up. On a 16:9 TV, and
// on a moderately wider or taller window, that IS cover (full bleed); only an
// extreme shape (a portrait window) leaves a gap, filled by the blurred wall.
// When a special is running its band sits on the floor down to the stage's
// bottom edge (y 1080), so the vertical bound becomes the full half-height and
// the band is never cropped (CodeRabbit, PR #722).
export function stageScale(vw, vh, withSpecials = false) {
  const cover = Math.max(vw / STAGE_W, vh / STAGE_H);
  const halfH = withSpecials ? STAGE_H / 2 : 500;
  return Math.min(cover, vw / (2 * 880), vh / (2 * halfH));
}
function useStageScale(withSpecials) {
  const read = () => (typeof window === "undefined"
    ? 1
    : stageScale(window.innerWidth, window.innerHeight, withSpecials));
  const [scale, setScale] = useState(read);
  useEffect(() => {
    const onResize = () => setScale(read());
    onResize();                                  // re-read when specials come or go
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withSpecials]);
  return scale;
}

// RTDB's own `.info/connected` — client-side metadata, no download, no rules.
// The SDK answers false before its first handshake as well as on a drop, so:
//  • until the first true the footer says "Connecting" — red only if a boot
//    has gone BOOT_GRACE_MS without ever connecting (slow store link);
//  • after that, a drop turns it red once it has lasted RECONNECT_GRACE_MS, so
//    a blip never flashes red at customers.
const RECONNECT_GRACE_MS = 3000;
const BOOT_GRACE_MS = 15000;
export function useRtdbConnected() {
  const [connected, setConnected] = useState(null);
  useEffect(() => {
    let everConnected = false;
    let timer = setTimeout(() => setConnected(false), BOOT_GRACE_MS);
    const unsub = onValue(ref(database, ".info/connected"), (snap) => {
      if (snap.val() === true) {
        clearTimeout(timer);
        everConnected = true;
        setConnected(true);
        return;
      }
      if (!everConnected) return;            // still booting — the boot timer stands
      clearTimeout(timer);
      timer = setTimeout(() => setConnected(false), RECONNECT_GRACE_MS);
    }, () => { clearTimeout(timer); setConnected(false); });
    return () => { clearTimeout(timer); unsub(); };
  }, []);
  return connected;
}

function ConnectionStatus({ connected }) {
  const color = connected === true ? COLORS.green : connected === false ? COLORS.red : COLORS.faint;
  const label = connected === true ? "System connected" : connected === false ? "Reconnecting" : "Connecting";
  return (
    <span className="qb-conn" data-connected={String(connected)}>
      <span className="qb-dot" style={{ background: color, boxShadow: `0 0 10px ${color}aa` }} />
      {label}
    </span>
  );
}

// Junid's Black Friday teaser: two black barrier tapes crossing the floor, the
// words scrolling in opposite directions. Each strip is six identical units
// and slides exactly one unit (a sixth of itself) per loop, so the seam never
// shows whatever width the font lands at. Six, not five: at the far end of a
// loop the strip is still five units long, which outruns the 2400 px band in
// both scroll directions with a unit to spare.
function BlackFridayTape() {
  const strip = Array.from({ length: 6 }, (_, i) => (
    <span className="qb-tape-unit" key={i}><b>BLACK FRIDAY</b><i>COMING SOON</i></span>
  ));
  return (
    <div className="qb-tape" role="img" aria-label="Black Friday coming soon">
      <div className="qb-tape-band qb-tape-back"><div className="qb-tape-strip">{strip}</div></div>
      <div className="qb-tape-band qb-tape-front"><div className="qb-tape-strip">{strip}</div></div>
    </div>
  );
}

// The wall behind the glass: the photo the TV Ad card picked (/settings/
// tvBackgrounds — one default, or a rotation on server time so every TV
// agrees) from TODAY's pool (Johannesburg day), else the built-in sneaker
// room. Rotation is checked every 5 s; a still photo re-checks every minute so
// the pool still turns over at midnight.
//
// Today's photos are downloaded once into Cache Storage (tvBackgroundCache)
// and drawn from there, so rotating, a new day or a new upload never
// re-downloads a photo the TV already holds; photos removed in the Workshop are
// dropped from the cache. The only listener is the small metadata node.
function useBoardBackground() {
  const cfg = useTvBackgrounds();
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  const rotating = cfg?.mode === "rotate" && cfg.photos.length > 1;
  useEffect(() => {
    const t = setInterval(() => setNowMs(serverNowMs()), rotating ? 5000 : 60_000);
    return () => clearInterval(t);
  }, [rotating]);
  const picked = cfg ? pickTvBackground(cfg, nowMs) : null;
  const day = johannesburgDay(nowMs);
  const todayKey = cfg ? photosForDay(cfg, day).map((p) => p.url).join("\n") : "";
  const allKey = cfg ? cfg.photos.map((p) => p.url).join("\n") : "";

  useEffect(() => {
    if (!cfg) return;
    const cache = tvBackgroundCache();
    const today = todayKey ? todayKey.split("\n") : [];
    cache.prune(allKey ? allKey.split("\n") : []).catch(() => {}).then(() => cache.prefetch(today));
  }, [todayKey, allKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [drawn, setDrawn] = useState(null); // { url, src } — src is the cached blob: URL
  const pickedUrl = picked?.url || "";
  useEffect(() => {
    if (!pickedUrl) return undefined;
    let live = true;
    tvBackgroundCache().resolve(pickedUrl).then((src) => { if (live) setDrawn({ url: pickedUrl, src }); });
    return () => { live = false; };
  }, [pickedUrl]);
  if (!pickedUrl) return wallPhoto;
  // Until the pick resolves, keep what is on screen (no flash of an uncached URL).
  return drawn?.url === pickedUrl ? drawn.src : (drawn?.src || wallPhoto);
}

// Two layers only (a TV has little memory to spare for full-HD photos): the
// photo on screen, and the next one fading in over it. The next photo is
// loaded BEFORE it starts to fade, so a change is a 1.5 s crossfade and never a
// flash of half-loaded image; a photo that fails to load is skipped and the
// current one stays.
function BoardBackground({ url }) {
  const [layers, setLayers] = useState(() => ({ under: null, top: url }));
  useEffect(() => {
    if (url === layers.top) return undefined;
    let cancelled = false;
    const img = new Image();
    img.onload = () => { if (!cancelled) setLayers((l) => ({ under: l.top, top: url })); };
    img.src = url;
    return () => { cancelled = true; img.onload = null; };
  }, [url, layers.top]);
  return (
    <div className="qb-bg" aria-hidden="true">
      {layers.under && <div key={`u:${layers.under}`} className="qb-bg-photo" style={{ backgroundImage: `url(${layers.under})` }} />}
      <div key={`t:${layers.top}`} className="qb-bg-photo qb-bg-in" style={{ backgroundImage: `url(${layers.top})` }} />
      <div className="qb-bg-dim" />
    </div>
  );
}

export default function TvDisplayMockup({ orders, specials, onExit }) {
  const hasSpecials = !!(specials && specials.length > 0);
  const scale = useStageScale(hasSpecials);
  const backgroundUrl = useBoardBackground();

  // "2h ago" ages against server time; re-derived every 30 s.
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  useEffect(() => {
    const t = setInterval(() => setNowMs(serverNowMs()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ?demo=1 draws the mockup's dummy orders instead of the live ones. Read once
  // per page load; it changes nothing but what is drawn.
  const [demo] = useState(() => isDemoMode());
  // The promo banner (TV Ad card → TV promo banner: the built-in Black Friday
  // tape, an uploaded photo, or off) runs across the floor where the footer
  // sits, so while it is up the connection status moves under the clock.
  const promo = useTvPromo();
  const promoMode = tvPromoMode(promo, nowMs);
  // Busy columns page through every order, a page of five every PAGE_MS.
  const [pageTick, setPageTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPageTick((n) => n + 1), PAGE_MS);
    return () => clearInterval(t);
  }, []);

  const board = useMemo(
    () => (demo ? DEMO_BOARD : buildBoard(orders || [], nowMs)),
    [demo, orders, nowMs]
  );
  const connected = useRtdbConnected();

  // Exit TV mode: drop out of browser fullscreen if we're in it, then leave the TV
  // view (onExit clears the #tv hash / returns to the picker). Reachable by the
  // discreet ✕ in the top-right corner (below) AND by the Esc key.
  const exitTv = () => {
    if (!onExit) return;
    try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch { /* ignore */ }
    onExit();
  };
  useEffect(() => {
    if (!onExit) return;
    const onKey = (e) => { if (e.key === "Escape") exitTv(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onExit]);

  // Exit ✕ is INVISIBLE at rest (customer-facing board) and fades in only while the
  // cursor moves. The click target stays live regardless.
  const [exitVisible, setExitVisible] = useState(false);
  useEffect(() => {
    if (!onExit) return;
    let timer;
    const onMove = () => {
      setExitVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setExitVisible(false), 2500);
    };
    window.addEventListener("mousemove", onMove);
    return () => { clearTimeout(timer); window.removeEventListener("mousemove", onMove); };
  }, [onExit]);

  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,300..800&display=swap" rel="stylesheet" />
      <style>{BOARD_CSS}</style>
      <div className="qb-viewport">
        {/* Only visible on an extreme screen shape (see stageScale): the same
            wall, blurred, filling whatever the stage does not cover. */}
        <div className="qb-wall" aria-hidden="true" style={{ backgroundImage: `url(${backgroundUrl})` }} />

        <div
          className="qb-stage"
          style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
        >
          <BoardBackground url={backgroundUrl} />
          {/* The sign is part of the photo; this heading is for screen readers. */}
          <h1 className="qb-sign">
            <span className="qb-sign-main">MARATHON</span>
            <span className="qb-sign-sub">STORE OPERATIONS</span>
          </h1>
          <BoardClock />

          <main className="qb-cols">
            {COLUMNS.map((c) => <Column key={c.id} column={c} data={board[c.id]} pageTick={pageTick} />)}
          </main>

          {promoMode ? (
            <>
              <div className="qb-status-top">
                {demo && <span className="qb-demo">DEMO</span>}
                <ConnectionStatus connected={connected} />
              </div>
              {promoMode === "photo"
                ? <div className="qb-promo-photo" role="img" aria-label={promo.name || "Promotion"}
                    style={{ backgroundImage: `url(${promo.photoUrl})` }} />
                : <BlackFridayTape />}
            </>
          ) : (
            <footer className="qb-footer">
              <span className="qb-footer-brand">MARATHON</span>
              {demo && <span className="qb-demo">DEMO</span>}
              <span className="qb-footer-line" />
              <ConnectionStatus connected={connected} />
            </footer>
          )}

          {/* Specials advertising, when any is running, sits on the floor band
              under the board — content, so it shows whenever /specials has one.
              With none, the floor is just floor. */}
          {hasSpecials && (
            <div className="qb-specials">
              <div className="qb-specials-inner">
                <TvSpecialsRail specials={specials} />
              </div>
            </div>
          )}
        </div>

        {/* Outside the scaled stage: position:fixed inside a transformed parent
            would be pinned to the stage, not the screen. */}
        {onExit && (
          <button
            type="button"
            onClick={exitTv}
            aria-label="Exit TV display"
            title="Exit TV display (Esc)"
            className="qb-exit"
            style={{ opacity: exitVisible ? 0.95 : 0 }}
          >
            <span>✕</span>
          </button>
        )}
        <TvAdOverlay />
      </div>
    </>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
// One stylesheet, all class names prefixed qb- (queue board). The wall is the
// photo on the stage itself, so the glass sits on exactly the light it was
// designed against. Motion is slow and transform/opacity-only (compositor work,
// no layout), and stops entirely under prefers-reduced-motion.
const BOARD_CSS = `
.qb-viewport {
  position: fixed; inset: 0; overflow: hidden;
  background: #120f0d; color: ${COLORS.text};
  font-family: ${FONT_BODY};
  -webkit-font-smoothing: antialiased;
}
.qb-bg { position: absolute; inset: 0; overflow: hidden; }
.qb-bg-photo { position: absolute; inset: 0; background-size: cover; background-position: center; background-repeat: no-repeat; }
.qb-bg-in { animation: qb-bg-in 1.5s ease both; }
@keyframes qb-bg-in { from { opacity: 0; } to { opacity: 1; } }
.qb-bg-dim { position: absolute; inset: 0; background: ${WALL_DIM}; }
.qb-wall { position: absolute; inset: -40px; background-size: cover; background-position: center; background-repeat: no-repeat;
  filter: blur(28px) brightness(0.5); }
.qb-sign { position: absolute; left: 0; right: 0; top: 46px; margin: 0; text-align: center; pointer-events: none; }
.qb-sign-main { display: block; padding-left: 0.46em; font-family: ${FONT_BODY}; font-weight: 500; font-stretch: 88%;
  font-size: 80px; line-height: 1; letter-spacing: 0.46em; color: #FFF6EA;
  text-shadow: 0 0 4px rgba(255,236,206,0.95), 0 0 14px rgba(255,196,122,0.85), 0 0 32px rgba(240,150,70,0.6),
               0 0 70px rgba(220,128,56,0.4); }
.qb-sign-sub { display: block; margin-top: 24px; padding-left: 1.1em; font-family: ${FONT_BODY}; font-weight: 400;
  font-size: 18px; letter-spacing: 1.1em; color: rgba(255,246,234,0.92); text-shadow: 0 0 10px rgba(255,200,140,0.5); }
.qb-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: 0; }

/* Glass: Apple-style clear glass. The wall stays visible through each panel,
   blurred and neutral (colour held near 0.8 so the sunlight doesn't turn
   orange); a faint white lift at the top, and a dark veil inside (Junid: not
   washed-out white) keeps it deep and the white text crisp. Tuned side
   by side against the mockup. */
.qb-stage {
  --qb-neon: 0 0 0 2px rgba(255,222,176,0.95), 0 0 4px 2px rgba(255,196,122,0.85),
             0 0 12px 3px rgba(255,176,96,0.72), 0 0 26px 5px rgba(240,150,70,0.55),
             0 0 50px 8px rgba(220,128,56,0.36), 0 0 95px 14px rgba(200,112,46,0.18);
  --qb-neon-soft: 0 0 0 1px rgba(255,210,148,0.70), 0 0 6px rgba(255,186,110,0.45),
             0 0 18px rgba(240,150,70,0.28), 0 0 40px rgba(220,128,56,0.14); }
.qb-stage { --qb-blur: 4px; --qb-sat: 1.05; --qb-bri: 0.9;
  --qb-glass-top: rgba(255,255,255,0.10); --qb-glass-mid: rgba(255,255,255,0.03); --qb-glass-bot: rgba(255,255,255,0.02);
  --qb-frost: rgba(14,13,12,0.12); }
.qb-stage { position: absolute; left: 50%; top: 50%; width: ${STAGE_W}px; height: ${STAGE_H}px;
  transform-origin: 50% 50%; background-size: ${STAGE_W}px ${STAGE_H}px; background-repeat: no-repeat; }

.qb-clock { position: absolute; right: 152px; top: 64px; text-align: right; }
.qb-clock-time { font-family: ${FONT_BODY}; font-weight: 300; font-size: 60px; line-height: 1;
  letter-spacing: 1px; color: #FBF7F1; font-variant-numeric: tabular-nums;
  text-shadow: 0 0 18px rgba(255,220,180,0.25), 0 2px 10px rgba(0,0,0,0.35); }
.qb-clock-date { margin-top: 13px; font-size: 13px; font-weight: 600; letter-spacing: 3px;
  color: rgba(251,247,241,0.86); text-shadow: 0 1px 6px rgba(0,0,0,0.4); }

/* ── Glass columns ─────────────────────────────────────────────────────────── */
.qb-cols { position: absolute; left: 101px; top: 220px; width: 1732px; height: 655px;
  display: grid; grid-template-columns: 1fr 1fr 44px 1fr 1fr; gap: 12px; }
/* A window between Ready and Out of stock, so the reader in the photo shows. */
.qb-cols > .qb-col:nth-child(3) { grid-column: 4; }
.qb-cols > .qb-col:nth-child(4) { grid-column: 5; }
.qb-col { position: relative; min-width: 0; border-radius: 6px; padding: 32px 24px 0;
  background:
    linear-gradient(180deg, rgba(255,250,244,0.05) 0%, rgba(255,250,244,0) 14%),
    linear-gradient(var(--qb-frost), var(--qb-frost)),
    linear-gradient(170deg, var(--qb-glass-top) 0%, var(--qb-glass-mid) 40%, var(--qb-glass-bot) 100%);
  -webkit-backdrop-filter: blur(var(--qb-blur)) saturate(var(--qb-sat)) brightness(var(--qb-bri));
          backdrop-filter: blur(var(--qb-blur)) saturate(var(--qb-sat)) brightness(var(--qb-bri));
  /* Neon edge, lit like the MARATHON sign above it: the GOLDEN light the sign
     reads as (its tube is white-hot up close, but the eye sees gold) — a gold
     line with an amber halo. */
  box-shadow: var(--qb-neon),
    0 40px 80px rgba(0,0,0,0.45),
    inset 0 0 2px rgba(255,214,156,0.55),
    inset 0 0 12px rgba(255,180,100,0.28),
    inset 0 0 30px rgba(230,140,60,0.12);
  overflow: hidden; isolation: isolate; }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .qb-col { background: linear-gradient(162deg, rgba(92,84,76,0.9), rgba(34,31,29,0.94)); }
}
/* Lit rim: a gradient border, brightest on the top-left edges facing the window. */
.qb-col::after { content: ""; position: absolute; inset: 0; border-radius: 6px; padding: 2px; pointer-events: none;
  background: rgba(255,224,180,0.96);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  animation: qb-rim 7s ease-in-out infinite; animation-delay: calc(var(--qb-i) * -1.6s); }
/* Light sweeping across the glass, staggered column to column. */
.qb-col::before { content: ""; position: absolute; top: -30%; bottom: -30%; left: -70%; width: 45%; pointer-events: none;
  background: linear-gradient(100deg, transparent 0%, rgba(255,232,200,0.0) 20%, rgba(255,232,200,0.10) 50%, rgba(255,232,200,0) 80%, transparent 100%);
  transform: translateX(0) rotate(14deg); z-index: 0;
  animation: qb-sheen 12s ease-in-out infinite; animation-delay: calc(var(--qb-i) * 1.1s); }
@keyframes qb-rim   { 0%, 100% { opacity: 0.88; } 50% { opacity: 1; } }
@keyframes qb-sheen { 0% { transform: translateX(0) rotate(14deg); } 55%, 100% { transform: translateX(560%) rotate(14deg); } }

.qb-col-head { position: relative; z-index: 1; display: flex; align-items: center; gap: 14px; height: 62px; padding: 0 4px; }
.qb-col-head svg { flex-shrink: 0; filter: drop-shadow(0 0 8px var(--qb-accent)); }
.qb-col-titles { flex: 1; min-width: 0; }
.qb-col-title { font-weight: 700; font-size: 18px; letter-spacing: 0.2px; font-stretch: 80%; line-height: 1.15; white-space: nowrap;
  overflow: hidden; text-overflow: clip; color: #FBF7F1; }
.qb-col-sub { margin-top: 10px; font-weight: 500; font-size: 12px; letter-spacing: 2.6px; font-stretch: 92%; white-space: nowrap;
  overflow: hidden; text-overflow: clip; color: ${COLORS.soft}; }
.qb-col-count { font-weight: 600; font-size: 50px; line-height: 1; color: #FBF7F1;
  font-variant-numeric: tabular-nums; padding-left: 4px; flex-shrink: 0;
  text-shadow: 0 0 16px rgba(255,236,214,0.25); }
.qb-rule { position: relative; z-index: 1; height: 3px; margin: 26px 0 6px; border-radius: 2px; overflow: hidden; }
.qb-rule::after { content: ""; position: absolute; top: 0; bottom: 0; left: -30%; width: 30%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.75), transparent);
  animation: qb-rule 6s ease-in-out infinite; animation-delay: calc(var(--qb-i) * 0.9s); }
@keyframes qb-rule { 0% { transform: translateX(0); } 45%, 100% { transform: translateX(440%); } }

.qb-rows { position: relative; z-index: 1; }
.qb-row { height: 90px; display: flex; align-items: center; gap: 14px; padding: 0 6px 0 8px;
  border-bottom: 1px solid rgba(255,244,230,0.13);
  animation: qb-row-in 0.6s cubic-bezier(.2,.7,.2,1) both; }
@keyframes qb-row-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.qb-num { flex: 1; min-width: 0; font-weight: 800; letter-spacing: -0.5px; line-height: 1;
  color: #FFFFFF; white-space: nowrap; overflow: hidden; text-overflow: clip;
  text-shadow: 0 0 22px rgba(255,236,214,0.18), 0 2px 12px rgba(0,0,0,0.4); }
.qb-meta { display: flex; align-items: center; gap: 14px; width: 118px; flex-shrink: 0; }
.qb-meta svg { flex-shrink: 0; }
.qb-meta-text { font-weight: 500; font-size: 16.5px; color: ${COLORS.soft}; white-space: nowrap;
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 6px rgba(0,0,0,0.55); }
.qb-dot { position: relative; display: inline-block; width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }
/* The newest order's dot breathes a ring outward. */
.qb-dot-live::after { content: ""; position: absolute; inset: -1px; border-radius: 50%;
  border: 2px solid currentColor; opacity: 0; animation: qb-ping 2.4s ease-out infinite; }
@keyframes qb-ping { 0% { transform: scale(1); opacity: 0.8; } 80%, 100% { transform: scale(2.8); opacity: 0; } }

.qb-pages { position: absolute; z-index: 1; left: 0; right: 0; bottom: 22px; display: flex; justify-content: center; gap: 10px; }
.qb-page-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,244,230,0.25); transition: background .4s; }

/* ── Footer ledge ──────────────────────────────────────────────────────────── */
.qb-footer { position: absolute; left: 101px; top: 884px; width: 1732px; height: 50px;
  display: flex; align-items: center; gap: 22px; padding: 0 32px 0 20px; box-sizing: border-box;
  border-radius: 5px;
  background: linear-gradient(180deg, rgba(120,110,100,0.30), rgba(40,36,33,0.42));
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  box-shadow: var(--qb-neon-soft), 0 20px 40px rgba(0,0,0,0.35),
              inset 0 0 10px rgba(255,180,100,0.16); }
.qb-footer-brand { font-weight: 500; font-size: 13px; letter-spacing: 6px; color: rgba(251,247,241,0.88); }
.qb-footer-line { flex: 1; height: 1px; background: linear-gradient(90deg, rgba(255,244,230,0.35), rgba(255,244,230,0.18)); }
.qb-conn { display: flex; align-items: center; gap: 12px; font-size: 14px; font-weight: 500;
  color: rgba(251,247,241,0.9); white-space: nowrap; }
.qb-demo { font-size: 11px; font-weight: 700; letter-spacing: 3px; color: ${COLORS.amber};
  border: 1px solid ${COLORS.amber}88; border-radius: 3px; padding: 3px 7px 3px 10px; }

/* ── Black Friday tape ─────────────────────────────────────────────────────
   Glossy black vinyl, wider than the stage so both ends run off the screen,
   crossing just under the fifth row. Drawn after the columns (over their
   bottom edge, like tape stuck across the glass) and before the specials rail. */
/* An uploaded banner sits in the tape's place: the floor band under the
   fifth row, as wide as fits. A wide image (about 1920×300) fills it edge to
   edge; transparent PNGs keep their transparency. */
.qb-promo-photo { position: absolute; left: 0; right: 0; top: 780px; bottom: 0; pointer-events: none;
  background-size: contain; background-position: center; background-repeat: no-repeat;
  filter: drop-shadow(0 18px 28px rgba(0,0,0,0.55)); }
.qb-status-top { position: absolute; right: 152px; top: 168px; display: flex; align-items: center; gap: 14px; }
.qb-status-top .qb-conn { font-size: 13px; color: rgba(251,247,241,0.8); text-shadow: 0 1px 6px rgba(0,0,0,0.4); }
.qb-tape { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.qb-tape-band { position: absolute; left: -240px; width: ${STAGE_W + 480}px; height: 78px; top: 868px;
  overflow: hidden; transform-origin: 50% 50%;
  background: linear-gradient(180deg, #3b3b3d 0%, #141415 8%, #060606 42%, #000 68%, #131314 92%, #2e2e30 100%);
  box-shadow: 0 22px 34px rgba(0,0,0,0.6), 0 5px 10px rgba(0,0,0,0.55),
              inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -1px 0 rgba(255,255,255,0.12); }
.qb-tape-band::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 30%),
              linear-gradient(97deg, rgba(255,255,255,0) 34%, rgba(255,255,255,0.09) 46%, rgba(255,255,255,0) 58%); }
.qb-tape-front { transform: rotate(4.2deg); }
.qb-tape-back  { transform: rotate(-4.2deg); filter: brightness(0.82); }
.qb-tape-strip { display: flex; align-items: center; height: 100%; width: max-content;
  animation: qb-tape-run 18s linear infinite; will-change: transform; }
.qb-tape-back .qb-tape-strip { animation-direction: reverse; }
.qb-tape-unit { flex: none; display: flex; align-items: center; gap: 34px; padding: 0 17px;
  font-family: ${FONT_BODY}; font-weight: 800; font-stretch: 62%; font-size: 52px; line-height: 1;
  letter-spacing: 0.5px; white-space: nowrap; }
.qb-tape-unit b { font-weight: 800; color: #FAFAFA; }
.qb-tape-unit i { font-style: normal; color: #E3141B; }
@keyframes qb-tape-run { from { transform: translateX(0); } to { transform: translateX(calc(-100% / 6)); } }

/* The rail is a fixed 160 px band; the floor under the footer is 140 px, so it
   is drawn at 7/8 size (a 2194 px-wide band scaled to exactly the stage width). */
.qb-specials { position: absolute; left: 0; right: 0; top: ${STAGE_H - 140}px; height: 140px; overflow: hidden; }
.qb-specials-inner { width: ${Math.round(STAGE_W * 8 / 7)}px; transform: scale(0.875); transform-origin: 0 0; }

.qb-exit { position: fixed; right: 14px; top: 14px; width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 300;
  transition: opacity .3s; -webkit-tap-highlight-color: transparent;
  background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.35); padding: 0;
  color: #fff; font-size: 20px; line-height: 1; font-weight: 300; }

@media (prefers-reduced-motion: reduce) {
  .qb-col::before, .qb-rule::after, .qb-dot-live::after { animation: none; display: none; }
  .qb-col::after, .qb-row, .qb-tape-strip, .qb-bg-in { animation: none; }
}
`;
