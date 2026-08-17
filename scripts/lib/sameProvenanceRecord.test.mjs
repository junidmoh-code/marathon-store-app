// ─── COMPARING TWO PROVENANCE RECORDS — the contention check's evidence ────────
//
// WHY THIS FILE EXISTS
// The first live `backfill-stock-provenance.mjs --execute` run reported 283 pairs as
// CONTENDED and removed every readiness sentinel. There was no contention. The
// comparison was `JSON.stringify(live) !== JSON.stringify(expected)`, and RTDB returns
// a node's children in lexicographic order (`{k, s}`) while `toRecord` builds them in
// counter order (`{s, k, u}`) — so `{"s":2,"k":14}` and `{"k":14,"s":2}`, the same
// record, compared unequal.
//
// The fail-safe did its job: it refused to publish rather than publish something it
// could not vouch for. What was wrong was the evidence, and a false CONTENDED is not
// harmless — it silences all rule-based auto-refill until someone re-runs the script.
//
// The comparator is duplicated here rather than exported from the script, because the
// script is a top-level-await ESM program that connects to RTDB on import and cannot be
// imported by a test. The duplication is pinned by reading the script's own source
// below, so the two cannot drift.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

function normCounter(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v % 1 !== 0) return NaN;
  return v;
}
const COUNTER_FIELDS = ["s", "k", "u"];
function sameRecord(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  for (const f of COUNTER_FIELDS) {
    const x = normCounter(a[f]), y = normCounter(b[f]);
    if (!(x === y)) return false;
  }
  const foreign = (o) => Object.keys(o).some((k) => !COUNTER_FIELDS.includes(k));
  return !foreign(a) && !foreign(b);
}

describe("the regression that removed every sentinel", () => {
  it("treats RTDB key order as identical — the exact live pairs that misfired", () => {
    // Copied from the failed run's own report.
    expect(sameRecord({ k: 14, s: 2 }, { s: 2, k: 14 })).toBe(true);
    expect(sameRecord({ k: 7, s: 1 }, { s: 1, k: 7 })).toBe(true);
    expect(sameRecord({ k: 13, s: 1 }, { s: 1, k: 13 })).toBe(true);
    // MUTATION: revert to JSON.stringify comparison and all three of these fail,
    // which is precisely what happened live.
    expect(JSON.stringify({ k: 14, s: 2 }) === JSON.stringify({ s: 2, k: 14 })).toBe(false);
  });

  it("treats an omitted counter and a zero counter alike — toRecord omits zeroes", () => {
    expect(sameRecord({ k: 4 }, { k: 4, u: 0 })).toBe(true);
    expect(sameRecord({ k: 4, s: 0, u: 0 }, { k: 4 })).toBe(true);
    expect(sameRecord({}, { s: 0, k: 0, u: 0 })).toBe(true);
  });
});

describe("real differences are still differences", () => {
  it("any counter differing by any amount", () => {
    expect(sameRecord({ k: 4 }, { k: 5 })).toBe(false);
    expect(sameRecord({ k: 4, u: 4 }, { k: 4, u: 3 })).toBe(false);   // the `u` case that arms falsely
    expect(sameRecord({ s: 1 }, { s: 2 })).toBe(false);
    expect(sameRecord({ k: 4 }, {})).toBe(false);
  });

  it("a FOREIGN key on either side — the thing the check exists to catch", () => {
    // MUTATION: drop the `foreign` test and an unexpected key writes itself into the
    // index unnoticed, which is the one shape `$other: .validate false` cannot stop
    // (the Admin SDK bypasses rules).
    expect(sameRecord({ k: 4, hacked: 1 }, { k: 4 })).toBe(false);
    expect(sameRecord({ k: 4 }, { k: 4, hacked: 1 })).toBe(false);
  });

  it("null, missing and malformed shapes never compare equal to a record", () => {
    expect(sameRecord(null, { k: 1 })).toBe(false);
    expect(sameRecord({ k: 1 }, null)).toBe(false);
    expect(sameRecord(null, null)).toBe(true);
    expect(sameRecord(undefined, null)).toBe(true);
    expect(sameRecord(7, { k: 7 })).toBe(false);
    expect(sameRecord("k:7", { k: 7 })).toBe(false);
    expect(sameRecord([], {})).toBe(false);
    // A counter that is PRESENT but not a finite integer is a DIFFERENCE, never a
    // quiet match against an absent one. Laundering corruption into 0 would let a
    // foreign or broken write pass the contention check.
    expect(sameRecord({ k: NaN }, {})).toBe(false);
    expect(sameRecord({ k: Infinity }, { k: 0 })).toBe(false);
    expect(sameRecord({ k: "4" }, { k: 4 })).toBe(false);
    expect(sameRecord({ k: 1.5 }, { k: 1 })).toBe(false);
    // …and not even against another corrupt one.
    expect(sameRecord({ k: NaN }, { k: NaN })).toBe(false);
  });
});

