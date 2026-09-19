// ─── OFFLINE MIRROR — the blocking setup screen ──────────────────────────────
//
// A device that has not finished its setup download sees this and nothing
// else. It is not a preference, not a prompt and not skippable: the app cannot
// read from a copy it does not have, and letting someone past this screen onto
// a half-filled mirror is how a shop ends up making decisions from a truncated
// catalogue.
//
// ── HONEST PROGRESS ─────────────────────────────────────────────────────────
//
// The bar is driven by BYTES, not by legs done. Twenty legs with /insights_log
// and /stock_movements among them means "18 of 20" can be 8% of the download,
// and a bar that sprints to 90% and then sits there for four minutes teaches
// people that progress bars lie. The per-leg sizes are the ones measured on
// 2026-09-19 and recorded in docs/store-offline-mirror.md; they are a share of
// the whole, so being a little out of date costs accuracy in the bar and
// nothing else.
//
// ── WHAT IT SAYS WHEN IT GOES WRONG ─────────────────────────────────────────
//
// A failure names the leg, the path and the reason, and offers one button:
// try again. It does NOT offer "continue anyway", because there is nothing to
// continue into. The two failures a person can actually act on — no line, and
// the rule not pasted yet (permission denied) — say so in those words.

import { useCallback, useEffect, useRef, useState } from "react";
import { MIRROR_LEGS } from "./nodes";

// Measured bytes per leg, 2026-09-19. Shares of the whole, used only to weight
// the bar — see the header.
const LEG_BYTES = Object.freeze({
  insights: 35_800_960,
  movements: 31_808_870,
  refills: 9_029_369,
  restockLog: 8_002_748,
  stock: 6_888_454,
  products: 4_679_403,
  orders: 2_647_522,
  customers: 1_808_403,
  restockRequests: 1_388_860,
  displayRegister: 353_404,
  returnsLog: 750_814,
  displayRows: 333_910,
  displaySlots: 138_896,
  taxonomy: 19_346,
  users: 12_746,
  hiddenProducts: 9_991,
  locations: 927,
  stockHoldConfig: 149,
  transitConfig: 99,
  // RTDB answers 4 bytes ("null") for a node with nothing in it. Kept as a
  // real measurement rather than rounded to zero, because a leg with no entry
  // at all contributes nothing to the bar and it would stop short of 100%.
  stockHoldHeld: 4,
  clothingOos: 4,
});

const TOTAL_BYTES = Object.values(LEG_BYTES).reduce((a, b) => a + b, 0);

const LEG_LABEL = Object.freeze({
  insights: "Order history",
  movements: "Stock movements",
  refills: "Refill requests",
  restockLog: "Out-of-stock log",
  stock: "Stock on hand",
  products: "The catalogue",
  orders: "Orders",
  customers: "Customers",
  restockRequests: "Source requests",
  displayRegister: "Display register",
  returnsLog: "Returns",
  displayRows: "Display rows",
  displaySlots: "Displays",
  taxonomy: "Categories",
  users: "Staff",
  locations: "Locations",
  stockHoldConfig: "Settings",
  stockHoldHeld: "Settings",
  hiddenProducts: "Settings",
  transitConfig: "Settings",
  clothingOos: "Settings",
});

const MB = (b) => `${(b / 1_000_000).toFixed(b < 10_000_000 ? 1 : 0)} MB`;

export function progressFor(doneLegs) {
  const done = new Set(doneLegs);
  let bytes = 0;
  for (const leg of MIRROR_LEGS) if (done.has(leg.name)) bytes += LEG_BYTES[leg.name] ?? 0;
  return { bytes, total: TOTAL_BYTES, pct: Math.min(100, Math.round((bytes / TOTAL_BYTES) * 100)) };
}

