// ─── DISPLAY CHECKS — TODAY VIEW (PR 5, read-only feed) ──────────────────────
// The Today tab body: the live work feed for one store, assembled from the two
// sources in useTodayFeedSources and partitioned by feedModel.deriveFeed.
//
// Layout (design §10/§11):
//   • Stat strip   — Assigned · Completion (done/assigned + arc) · Outstanding.
//   • Outstanding  — open checks, a responsive card grid, the work you act on.
//   • Waiting on stock (N)  — held checks, collapsed, greyscale, no action.
//   • Confirmed (N)         — today's completed checks, collapsed, dimmed.
// Held checks stay OUT of the completion maths (§2). Tapping an outstanding card
// opens the confirm sheet (PR 7), which writes the completion server-side; the
// live listener then moves the card into Completed on its own.

import { useMemo, useState } from "react";
import { FONT, MONO, BLUE, BLUE_SOFT, AMBER, INK, PANEL, META } from "./tokens";
import { useTodayFeedSources } from "./useDisplayChecks";
import { deriveFeed } from "./feedModel";
import CheckCard from "./CheckCard";
import CheckSheet from "./CheckSheet";

function StatTile({ label, value, sub }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div style={{ ...META, fontSize: 10 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {sub != null && <div style={{ ...META, fontSize: 10, color: "rgba(233,238,255,.35)" }}>{sub}</div>}
    </div>
  );
}

function StatStrip({ stats }) {
  return (
    <div style={{ ...PANEL, padding: "16px 18px", marginBottom: 18,
                  display: "flex", gap: 24, alignItems: "flex-end", flexWrap: "wrap" }}>
      <StatTile label="Assigned" value={stats.assigned} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 160 }}>
        <div style={{ ...META, fontSize: 10 }}>Completion</div>
        <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: INK, fontVariantNumeric: "tabular-nums" }}>
          {stats.done} / {stats.assigned}
        </div>
        <div style={{ height: 4, borderRadius: 999, background: "rgba(255,255,255,.07)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${stats.completionPct}%`, background: BLUE,
                        boxShadow: `0 0 10px ${BLUE}`, transition: "width .4s ease" }} />
        </div>
      </div>
      <StatTile label="Outstanding" value={stats.outstanding}
                sub={stats.waiting > 0 ? `${stats.waiting} WAITING` : null} />
    </div>
  );
}

// A collapsible section header + body. `defaultOpen` seeds the toggle.
function Section({ title, count, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ marginTop: 20 }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
              style={{ ...META, fontSize: 11, background: "none", border: "none", cursor: "pointer",
                       color: "rgba(233,238,255,.55)", padding: "8px 0", display: "flex",
                       alignItems: "center", gap: 8, width: "100%", textAlign: "left" }}>
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-block" }}>›</span>
        {title} <span style={{ color: "rgba(233,238,255,.3)" }}>({count})</span>
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

// Responsive card grid — 1 col on a phone, up to 3 on desktop (auto-fill).
function CardGrid({ children }) {
  return (
    <div style={{ display: "grid", gap: 12,
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
      {children}
    </div>
  );
}

export default function TodayView({ store }) {
  const { activeItems, completedItems, ready, error } = useTodayFeedSources(store);
  const feed = useMemo(() => deriveFeed(activeItems, completedItems), [activeItems, completedItems]);
  // The check whose confirm sheet is open (PR 7). Null = no sheet.
  const [sheetCheck, setSheetCheck] = useState(null);

  if (!store) {
    return (
      <div style={{ ...PANEL, padding: "40px 24px", textAlign: "center",
                    ...META, color: "rgba(233,238,255,.4)" }}>
        NO STORE IN SCOPE
      </div>
    );
  }

  // A denied/failed read is NOT an empty day. Show it plainly rather than the
  // "nothing outstanding" state — an unreadable feed must never read as "all
  // caught up" in a compliance tool.
  if (ready && error) {
    return (
      <div style={{ ...PANEL, padding: "40px 24px", textAlign: "center",
                    display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ ...META, color: AMBER }}>FEED UNAVAILABLE</div>
        <div style={{ fontFamily: FONT, fontSize: 14, color: "rgba(233,238,255,.5)" }}>
          Today's checks couldn't be read for this store. This isn't an empty day — it's a read
          error{typeof error === "string" ? ` (${error})` : ""}. It clears on its own once the feed is reachable.
        </div>
      </div>
    );
  }

  const nothingYet = ready && !error && feed.outstanding.length === 0
    && feed.waiting.length === 0 && feed.completed.length === 0;

  return (
    <div>
      <StatStrip stats={feed.stats} />

      {!ready && (
        <div style={{ ...META, textAlign: "center", padding: "24px 0", color: "rgba(233,238,255,.35)" }}>
          LOADING FEED…
        </div>
      )}

      {nothingYet && (
        <div style={{ ...PANEL, padding: "40px 24px", textAlign: "center",
                      display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ ...META, color: BLUE_SOFT }}>NOTHING OUTSTANDING</div>
          <div style={{ fontFamily: FONT, fontSize: 14, color: "rgba(233,238,255,.5)" }}>
            No clothing has sold today, or every display has been checked. New checks appear here the moment an item sells.
          </div>
        </div>
      )}

      {/* Outstanding — the work you can act on, always expanded */}
      {feed.outstanding.length > 0 && (
        <div>
          <div style={{ ...META, fontSize: 11, color: "rgba(233,238,255,.55)", padding: "8px 0 12px" }}>
            OUTSTANDING <span style={{ color: "rgba(233,238,255,.3)" }}>({feed.outstanding.length})</span>
          </div>
          <CardGrid>
            {feed.outstanding.map((c) => (
              <CheckCard key={c.key} check={c} variant="outstanding" onOpen={setSheetCheck} />
            ))}
          </CardGrid>
        </div>
      )}

      {/* Waiting on stock — held, collapsed by default */}
      {feed.waiting.length > 0 && (
        <Section title="WAITING ON STOCK" count={feed.waiting.length}>
          <CardGrid>
            {feed.waiting.map((c) => (
              <CheckCard key={c.key} check={c} variant="waiting" />
            ))}
          </CardGrid>
        </Section>
      )}

      {/* Completed — today's resolved checks (confirmed AND no-stock, each card
          carries its own result tag), collapsed by default. Titled COMPLETED not
          CONFIRMED because a no-stock result is completed work too. */}
      {feed.completed.length > 0 && (
        <Section title="COMPLETED" count={feed.completed.length}>
          <CardGrid>
            {feed.completed.map((c) => (
              <CheckCard key={c.key} check={c} variant="completed" />
            ))}
          </CardGrid>
        </Section>
      )}

      {sheetCheck && (
        <CheckSheet store={store} check={sheetCheck} onClose={() => setSheetCheck(null)} />
      )}
    </div>
  );
}
