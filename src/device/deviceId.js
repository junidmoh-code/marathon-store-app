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
