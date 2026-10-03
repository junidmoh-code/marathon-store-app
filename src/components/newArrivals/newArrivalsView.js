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
];
// No Skipped tab (owner, 3 Oct): "Skip — don't advertise" is one tap with an
// 8-second Undo. A skipped item stays in the data (status "skipped") — the
// generator, the chain and the posters all leave it alone.
export const UNDO_MS = 8000;

// Mirror of functions/newArrivals/core.cjs REJECT_CHIPS — the exact strings
// the ledger records (calibration contract). One tap, no typing.
export const REJECT_CHIPS = ["background wrong", "colour off", "detail changed", "looks fake/CGI", "framing", "box wrong", "blurry"];

// ONE switcher bar instead of filter chips (owner, 3 Oct): exactly TWO groups,
// decided server-side from the category (functions/newArrivals/core.cjs
// groupOf): Sneakers = all footwear; Clothing = everything else, and anything
// uncategorised unless it is clearly footwear. New, Ready and Rejected are
// grouped (the tabs Junid acts in); Done is the whole history, ungrouped.
export const GROUPS = [
  { key: "sneakers", label: "Sneakers" },
  { key: "clothing", label: "Clothing" },
];
export const GROUP_TABS = ["new", "ready", "rejected"];
export const DEFAULT_GROUP = "sneakers";
export const GROUP_STORAGE_KEY = "newArrivals.group";
export const isGroupTab = (tab) => GROUP_TABS.includes(tab);
export const groupLabel = (key) => (GROUPS.find((g) => g.key === key) || GROUPS[0]).label;
/** The group one step left (-1) or right (+1), or null at an end. Pure. */
export function stepGroup(key, dir) {
  const i = GROUPS.findIndex((g) => g.key === key);
  const j = (i < 0 ? 0 : i) + dir;
  return j >= 0 && j < GROUPS.length ? GROUPS[j].key : null;
}
/** The last group on this device; Sneakers when none (or storage throws). */
export function rememberedGroup(storage) {
  try {
    const g = storage ? storage.getItem(GROUP_STORAGE_KEY) : null;
    return GROUPS.some((x) => x.key === g) ? g : DEFAULT_GROUP;
  } catch { return DEFAULT_GROUP; }
}
export function rememberGroup(storage, key) {
  try { if (storage) storage.setItem(GROUP_STORAGE_KEY, key); } catch { /* private mode: not remembered */ }
}

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

// COSTS (contract, 3 Oct card fixes): every Gemini call has a cost in rand.
// A metered cost reads "R2.38"; a list-price estimate "~R2.41 (estimated)".
// A generation with no cost recorded at all (before the poster's backfill)
// is shown at the model's list price for one 2K image, estimated — never
// "cost unknown".
export const DEFAULT_ESTIMATE_PER_GENERATION_ZAR = 2.41;
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const fin = (v) => Number.isFinite(num(v));
/** The list-price estimate of one generation, in rand (stats, else the default). Pure. */
export function estimatePerGenerationZar(stats) {
  const e = num(stats?.estimatePerGenerationZar);
  return Number.isFinite(e) && e > 0 ? e : DEFAULT_ESTIMATE_PER_GENERATION_ZAR;
}
/** One generation's cost: { zar, estimated }. Never unknown. Pure. */
export function genCost(gen, stats) {
  if (fin(gen?.costZar)) return { zar: num(gen.costZar), estimated: gen.costEstimated === true };
  // Dollars only: converted at the generation's own rate, else today's (an estimate).
  if (fin(gen?.costUsd)) {
    const own = num(gen.usdZar);
    const rate = Number.isFinite(own) && own > 0 ? own : num(stats?.usdZar);
    if (Number.isFinite(rate) && rate > 0) return { zar: num(gen.costUsd) * rate, estimated: gen.costEstimated === true || !(own > 0) };
  }
  return { zar: estimatePerGenerationZar(stats), estimated: true };
}
const randText = ({ zar, estimated }) => (estimated ? `~R${zar.toFixed(2)} (estimated)` : `R${zar.toFixed(2)}`);

