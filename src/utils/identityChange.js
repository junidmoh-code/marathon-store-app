// ─── "A DIFFERENT PERSON IS SIGNED IN NOW" — ONE PLACE THAT SAYS SO ──────────
//
// Anything this app keeps in memory or on the device on behalf of whoever is
// signed in — a held live snapshot, the Insights day cache, the Home card's
// copy of the register — must be let go when that person changes, including
// when they sign out. This is the one auth listener those caches share.
//
// Wired on first use, so importing a module that registers here touches auth
// only when the app actually runs. The first auth answer is not a change.

import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";

const listeners = new Set();
let wired = false;
let lastUid;

function wire() {
  if (wired) return;
  wired = true;
  try {
    onAuthStateChanged(auth, (user) => {
      const uid = user ? user.uid : null;
      const changed = lastUid !== undefined && uid !== lastUid;
      lastUid = uid;
      if (!changed) return;
      for (const fn of [...listeners]) {
        try { fn(uid); } catch (err) { console.warn("identity change: a listener threw:", err); }
      }
    });
  } catch { /* auth unavailable — each read's own auth gate still applies */ }
}

/** Call `fn(newUidOrNull)` whenever the signed-in identity changes. */
export function onIdentityChange(fn) {
  listeners.add(fn);
  wire();
  return () => { listeners.delete(fn); };
}
