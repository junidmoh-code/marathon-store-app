// ─── NEW ARRIVALS CARD — pure presentation helpers ───────────────────────────
// No Firebase, no React: what each item SAYS, decided here and unit-tested.
// The shapes come from functions/newArrivals/core.cjs (queue) and the Mac mini
// agents (generation, chain, posting). Any field may be absent — RTDB drops
// empty arrays and objects — so every reader here tolerates absence.

export const TABS = [
  { key: "new", label: "New" },
  { key: "ready", label: "Ready" },
  { key: "rejected", label: "Rejected" },
  { key: "done", label: "Done" },
  { key: "skipped", label: "Skipped" },
];

// Mirror of functions/newArrivals/core.cjs REJECT_CHIPS — the exact strings
// the ledger records (calibration contract). One tap, no typing.
export const REJECT_CHIPS = ["background wrong", "colour off", "detail changed", "looks fake/CGI", "framing", "box wrong", "blurry"];

// The New tab's one-tap filters → the callable's filter object.
// Category chips map onto the plate classes (core.cjs filterClassOf):
// sneakers = footwear except slides/sandals · slides = slides + sandals ·
// clothing = single garments · two-piece = tracksuits.
export const FILTER_CHIPS = [
  { key: "oneSize", label: "1 size only" },
  { key: "sneakers", label: "Sneakers", cls: true },
  { key: "slides", label: "Slides", cls: true },
  { key: "clothing", label: "Clothing", cls: true },
  { key: "twopiece", label: "Two-piece", cls: true },
  { key: "noStockPrice", label: "No stock price" },
];
/** Toggle a chip in the filter; the category chips are exclusive. Pure. */
export function toggleFilter(filter, key) {
  const f = { ...(filter || {}) };
  const chip = FILTER_CHIPS.find((c) => c.key === key);
  if (!chip) return f;
  if (chip.cls) {
    if (f.cls === key) delete f.cls; else f.cls = key;
  } else if (f[key]) delete f[key]; else f[key] = true;
  return f;
}
export const chipOn = (filter, key) => {
  const chip = FILTER_CHIPS.find((c) => c.key === key);
  return chip?.cls ? filter?.cls === key : !!filter?.[key];
};
export const filterActive = (filter) => !!filter && Object.keys(filter).length > 0;

export const CLASS_LABELS = { footwear: "Footwear", single: "Clothing", twopiece: "Two-piece" };
/** "83%" or "—" for one class, from new_arrivals/stats. Pure. */
export function agreementText(stats, cls) {
  const pct = stats?.agreement?.[cls]?.pct;
  return pct === null || pct === undefined || !Number.isFinite(Number(pct)) ? "—" : `${Math.round(Number(pct))}%`;
}

/** The header's reject-rate line: Junid's rejects, top reasons, cost per finished photo. Pure. */
export function rejectRateText(stats) {
  const r = stats?.rejectRate;
  const pct = Number(r?.pct);
  const parts = [];
  if (r && Number.isFinite(pct) && Number(r.n) > 0) {
    const top = Object.entries(r.byReason || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ");
    parts.push(`Rejected ${Math.round(pct)}% of ${r.n} (target under 15%)${top ? ` — ${top}` : ""}`);
  } else parts.push("Rejected —");
  const c = Number(stats?.costPerFinishedZar);
  parts.push(Number.isFinite(c) && c > 0 ? `R${c.toFixed(2)} per finished photo` : "cost per finished photo —");
  return parts.join(" · ");
}

/** Every paid generation, newest first, as [{ genId, ...gen }]. Pure. */
export function generationsOf(item) {
  const g = item?.generations;
  if (!g || typeof g !== "object") return [];
  return Object.entries(g).filter(([, v]) => v && typeof v === "object")
    .map(([genId, v]) => ({ genId, ...v }))
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0) || (a.genId < b.genId ? 1 : -1));
}

export function costText(gen) {
  const zar = Number(gen?.costZar);
  if (Number.isFinite(zar) && gen?.costZar != null) return `R${zar.toFixed(2)}`;
  const usd = Number(gen?.costUsd);
  if (Number.isFinite(usd) && gen?.costUsd != null) return `$${usd.toFixed(2)}`;
  return "cost unknown";
}

