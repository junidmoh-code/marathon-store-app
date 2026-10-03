// The backfill may FILL an empty brand, never overwrite a set one (Junid, 3 Oct:
// a corrected brand must never be written back by a re-derivation).
/** The brand to write, or null for "leave it". Pure. */
export function brandFill(current, derived) {
  if (String(current ?? "").trim()) return null;
  return derived || null;
}
