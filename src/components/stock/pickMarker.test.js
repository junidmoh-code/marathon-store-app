// pickMarker.js — the client half of "a scan landing mid-pick cannot touch the
// request" — pinned equal to its server twin and its claim body driven.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { pickInProgress, claimPickTxn, PICK_MARKER_TTL_MS } from "./pickMarker";
import { refusalTxn } from "./refusalGuard";

const server = createRequire(import.meta.url)("../../../functions/lib/shop-source-rule.cjs");
const NOW = Date.parse("2026-10-03T12:00:00.000Z");

describe("pickMarker", () => {
  it("is the server's pickInProgress, byte for byte in behaviour", () => {
    expect(PICK_MARKER_TTL_MS).toBe(server.PICK_MARKER_TTL_MS);
    for (const rr of [null, {}, { picking: null }, { picking: "x" }, { picking: { atMs: NOW } }, { picking: { atMs: NOW - PICK_MARKER_TTL_MS + 1 } },
      { picking: { atMs: NOW - PICK_MARKER_TTL_MS } }, { picking: { atMs: "nope" } }, { picking: {} }]) {
      expect(pickInProgress(rr, NOW), JSON.stringify(rr)).toBe(server.pickInProgress(rr, NOW));
    }
  });
  it("claim: probes a cold null, refuses a resolved row and another device's fresh claim, re-stamps its own", () => {
    const args = { movementId: "rrf_a", atMs: NOW, by: "u1" };
    expect(claimPickTxn(null, args)).toBeNull();
    expect(claimPickTxn({ status: "fulfilled" }, args)).toBeUndefined();
    expect(claimPickTxn({ status: "open", picking: { atMs: NOW - 1000, movementId: "rrf_a_1" } }, args)).toBeUndefined();
    expect(claimPickTxn({ status: "open", picking: { atMs: NOW - 1000, movementId: "rrf_a" } }, args).picking).toEqual({ atMs: NOW, movementId: "rrf_a", by: "u1" });
    expect(claimPickTxn({ status: "open", picking: { atMs: NOW - PICK_MARKER_TTL_MS - 1, movementId: "rrf_a_1" } }, args).picking.movementId).toBe("rrf_a");
    expect(claimPickTxn({ status: "open", qty: 2 }, args)).toEqual({ status: "open", qty: 2, picking: { atMs: NOW, movementId: "rrf_a", by: "u1" } });
  });
  it("Out of Stock waits while another device has claimed the line", () => {
    const row = { status: "open", qty: 1, picking: { atMs: NOW - 1000, movementId: "rrf_a" } };
    expect(refusalTxn(row, { status: "cancelled" }, { nowMs: NOW })).toBeUndefined();
    expect(refusalTxn({ ...row, picking: { atMs: NOW - PICK_MARKER_TTL_MS - 1, movementId: "rrf_a" } }, { status: "cancelled" }, { nowMs: NOW }).status).toBe("cancelled");
  });
});
