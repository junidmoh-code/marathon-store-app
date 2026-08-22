// ─── THE CARD WRITES NOTHING — PROVED OVER THE SOURCE, NOT OVER A RUN ─────────
// NetworkTotals.render.test.jsx proves no write API fires during a session of
// use. That is a proof about ONE path through the code. This is the other half:
// a scan of every file the feature owns, so a write added later — on a branch,
// behind a condition, in a handler no test happens to click — fails here.
//
// The rule is deliberately blunt. This feature has no legitimate reason to hold
// a reference to a writer of any kind, so the honest guard is "none of these
// identifiers appear at all", not "none of them are reachable".
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNED = ["networkTotalsCore.js", "networkTotalsStore.js", "NetworkTotals.jsx"];

// Every mutating RTDB export, the app's own stock writer, and the Storage/HTTP
// escape hatches a "read-only" screen could smuggle a side effect through.
// A FREE call only — "(^|[^.\\w])name(" — so `cache.set(…)` on a Map and
// `negatives.push(…)` on an array stay legal while the modular SDK's own
// `set(ref, …)` / `update(ref, …)` / `push(ref, …)` cannot appear. (No
// lookbehind: a negative-lookbehind assertion here would be a parse-time
// SyntaxError on an older tablet and blank the whole app — and the repo-wide
// guard in noLookbehind.test.js scans this file too, comments included.)
const FREE_CALL = (name) => `(^|[^.\\w])${name}\\s*\\(`;
const FORBIDDEN = [
  FREE_CALL("set"), FREE_CALL("update"), FREE_CALL("push"), FREE_CALL("remove"),
  "runTransaction", "setWithPriority", "onDisconnect", "\\bserverTimestamp\\b",
  "applyMovement", "setCellState", "logInsight",
  "httpsCallable", "uploadBytes", "uploadString", "deleteObject",
  FREE_CALL("fetch"), "XMLHttpRequest", "sendBeacon",
];

const source = (f) => readFileSync(join(HERE, f), "utf8");

// Comments describe the design (and name applyMovement to explain why it is
// absent); the guard is about executable code, so strip comments first.
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

describe("network totals is read-only by construction", () => {
  for (const file of OWNED) {
    it(`${file} contains no write call of any kind`, () => {
      const body = code(source(file));
      for (const pattern of FORBIDDEN) {
        expect(body, `${file} contains a forbidden write: ${pattern}`).not.toMatch(new RegExp(pattern, "m"));
      }
    });

    it(`${file} imports nothing that writes`, () => {
      const imports = [...code(source(file)).matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)];
      for (const [, clause, from] of imports) {
        if (from === "firebase/database") {
          // The ONLY two database imports this feature is allowed to hold.
          const named = clause.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
          expect(named.sort()).toEqual(["get", "ref"]);
        }
        expect(from).not.toMatch(/applyMovement|firebase\/storage|firebase\/functions/);
      }
    });
  }

  // Mutation proof: the scanner must actually be able to fail. A guard that
  // cannot go red is decoration.
  it("would catch a write added to any of the three files", () => {
    const mutants = [
      'update(ref(database, "stock/central/p1"), { qty: 0 });',
      "await set(cellRef, next);",
      "runTransaction(counterRef, (n) => (n || 0) + 1);",
      'applyMovement({ type: "adjustment" });',
      'await fetch("https://example.com/log", { method: "POST" });',
    ];
    for (const mutant of mutants) {
      const body = code(`${source("networkTotalsStore.js")}\n${mutant}\n`);
      expect(FORBIDDEN.some((p) => new RegExp(p, "m").test(body)), `undetected mutant: ${mutant}`).toBe(true);
    }
  });
});
