// ─── BLACK FRIDAY → THE WEBSITE FIRST (Junid, 20 Nov 2026) ───────────────────
// "Every product I approve on the Black Friday card is published on the Shopify
// website BEFORE it is posted to the WhatsApp groups."
//
// This file does NOT talk to Shopify and has no publisher of its own. It does
// what a person does on the publisher card, by calling THE SAME code the
// card's buttons call (publishMutators.js — the New Arrivals chain and the
// auto-publish agent do the same), and the existing reconciler
// (scripts/shopify/reconcile.mjs) does the Shopify side with all of its own
// checks: naming rules, compliance, duplicates, photos, live size stock.
//
// For one approved product:
//   (0) already on the website (confirmed by the reconciler)  → "live", done.
//       A New Arrival the New Arrivals chain is publishing    → left to it.
//   (1) out of stock online (the publisher's own stock rule)   → not published.
//   (2) the photo: the APPROVED photo (the one that posts) becomes the FIRST
//       photo of the publishing list and the others are kept — mediaMutator,
//       then THE primary-photo write (primaryPhotoCore.setShopifyPrimaryPhoto)
//       so the app photo follows, as Junid's photo rule requires (26 Sep /
//       19 Oct 2026). A kept photo the website would refuse (a brand word in
//       its file path) is left out; nothing is deleted.
//   (3) the name: a pending AI suggestion (applyProposalMutator), else the name
//       the card would ship (effectiveNameFor). No usable name, or the website
//       refused the last one as a duplicate → "needs-name": the runner asks the
//       store's existing namer (the poster's suggestNames) and we try again.
//   (4) condition Excellent (conditionMutator).
//   (5) publish (publishMutator → desiredState "on"); the reconciler applies it.
// Prices are never read for a decision and never written.
//
// STATE (server-only, under the campaign node; no rule changes):
//   bf_campaign_2026/webQueue/{pid}  { approvedAt, at, tryAt?, tries?, nameAt? }
//       work to do; written by bfWebQueue (functions/blackFriday/webQueue.js)
//       on every approval, removed when the product is live or can never be.
//   bf_campaign_2026/web/{pid}       { s, why?, at, approvedAt, pubAt? }
//       what the card shows: s = "live" | "pub" (publishing) | "fail" | "oos"
import { applyProposalMutator, conditionMutator, mediaMutator, publishMutator, precheck }
  from "../../src/components/shopify/publishMutators.js";
import { CONDITIONS, APP_STORAGE_PREFIX, resolveMediaList, lazyPhotoItem, storedMediaKey, mediaListProblem }
  from "../../src/components/shopify/publishShared.js";
import { effectiveNameFor, isOn, normalizedState, isPublishableProduct, proposalApplyBlocker }
  from "../../src/components/shopify/shopifyPublishCore.js";
import { isPendingProposal } from "../../src/utils/visionNaming.js";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";
import { setShopifyPrimaryPhoto } from "../../src/components/shopify/primaryPhotoCore.js";
import { writeApprovedThumbFromUrl, writeProductThumb } from "../../src/utils/productThumb.js";
import { productPhotoThumbPath } from "../../src/utils/productPhotoPaths.js";
import { hasSellableStock } from "../shopify/reviewStock.mjs";
import bfCore from "../../functions/blackFriday/core.cjs";

export const ROOT = "bf_campaign_2026";
export const WEB = `${ROOT}/web`;
export const QUEUE = `${ROOT}/webQueue`;
// Off switch: true here = nothing is published by this file (approvals still queue).
export const SWITCH_OFF = `${ROOT}/webSwitch/off`;
export const AGENT_UID = "bf-web-agent";
export const EXCELLENT = CONDITIONS[0];
// The reconciler applies at most 25 intents a run; queuing faster only builds its backlog.
export const MAX_PUBLISH_PER_RUN = 25;
export const MAX_ATTEMPTS_PER_RUN = 60;
// A product that could not go on is looked at again after this (doubling, at most 6 h).
export const RETRY_MS = 30 * 60 * 1000;
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
// The namer is asked again for the same product at most this often.
export const NAME_RETRY_MS = 2 * 60 * 60 * 1000;
// New Arrivals statuses in which the New Arrivals chain owns the publish (functions/newArrivals/core.cjs).
export const NA_CHAIN_STATUSES = Object.freeze(["approved", "chaining"]);
const COLLISION_RE = /handle|already|collid|duplicate/i;

