// ─── TV QUEUE BOARD ───────────────────────────────────────────────────────────
// The customer pickup board on the store TVs (#tv kiosk, ?section=1#tv, and the
// in-app DISPLAY role). DISPLAY-ONLY: it draws the `orders` it is handed and
// writes nothing. Everything about WHICH orders appear — refill carts dropped,
// the Hub 2 hold, the 8-min ready/out-of-stock and 15-min tomorrow auto-clear,
// layby pulls — is decided upstream in App.jsx's TvWithAutoCollect, and the
// bandwidth-scoped listener (useTvOrders' key range) is upstream of that. This
// file is the look: a 1920×1080 stage — concrete wall, warm window light, four
// glass columns — scaled to whatever the TV's viewport is, never scrolling.
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
import { buildBoard, clockText, dateText } from "./tv/queueBoardRows";
import { DEMO_BOARD, isDemoMode } from "./tv/queueBoardDemo";

const STAGE_W = 1920;
const STAGE_H = 1080;

const FONT_BODY    = "'Archivo', 'Helvetica Neue', Arial, sans-serif";
const FONT_DISPLAY = "'Oswald', 'Arial Narrow', 'Helvetica Neue', sans-serif";

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

function Row({ row, column }) {
  return (
    <div className="qb-row">
      <span className="qb-num" style={{ fontSize: numberSize(row.number) }}>{row.number}</span>
      <span className="qb-meta">
        {column.marker === "clock"
          ? <ClockIcon color={COLORS.soft} size={22} />
          : <span className="qb-dot" style={{ background: column.accent, boxShadow: `0 0 10px ${column.accent}88` }} />}
        <span className="qb-meta-text">{row.meta}</span>
      </span>
      <Chevron color={COLORS.soft} />
    </div>
  );
}

