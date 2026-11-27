import React, { createContext, useContext } from "react";
const value = { permRecord: { stockRole: "admin", displayName: "Harness" }, isSuperAdmin: true, deviceIdentity: null, loading: false };
export const PermissionsContext = createContext(value);
export function usePermissions() { return useContext(PermissionsContext); }
export function PermissionsProvider({ children }) { return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>; }
export default PermissionsContext;