const val = async (db, p) => (await db.ref(p).once("value")).val();

/** Wait before the next try, after `tries` failed ones. Pure. */
export function retryDelay(tries) {
  const n = Math.max(1, Number(tries) || 1);
  return Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (n - 1));
}

/** The photo an approved product posts with (the poster's approvedPhotoOf), as a URL. Pure. */
export function approvedPhotoUrl(pick, photo, product) {
  if (!pick) return null;
  if (pick.src === "na") return pick.shown || null;
  const sig = bfCore.sigOf(photo);
  if (sig !== "current") return photo.gens[sig].url || null;
  return pick.shown || product?.photoUrl || null;
}

/** A photo URL the website takes: this app's Storage, no brand word in its path. Pure. */
export function websitePhotoProblem(url) {
  if (typeof url !== "string" || !url.startsWith(APP_STORAGE_PREFIX)) return "the approved photo is not one of the app's own files";
  let path = url;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { /* checked raw */ }
  const hits = triggersInText(path);
  return hits.length ? `the approved photo's file name carries a brand word (${hits.join(", ")})` : null;
}

/**
 * The publishing list with the approved photo FIRST and every other item kept
 * in its order, except one the website would refuse. Pure.
 * → { media, changed } (changed = differs from what the node resolves to now)
 */
export function mediaWithFirst(node, product, approvedUrl) {
  const { items } = resolveMediaList(node, product);
  const first = items.find((m) => m.url === approvedUrl) || lazyPhotoItem(approvedUrl, "black-friday");
  const rest = items.filter((m) => m.url !== approvedUrl && m.id !== first.id && !websitePhotoProblem(m.url) && !(m.posterUrl && websitePhotoProblem(m.posterUrl)));
  const media = [first, ...rest];
  const changed = media.length !== items.length || media.some((m, i) => m.id !== items[i]?.id || m.url !== items[i]?.url);
  return { media, changed };
}

/** What the card shows for a product. Pure. → { s, why } */
export function webEntry(s, why = null) { return why ? { s, why: String(why).slice(0, 240) } : { s }; }

/** A button's mutator run as an Admin SDK transaction on /shopify_publish/{pid} (chainCore.decide). */
async function decide(db, pid, node, mutator, args, ctx) {
  let refusal = null;
  const res = await db.ref(`shopify_publish/${pid}`).transaction((cur) => {
    const out = mutator(cur || node || {}, args, ctx);
    if (out.refusal) { refusal = out.refusal; return undefined; }
    return out.next;
  });
  if (!res.committed) return { ok: false, message: refusal || "Not saved." };
  return { ok: true, node: res.snapshot.val() };
}

/** Sellable units online, by the publisher's own rule (reviewStock.hasSellableStock). → true | false | null */
async function inStock(db, pid, product, locNames) {
  const tree = {};
  for (const loc of locNames) {
    const cells = await val(db, `stock/${loc}/${pid}`);
    if (cells) tree[loc] = { [pid]: cells };
  }
  return hasSellableStock(tree, pid, product?.sizes);
}

/** The primary-photo write's I/O, built from the runner's raw deps (exactly as the New Arrivals chain does). */
function primaryDeps(pid, deps) {
  const { db, log = () => {} } = deps;
  return {
    now: deps.now,
    md5Of: deps.md5Of,
    rebuildThumb: (id, url) => writeApprovedThumbFromUrl(id, url, {
      download: deps.download,
      upload: deps.uploadThumb,
      remove: deps.removeObject,
      warn: (...a) => log(`${pid}: thumbnail — ${a.map(String).join(" ")}`),
      write: (tid, blob, d) => writeProductThumb(tid, blob, { ...d, encode: deps.encodeThumb }),
    }),
    removeThumb: (id) => deps.removeObject(productPhotoThumbPath(id)),
    writeProduct: (id, patch) => db.ref(`products/${id}`).update(patch),
  };
}

