// ─── AUTO-PUBLISH: NO HUMAN REVIEW STEP (owner instruction, 2026-10-03) ──────
// "name suggestion should also be auto approved, i don't have to review
// anything at all, change the name and publish it" — and condition is
// Excellent, always.
//
// For every product that reaches the review list with at least
// REVIEW_MIN_UNITS sellable units (reviewStock.mjs queues it), this agent does
// what the publisher card's buttons do, by calling THE SAME mutators the
// buttons call (publishMutators.js — the New Arrivals chain does the same):
//   1. the name — a pending AI suggestion is applied (applyProposalMutator);
//      otherwise the name the card would ship (effectiveNameFor: a saved name,
//      or the lexicon's clean name). No name yet → wait for the namer.
//   2. condition Excellent (conditionMutator).
//   3. publish (publishMutator) → desiredState "on"; the existing reconciler
//      does the Shopify side on its next tick, with all of its own checks
//      (compliance, duplicates, photos). A product it refuses becomes
//      "blocked" and stays in the review list for a person.
//
// It NEVER touches a product already on (or going on) the storefront: every
// mutator refuses one, and the agent skips it before trying.
//
// OFF SWITCH: /config/shopifyAutoPublish/enabled. Absent or anything but true
// = the agent does nothing (the queue keeps filling, nothing is lost).

import { applyProposalMutator, conditionMutator, publishMutator, precheck }
  from "../../src/components/shopify/publishMutators.js";
import { CONDITIONS } from "../../src/components/shopify/publishShared.js";
import { effectiveNameFor, effectivePhotoList, normalizedState, isOnOrGoingOn, isPublishableProduct, proposalApplyBlocker }
  from "../../src/components/shopify/shopifyPublishCore.js";
import { isPendingProposal } from "../../src/utils/visionNaming.js";
import { locationNames } from "./inventorySync.mjs";
import { judgeProduct, AUTOPUBLISH_QUEUE_PATH, HIDDEN_PATH } from "./reviewStock.mjs";

export const SWITCH_PATH = "config/shopifyAutoPublish/enabled";
export const EXCELLENT = CONDITIONS[0];
export const AGENT_UID = "auto-publish-agent";
// The reconciler applies at most 25 intents a run; queuing faster than that
// only builds its backlog.
export const MAX_PER_RUN = 25;
// And at most this many products LOOKED AT per tick (each is a handful of
// point reads), so a large backlog never makes one tick slow.
export const MAX_ATTEMPTS_PER_RUN = 80;
// A product waiting for something (a name, a photo) is looked at again after
// this long, not on every two-minute tick.
export const RETRY_AFTER_MS = 30 * 60 * 1000;

/** A button's mutator run as an Admin SDK transaction on /shopify_publish/{pid}. */
async function decide(db, pid, node, mutator, args, ctx) {
  let refusal = null;
  const res = await db.ref(`shopify_publish/${pid}`).transaction((cur) => {
    const base = cur || node || {};
    // Re-checked INSIDE the transaction, against the server's value: a person
    // may have published (or the reconciler confirmed) this product since it
    // was read. The agent never writes to a product on or going on — not even
    // the condition, which the button mutators alone would allow.
    if (isOnOrGoingOn(base)) { refusal = "on or going on the storefront"; return undefined; }
    const out = mutator(base, args, ctx);
    if (out.refusal) { refusal = out.refusal; return undefined; }
    return out.next;
  });
  if (!res.committed) return { ok: false, message: refusal || "Not saved." };
  return { ok: true, node: res.snapshot.val() };
}

/**
 * Is this product ready to auto-publish, judged from the product and its node
 * alone (stock is judged separately)? Pure — the agent and the dry-run report
 * use this one answer.
 *   { ready: true, name, source, viaProposal }
 *   { ready: false, outcome: "done" | "wait", why }
 */
export function readiness(product, node) {
  if (!product) return { ready: false, outcome: "done", why: "product no longer exists" };
  if (!isPublishableProduct(product)) return { ready: false, outcome: "done", why: "not merchandise" };
  if (isOnOrGoingOn(node)) return { ready: false, outcome: "done", why: "already on or going on the storefront" };
  if (normalizedState(node) === "blocked") return { ready: false, outcome: "done", why: "blocked — needs a person" };
  if (!(effectivePhotoList(product, node)?.photos?.length > 0)) return { ready: false, outcome: "wait", why: "no photo yet" };
  let name, source, viaProposal = false;
  if (isPendingProposal(node)) {
    const gate = proposalApplyBlocker(node);
    if (!gate.ok) return { ready: false, outcome: "wait", why: `name suggestion refused: ${gate.reason}` };
    name = String(node.nameProposal.name).trim(); source = "ai"; viaProposal = true;
  } else {
    const eff = effectiveNameFor(product, node);
    if (!eff.name) return { ready: false, outcome: "wait", why: "no name yet — waiting for the AI namer" };
    name = eff.name; source = eff.source;
  }
  const bad = precheck.publish(name);
  if (bad) return { ready: false, outcome: "wait", why: `name not publishable: ${bad}` };
  return { ready: true, name, source, viaProposal };
}

