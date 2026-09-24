// ─── THE FIFTEEN-MINUTE DISPLAY REFILL IS UNTOUCHED ─────────────────────────
//
// Owner constraint (2026-09-24): "DO NOT TOUCH the existing automatic display
// refill that fires ~15 minutes after a sneaker sells. Its trigger, timing and
// output stay byte-for-byte the same. Add a test proving it is unchanged."
//
// The automatic path is two blocks of App.jsx:
//   TRIGGER — marking a Display Partner order READY stamps
//             displayRefillScheduledAt / displayRefillHub and nulls the four
//             resolution fields (the "Display Partner refill scheduling
//             (Phase 9)" block in updateStatus);
//   TIMING  — the Display Refill card lists a task once
//             DISPLAY_REFILL_DELAY_MS (15 min) has passed since that stamp
//             (the dueRefills useMemo).
//
// Both are pinned by the SHA-256 of their exact bytes as they stood on main at
// 95a5284b, the commit this work branched from. Any edit — a character, a
// comment, a reordered field — fails here. If the owner ever changes that path
// on purpose, re-derive the hashes from the new main in the same PR.
//
// And the wall walk's new request is checked against the TRIGGER's own field
// list, so "lands on the same card, in the same shape" is read off the code
// rather than restated in a test.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { wallWalkOrder } from "./displayRequestCore";
import { isOpenDisplayRequest } from "./displayRowCore";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, "../../App.jsx"), "utf8");
const slice = (a, b) => {
  const i = APP.indexOf(a);
  const j = APP.indexOf(b, i);
  if (i < 0 || j < 0) return null;
  return APP.slice(i, j + b.length);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

const TRIGGER = slice("    // ── Display Partner refill scheduling (Phase 9)", "    updateOrder(order.id, patch);");
const TIMING = slice("  const DISPLAY_REFILL_DELAY_MS", "  }, [orders, selectedHub, nowTick]);");

describe("the automatic display refill, byte for byte", () => {
  it("TRIGGER — the READY scheduling block is exactly main@95a5284b's", () => {
    expect(TRIGGER).not.toBeNull();
    expect(TRIGGER.length).toBe(4226);
    expect(sha(TRIGGER)).toBe("49eaebcd4b7ccb4d137a4223f765e1ef1de3e86b58c2a5d6bce53ef9b5f922ba");
  });

  it("TIMING — the Display Refill card's due rule is exactly main@95a5284b's", () => {
    expect(TIMING).not.toBeNull();
    expect(TIMING).toMatch(/const DISPLAY_REFILL_DELAY_MS = 15 \* 60 \* 1000;/);
    expect(TIMING.length).toBe(2057);
    expect(sha(TIMING)).toBe("7b55ebceac1f19b947a6ade7dbd9669cd787573c8cf186f191da274ac50e5361");
  });

  it("SEND — the refill resolution (setDisplayRefillStatus) is exactly main@95a5284b's", () => {
    const i = APP.indexOf("  const setDisplayRefillStatus = async");
    const S = APP.slice(i, APP.indexOf("  const undoDisplayRefill = async", i));
    expect(i).toBeGreaterThan(0);
    expect(sha(S)).toBe("31fe08f2d7cee10310efc142fd4e1d7a31f6c5509d66943e9a646348789367ad");
  });

  it("CHECKOUT — the partner order's creation literal is exactly main@95a5284b's", () => {
    const i = APP.indexOf("          requestDisplayPartner: item.requestDisplayPartner || false,");
    const C = APP.slice(i, APP.indexOf("          displayRefilledBy:           null,", i));
    expect(i).toBeGreaterThan(0);
    expect(sha(C)).toBe("0089549ef1e3ca01347277bd41ff9da6e35e28d66fde59c191aabbe1cadf1390");
  });

  it("CARD — the due-card render is main@95a5284b's plus ONE block, gated on wallWalk", () => {
    const i = APP.indexOf("      {/* Due cards — grouped by day");
    let R = APP.slice(i, APP.indexOf("      {/* Completed cards", i));
    const a = R.indexOf("                    {/* A wall-walk");
    expect(a).toBeGreaterThan(0);
    const end = "                    )}\n";
    const b = R.indexOf(end, a);
    const added = R.slice(a, b + end.length);
    // The addition renders ONLY for a wall-walk order, which the auto path never mints.
    expect(added).toMatch(/\{order\.wallWalk === true && \(/);
    expect((added.match(/&& \(/g) || []).length).toBe(1);
    R = R.slice(0, a) + R.slice(b + end.length);
    expect(sha(R)).toBe("602b6e7ad0ae8c9fd7c3a4e3780f70be0b12086bd720c784d8dbce1a689be431");
  });

  it("an auto-scheduled order still reads as an OPEN request until the picker resolves it", () => {
    const auto = { requestDisplayPartner: true, status: "collected", destShop: "trophy", productId: "p1",
                   displayRefillScheduledAt: "2026-09-24T09:00:00.000Z", displayRefillStatus: null };
    expect(isOpenDisplayRequest(auto)).toBe(true);
    expect(isOpenDisplayRequest({ ...auto, displayRefillStatus: "refilled" })).toBe(false);
  });
});

describe("the wall walk's request lands on the same card, in the same shape", () => {
  const order = wallWalkOrder({
    orderId: "042", store: "trophy", hub: "hub2",
    product: { id: "p1", name: "Shoe" }, nowIso: "2026-09-24T10:00:00.000Z", by: "u1",
  });

  it("carries every field the TRIGGER writes, with the TRIGGER's values", () => {
    // The fields assigned in the scheduling branch, read off the code.
    const branch = TRIGGER.slice(TRIGGER.indexOf("} else {"), TRIGGER.indexOf("} else if (status !== STATUS.COLLECTED)"));
    const fields = [...branch.matchAll(/patch\.(\w+)\s*=\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
    expect(fields.map(([f]) => f)).toEqual([
      "displayRefillScheduledAt", "displayRefillHub", "displayRefillStatus",
      "displayRefilledAt", "displayRefillStockDepletedAt", "displayRefilledBy",
    ]);
    for (const [f, rhs] of fields) {
      if (rhs === "null") expect(order[f]).toBeNull();
      else if (rhs === "now") expect(order[f]).toBe("2026-09-24T10:00:00.000Z");
      else expect(order[f]).toBe(order.placedAtHub);           // placedAtHub || tag || "hub1"
    }
  });

  it("passes every filter the card's due rule applies (for the hub that holds the shoe)", () => {
    expect(order.requestDisplayPartner).toBe(true);
    expect(order.displayRefillScheduledAt).toBeTruthy();
    expect(order.displayRefillHub).toBe("hub2");
    expect(order.displayRefillStatus).toBeNull();
    expect(isOpenDisplayRequest(order)).toBe(true);
  });

  it("names no size — the picker chooses it at Send", () => {
    expect(order.size).toBeNull();
    expect(order.sentSize).toBeNull();
  });
});
