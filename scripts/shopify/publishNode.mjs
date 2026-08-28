// ── /shopify_publish/{productId} — the publishing-state node ─────────────────
// One node per product (owner decision 2026-08-13), SEPARATE from the
// /shopify_sync ID map: sync records WHAT exists on Shopify, publish records
// WHERE a product is in the human pipeline. State model of 2026-08-14 — the
// old none/nominated/draft chain is collapsed:
//
//   /shopify_publish/{productId} = {
//     state:            "awaiting" | "live" | "blocked",
//     liveState:        "on" | "off",            // CONFIRMED channel state, live products only
//     desiredState:     "on" | "off",            // INTENT written by the page; reconciler applies
//     blockedReason:    string,                  // reconciler's apply-time refusal, blocked only
//     blockedHandle:    string,                  // the handle a COLLISION refusal was about
//     cleanName:        string,                  // the compliant listing title
//     cleanNameSource:  "lexicon" | "ai" | "manual",
//     nameApprovedAt:   epoch ms,                // name signed off in the review page
//     condition:        one of CONDITIONS (compliance.mjs) — NO default,
//     photos:           [url, …],                // PUBLISHING photo set, ordered, first = primary.
//                                                // Optional — absent means "use the record's
//                                                // photoUrl + gallery". Photos are a publishing
//                                                // concern: NEVER written to /products.
//     liveAt:           epoch ms,                // when the product last went ON (reconciler stamp)
//     lastOff:          { at, actor, reasonCode, detail },  // WHY it last came off
//     offLog:           { <epoch ms>: <the same record> },  // last 10, oldest trimmed
//     adminUrl:         string,                  // Shopify admin link (reconciler stamp)
//     updatedAt:        epoch ms,
//     updatedBy:        uid or "script:<name>",
//   }
//
// The page writes desiredState ONLY (plus name/condition fields); state and
// liveState are written back by scripts/shopify/reconcile.mjs once Shopify
// confirms. desiredState ≠ confirmed ⇒ the row shows pending. The browser
// NEVER calls Shopify — it cannot hold the client secret.
//
// Console rules (pasted by the owner, NOT in database.rules.json): read = any
// non-anonymous user; write = Junid or stockRole admin. Admin SDK scripts
// bypass rules but keep to the same field set so the page and the scripts
// always agree on shape.
//
// WRITE DISCIPLINE: every write here is a MERGE (update()), never set() — a
// script confirming a liveState must not clobber a condition Junid just set
// from the page, and vice versa. cachePublishName never overwrites an existing
// cleanName: a name is generated once and never regenerated (AI is
// non-deterministic; a re-run must not silently change a reviewed title).
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { buildOffRecord, offAuditFields } from "../../src/components/shopify/publishAudit.js";

export const PUBLISH_STATES = ["awaiting", "live", "blocked"];

// ── SERVER TIME, NOT THIS MACHINE'S CLOCK ────────────────────────────────────
// `updatedAt` is a rules-validated field (`newData.val() <= now + 86400000`)
// and the Admin SDK bypasses rules — so a skewed clock on the Mac mini writes
// a value the rule would have refused, silently, poisoning every later browser
// write to that node. `/.info/serverTimeOffset` is the RTDB server clock minus
// this machine's, exactly as src/utils/serverTime.js uses it in the browser.
//
// Read ONCE per process and cached: it is a client-side metadata value with no
// rules and no round trip after the handshake, and an off record's `at` and its
// log key must be the SAME instant — two calls to a live clock are two numbers.
// The off-audit fields for a script-side write, log INCLUDED AND TRIMMED.
// The first version used the untrimmed update() form on the argument that
// script-side offs are rare — which is true of a healthy shop and false of the
// case that matters: a product the validator refuses on every tick would grow
// its log without limit (Codex review, 2026-08-28). One small point read of the
// log child is cheaper than an unbounded node.
async function offFields(db, productId, record) {
  let existing = null;
  try { existing = (await db.ref(`shopify_publish/${productId}/offLog`).get()).val(); }
  catch { existing = null; }   // an unreadable log must never block a take-down
  return offAuditFields({ offLog: existing }, record, record.at);
}

let offsetMs = null;
export async function serverNowMs(db) {
  if (offsetMs === null) {
    try { offsetMs = Number((await db.ref(".info/serverTimeOffset").get()).val()) || 0; }
    catch { offsetMs = 0; }   // degrades to this machine's clock, never blocks a take-down
  }
  return Date.now() + offsetMs;
}

export async function readPublishNode(db, productId) {
  assertSafeSegment(productId, "productId");
  return (await db.ref(`shopify_publish/${productId}`).get()).val();
}

export async function readAllPublishNodes(db) {
  return (await db.ref("shopify_publish").get()).val() || {};
}

