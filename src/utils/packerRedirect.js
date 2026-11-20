// ── The online packer belongs in the POS (Junid, 20 Nov 2026) ─────────────────
// "Yusuf should use the dark Marathon POS app (marathon-pos.web.app), not the light store app … If he ever lands on the
// store app, redirect him to the POS." A login whose POS role is the online packer (marathon-pos-app
// src/auth/posAccess.js ONLINE_PACKER_ROLE) is sent to the POS's Online Orders screen; the POS's own router keeps him
// there. The super admin is never redirected, whatever a record says.
export const POS_ONLINE_ORDERS_URL = "https://marathon-pos.web.app/pos/online-orders";
export const ONLINE_PACKER_ROLE = "onlinePacker";

/** The URL this login must go to instead of the store app, or null. Pure. */
export function packerRedirectUrl(permRecord, isSuperAdmin = false) {
  if (isSuperAdmin) return null;
  const pa = permRecord?.posAccess;
  if (!pa || pa.isActive !== true || pa.role !== ONLINE_PACKER_ROLE) return null;
  return POS_ONLINE_ORDERS_URL;
}
