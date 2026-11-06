// DEV ONLY — firebase/auth stand-in: one signed-in harness account (the owner's
// address, so the owner-gated screens render as they do for Junid). No
// password, no token, no network — getIdToken answers a dummy string.
export const HARNESS_USER = {
  uid: "harness-owner", email: "gunidmoh@gmail.com", emailVerified: true, displayName: "Junid",
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
