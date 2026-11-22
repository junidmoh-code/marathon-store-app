// ─── DESTINATIONS FOLLOW THE DIVISION LIST YOU ARE STANDING IN (pure) ─────────
// Junid, 22 Nov 2026. A Missing Products card is on ONE division's list, and
// its Solve / Request may only name that division's destinations:
//
//   Missing from Concrete   sneakers → Hub 3 only
//                           everything else → Pine OR Concrete (never both,
//                           never a hub)
//   Missing from Marathon   sneakers → Hub 1 OR Hub 2 (never both, never Hub 3)
//                           everything else → Marathon's shops, as before
//                           (never Pine or Concrete)
//
// A sneaker wanted in both divisions is requested once from each list.
//
// ENFORCED TWICE: the chooser renders only what `…Destinations` returns, and
// the confirm step asks `destinationProblem` of the payload it is about to
// write — so a stale screen, or a selection made before a switch of list,
// cannot write a wrong one. Every name and section comes from the network
// registry; "the Concrete division" is whichever section the registry puts the
// Concrete store in.
import { sectionOf, sectionName, locationName } from "../../utils/networkRegistry";
import { net, storeIds, hubIds } from "./sectionRouting";
import { otherMarathonHub } from "./concreteDivision";

export const concreteSectionOf = (network) => sectionOf(net(network), "concrete") || 1;

/** The hubs a sneaker on `section`'s list may be requested into. */
export function sneakerDestinations(network, section, { solveOnly = true } = {}) {
  return hubIds(net(network), { section, ...(solveOnly ? { solveOnly: true } : {}) });
}

/** The shops anything that is not a sneaker on `section`'s list may be solved into. */
export function shopDestinations(network, section) {
  return storeIds(net(network), { section });
}

/** Are this division's shops one-or-the-other? (Pine / Concrete: yes.) */
export const shopsAreExclusive = (network, section) => section === concreteSectionOf(network);

/**
 * The shop selection after a tap. Where the shops are exclusive it is a
 * SWITCH: the tapped shop goes on and every other goes off (a lit one goes
 * off, leaving none — the panel then asks for a shop). Elsewhere a plain
 * toggle, in the order ticked.
 */
export function switchShopPick(current, shop, { exclusive = false } = {}) {
  const cur = Array.isArray(current) ? current.filter(Boolean) : [];
  if (!shop) return cur;
  if (cur.includes(shop)) return cur.filter((s) => s !== shop);
  return exclusive ? [shop] : [...cur, shop];
}

/**
 * Why this payload must NOT be written from `section`'s list — or null.
 * `kind`: "sneaker" (destinations are hubs) or "product" (shops).
 */
export function destinationProblem({ network, section, destinations, kind }) {
  const N = net(network);
  const list = [...new Set((destinations || []).filter(Boolean))];
  if (!list.length) return kind === "sneaker" ? "Pick a hub first." : "Tick at least one store.";
  const division = sectionName(N, section);
  const allowed = new Set(kind === "sneaker" ? hubIds(N, { section }) : shopDestinations(N, section));
  const stray = list.find((d) => !allowed.has(d));
  if (stray) {
    const theirs = sectionOf(N, stray);
    const from = theirs && theirs !== section ? ` It is solved from the "Missing from ${sectionName(N, theirs)}" list.` : "";
    return `${locationName(N, stray) || stray} is not a destination on the "Missing from ${division}" list.${from}`;
  }
  if (kind === "sneaker") {
    const both = list.find((h) => otherMarathonHub(h) && list.includes(otherMarathonHub(h)));
    if (both) return `${locationName(N, both)} and ${locationName(N, otherMarathonHub(both))} never share a sneaker — pick one.`;
    return null;
  }
  if (shopsAreExclusive(N, section) && list.length > 1) {
    return `${list.map((s) => locationName(N, s) || s).join(" and ")} cannot both be solved for the same product — pick one.`;
  }
  return null;
}
