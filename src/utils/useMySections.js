// Which sections THIS signed-in account, on THIS device, may see and act in.
// One hook so every screen asks the same question the same way:
//
//   const { sections, canSee } = useMySections();
//   locations.filter((l) => canSee(l.id))
//
// The answer comes from sectionsFor() in the network registry: Junid and any
// admin he marks allSections see both; an account with a sections map sees
// those; an enrolled device carries its own section; an account that predates
// sections sees both until Junid narrows it. Central is visible to everyone.
//
// This is what the SCREENS show. The enforcement is the section wall in the
// stock writer and the database rules — a screen filter alone is not access
// control, and nothing here is relied on as one.
import { useMemo } from "react";
import { usePermissions } from "../components/PermissionsContext";
import { useNetwork } from "./useNetwork";
import { sectionsFor, canSeeLocation } from "./networkRegistry";

export function useMySections() {
  const { permRecord, isSuperAdmin, deviceIdentity } = usePermissions();
  const { registry } = useNetwork();
  return useMemo(() => {
    const sections = sectionsFor(registry, permRecord, { isOwner: isSuperAdmin, deviceSection: deviceIdentity?.section });
    return {
      sections,
      both: sections.length === 2,
      canSee: (loc) => canSeeLocation(registry, sections, loc),
      registry,
    };
  }, [registry, permRecord, isSuperAdmin, deviceIdentity?.section]);
}
