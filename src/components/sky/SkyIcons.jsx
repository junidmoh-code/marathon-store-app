// ─── SKY ICONS — the outline icon set the references use ────────────────────
// One stroke weight, round caps, currentColor. Drawn to sit on glass in white.

const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };

export const IconGrid = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="2" /><rect x="14" y="3.5" width="6.5" height="6.5" rx="2" />
    <rect x="3.5" y="14" width="6.5" height="6.5" rx="2" /><rect x="14" y="14" width="6.5" height="6.5" rx="2" />
  </svg>
);
export const IconUser = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="12" cy="8.2" r="4" /><path d="M4.5 20.5c1.2-3.6 4.2-5.6 7.5-5.6s6.3 2 7.5 5.6" />
  </svg>
);
export const IconUserCircle = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="10" r="3.4" /><path d="M5.8 18.6c1.4-2.4 3.6-3.6 6.2-3.6s4.8 1.2 6.2 3.6" />
  </svg>
);
export const IconSearch = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><circle cx="10.8" cy="10.8" r="7" /><path d="M16 16l4.6 4.6" /></svg>
);
export const IconFilter = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" />
  </svg>
);
export const IconCamera = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.4-2h5l1.4 2h1.6A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
    <circle cx="12" cy="12.3" r="3.6" />
  </svg>
);
export const IconCart = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M2.5 3.5h2.6l2.4 11.2a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.2l1.6-7.3H6.2" /><circle cx="9.5" cy="20" r="1.5" /><circle cx="17.5" cy="20" r="1.5" />
  </svg>
);
export const IconPlus = (p) => (
  <svg viewBox="0 0 24 24" {...base} strokeWidth={2.6} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconBag = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M5.2 8.5h13.6l-1 11a1.8 1.8 0 0 1-1.8 1.6H8a1.8 1.8 0 0 1-1.8-1.6z" /><path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3" /><path d="M8 8.5h8" />
  </svg>
);
export const IconBox = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 2.8l8.2 4.3v9.8L12 21.2l-8.2-4.3V7.1z" /><path d="M3.8 7.1L12 11.4l8.2-4.3M12 11.4v9.8" />
  </svg>
);
export const IconMonitorCheck = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <rect x="2.8" y="3.8" width="18.4" height="12.4" rx="1.8" /><path d="M8.8 10.1l2.3 2.3 4.3-4.6M12 16.2v3.4M8 20h8" />
  </svg>
);
export const IconLayersShield = (p) => (
  <svg viewBox="0 0 26 24" {...base} {...p}>
    <path d="M11 2.8L20 7.2l-9 4.4-9-4.4z" /><path d="M2 11.4l9 4.4 3-1.5" /><path d="M2 15.6l9 4.4 3-1.5" />
    <path d="M19.5 11.6l4 1.5v3.2c0 2.6-1.7 4.3-4 5.1-2.3-.8-4-2.5-4-5.1v-3.2z" /><path d="M17.9 16.5l1.2 1.2 2.1-2.3" />
  </svg>
);
export const IconLayers = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 3l9 4.5-9 4.5-9-4.5z" /><path d="M3 12l9 4.5 9-4.5" /><path d="M3 16.5L12 21l9-4.5" />
  </svg>
);
export const IconChevronLeft = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><path d="M15 5l-7 7 7 7" /></svg>
);
export const IconClose = (p) => (
  <svg viewBox="0 0 24 24" {...base} strokeWidth={2.2} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconMore = (p) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}><circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" /></svg>
);
export const IconExpand = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
);
