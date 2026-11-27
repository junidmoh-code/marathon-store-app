// ─── TEMPORARY SCREENS — one flag each, so each can be removed in one edit ────
//
// CONCRETE_PRODUCTS_CARD (Junid, 20 Nov 2026): the home-page "Concrete Products"
// card where Junid marks which CLOTHING products are Concrete-only. TEMPORARY —
// it exists while the catalogue is being split. Set to false to remove the
// tile AND its route (App.jsx reads this flag at both places); the component
// (src/components/concrete/ConcreteProductsCard.jsx) can then be deleted.
export const CONCRETE_PRODUCTS_CARD = true;

// BRAND_CHECK_TAB: Product Admin's "Brand Check" tab (PR #911). Hidden — the
// Concrete Products card replaces it (Junid, 20 Nov 2026). The component is
// kept so it can come back with this one flag.
export const BRAND_CHECK_TAB = false;
