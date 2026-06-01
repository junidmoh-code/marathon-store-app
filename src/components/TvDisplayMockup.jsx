// ─── TV DISPLAY ───────────────────────────────────────────────────────────────
// Accepts optional `orders` prop (live RTDB array from App.jsx).
// When orders are provided → live mode: sections are derived from real status
// filters. When orders is absent/empty → sandbox mode: uses hardcoded sample
// data so /#tvmock still works for design iteration.

import { useEffect, useMemo, useRef, useState } from "react";
import shoebox    from "../assets/tv/shoebox.png";
import yeezy     from "../assets/tv/header-shoe.png";
import jumpman   from "../assets/tv/jumpman.png";
import aj1Chicago from "../assets/tv/aj1-chicago.png";
import aj1Green  from "../assets/tv/aj1-green.png";
import aj4Bred   from "../assets/tv/aj4-bred.png";
import aj1Yellow from "../assets/tv/aj1-yellow.png";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";

const COLORS = {
  bg:          "#0B0F1A",
  card:        "#0E1421",
  cardEdge:    "rgba(255,255,255,0.04)",
  red:         "#EF4444",
  redGlow:     "rgba(239,68,68,0.40)",
  green:       "#22C55E",
  greenGlow:   "rgba(34,197,94,0.40)",
  amber:       "#F59E0B",
  amberGlow:   "rgba(245,158,11,0.40)",
  white:       "#FFFFFF",
  mute:        "#64748B",
  hairline:    "rgba(255,255,255,0.06)",
};

// ─── ICONS ────────────────────────────────────────────────────────────────────
// Hand-rolled inline SVG so we never depend on an icon font in TV signage.
const stroke = (color, size, paths, viewBox = "0 0 24 24") => (
  <svg width={size} height={size} viewBox={viewBox} fill="none"
       stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {paths}
  </svg>
);

const BoxIcon   = ({ color, size }) => stroke(color, size, <>
  <path d="M3 7l9 -4 9 4v10l-9 4l-9 -4z"/>
  <path d="M3 7l9 4l9 -4"/>
  <path d="M12 11v10"/>
</>);

const CheckIcon = ({ color, size }) => stroke(color, size, <>
  <circle cx="12" cy="12" r="9"/>
  <path d="M8 12.5l3 3l5 -6"/>
</>);

const XIcon    = ({ color, size }) => stroke(color, size, <>
  <circle cx="12" cy="12" r="9"/>
  <path d="M9 9l6 6m0 -6l-6 6"/>
</>);

const CalIcon  = ({ color, size }) => stroke(color, size, <>
  <rect x="3" y="5" width="18" height="16" rx="2"/>
  <path d="M3 10h18M8 3v4M16 3v4"/>
</>);

const ClockIcon = ({ color, size }) => stroke(color, size, <>
  <circle cx="12" cy="12" r="9"/>
  <path d="M12 7v5l3 2"/>
</>);

// Eye with a slash through it — subtle indicator that sneaker visuals are
// hidden ("no sneakers" mode). Tapping the hidden bottom-left zone restores them.
const EyeSlashIcon = ({ color, size }) => stroke(color, size, <>
  <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
  <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
  <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
  <path d="M2 2l20 20"/>
</>);

