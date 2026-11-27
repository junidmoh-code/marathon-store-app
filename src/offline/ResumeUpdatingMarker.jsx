// The small "Updating…" pill shown while what is on screen is a copy that is
// catching up — see resumeFreshness.js. Sits beside the mirror's status dot,
// in every shell, and never on the customer-facing TV board.
import { MIRROR_LEGS } from "./nodes";
import { isLegServing } from "./serving";
import { useResumeUpdating } from "./resumeFreshness";
import { isTvScreen } from "../update/updateChecker";

const anyLegServing = () => MIRROR_LEGS.some((l) => isLegServing(l.name));

export function ResumeUpdatingMarker() {
  const on = useResumeUpdating(anyLegServing);
  if (!on || isTvScreen()) return null;
  return (
    <span role="status" aria-live="polite" data-testid="resume-updating"
          style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999,
                   background: "rgba(245,158,11,.14)", border: "1px solid rgba(245,158,11,.45)", color: "#fbbf24",
                   font: "600 11px/1.2 -apple-system, 'Segoe UI', Roboto, sans-serif", letterSpacing: "0.02em" }}>
      <span aria-hidden="true">⟳</span>Updating…
    </span>
  );
}
