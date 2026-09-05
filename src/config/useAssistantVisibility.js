// ─── THE LIVE READ OF /config/assistantView ──────────────────────────────────
// One tiny node, subscribed once per assistant screen — never a whole-node read
// of anything. Modelled on useStyleCodeConfig: it FAILS TO THE DEFAULT, loudly
// in the console and quietly on screen, because a denied read must never change
// what a shop floor can sell.
//
// The default is Pine-exempt (src/config/assistantVisibility.js), which is also
// the value the first paint uses — so neither a Pine nor a non-Pine assistant
// ever sees the wrong catalogue flash and then correct itself.

import { useEffect, useState } from "react";
import { ref, onValue } from "firebase/database";
import { database } from "../firebase";
import {
  ASSISTANT_VISIBILITY_PATH,
  DEFAULT_DEACTIVATED_SHOPS,
  readDeactivatedShops,
} from "./assistantVisibility";

export function useAssistantVisibility() {
  const [state, setState] = useState({
    deactivatedShops: DEFAULT_DEACTIVATED_SHOPS,
    ready: false,
    source: "default",
  });

  useEffect(() => {
    let alive = true;
    const off = onValue(
      ref(database, ASSISTANT_VISIBILITY_PATH),
      (snap) => {
        if (!alive) return;
        const val = snap.exists() ? snap.val() : null;
        setState({
          deactivatedShops: readDeactivatedShops(val),
          ready: true,
          source: val && val.showDeactivatedShops ? "config" : "default",
        });
      },
      (err) => {
        console.warn("useAssistantVisibility: could not read /config/assistantView:", err && err.message);
        if (alive) setState({ deactivatedShops: DEFAULT_DEACTIVATED_SHOPS, ready: true, source: "default" });
      },
    );
    return () => { alive = false; off(); };
  }, []);

  return state;
}