/**
 * Take one approved product as far as it goes now.
 * deps: { db, now: async () => serverNowMs, locNames: string[], download, uploadThumb, removeObject,
 *         encodeThumb, md5Of?, log? }
 * opts: { web } = the product's current web/{pid} entry (to judge "the website refused OUR publish")
 * → { pid, outcome, why? } where outcome is
 *   "live"       on the website — done
 *   "published"  the intent is written; the reconciler applies it on its next run
 *   "pending"    already handed to the reconciler (or the New Arrivals chain), waiting
 *   "needs-name" no usable name: ask the namer, then try again
 *   "failed"     cannot go on now (why) — try again later
 *   "oos"        out of stock online — not published
 *   "gone"       can never be published (no record, merged, not merchandise) — done
 *   "unapproved" no longer approved — done
 */
export async function publishOne(pid, deps, { web = null } = {}) {
  const { db } = deps;
  const [pick, photo] = await Promise.all([val(db, `${ROOT}/picks/${pid}`), val(db, `${ROOT}/photos/${pid}`)]);
  if (!bfCore.isApproved(pick, photo)) return { pid, outcome: "unapproved" };
  let node = await val(db, `shopify_publish/${pid}`);
  if (isOn(node)) return { pid, outcome: "live" };

  const product = await val(db, `products/${pid}`);
  if (!product) return { pid, outcome: "gone", why: "the product record no longer exists" };
  if (product.mergedInto) return { pid, outcome: "gone", why: `merged into ${product.mergedInto}` };
  if (!isPublishableProduct(product)) return { pid, outcome: "gone", why: "not merchandise (an internal price record)" };

  // Handed to the reconciler already (by us, the New Arrivals chain or anyone): wait for its verdict.
  if (node?.desiredState === "on" && normalizedState(node) !== "blocked") return { pid, outcome: "pending", why: "waiting for the website publisher" };

  // A New Arrival the New Arrivals chain is publishing: its chain does the same steps with the same
  // photo; doing them twice would leave its photo step refused ("listing is ON") for ever.
  const naStatus = await val(db, `new_arrivals/items/${pid}/status`);
  if (NA_CHAIN_STATUSES.includes(naStatus)) {
    const stuck = await val(db, `new_arrivals/items/${pid}/chain/stuck`);
    return stuck && stuck.reason
      ? { pid, outcome: "failed", why: `New Arrivals: ${String(stuck.reason)}`, na: true }
      : { pid, outcome: "pending", why: "New Arrivals is publishing it", na: true };
  }

  const blocked = normalizedState(node) === "blocked" ? String(node?.blockedReason || "refused, no reason recorded") : null;
  // The reconciler refused a publish WE wrote (pubAt survives the "fail" entry that follows it).
  const refusedOurs = !!blocked && Number(web?.pubAt) > 0;

  // (1) stock — the publisher's own rule (at least one sellable unit online).
  const stocked = await inStock(db, pid, product, deps.locNames || []);
  if (stocked === false) return { pid, outcome: "oos", why: "out of stock — not published" };
  if (stocked === null) return { pid, outcome: "failed", why: "the product has no sizes, so its stock cannot be judged" };

  // (3a) the name, decided before anything is written.
  let name, source, viaProposal = false;
  const proposalOk = isPendingProposal(node) && proposalApplyBlocker(node).ok;
  if (proposalOk) {
    name = String(node.nameProposal.name).trim(); source = "ai"; viaProposal = true;
  } else {
    // A name the website refused as a duplicate is not tried again: a new one is asked for.
    if (blocked && COLLISION_RE.test(blocked)) return { pid, outcome: "needs-name", why: `the website name is taken — ${blocked.slice(0, 160)}` };
    const eff = effectiveNameFor(product, node);
    if (!eff.name) return { pid, outcome: "needs-name", why: "no website name yet" };
    if (precheck.publish(eff.name)) return { pid, outcome: "needs-name", why: `the name "${eff.name}" cannot be used (${precheck.publish(eff.name)})` };
    name = eff.name; source = eff.source;
  }
  if (precheck.publish(name)) return { pid, outcome: "needs-name", why: `the suggested name cannot be used (${precheck.publish(name)})` };
  if (refusedOurs && !viaProposal && !/media|photo|originalSource/i.test(blocked)) {
    // Same name, same refusal: only a change (a new name, a new photo) is worth a new try.
    return { pid, outcome: "failed", why: blocked };
  }

  const ctx = async () => ({ now: await deps.now(), uid: AGENT_UID });

  // (2) the photo: approved first, the others kept.
  const approvedUrl = approvedPhotoUrl(pick, photo, product);
  if (!approvedUrl) return { pid, outcome: "failed", why: "no approved photo" };
  const bad = websitePhotoProblem(approvedUrl);
  if (bad) return { pid, outcome: "failed", why: bad };
  const { media, changed } = mediaWithFirst(node, product, approvedUrl);
  if (changed || !node?.media) {
    const problem = mediaListProblem(media);
    if (problem) return { pid, outcome: "failed", why: problem };
    const oldPrimary = resolveMediaList(node, product).items[0]?.url || null;
    const res = await decide(db, pid, node, mediaMutator, { media, basisKey: storedMediaKey(node) }, await ctx());
    if (!res.ok) return { pid, outcome: "failed", why: res.message };
    node = res.node;
    // The app photo follows the website's first photo (THE one write; never throws).
    if (product.photoUrl !== approvedUrl) {
      const app = await setShopifyPrimaryPhoto(pid, { product, oldPrimary, newPrimary: approvedUrl, fallbackOriginal: product.photoUrl || null }, primaryDeps(pid, deps));
      if (!app.ok) throw new Error(`app photo not updated: ${app.message || app.reason || "unknown"}`);
    }
  }

  // (3b) apply the suggestion exactly as its button does (pinned to the one just read).
  if (viaProposal) {
    const res = await decide(db, pid, node, applyProposalMutator, { seenProposedAt: node.nameProposal?.proposedAt ?? null }, await ctx());
    if (!res.ok) return { pid, outcome: "failed", why: `name suggestion not applied: ${res.message}` };
    node = res.node;
    name = node.cleanName; source = node.cleanNameSource;
  }

  // (4) Excellent (also lifts a refusal back to awaiting, as the chip does).
  if (node?.condition !== EXCELLENT || normalizedState(node) === "blocked") {
    const res = await decide(db, pid, node, conditionMutator, { condition: EXCELLENT }, await ctx());
    if (!res.ok) return { pid, outcome: "failed", why: res.message };
    node = res.node;
  }

  // (5) publish — the intent only; the reconciler does Shopify. Stock again first: a sale during the
  // steps above must not ship a product that has just sold out.
  if ((await inStock(db, pid, product, deps.locNames || [])) === false) return { pid, outcome: "oos", why: "out of stock — not published" };
  const res = await decide(db, pid, node, publishMutator, { name, source }, await ctx());
  if (!res.ok) return { pid, outcome: "failed", why: res.message };
  return { pid, outcome: "published", why: name };
}

