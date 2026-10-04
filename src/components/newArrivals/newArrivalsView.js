// ─── NEW ARRIVALS CARD — pure presentation helpers ───────────────────────────
// No Firebase, no React: what each item SAYS, decided here and unit-tested.
// The shapes come from functions/newArrivals/core.cjs (queue), the photo studio
// function (generation) and the Mac mini's chain. Any field may be absent —
// RTDB drops empty arrays and objects — so every reader here tolerates absence.

// ONE PLACE TO GENERATE AND APPROVE (owner, 3 Oct night): two tabs. New
// holds every item not yet approved (the lanes new, generating, ready and
// rejected, merged — a lane never moves an item between tabs or hides it);
// a generation lands ON THE SAME CARD. Done is the history.
export const TABS = [
  { key: "new", label: "New" },
  { key: "done", label: "Done" },
];
/** The lanes the New tab shows (mirror of functions/newArrivals/core.cjs NEW_LANES). */
export const NEW_LANES = ["new", "generating", "ready", "rejected"];
// An older link / default asked for Ready or Rejected: both are New now.
const LEGACY_TABS = { ready: "new", rejected: "new" };
/** The tab to show for a requested one; New for anything unknown. Pure. */
export function normalizeTab(t) {
  if (TABS.some((x) => x.key === t)) return t;
  return LEGACY_TABS[t] || "new";
}
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
// uncategorised unless it is clearly footwear. New is grouped (the tab Junid
// acts in); Done is the whole history, ungrouped.
export const GROUPS = [
  { key: "sneakers", label: "Sneakers" },
  { key: "clothing", label: "Clothing" },
];
export const GROUP_TABS = ["new"];
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
  // An older derived photo (a framing correction of an earlier one, no new
  // generation) is labelled so; its few cents are never read as a photo's cost.
  const tag = gen?.derivedFrom ? "adjusted copy · " : "";
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

// Mirror of core.cjs requestPending: the photo studio's own request (stamped
// studio) older than this is a run that died and holds nothing back; any other
// request counts as pending until it is cleared.
export const REQUEST_STALE_MS = 10 * 60 * 1000;
/** Is a new photo being generated for this item (lane generating, or a live request)? Pure. */
export function isGenerating(item, nowMs = Date.now()) {
  if (item?.status === "generating") return true;
  const r = item?.generateRequest;
  if (!NEW_LANES.includes(item?.status) || !r) return false;
  if (r.studio !== true) return true;
  const at = Number(r.at) || 0;
  return !(at > 0 && nowMs - at > REQUEST_STALE_MS);
}
/** Does this New-tab item have a finished photo to approve? Pure. */
export function hasPhoto(item) {
  // The main photo, or (an older item whose URL was cleared) its current generation's — as the server sorts it.
  const cur = item?.currentGen && item?.generations?.[item.currentGen];
  return NEW_LANES.includes(item?.status) && !!(item?.generatedUrl || cur?.url);
}
/** "photo" | "generating" | "none" — the New tab's three buckets (server orders by them). Pure. */
export function photoBucket(item) {
  if (isGenerating(item)) return "generating";
  return hasPhoto(item) ? "photo" : "none";
}

/** Can Junid make this generation the main photo ("Use this one")? Pure. */
export function canPick(item, gen) {
  return NEW_LANES.includes(item?.status) && !!gen?.url && gen.genId !== currentGenId(item);
}
/** "Use this one" is shown but waits while a new photo is being generated. Pure. */
export function pickEnabled(item) {
  return !isGenerating(item);
}
// LEARNING LOG (3 Oct evening): every generation has a permanent code
// ("G-0042", set by the poster) printed under its image; one with no code yet
// shows nothing — never a placeholder.
/** The generation's permanent code, or null. Pure. */
export function genCode(gen) {
  const c = typeof gen?.code === "string" ? gen.code.trim() : "";
  return c || null;
}
// HOW GEMINI DID IT (3 Oct): every coded generation has a toggle that loads,
// on open only, Gemini's own summary of its thinking (verbatim) and its drafts
// (functions/newArrivals/core.cjs howView). The label is shown with it, always.
export const THOUGHTS_LABEL = "Gemini's own account — not proof";
export const HOW_NONE_TEXT = "Nothing was recorded for this photo.";
/** Does this generation carry the "How Gemini did it" toggle? Pure. */
export const canHow = (gen) => genCode(gen) !== null;

