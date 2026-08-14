// Deterministic stringify (sorted keys) — ONE implementation shared by the
// merge runner (drift fingerprint) and the rollback tool (path
// classification). The two comparisons must agree byte-for-byte: if the copies
// ever diverged, rollback could classify a merge output as a divergence — or
// worse, a divergence as a merge output, then write a pre-merge money value
// over live data under --force (CodeRabbit, #364).
export function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}
