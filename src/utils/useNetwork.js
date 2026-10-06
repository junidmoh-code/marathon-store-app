// /network → the normalised registry. ONE small node, read through the same
// chokepoint as every other stock path (usePathState), never a whole-tree read.
// `settled` is false until the node has answered; the registry returned in the
// meantime is the seed, which is safe to route Section 2 with.
import { useEffect, useMemo } from "react";
import { usePathState } from "../components/stock/useStock";
import { NETWORK_PATH, normalizeNetwork, SEED_REGISTRY } from "./networkRegistry";
import { setCurrentNetworkFromRaw } from "./networkStore";

export function useNetwork(enabled = true) {
  const { value, settled, error } = usePathState(NETWORK_PATH, enabled);
  const registry = useMemo(() => (settled && !error ? normalizeNetwork(value) : SEED_REGISTRY), [value, settled, error]);
  useEffect(() => {
    if (settled && !error) setCurrentNetworkFromRaw(value);
  }, [value, settled, error]);
  return { registry, settled, error, seeded: settled && !error && value != null, raw: settled && !error ? value : null };
}