// Brand-neutral placeholder for the Jordan jumpman position. Stylised leaping
// figure — keeps the silhouette readable at small sizes without invoking any
// real trademark. Real logo decision pending.
const LeapingFigure = ({ color = COLORS.red, size = 42 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill={color}>
    <path d="M40 6c3 0 5 2 5 5s-2 5 -5 5s-5 -2 -5 -5s2 -5 5 -5z"/>
    <path d="M48 22l-12 -2l-10 6l-8 -2l-2 6l9 4l-6 16l5 2l8 -16l4 0l8 16l5 -2l-7 -22l9 -3l-3 -3z"/>
  </svg>
);

// Brand-neutral curve for the Nike-swoosh position in each card footer. Just
// a stylised motion line — not a trademark.
const MotionMark = ({ color, size = 18 }) => (
  <svg width={size * 2} height={size} viewBox="0 0 32 16" fill="none"
       stroke={color} strokeWidth="2.5" strokeLinecap="round">
    <path d="M2 13 Q 12 4, 30 2"/>
  </svg>
);

// Side-profile sneaker silhouette. Used as both a faded backdrop element and
// the foreground featured product. Same SVG, different size + opacity.
const Sneaker = ({ size = 200, opacity = 1, accent = COLORS.red }) => (
  <svg width={size} height={size * 0.55} viewBox="0 0 320 176" fill="none"
       style={{ opacity, filter: opacity === 1 ? `drop-shadow(0 12px 20px rgba(0,0,0,0.55))` : "none" }}>
    {/* sole */}
    <path d="M8 138 Q 8 128, 28 126 L 296 126 Q 312 126, 312 138 L 312 152 Q 312 162, 300 162 L 20 162 Q 8 162, 8 152 Z"
          fill="#F8FAFC"/>
    {/* sole stripe */}
    <rect x="14" y="144" width="294" height="2" fill="#000" opacity="0.55"/>
    {/* upper main body */}
    <path d="M28 126 Q 28 70, 86 50 L 130 38 Q 188 30, 234 80 L 260 104 Q 286 116, 296 126 Z"
          fill="#111827"/>
    {/* toe cap */}
    <path d="M218 78 Q 244 70, 296 124 L 296 126 L 234 126 Q 222 116, 218 100 Z"
          fill="#F8FAFC"/>
    {/* heel collar */}
    <path d="M28 126 L 28 96 Q 40 90, 62 92 L 62 126 Z" fill="#1F2937"/>
    {/* accent swoosh-ish curve (column accent colour) */}
    <path d="M64 122 Q 138 92, 230 116" stroke={accent} strokeWidth="9" strokeLinecap="round" fill="none"/>
    {/* laces */}
    <g stroke="#E5E7EB" strokeWidth="2" strokeLinecap="round" opacity="0.85">
      <path d="M104 70 L 158 56"/>
      <path d="M110 84 L 164 70"/>
      <path d="M116 98 L 170 84"/>
      <path d="M122 112 L 176 98"/>
    </g>
    {/* tongue/eye stay highlight */}
    <path d="M90 60 Q 100 50, 142 42 L 152 56 L 100 72 Z" fill="#1F2937" opacity="0.7"/>
  </svg>
);

// ─── SECTION TEMPLATES ────────────────────────────────────────────────────────
// Static config per column. `orders` is overridden at runtime from live data.
const SECTION_TEMPLATES = [
  { id: "incoming", number: 1, title: "INCOMING ORDERS",        subtitle: "NEW ORDERS RECEIVED",
    accent: COLORS.red,   glow: COLORS.redGlow,   Icon: BoxIcon,
    orders: [101, 102, 103, 104, 105], tagline: "MORE THAN JUST SNEAKERS.",   shoeImg: aj1Chicago },
  { id: "ready",    number: 2, title: "READY",                  subtitle: "READY FOR PICKUP",
    accent: COLORS.green, glow: COLORS.greenGlow, Icon: CheckIcon,
    orders: [201, 202, 203, 204, 205], tagline: "THANK YOU FOR YOUR PATIENCE.", shoeImg: yeezy },
  { id: "oos",      number: 3, title: "OUT OF STOCK",           subtitle: "CURRENTLY UNAVAILABLE",
    accent: COLORS.red,   glow: COLORS.redGlow,   Icon: XIcon,
    orders: [301, 302, 303, 304, 305], tagline: "WE'LL RESTOCK SOON.",         shoeImg: aj4Bred  },
  { id: "tomorrow", number: 4, title: "SCHEDULED FOR TOMORROW", subtitle: "ORDERS SCHEDULED",
    accent: COLORS.amber, glow: COLORS.amberGlow, Icon: CalIcon,
    orders: [401, 402, 403, 404, 405], tagline: "SEE YOU TOMORROW!",           shoeImg: aj1Yellow },
];

// ─── SUBCOMPONENTS ────────────────────────────────────────────────────────────
function ClockCard({ now }) {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const dayName = now.toLocaleDateString("en-GB", { weekday: "short" });
  const dayNum  = now.getDate();
  const monthSh = now.toLocaleDateString("en-GB", { month: "short" });
  return (
    <div style={{
      position: "absolute", top: 0, right: 0,
      background: "rgba(20,25,40,0.85)",
      border: `1px solid ${COLORS.hairline}`,
      borderRadius: 14,
      padding: "10px 16px 10px 12px",
      display: "flex", alignItems: "center", gap: 10,
      backdropFilter: "blur(6px)",
    }}>
      <ClockIcon color={COLORS.red} size={20}/>
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
        <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: 0.5 }}>{hh}:{mm}</span>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1.4, color: COLORS.mute, marginTop: 3 }}>
          {dayName} {dayNum} {monthSh}
        </span>
      </div>
    </div>
  );
}

