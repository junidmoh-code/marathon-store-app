// The pure half of scripts/apply-central-clothing-policy.mjs (Junid, 12 Nov 2026).
// Builds the two config values and refuses anything that would touch a
// Marathon leg of the footwear-all group.
"use strict";

const HUB3_LEG = Object.freeze({ target: 2, minQty: 1, reorderPoint: 1, carriedOnly: true });
const DIVISION = Object.freeze({ shopOnly: Object.freeze({ perSize: 2, oneSize: 5 }) });
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

function planCentralClothingPolicy({ liveGroup, liveDivision }) {
  if (!liveGroup || liveGroup.armed !== true || !liveGroup.policy || typeof liveGroup.policy !== "object") {
    throw new Error("the footwear-all group is not armed — stop");
  }
  if (!liveDivision || typeof liveDivision !== "object") throw new Error("the Concrete division key is off — stop (this change builds on it)");
  const group = { ...liveGroup, policy: { ...liveGroup.policy, hub3: { ...HUB3_LEG } } };
  // Every key but the Hub 3 leg, byte for byte.
  const rest = (g) => stable({ ...g, policy: { ...g.policy, hub3: null } });
  if (rest(group) !== rest(liveGroup)) throw new Error("REFUSED: the new group differs from the live one outside the Hub 3 leg");
  return {
    group,
    groupChanges: stable(liveGroup.policy.hub3 ?? null) !== stable(HUB3_LEG),
    division: { shopOnly: { ...DIVISION.shopOnly } },
  };
}

module.exports = { HUB3_LEG, DIVISION, planCentralClothingPolicy };
