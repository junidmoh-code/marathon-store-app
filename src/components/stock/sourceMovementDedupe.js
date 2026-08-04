// ─── SOURCE FULFIL — movement-id duplicate check (pid-key cutover) ────────────
// Source Transfer & Fulfil movement ids used to be NAME-derived
// (`srcful_{date}_{toKey(productName)}_{size}_{n}`). Two identically-named
// products ("twins") collided to the SAME id, so the second twin's transfer was
// silently swallowed by applyMovement's idempotency no-op. Ids are now derived
// from the productId — but a transfer already applied under a legacy name id
// must NOT re-apply under its new pid id (that would double-move stock).
//
// So before writing, the panel checks BOTH ids:
//   • new (pid-derived) id exists            → duplicate (applyMovement would
//     no-op anyway; checking here keeps one code path and one test surface)
//   • legacy (name-derived) id exists AND its recorded productId matches OURS
//     → duplicate via legacy: the same physical transfer, applied pre-cutover
//   • legacy id exists but for a DIFFERENT productId → that was the twin's
//     movement, not ours — NOT a duplicate, the transfer must land
//
// The legacy check is inherently bounded: ids embed the request date, and
// Source only renders cards for today + HISTORY_RETENTION_DAYS (5) back — the
// same window the screen's log reads use. Once every renderable date is
// post-cutover, the legacy branch can never match and the dual-read can be
// retired. Callers surface `viaLegacy` (console counter + a
// `viaLegacyMovementId` flag persisted on the response record) so that moment
// is observable instead of guessed.

// The one place Source fulfil movement ids are shaped. Both the new (group key
// = product id) and the legacy (group key = sanitized name) seeds come from
// here, so the two can never drift apart in format — only in the key they carry.
// The panel appends `_{unitsAlreadySent}` to get the final movement id.
export function sourceMovementIdSeed(date, groupKey, encodedSize) {
  return `srcful_${date}_${groupKey}_${encodedSize}`;
}

// Returns { duplicate, viaLegacy, appliedQty }.
//
// appliedQty is the quantity the ALREADY-RECORDED movement moved — which is not
// necessarily the quantity the operator just picked. Crediting the picked
// quantity would let a suppressed duplicate close a cell for units that never
// moved (existing movement sent 1, operator now confirms 3, cell closes at 3,
// two units never leave). The caller credits progress with this instead.
// 0 when there is nothing to credit, so an unreadable record under-credits and
// leaves the cell open rather than closing it on a guess.
//
// getMovement: async (movementId) => movement record | null
export async function checkSourceMovementDuplicate({ getMovement, newId, legacyId, productId }) {
  const qtyOf = (m) => (Number(m?.qty) > 0 ? Number(m.qty) : 0);
  const existing = await getMovement(newId);
  if (existing) return { duplicate: true, viaLegacy: false, appliedQty: qtyOf(existing) };
  if (legacyId && legacyId !== newId) {
    const legacy = await getMovement(legacyId);
    if (legacy && legacy.productId === productId) return { duplicate: true, viaLegacy: true, appliedQty: qtyOf(legacy) };
  }
  return { duplicate: false, viaLegacy: false, appliedQty: 0 };
}
