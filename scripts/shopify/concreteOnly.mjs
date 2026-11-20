// ─── CONCRETE-ONLY ON THE MARATHON STORE (Junid, 20 Nov 2026) ────────────────
// A product marked concreteProduct sells on the Concrete website ONLY. The
// Marathon reconciler therefore:
//   1. refuses to turn one ON (reconcile.mjs, at apply time), and
//   2. turns OFF any that are live on marathonclub.co.za — this module.
//
// NO WHOLE-NODE READ. Concrete-only products are found through the small
// index /settings/concreteOnlyIndex/{pid} (written in the same multi-path
// update as the mark — src/utils/concreteListing.js), never by scanning
// /products. Each indexed pid is then RE-READ from /products/{pid}: the index
// is a pointer, the product record is the truth, so a stale index entry (a
// console edit) can never take a Marathon product down.
//
// The off is an ordinary intent — desiredState "off" plus the standard off
// record (publishAudit.js, reason "concrete_only") — so the reconciler's own
// off path does the Shopify side in the same tick and the page shows why.
import { isConcreteProduct, CONCRETE_INDEX_PATH } from "../../src/utils/concreteListing.js";
import { buildOffRecord, offAuditFields } from "../../src/components/shopify/publishAudit.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

export const MARATHON_PUBLISH_PATH = "shopify_publish";

/** Live on (or going on to) the Marathon storefront, so an off is needed. */
export function needsMarathonOff(node) {
  if (!node || typeof node !== "object") return false;
  if (node.desiredState === "off") return false;
  if (node.desiredState === "on") return true;
  return node.state === "live" && node.liveState !== "off";
}

/**
 * PURE: the fields that turn a Marathon publish node off because the product
 * is Concrete-only. `at` = server epoch ms (also the off-log key).
 */
export function concreteOnlyOffFields(node, { at, actor }) {
  if (!(Number.isFinite(at) && at > 0)) throw new Error("concreteOnlyOffFields: `at` must be server epoch ms");
  const record = buildOffRecord({ at, actor, reasonCode: "concrete_only" });
  return {
    desiredState: "off",
    updatedAt: at,
    updatedBy: actor,
    ...offAuditFields(node, record, at),
  };
}

/**
 * Turn off, on Marathon, every Concrete-only product still live there.
 * Returns { checked, turnedOff: [pid], skipped: [{pid, why}] }.
 *   db         Admin SDK database
 *   nowMs      () => Promise<server epoch ms>
 *   actor      "script:<name>"
 *   commit     false = report only
 */
export async function enforceConcreteOnlyOnMarathon(db, { nowMs, actor, commit = false, log = () => {} }) {
  const index = (await db.ref(CONCRETE_INDEX_PATH).get()).val() || {};
  const out = { checked: 0, turnedOff: [], skipped: [] };
  for (const pid of Object.keys(index)) {
    try { assertSafeSegment(pid, "productId"); } catch { out.skipped.push({ pid, why: "unsafe id" }); continue; }
    out.checked++;
    const product = (await db.ref(`products/${pid}`).get()).val();
    if (!isConcreteProduct(product)) { out.skipped.push({ pid, why: "index says Concrete-only but the product record does not" }); continue; }
    const node = (await db.ref(`${MARATHON_PUBLISH_PATH}/${pid}`).get()).val();
    if (!needsMarathonOff(node)) continue;
    if (commit) {
      const at = await nowMs();
      await db.ref(`${MARATHON_PUBLISH_PATH}/${pid}`).update(concreteOnlyOffFields(node, { at, actor }));
      log(`  marathon: ${pid} is Concrete-only — switching its Marathon listing off`);
    }
    out.turnedOff.push(pid);
  }
  return out;
}