describe("the script uses THIS comparator, not a stringify", () => {
  const src = readFileSync(new URL("../backfill-stock-provenance.mjs", import.meta.url), "utf8");

  it("declares sameRecord with the same field list and semantics", () => {
    expect(src).toMatch(/const COUNTER_FIELDS = \["s", "k", "u"\];/);
    expect(src).toMatch(/function sameRecord\(a, b\) \{/);
    expect(src).toMatch(/function normCounter\(v\) \{/);
    expect(src).toMatch(/if \(typeof v !== "number" \|\| !Number\.isFinite\(v\) \|\| v % 1 !== 0\) return NaN;/);
    expect(src).toMatch(/const x = normCounter\(a\[f\]\), y = normCounter\(b\[f\]\);/);
    expect(src).toMatch(/const foreign = \(o\) => Object\.keys\(o\)\.some\(\(k\) => !COUNTER_FIELDS\.includes\(k\)\);/);
  });

  it("uses it for the contention comparison, and no stringify comparison survives there", () => {
    expect(src).toMatch(/!sameRecord\(liveLoc\[pid\], expected\)/);
    // MUTATION: put the stringify comparison back and this fails.
    expect(src).not.toMatch(/JSON\.stringify\(liveLoc\[pid\]\)/);
  });
});

// ═══ THE FAIL-SAFE MUST STILL FIRE ═══════════════════════════════════════════
// Owner requirement: fixing the 283 false positives by canonicalising key order is
// correct; making the comparison FORGIVING is not. These tests are the guard on that
// distinction. They replay a genuine concurrent increment landing mid-backfill — the
// scenario that must still produce CONTENDED and still refuse to arm — using the same
// comparator the contention loop calls.

// The contention loop's decision, reduced to its inputs. Mirrors the live code:
//   expected = payload[path] ?? preExistingOrphans.get(path) ?? null
//   null            → contended ("pair did not exist when this run started")
//   !sameRecord(...) → contended
const contendedBecause = (live, expected) => {
  if (expected === null || expected === undefined) return "unexpected-pair";
  if (!sameRecord(live, expected)) return "changed-pair";
  return null;
};

describe("a REAL concurrent increment still trips the check", () => {
  it("a `u` increment landing mid-backfill — the one that arms falsely if lost", () => {
    // Pass 1 SET {k:4, u:3} from its ledger read. An undo then lands and applyMovement
    // increments u to 4. If this comparison waved that through, the run would claim
    // authority and the convergence SET would restore u:3 — raising k−u from 0 to 1 and
    // arming a shop that holds nothing. That is the exact failure CodeRabbit found.
    const passOne = { k: 4, u: 3 };
    const liveAfterUndo = { k: 4, u: 4 };
    expect(contendedBecause(liveAfterUndo, passOne)).toBe("changed-pair");
    // …and in the RTDB key order it actually arrives in, so the fix for the false
    // positives cannot be the thing that hides it.
    expect(contendedBecause({ u: 4, k: 4 }, passOne)).toBe("changed-pair");
  });

  it("a `k` increment landing mid-backfill", () => {
    expect(contendedBecause({ k: 5 }, { k: 4 })).toBe("changed-pair");
    expect(contendedBecause({ s: 1, k: 5 }, { k: 4, s: 1 })).toBe("changed-pair");
  });

  it("a `s` increment landing mid-backfill", () => {
    expect(contendedBecause({ k: 4, s: 3 }, { s: 2, k: 4 })).toBe("changed-pair");
  });

  it("a concurrent movement creating a pair pass 1 never saw", () => {
    // applyMovement writes the ledger record and the counter atomically, so a movement
    // for a previously unseen (loc,pid) appears at a path payload never had. Expected is
    // null, which is contention on its own — no value comparison involved.
    expect(contendedBecause({ k: 1 }, null)).toBe("unexpected-pair");
    expect(contendedBecause({ u: 1 }, undefined)).toBe("unexpected-pair");
  });

  it("the smallest possible real change — one unit on one counter — is still caught", () => {
    for (const f of ["s", "k", "u"]) {
      const expected = { k: 2 };
      const live = { ...expected, [f]: (expected[f] || 0) + 1 };
      expect(contendedBecause(live, expected)).toBe("changed-pair");
    }
  });

  it("and the run is NOT contended when the only difference is key order", () => {
    // The whole point: sharp against real change, silent on formatting.
    expect(contendedBecause({ u: 3, k: 4, s: 2 }, { s: 2, k: 4, u: 3 })).toBe(null);
    expect(contendedBecause({ k: 4 }, { k: 4, u: 0, s: 0 })).toBe(null);
  });
});
