// ─── ORDER VIEW PREVIEW — the sneaker wall, behind a switch ──────────────────
//
// Junid, 2026-10-20: the Sneaker order screen goes back to the classic layout
// staff know (sidebar · card grid · Order panel) for everyone. The sneaker
// wall (#761/#764/#768) stays in the tree for Junid to keep iterating on, but
// only mounts when the preview is on:
//
//   - the URL carries ?view=wall (any account — a link, for a demo), or
//   - this browser's localStorage has mc.orderView === "wall" AND the signed-in
//     account is one that may set it (a flag left on a shared till by Junid or
//     MC must not put a staff login on the wall).
//
// The "Preview new design" toggle that writes the localStorage key is shown
// to two accounts only: Junid's (the owner email the database rules name) and
// the staff-code user MC. Flipping it reloads the page, so the answer below is
// read once per page load and never changes underneath a mounted screen.

export const ORDER_VIEW_KEY = "mc.orderView";
export const ORDER_VIEW_WALL = "wall";

// Junid's account (ADMIN_EMAIL / the rules' owner email) and MC's staff-code
// login (usernameToEmail("mc")).
export const PREVIEW_TOGGLE_EMAILS = Object.freeze(["gunidmoh@gmail.com", "mc@marathon.internal"]);

function defaultStorage() {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}
function defaultSearch() {
  return typeof window !== "undefined" ? window.location?.search || "" : "";
}

/** Did this page load turn the preview on through ?view=wall? Never throws. */
export function isWallPreviewFromUrl(search = defaultSearch()) {
  try { return new URLSearchParams(search).get("view") === ORDER_VIEW_WALL; }
  catch { return false; }   // malformed query
}

/** Is the sneaker-wall preview on for this page load? Never throws. */
export function isWallPreviewOn({ search = defaultSearch(), storage = defaultStorage(), email = "" } = {}) {
  if (isWallPreviewFromUrl(search)) return true;
  if (!canTogglePreview(email)) return false;
  try {
    return storage?.getItem(ORDER_VIEW_KEY) === ORDER_VIEW_WALL;
  } catch { return false; }   // private window / blocked storage = classic
}

/** May this account see the "Preview new design" toggle? */
export function canTogglePreview(email) {
  return PREVIEW_TOGGLE_EMAILS.includes(String(email || "").trim().toLowerCase());
}

/**
 * Turn the preview on or off for this browser and reload. Turning it off also
 * drops ?view=wall from the URL, or the reload would land straight back on
 * the wall.
 */
export function setWallPreview(on, { storage = defaultStorage(), location = typeof window !== "undefined" ? window.location : null } = {}) {
  try {
    if (on) storage?.setItem(ORDER_VIEW_KEY, ORDER_VIEW_WALL);
    else storage?.removeItem(ORDER_VIEW_KEY);
  } catch { /* storage blocked: the URL switch still works */ }
  if (!location) return;
  if (!on) {
    try {
      const params = new URLSearchParams(location.search || "");
      if (params.has("view")) {
        params.delete("view");
        const qs = params.toString();
        location.replace(`${location.pathname}${qs ? `?${qs}` : ""}${location.hash || ""}`);
        return;
      }
    } catch { /* fall through to a plain reload */ }
  }
  location.reload();
}
