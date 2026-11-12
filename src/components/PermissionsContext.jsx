// ─── PERMISSIONS CONTEXT ──────────────────────────────────────────────────────
// Provided by <AuthGate>. Consumers call usePermissions() to read the current
// user, their permissions array, and a hasPermission(name) helper.
//
// Super-admin shortcut: AuthGate asks isSuperAdmin(email) (config/superAdmins.js)
// and hasPermission short-circuits on it, so Junid and Jafer always resolve
// true regardless of what's in /users/{uid}.

import { createContext, useContext } from "react";

export const PermissionsContext = createContext({
  user:          null,
  permRecord:    null,
  isSuperAdmin:  false,
  permissions:   [],
  // Phase 15: effective stores this user may place orders against (see
  // effectiveStoreIds). Empty array = no store access; the order flow blocks.
  storeIds:      [],
  hasPermission: () => false,
  signOut:       () => {},
  // Which device this is and who holds it (src/device/enrolment.js). `section`
  // is the section an enrolled device's code was made for (1 | 2), else null.
  deviceIdentity: { deviceId: null, personName: null, personId: null, enrolled: false, canManageCodes: false, section: null },
});

export function usePermissions() {
  return useContext(PermissionsContext);
}
