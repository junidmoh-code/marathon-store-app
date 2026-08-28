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
  ] },
  { title: "Stock", perms: [
    { key: "stock_management", label: "Stock",          desc: "Transfers, locator & history", stock: true },
    { key: "stock_add",        label: "Set / Add Stock", desc: "Adjust on-hand counts", stock: true },
    { key: "barcode",          label: "Barcodes",        desc: "Create & print product barcodes", stock: true },
    // ── ENGINE POLICY (added 2026-08-27, owner request) ─────────────────────
    // Opens the Engine Policy card: the category map that says what every shop
    // keeps of each category and when the engine asks for more. A wrong number
    // in it is felt across the whole network before anyone notices, which is
    // why it is `sensitive` and why it was owner-only until now.
    //
    // NO `stock: true`, and that is not an oversight. Every change on the
    // Categories tab goes through the setCategoryPolicy callable, which writes
    // with the Admin SDK. A stockRole would grant this holder write on
    // /stock_targets, /locations, the engine kill switch and every /config
    // branch: the exact over-grant the Online & Content keys below exist to end.
    //
    // ONE TAB IS DIFFERENT and the honest note belongs here: Seating writes
    // /stock_targets and /stock straight from the browser, so those three
    // buttons DO need a stockRole. They ask for it themselves and say so in
    // words rather than failing at the database. See
    // enginePolicySeatingWritable in src/config/enginePolicy.js.
    { key: "engine_policy",    label: "Engine Policy",   desc: "What each shop keeps, and when to reorder", sensitive: true },
  ] },
  { title: "Business", perms: [
    { key: "insights",      label: "Insights",          desc: "Business analytics" },
    { key: "broadcast",     label: "Group Broadcast",   desc: "Send WhatsApp broadcasts", sensitive: true },
    { key: "customer_data", label: "Customer Database", desc: "View customer records", sensitive: true },
    // ── CARD RECON (added 2026-08-28, owner request) ────────────────────────
    // Opens the batch-slip capture screen and the cardBatchCapture callable:
    // photograph the FNB terminal's own Batch Report, OCR it server-side, see
    // the variance against the POS tender ledger. `sensitive` because it is
    // financial-reconciliation evidence AND each capture spends a Gemini OCR
    // call. Per-user only, in no role preset; NO `stock: true` — it gates no
    // stock write and the flag would auto-link a stockRole (invariant 1 above).
    { key: "card_recon", label: "Card Recon", desc: "Capture card-machine batch slips — variance vs POS", sensitive: true },
  ] },
  // ── ONLINE & CONTENT ───────────────────────────────────────────────────────
  // Two surfaces that were never wired to this permissions system and so ended
  // up gated on `stockRole === "admin"` instead — a stock-WRITE level that also
  // opens the refill-engine kill switch, /stock_targets, /locations, /reports
  // and every /config/* branch. Handing someone Shopify Publishing meant handing
  // them all of that, which is exactly how one account ended up far broader than
  // the job needed (owner, 2026-08-23).
  //
  // Both are per-user-only and NEITHER is in ROLE_DEFAULT_PERMS: tapping a role
  // preset must never hand out the ability to publish to the live shop or to
  // spend money. Neither carries `stock: true` — they gate no stock write, and
  // the flag would auto-link a stockRole, re-creating the very over-grant these
  // keys exist to end (see invariant 1 above).
  { title: "Online & Content", perms: [
    { key: "shopify_publish",  label: "Shopify Publishing", desc: "Clean names, condition & publish to the online shop" },
    // SPENDS REAL MONEY: ~$0.067 a white-background image, ~$0.134 a house-style
    // one, on every generation. Marked sensitive so the editor styles it as a
    // consequential grant, and every run is logged with its cost against the
    // person who ran it (AI Studio → Spend).
    { key: "photo_generation", label: "Photo Generation",   desc: "Regenerate product photos — spends money per image", sensitive: true },
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


// ─── RULES-READABLE MIRROR OF THE PERMISSIONS ARRAY ──────────────────────────
// `permissions` is a JSON ARRAY of strings, and RTDB security rules cannot ask
// whether an array CONTAINS a value: an array arrives in the rules engine as an
// object keyed by position ({"0":"insights","1":"barcode"}), so the only thing a
// rule could test is "is index 3 equal to X" — which changes meaning the moment
// a different permission is toggled and the array reindexes. That is why
// /shopify_publish was gated on stockRole in the first place: stockRole is a
// scalar, and a scalar is the only shape a rule can read.
//
// So every write of `permissions` also writes this MAP beside it, and the rules
// read the map:
//
//     root.child('users').child(auth.uid).child('permFlags').child('shopify_publish').val() === true
//
// WHY THIS CANNOT DRIFT: the mirror is never patched key-by-key. It is always
// written as a whole object in the SAME update() call as the array it mirrors,
// and update() replaces a named child wholesale — so a revoked permission's flag
// is gone by construction rather than by remembering to delete it.
//
// WHY IT IS NOT FORGEABLE: /users is writable ONLY by the super-admin email
// (live rule, checked 2026-08-23), so a staff member cannot grant themselves a
// flag any more than they can grant themselves a stockRole.
export function permFlagsFor(permissions) {
  const flags = {};
  for (const key of Array.isArray(permissions) ? permissions : []) {
    if (typeof key === "string" && key) flags[key] = true;
  }
  // RTDB deletes a child set to null. An empty object would be dropped too, but
  // null says "remove the mirror" explicitly rather than relying on that.
  return Object.keys(flags).length ? flags : null;
}
