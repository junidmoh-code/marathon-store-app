// The small pill shown while what is on screen is a copy that is catching up
// — see resumeFreshness.js. Sits beside the mirror's status dot, in every
// shell, and never on the customer-facing TV board.
//
//   updating → "⟳ Updating…"              (bounded: UPDATE_TIMEOUT_MS)
//   failed   → "Couldn't update. Tap to retry"   (a button)
//   offline  → "Offline"
import { MIRROR_LEGS } from "./nodes";
import { isLegServing } from "./serving";
import { useResumeMarkerState, retryUpdate } from "./resumeFreshness";
import { isTvScreen } from "../update/updateChecker";

const anyLegServing = () => MIRROR_LEGS.some((l) => isLegServing(l.name));

const pill = {
  display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999,
  font: "600 11px/1.2 -apple-system, 'Segoe UI', Roboto, sans-serif", letterSpacing: "0.02em",
};
const amber = { background: "rgba(245,158,11,.14)", border: "1px solid rgba(245,158,11,.45)", color: "#fbbf24" };
const red = { background: "rgba(239,68,68,.16)", border: "1px solid rgba(239,68,68,.5)", color: "#fca5a5" };
const grey = { background: "rgba(148,163,184,.16)", border: "1px solid rgba(148,163,184,.45)", color: "#cbd5e1" };

export function ResumeUpdatingMarker() {
  const state = useResumeMarkerState(anyLegServing);
  if (state === "hidden" || isTvScreen()) return null;
  if (state === "failed") {
    return (
      <button type="button" data-testid="resume-updating" data-state="failed" onClick={() => retryUpdate()}
              style={{ ...pill, ...red, cursor: "pointer", minHeight: 28 }}>
        <span aria-hidden="true">!</span>Couldn't update. Tap to retry
      </button>
    );
  }
  if (state === "offline") {
    return (
      <span role="status" aria-live="polite" data-testid="resume-updating" data-state="offline" style={{ ...pill, ...grey }}>
        <span aria-hidden="true">○</span>Offline
      </span>
    );
  }
  return (
    <span role="status" aria-live="polite" data-testid="resume-updating" data-state="updating" style={{ ...pill, ...amber }}>
      <span aria-hidden="true">⟳</span>Updating…
    </span>
  );
}
