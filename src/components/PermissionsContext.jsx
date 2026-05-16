// ─── PERMISSIONS CONTEXT ──────────────────────────────────────────────────────
// Provided by <AuthGate>. Consumers call usePermissions() to read the current
// user, their permissions array, and a hasPermission(name) helper.
//
// Super-admin shortcut: Junid's existing access path is preserved by checking
// the hardcoded ADMIN_EMAIL inside hasPermission, so gunidmoh@gmail.com always
// resolves true regardless of what's in /users/{uid}.

import { createContext, useContext } from "react";

export const ADMIN_EMAIL = "gunidmoh@gmail.com";

export const PermissionsContext = createContext({
  user:          null,
  permRecord:    null,
  isSuperAdmin:  false,
  permissions:   [],
  hasPermission: () => false,
  signOut:       () => {},
});

export function usePermissions() {
  return useContext(PermissionsContext);
}
