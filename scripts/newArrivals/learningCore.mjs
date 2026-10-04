// ─── NEW ARRIVALS — THE WEEKLY LEARNING REPORT (pure) ────────────────────────
// What made the photos Junid loved, set against the ones he marked "not right".
// Everything is manual now, so there is no checker to agree or disagree with:
// the only judge is Junid — his ❤, his Approve / Use this one, his feedback
// chips — and the only evidence is the learning log each generation keeps
// (method, prompt version and layers, inputs, timing, cost, Gemini's thought
// summary, pixel measurements).
//
// THREE FINDINGS, each citing its numbers; fewer than three clear differences
// is said plainly, never padded. PROMPT CHANGES ARE ONLY PROPOSED — never
// applied without Junid's OK.
//
// Pure: decisions (new_arrivals/decisions rows) + genlogs (new_arrivals/genlog
// rows) in, { subject, body, images } out. The runner (learningReport.mjs)
// reads RTDB and sends the email from the Mac mini.

export const THOUGHTS_LABEL = "Gemini's own account — not proof";
const WEEK_MS = 7 * 86_400_000;
const GOOD = new Set(["approve", "approve-anyway", "pick"]);

const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const fmt = (x, d = 2) => (x == null ? "—" : Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 10 ** d) / 10 ** d));
const zar = (x) => (x == null ? "—" : `R${Number(x).toFixed(2)}`);
const genKey = (d) => `${d.pid}|${d.genId || d.gen?.url || ""}`;

/**
 * Junid's final word on each generation: "loved" | "approved" | "rejected".
 * ❤ outranks everything until it is un-loved; otherwise the last of approve /
 * pick / a feedback chip wins. Every chip he gave is kept as `reasons`. Pure.
 * → [{ pid, genId, at, tier, reasons, gen, categoryKey, class }], oldest first
 */
export function tiers(decisions) {
  const ordered = [...(decisions || [])].filter((d) => d && d.pid && (d.genId || d.gen?.url)).sort((a, b) => Number(a.at) - Number(b.at));
  const word = new Map(), loved = new Map(), reasons = new Map();
  for (const d of ordered) {
    const k = genKey(d);
    if (d.action === "love") { loved.set(k, d); continue; }
    if (d.action === "unlove") { loved.delete(k); continue; }
    if (d.action === "reject") {
      word.set(k, { d, tier: "rejected" });
      if (d.reason) reasons.set(k, [...(reasons.get(k) || []), String(d.reason)]);
      continue;
    }
    if (GOOD.has(d.action)) word.set(k, { d, tier: "approved" });
  }
  for (const [k, d] of loved) word.set(k, { d, tier: "loved" });
  return [...word.entries()].map(([k, { d, tier }]) => ({
    pid: d.pid, genId: d.genId || null, at: Number(d.at) || 0, tier, reasons: reasons.get(k) || [],
    gen: d.gen || {}, categoryKey: d.categoryKey || null, class: d.class || null,
  })).sort((a, b) => a.at - b.at);
}

/** Tiers joined to the learning log: one row per judged generation. Pure. */
export function joinRows(decisions, genlogs) {
  const byGen = new Map((genlogs || []).filter(Boolean).map((g) => [`${g.pid}|${g.genId}`, g]));
  return tiers(decisions).map((t) => {
    const log = byGen.get(`${t.pid}|${t.genId}`) || null;
    return { ...t, log, code: log?.code || t.gen?.code || null };
  });
}

