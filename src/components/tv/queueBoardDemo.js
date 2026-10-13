// ─── QUEUE BOARD — ?demo=1 ────────────────────────────────────────────────────
// The mockup's own dummy orders, so the full design can be seen on an empty
// queue. Render-only: demo mode swaps what the board DRAWS and nothing else — the
// board never writes, and the live listeners upstream are untouched.
// Column 4 says "Tomorrow" exactly as the live board does: an order on hold for
// tomorrow carries no pickup time, so the demo must not show one either.
const demoRows = (list) => list.map(([number, meta]) => ({ key: `demo:${number}`, number, meta }));
// Busy columns carry their full lists (12 incoming, 8 ready) so the demo also
// shows the board paging through them; each total is its row count.
const demoColumn = (list) => { const rows = demoRows(list); return { total: rows.length, rows }; };
export const DEMO_BOARD = {
  incoming: demoColumn([["L-366", "just now"], ["L-365", "6m ago"], ["L-364", "22m ago"], ["L-363", "45m ago"], ["L-362", "59m ago"],
                        ["L-361", "1h ago"], ["L-360", "1h ago"], ["L-359", "1h ago"], ["L-357", "2h ago"], ["L-356", "2h ago"],
                        ["L-355", "2h ago"], ["L-354", "2h ago"]]),
  ready:    demoColumn([["071", "2h ago"], ["064", "3h ago"], ["065", "4h ago"], ["047", "5h ago"], ["039", "6h ago"],
                        ["031", "6h ago"], ["028", "7h ago"], ["022", "7h ago"]]),
  oos:      demoColumn([["L-358", "2h ago"], ["L-352", "4h ago"], ["L-349", "5h ago"]]),
  tomorrow: demoColumn([["L-371", "Tomorrow"], ["L-370", "Tomorrow"], ["L-369", "Tomorrow"], ["L-368", "Tomorrow"], ["L-367", "Tomorrow"]]),
};

// ?demo=1 in the QUERY STRING — kiosk URL /?demo=1#tv. (Not in the hash:
// AuthGate routes the kiosk on hash === "#tv" exactly.)
export function isDemoMode(loc = typeof window !== "undefined" ? window.location : null) {
  if (!loc) return false;
  try { return new URLSearchParams(loc.search || "").get("demo") === "1"; }
  catch { return false; }
}