// Cache a generated/typed clean name. Returns "cached" | "kept-existing".
// The never-overwrite guarantee is a TRANSACTION on the cleanName child — a
// read-then-update here would let an AI run and a page save both observe
// "no name" and the later write clobber the earlier reviewed one.
export async function cachePublishName(db, productId, { cleanName, source, updatedBy }) {
  assertSafeSegment(productId, "productId");
  const nameRef = db.ref(`shopify_publish/${productId}/cleanName`);
  const result = await nameRef.transaction((cur) =>
    cur === null ? String(cleanName) : undefined
  );
  if (!result.committed) return "kept-existing";
  await db.ref(`shopify_publish/${productId}`).update({
    cleanNameSource: source,
    updatedAt: await serverNowMs(db),
    updatedBy,
  });
  return "cached";
}

// The reconciler's confirmation write: Shopify now agrees the product is
// on/off, so record it and let the page's pending marker clear. desiredState
// is deliberately NOT touched — it is the page's field; leaving it in place
// keeps the write idempotent (desired == confirmed ⇒ no diff next run).
//
// The optional gid lets the page show the row's Shopify admin link without a
// /shopify_sync read (adminUrl rides the node's $other clause); liveAt stamps
// the moment the product last WENT ON — the fact Junid asked the Live view to
// show. Both are best-effort extras: an older caller without them still
// confirms correctly, the row just shows no link/date yet.
// clearAdminUrl: the caller KNOWS no Shopify product exists (e.g. confirming
// off with no /shopify_sync mapping) — a link stamped in an earlier life
// would now point at nothing, so it is removed rather than preserved.
// Pass as `offReason` when the node ALREADY carries a truthful off record (the
// page wrote it when the switch was flipped) and this confirm is only agreeing
// with it. Overwriting an "off_to_rename" with a generic "script" here would
// be exactly the information loss the audit exists to stop.
export const KEEP_EXISTING_OFF_REASON = "__keep__";

export async function confirmLiveState(db, productId, liveState, updatedBy, { gid = null, clearAdminUrl = false, offReason = "script", offDetail = null } = {}) {
  assertSafeSegment(productId, "productId");
  if (liveState !== "on" && liveState !== "off") throw new Error(`invalid liveState: ${liveState}`);
  const numericId = gid ? String(gid).split("/").pop() : null;
  const at = await serverNowMs(db);
  // EVERY transition to off carries its reason (publishAudit.js). A caller that
  // does not name one is a bug, not a shrug: an unexplained off is precisely
  // the state docs/PUBLISH-AUTO-OFF.md exists because of, so the default names
  // the script rather than leaving the row with nothing to say.
  const audit = liveState === "off" && offReason !== KEEP_EXISTING_OFF_REASON
    ? await offFields(db, productId, buildOffRecord({
        at,
        actor: updatedBy,
        reasonCode: offReason,
        detail: offDetail,
      }))
    : {};
  await db.ref(`shopify_publish/${productId}`).update({
    state: "live",
    liveState,
    blockedReason: null,
    ...(numericId ? { adminUrl: `https://admin.shopify.com/store/nu3ei8-0p/products/${numericId}` } : {}),
    ...(!numericId && clearAdminUrl ? { adminUrl: null } : {}),
    ...(liveState === "on" ? { liveAt: at } : {}),
    ...audit,
    updatedAt: at,
    updatedBy,
  });
}

// The reconciler's refusal write: the apply-time validator said no. The
// intent is cleared back to "off" so the refusal doesn't retry forever —
// after fixing the cause, the page re-expresses it (blocked → awaiting via
// the condition chips, or Publish again).
// blockedHandle: the storefront address this refusal was ABOUT, when it was a
// handle collision. Recorded as a FIELD rather than left to be read back out of
// the sentence — the page has to decide whether a block is still true (a
// refusal outlives the name that caused it), and parsing prose for that answer
// means every future edit to the wording silently breaks the feature. It did:
// the first version of this change rewrote the refusal text and left the reader
// matching a string the code no longer emitted (architect review, 2026-08-28).
// ALWAYS written — null on every non-collision refusal, so a stale handle from
// an earlier life can never make a live block look answered.
export async function markBlocked(db, productId, reason, updatedBy, { wasTakenDown = false, blockedHandle = null } = {}) {
  assertSafeSegment(productId, "productId");
  const at = await serverNowMs(db);
  await db.ref(`shopify_publish/${productId}`).update({
    state: "blocked",
    blockedReason: String(reason),
    blockedHandle: blockedHandle ? String(blockedHandle) : null,
    desiredState: "off",
    // A refusal that ran failSafeUnpublish first has PROVED the product is off
    // the channel; recording it stops the node claiming `liveState: "on"` for
    // a product nobody can see. Refusals that never published leave the field
    // alone — they have no new fact about the channel.
    ...(wasTakenDown ? { liveState: "off" } : {}),
    ...(await offFields(db, productId, buildOffRecord({
      at,
      actor: updatedBy,
      reasonCode: "reconciler_refused",
      detail: String(reason),
    }))),
    updatedAt: at,
    updatedBy,
  });
}
