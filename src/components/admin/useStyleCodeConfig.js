// ─── WHICH CATEGORIES ARE ASKED FOR A STYLE CODE — READ LIVE ─────────────────
// /config/styleCode is admin-writable in the rules (stockRole === 'admin') and
// readable by any signed-in staff member, so widening or narrowing the gate is
// a console edit rather than a deploy.
//
// ── IT FAILS OPEN, DELIBERATELY ──────────────────────────────────────────────
// This list decides whether someone can do their job. A denied read, a network
// blip, a malformed node — every one of them resolves to the DEFAULT (sneakers
// only), never to "everything is enforced". We have already shipped a gate that
// locked the shop floor out of Add Product once; the failure mode of this hook
// must be "people can add products".
//
// `ready` is exposed so the caller can wait for the real answer before showing a
// gate. Enforcing on a default we are about to replace would flash a step in
// front of someone and then take it away.

import { useEffect, useState } from "react";
import { ref, onValue } from "firebase/database";
import { database } from "../../firebase";
import { DEFAULT_ENFORCED_CATEGORIES } from "../../config/styleCode";
import { readEnforcedCategories } from "./styleCodeGateLogic";

export const STYLE_CODE_CONFIG_PATH = "config/styleCode";

export function useStyleCodeConfig() {
  const [state, setState] = useState({
    enforced: DEFAULT_ENFORCED_CATEGORIES,
    ready: false,
    source: "default",
  });

  useEffect(() => {
    let alive = true;
    const off = onValue(
      ref(database, STYLE_CODE_CONFIG_PATH),
      (snap) => {
        if (!alive) return;
        const val = snap.exists() ? snap.val() : null;
        setState({
          enforced: readEnforcedCategories(val, DEFAULT_ENFORCED_CATEGORIES),
          ready: true,
          source: val && Array.isArray(val.enforcedCategories) ? "config" : "default",
        });
      },
      (err) => {
        // A denied or failed read must not enforce anything. Fall back loudly in
        // the console and quietly in the UI.
        console.warn("useStyleCodeConfig: could not read /config/styleCode:", err && err.message);
        if (alive) setState({ enforced: DEFAULT_ENFORCED_CATEGORIES, ready: true, source: "default" });
      },
    );
    return () => { alive = false; off(); };
  }, []);

  return state;
}
