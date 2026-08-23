// ─── Permission catalog (pure data) ──────────────────────────────────────────
// The grantable permission set + its derivations, extracted from UserManagement
// so the invariants are unit-testable without importing the editor component
// (which pulls in firebase at module load). EVERY key here gates something real
// in App.jsx / the RTDB rules — no decorative toggles.
//
// TWO LOAD-BEARING INVARIANTS a reviewer/editor MUST preserve (pinned in
// permissionCatalog.test.js):
//   1. `stock: true` on an entry adds it to STOCK_PERM_KEYS, which auto-links a
//      stockRole when the toggle is switched on (UserManagement.jsx ~625/1083).
//      A NON-stock permission (like display_checks) must NOT carry that flag, or
//      granting it would silently hand out stock-write access.
//   2. A key in ROLE_DEFAULT_PERMS is auto-granted to every user of that role
//      (and is the Add-Staff default). A per-user-only permission (like
//      display_checks) must NOT be in any role default — it is granted ONLY via
//      the explicit per-user toggle.
//
// If you add a key here, ALSO add it to VALID_PERMISSIONS in functions/index.js
// or createStaffUser will reject accounts that carry it.
export const PERMISSION_GROUPS = [
  { title: "Ordering", perms: [
    { key: "store_assistant", label: "Place Orders",  desc: "Take customer orders (Store Assistant screen)" },
    { key: "place_orders",    label: "Returns",       desc: "Log returned items" },
    { key: "warehouse",       label: "Order Queue",   desc: "Work the warehouse order queue" },
    { key: "source",          label: "Source / Restock", desc: "Raise restock requests" },
  ] },
  { title: "Products & Displays", perms: [
    { key: "product_admin",   label: "Products & Displays", desc: "Manage products, TV display & customer view" },
    { key: "display_checks",  label: "Display Checks", desc: "Clothing display checks" },
    // Opens the AI Studio's Photo Studio tab ONLY, and authorises the
    // generateProductPhotos callable. Every tap spends real AI credits, hence
    // `sensitive` — and hence per-user-only: deliberately absent from every
    // ROLE_DEFAULT_PERMS entry so no role preset can hand out spending power.
    // Name Cleanup, Reorder and the Style Kit stay super-admin.
    { key: "ai_photos",       label: "AI Photo Studio", desc: "Generate product photos (spends AI credits)", sensitive: true },
  ] },
  { title: "Stock", perms: [
    { key: "stock_management", label: "Stock",          desc: "Transfers, locator & history", stock: true },
    { key: "stock_add",        label: "Set / Add Stock", desc: "Adjust on-hand counts", stock: true },
    { key: "barcode",          label: "Barcodes",        desc: "Create & print product barcodes", stock: true },
  ] },
  { title: "Business", perms: [
    { key: "insights",      label: "Insights",          desc: "Business analytics" },
    { key: "broadcast",     label: "Group Broadcast",   desc: "Send WhatsApp broadcasts", sensitive: true },
    { key: "customer_data", label: "Customer Database", desc: "View customer records", sensitive: true },
  ] },
];
export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.perms);
// Stock permissions that need a stockRole to actually write (drives the auto-link).
export const STOCK_PERM_KEYS = ALL_PERMISSIONS.filter((p) => p.stock).map((p) => p.key);

// Role presets — applied when a role is tapped in the editor and used as
// Add-Staff defaults. Admin = every operational permission EXCEPT staff
// management (super-admin only). Mirrors scripts/seedUsers.cjs intent.
export const ROLE_DEFAULT_PERMS = {
  admin:           ["store_assistant", "place_orders", "warehouse", "source", "product_admin", "stock_management", "stock_add", "barcode", "insights", "broadcast", "customer_data"],
  store_assistant: ["store_assistant", "place_orders"],
  warehouse:       ["warehouse", "source", "stock_management", "stock_add", "barcode"],
};