function NumberRow({ value, color, withNewBadge }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, lineHeight: 1 }}>
      <span style={{
        fontSize: "clamp(46px, 5.2vw, 90px)",
        fontWeight: 800, letterSpacing: "-0.025em", color,
        textShadow: withNewBadge ? `0 0 24px ${color}55` : "none",
      }}>
        {value}
      </span>
      {withNewBadge && (
        <span style={{
          background: color, color: "#0B0F1A",
          fontSize: 10, fontWeight: 900, letterSpacing: 0.8,
          padding: "3px 7px", borderRadius: 4,
          alignSelf: "flex-start", marginTop: 6,
        }}>NEW</span>
      )}
    </div>
  );
}

// ─── CRISP SVG NIKE SHOEBOX ──────────────────────────────────────────────────
// Hand-drawn 3/4 isometric view. Three faces with correct light/shadow,
// Nike swoosh + wordmark on the front, NIKE on the lid top, finger hole.
// Pure SVG — zero bitmap, crisp at any screen density.
function NikeShoeBox() {
  return (
    <svg viewBox="0 0 210 138" xmlns="http://www.w3.org/2000/svg" style={{ display:"block", overflow:"visible" }}>
      <defs>
        <linearGradient id="sbLidTop" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#FF2233"/>
          <stop offset="100%" stopColor="#D4001C"/>
        </linearGradient>
        <linearGradient id="sbFront" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#C8001A"/>
          <stop offset="100%" stopColor="#B0001A"/>
        </linearGradient>
      </defs>

      {/* Ground shadow */}
      <ellipse cx="100" cy="130" rx="82" ry="7" fill="rgba(0,0,0,0.45)"/>

      {/* Right face — deepest shadow */}
      <polygon points="138,53 172,24 172,84 138,113" fill="#7A000E"/>

      {/* Front face */}
      <polygon points="14,53 138,53 138,113 14,113" fill="url(#sbFront)"/>

      {/* Lid right wall */}
      <polygon points="138,44 172,15 172,24 138,53" fill="#9E000E"/>

      {/* Lid front wall */}
      <polygon points="11,44 138,44 138,53 11,53" fill="#D4001D"/>

      {/* Lid top face */}
      <polygon points="11,44 138,44 172,15 45,15" fill="url(#sbLidTop)"/>

      {/* Lid highlight edges */}
      <polyline points="11,44 138,44 172,15" stroke="rgba(255,255,255,0.22)" strokeWidth="0.8" fill="none"/>
      <line x1="11" y1="44" x2="45" y2="15" stroke="rgba(255,255,255,0.12)" strokeWidth="0.6"/>

      {/* Finger hole */}
      <ellipse cx="76" cy="49" rx="7" ry="4"   fill="#650010"/>
      <ellipse cx="76" cy="48" rx="5.5" ry="2.8" fill="#4E0008"/>

      {/* Bottom edge shadow */}
      <line x1="14"  y1="113" x2="138" y2="113" stroke="rgba(0,0,0,0.3)" strokeWidth="1.2"/>
      <line x1="138" y1="113" x2="172" y2="84"  stroke="rgba(0,0,0,0.3)" strokeWidth="1.2"/>

      {/* ── Front face: Nike Swoosh ── */}
      <path d="M 20 90 C 38 72, 76 66, 104 71 C 84 73, 36 88, 20 90 Z"
            fill="rgba(255,255,255,0.9)"/>

      {/* ── Front face: NIKE wordmark ── */}
      <text x="20" y="110"
            fontFamily="'Arial Black','Helvetica Neue',Arial,sans-serif"
            fontWeight="900" fontSize="18" fill="rgba(255,255,255,0.9)"
            letterSpacing="4">NIKE</text>

      {/* ── Lid top: NIKE (skewed to lie flat on the top face) ── */}
      <g transform="translate(50,18) skewX(-20) scale(1,0.52)">
        <path d="M 1 14 C 8 7, 26 4, 42 7 C 30 9, 6 13, 1 14 Z"
              fill="rgba(255,255,255,0.6)"/>
        <text x="2" y="28"
              fontFamily="'Arial Black','Helvetica Neue',Arial,sans-serif"
              fontWeight="900" fontSize="15" fill="rgba(255,255,255,0.62)"
              letterSpacing="3">NIKE</text>
      </g>
    </svg>
  );
}