/** Sum of every generation's cost in rand (null when none is known). Pure. */
export function totalCostZar(item) {
  const known = generationsOf(item).map((g) => Number(g.costZar)).filter((n) => Number.isFinite(n));
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** The checker's verdict as a label — it never blocks anything. Pure. */
export function verdictText(verdict) {
  if (!verdict || typeof verdict !== "object") return null;
  if (verdict.pass === true) return "Checker: pass";
  const failed = Array.isArray(verdict.failed) ? verdict.failed : Object.values(verdict.failed || {});
  const what = verdict.label || failed.join(", ");
  return what ? `Checker: failed — ${what}` : "Checker: failed";
}

/** "In stock: 7 · 8 — 3 units", or that no stock is recorded. Pure. */
export function stockText(item) {
  if (!item?.stockKnown && !(Number(item?.totalUnits) > 0)) return "No stock recorded";
  const sizes = Array.isArray(item?.availableSizes) ? item.availableSizes : Object.values(item?.availableSizes || {});
  const units = Number(item?.totalUnits) || 0;
  return `In stock: ${sizes.length ? sizes.join(" · ") : "no sizes"} — ${units} ${units === 1 ? "unit" : "units"}`;
}

export const MAX_ATTEMPTS = 3;

const SAST = "Africa/Johannesburg";
export function whenText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Intl.DateTimeFormat("en-ZA", { timeZone: SAST, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(n));
}

export function priceText(price) {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 ? `R${Math.round(n)}` : "No price";
}

export function sizesText(sizes) {
  const list = (Array.isArray(sizes) ? sizes : Object.values(sizes || {})).filter((s) => s !== null && s !== undefined && s !== "");
  return list.length ? list.join(" · ") : "No sizes";
}

/** One line under the item: where it is in its lane. */
export function statusLine(item) {
  const s = item?.status;
  // Generation is Junid's call (calibration): nothing is generated until he taps Generate.
  if (s === "new") return item?.generateRequest ? "Generate requested — the generator will take it shortly" : "Waiting — tap Generate when you want its photo";
  if (s === "skipped") return "Skipped — not advertised (Restore brings it back to New)";
  if (s === "generating") return "Generating the photo now…";
  if (s === "ready") return Number(item?.product?.stockPrice) > 0
    ? "Photo checked — waiting for your Approve"
    : "Photo checked — needs a stock price before approving";
  if (s === "approved") return "Approved — publishing will start in a minute";
  if (s === "chaining" && item?.chain?.waiting?.for === "retail price") return "Shopify waits for a retail price — the groups are posted at the stock price meanwhile";
  if (s === "chaining") return chainProgress(item);
  if (s === "done") return item?.soldOutBeforePosting ? "Sold out before posting" : "Done";
  if (s === "rejected") return rejectionText(item);
  return "";
}

const CHAIN_STEPS = [
  ["photo", "photo set"], ["name", "name accepted"], ["condition", "condition Excellent"],
  ["publish", "approved for Shopify"], ["shopify", "live on Shopify"],
];
export function chainProgress(item) {
  const chain = item?.chain || {};
  const doneSteps = CHAIN_STEPS.filter(([k]) => chain[k]?.at).map(([, label]) => label);
  const next = CHAIN_STEPS.find(([k]) => !chain[k]?.at);
  if (!doneSteps.length) return "Publishing…";
  return `${doneSteps.join(" · ")}${next ? ` — next: ${next[1]}` : ""}`;
}

export function rejectionText(item) {
  const r = item?.rejection || {};
  const reason = r.reason || "Rejected";
  if (r.code === "junid") return `You rejected it: ${reason}`;
  // Nothing regenerates by itself any more: an older automatic rejection waits for Junid.
  if (r.code === "checker" || r.code === "generation") return `${reason} — tap Regenerate for a fresh attempt`;
  return reason;
}

/** Done tab: where the item went, and when. One line per destination. */
/** The Shopify name line on a card: the suggestion, or why there is none yet. */
export function shopifyNameLine(item) {
  // The name actually APPLIED by the chain wins; then the suggestion.
  if (item?.chain?.name?.name) return `Shopify name: ${item.chain.name.name}`;
  if (item?.suggestedName) return `Shopify name: ${item.suggestedName}`;
  if (item?.naming?.status === "pending") return "Shopify name: naming pending";
  if (item?.naming?.status === "failed") return `Shopify name: ${item.naming.reason || "could not be named"}`;
  return null;
}

export function destinationLines(item) {
  const d = item?.destinations || {};
  const out = [];
  if (d.shopify?.at) out.push(`Shopify — live ${whenText(d.shopify.at)}${d.shopify.title ? ` as “${d.shopify.title}”` : ""}`);
  else if (item?.naming?.status === "pending" && item?.approvedAt) out.push("Shopify — waiting for its name (the groups don't wait)");
  else if (item?.naming?.status === "failed" && item?.approvedAt) out.push(`Shopify — not published: ${item.naming.reason || "could not be named"}`);
  else if (item?.status === "chaining" || item?.status === "approved") out.push("Shopify — publishing");
  if (item?.soldOutBeforePosting?.at) out.push(`WhatsApp groups — not posted: sold out before the ${item.soldOutBeforePosting.window || ""} window`.replace("  ", " "));
  else if (d.groups?.at) out.push(`WhatsApp — ${d.groups.count || 0} groups, ${whenText(d.groups.at)}`);
  else if (item?.approvedAt) out.push("WhatsApp — next posting window");
  if (d.social?.at) out.push(`Instagram & Facebook — carousel ${whenText(d.social.scheduledAt || d.social.at)}`);
  return out;
}

// THE GROUPS' PRICE IS THE STOCK PRICE (Junid, 3 Oct: he sells to traders).
// Retail is Shopify's business only and is never shown for the groups.
/** Does this item still need a stock price (the only price the card asks for)? Pure. */
export function needsStockPrice(product) {
  const v = product?.stockPrice;
  return v == null || v === "" || !(Number(v) > 0);
}

/**
 * Which buttons an item shows. Approve (and Approve anyway) need a generated
 * photo and a stock price; the checker's verdict never gates anything.
 */
export function actionsFor(item) {
  const s = item?.status;
  const priced = Number(item?.product?.stockPrice) > 0;
  return {
    approve: s === "ready" && !!item?.generatedUrl && priced,
    approveAnyway: s === "rejected" && !!item?.generatedUrl && priced,
    generate: s === "new" && !item?.generateRequest,
    regenerate: s === "ready" || s === "rejected",
    reject: s === "ready",
    skip: s === "new" || s === "rejected",
    restore: s === "skipped",
  };
}