export function costText(gen, stats = null) {
  // A RE-CHECK (a framing correction of an earlier photo — vision only, no new
  // generation) is labelled so; its few cents are never read as a photo's cost.
  const tag = gen?.derivedFrom ? "re-check, no new generation · " : "";
  return `${tag}${randText(genCost(gen, stats))}`;
}

/** Every generation's cost, re-checks included: { zar, estimated } (null with none). Pure. */
export function totalCost(item, stats = null) {
  const gens = generationsOf(item);
  if (!gens.length) return null;
  const parts = gens.map((g) => genCost(g, stats));
  return { zar: parts.reduce((a, p) => a + p.zar, 0), estimated: parts.some((p) => p.estimated) };
}
/** "R4.76 total", or "~R4.79 total" when any part is estimated. Pure. */
export function totalCostText(item, stats = null) {
  const t = totalCost(item, stats);
  return t ? `${t.estimated ? "~" : ""}R${t.zar.toFixed(2)} total` : null;
}
/** Sum of every generation's cost in rand, estimates included (null when none). Pure. */
export function totalCostZar(item, stats = null) {
  const t = totalCost(item, stats);
  return t ? t.zar : null;
}

/** The header's spend: every generation, re-check and other Gemini call. Pure. */
export function spentText(stats) {
  const total = num(stats?.totalSpentZar);
  if (!Number.isFinite(total)) return "Spent so far —";
  const est = num(stats?.estimatedPartZar);
  return `Spent so far R${total.toFixed(2)}${Number.isFinite(est) && est > 0 ? ` (incl. ~R${est.toFixed(2)} estimated)` : ""}`;
}

/** Can Junid make this generation the main photo ("Use this one")? Pure. */
export function canPick(item, gen) {
  return (item?.status === "ready" || item?.status === "rejected") && !!gen?.url && gen.genId !== currentGenId(item);
}
/** The generation shown big: currentGen, else the newest. Pure. */
export function currentGenId(item) {
  const gens = generationsOf(item);
  const cur = gens.find((g) => g.genId === item?.currentGen) || gens[0];
  return cur ? cur.genId : null;
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
  if (s === "skipped") return "Skipped — not advertised";
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
 * Which buttons an item shows. Approve is ALWAYS shown on Ready (owner, 3 Oct)
 * but only ENABLED with a generated photo and a stock price (approveEnabled);
 * Approve anyway (Rejected) likewise needs both. The checker's verdict never
 * gates anything.
 */
export function actionsFor(item) {
  const s = item?.status;
  const priced = Number(item?.product?.stockPrice) > 0;
  return {
    approve: s === "ready",
    approveEnabled: s === "ready" && !!item?.generatedUrl && priced,
    // Shown on every Rejected item with a photo; enabled only with a stock price.
    approveAnyway: s === "rejected" && !!item?.generatedUrl,
    approveAnywayEnabled: s === "rejected" && !!item?.generatedUrl && priced,
    generate: s === "new" && !item?.generateRequest,
    regenerate: s === "ready" || s === "rejected",
    reject: s === "ready",
    skip: s === "new" || s === "rejected",
  };
}

/** The tabs whose cards carry the two price fields (Done is history). */
export const PRICE_TABS = ["new", "ready", "rejected"];
/** A price as the field shows it: the stored number, or empty. Pure. */
export const priceField = (v) => (Number(v) > 0 ? String(Number(v)) : "");
/** Only the fields Junid changed from what the card showed: { stockPrice?, retailPrice? }. Pure. */
export function changedPrices(product, stockDraft, retailDraft) {
  const out = {};
  if (String(stockDraft ?? "").trim() !== priceField(product?.stockPrice)) out.stockPrice = String(stockDraft ?? "").trim();
  if (String(retailDraft ?? "").trim() !== priceField(product?.retailPrice)) out.retailPrice = String(retailDraft ?? "").trim();
  return out;
}
