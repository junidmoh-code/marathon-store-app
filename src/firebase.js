// Firebase initialization for Marathon Store.
// Realtime Database is used for live sync of products and orders across devices.
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getFunctions } from "firebase/functions";
import { getStorage } from "firebase/storage";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",
  authDomain: "marathon-club.firebaseapp.com",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "marathon-club",
  storageBucket: "marathon-club.firebasestorage.app",
  messagingSenderId: "306270814317",
  appId: "1:306270814317:web:470395933121de7dbdbf64",
};

export const app            = initializeApp(firebaseConfig);
export const database       = getDatabase(app);
export const functions      = getFunctions(app, "europe-west1");   // existing: sendWhatsApp
export const functionsUS    = getFunctions(app, "us-central1");    // Phase 1: broadcast Cloud Functions
export const storage        = getStorage(app);
export const auth           = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Expose auth on window for debug parity with existing patterns
// (window.__pwaInstallPrompt, window.__sourceDebug, window.__orderAudit).
if (typeof window !== "undefined") window.auth = auth;
