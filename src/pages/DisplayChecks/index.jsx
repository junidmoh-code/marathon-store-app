// ─── DISPLAY CHECKS — MODULE SHELL ────────────────────────────────────────────
// The four-tab frame (Today / Availability / Analytics / Settings). Desktop
// (≥1024px) gets an AI-Studio sidebar; phone keeps the single-column floor
// layout. Manager tabs (Analytics, Settings) are gated by canManageDisplayChecks
// (super-admin today). Store scope: super-admin toggles enabled stores; scoped
// staff are pinned to their own store.
//
// NAVIGATION-STABLE STATE (fix, 2026-07-21). Three things used to destroy state:
//   1. tab switch — the old ternary UNMOUNTED the inactive tab (Today's listener
//      with it), so returning re-subscribed from empty.
//   2. rotation — the layout used to be TWO separate return trees (desktop vs
//      mobile); crossing the 1024 breakpoint remounted the whole content subtree.
//   3. leave/return — the module itself unmounts on route change.
// Fixes, all here: (a) ONE lifted feed listener for the module, passed to Today
// AND Analytics as props — a tab switch never detaches or duplicates it; (b) ONE
// layout tree — the sidebar and mobile chrome toggle by `display`, the content
// column keeps a stable tree position so a rotation never remounts the tabs;
// (c) all visible tab bodies stay MOUNTED (display-toggled), and tab / search /
// scroll / a last-feed snapshot live in [[session]] (dcSession) which outlives
// the module's mount, so leave/return rehydrates exactly where the user was.
// Net listener churn is LOWER than before, never higher.
//
// STYLING: Marathon Glass — pitch-black ground, frosted panels, electric blue.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePermissions } from "../../components/PermissionsContext";
import { SHOP_LABELS } from "../../utils/stores";
import {
  DISPLAY_CHECKS_STORE_FLAGS,
  canManageDisplayChecks,
  isDisplayChecksSuperAdmin,
} from "../../config/displayChecks";
import { FONT, BLUE, BLUE_SOFT, INK, GLASS_BG, GLASS_BORDER, META } from "./tokens";
import TodayView from "./TodayView";
import AvailabilityView from "./AvailabilityView";
import AnalyticsView from "./AnalyticsView";
import SettingsView from "./SettingsView";
import { useTodayFeedSources } from "./useDisplayChecks";
import { dcSession, resetDcSession } from "./session";

const TABS = [
  { key: "today", label: "Today", manager: false },
  { key: "availability", label: "Availability", manager: false },
  { key: "analytics", label: "Analytics", manager: true },
  { key: "settings", label: "Settings", manager: true },
];

const ENABLED_STORES = Object.keys(DISPLAY_CHECKS_STORE_FLAGS)
  .filter((id) => DISPLAY_CHECKS_STORE_FLAGS[id] === true)
  .map((id) => ({ id, label: SHOP_LABELS[id] || id }));

