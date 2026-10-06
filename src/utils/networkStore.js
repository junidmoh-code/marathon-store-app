// ─── THE CURRENT NETWORK REGISTRY, FOR CODE THAT IS NOT A COMPONENT ──────────
// useNetwork() pushes every /network snapshot in here, so writers that run
// outside React (applyMovement, order placement) ask the same registry the
// screens show. Before the first snapshot — and on a device that cannot read
// /network at all — this is the seed, which routes Section 2 exactly as it
// always has and holds every Section 1 location NOT live.
import { SEED_REGISTRY, normalizeNetwork } from "./networkRegistry";

let current = SEED_REGISTRY;
const listeners = new Set();

export function currentNetwork() {
  return current;
}

export function setCurrentNetworkFromRaw(raw) {
  current = normalizeNetwork(raw);
  for (const fn of listeners) fn(current);
  return current;
}

export function onNetworkChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Tests only.
export function __resetNetworkForTests() {
  current = SEED_REGISTRY;
}
