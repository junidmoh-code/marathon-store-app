// ─── Persistent per-browser device id ────────────────────────────────────────
// The store-app has no server-issued device identity (unlike the POS, whose
// tills are named). To attribute WHICH physical tablet/PC saved a record — even
// under a shared PIN login — we mint a random id once and keep it in the
// browser's localStorage, reusing it forever after. It is opaque by design (a
// UUID, not a name); pair it with the createdBy.uid/email to see who + where.
//
// Never throws: private-mode / storage-disabled browsers just return null, so a
// caller stamps `deviceId: null` rather than blocking the write it rides along.

const DEVICE_ID_KEY = "marathon.deviceId";

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : `dev-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

// An enrolled device's id is the one its enrolment token names (the server
// recorded it). If this browser's storage was cleared but its sign-in was not,
// the two differ; the token wins, so every record names the device the server
// knows. Never throws.
export function adoptDeviceId(id) {
  if (typeof id !== "string" || !id) return;
  try {
    if (localStorage.getItem(DEVICE_ID_KEY) !== id) localStorage.setItem(DEVICE_ID_KEY, id);
  } catch { /* storage disabled — the token still names the device */ }
}
