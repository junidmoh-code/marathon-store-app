// ── Should the live checkout move to origin/main, and what does that take? ───
// The decision half of live-update.mjs, kept pure so every branch is a test.
// It never looks at the disk or at git: the caller hands it what git said.

// A dependency tree is reinstalled only when ITS lockfile changed.
export const LOCKFILE_DIRS = Object.freeze({
  "package-lock.json": ".",
  "functions/package-lock.json": "functions",
  "scripts/cardrecon/package-lock.json": "scripts/cardrecon",
});

// Every other job in this checkout runs one tick and exits, so launchd starts
// its next tick on the new code with nothing to do here. These are the ones
// that STAY UP (checked on the mini, 11 Nov 2026: quote-runner.mjs had been one
// process for 8 days) and would otherwise keep running the code they started
// with. Restarted only when something they could have imported changed.
export const LONG_LIVED = Object.freeze([
  { label: "com.marathon.shippingquotes", prefixes: ["scripts/shipping/", "scripts/shopify/", "scripts/lib/", "src/utils/", "functions/"] },
]);

/**
 *   head, target            commit ids (HEAD, origin/main)
 *   targetDescendsFromHead  is `target` HEAD or ahead of it (fast-forward only)
 *   trackedEdits            tracked files someone has modified in the checkout
 *   changedFiles            files that differ between head and target
 * → { action: "none" | "refuse" | "update", why, npmCi: [dir], restart: [label], check: [file] }
 */
export function planLiveUpdate({ head, target, targetDescendsFromHead, trackedEdits = [], changedFiles = [] } = {}) {
  const no = (action, why) => ({ action, why, npmCi: [], restart: [], check: [] });
  if (!head || !target) return no("refuse", "could not read HEAD or origin/main");
  if (head === target) return no("none", "already at origin/main");
  // Never backwards and never sideways: a checkout that is AHEAD of main, or on
  // something main does not contain, is a person's work — not ours to move.
  if (!targetDescendsFromHead) return no("refuse", `HEAD ${head.slice(0, 8)} is not behind origin/main ${target.slice(0, 8)} — someone moved this checkout by hand; left alone`);
  // A hand-edited tracked file means someone is working in the live directory.
  if (trackedEdits.length) return no("refuse", `tracked file(s) edited in the live checkout (${trackedEdits.slice(0, 5).join(", ")}${trackedEdits.length > 5 ? ", …" : ""}) — left alone`);
  return {
    action: "update",
    why: `${changedFiles.length} file(s) changed between ${head.slice(0, 8)} and ${target.slice(0, 8)}`,
    npmCi: Object.entries(LOCKFILE_DIRS).filter(([lock]) => changedFiles.includes(lock)).map(([, dir]) => dir),
    restart: LONG_LIVED.filter((s) => changedFiles.some((f) => s.prefixes.some((p) => f.startsWith(p)))).map((s) => s.label),
    // Parsed before any tick may run them: a file that does not even parse
    // must never be what the next tick starts.
    check: changedFiles.filter((f) => /^(scripts|functions|tools)\/.*\.(mjs|cjs|js)$/.test(f) && !/(^|\/)node_modules\//.test(f)),
  };
}