const M = (r) => r.log?.measurements || r.gen?.measurements || null;
const methodOf = (r) => r.log?.method || r.gen?.method || null;
/** The prompt setup in plain words: "the standard instructions" + what was added. Pure. */
export function setupWords(version) {
  const v = String(version || "").split(" ")[0];
  if (!v) return null;
  if (v.startsWith("split-")) return "the product-only instructions";
  const extras = v.split("+").slice(1).map((x) => ({ steam: "steaming", footwearBox: "the box rule", footwearPose: "the pedestal rule", footwearExamples: "your example photos", packaging: "the keep-the-box rule" }[x] || x));
  return extras.length ? `the standard instructions plus ${extras.join(", ")}` : "the standard instructions";
}
const kindOf = (r) => r.log?.kind || r.gen?.kind || r.class || null;
// A side of a comparison needs this many photos; under SMALL_SAMPLE the finding is called a hint.
export const MIN_SIDE = 3;
export const SMALL_SAMPLE = 6;
// What is compared. `better` says which way is good; a field without it is described, never ranked.
export const FIELDS = [
  { key: "sharpness", measured: true, label: "sharpness", unit: "(a higher number is sharper)", num: true, better: "higher", get: (r) => M(r)?.sharpness?.laplacianVar ?? null },
  { key: "noise", measured: true, label: "background noise", unit: "(a lower number is cleaner)", num: true, better: "lower", get: (r) => M(r)?.noise?.highpassStd ?? null },
  { key: "crease", measured: true, label: "creasing left in the garment", unit: "(a lower number is smoother)", num: true, better: "lower", get: (r) => M(r)?.crease?.delta ?? null },
  // Full Gemini only: in Split the backdrop IS your photo, so the number says nothing about quality there.
  { key: "background", measured: true, label: "difference from your backdrop photo", unit: "(0 is identical)", num: true, better: "lower", get: (r) => (methodOf(r) === "split" ? null : M(r)?.background?.mad ?? null) },
  { key: "requestMs", label: "seconds Gemini took", unit: "", num: true, get: (r) => (r.log?.timing?.requestMs != null ? r.log.timing.requestMs / 1000 : null) },
  { key: "costZar", label: "cost", unit: "(rand)", num: true, get: (r) => { const c = Number(r.log?.costZar ?? r.gen?.costZar); return Number.isFinite(c) && c > 0 ? c : null; } },
  { key: "method", label: "made by", get: (r) => (methodOf(r) === "split" ? "Split" : methodOf(r) === "full" ? "Full Gemini" : null) },
  { key: "setup", label: "made with", get: (r) => setupWords(r.log?.promptVersion || r.gen?.promptVersion) },
  { key: "box", label: "shown with a box", get: (r) => ((r.log?.kind || r.gen?.kind) === "footwear" && r.log ? ((r.log.inputs || []).some((i) => String(i.role).startsWith("box")) ? "yes" : "no") : null) },
];

// What a finding suggests for the prompt — PROPOSED only.
export const PROPOSALS = {
  sharpness: "Add to the instructions: \"tack-sharp across the whole product — every stitch and texture crisp\".",
  noise: "Add to the instructions: \"a clean, noise-free exposure — no grain in the background\".",
  crease: "Make the steaming instruction stronger for the garment types that still come out creased (or try Split on those items).",
  background: "Try Split on these items: it puts the product on your real backdrop photo, so the background cannot change.",
  method: "Make the method that produced more loved photos the default for that group.",
  setup: "Keep the instructions that produced more loved photos; drop the others.",
  box: "Photograph the shoe's own box with it (or add the brand's box to the library) — photos sent with a box photo were loved more often.",
};
// Reject chips → what they suggest.
export const CHIP_PROPOSALS = {
  "background wrong": PROPOSALS.background,
  "colour off": "Add next to NEVER CHANGE THE PRODUCT: \"true-to-life colour exactly as in the product photo — no colour grading\".",
  "detail changed": "Add: \"every text, logo, label, print and stitch line exactly as in the product photo, character for character\".",
  "looks fake/CGI": "Add: \"a real photograph — natural fabric and material texture, no plastic or rendered look\".",
  framing: "Use Split for these items (code places the product at your measured layout).",
  "box wrong": "Photograph the shoe's own box with it; a brand-library box is only a stand-in.",
  blurry: PROPOSALS.sharpness,
};

/**
 * Up to three findings, each citing its numbers. "Good" is loved when there are
 * at least 2 loved photos with the measurement, else loved + approved; always
 * compared against rejected. Fewer than three clear differences is said once,
 * with the counts. Pure. → [{ key, text, goodIsBetter }]
 */
