// ─── QUEUE BOARD — ?demo=1 ────────────────────────────────────────────────────
// The mockup's own dummy orders, so the full design can be seen on an empty
// queue. Render-only: demo mode swaps what the board DRAWS and nothing else — the
// board never writes, and the live listeners upstream are untouched.
const demoRows = (list) => list.map(([number, meta]) => ({ key: `demo:${number}`, number, meta }));
export const DEMO_BOARD = {
  incoming: { total: 12, rows: demoRows([["L-366", "12:43"], ["L-365", "12:37"], ["L-364", "12:21"], ["L-363", "11:58"], ["L-362", "11:44"]]) },
  ready:    { total: 8,  rows: demoRows([["071", "2h ago"], ["064", "3h ago"], ["065", "4h ago"], ["047", "5h ago"], ["039", "6h ago"]]) },
  oos:      { total: 3,  rows: demoRows([["L-358", "2h ago"], ["L-352", "4h ago"], ["L-349", "5h ago"]]) },
  tomorrow: { total: 5,  rows: demoRows([["L-371", "09:00"], ["L-370", "10:30"], ["L-369", "12:00"], ["L-368", "14:30"], ["L-367", "16:00"]]) },
};

// ?demo=1 in the QUERY STRING — kiosk URL /?demo=1#tv. (Not in the hash:
// AuthGate routes the kiosk on hash === "#tv" exactly.)
export function isDemoMode(loc = typeof window !== "undefined" ? window.location : null) {
  if (!loc) return false;
  try { return new URLSearchParams(loc.search || "").get("demo") === "1"; }
  catch { return false; }
}
