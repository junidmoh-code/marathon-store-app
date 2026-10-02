// ─── NEW ARRIVALS — THE POST-APPROVAL CHAIN ──────────────────────────────────
// After Junid taps Approve, the agents do exactly what a person does today, by
// calling the SAME code the buttons call — never a copy, never the UI:
//   (a) the generated photo becomes the product photo — the AI Studio approve
//       path (photoUrl ← generated, photoUrlOriginal ← the upload, kept for
//       ever; writeApprovedThumbFromUrl for the tills) and the publisher card's
//       photo strip (photosMutator);
//   (b) accept the name suggester's proposal — the Suggested-name Apply button
//       (applyProposalMutator), and ONLY the proposal Junid was shown;
//   (c) condition Excellent — the condition chip (conditionMutator);
//   (d) approve on the publisher card — the Publish button (publishMutator);
//   (e) the existing reconciler publishes; the chain only watches for its verdict.
// Any refusal — including the reconciler's duplicate-title/handle block — moves
// the item to Rejected with the reason in plain words. Nothing is suffixed,
// forced or retried around a refusal.
//
// Every step stamps items/{pid}/chain/{step}/at, so a crashed run resumes
// where it stopped and never repeats a finished step.
import { applyProposalMutator, conditionMutator, photosMutator, publishMutator, precheck }
  from "../../src/components/shopify/publishMutators.js";
import { CONDITIONS } from "../../src/components/shopify/publishShared.js";
import { writeApprovedThumbFromUrl, writeProductThumb } from "../../src/utils/productThumb.js";

export const EXCELLENT = CONDITIONS[0];
export const DUPLICATE = "duplicate name — needs a distinct name";
export const AGENT_UID = "new-arrivals-agent";
const ITEMS = "new_arrivals/items";

// ── queue moves (same semantics as functions/newArrivals/core.cjs) ──────────
function moveMutator(from, to, fields, at, out) {
  return (cur) => {
    if (!cur) { out.refusal = "not in the queue"; return null; }
    if (![].concat(from).includes(cur.status)) { out.refusal = `it is ${cur.status}`; return undefined; }
    out.from = cur.status;
    const next = { ...cur, ...fields, status: to, statusAt: at };
    for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
    return next;
  };
}
async function move(db, pid, from, to, fields, at) {
  const out = {};
  const res = await db.ref(`${ITEMS}/${pid}`).transaction(moveMutator(from, to, fields, at, out));
  const v = res.committed && res.snapshot.val();
  if (!v || v.status !== to) return null;
  const u = { [`by_status/${to}/${pid}`]: Number(v.enqueuedAt) || 0 };
  if (out.from && out.from !== to) u[`by_status/${out.from}/${pid}`] = null;
  await db.ref("new_arrivals").update(u);
  return v;
}

/** A button's mutator run as an Admin SDK transaction on /shopify_publish/{pid}. */
export async function decide(db, pid, node, mutator, args, ctx) {
  let refusal = null;
  const res = await db.ref(`shopify_publish/${pid}`).transaction((cur) => {
    const out = mutator(cur || node || {}, args, ctx);
    if (out.refusal) { refusal = out.refusal; return undefined; }
    return out.next;
  });
  if (!res.committed) return { ok: false, message: refusal || "Not saved." };
  return { ok: true, node: res.snapshot.val() };
}

/** The reconciler's block, in Junid's words. Pure. */
export function blockedReasonText(blockedReason) {
  const r = String(blockedReason || "");
  if (/already belongs to another listing|already carries this exact title|duplicate|handle/i.test(r)) return DUPLICATE;
  return `Shopify refused it — ${r.slice(0, 220) || "no reason recorded"}`;
}

/**
 * Advance one approved item as far as it will go now.
 * deps: { db, now: async () => serverNowMs, download(url) → Buffer, uploadThumb(path, buf, meta),
 *         removeObject(path), encodeThumb(buf) → Buffer, claimPublish(pid) → bool, log }
 * Returns { pid, outcome: "done"|"rejected"|"waiting"|"skipped", reason?, step? }.
 */