export function findings(rows) {
  const cands = [];
  // Photo measurements differ by nature between shoes and clothing, so those are
  // compared within each; the rest (method, setup, box) over everything.
  const groups = [
    { name: "Shoes", rows: rows.filter((r) => kindOf(r) === "footwear"), fields: FIELDS.filter((f) => f.measured) },
    { name: "Clothing", rows: rows.filter((r) => kindOf(r) && kindOf(r) !== "footwear"), fields: FIELDS.filter((f) => f.measured) },
    { name: null, rows, fields: FIELDS.filter((f) => !f.measured) },
  ];
  for (const g of groups) for (const f of g.fields) {
    const rejected = g.rows.filter((r) => r.tier === "rejected");
    const lovedVals = g.rows.filter((r) => r.tier === "loved").map(f.get).filter((v) => v != null);
    const who = lovedVals.length >= MIN_SIDE ? "loved" : "loved and approved";
    const good = lovedVals.length >= MIN_SIDE ? lovedVals : g.rows.filter((r) => r.tier !== "rejected").map(f.get).filter((v) => v != null);
    const bad = rejected.map(f.get).filter((v) => v != null);
    if (good.length < MIN_SIDE || bad.length < MIN_SIDE) continue;
    const Who = `${g.name ? `${g.name} — ${who}` : `${who[0].toUpperCase()}${who.slice(1)}`}`;
    // Few photos on either side: a hint, said as one.
    const small = Math.min(good.length, bad.length) < SMALL_SAMPLE ? " Only a few photos so far — a hint, not a rule." : "";
    if (f.num) {
      if (!f.better) continue;
      const mg = median(good.map(Number)), mb = median(bad.map(Number));
      const all = [...good, ...bad].map(Number);
      const effect = (mg - mb) / ((Math.max(...all) - Math.min(...all)) || 1);
      if (Math.abs(effect) < 0.1) continue;
      const goodIsBetter = f.better === "higher" ? mg > mb : mg < mb;
      cands.push({ key: f.key, effect: Math.abs(effect), goodIsBetter,
        text: `${Who} photos had ${f.label} ${fmt(mg)} (typical of ${good.length}) against ${fmt(mb)} for the ones you marked not right (typical of ${bad.length}) ${f.unit}${goodIsBetter ? "" : " — the opposite of what was expected, so this number does not explain your choice"}.${small}` });
    } else {
      const counts = {};
      for (const v of good) counts[v] = (counts[v] || 0) + 1;
      const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const share = (vals) => vals.filter((x) => x === top[0]).length / vals.length;
      const sg = share(good), sb = share(bad);
      if (Math.abs(sg - sb) < 0.25) continue;
      cands.push({ key: f.key, effect: Math.abs(sg - sb), goodIsBetter: sg > sb,
        text: `${Who} photos: ${Math.round(sg * good.length)} of ${good.length} were ${f.label} "${top[0]}", against ${Math.round(sb * bad.length)} of ${bad.length} of the ones you marked not right.${small}` });
    }
  }
  const out = cands.sort((a, b) => b.effect - a.effect).slice(0, 3).map(({ key, text, goodIsBetter }) => ({ key, text, goodIsBetter }));
  const n = (t) => rows.filter((r) => r.tier === t).length;
  if (out.length < 3) {
    out.push({ key: null, goodIsBetter: false,
      text: `${out.length ? "No further clear difference" : "Not enough to compare yet"}: ${n("loved")} loved, ${n("approved")} approved and ${n("rejected")} marked not right so far — a finding needs at least ${MIN_SIDE} good and ${MIN_SIDE} not-right photos of the same kind that differ on something measured.` });
  }
  return out;
}

