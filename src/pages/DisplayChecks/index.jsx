// ─── DISPLAY CHECKS — MODULE SHELL (PR 1, scaffold only) ──────────────────────
// The clickable skeleton of the Display Check module for the clothing department.
// It renders the four-tab frame (Today / Availability / Analytics / Settings) and
// an empty state for each. NOTHING here reads or writes data: no RTDB listener,
// no get(), no callable, no Cloud Function. A later PR fills each tab in.
//
// Every access decision comes from src/config/displayChecks.js — there are NO
// inline role/permission checks in this file. Manager-only tabs (Analytics,
// Settings) are gated by canManageDisplayChecks(user, store); today that is
// super-admin-only because the permission isn't seeded yet.
//
// STORE SCOPE: super-admin gets a store toggle over the enabled stores (the feeds
// run separately — this is a switcher, never a merge). A store-scoped staff user
// is pinned to their own store. The store in view is what the manager gate is
// evaluated against, so a trophy manager can never see marathon-pe analytics.
//
// STYLING: Marathon Glass — pitch-black glossy ground, frosted panels, electric
// blue accents. Anything the SYSTEM recorded is ledger type: monospace, uppercase,
// wide tracking (per §9 of the design). Human copy stays in the normal sans.

import { useEffect, useMemo, useState } from "react";
import { usePermissions } from "../../components/PermissionsContext";
import { SHOP_LABELS } from "../../utils/stores";
import {
  DISPLAY_CHECKS_STORE_FLAGS,
  canManageDisplayChecks,
  isDisplayChecksSuperAdmin,
} from "../../config/displayChecks";

// ── Marathon Glass tokens ─────────────────────────────────────────────────────
const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const BLUE = "#4A7FFF";
const BLUE_SOFT = "#6A9FFF";
const INK = "#f3f6ff";
const GLASS_BG = "rgba(255,255,255,.03)";
const GLASS_BORDER = "1px solid rgba(74,127,255,.16)";

const PANEL = {
  background: GLASS_BG,
  border: GLASS_BORDER,
  borderRadius: 16,
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
};

// Ledger metadata — monospace, uppercase, wide tracking. The cold register.
const META = {
  fontFamily: MONO,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: "rgba(233,238,255,.45)",
  fontSize: 11,
};

// The four tabs. `manager: true` → only rendered when canManageDisplayChecks.
const TABS = [
  { key: "today", label: "Today", manager: false },
  { key: "availability", label: "Availability", manager: false },
  { key: "analytics", label: "Analytics", manager: true },
  { key: "settings", label: "Settings", manager: true },
];

// Stores enabled for the module, in a stable order, with display labels.
const ENABLED_STORES = Object.keys(DISPLAY_CHECKS_STORE_FLAGS)
  .filter((id) => DISPLAY_CHECKS_STORE_FLAGS[id] === true)
  .map((id) => ({ id, label: SHOP_LABELS[id] || id }));

