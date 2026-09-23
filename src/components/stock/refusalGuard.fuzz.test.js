// Property fuzz of refusalGuard.refusalTxn — 20,000 seeded random request
// nodes. Stands in for the unavailable external reviewer (PR #643) alongside a
// differently briefed second review. The invariants are the spec, not the code:
//   • a sent request is never written (abort), and is left byte-identical;
//   • a refusal NEVER produces the corrupted live shape (cancelled + fulfilledBy);
//   • every field the refusal does not set survives unchanged; nulls clear;
//   • a cold-cache null is a probe (null), never an abort.
import { describe, it, expect } from "vitest";
import { alreadySent, refusalTxn } from "./refusalGuard";

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

function randomNode(r) {
  const n = { productId: "p", size: pick(r, ["M", "7", "_", "10.5"]), qty: Math.floor(r() * 5), requestingLocation: pick(r, ["hub1", "hub2", "trophy"]) };
  const status = pick(r, ["open", "fulfilled", "cancelled", undefined]);
  if (status !== undefined) n.status = status;
  if (r() < 0.3) n.sentQty = Math.floor(r() * 4);
  if (r() < 0.3) n.fulfilledBy = pick(r, [{ movementId: "rrf_x", qty: 1 }, { movementId: "rrf_x", qty: 2, uncounted: true }, "junk", null, 0]);
  if (r() < 0.3) n.cancelReason = pick(r, ["awaiting_upstream", "no_longer_needed", "first_batch_central_declined"]);
  if (r() < 0.3) n.resolvedBy = "u_prev";
  if (r() < 0.3) n.createdFrom = { engine: true, source: pick(r, ["central", "hub2"]) };
  if (r() < 0.2) n.blockedRefusals = { 1: { atMs: 1 } };
  for (const k of Object.keys(n)) if (n[k] === null) delete n[k];   // RTDB never stores null
  return n;
}
function randomFields(r) {
  return {
    status: "cancelled", resolvedAt: "2026-09-23T09:00:00.000Z", rejectedBy: pick(r, ["warehouse", "admin", "unknown"]),
    cancelReason: pick(r, [null, "first_batch_central_declined"]),
    ...(r() < 0.8 ? { resolvedBy: "u1" } : {}),
  };
}

describe("refusalTxn — property fuzz", () => {
  it("holds every invariant over 20,000 random nodes", () => {
    const r = rng(643);
    let aborted = 0, written = 0;
    for (let i = 0; i < 20000; i++) {
      const cur = randomNode(r);
      const fields = randomFields(r);
      const before = JSON.stringify(cur);
      expect(refusalTxn(null, fields)).toBeNull();
      const next = refusalTxn(cur, fields);
      expect(JSON.stringify(cur)).toBe(before);                         // never mutates its input
      if (alreadySent(cur)) {
        aborted++;
        expect(next).toBeUndefined();
        continue;
      }
      written++;
      expect(next.status).toBe("cancelled");
      // the corrupted live shape can never be produced
      expect(!!(next.fulfilledBy && typeof next.fulfilledBy === "object")).toBe(false);
      for (const [k, v] of Object.entries(fields)) {
        if (v === null) expect(k in next).toBe(false);
        else expect(next[k]).toEqual(v);
      }
      for (const k of Object.keys(cur)) if (!(k in fields)) expect(next[k]).toEqual(cur[k]);
      for (const v of Object.values(next)) expect(v).not.toBeNull();   // nothing RTDB would reject/drop
      // a second tap on the same (now refused) node writes the same thing
      expect(refusalTxn(next, fields)).toEqual(next);
    }
    expect(aborted).toBeGreaterThan(1000);
    expect(written).toBeGreaterThan(1000);
  });
});
