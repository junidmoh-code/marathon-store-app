import { describe, it, expect, vi, beforeEach } from "vitest";

// Dispatch printing now sends a TEXT-FIRST label (big Order #, small customer
// name, no barcode). Mock the barcode store + printer facade so we can assert
// exactly what gets handed to printLabels.
vi.mock("./barcodeStore", () => ({ ensureBarcode: vi.fn(async () => ({ code: "00001234" })) }));
vi.mock("./printers", () => ({
  TRANSPORTS: [{ id: "phomemo", supported: () => true }],
  connectTransport: vi.fn(async () => ({ device: "stub" })),
  printLabels: vi.fn(async () => ({ ok: true, printed: 1 })),
}));

import { printDispatchLabel } from "./printDispatch";
import { printLabels } from "./printers";

describe("printDispatchLabel — text-first dispatch label", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags the label as dispatch and carries order # + customer (the big/small text)", async () => {
    const r = await printDispatchLabel({
      id: "1001", productId: "p1", productName: "Nike Air Force 1", size: "9", customerName: "Jane M.",
    });
    expect(r.ok).toBe(true);
    const item = printLabels.mock.calls[0][0].items[0];
    expect(item.dispatch).toBe(true);
    expect(item.orderNo).toBe("1001");
    expect(item.customerName).toBe("Jane M.");
    expect(item.size).toBe("9");          // size still on the label for the picker
    expect(item.count).toBe(1);
  });

  it("uses the warehouse substitute size when one was picked", async () => {
    await printDispatchLabel({ id: "1003", productId: "p1", productName: "X", size: "9", sentSize: "10" });
    expect(printLabels.mock.calls[0][0].items[0].size).toBe("10");
  });

  it("tolerates a missing customer name (empty, not undefined)", async () => {
    await printDispatchLabel({ id: "1002", productId: "p1", productName: "X", size: "8" });
    const item = printLabels.mock.calls[0][0].items[0];
    expect(item.orderNo).toBe("1002");
    expect(item.customerName).toBe("");
  });

  it("refuses an order with no product", async () => {
    const r = await printDispatchLabel({ id: "1004" });
    expect(r.ok).toBe(false);
    expect(printLabels).not.toHaveBeenCalled();
  });
});
