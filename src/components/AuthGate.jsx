// ─── AUTH GATE ────────────────────────────────────────────────────────────────
// Wraps the app, decides which surface to show:
//   1. hash === "#tv"  → calls renderTv() which mounts the TV display. Anon
//      sign-in is kicked off so RTDB reads work. Bypasses everything else.
//   2. otherwise + no user (or anonymous user from a prior TV visit) → Login.
//   3. otherwise + signed-in real user → fetches /users/{uid} permissions,
//      provides PermissionsContext to children.
//
// hasPermission(name) returns true for the super-admin email regardless of
// /users/{uid} contents, so Junid's existing Google sign-in path keeps working.

import { useEffect, useState } from "react";
import { onAuthStateChanged, signInAnonymously, signOut } from "firebase/auth";
import { onValue, ref } from "firebase/database";
import { auth, database } from "../firebase";
import { PermissionsContext, ADMIN_EMAIL } from "./PermissionsContext";
import Login from "./Login";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";

function LoadingScreen({ label = "Loading…" }) {
  return (
    <div style={{ minHeight:"100vh", background:"#000",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  color:"#555", fontFamily:FONT, fontSize:14 }}>
      {label}
    </div>
  );
}

export default function AuthGate({ children, renderTv }) {
  const [hash,         setHash]         = useState(window.location.hash);
  const [authReady,    setAuthReady]    = useState(false);
  const [user,         setUser]         = useState(null);
  const [permRecord,   setPermRecord]   = useState(null);
  const [permLoaded,   setPermLoaded]   = useState(false);
  const [tvAuthReady,  setTvAuthReady]  = useState(false);

  // Track hash changes for the #tv bypass
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Track Firebase auth state
  useEffect(() => {
    const off = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return () => off();
  }, []);

  // On #tv, ensure we have a signed-in user (anon is fine) BEFORE rendering
  // the TV display — otherwise useOrders subscribes with a null auth and the
  // first read fails. If auth.currentUser already exists (warm start), flip
  // tvAuthReady immediately; otherwise wait for the anon sign-in to settle.
  // .catch() also flips the flag so we don't hang if anon fails — the TV
  // will then render with whatever state it has (useOrders just returns []).
  const isTv = hash === "#tv";
  useEffect(() => {
    if (!isTv) return;
    if (auth.currentUser) {
      setTvAuthReady(true);
      return;
    }
    signInAnonymously(auth)
      .then(() => setTvAuthReady(true))
      .catch((err) => {
        console.warn("anonymous sign-in failed:", err);
        setTvAuthReady(true);
      });
  }, [isTv]);

  // Subscribe to /users/{uid} for real (non-anonymous) users
  useEffect(() => {
    if (!user || user.isAnonymous) {
      setPermRecord(null);
      setPermLoaded(true);
      return;
    }
    setPermLoaded(false);
    const r = ref(database, `users/${user.uid}`);
    const off = onValue(
      r,
      (snap) => { setPermRecord(snap.val() || null); setPermLoaded(true); },
      (err)  => { console.warn("permissions read failed:", err); setPermRecord(null); setPermLoaded(true); }
    );
    return () => off();
  }, [user]);

  // TV bypass: hand off entirely to the caller's renderTv — but only once
  // tvAuthReady is true, so the TV's data hooks always see a valid auth.
  if (isTv) {
    if (!tvAuthReady) return <LoadingScreen />;
    return renderTv ? renderTv() : null;
  }

  if (!authReady) return <LoadingScreen />;
  if (!user || user.isAnonymous) return <Login />;
  if (!permLoaded) return <LoadingScreen />;

  const isSuperAdmin  = user.email === ADMIN_EMAIL;
  const permissions   = Array.isArray(permRecord?.permissions) ? permRecord.permissions : [];
  const hasPermission = (p) => isSuperAdmin || permissions.includes(p);
  const doSignOut     = () => signOut(auth).catch((err) => console.warn("signOut failed:", err));

  return (
    <PermissionsContext.Provider
      value={{ user, permRecord, isSuperAdmin, permissions, hasPermission, signOut: doSignOut }}>
      {children}
    </PermissionsContext.Provider>
  );
}
