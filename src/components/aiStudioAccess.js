// ─── AI Studio tool access (pure) ────────────────────────────────────────────
// Which AI Studio tabs an account may open, extracted from App.jsx so the
// narrowing is unit-testable without mounting the view (which pulls in firebase
// at module load).
//
// Two tiers only:
//   • super-admin  — every tool.
//   • `ai_photos`  — the Photo Studio alone. Name Cleanup and Reorder spend on
//     Claude, and the Style Kit rewrites the house look for EVERY future
//     generation, so all three stay super-admin.
//
// This is a UI narrowing, not the security boundary: generateProductPhotos
// re-checks the grant server-side (assertPhotoStudio), so a spoofed client
// still cannot spend anything.

/** The tool id an `ai_photos` holder is allowed to open, and the safe default. */
export const AI_DEFAULT_TOOL = "photos";

/** Filter a tool list down to what this account may open. */
export function permittedAiTools(allTools, fullAccess) {
  const list = Array.isArray(allTools) ? allTools : [];
  return fullAccess ? list : list.filter((t) => t && t.id === AI_DEFAULT_TOOL);
}

/**
 * Clamp a remembered tab to the permitted set.
 *
 * usePersistedTab restores the last tab from storage, so an account that was
 * demoted — or one that borrowed a browser where a super-admin left "reorder"
 * behind — would otherwise land straight on a tool it may not open. Anything
 * not in the permitted list collapses to the Photo Studio.
 */
export function clampAiTool(tool, tools) {
  const list = Array.isArray(tools) ? tools : [];
  return list.some((t) => t && t.id === tool) ? tool : AI_DEFAULT_TOOL;
}
