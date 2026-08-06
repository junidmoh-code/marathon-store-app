// ─── THREE FRAMES, NOT ONE — cross-frame token agreement ─────────────────────
// Most OCR variance is single-frame noise: one frame catches glare, one splits
// a word, one reads clean. The capture takes three frames and keeps only the
// tokens that appear in AT LEAST TWO of them — a token seen once is noise, a
// token seen twice is the label. With fewer than two usable frames (camera
// fallback, permission denied) the single frame's tokens pass through
// unchanged: degraded, but never a dead end.

export function mergeFrameTokens(frameTokenLists) {
  const frames = (frameTokenLists || [])
    .map((l) => new Set((l || []).map((t) => String(t ?? "").trim().toUpperCase()).filter(Boolean)))
    .filter((s) => s.size > 0);
  if (frames.length === 0) return [];
  if (frames.length === 1) return [...frames[0]].sort();
  const counts = new Map();
  for (const frame of frames) {
    for (const t of frame) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([t]) => t).sort();
}