/** The card's entry for an outcome (null = remove it). Pure. */
export function entryFor(r, prevWeb = null) {
  switch (r.outcome) {
    case "live": return webEntry("live");
    case "published": return webEntry("pub");
    case "pending": return webEntry("pub", r.why);
    case "needs-name": return webEntry("pub", "waiting for a website name");
    case "oos": return webEntry("oos", r.why);
    case "failed": case "gone": return webEntry("fail", r.why);
    case "error": return prevWeb && prevWeb.s ? null : webEntry("pub");
    case "unapproved": return null;
    default: return null;
  }
}

/** Is the queue entry finished with this outcome (removed from the queue)? Pure. */
export const isFinal = (outcome) => ["live", "oos", "gone", "unapproved"].includes(outcome);

/**
 * Write the card's entry when it changed (a quiet product writes nothing).
 * `approvedAt` ties the entry to the approval it is about.
 */
export async function recordWeb(db, pid, r, { prev, approvedAt, now }) {
  const e = entryFor(r, prev);
  if (r.outcome === "unapproved") { if (prev) await db.ref(`${WEB}/${pid}`).set(null); return null; }
  if (r.outcome === "error" && prev && prev.s) return prev; // a crash is not news
  const next = { ...e, approvedAt: approvedAt ?? prev?.approvedAt ?? null };
  if (r.outcome === "published") next.pubAt = now;
  else if (prev?.pubAt && next.s === "pub") next.pubAt = prev.pubAt;
  else if (prev?.pubAt && next.s === "fail") next.pubAt = prev.pubAt;
  const same = prev && prev.s === next.s && (prev.why || null) === (next.why || null) && (prev.approvedAt ?? null) === (next.approvedAt ?? null) && (prev.pubAt ?? null) === (next.pubAt ?? null);
  if (same) return prev;
  await db.ref(`${WEB}/${pid}`).set({ ...next, at: now });
  return next;
}