// ─── SHOEBOX SCREENSAVER ──────────────────────────────────────────────────────
function ShoeboxFloat() {
  const elRef = useRef(null);
  const BOX_W = 180;
  const BOX_H = 138;

  useEffect(() => {
    const SPEED = 0.45;
    const angle = (Math.random() * 30 + 20) * (Math.PI / 180);
    const pos = {
      x: Math.random() * (window.innerWidth  * 0.4) + window.innerWidth  * 0.1,
      y: Math.random() * (window.innerHeight * 0.4) + window.innerHeight * 0.1,
      dx: SPEED * Math.cos(angle) * (Math.random() > 0.5 ? 1 : -1),
      dy: SPEED * Math.sin(angle) * (Math.random() > 0.5 ? 1 : -1),
    };
    let raf;
    const tick = () => {
      const el = elRef.current;
      if (!el) { raf = requestAnimationFrame(tick); return; }
      const W = window.innerWidth, H = window.innerHeight;
      pos.x += pos.dx; pos.y += pos.dy;
      if (pos.x <= 0)         { pos.x = 0;         pos.dx =  Math.abs(pos.dx); }
      if (pos.x >= W - BOX_W) { pos.x = W - BOX_W; pos.dx = -Math.abs(pos.dx); }
      if (pos.y <= 0)         { pos.y = 0;         pos.dy =  Math.abs(pos.dy); }
      if (pos.y >= H - BOX_H) { pos.y = H - BOX_H; pos.dy = -Math.abs(pos.dy); }
      el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={elRef} style={{
      position: "fixed", top: 0, left: 0,
      width: BOX_W, zIndex: 200,
      pointerEvents: "none", willChange: "transform",
      filter: "drop-shadow(0 14px 28px rgba(0,0,0,0.7))",
    }}>
      <img src={shoebox} alt="" width={BOX_W} style={{ display: "block", objectFit: "contain" }} />
    </div>
  );
}

// ─── SHOE CONVEYOR ────────────────────────────────────────────────────────────
// Shoe images are 1536×1024 (3:2). Displayed at height=148px → natural width
// ≈ 222px. SHOE_SLOT is that natural width + a small gap so shoes pack tightly
// on any screen — no screen-relative % sizing that creates massive gaps on
// wide TVs. Enough copies are generated at mount to fill 2× screen width so
// the loop point is always off-screen and the teleport is never visible.
// Loop: every CONVEYOR_BASE (4 shoes × SHOE_SLOT) pixels, the pattern repeats.
// Strip moves left continuously; pos += CONVEYOR_BASE (not reset to 0) so
// the sub-pixel fraction is preserved — no 1-frame jump on loop.
const CONVEYOR_SHOES = [aj1Chicago, yeezy, aj4Bred, aj1Yellow];
const CONVEYOR_SPEED = 0.7; // px per frame at 60 fps
const SHOE_SLOT      = 260; // px per shoe: ~222px natural + 38px breathing room
const CONVEYOR_BASE  = CONVEYOR_SHOES.length * SHOE_SLOT; // 4 × 260 = 1040px loop unit

function ShoeConveyor() {
  const containerRef = useRef(null);
  const stripRef     = useRef(null);
  // Enough copies to fill 2× screen width — calculated once on mount.
  const [copies, setCopies] = useState(4); // default; updated after mount

  useEffect(() => {
    const W = containerRef.current?.offsetWidth || window.innerWidth;
    // Need at least ⌈(2×W) / CONVEYOR_BASE⌉ + 1 full sets, minimum 2 sets.
    const sets = Math.max(2, Math.ceil((2 * W) / CONVEYOR_BASE) + 1);
    setCopies(sets);
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    let pos = 0;
    let raf;
    const tick = () => {
      pos -= CONVEYOR_SPEED;
      // Advance by one base unit instead of resetting to 0 — preserves the
      // sub-pixel fraction so there is never a 1-frame jump.
      if (pos <= -CONVEYOR_BASE) pos += CONVEYOR_BASE;
      el.style.transform = `translateX(${pos}px)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [copies]); // restart rAF after copies recalculate

  // Flatten: copies × 4 shoes, each src cycling through CONVEYOR_SHOES
  const shoeList = Array.from(
    { length: copies * CONVEYOR_SHOES.length },
    (_, i) => CONVEYOR_SHOES[i % CONVEYOR_SHOES.length]
  );

  return (
    <div ref={containerRef} style={{
      width: "100%", overflow: "hidden", height: 160, flexShrink: 0,
    }}>
      <div ref={stripRef} style={{
        display: "flex", flexShrink: 0,
        willChange: "transform",
      }}>
        {shoeList.map((src, i) => (
          <div key={i} style={{
            width: SHOE_SLOT, flexShrink: 0,
            height: 160,
            display: "flex", alignItems: "flex-end", justifyContent: "center",
            padding: "0 10px",
          }}>
            <img src={src} alt=""
              style={{ height: 148, width: "auto",
                       filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.8))" }}/>
          </div>
        ))}
      </div>
    </div>
  );
}

const VISIBLE_ORDERS = 5;

function Column({ section }) {
  const { Icon } = section;
  const needsScroll = section.orders.length > VISIBLE_ORDERS;
  // Duplicate list so the CSS animation loops seamlessly (scroll to -50% = back to start)
  const scrollList = needsScroll
    ? [...section.orders, ...section.orders]
    : section.orders;
  // Each row: font clamp(46px,5.2vw,90px) + 0.3vw gap ≈ 5.5vw per slot
  const visibleCount = Math.min(section.orders.length, VISIBLE_ORDERS);
  const animName = `mc-scroll-${section.id}`;
  // 2 s per order item for a comfortable read speed
  const scrollDuration = `${section.orders.length * 2}s`;

  return (
    <div style={{
      position: "relative",
      flex: "1 1 0", minWidth: 0,
      background: COLORS.card,
      border: `1px solid ${section.accent}30`,
      borderRadius: 14,
      padding: "0.7vw 1.1vw 0.5vw",
      boxShadow: `0 0 28px ${section.glow}, inset 0 1px 0 rgba(255,255,255,0.04)`,
      display: "flex", flexDirection: "column",
      overflow: "hidden",
      minHeight: 0,
    }}>
      {/* faded backdrop sneaker (decorative) */}
      <div style={{ position: "absolute", right: "-8%", top: "22%", opacity: 0.12, pointerEvents: "none" }}>
        <img src={section.shoeImg} alt="" width={340} style={{ display: "block", objectFit: "contain" }}/>
      </div>

      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, position: "relative", zIndex: 1 }}>
        <Icon color={section.accent} size={22}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "clamp(13px, 1.15vw, 19px)", fontWeight: 800, letterSpacing: 0.4, color: COLORS.white, lineHeight: 1.15 }}>
            {section.number}. {section.title}
          </div>
          <div style={{ fontSize: "clamp(9px, 0.68vw, 11px)", fontWeight: 700, letterSpacing: 1.4, color: section.accent, marginTop: 4 }}>
            {section.subtitle}
          </div>
        </div>
      </div>

      {/* accent hairline */}
      <div style={{
        height: 1, marginTop: "0.35vw", marginBottom: "0.45vw",
        background: `linear-gradient(90deg, ${section.accent}, transparent)`,
      }}/>

      {/* numbers stack — static up to 8, continuous scroll beyond */}
      {needsScroll && (
        <style>{`
          @keyframes ${animName} {
            0%   { transform: translateY(0); }
            100% { transform: translateY(-50%); }
          }
        `}</style>
      )}
      <div style={{
        position: "relative", zIndex: 1,
        height: `calc(${visibleCount} * (clamp(46px, 5.2vw, 90px) + 0.3vw))`,
        overflow: "hidden",
      }}>
        <div style={{
          display: "flex", flexDirection: "column", gap: "0.3vw",
          ...(needsScroll && {
            animation: `${animName} ${scrollDuration} linear infinite`,
          }),
        }}>
          {scrollList.map((n, i) => {
            const posInOriginal = i % section.orders.length;
            return (
              <NumberRow
                key={i}
                value={n}
                color={posInOriginal === 0 ? section.accent : COLORS.white}
                withNewBadge={posInOriginal === 0}
              />
            );
          })}
        </div>
      </div>

      {/* flex spacer so tagline stays pinned to the bottom */}
      <div style={{ flex: 1 }}/>

      {/* footer: tagline + small marks */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginTop: "0.3vw", position: "relative", zIndex: 1,
      }}>
        <div style={{ fontSize: "clamp(8px, 0.6vw, 10px)", fontWeight: 700, letterSpacing: 1.4, color: COLORS.white }}>
          {section.tagline}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.85 }}>
          <LeapingFigure color={section.accent} size={14}/>
          <MotionMark color={section.accent} size={11}/>
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
// localStorage key for the sneaker-visibility preference (persists across TV
// refreshes). Default (key absent) → sneakers shown.
const SNEAKERS_LS_KEY = "mc_tv_sneakers";

// Status values mirror App.jsx STATUS constants (no import needed — strings).
const STATUS_MAP = {
  incoming: "incoming",
  ready:    "ready",
  oos:      "out_of_stock",
  tomorrow: "coming_tomorrow",
};

export default function TvDisplayMockup({ orders: liveProp }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  // Sneaker visuals (sliding conveyor, header shoe, floating shoebox) can be
  // toggled off via a hidden bottom-left tap zone. Preference persists in
  // localStorage so a TV refresh remembers the last state. Default: shown.
  const [sneakersOn, setSneakersOn] = useState(() => {
    try { return localStorage.getItem(SNEAKERS_LS_KEY) !== "off"; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(SNEAKERS_LS_KEY, sneakersOn ? "on" : "off"); }
    catch { /* storage unavailable — toggle still works for the session */ }
  }, [sneakersOn]);

  // Derive live sections when real orders are provided; fall back to sample data.
  const SECTIONS = useMemo(() => {
    const live = liveProp && liveProp.length > 0;
    return SECTION_TEMPLATES.map(tmpl => ({
      ...tmpl,
      orders: live
        ? liveProp
            .filter(o => o.status === STATUS_MAP[tmpl.id])
            .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
            .map(o => o.id)
        : tmpl.orders,
    }));
  }, [liveProp]);

  return (
    <>
    <link rel="preconnect" href="https://fonts.googleapis.com"/>
    <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap" rel="stylesheet"/>
    <div style={{
      minHeight: "100vh", width: "100%",
      background: COLORS.bg,
      color: COLORS.white,
      fontFamily: FONT,
      padding: "0.6vw 1.4vw 0.4vw",
      boxSizing: "border-box",
      display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* HEADER */}
      <header style={{ position: "relative", display: "flex", alignItems: "center", paddingRight: 140 }}>
        {/* Jumpman: mix-blend-mode:screen makes the black background transparent
            on the dark navy canvas (screen: black+bg=bg, red+bg≈red) */}
        <img
          src={jumpman}
          alt="Jordan"
          width={80}
          height={80}
          style={{ width: 80, height: 80, objectFit: "contain", mixBlendMode: "screen" }}
        />
        <div style={{
          flex: 1, textAlign: "center",
          fontFamily: "'Bebas Neue', 'Arial Black', Impact, sans-serif",
          fontSize: "clamp(52px, 6.5vw, 110px)",
          fontWeight: 400,
          letterSpacing: "0.22em",
          lineHeight: 1,
          color: "#FFFFFF",
          textShadow: "0 0 32px rgba(239,68,68,0.45), 0 3px 8px rgba(0,0,0,0.9)",
        }}>
          MARATHON
        </div>
        {/* fixed-width slot stays reserved either way so the header never shifts */}
        <div style={{ width: 110, display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
          <img src={aj1Green} alt="" width={110}
               style={{ objectFit: "contain", filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.6))",
                        visibility: sneakersOn ? "visible" : "hidden" }}/>
        </div>
        <ClockCard now={now}/>
      </header>

      {/* COLUMNS */}
      <main style={{ display: "flex", gap: "0.9vw", flex: 1, minHeight: 0, marginTop: "0.35vw" }}>
        {SECTIONS.map((s) => <Column key={s.id} section={s}/>)}
      </main>

      {/* SHOE CONVEYOR — keep an equal-height spacer when hidden so the column
          area below the main grid never grows/shifts. */}
      {sneakersOn ? <ShoeConveyor /> : <div style={{ height: 160, flexShrink: 0 }} />}

      {/* SHOEBOX SCREENSAVER — position:fixed, so omitting it has no layout impact */}
      {sneakersOn && <ShoeboxFloat />}

      {/* FOOTER */}
      <footer style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
        marginTop: "0.25vw",
        color: COLORS.red,
        fontSize: "clamp(11px, 0.85vw, 14px)", fontWeight: 800, letterSpacing: 5,
      }}>
        <Sneaker size={22} accent={COLORS.red}/>
        <span>MARATHON. KEEP MOVING.</span>
      </footer>

      {/* Hidden ~60×60 tap/click zone in the bottom-left corner. Single tap
          toggles sneaker visuals. Invisible by default; when sneakers are
          hidden it shows a small, subtle eye-slash so staff know the mode is
          active and where to tap to restore. */}
      <button
        type="button"
        onClick={() => setSneakersOn(v => !v)}
        aria-label={sneakersOn ? "Hide sneakers" : "Show sneakers"}
        title={sneakersOn ? "Hide sneakers" : "Show sneakers"}
        style={{
          position: "fixed", left: 0, bottom: 0,
          width: 60, height: 60,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", zIndex: 300,
          WebkitTapHighlightColor: "transparent",
          background: "transparent", border: 0, padding: 0,
        }}
      >
        {!sneakersOn && (
          <EyeSlashIcon color="rgba(255,255,255,0.28)" size={20}/>
        )}
      </button>
    </div>
    </>
  );
}