export async function advance(pid, deps) {
  const { db, log = () => {} } = deps;
  let item = (await db.ref(`${ITEMS}/${pid}`).once("value")).val();
  if (!item) return { pid, outcome: "skipped", reason: "not in the queue" };
  if (item.status === "approved") {
    item = await move(db, pid, "approved", "chaining", {}, await deps.now());
    if (!item) return { pid, outcome: "skipped", reason: "could not claim" };
  }
  if (item.status !== "chaining") return { pid, outcome: "skipped", reason: `it is ${item.status}` };
  const chain = item.chain || {};
  // A chain stamp from a different generation is not this lap's: redo it.
  if (chain.photo && chain.photo.url && chain.photo.url !== item.generatedUrl) {
    for (const k of Object.keys(chain)) delete chain[k];
    await db.ref(`${ITEMS}/${pid}/chain`).set(null);
  }
  const reject = async (step, reason) => {
    await move(db, pid, "chaining", "rejected", { rejection: { code: "chain", step, reason, at: await deps.now() } }, await deps.now());
    log(`${pid}: REJECTED at ${step} — ${reason}`);
    return { pid, outcome: "rejected", step, reason };
  };
  const stampStep = async (step, extra = {}) => {
    const at = await deps.now();
    await db.ref(`${ITEMS}/${pid}/chain/${step}`).set({ at, ...extra });
    chain[step] = { at, ...extra };
  };
  const ctx = async () => ({ now: await deps.now(), uid: AGENT_UID });
  const product = (await db.ref(`products/${pid}`).once("value")).val();
  if (!product) return reject("photo", "the product record no longer exists");
  if (!item.generatedUrl) return reject("photo", "no generated photo on the item");
  let node = (await db.ref(`shopify_publish/${pid}`).once("value")).val();

  // (a) the photo
  if (!chain.photo) {
    if (!(Number(product.retailPrice) > 0)) return reject("photo", "no retail price — set the price in the app, then Retry");
    // The publisher card's photo strip FIRST: it is the step that can refuse
    // (a listing already ON), and a refusal must leave the app photo untouched.
    // The button's own argument check first, exactly as setPublishPhotos does.
    const bad = precheck.photos([item.generatedUrl]);
    if (bad) return reject("photo", bad);
    const res = await decide(db, pid, node, photosMutator, { photos: [item.generatedUrl], basisPhotos: node?.photos }, await ctx());
    if (!res.ok) return reject("photo", res.message);
    node = res.node;
    // AI Studio approve path: photoUrl ← generated; photoUrlOriginal keeps the
    // FIRST original for ever (never overwritten by a later approval).
    const original = product.photoUrlOriginal || item.originalUrl || product.photoUrl;
    // Exactly the AI Studio approve write (App.jsx): photoUrl + photoUrlOriginal.
    const update = { photoUrl: item.generatedUrl };
    if (!product.photoUrlOriginal) update.photoUrlOriginal = original;
    await db.ref(`products/${pid}`).update(update);
    // The till thumbnail, by the same helper the AI Studio approve uses. The
    // browser encodes with a canvas; here the encoder is injected (sharp), and
    // the helper's own contract — best-effort, never throws — is unchanged.
    const thumb = await writeApprovedThumbFromUrl(pid, item.generatedUrl, {
      download: deps.download,
      upload: deps.uploadThumb,
      remove: deps.removeObject,
      warn: (...a) => log(`${pid}: thumbnail — ${a.map(String).join(" ")}`),
      write: (id, blob, d) => writeProductThumb(id, blob, { ...d, encode: deps.encodeThumb }),
    });
    await stampStep("photo", { thumb: !!thumb?.ok, url: item.generatedUrl });
  }

  // (b) the name — the proposal Junid saw on the card, and only that one.
  if (!chain.name) {
    // Without the shown proposal's timestamp the mutator's freshness check is
    // skipped and a NEWER proposal could be applied unseen — refuse instead.
    if (item.nameProposedAt == null) return reject("name", "the card did not record which suggested name was shown — Retry for a fresh one");
    const res = await decide(db, pid, node, applyProposalMutator, { seenProposedAt: item.nameProposedAt ?? null }, await ctx());
    if (!res.ok) {
      // Resume after a crash between the apply and its stamp: the proposal
      // Junid saw is already applied — that step is done, not refused.
      const n = (await db.ref(`shopify_publish/${pid}`).once("value")).val();
      const p = n?.nameProposal;
      const alreadyApplied = p?.status === "applied" && Number(p.proposedAt) === Number(item.nameProposedAt) && n.cleanName === String(p.name).trim();
      if (!alreadyApplied) {
        return reject("name", /no proposal to apply/.test(res.message) ? "the suggested name is no longer there — Retry for a fresh one" : res.message);
      }
      node = n;
    } else node = res.node;
    await stampStep("name", { name: node.cleanName });
  }

  // (c) condition Excellent
  if (!chain.condition) {
    const bad = precheck.condition(EXCELLENT);
    if (bad) return reject("condition", bad);
    const res = await decide(db, pid, node, conditionMutator, { condition: EXCELLENT }, await ctx());
    if (!res.ok) return reject("condition", res.message);
    node = res.node;
    await stampStep("condition");
  }

  // (d) approve on the publisher card — once, ever (ledger claim + the mutator's own isOn gate)
  if (!chain.publish) {
    if (deps.claimPublish && !deps.claimPublish(pid)) {
      // Claimed by an earlier run that died before stamping. Only proceed if
      // the intent is visibly there; otherwise stop rather than risk a double.
      node = (await db.ref(`shopify_publish/${pid}`).once("value")).val();
      if (node?.desiredState !== "on") return reject("publish", "an earlier publish attempt did not finish — check the publisher card, then Retry");
    } else {
      const bad = precheck.publish(node.cleanName);
      if (bad) { deps.releasePublish?.(pid); return reject("publish", bad); }
      let res;
      try {
        res = await decide(db, pid, node, publishMutator, { name: node.cleanName, source: node.cleanNameSource }, await ctx());
      } catch (e) {
        // Nothing was written: the claim must not outlive a network error.
        deps.releasePublish?.(pid);
        throw e;
      }
      if (!res.ok) { deps.releasePublish?.(pid); return reject("publish", res.message); }
      node = res.node;
    }
    await stampStep("publish");
  }

  // (e) the reconciler's verdict
  node = (await db.ref(`shopify_publish/${pid}`).once("value")).val();
  if (node?.state === "live" && node?.liveState === "on") {
    const at = Number(node.liveAt) || await deps.now();
    await stampStep("shopify", { adminUrl: node.adminUrl || null });
    await move(db, pid, "chaining", "done", {
      "destinations": { ...(item.destinations || {}), shopify: { at, title: node.cleanName || null, adminUrl: node.adminUrl || null } },
    }, await deps.now());
    return { pid, outcome: "done" };
  }
  if (node?.state === "blocked") return reject("shopify", blockedReasonText(node.blockedReason));
  return { pid, outcome: "waiting", step: "shopify" };
}
