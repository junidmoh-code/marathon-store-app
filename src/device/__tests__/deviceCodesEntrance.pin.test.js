// The Device codes screen has exactly two ways in — the home tile and the
// #admin/devices route — and both must exist for the owner AND for MC's
// enrolled code-making device. Deleting either would leave a working screen
// nobody can reach. Read as text: App.jsx pulls Firebase in at import time.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const app = readFileSync(join(__dirname, "../../App.jsx"), "utf8");

describe("Device codes entrance", () => {
  it("the home tile exists, for Junid or a code-making device, and opens #admin/devices", () => {
    expect(app).toMatch(/\(isSuperAdmin \|\| homeDevice\?\.canManageCodes === true\) && \{ key:"device_codes"[^\n]*#admin\/devices/);
  });
  it("the route mounts the card for the same two, and nobody else", () => {
    expect(app).toMatch(/const wantDeviceCodes = hash === "#admin\/devices"/);
    expect(app).toMatch(/if \(wantDeviceCodes\) \{[\s\S]{0,400}\(isSuperAdmin \|\| deviceIdentity\?\.canManageCodes === true\)\s*\?\s*<DeviceCodesCard isOwner=\{isSuperAdmin\}/);
  });
});
