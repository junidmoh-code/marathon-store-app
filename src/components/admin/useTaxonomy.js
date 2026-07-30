// ─── LIVE TAXONOMY REGISTRY HOOK ──────────────────────────────────────────────
// Subscribes to RTDB /settings/productTaxonomy — the runtime source of truth for
// the category system. Because this is a LIVE read, adding or retiring a
// category is a data edit in the Firebase console: no code change, no deploy,
// and every open Admin tab picks it up within a second.
//
// FALLBACK: if the read fails (offline, rules, node absent before the seed has
// run) we fall back to the checked-in TAXONOMY_SEED rather than rendering an
// empty dropdown. The Add Product form must never be brickable by a bad read —
// a stale-but-correct 31-category list is always better than no list. `source`
// tells the UI which one it is so the operator can see when they are on the
// fallback.

import { useEffect, useState } from "react";
import { ref, onValue } from "firebase/database";
import { database } from "../../firebase.js";
import { TAXONOMY_SEED } from "../../utils/productTaxonomy.js";

const REGISTRY_PATH = "settings/productTaxonomy";

// A registry is only usable if it actually holds categories — an empty or
// half-written node falls back rather than presenting a broken picker.
function usable(v) {
  return !!(v && typeof v === "object" && v.cats && typeof v.cats === "object" && Object.keys(v.cats).length > 0);
}

export function useTaxonomy() {
  const [state, setState] = useState({ registry: TAXONOMY_SEED, source: "loading", error: null });

  useEffect(() => {
    const unsub = onValue(
      ref(database, REGISTRY_PATH),
      (snap) => {
        const v = snap.val();
        setState(usable(v)
          ? { registry: v, source: "live", error: null }
          : { registry: TAXONOMY_SEED, source: "fallback", error: v == null ? "registry not seeded yet" : "registry unusable" });
      },
      (err) => setState({ registry: TAXONOMY_SEED, source: "fallback", error: err?.message || "read denied" }),
    );
    return () => unsub();
  }, []);

  return state;
}