// THE METHOD (3 Oct): "split" = Gemini makes the product only, code places it
// on the real plate; "full" = Gemini makes the whole photo (the old method).
// The poster's default is its config; the card only sets the per-item override.
/** Is this item set to "Full Gemini"? Pure. */
export const isFullGemini = (item) => item?.method === "full";
/** The method this item's NEXT photo will use: its own choice, else the poster's default. Pure. */
export const effectiveMethod = (item, defaultMethod = "full") => (item?.method === "full" || item?.method === "split" ? item.method : defaultMethod === "split" ? "split" : "full");
/** What a tap on `choice` writes: the default clears the override (null), anything else is set. Pure. */
export const methodToSet = (choice, defaultMethod = "full") => (choice === (defaultMethod === "split" ? "split" : "full") ? null : choice);
export const METHOD_CHOICES = Object.freeze([{ key: "split", label: "Split" }, { key: "full", label: "Full Gemini" }]);
/** How one photo was made, as a small label, or null. Pure. */
export function methodMadeText(gen) {
  if (gen?.method === "split") return "made: product by Gemini, placed by code";
  if (gen?.method === "full") return "made: full Gemini";
  return null;
}
/** The tabs whose cards carry the "Full Gemini" control. */
export const METHOD_TABS = ["new"];

/** The tabs whose generations carry the ❤ Love toggle. */
export const LOVE_TABS = ["new", "done"];
/** Can Junid ❤ this generation here? Pure. */
export function canLove(tab, gen) {
  return LOVE_TABS.includes(tab) && !!gen?.url;
}
/** Is this generation loved? Pure. */
export const isLoved = (gen) => gen?.loved === true;

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