// A second-resolution wall clock for the on-duty strip (§9.4). Presentational.
function useTick() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function OnDutyStrip({ name }) {
  const now = useTick();
  const clock = now.toLocaleTimeString("en-GB", { hour12: false });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, ...META, color: "rgba(233,238,255,.6)" }}>
      <style>{`@keyframes dcPulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: BLUE, boxShadow: `0 0 8px ${BLUE}`, display: "inline-block", animation: "dcPulse 2.6s ease-in-out infinite" }} />
      <span style={{ fontVariantNumeric: "tabular-nums" }}>ON DUTY · {(name || "—").toUpperCase()} · {clock}</span>
    </div>
  );
}

function OnDutyLine() {
  const now = useTick();
  return (
    <span style={{ display: "block", ...META, fontSize: 9.5, color: "rgba(233,238,255,.45)", marginTop: 1, fontVariantNumeric: "tabular-nums" }}>
      ON DUTY · {now.toLocaleTimeString("en-GB", { hour12: false })}
    </span>
  );
}

// Reacts to resize/rotate via matchMedia. Only the CHROME keys off this now — the
// content column is outside the wide/narrow branch, so a breakpoint cross swaps
// the sidebar for the mobile bar without remounting any tab body.
function useIsWide(px = 1024) {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(`(min-width:${px}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width:${px}px)`);
    const on = (e) => setWide(e.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on));
  }, [px]);
  return wide;
}

export default function DisplayChecks({ onExit, products }) {
  const { user, permRecord } = usePermissions();

  const gateUser = useMemo(() => ({
    email: user?.email,
    permissions: permRecord?.permissions,
    destShop: permRecord?.destShop,
  }), [user?.email, permRecord?.permissions, permRecord?.destShop]);

  const isSuper = isDisplayChecksSuperAdmin(gateUser);
  const [superStore, setSuperStore] = useState(ENABLED_STORES[0]?.id || null);
  const store = isSuper ? superStore : (permRecord?.destShop || null);
  const storeLabel = SHOP_LABELS[store] || store || "—";
  const canManage = canManageDisplayChecks(gateUser, store);
  const visibleTabs = TABS.filter((t) => !t.manager || canManage);
  const displayName = permRecord?.displayName || permRecord?.username || user?.email?.split("@")[0] || "Staff";
  const wide = useIsWide(1024);

  // Wipe the session singleton when the signed-in user changes (logout→login on
  // the same device), so one user's tab/search/selection/feed-cache never leaks
  // to the next. Runs before the tab state below reads dcSession on that mount.
  const lastUserRef = useRef(user?.uid || null);
  if (lastUserRef.current !== (user?.uid || null)) {
    lastUserRef.current = user?.uid || null;
    resetDcSession();
  }

  // Active tab — seeded from and written back to the session singleton so it
  // survives every remount (tab switch is display-only, but rotation/leave-return
  // remount the module).
  const [tab, setTabState] = useState(() => dcSession.activeTab);
  const setTab = useCallback((next) => { dcSession.activeTab = next; setTabState(next); }, []);

  // Manager tab selected but no longer allowed (store toggle moved) → fall back.
  useEffect(() => {
    const t = TABS.find((x) => x.key === tab);
    if (t?.manager && !canManage) setTab("today");
  }, [tab, canManage, setTab]);

  // ── ONE lifted feed subscription for the whole module ──
  // Today AND Analytics read from this single listener (props), so a tab switch
  // never detaches, re-subscribes, or runs two listeners on the same store. It is
  // detached only when the module unmounts (leave) or on the SA-midnight rollover.
  const live = useTodayFeedSources(store);
  // Cache the last good snapshot → a remount paints known checks instantly instead
  // of flashing empty while the listener re-attaches (no-empty-flash on return).
  useEffect(() => {
    if (store && live.ready && !live.error) {
      dcSession.feedByStore[store] = { activeItems: live.activeItems, completedItems: live.completedItems, saDate: live.saDate };
    }
  }, [store, live.ready, live.error, live.activeItems, live.completedItems, live.saDate]);
  const cached = store ? dcSession.feedByStore[store] : null;
  // Only paint the cache when it's for TODAY — a snapshot taken before SA midnight
  // must not show yesterday's completions as today's (day-boundary correctness).
  const cacheFresh = cached && cached.saDate === live.saDate;
  const feed = live.ready
    ? { activeItems: live.activeItems, completedItems: live.completedItems, ready: true, error: live.error }
    : cacheFresh
      ? { activeItems: cached.activeItems, completedItems: cached.completedItems, ready: true, error: null }
      : { activeItems: [], completedItems: [], ready: false, error: null };

  // ── Per-tab scroll persistence (window scroll; the sidebar stays sticky). Saved
  //    on switch, restored before paint so there's no jump. Survives leave/return
  //    too — on remount this runs once the active tab is rehydrated. ──
  const switchTab = useCallback((next) => {
    dcSession.scroll[tab] = window.scrollY;
    setTab(next);
  }, [tab, setTab]);
  useLayoutEffect(() => {
    window.scrollTo(0, dcSession.scroll[tab] || 0);
  }, [tab]);
  // Save the active tab's scroll on UNMOUNT too, so leaving the module (not just an
  // in-app tab switch) preserves position for the return. Ref-free: read the latest
  // tab via a ref so the cleanup isn't stale.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => () => { dcSession.scroll[tabRef.current] = window.scrollY; }, []);

  const activeLabel = visibleTabs.find((t) => t.key === tab)?.label || "Today";

  // Store-toggle buttons, shared by both chromes.
  const storeToggle = isSuper && ENABLED_STORES.length > 1
    ? ENABLED_STORES.map((s) => {
        const on = s.id === store;
        return (
          <button key={s.id} type="button" onClick={() => setSuperStore(s.id)}
                  style={{ ...META, letterSpacing: "0.08em", cursor: "pointer", padding: "6px 12px", borderRadius: 999,
                           background: on ? "rgba(74,127,255,.18)" : GLASS_BG, border: on ? `1px solid ${BLUE}` : GLASS_BORDER,
                           color: on ? BLUE_SOFT : "rgba(233,238,255,.5)" }}>
            {s.label}
          </button>
        );
      })
    : null;

  // ── Tab bodies — ALL visible tabs stay MOUNTED, only the active one shown.
  //    Mounted-but-hidden means a tab switch never unmounts a body or a listener.
  //    Today & Analytics consume the ONE lifted feed above (no own listener). ──
  const bodies = (
    <>
      <div style={{ display: tab === "today" ? "block" : "none" }}>
        <TodayView store={store} active={tab === "today"} activeItems={feed.activeItems} completedItems={feed.completedItems} ready={feed.ready} error={feed.error} />
      </div>
      <div style={{ display: tab === "availability" ? "block" : "none" }}>
        <AvailabilityView store={store} products={products} wide={wide} active={tab === "availability"} />
      </div>
      {canManage && (
        <div style={{ display: tab === "analytics" ? "block" : "none" }}>
          <AnalyticsView store={store} wide={wide} activeItems={feed.activeItems} completedItems={feed.completedItems} ready={feed.ready} />
        </div>
      )}
      {canManage && (
        <div style={{ display: tab === "settings" ? "block" : "none" }}>
          <SettingsView store={store} wide={wide} active={tab === "settings"} />
        </div>
      )}
    </>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#000", color: INK, fontFamily: FONT, position: "relative", overflowX: "clip", display: "flex" }}>
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "radial-gradient(1100px 520px at 82% -14%, rgba(74,127,255,.12), transparent 58%)" }} />

      {/* SIDEBAR — desktop chrome. display:none when narrow keeps the content
          column's tree position stable, so a rotation never remounts the tabs. */}
      <aside style={{ display: wide ? "flex" : "none", zIndex: 1, width: 246, flexShrink: 0, boxSizing: "border-box",
                      position: "sticky", top: 0, alignSelf: "flex-start", height: "100vh", flexDirection: "column", padding: "22px 14px 16px",
                      background: "rgba(255,255,255,.02)", borderRight: GLASS_BORDER, overflowY: "auto" }}>
        <button type="button" onClick={onExit} style={{ ...META, background: "none", border: "none", cursor: "pointer", color: "rgba(233,238,255,.45)", padding: "2px 10px", textAlign: "left", alignSelf: "flex-start" }}>‹ BACK</button>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.01em", padding: "12px 10px 14px" }}>Display Checks</div>
        {storeToggle && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 6px 14px" }}>{storeToggle}</div>}
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {visibleTabs.map((t) => {
            const on = t.key === tab;
            return (
              <button key={t.key} type="button" onClick={() => switchTab(t.key)}
                      style={{ display: "flex", alignItems: "center", width: "100%", textAlign: "left", boxSizing: "border-box",
                               fontFamily: FONT, fontSize: 14, fontWeight: 650, cursor: "pointer",
                               background: on ? "rgba(74,127,255,.12)" : "transparent", border: "1px solid " + (on ? BLUE : "transparent"),
                               color: on ? BLUE_SOFT : "rgba(233,238,255,.55)", borderRadius: 10, padding: "10px 13px" }}>
                {t.label}
              </button>
            );
          })}
        </nav>
        <div style={{ flex: 1, minHeight: 14 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", background: "rgba(255,255,255,.04)", border: GLASS_BORDER, borderRadius: 13 }}>
          <span style={{ width: 32, height: 32, flexShrink: 0, borderRadius: "50%", background: "rgba(74,127,255,.2)", border: `1px solid ${BLUE}`, color: BLUE_SOFT, fontSize: 13, fontWeight: 800, display: "grid", placeItems: "center" }}>{(displayName[0] || "?").toUpperCase()}</span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 750, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
            <OnDutyLine />
          </span>
        </div>
      </aside>

      {/* CONTENT COLUMN — always present; window scrolls, sidebar stays sticky. */}
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        <div style={{ maxWidth: wide ? 1080 : 640, margin: "0 auto", padding: wide ? "28px 34px 52px" : "20px 16px 40px" }}>
          {/* MOBILE chrome — header, store toggle, horizontal tabs. Hidden when wide. */}
          <div style={{ display: wide ? "none" : "block" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button type="button" onClick={onExit} style={{ ...META, background: "none", border: "none", cursor: "pointer", color: "rgba(233,238,255,.45)", padding: "6px 12px 6px 0", margin: "-6px 0", textAlign: "left" }}>‹ BACK</button>
                <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.01em" }}>Display Checks</div>
                <OnDutyStrip name={displayName} />
              </div>
              <div style={{ ...META, textAlign: "right", paddingTop: 22 }}><div>{storeLabel.toUpperCase()}</div></div>
            </div>
            {storeToggle && <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>{storeToggle}</div>}
            <div style={{ display: "flex", gap: 4, marginBottom: 18, borderBottom: "1px solid rgba(255,255,255,.06)", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              {visibleTabs.map((t) => {
                const on = t.key === tab;
                return (
                  <button key={t.key} type="button" onClick={() => switchTab(t.key)}
                          style={{ fontFamily: FONT, fontSize: 14, fontWeight: 650, cursor: "pointer", background: "none", border: "none", padding: "10px 14px", flexShrink: 0, whiteSpace: "nowrap", color: on ? INK : "rgba(233,238,255,.4)", borderBottom: on ? `2px solid ${BLUE}` : "2px solid transparent", marginBottom: -1 }}>
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* DESKTOP content header — active tab + store. Hidden when narrow. */}
          <div style={{ display: wide ? "flex" : "none", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 22 }}>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.01em" }}>{activeLabel}</div>
            <div style={{ ...META, color: "rgba(233,238,255,.5)" }}>{storeLabel.toUpperCase()}</div>
          </div>

          {bodies}
        </div>
      </div>
    </div>
  );
}
