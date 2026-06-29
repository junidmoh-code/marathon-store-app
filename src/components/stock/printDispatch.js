// ─── DISPATCH LABEL ───────────────────────────────────────────────────────────
// Auto-prints ONE combined dispatch label when a warehouse order is marked Sent.
// Pure reuse of the existing barcode + printer stack — NO new printer path:
//   • ensureBarcode (mint-if-missing / reuse) for the (product, SENT size) code
//   • the shared label renderer (an optional `header` line carries order # + customer)
//   • connectTransport + printLabels (Phomemo by default — the proven transport)
// Each customer order is a single product + size (qty 1), so it's one label per order:
//   Order #1001 · Jane M.   /   <product per-size barcode>   /   name · size · code
//
// CALLER CONTRACT: invoke this INSIDE the Send click (the BLE chooser needs the
// user-gesture activation) and DO NOT await it — a print failure must never block
// the Send. The function never throws; it returns { ok, error } / { ok, printed }.

import { ensureBarcode } from "./barcodeStore";
import { TRANSPORTS, connectTransport, printLabels } from "./printers";

// First supported transport (Phomemo on the warehouse Android/Chrome devices).
function defaultTransport() {
  return (TRANSPORTS.find((t) => t.supported())?.id) || "phomemo";
}

// order: { id, productId, productName, size, sentSize?, customerName? }
export async function printDispatchLabel(order, transport = defaultTransport()) {
  try {
    if (!order?.productId) return { ok: false, error: "Order has no product to label." };
    // Connect FIRST — requestDevice needs the gesture, which the awaits below consume.
    const conn = await connectTransport(transport);
    // The size physically shipping is the warehouse substitute if one was picked.
    const sentSize = order.sentSize ?? order.size ?? null;
    // Mint-if-missing (warehouse stockRole) so the label always has a code; after the
    // catalog backfill this almost always just reuses the existing per-size code.
    const { code } = await ensureBarcode(order.productId, sentSize);
    const header = `Order #${order.id}${order.customerName ? "  ·  " + order.customerName : ""}`;
    // Dispatch label is now TEXT-FIRST: a big "Order #…" + small customer name —
    // no barcode (the Phomemo renderer reads `dispatch`/`orderNo`/`customerName`).
    // `code`/`header` stay on the item for the Xprinter fallback path, which still
    // renders a barcode label natively.
    const items = [{
      code, productName: order.productName, size: sentSize, header,
      dispatch: true, orderNo: order.id, customerName: order.customerName ?? "",
      count: 1,
    }];
    return await printLabels({ items, transport, conn });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
