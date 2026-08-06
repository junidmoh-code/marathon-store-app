// ─── STOCK ACCESS — the one derivation of "may this viewer touch stock" ──────
// Lived in DisplayRegister.jsx until that module was removed (displays are hub
// stock now — see HubCleanup.jsx). The derivation is app-wide load-bearing:
// App.jsx gates the Stock/Health/Attention/Marketing tiles and routes on it.
// One definition, every call site, no chance of two hand-written copies
// drifting.

export function hasStockAccess({ permRecord = null, hasPermission = () => false, isSuperAdmin = false } = {}) {
  const stockRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  return stockRole === "admin" || stockRole === "warehouse" || !!hasPermission("stock_management");
}
