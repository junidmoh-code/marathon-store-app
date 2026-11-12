// DEV ONLY — firebase/auth stand-in: one signed-in harness account (the owner's
// address, so the owner-gated screens render as they do for Junid). No
// password, no token, no network — getIdToken answers a dummy string.
// localStorage harness_user = "staff" signs in a lowest-access staff account
// instead (store assistant only, no stockRole, no store) — for "what does the
// least-privileged person see" screenshots and checks.
const STAFF = (() => { try { return localStorage.getItem("harness_user") === "staff"; } catch { return false; } })();
export const HARNESS_USER = {
  ...(STAFF
    ? { uid: "harness-staff", email: "staff@harness.invalid", emailVerified: true, displayName: "Staff" }
    : { uid: "harness-owner", email: "gunidmoh@gmail.com", emailVerified: true, displayName: "Junid" }),
  isAnonymous: false, providerData: [{ providerId: "google.com" }],
  getIdToken: async () => "harness", getIdTokenResult: async () => ({ token: "harness", claims: {} }),
};
const auth = { currentUser: HARNESS_USER, __fake: true };
export function getAuth() { return auth; }
export class GoogleAuthProvider { setCustomParameters() {} addScope() {} }
export function onAuthStateChanged(_a, cb) { const t = setTimeout(() => cb(HARNESS_USER), 0); return () => clearTimeout(t); }
export function onIdTokenChanged(_a, cb) { const t = setTimeout(() => cb(HARNESS_USER), 0); return () => clearTimeout(t); }
const signedIn = async () => ({ user: HARNESS_USER });
export const signInAnonymously = signedIn, signInWithCustomToken = signedIn, signInWithEmailAndPassword = signedIn, signInWithPopup = signedIn;
export async function signOut() {}
