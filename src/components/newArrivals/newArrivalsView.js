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
  const tries = Number(item?.attemptsSinceRetry) || 0;
  if (s === "new") return tries ? `Waiting for a fresh attempt (${tries} of ${MAX_ATTEMPTS} used)` : "Waiting for its photo to be generated";
  if (s === "generating") return "Generating the photo now…";
  if (s === "ready") return Number(item?.product?.retailPrice) > 0
    ? "Photo checked — waiting for your Approve"
    : "Photo checked — set a retail price in the app before approving";
  if (s === "approved") return "Approved — publishing will start in a minute";
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
  const tries = Number(item?.attemptsSinceRetry) || 0;
  if (r.code === "checker" || r.code === "generation") {
    return tries >= MAX_ATTEMPTS
      ? `${reason} — ${MAX_ATTEMPTS} attempts failed; it stays here until you tap Retry`
      : `${reason} — a fresh attempt runs automatically (${tries} of ${MAX_ATTEMPTS} used)`;
  }
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

/** Which buttons an item shows. Approve only with a checked, generated photo. */
export function actionsFor(item) {
  return {
    approve: item?.status === "ready" && !!item?.generatedUrl && Number(item?.product?.retailPrice) > 0,
    retry: item?.status === "rejected",
  };
}
