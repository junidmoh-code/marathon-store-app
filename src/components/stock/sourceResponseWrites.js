// ─── SOURCE RESPONSE CELL WRITES — testable, transport-injected ──────────────
// A Source response cell can live under TWO keys during the pid-key cutover:
// its productId key, and the legacy sanitized-name key a pre-cutover response
// was written under. Clearing one but not the other half-applies INVISIBLY —
// every dual-read (SourceTodayTab, SourceHistoryTab, hubBadges) finds the
// surviving leaf and keeps rendering the card as completed, so the operator
// sees Undo do nothing and gets no error.
//
// The write therefore has to be ONE multi-path update rooted at the two keys'
// common parent (the date node), never a remove() per key. That "one call, both
// paths" property is the whole point, so it is exercised through an injected
// `updatePaths` rather than by hand-rebuilding the patch in a test: a
// regression to two calls, or to a single-path call, fails the assertion.
// (App.jsx injects the real firebase `update`.)

import { sourceResponseDatePath } from "../../utils/insights";
import { encodeSizeKey, assertSafeSegment } from "../../utils/sizeKey";

// { "<key>/<sizeKey>": null, … } — one entry per distinct key the cell can live
// under. Duplicates collapse: a pid-less group's key IS its nameKey, and the
// same path must not appear twice. Falsy keys are dropped.
// The size is RTDB-encoded ("5.5"→"5_5") to match the encoded write side —
// a raw half size here made the "." a path separator, so Undo silently
// targeted a child node that never existed.
export function buildUndoPatch(productKeys, size) {
  const keys = Array.from(new Set(
    (Array.isArray(productKeys) ? productKeys : [productKeys]).filter(Boolean)
  ));
  const sizeKey = assertSafeSegment(encodeSizeKey(size), "size key");
  const patch = {};
  keys.forEach((k) => { patch[`${k}/${sizeKey}`] = null; });
  return patch;
}

// updatePaths: (path, patch) => Promise — the firebase multi-path update.
// Resolves { cleared } = how many leaves the single update targeted; 0 means
// there was nothing to clear and no write was issued.
// Rejects on transport failure: the caller SHOWS the error. Swallowing it is
// what let the half-apply hide in the first place.
export async function clearSourceResponseCells({ updatePaths, date, productKeys, size }) {
  const patch = buildUndoPatch(productKeys, size);
  const cleared = Object.keys(patch).length;
  if (!cleared) return { cleared: 0 };
  await updatePaths(sourceResponseDatePath(date), patch);
  return { cleared };
}
