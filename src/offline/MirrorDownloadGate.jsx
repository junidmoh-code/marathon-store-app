// ─── OFFLINE MIRROR — the download gate ──────────────────────────────────────
//
// The first time a device opens the app after the mirror is switched on, this
// is what a person sees: one sentence about what it is, and ONE BUTTON.
//
// ── TAPPING IT OPENS THE APP IMMEDIATELY ────────────────────────────────────
//
// It does not start a download and wait for it. It records that this device
// has said yes, dismisses itself, and the 104 MB goes down underneath the app
// while the person works. Until that download is complete and verified, every
// screen reads live from the database exactly as it does today — the mirror
// serves nothing until it has everything, and health.js decides that, not a
// timer and not this screen.
//
// The version before this one BLOCKED. It held the whole app behind a progress
// bar until the download finished, which on a shop floor means a member of
// staff standing in front of a customer waiting for a bar. The app works
// perfectly well on live reads; that is what it did for two years. Nothing
// here may ever stop somebody trading.
//
// It is asked ONCE per device. Afterwards the download resumes by itself on
// every open until the copy is complete, and this screen is never seen again —
// unless the local copy is purged, which is the one case where the device
// genuinely is starting over and the question is worth asking again.
//
// ── WHY THERE IS NO "NOT NOW" ───────────────────────────────────────────────
//
// Because the answer to "not now" is "open the app", which is what the one
// button does. A second button would only mean "and stay expensive", which is
// not a choice this shop is offering its devices; the decision about whether
// the fleet mirrors is one value in the database (killSwitch.js), not
// twenty-odd separate opinions collected at tills.
//
// `progressFor` and `explainFailure` stay here, and the status dot uses them
// to show the download while it runs.

import { useCallback } from "react";
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
    // Written for whoever is holding the tablet, not for whoever wrote the
    // rules. The one thing they can act on is signing in; the rest is
    // somebody else's job and saying so is kinder than naming a JSON file.
    return "This device is not allowed to download the copy yet. "
      + "Make sure you are signed in — if you are, it is a setting on the "
      + "database that Junid has to switch on.";
  }
  if (/did not answer|timeout|network|offline/i.test(msg)) {
    return "The connection dropped. It will pick up where it stopped by "
      + "itself — nothing downloaded so far is lost.";
  }
  return msg || "The download stopped and will try again by itself.";
}

export function MirrorDownloadGate({ runtime, onStart }) {
  const { total } = progressFor([]);

  // ── IT DOES NOT AWAIT ANYTHING ────────────────────────────────────────────
  //
  // Not the download, obviously — but not the consent write either. `await`ing
  // even one IndexedDB write here means the gate is still on screen, over the
  // app, for however long that write takes on a tablet that is busy doing
  // something else; and an `await` on a call that also STARTS the download is
  // how the first version of this held the gate up for the whole 104 MB with
  // the button reading "Starting…". (Found by mutating the await back in.)
  //
  // A tab closed in that same millisecond loses the consent record and the
  // device is asked once more next time. That is the entire downside.
  const start = useCallback(() => {
    try {
      const p = runtime.consentAndDownload();
      if (p && typeof p.catch === "function") {
        p.catch((err) => console.warn("offline mirror: could not record the download consent —", err));
      }
    } catch (err) {
      // A device that cannot record its consent still gets its app, and will
      // be asked again next time. Never a dead end.
      console.warn("offline mirror: could not record the download consent —", err);
    }
    onStart();
  }, [runtime, onStart]);

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.title}>Keep the shop on this device</div>
        <div style={S.sub}>
          This device can hold its own copy of the shop — stock, products,
          orders, history — so screens open instantly and the shop stops paying
          to fetch the same numbers over and over. It downloads about {MB(total)}
          once. Best on Wi-Fi.
        </div>
        <button type="button" style={S.button} onClick={start}>Download</button>
        <div style={S.note}>
          The app opens straight away and you can carry on working. Nothing
          changes on screen until the copy is complete — until then everything
          is read live, exactly as it is now.
        </div>
      </div>
    </div>
  );
}

/**
 * What the status dot says while the download is running. Shared with the gate
 * so the weighting — BYTES, not legs done — is the same in both places.
 */
export function downloadLine({ legsDone = [], current = null, error = null }) {
  if (error) return `Download paused — ${explainFailure(error)}`;
  const { pct, bytes, total } = progressFor(legsDone);
  const what = current ? `${LEG_LABEL[current] ?? current}` : "the catalogue";
  return `Downloading this device's copy — ${pct}% (${MB(bytes)} of ${MB(total)}), on ${what}`;
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
  note: { marginTop: 14, color: "#71717a", fontSize: 12.5 },
  button: {
    width: "100%", padding: "11px 14px", borderRadius: 10, border: 0,
    background: "#f4f4f5", color: "#18181b", fontSize: 14, fontWeight: 600, cursor: "pointer",
  },
};
