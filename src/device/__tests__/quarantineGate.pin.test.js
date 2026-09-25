// Every press that rejects or sends on a hub's order asks whether THIS phone
// is quarantined BEFORE it writes or moves anything (src/device/deviceRejects.js).
// App.jsx is too large to render here, so the ORDER of the lines is pinned:
// the check comes first in each handler, and the reject paths record the phone.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = readFileSync(fileURLToPath(new URL("../../App.jsx", import.meta.url)), "utf8");
const QUEUE = readFileSync(fileURLToPath(new URL("../../components/stock/RefillQueue.jsx", import.meta.url)), "utf8");

function body(src, head, len = 1400) {
  const i = src.indexOf(head);
  expect(i, `${head} not found`).toBeGreaterThan(0);
  return src.slice(i, i + len);
}
const before = (text, a, b) => {
  const i = text.indexOf(a), j = text.indexOf(b);
  expect(i, `"${a}" missing`).toBeGreaterThan(-1);
  expect(j, `"${b}" missing`).toBeGreaterThan(-1);
  return i < j;
};

describe("the quarantine is asked first, on every hub press", () => {
  it("updateStatus (Out of stock / Ready / Tomorrow) — before any write", () => {
    const b = body(APP, "const updateStatus = async (order, status, extraPatch = {}) => {");
    expect(before(b, "await thisDevicePaused()", "const patch =")).toBe(true);
  });
  it("markSentWithTransfer — before the stock transfer", () => {
    const b = body(APP, "const markSentWithTransfer = async (order, extraPatch = {}) => {");
    expect(before(b, "await thisDevicePaused()", "recordDispatchTransfer(")).toBe(true);
  });
  it("fulfillCRBatch (clothing Send / Reject) — before the loop", () => {
    const b = body(APP, "const fulfillCRBatch = async (batch, plan) => {");
    expect(before(b, "await thisDevicePaused()", "for (const it of batch.items)")).toBe(true);
  });
  it("RefillQueue Send, Out of Stock and sale Fulfil — before any read-modify-write", () => {
    expect(before(body(QUEUE, "const fulfilRequest = async (row, qty, avail) => {", 5000), "await thisDevicePaused()", "applyMovement")).toBe(true);
    expect(before(body(QUEUE, "const rejectRequest = async (row) => {", 5000), "await thisDevicePaused()", "runTransaction(")).toBe(true);
    expect(before(body(QUEUE, "const fulfilSale = async (row, pickLoc, qty, avail) => {", 5000), "await thisDevicePaused()", "applyMovement")).toBe(true);
  });
});

describe("the reject records the phone", () => {
  it("a sneaker Out of stock stamps outOfStockByUid + outOfStockDeviceId in the same patch", () => {
    const b = body(APP, "const updateStatus = async (order, status, extraPatch = {}) => {", 4000);
    expect(b).toContain("patch.outOfStockByUid = rej.uid;");
    expect(b).toContain("patch.outOfStockDeviceId = rej.deviceId;");
  });
  it("a clothing Reject stamps clothingOutOfStockDeviceId, and Send/Undo clear it", () => {
    expect(APP).toContain('clothingRefillStatus: "rejected", clothingOutOfStockAt: now, clothingOutOfStockByUid: auth.currentUser?.uid || null, clothingOutOfStockDeviceId: rej.deviceId');
    expect(APP.match(/clothingOutOfStockDeviceId: null/g)).toHaveLength(2);
  });
});