/** One line under the item: what it waits for. On New: photo ready, generating, or no photo yet. */
export function statusLine(item) {
  const s = item?.status;
  if (NEW_LANES.includes(s)) {
    // Generation is Junid's call (calibration): nothing is generated until he taps Generate.
    if (isGenerating(item)) return "Generating…";
    if (hasPhoto(item)) return "Photo ready — approve";
    // A failed generation is never retried on its own — the card says so and waits for a tap.
    if (item?.lastAttempt?.failed === true) return `Last photo failed: ${item.lastAttempt.reason || "tap Generate again"}`;
    return "Waiting — tap Generate when you want its photo";
  }
  if (s === "skipped") return "Skipped — not advertised";
  if ((s === "approved" || s === "chaining") && item?.naming?.status === "pending" && !item?.chain?.name) return "Approved — the Shopify name is being made";
  if (s === "approved") return "Approved — publishing will start in a minute";
  if (s === "chaining" && item?.chain?.waiting?.for === "retail price") return "Shopify waits for a retail price — the groups are posted at the stock price meanwhile";
  // A step that cannot go on is NOTED — Junid's approval stands (4 Oct).
  if (s === "chaining" && item?.chain?.stuck) return `Approved — waiting at "${item.chain.stuck.step}": ${item.chain.stuck.reason}`;
  if (s === "chaining") return chainProgress(item);
  if (s === "done") return item?.soldOutBeforePosting ? "Sold out before posting" : "Done";
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

/** A rejection on a New-tab item, as a LABEL (it never moves or hides the item), or null. Pure. */
export function rejectionLabel(item) {
  return NEW_LANES.includes(item?.status) && item?.rejection ? rejectionText(item) : null;
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
 * Which buttons an item shows — by PHOTO PRESENCE, never by lane or verdict
 * (owner, 3 Oct night). Any item with a generated photo shows Approve (the
 * main / selected photo); it is ENABLED only with a stock price and no new
 * photo being generated — approveWhy says why not ("add stock price first",
 * "generating…"). With no photo: Generate (`generateRegenerate` when the
 * lane needs the regenerate flag). The checker's verdict never gates anything.
 */
export function actionsFor(item) {
  const s = item?.status;
  const lane = NEW_LANES.includes(s);
  const priced = Number(item?.product?.stockPrice) > 0;
  const generating = isGenerating(item);
  const photo = hasPhoto(item);
  // A photo made from a product photo that has since been replaced is never approved: Regenerate first.
  const outdated = photo && item?.sourceChanged === true;
  const approveWhy = !photo ? null : generating ? "generating…" : outdated ? "the product's photo changed — regenerate first" : !priced ? "add stock price first" : null;
  return {
    approve: photo,
    approveEnabled: photo && !generating && priced && !outdated,
    approveWhy,
    generate: lane && !photo && !generating,
    // Lane rejected / ready without a photo: the server needs the regenerate flag.
    generateRegenerate: lane && !photo && s !== "new",
    regenerate: photo && !generating,
    reject: photo && !generating,
    skip: lane && s !== "generating",
  };
}

/** The tabs whose cards carry the two price fields (Done is history). */
export const PRICE_TABS = ["new"];
/** A price as the field shows it: the stored number, or empty. Pure. */
export const priceField = (v) => (Number(v) > 0 ? String(Number(v)) : "");
/**
 * Only the fields Junid changed from what the card showed: { stockPrice?, retailPrice? }.
 * An emptied field is NOT a change — on this card an empty field means "leave
 * it", never "clear the real price" (the admin price editor clears). Pure.
 */
export function changedPrices(product, stockDraft, retailDraft) {
  const out = {};
  const stock = String(stockDraft ?? "").trim(), retail = String(retailDraft ?? "").trim();
  if (stock !== "" && stock !== priceField(product?.stockPrice)) out.stockPrice = stock;
  if (retail !== "" && retail !== priceField(product?.retailPrice)) out.retailPrice = retail;
  return out;
}

// ── THE CARD'S OWN STATE: what a tap shows before the server has answered ────
// Every tap changes the card at once; these say how — the part of the server's
// change the card shows (functions/newArrivals: selectFields, lovedItem, the
// admin price save). Each has a REVERT that undoes only what that tap changed,
// on the item as it is by then: a failed write never wipes a later tap.
const copyFrom = (cur, was, keys) => {
  const next = { ...cur };
  for (const k of keys) { if (was?.[k] === undefined) delete next[k]; else next[k] = was[k]; }
  return next;
};

/** A generation that has just started, as the card shows it. Pure. */
export const liveStart = (at) => ({ status: "Starting…", thoughts: "", drafts: [], startedAt: at });

/** One progress event from the photo studio folded into the live view. Pure. */
export function foldLive(live, ev) {
  if (!ev || typeof ev !== "object") return live;
  if (ev.type === "status" && ev.text) return { ...live, status: String(ev.text) };
  if (ev.type === "thought" && ev.text) return { ...live, status: "Gemini is thinking…", thoughts: live.thoughts + String(ev.text) };
  if (ev.type === "draft" && ev.url) return live.drafts.includes(ev.url) ? live : { ...live, status: "Gemini is drawing…", drafts: [...live.drafts, String(ev.url)] };
  return live;
}

/** The item after "Use this one" on `genId`. Pure. */
export function afterPick(item, genId) {
  const gen = item?.generations?.[genId];
  if (!gen?.url) return item;
  const next = { ...item, currentGen: genId, generatedUrl: gen.url, generatedPath: gen.path || null };
  delete next.verdict;
  return next;
}

/** The item after a ❤ / un-❤ of `genId`. Pure. */
export function afterLove(item, genId, loved, at) {
  const gen = item?.generations?.[genId];
  if (!gen) return item;
  const g = { ...gen };
  if (loved) { g.loved = true; g.lovedAt = at; } else { delete g.loved; delete g.lovedAt; }
  return { ...item, generations: { ...item.generations, [genId]: g } };
}

/** The item after a price save of `drafts` (text; an empty field is left alone). Pure. */
export function afterPrices(item, drafts) {
  const product = { ...(item?.product || {}) };
  for (const f of ["stockPrice", "retailPrice"]) {
    const t = String(drafts?.[f] ?? "").trim();
    if (t !== "" && Number(t) > 0) product[f] = Number(t);
  }
  return { ...item, product };
}

const less = (n) => (Number.isFinite(n) ? Math.max(0, n - 1) : n);
const more = (n) => (Number.isFinite(n) ? n + 1 : n);
/**
 * The list after an item leaves the New tab (Approve → `toTab` "done"; Skip →
 * null): the item gone, the counts moved with it. Pure.
 */
export function withoutItem(data, pid, { group = null, toTab = null } = {}) {
  const items = data.items || [];
  if (!items.some((i) => i.pid === pid)) return data;
  const tabCounts = { ...(data.tabCounts || {}), new: less(data.tabCounts?.new) };
  if (toTab) tabCounts[toTab] = more(data.tabCounts?.[toTab]);
  return {
    ...data, items: items.filter((i) => i.pid !== pid), total: less(data.total), tabCounts,
    groupCounts: data.groupCounts && group ? { ...data.groupCounts, [group]: less(data.groupCounts[group]) } : data.groupCounts,
  };
}
/** The list with a departed item back in its place, and the counts with it. Pure. */
export function withItemBack(data, { item, index, toTab = null }, { group = null } = {}) {
  const items = data.items || [];
  if (items.some((i) => i.pid === item.pid)) return data;
  const at = Math.max(0, Math.min(Number.isFinite(index) && index >= 0 ? index : 0, items.length));
  const tabCounts = { ...(data.tabCounts || {}), new: more(data.tabCounts?.new) };
  if (toTab) tabCounts[toTab] = less(data.tabCounts?.[toTab]);
  return {
    ...data, items: [...items.slice(0, at), item, ...items.slice(at)], total: more(data.total), tabCounts,
    groupCounts: data.groupCounts && group ? { ...data.groupCounts, [group]: more(data.groupCounts[group]) } : data.groupCounts,
  };
}

/** Undo a "Use this one" of `genId` — only if that photo is still the card's. Pure. */
export const revertPick = (was, genId) => (cur) => (cur?.currentGen === genId ? copyFrom(cur, was, ["currentGen", "generatedUrl", "generatedPath", "verdict"]) : cur);
/** Undo a ❤ / un-❤ of `genId` — back to how that generation was. Pure. */
export const revertLove = (was, genId) => (cur) => {
  const gen = cur?.generations?.[genId];
  if (!gen) return cur;
  return { ...cur, generations: { ...cur.generations, [genId]: copyFrom(gen, was?.generations?.[genId], ["loved", "lovedAt"]) } };
};
/** Undo a price save of `drafts` — only the fields still showing what that save put there. Pure. */
export const revertPrices = (was, drafts) => (cur) => {
  const product = { ...(cur?.product || {}) };
  for (const f of ["stockPrice", "retailPrice"]) {
    const t = String(drafts?.[f] ?? "").trim();
    if (t === "" || product[f] !== Number(t)) continue;
    if (was?.product?.[f] === undefined) delete product[f]; else product[f] = was.product[f];
  }
  return { ...cur, product };
};
/** Undo a method choice — only if it is still the one chosen. Pure. */
export const revertMethod = (was, choice) => (cur) => (cur?.method === choice ? copyFrom(cur, was, ["method"]) : cur);

/** The server's item after a generation, merged onto the card: the card keeps its product and stock lines. Pure. */
export const afterGenerated = (cur, item) => ({ sourceUrl: cur.sourceUrl, ...item, product: cur.product, availableSizes: cur.availableSizes, totalUnits: cur.totalUnits, stockKnown: cur.stockKnown });

/**
 * The photo shown as "Original": the product's CURRENT source photo as the
 * server read it (`sourceUrl`). Only an answer from an older server (no
 * sourceUrl) falls back to the product's own fields — and the item's old pin
 * (`originalUrl`) comes LAST: it is the copy that went stale. Pure.
 */
export const sourceUrlOf = (item) => item?.sourceUrl || item?.product?.photoUrlOriginal || item?.product?.photoUrl || item?.originalUrl || null;

/** "Nike AF1: …" — every message names its item (several can be at work at once). Pure. */
export const named = (item, text) => {
  const name = String(item?.product?.name || item?.name || "").trim();
  return name ? `${name.length > 34 ? `${name.slice(0, 33)}…` : name}: ${text}` : text;
};