/**
 * Take one product as far as it goes. Returns
 *   { outcome: "published" | "done" | "wait", why }
 * "done" = leave the queue (nothing to do, or a person must act);
 * "wait" = keep it queued and look again later.
 */
export async function autoPublishOne(db, pid, { now, locNames }) {
  const product = (await db.ref(`products/${pid}`).get()).val();
  let node = (await db.ref(`shopify_publish/${pid}`).get()).val();
  const ready = readiness(product, node);
  if (!ready.ready) return { outcome: ready.outcome, why: ready.why };

  // The stock bar is re-checked NOW, not trusted from when it was queued.
  const j = await judgeProduct(db, pid, locNames);
  if (j.verdict !== "show") return { outcome: "done", why: j.why };
  if ((await db.ref(`${HIDDEN_PATH}/${pid}`).get()).val() != null) return { outcome: "done", why: "hidden" };

  const ctx = { now: await now(), uid: AGENT_UID };

  // 1. The name. A pending AI suggestion is applied exactly as its button
  // does (pinned to the proposal just read, so a newer one is never taken
  // unseen); after that the node's name IS the one readiness() checked.
  if (ready.viaProposal) {
    const res = await decide(db, pid, node, applyProposalMutator,
      { seenProposedAt: node.nameProposal?.proposedAt ?? null }, ctx);
    if (!res.ok) return { outcome: "wait", why: `name suggestion not applied: ${res.message}` };
    node = res.node;
  }
  const eff = { name: ready.viaProposal ? node.cleanName : ready.name, source: ready.viaProposal ? node.cleanNameSource : ready.source };

  // 2. Excellent.
  if (node?.condition !== EXCELLENT) {
    const res = await decide(db, pid, node, conditionMutator, { condition: EXCELLENT }, ctx);
    if (!res.ok) return { outcome: "wait", why: res.message };
    node = res.node;
  }

  // 3. Publish — the intent only; the reconciler does Shopify.
  const res = await decide(db, pid, node, publishMutator, { name: eff.name, source: eff.source }, ctx);
  if (!res.ok) return { outcome: "wait", why: res.message };
  return { outcome: "published", why: eff.name };
}

/** Drain the queue. `now` = async server-time ms (publishNode.serverNowMs). */
export async function drainAutoPublish(db, { now, max = MAX_PER_RUN, maxAttempts = MAX_ATTEMPTS_PER_RUN, log = () => {} } = {}) {
  const out = { enabled: false, queued: 0, published: 0, done: 0, waiting: 0, failed: 0, results: [] };
  const queue = (await db.ref(AUTOPUBLISH_QUEUE_PATH).get()).val() || {};
  out.queued = Object.keys(queue).length;
  if (!out.queued) return out;
  out.enabled = (await db.ref(SWITCH_PATH).get()).val() === true;
  if (!out.enabled) return out;

  const t = await now();
  const due = Object.entries(queue)
    .filter(([, q]) => !(Number(q?.lastTryAt) > t - RETRY_AFTER_MS))
    .sort((a, b) => (Number(a[1]?.lastTryAt) || 0) - (Number(b[1]?.lastTryAt) || 0))
    .map(([pid]) => pid);
  const locNames = await locationNames(db);
  for (const pid of due.slice(0, maxAttempts)) {
    if (out.published >= max) break;
    try {
      const r = await autoPublishOne(db, pid, { now, locNames });
      out.results.push({ pid, ...r });
      if (r.outcome === "wait") {
        out.waiting++;
        await db.ref(`${AUTOPUBLISH_QUEUE_PATH}/${pid}`).update({ lastTryAt: await now(), why: r.why.slice(0, 300) });
      } else {
        if (r.outcome === "published") out.published++; else out.done++;
        await db.ref(`${AUTOPUBLISH_QUEUE_PATH}/${pid}`).remove();
      }
    } catch (e) {
      out.failed++;
      out.results.push({ pid, outcome: "error", why: String(e?.message || e) });
      log(`  ⚠ auto-publish ${pid}: ${String(e?.message || e)} — kept in the queue`);
      await db.ref(`${AUTOPUBLISH_QUEUE_PATH}/${pid}`).update({ lastTryAt: await now(), why: String(e?.message || e).slice(0, 300) }).catch(() => {});
    }
  }
  return out;
}
