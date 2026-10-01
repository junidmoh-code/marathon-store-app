// ─── JUNID'S STANDING FOOTWEAR RUN — ONE COPY, FOR THE SCRIPTS ────────────────
//
// The numbers Junid set on 24 Sep 2026 for every footwear product at Hub 1 and
// Hub 2. They are DATA for two scripts — the census (which measures the live
// policy against them) and the apply runner (which writes them through the
// callable's own path). They are not engine code: once applied, the live
// footwear-all group is the source of truth and Junid edits it on the Engine
// Policy card. Nothing in functions/ or src/ reads this file.
//
// Size keys are the STORED form: 5.5 is "5_5" (RTDB forbids "." in a key).
// Sizes not named here stay UNARMED — no row, not a target of 0.
//
// minQty follows the convention every live footwear leg already uses
// (ceil(keep / 2): keep 2 → 1, keep 3 → 2), the same default the card and the
// write path apply to a blank minQty.

export const STANDING_KEEP = Object.freeze({
  "3": 2, "4": 2, "5": 2, "5_5": 2, "6": 3, "7": 3, "8": 3, "9": 2, "10": 2, "11": 2, "12": 2, "13": 2,
});
export const STANDING_ASK_AT = 1;
export const STANDING_HUBS = Object.freeze(["hub1", "hub2"]);
export const FOOTWEAR_GROUP_KEY = "footwear-all";
export const FOOTWEAR_GROUP_LABEL = "Footwear";
export const FOOTWEAR_KEYS = Object.freeze([
  "boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers", "soccer-boots",
]);

const minQtyFor = (keep) => Math.ceil(keep / 2);

// One hub's leg. carriedOnly:true — HOW MANY, never WHERE: the policy speaks
// only for products the hub already holds a stock cell for.
export function standingLeg() {
  const sizes = {};
  for (const [k, keep] of Object.entries(STANDING_KEEP)) {
    sizes[k] = { target: keep, minQty: minQtyFor(keep), reorderPoint: STANDING_ASK_AT };
  }
  return { sizes, carriedOnly: true };
}

// The whole group as it should stand: eight members, armed, the same leg at
// both hubs, nothing at Central or any shop.
export function standingGroup() {
  const policy = { perSize: true };
  for (const hub of STANDING_HUBS) policy[hub] = standingLeg();
  return { label: FOOTWEAR_GROUP_LABEL, memberCategoryKeys: [...FOOTWEAR_KEYS], armed: true, policy };
}

// The live config with the standing group in place and every footwear
// category's own entry removed — the state the apply runner produces. Used by
// the census to model "after" EXPLICITLY, never by reading the live policy it
// is measuring.
export function proposedConfig(config) {
  const categoryPolicy = { ...(config?.categoryPolicy || {}) };
  for (const k of FOOTWEAR_KEYS) delete categoryPolicy[k];
  return {
    ...config,
    categoryPolicy,
    policyGroups: { ...(config?.policyGroups || {}), [FOOTWEAR_GROUP_KEY]: standingGroup() },
  };
}