/**
 * One pass over the queue. deps as publishOne, plus suggestNames(pids) (optional: the runner's namer).
 * → { off, queued, results: [{ pid, outcome, why }], published, named }
 */
export async function drain(deps, { max = MAX_PUBLISH_PER_RUN, maxAttempts = MAX_ATTEMPTS_PER_RUN, pids = null, force = false } = {}) {
  const { db, log = () => {} } = deps;
  const out = { off: false, queued: 0, results: [], published: 0, named: 0 };
  if ((await val(db, SWITCH_OFF)) === true) { out.off = true; return out; }
  const queue = pids ? Object.fromEntries(await Promise.all(pids.map(async (pid) => [pid, (await val(db, `${QUEUE}/${pid}`)) || {}]))) : ((await val(db, QUEUE)) || {});
  out.queued = Object.keys(queue).length;
  if (!out.queued) return out;
  const t = await deps.now();
  const due = Object.entries(queue)
    .filter(([, q]) => force || !(Number(q?.tryAt) > t))
    .sort((a, b) => (Number(a[1]?.tryAt) || 0) - (Number(b[1]?.tryAt) || 0) || (Number(a[1]?.approvedAt) || 0) - (Number(b[1]?.approvedAt) || 0))
    .map(([pid, q]) => [pid, q]);
  const namePids = [];
  for (const [pid, q] of due.slice(0, maxAttempts)) {
    if (out.published >= max) break;
    const prev = await val(db, `${WEB}/${pid}`);
    let r;
    try { r = await publishOne(pid, deps, { web: prev }); } catch (e) { r = { pid, outcome: "error", why: String(e?.message || e) }; log(`${pid}: ${r.why}`); }
    out.results.push(r);
    const now = await deps.now();
    await recordWeb(db, pid, r, { prev, approvedAt: q?.approvedAt ?? null, now });
    if (r.outcome === "published") out.published++;
    if (isFinal(r.outcome)) { await db.ref(`${QUEUE}/${pid}`).set(null); continue; }
    if (r.outcome === "published" || r.outcome === "pending") {
      // Look again soon for the reconciler's verdict (its tick is 2 minutes).
      await db.ref(`${QUEUE}/${pid}`).update({ tryAt: r.outcome === "published" ? null : now + 4 * 60 * 1000, ...(r.outcome === "published" ? { tries: 0 } : {}) });
      continue;
    }
    if (r.outcome === "needs-name") {
      if (!(Number(q?.nameAt) > now - NAME_RETRY_MS)) { namePids.push(pid); await db.ref(`${QUEUE}/${pid}`).update({ nameAt: now, tryAt: now + 5 * 60 * 1000 }); }
      else await db.ref(`${QUEUE}/${pid}`).update({ tryAt: Number(q.nameAt) + NAME_RETRY_MS });
      continue;
    }
    const tries = (Number(q?.tries) || 0) + 1;
    await db.ref(`${QUEUE}/${pid}`).update({ tries, tryAt: now + retryDelay(tries), why: String(r.why || "").slice(0, 240) });
  }
  if (namePids.length && deps.suggestNames) {
    try { await deps.suggestNames(namePids); out.named = namePids.length; } catch (e) { log(`namer: ${String(e?.message || e)}`); }
  }
  return out;
}

/** Queue one approval (the backfill and the album gate use this; bfWebQueue writes the same shape). */
export async function enqueue(db, pid, approvedAt, now) {
  await db.ref(`${QUEUE}/${pid}`).update({ approvedAt: approvedAt ?? null, at: now, tryAt: null });
}
