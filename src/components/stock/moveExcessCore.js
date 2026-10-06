// ─── MOVE EXCESS — the card computation (pure, testable) ─────────────────────
// Lifted out of MoveExcess.jsx unchanged in its arithmetic, for one reason:
// the deficit pool. It used to be ONE network-wide pool keyed pid|size, which
// was right while the network was one section. With two it would hold a
// Section 1 surplus back for a Section 2 need (or recommend sending it there)
// — a move the section wall refuses. So the pool is PER SECTION now:
//
//   • a surplus covers deficits only in its OWN section's stores and hubs;
//   • whatever is beyond that goes back to CENTRAL (hub → Central and
//     store → Central are always allowed);
//   • only LIVE locations have a deficit worth holding stock for — nothing is
//     refilled automatically at a location that has not been counted in, so
//     its "need" must not pull another location's surplus toward it. A
//     non-live location's own excess is still listed, and goes to Central by
//     hand.
//
// For Section 2 (every location live, one section) the pool is exactly the
// old one, so every card and every number is what it was.

import { encodeSizeKey, decodeSizeKey } from "../../utils/sizeKey";
import { isDeactivated } from "../../utils/deactivation";
import { wallAllows, isLive, sectionOf } from "../../utils/networkRegistry";
import { sizeRank } from "./hubSizeRank";
import { net, storeIds, solveHubFor, centralId, isCentral } from "./sectionRouting";

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

// The engine's routes when its config has not answered (or names none): each
// LIVE store behind its default back-stock hub, each of those hubs behind
// Central. On the seed registry: Marathon PE → Hub 2, Trophy → Hub 2,
// Hub 2 → Central — the literal map this replaced.
export function registryRoutes(network, { liveOnly = true } = {}) {
  const N = net(network);
  const out = {};
  for (const s of storeIds(N, { liveOnly })) {
    const h = solveHubFor(N, s, null, null);
    if (!h || (liveOnly && !isLive(N, h))) continue;
    out[s] = h;
    out[h] = centralId(N);
  }
  return out;
}

// The locations Move Excess walks, and where each one's route leads.
//   • the engine's configured routes, exactly as before;
//   • plus every registry store and its hub the config does not name yet (a
//     location that is not live is VISIBLE here — its excess can be sent back
//     to Central by hand).
// `canSee` (optional) keeps a viewer to their own sections.
export function excessSources(network, routesCfg, { canSee } = {}) {
  const N = net(network);
  const cfg = routesCfg && Object.keys(routesCfg).length ? routesCfg : registryRoutes(N);
  const all = registryRoutes(N, { liveOnly: false });
  const routes = { ...all, ...cfg };
  // Same deterministic order as the engine (downstream stores before their
  // source) so per-card allocation attribution matches the scan's advisory
  // numbers — the greedy split is sum-invariant but not order-invariant.
  const order = (list) => list.slice().sort((a, b) => {
    if (routes[a] === b) return -1;
    if (routes[b] === a) return 1;
    return a.localeCompare(b);
  });
  // The configured locations FIRST, in exactly the order they always had; the
  // registry's additions after them. (Sorting the two together could reorder
  // the configured ones — the comparator is a partial order — and the order
  // decides which store's surplus is attributed to a hub need.)
  const added = Object.keys(all)
    .filter((l) => cfg[l] === undefined && sectionOf(N, l) !== null)
    .filter((l) => (typeof canSee === "function" ? canSee(l) : true));
  return { sources: [...order(Object.keys(cfg)), ...order(added)], routes };
}

// A BUFFER hub: a location another listed location is refilled from (Hub 2
// for Marathon PE and Trophy; Hub 3 for Pine and Concrete). Its surplus is
// judged NET of what its section still needs. Hub 1 is nobody's route, so it
// is judged like a store — exactly as it was when this read `loc === "hub2"`.
export const isBufferHub = (loc, sources, routes) => (sources || []).some((s) => s !== loc && routes?.[s] === loc);