/** The reject chips, most used first: [[chip, count]]. Pure. */
export function chipCounts(rows) {
  const counts = {};
  // Only photos whose final word is "not right": a chip on a photo he later loved or approved is not a complaint about it.
  for (const r of rows) if (r.tier === "rejected") for (const c of r.reasons || []) counts[c] = (counts[c] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

/** PROPOSED prompt changes — from the findings and the chips he used most. Never applied. Pure. */
export function proposals(found, chips) {
  const out = [];
  for (const f of found) if (f.key && f.goodIsBetter && PROPOSALS[f.key]) out.push({ change: PROPOSALS[f.key], because: f.text });
  for (const [chip, n] of chips.slice(0, 2)) if (n >= 2 && CHIP_PROPOSALS[chip]) out.push({ change: CHIP_PROPOSALS[chip], because: `you marked ${n} photos "${chip}".` });
  const seen = new Set();
  return out.filter((p) => (seen.has(p.change) ? false : seen.add(p.change)));
}

/** What the week's generations cost: { n, zar, estimatedZar, perPhoto }. Pure. */
export function weekSpend(genlogs, now) {
  const week = (genlogs || []).filter((g) => g && Number(g.at) >= now - WEEK_MS);
  const cost = (g) => (Number.isFinite(Number(g.costZar)) ? Number(g.costZar) : 0);
  const total = week.reduce((a, g) => a + cost(g), 0);
  return { n: week.length, zar: total, estimatedZar: week.filter((g) => g.costEstimated).reduce((a, g) => a + cost(g), 0), perPhoto: week.length ? total / week.length : null,
    seconds: median(week.map((g) => (g.timing?.requestMs != null ? g.timing.requestMs / 1000 : NaN))) };
}

/**
 * The whole report. Pure.
 * → { subject, body, images: [{ code, url, tier }], rows, findings, proposals }
 */
export function learningReport({ decisions, genlogs, now = Date.now(), imagesPerTier = 5 }) {
  const rows = joinRows(decisions, genlogs);
  const found = findings(rows);
  const chips = chipCounts(rows);
  const props = proposals(found, chips);
  const spend = weekSpend(genlogs, now);
  const count = (t, since = 0) => rows.filter((r) => r.tier === t && r.at >= since).length;
  const week = now - WEEK_MS;
  const L = ["Junid,", ""];
  L.push(`Your photos this week: ${count("loved", week)} loved ❤, ${count("approved", week)} approved, ${count("rejected", week)} marked not right.`);
  L.push(`So far: ${count("loved")} loved, ${count("approved")} approved, ${count("rejected")} marked not right.`);
  L.push(spend.n
    ? `Gemini made ${spend.n} photo${spend.n === 1 ? "" : "s"} this week for ${zar(spend.zar)}${spend.estimatedZar > 0 ? ` (of which ~${zar(spend.estimatedZar)} is an estimate)` : ""} — ${zar(spend.perPhoto)} a photo${spend.seconds != null ? `, about ${Math.round(spend.seconds)} seconds each` : ""}.`
    : "Gemini made no photos this week.");
  L.push("", "WHAT STANDS OUT (up to three things)");
  found.forEach((f, i) => L.push(`${i + 1}. ${f.text}`));
  L.push("");

  const pick = (t) => rows.filter((r) => r.tier === t).sort((a, b) => b.at - a.at).slice(0, imagesPerTier);
  const images = [];
  for (const t of ["loved", "rejected"]) {
    const list = pick(t);
    L.push(`${t === "loved" ? "LOVED ❤" : "MARKED NOT RIGHT"} — the ${list.length} most recent (attached, named by their code)`);
    if (!list.length) L.push("  none yet");
    for (const r of list) {
      const how = [FIELDS.find((f) => f.key === "method").get(r), FIELDS.find((f) => f.key === "setup").get(r)].filter(Boolean).join(", with ");
      L.push(`  ${r.code || "(no code)"}${how ? ` — ${how}` : ""}${r.reasons.length ? ` — you said: ${[...new Set(r.reasons)].join(", ")}` : ""}`);
      if (r.log?.thoughts) L.push(`     Gemini said (${THOUGHTS_LABEL.toLowerCase()}): "${String(r.log.thoughts).replace(/\s+/g, " ").slice(0, 220)}${r.log.thoughts.length > 220 ? "…" : ""}"`);
      if (r.gen?.url) images.push({ code: r.code || `${r.pid}-${r.genId}`, url: r.gen.url, tier: t });
    }
    L.push("");
  }

  L.push("WHAT YOU SAID WAS NOT RIGHT");
  if (!chips.length) L.push("  no feedback chips used yet");
  for (const [chip, n] of chips) L.push(`  ${chip}: ${n}`);
  L.push("");

  L.push("PROPOSED CHANGES TO THE INSTRUCTIONS GEMINI GETS — NOT APPLIED. Nothing changes unless you say yes.");
  if (!props.length) L.push("  none this week — nothing separates the loved photos from the others clearly enough yet");
  for (const p of props) L.push(`  • ${p.change}`, `    because: ${p.because}`);

  const subject = `New Arrivals photos this week: ${count("loved", week)} loved, ${count("rejected", week)} not right (${new Date(now).toISOString().slice(0, 10)})`;
  return { subject, body: L.join("\n"), images, rows, findings: found, proposals: props, spend };
}