// A second-resolution wall clock for the on-duty strip. Machines don't forget —
// timestamps read to the second (§9.4). Presentational only; no data.
function useTick() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ── On-duty identity strip (§8.3) — a fact, not a warning ─────────────────────
// The dot carries the design's specified slow pulse; the clock ticks to the
// second (ledger precision, §8.4). Presentational only.
function OnDutyStrip({ name }) {
  const now = useTick();
  const clock = now.toLocaleTimeString("en-GB", { hour12: false });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, ...META, color: "rgba(233,238,255,.6)" }}>
      <style>{`@keyframes dcPulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: BLUE,
                     boxShadow: `0 0 8px ${BLUE}`, display: "inline-block",
                     animation: "dcPulse 2.6s ease-in-out infinite" }} />
      <span style={{ fontVariantNumeric: "tabular-nums" }}>ON DUTY · {(name || "—").toUpperCase()} · {clock}</span>
    </div>
  );
}

// ── Empty-state panel — same frosted card for every dark tab ──────────────────
function EmptyState({ title, line }) {
  return (
    <div style={{ ...PANEL, padding: "48px 28px", textAlign: "center",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <div style={{ ...META, color: BLUE_SOFT }}>NO DATA YET</div>
      <div style={{ fontFamily: FONT, fontSize: 17, fontWeight: 650, color: INK }}>{title}</div>
      <div style={{ fontFamily: FONT, fontSize: 13.5, color: "rgba(233,238,255,.5)", maxWidth: 420, lineHeight: 1.5 }}>
        {line}
      </div>
    </div>
  );
}

const TAB_EMPTY = {
  today: {
    title: "No display checks yet",
    line: "When a clothing item sells, a check will appear here for the person on duty to confirm the display. Nothing is being tracked yet — this is the shell.",
  },
  availability: {
    title: "Availability is not wired up yet",
    line: "Scan, barcode and name lookup against live stock will live here. No lookups run in this build.",
  },
  analytics: {
    title: "Analytics are not wired up yet",
    line: "Completion times, repeat rates, marks and chronically-out products will be summarised here for managers.",
  },
  settings: {
    title: "Settings are not wired up yet",
    line: "The weekly roster (draft → lock), cover-for-a-day, wake delay, repeat window and close time will live here.",
  },
};

export default function DisplayChecks({ onExit }) {
  const { user, permRecord } = usePermissions();

  // Build the plain gate-user once: auth email (trusted identity) + the
  // /users record fields. All gating flows through config/displayChecks.
  const gateUser = useMemo(() => ({
    email: user?.email,
    permissions: permRecord?.permissions,
    destShop: permRecord?.destShop,
  }), [user?.email, permRecord?.permissions, permRecord?.destShop]);

  const isSuper = isDisplayChecksSuperAdmin(gateUser);

  // Store in view: super-admin toggles across enabled stores; a scoped staff
  // user is pinned to their own store.
  const [superStore, setSuperStore] = useState(ENABLED_STORES[0]?.id || null);
  const store = isSuper ? superStore : (permRecord?.destShop || null);
  const storeLabel = SHOP_LABELS[store] || store || "—";

  const canManage = canManageDisplayChecks(gateUser, store);
  const visibleTabs = TABS.filter((t) => !t.manager || canManage);

  const [tab, setTab] = useState("today");
  // If the store toggle lands on a store the viewer can't manage, a manager tab
  // could be selected but hidden — fall back to Today so the frame never blanks.
  useEffect(() => {
    const t = TABS.find((x) => x.key === tab);
    if (t?.manager && !canManage) setTab("today");
  }, [tab, canManage]);

  const displayName = permRecord?.displayName || permRecord?.username
    || user?.email?.split("@")[0] || "Staff";
  const empty = TAB_EMPTY[tab] || TAB_EMPTY.today;

  return (
    <div style={{ minHeight: "100vh", background: "#000", color: INK, fontFamily: FONT,
                  position: "relative", overflowX: "hidden" }}>
      {/* Glossy ground glow */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none",
                    background: "radial-gradient(1100px 520px at 82% -14%, rgba(74,127,255,.12), transparent 58%)" }} />

      <div style={{ position: "relative", maxWidth: 1040, margin: "0 auto", padding: "20px 16px 40px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" onClick={onExit}
                    style={{ ...META, background: "none", border: "none", cursor: "pointer",
                             color: "rgba(233,238,255,.45)", padding: "6px 12px 6px 0",
                             margin: "-6px 0", textAlign: "left" }}>
              ‹ BACK
            </button>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.01em" }}>Display Checks</div>
            <OnDutyStrip name={displayName} />
          </div>
          <div style={{ ...META, textAlign: "right", paddingTop: 22 }}>
            <div>{storeLabel.toUpperCase()}</div>
          </div>
        </div>

        {/* Store toggle — super-admin only, a switcher (never a merge) */}
        {isSuper && ENABLED_STORES.length > 1 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {ENABLED_STORES.map((s) => {
              const on = s.id === store;
              return (
                <button key={s.id} type="button" onClick={() => setSuperStore(s.id)}
                        style={{ ...META, letterSpacing: "0.1em", cursor: "pointer",
                                 padding: "7px 13px", borderRadius: 999,
                                 background: on ? "rgba(74,127,255,.18)" : GLASS_BG,
                                 border: on ? `1px solid ${BLUE}` : GLASS_BORDER,
                                 color: on ? BLUE_SOFT : "rgba(233,238,255,.5)" }}>
                  {s.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Tab bar — horizontally scrollable so four tabs never clip on a phone */}
        <div style={{ display: "flex", gap: 4, marginBottom: 18, borderBottom: "1px solid rgba(255,255,255,.06)",
                      overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {visibleTabs.map((t) => {
            const on = t.key === tab;
            return (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                      style={{ fontFamily: FONT, fontSize: 14, fontWeight: 650, cursor: "pointer",
                               background: "none", border: "none", padding: "10px 14px",
                               flexShrink: 0, whiteSpace: "nowrap",
                               color: on ? INK : "rgba(233,238,255,.4)",
                               borderBottom: on ? `2px solid ${BLUE}` : "2px solid transparent",
                               marginBottom: -1 }}>
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Tab body — empty states only in this build */}
        <EmptyState title={empty.title} line={empty.line} />

        <div style={{ ...META, marginTop: 22, textAlign: "center", color: "rgba(233,238,255,.28)" }}>
          RECORDED · SHELL BUILD · NO DATA READ OR WRITTEN
        </div>
      </div>
    </div>
  );
}
