// ─── STYLE CODE — ENFORCEMENT SWITCH ─────────────────────────────────────────
// One constant decides whether intake LOOKS UP a style code or merely CAPTURES
// it. It exists because those two jobs became coupled by accident, and the
// coupling cost the shop floor a working Add Product screen.
//
// ── WHY IT IS CURRENTLY OFF ──────────────────────────────────────────────────
// Two independent reasons, either sufficient on its own:
//
//   1. THE LOOKUP CANNOT SUCCEED. resolveStyleCode calls a KicksDB route that
//      returns 403 "This route requires a subscription" on our plan. Every code,
//      every time. A step that always fails is not a check, it is an obstacle.
//
//   2. THERE IS NOTHING TO COMPARE AGAINST. No product carries a style code yet
//      and /style_code_index is empty, so "does this code already exist?" has
//      exactly one possible answer: no. Paying a round trip and a screen to be
//      told that is pure cost.
//
// ── WHAT STAYS TRUE WHILE IT IS OFF ──────────────────────────────────────────
// Codes are still CAPTURED and still written to the product. The catalogue keeps
// filling. What is skipped is only the identify-confirm-route detour.
//
// Uniqueness is NOT weakened by this switch, because it was never enforced here.
// The create-once claim on /style_code_index happens at SAVE time: if a code
// already belongs to a product, the save is refused and the operator is sent to
// add stock on it. That guard is untouched and keeps working with the switch
// off — it simply has nothing to catch yet.
//
// ── TURNING IT BACK ON ───────────────────────────────────────────────────────
// Flip this to true. That is the whole change; the full flow is still here and
// still tested. Worth doing once BOTH are true:
//   • the adapter points at a route our plan can actually call
//     (/v3/stockx/products?sku=, which serves Jordan, adidas and Puma cleanly)
//   • enough products carry codes that a collision is a real possibility
export const STYLE_CODE_LOOKUP_ENABLED = false;