export function computeMoveExcessCards({
  allStock, allTargets, byId, openRequests, heldLines, sources, routes, storeMin, network,
} = {}) {
  const N = net(network);
  const out = [];
  // A location the registry does not know has no section; it pools under ""
  // with any other such location, as the single network-wide pool used to.
  const poolOf = (loc) => sectionOf(N, loc) ?? "";
  // Deficit per (section,pid,size): surplus that another location IN THE SAME
  // SECTION still NEEDS is held for refills, never offered to Central (mirrors
  // the engine's "Cortez fix" netting; client-side we approximate without
  // inbound data, which only errs toward holding MORE back — the safe
  // direction).
  const deficitBySize = new Map();
  // Inbound already on its way per (dest,pid,size) — open engine requests.
  const inbound = new Map();
  for (const r of openRequests || []) {
    if (!r?.productId || !r.requestingLocation || r.shadow) continue;
    const k = `${r.requestingLocation}|${r.productId}|${encodeSizeKey(r.size)}`;
    inbound.set(k, (inbound.get(k) || 0) + (Number(r.qty) || 1));
  }
  for (const [dest, byLine] of Object.entries(heldLines || {})) {
    for (const line of Object.values(byLine || {})) {
      if (!line?.productId || (line.sizeKey == null && line.size == null)) continue;
      const k = `${dest}|${line.productId}|${line.sizeKey != null ? String(line.sizeKey) : encodeSizeKey(line.size)}`;
      inbound.set(k, (inbound.get(k) || 0) + (Number(line.qty) || 1));
    }
  }
  for (const loc of sources || []) {
    // Only a LIVE location's need holds stock back. (A location the registry
    // does not know is left as it was: counted.)
    if (sectionOf(N, loc) !== null && !isLive(N, loc)) continue;
    for (const [pid, bySize] of Object.entries(allTargets?.[loc] || {})) {
      for (const [sizeKey, t] of Object.entries(bySize || {})) {
        if (!t || typeof t.target !== "number") continue;
        const have = Math.max(Number(allStock?.[loc]?.[pid]?.[decodeSizeKey ? decodeSizeKey(sizeKey) : sizeKey]?.qty) || 0, 0);
        const deficit = t.target - have - (inbound.get(`${loc}|${pid}|${sizeKey}`) || 0);
        if (deficit > 0) {
          const k = `${poolOf(loc)}|${pid}|${sizeKey}`;
          deficitBySize.set(k, (deficitBySize.get(k) || 0) + deficit);
        }
      }
    }
  }
  for (const loc of sources || []) {
    const buffer = isBufferHub(loc, sources, routes);
    const minEx = buffer ? 1 : storeMin;
    // The hub leg exists only where the route's hub is on this location's
    // side of the wall (or the route simply leads to Central).
    const hubDest = routes?.[loc];
    const hubLegOpen = !!hubDest && (isCentral(hubDest, N) || wallAllows(N, loc, hubDest));
    for (const [pid, bySize] of Object.entries(allStock?.[loc] || {})) {
      const p = byId.get(pid);
      if (!isClothing(p)) continue;
      // Lockstep with the engine's excess pass, where resolveTarget nulls a
      // deactivated product: a finished line is not "excess to move" (moving
      // it would reactivate it on arrival) — its stock shows on the
      // Deactivated list instead.
      if (isDeactivated(p)) continue;
      const sizes = [];
      for (const [size, cell] of Object.entries(bySize || {})) {
        const qty = typeof cell?.qty === "number" ? cell.qty : 0;
        const t = allTargets?.[loc]?.[pid]?.[encodeSizeKey(size)];
        // Three states (v5): configured target → judged; explicit target 0 →
        // deliberately excluded, every unit is excess; NO target → not judged
        // here at all (it shows under "No Target Configured" in Health — the
        // engine never assumes unconfigured stock is misplaced).
        if (!t || typeof t.target !== "number") continue;
        const raw = qty - t.target;
        const dKey = `${poolOf(loc)}|${pid}|${encodeSizeKey(size)}`;
        const lineMin = t.target === 0 ? 1 : minEx;
        if (buffer) {
          // A buffer hub stays NET-based: its held units flow onward
          // automatically via the engine's hub→store refill legs.
          const held = Math.min(Math.max(raw, 0), deficitBySize.get(dKey) || 0);
          const excessQty = raw - held;
          if (excessQty >= lineMin) sizes.push({ size, have: qty, target: t.target, excess: excessQty, toHub: 0, toCentral: excessQty });
        } else if (raw >= lineMin) {
          // TWO-LEG split (owner directive 2026-07-13): stores move their
          // WHOLE overage in one visit — deficit-covering units → their hub
          // (Cortez preserved: never to Central), remainder → Central. The
          // deficit is CONSUMED as cards allocate so two stores never both
          // fill the same hub need (lockstep with the engine).
          const need = hubLegOpen ? (deficitBySize.get(dKey) || 0) : 0;
          const toHub = Math.min(raw, need);
          if (hubLegOpen) deficitBySize.set(dKey, need - toHub);
          sizes.push({ size, have: qty, target: t.target, excess: raw, toHub, toCentral: raw - toHub });
        }
      }
      if (!sizes.length) continue;
      sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      out.push({
        key: `${loc}|${pid}`, loc, pid, name: p?.name || pid, photo: p?.photoUrl,
        sizes, totalExcess: sizes.reduce((t, s) => t + s.excess, 0),
      });
    }
  }
  return out.sort((a, b) => b.totalExcess - a.totalExcess);
}