function Column({ column, data }) {
  const { Icon } = column;
  return (
    <section className="qb-col" aria-label={column.title}>
      <header className="qb-col-head">
        <Icon color={column.accent} size={50} strokeWidth={1.6} />
        <div className="qb-col-titles">
          <div className="qb-col-title">{column.title}</div>
          <div className="qb-col-sub">{column.subtitle}</div>
        </div>
        <div className="qb-col-count">{data.total}</div>
      </header>
      <div className="qb-rule" style={{ background: column.accent, boxShadow: `0 0 14px ${column.accent}66` }} />
      <div className="qb-rows">
        {data.rows.map((row) => <Row key={row.key} row={row} column={column} />)}
      </div>
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

// Fit the fixed 1920×1080 stage into the viewport (letterboxed, never scrolling).
function useStageScale() {
  const read = () => (typeof window === "undefined"
    ? 1
    : Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));
  const [scale, setScale] = useState(read);
  useEffect(() => {
    const onResize = () => setScale(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return scale;
}

// RTDB's own `.info/connected` — client-side metadata, no download, no rules.
// The SDK reports false before its first handshake and on every blip, so a drop
// only turns the footer red once it has lasted RECONNECT_GRACE_MS; until the
// first answer it says "Connecting".
const RECONNECT_GRACE_MS = 3000;
export function useRtdbConnected() {
  const [connected, setConnected] = useState(null);
  useEffect(() => {
    let timer = null;
    const unsub = onValue(ref(database, ".info/connected"), (snap) => {
      clearTimeout(timer);
      if (snap.val() === true) { setConnected(true); return; }
      timer = setTimeout(() => setConnected(false), RECONNECT_GRACE_MS);
    }, () => setConnected(false));
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

export default function TvDisplayMockup({ orders, specials, onExit }) {
  const scale = useStageScale();

  // "2h ago" ages against server time; re-derived every 30 s.
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  useEffect(() => {
    const t = setInterval(() => setNowMs(serverNowMs()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ?demo=1 draws the mockup's dummy orders instead of the live ones. Read once
  // per page load; it changes nothing but what is drawn.
  const [demo] = useState(() => isDemoMode());
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

  const hasSpecials = !!(specials && specials.length > 0);

  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600;700;800&family=Oswald:wght@300;400&display=swap" rel="stylesheet" />
      <style>{BOARD_CSS}</style>
      <div className="qb-viewport">
        <div className="qb-wall" aria-hidden="true">
          <div className="qb-wall-texture" />
          <div className="qb-wall-seams" />
          <div className="qb-window" />
          <div className="qb-sun" />
          <div className="qb-beams" />
          <div className="qb-strip" />
          <div className="qb-floor" />
        </div>

        <div
          className="qb-stage"
          style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
        >
          <header className="qb-brand">
            <div className="qb-brand-word">MARATHON</div>
            <div className="qb-brand-sub">STORE<span className="qb-brand-gap" />OPERATIONS</div>
          </header>
          <BoardClock />

          <main className="qb-cols">
            {COLUMNS.map((c) => <Column key={c.id} column={c} data={board[c.id]} />)}
          </main>

          <footer className="qb-footer">
            <span className="qb-footer-brand">MARATHON</span>
            {demo && <span className="qb-demo">DEMO</span>}
            <span className="qb-footer-line" />
            <ConnectionStatus connected={connected} />
          </footer>

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
// One stylesheet, all class names prefixed qb- (queue board). The wall is pure
// CSS (no image download on a kiosk that reloads on every deploy).
const NOISE_SVG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='260' height='260'>" +
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/>" +
  "<feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.47  0 0 0 0 0.44  0 0 0 0.55 0'/></filter>" +
  "<rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

const BOARD_CSS = `
.qb-viewport {
  position: fixed; inset: 0; overflow: hidden;
  background: #14110f; color: ${COLORS.text};
  font-family: ${FONT_BODY};
  -webkit-font-smoothing: antialiased;
}
.qb-wall { position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  background:
    radial-gradient(ellipse 70% 60% at 50% 12%, rgba(84,74,64,0.55), transparent 70%),
    linear-gradient(180deg, #36302a 0%, #2b2622 40%, #211d1a 72%, #171412 100%);
}
.qb-wall-texture { position: absolute; inset: 0; background-image: ${NOISE_SVG};
  background-size: 260px 260px; opacity: 0.55; mix-blend-mode: overlay; }
.qb-wall-seams { position: absolute; left: 0; right: 0; top: 0; height: 84%;
  background:
    repeating-linear-gradient(90deg, transparent 0 calc(12.5% - 2px), rgba(0,0,0,0.28) calc(12.5% - 2px) calc(12.5% - 1px), rgba(255,235,210,0.05) calc(12.5% - 1px) 12.5%),
    repeating-linear-gradient(180deg, transparent 0 calc(33.3% - 2px), rgba(0,0,0,0.18) calc(33.3% - 2px) 33.3%);
}
.qb-window { position: absolute; left: 0; top: 0; bottom: 14%; width: 5.2%;
  background:
    linear-gradient(90deg, rgba(10,9,8,0.9) 0 10%, transparent 10% 86%, rgba(10,9,8,0.92) 86%),
    linear-gradient(180deg, rgba(255,214,150,0.55), rgba(150,140,80,0.35) 45%, rgba(70,72,40,0.45));
  filter: blur(1px);
}
.qb-sun { position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 55% 70% at 8% 18%, rgba(255,196,128,0.34), transparent 65%),
    radial-gradient(ellipse 40% 50% at 30% 0%, rgba(255,210,150,0.18), transparent 70%);
}
.qb-beams { position: absolute; left: -10%; top: -20%; width: 80%; height: 120%;
  background: repeating-linear-gradient(118deg,
    transparent 0 70px, rgba(255,205,145,0.16) 70px 150px, transparent 150px 190px,
    rgba(255,205,145,0.10) 190px 230px, transparent 230px 320px);
  -webkit-mask-image: radial-gradient(ellipse 60% 55% at 30% 35%, #000 20%, transparent 75%);
          mask-image: radial-gradient(ellipse 60% 55% at 30% 35%, #000 20%, transparent 75%);
  filter: blur(8px);
}
.qb-strip { position: absolute; right: 2.6%; top: 0; bottom: 13%; width: 5px;
  background: linear-gradient(180deg, rgba(255,224,170,0.95), rgba(255,200,130,0.75));
  box-shadow: 0 0 18px 6px rgba(255,190,110,0.45), 0 0 70px 24px rgba(255,170,90,0.18);
  border-radius: 3px;
}
.qb-floor { position: absolute; left: 0; right: 0; bottom: 0; height: 14%;
  background:
    repeating-linear-gradient(90deg, transparent 0 7%, rgba(255,214,160,0.07) 7% 8%, transparent 8% 12.5%),
    linear-gradient(180deg, #3a332c 0%, #241f1b 30%, #15120f 100%);
  box-shadow: inset 0 2px 0 rgba(255,220,180,0.10);
}
.qb-floor::after { content: ""; position: absolute; inset: 0;
  background: radial-gradient(ellipse 60% 120% at 50% 0%, rgba(255,215,160,0.12), transparent 70%); }

.qb-stage { position: absolute; left: 50%; top: 50%; width: ${STAGE_W}px; height: ${STAGE_H}px;
  transform-origin: 50% 50%; }

.qb-brand { position: absolute; left: 0; right: 0; top: 46px; text-align: center; }
.qb-brand-word { font-family: ${FONT_DISPLAY}; font-weight: 400; font-size: 92px; line-height: 1.05;
  letter-spacing: 46px; padding-left: 46px; color: #FFF6E8;
  text-shadow: 0 0 2px rgba(255,244,226,0.9), 0 0 18px rgba(255,214,160,0.65),
               0 0 44px rgba(255,170,90,0.38), 0 0 90px rgba(255,150,70,0.18); }
.qb-brand-sub { margin-top: 16px; font-family: ${FONT_BODY}; font-weight: 500; font-size: 17px;
  letter-spacing: 15px; padding-left: 15px; color: rgba(255,246,232,0.88);
  text-shadow: 0 0 10px rgba(255,200,140,0.25); }
.qb-brand-gap { display: inline-block; width: 22px; }

.qb-clock { position: absolute; right: 158px; top: 78px; text-align: right; }
.qb-clock-time { font-family: ${FONT_BODY}; font-weight: 300; font-size: 60px; line-height: 1;
  letter-spacing: 1px; color: #FBF7F1; font-variant-numeric: tabular-nums; }
.qb-clock-date { margin-top: 12px; font-size: 13px; font-weight: 600; letter-spacing: 3px;
  color: rgba(251,247,241,0.82); }

.qb-cols { position: absolute; left: 101px; top: 220px; width: 1732px; height: 655px;
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.qb-col { position: relative; min-width: 0; border-radius: 6px; padding: 32px 26px 0;
  background: linear-gradient(180deg, rgba(92,86,80,0.36) 0%, rgba(58,54,50,0.42) 55%, rgba(44,41,38,0.48) 100%);
  border: 1px solid rgba(255,244,230,0.24);
  box-shadow: 0 34px 70px rgba(0,0,0,0.42), 0 6px 18px rgba(0,0,0,0.25),
              inset 0 1px 0 rgba(255,255,255,0.20), inset 0 0 40px rgba(255,236,210,0.04);
  -webkit-backdrop-filter: blur(16px) saturate(115%);
          backdrop-filter: blur(16px) saturate(115%);
  overflow: hidden; }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .qb-col { background: linear-gradient(180deg, rgba(70,65,60,0.86), rgba(42,39,36,0.9)); }
}
.qb-col::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(125deg, rgba(255,236,210,0.10) 0%, transparent 38%); }
.qb-col-head { position: relative; display: flex; align-items: center; gap: 20px; height: 62px; padding: 0 4px; }
.qb-col-head svg { flex-shrink: 0; }
.qb-col-titles { flex: 1; min-width: 0; }
.qb-col-title { font-weight: 700; font-size: 18.5px; letter-spacing: 0.6px; line-height: 1.15; white-space: nowrap;
  color: #FBF7F1; }
.qb-col-sub { margin-top: 9px; font-weight: 500; font-size: 11.5px; letter-spacing: 2.6px; white-space: nowrap;
  color: ${COLORS.soft}; }
.qb-col-count { font-weight: 500; font-size: 46px; line-height: 1; color: #FBF7F1;
  font-variant-numeric: tabular-nums; padding-left: 6px; }
.qb-rule { height: 3px; margin: 26px 0 6px; border-radius: 2px; }
.qb-rows { position: relative; }
.qb-row { height: 90px; display: flex; align-items: center; gap: 14px; padding: 0 6px 0 8px;
  border-bottom: 1px solid rgba(255,244,230,0.12); }
.qb-num { flex: 1; min-width: 0; font-weight: 800; letter-spacing: -0.5px; line-height: 1;
  color: #FFFFFF; white-space: nowrap; overflow: hidden; text-overflow: clip;
  text-shadow: 0 2px 12px rgba(0,0,0,0.35); }
.qb-meta { display: flex; align-items: center; gap: 14px; width: 118px; flex-shrink: 0; }
.qb-meta svg { flex-shrink: 0; }
.qb-meta-text { font-weight: 500; font-size: 16.5px; color: ${COLORS.soft}; white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.qb-dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }

.qb-footer { position: absolute; left: 101px; top: 883px; width: 1732px; height: 52px;
  display: flex; align-items: center; gap: 22px; padding: 0 32px 0 18px; box-sizing: border-box;
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(255,240,220,0.06), rgba(255,240,220,0.02));
  border-top: 1px solid rgba(255,240,220,0.10); }
.qb-footer-brand { font-weight: 500; font-size: 13px; letter-spacing: 6px; color: rgba(251,247,241,0.85); }
.qb-demo { font-size: 11px; font-weight: 700; letter-spacing: 3px; color: ${COLORS.amber};
  border: 1px solid ${COLORS.amber}88; border-radius: 3px; padding: 3px 7px 3px 10px; }
.qb-footer-line { flex: 1; height: 1px; background: rgba(255,244,230,0.28); }
.qb-conn { display: flex; align-items: center; gap: 12px; font-size: 14px; font-weight: 500;
  color: rgba(251,247,241,0.88); white-space: nowrap; }

/* The rail is a fixed 160 px band; the floor under the footer is 140 px, so it
   is drawn at 7/8 size (a 2194 px-wide band scaled to exactly the stage width). */
.qb-specials { position: absolute; left: 0; right: 0; top: ${STAGE_H - 140}px; height: 140px; overflow: hidden; }
.qb-specials-inner { width: ${Math.round(STAGE_W * 8 / 7)}px; transform: scale(0.875); transform-origin: 0 0; }

.qb-exit { position: fixed; right: 14px; top: 14px; width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 300;
  transition: opacity .3s; -webkit-tap-highlight-color: transparent;
  background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.35); padding: 0;
  color: #fff; font-size: 20px; line-height: 1; font-weight: 300; }
`;