// The two failures a person can do something about, in the words they would
// use. Everything else is shown verbatim rather than guessed at.
export function explainFailure(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/permission|PERMISSION_DENIED/i.test(msg)) {
    return "This device is not allowed to read part of the database yet. "
      + "The database rule for the change log still has to be pasted — see "
      + "docs/store-offline-mirror.md.";
  }
  if (/did not answer|timeout|network|offline/i.test(msg)) {
    return "The database did not answer. Check the connection and try again — "
      + "nothing downloaded so far has been lost.";
  }
  return msg || "The download stopped for a reason this screen could not read.";
}

export function MirrorSetupScreen({ runtime, onDone }) {
  const [done, setDone] = useState([]);
  const [current, setCurrent] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const startedRef = useRef(false);

  const run = useCallback(async () => {
    setError(null);
    try {
      await runtime.setup();
      onDone();
    } catch (err) {
      setError(err);
    }
  }, [runtime, onDone]);

  useEffect(() => {
    // The engine takes one onProgress at construction; the runtime fans it out
    // so this screen does not have to own the engine.
    const unsub = runtime.onSetupProgress?.((p) => {
      if (p.phase !== "setup") return;
      setCurrent(p.leg);
      // `rows` is only present on a leg that has FINISHED. A leg counted as
      // done while it was still downloading is how a bar reaches 90% and sits
      // there.
      if (p.rows !== undefined) {
        setDone((prev) => (prev.includes(p.leg) ? prev : [...prev, p.leg]));
      }
    });
    return unsub ?? (() => {});
  }, [runtime]);

  useEffect(() => {
    // StrictMode mounts effects twice in development. runSetup() is itself
    // single-flight (it returns the run already in progress), but starting it
    // twice would still double the progress wiring, so the start is latched.
    if (startedRef.current && attempt === 0) return;
    startedRef.current = true;
    run();
  }, [run, attempt]);

  const { bytes, total, pct } = progressFor(done);

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.title}>Setting this device up</div>
        <div style={S.sub}>
          This happens once. Afterwards the app reads from this device instead of
          downloading everything again, so it will be faster and will use almost
          no data.
        </div>

        {error ? (
          <>
            <div style={S.error}>{explainFailure(error)}</div>
            <button type="button" style={S.button} onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
            <div style={S.note}>
              Nothing already downloaded is lost — it picks up where it stopped.
            </div>
          </>
        ) : (
          <>
            <div style={S.barOuter}>
              <div style={{ ...S.barInner, width: `${pct}%` }} />
            </div>
            <div style={S.row}>
              <span>{MB(bytes)} of {MB(total)}</span>
              <span>{pct}%</span>
            </div>
            <div style={S.current}>
              {current ? `Downloading ${LEG_LABEL[current] ?? current}…` : "Starting…"}
            </div>
            <div style={S.note}>
              Pictures download quietly afterwards and do not hold anything up.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const S = {
  wrap: {
    position: "fixed", inset: 0, zIndex: 2147483000, display: "flex",
    alignItems: "center", justifyContent: "center", padding: 16,
    background: "#0b0b0c", color: "#f4f4f5",
    font: "14px/1.55 -apple-system,system-ui,'Segoe UI',sans-serif",
  },
  card: { width: "100%", maxWidth: 420 },
  title: { fontSize: 20, fontWeight: 650, letterSpacing: "-0.01em", marginBottom: 8 },
  sub: { color: "#a1a1aa", marginBottom: 22 },
  barOuter: { height: 8, borderRadius: 999, background: "#27272a", overflow: "hidden" },
  barInner: { height: "100%", background: "#22c55e", transition: "width .35s ease" },
  row: { display: "flex", justifyContent: "space-between", marginTop: 10, color: "#a1a1aa", fontSize: 13 },
  current: { marginTop: 16, fontWeight: 550 },
  note: { marginTop: 14, color: "#71717a", fontSize: 12.5 },
  error: {
    background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 10,
    padding: "12px 14px", marginBottom: 16, color: "#fecaca",
  },
  button: {
    width: "100%", padding: "11px 14px", borderRadius: 10, border: 0,
    background: "#f4f4f5", color: "#18181b", fontSize: 14, fontWeight: 600, cursor: "pointer",
  },
};
