// src/firebase.js and the other firebase/* entry points, faked for the harness.
export const app = {}; export const database = { fake: true }; export const functions = {}; export const functionsUS = {};
export const storage = {}; export const auth = { currentUser: { uid: "harness", email: "harness@example.invalid", getIdToken: async () => "t" } };
export class GoogleAuthProvider {}
export const googleProvider = new GoogleAuthProvider();
export const initializeApp = () => ({}); export const getApp = () => ({}); export const getApps = () => [];
export const getAuth = () => auth;
export const onAuthStateChanged = (_a, cb) => { setTimeout(() => cb(auth.currentUser), 0); return () => {}; };
export const onIdTokenChanged = onAuthStateChanged;
export const signInAnonymously = async () => ({}); export const signInWithCustomToken = async () => ({});
export const signInWithEmailAndPassword = async () => ({}); export const signInWithPopup = async () => ({}); export const signOut = async () => {};
export const getFunctions = () => ({});
export const httpsCallable = () => async () => ({ data: { ok: true } });
export const getStorage = () => ({});
export const storageRef = () => ({}); export const getDownloadURL = async () => ""; export const uploadBytes = async () => ({});
export const uploadBytesResumable = () => ({ on() {} }); export const deleteObject = async () => {}; export const getMetadata = async () => ({}); export const getBlob = async () => new Blob();
export const ref = () => ({});
