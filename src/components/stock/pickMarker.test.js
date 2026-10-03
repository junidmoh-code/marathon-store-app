// pickMarker.js — the client half of "a scan landing mid-pick cannot touch the
// request" — pinned equal to its server twin and its claim body driven.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { pickInProgress, claimPickTxn, releasePickTxn, PICK_MARKER_TTL_MS } from "./pickMarker";
import { refusalTxn } from "./refusalGuard";

const server = createRequire(import.meta.url)("../../../functions/lib/shop-source-rule.cjs");
const NOW = Date.parse("2026-10-03T12:00:00.000Z");

describe("pickMarker", () => {
  it("is the server's pickInProgress, byte for byte in behaviour", () => {
    expect(PICK_MARKER_TTL_MS).toBe(server.PICK_MARKER_TTL_MS);
    for (const rr of [null, {}, { picking: null }, { picking: "x" }, { picking: { atMs: NOW } }, { picking: { atMs: NOW - PICK_MARKER_TTL_MS + 1 } },
      { picking: { atMs: NOW - PICK_MARKER_TTL_MS } }, { picking: { atMs: "nope" } }, { picking: {} },
      { picking: { atMs: NOW + 60e3 } }, { picking: { atMs: NOW + PICK_MARKER_TTL_MS + 1 } }]) {
      expect(pickInProgress(rr, NOW), JSON.stringify(rr)).toBe(server.pickInProgress(rr, NOW));
    }
  });
  it("claim: probes a cold null, refuses a resolved row and ANY fresh claim (same tranche included — two devices compute the same id); a stale one is taken over", () => {
    const args = { movementId: "rrf_a", atMs: NOW, by: "u1", token: "t1" };
    expect(claimPickTxn(null, args)).toBeNull();
    expect(claimPickTxn({ status: "fulfilled" }, args)).toBeUndefined();
    expect(claimPickTxn({ status: "open", picking: { atMs: NOW - 1000, movementId: "rrf_a_1", token: "t0" } }, args)).toBeUndefined();
    expect(claimPickTxn({ status: "open", picking: { atMs: NOW - 1000, movementId: "rrf_a", token: "t0" } }, args)).toBeUndefined();
    expect(claimPickTxn({ status: "open", picking: { atMs: NOW - PICK_MARKER_TTL_MS - 1, movementId: "rrf_a_1", token: "t0" } }, args).picking.token).toBe("t1");
    expect(claimPickTxn({ status: "open", qty: 2 }, args)).toEqual({ status: "open", qty: 2, picking: { atMs: NOW, movementId: "rrf_a", by: "u1", token: "t1" } });
    // a replay (its movement exists) may take over its OWN tranche's claim — never another tranche's
    expect(claimPickTxn({ status: "open", picking: { atMs: NOW - 1000, movementId: "rrf_a", token: "t0" } }, { ...args, replayOf: "rrf_a" }).picking.token).toBe("t1");
    expect(claimPickTxn({ status: "open", picking: { atMs: NOW - 1000, movementId: "rrf_a_1", token: "t0" } }, { ...args, replayOf: "rrf_a" })).toBeUndefined();
  });
  it("release: only the attempt that holds the token clears the claim", () => {
    expect(releasePickTxn(null, "t1")).toBeNull();
    expect(releasePickTxn({ token: "t1" }, "t1")).toBeNull();
    expect(releasePickTxn({ token: "t2" }, "t1")).toBeUndefined();
  });
  it("Out of Stock waits while another device has claimed the line", () => {
    const row = { status: "open", qty: 1, picking: { atMs: NOW - 1000, movementId: "rrf_a" } };
    expect(refusalTxn(row, { status: "cancelled" }, { nowMs: NOW })).toBeUndefined();
    expect(refusalTxn({ ...row, picking: { atMs: NOW - PICK_MARKER_TTL_MS - 1, movementId: "rrf_a" } }, { status: "cancelled" }, { nowMs: NOW }).status).toBe("cancelled");
  });
});
