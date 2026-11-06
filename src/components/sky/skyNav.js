// ─── THE ROUTE HIERARCHY (Junid, 6 Nov — "the grid button goes back ONE level") ─
//
// The header's grid button goes to the PARENT of the screen on view, computed
// from where the app is (the role and the URL hash), never from browser
// history — so a deep link opened cold (#product/{id}, #shopify/{pid}) still
// goes up to its list, then Admin, then Home. A long-press goes Home at once.
// The browser / OS back button is untouched: it still walks history as before.
//
//   Home                                  role none, no panel
//   ├─ Store Assistant · Warehouse ·      the three home tiles
//   │  Display Check                      → parent: Home
//   └─ Admin                              the Admin panel on Home
//      ├─ every Admin card                any other role, or an #admin/… /
//      │                                  #new-arrivals screen → parent: Admin
//      ├─ Products (Admin, any section)   → parent: Admin
//      │  └─ Product edit                 #product/{id} → parent: Products
//      ├─ Shopify publisher               → parent: Admin
//      │  └─ Shopify product              #shopify/{pid} → parent: Shopify publisher
//      └─ User management                 #admin/users → parent: Admin
//         └─ One user                     #admin/users/{uid} → parent: User management
//
// Pure: no React, no window — App.jsx applies the answer.

/** Roles reached from a Home tile (not from the Admin panel). */
export const HOME_TILE_ROLES = new Set(["assistant", "warehouse", "display_checks"]);

/** Hash screens that open over everything (App.jsx's #admin/… mounts). */
const ADMIN_HASH = /^#(admin\/(users|notifications|cost|mirror|network|online-orders|shipping|devices)|new-arrivals)(\/|$)/;

/**
 * Where "up one level" goes from here.
 * @param {{ role: string|null, hash: string }} at
 * @returns {{ level: "home"|"admin"|"card", hash?: string, role?: null, panel?: "admin"|null, label: string }}
 *   level "card": stay on the role, set the hash (an item → its list);
 *   level "admin": Home with the Admin panel open; level "home": Home.
 */
export function parentOf({ role = null, hash = "" } = {}) {
  const h = String(hash || "").replace(/\/+$/, "");
  // Item → its card (a hash under the same screen).
  if (/^#product\/.+/.test(h)) return { level: "card", hash: "", label: "Products" };
  if (/^#shopify\/.+/.test(h)) return { level: "card", hash: "", label: "Shopify" };
  const user = h.match(/^#admin\/users\/.+/);
  if (user) return { level: "card", hash: "#admin/users", label: "Users" };
  // An Admin card opened by hash → Admin.
  if (ADMIN_HASH.test(h)) return { level: "admin", hash: "", role: null, panel: "admin", label: "Admin" };
  if (!role) return { level: "home", hash: "", role: null, panel: null, label: "Home" };
  if (HOME_TILE_ROLES.has(role)) return { level: "home", hash: "", role: null, panel: null, label: "Home" };
  return { level: "admin", hash: "", role: null, panel: "admin", label: "Admin" };
}

/** Home itself, from anywhere (the long-press). */
export const HOME = Object.freeze({ level: "home", hash: "", role: null, panel: null, label: "Home" });

// The panel Home should open on its next mount ("up" from an Admin card lands
// on the Admin panel). Read once by RoleSelector, then cleared.
let nextHomePanel = null;
export function requestHomePanel(panel) { nextHomePanel = panel || null; }
// Cleared on the next tick, not on the read: React's StrictMode runs a state
// initializer twice, and both runs must see the same answer.
export function takeHomePanel() {
  const p = nextHomePanel;
  if (p) setTimeout(() => { if (nextHomePanel === p) nextHomePanel = null; }, 0);
  return p;
}
