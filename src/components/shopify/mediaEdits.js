// ─── MEDIA LIST EDITS (pure) ─────────────────────────────────────────────────
// The edits MediaStrip.jsx offers on a selected item. Each returns the next
// list, or null when the edit is not allowed — and the strip enables a chip
// exactly when its edit returns a list, so a video can never be put first and
// the last photo can never be removed: the UI cannot express those edits.
import { photoFirst } from "./publishShared.js";

export function moveItem(items, i, d) {
  const j = i + d;
  if (i < 0 || i >= items.length || j < 0 || j >= items.length) return null;
  const next = [...items];
  [next[i], next[j]] = [next[j], next[i]];
  return next[0].type === "photo" ? next : null;
}
export function makePrimary(items, i) {
  if (i <= 0 || items[i]?.type !== "photo") return null;
  return [items[i], ...items.filter((_, k) => k !== i)];
}
export function removeItem(items, i) {
  if (i < 0 || i >= items.length) return null;
  const next = items.filter((_, k) => k !== i);
  if (!next.some((m) => m.type === "photo")) return null; // never without a photo
  return photoFirst(next);
}
export function replaceItem(items, oldUrl, newItem) {
  const i = items.findIndex((m) => m.url === oldUrl);
  if (i < 0) return null;
  const next = [...items];
  next[i] = newItem;
  return next[0].type === "photo" ? next : null;
}

