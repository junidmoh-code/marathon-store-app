// ─── AUTH GATE ────────────────────────────────────────────────────────────────
// Wraps the app, decides which surface to show:
//   1. hash === "#tv"     → calls renderTv() which mounts the TV display. Anon
//                           sign-in is kicked off so RTDB reads work. Bypasses
//                           everything else.
//   2. hash === "#admin"
//      AND unauthenticated → renders children with a stub PermissionsContext
//                           so AppInner can mount its <AdminSignInScreen /> and
//                           drive the Google popup. Without this bypass the
//                           staff Login form would show instead and Junid
//                           would have no way to reach the super-admin path
//                           from a fresh device.
//   3. otherwise + no user (or anonymous from a prior TV visit) → Login.
//   4. otherwise + signed-in real user → fetches /users/{uid} permissions,
//                           provides PermissionsContext to children.
//   5. …UNLESS that login needs a device code (/users/{uid}/deviceCodeRequired)
//                           and this device is not enrolled, or its enrolment
//                           was revoked → the code screen INSTEAD of the app
//                           (src/device/EnrolmentGate.jsx, src/device/enrolment.js).
//
// hasPermission(name) returns true for the super-admin email regardless of
// /users/{uid} contents, so Junid's existing Google sign-in path keeps working.

import { useEffect, useState } from "react";
import { onAuthStateChanged, onIdTokenChanged, signInAnonymously, signInWithCustomToken, signOut } from "firebase/auth";
import { onValue, ref, set } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { auth, database, functions } from "../firebase";
import { PermissionsContext, ADMIN_EMAIL } from "./PermissionsContext";
import { revokeBeforeSignOut } from "../push/registerPush";
import { effectiveStoreIds } from "../utils/stores";
import Login from "./Login";
import EnrolmentGate from "../device/EnrolmentGate";
import {
  deviceGateVerdict, deviceTypeHint, identityFrom, isLiveEnrolment, knownRequired, readSessionClaims,
  rememberRequired, setDeviceIdentity, writeLastSeen, LAST_SEEN_EVERY_MS,
} from "../device/enrolment";
import { serverNowMs } from "../utils/serverTime";
import { adoptDeviceId, getDeviceId } from "../device/deviceId";

// The two calls the code screen makes. Module-level so the screen's props are
// stable across renders.
const enrolDeviceCall = httpsCallable(functions, "enrolDevice");
const enrolWithCode = async (code) => (await enrolDeviceCall({
  code,
  deviceId: getDeviceId(),
  deviceType: deviceTypeHint(),
  userAgent: typeof navigator === "undefined" ? null : String(navigator.userAgent || "").slice(0, 200),
})).data;
// One reload after enrolling: while this device was unenrolled the rules
// refused its reads, and a refused listener (the offline mirror's, for one)
// never retries. enrolDevice has already written the gate entry, so the
// reloaded app opens straight in.
const signInWithDeviceToken = async (token) => {
  await signInWithCustomToken(auth, token);
  try { window.location.reload(); } catch { /* no reload (tests) — AuthGate still opens the app */ }
};

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
  // Phase 15: a transient /users/{uid} read failure leaves permRecord null,
  // which effectiveStoreIds would treat as "legacy = all-access". For a scoped
  // user that would silently over-grant store access until the read recovers.
  // Track the error so we can fail CLOSED (no stores) on read failure instead.
  const [permReadError, setPermReadError] = useState(false);
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

  // The device claims on this session's token. onIdTokenChanged, NOT
  // onAuthStateChanged: signing in with the enrolment token keeps the same
  // uid, and onAuthStateChanged only fires when the uid changes.
  // undefined = still reading (the gate waits rather than flash the code
  // screen at an enrolled device).
  const [claims, setClaims] = useState(undefined);
  useEffect(() => {
    let seq = 0;
    const off = onIdTokenChanged(auth, (u) => {
      const mine = ++seq;
      if (!u || u.isAnonymous) { setClaims(null); return; }
      readSessionClaims(u).then((c) => { if (mine === seq) setClaims(c); });
    });
    return () => off();
  }, []);

  // Who is holding this device, for the stamps every order and stock write
  // carries (src/device/deviceStamp.js). An enrolled device's id is the one
  // its token names; the browser's own id is brought into line with it so the
  // quarantine, the mirror telemetry and the stamps all name one device.
  useEffect(() => {
    if (claims?.deviceId) adoptDeviceId(claims.deviceId);
    setDeviceIdentity({ claims, permRecord, user });
  }, [claims, permRecord, user]);

  // Last seen, for Junid's device list (src/device/enrolment.js explains why
  // serverNowMs and why a failure is ignored).
  const liveDeviceId = isLiveEnrolment(permRecord, claims) ? claims.deviceId : null;
  useEffect(() => {
    if (!liveDeviceId) return undefined;
    const write = (path, v) => set(ref(database, path), v);
    const beat = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      writeLastSeen({ deviceId: liveDeviceId, write, nowMs: serverNowMs() });
    };
    beat();
    const t = setInterval(beat, LAST_SEEN_EVERY_MS);
    return () => clearInterval(t);
  }, [liveDeviceId]);

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
      (snap) => {
        setPermReadError(false);
        setPermRecord(snap.val() || null);
        rememberRequired(user.uid, snap.val()?.deviceCodeRequired === true);
        setPermLoaded(true);
      },
      (err)  => { console.warn("permissions read failed:", err); setPermReadError(true); setPermRecord(null); setPermLoaded(true); }
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

  // #admin bypass for unauthenticated visitors. AppInner sees wantAdmin &&
  // !isSuperAdmin and renders <AdminSignInScreen />. Once signInWithPopup
  // resolves, onAuthStateChanged fires, user becomes Junid's real account,
  // and AuthGate re-renders down the normal authenticated path below.
  const isAdmin = hash === "#admin";
  if (isAdmin && (!user || user.isAnonymous)) {
    return (
      <PermissionsContext.Provider
        value={{
          user:          user || null,
          permRecord:    null,
          isSuperAdmin:  false,
          permissions:   [],
          storeIds:      [],
          hasPermission: () => false,
          signOut:       () => signOut(auth).catch((err) => console.warn("signOut failed:", err)),
        }}>
        {children}
      </PermissionsContext.Provider>
    );
  }

  if (!user || user.isAnonymous) return <Login />;
  if (!permLoaded) return <LoadingScreen />;

  const isSuperAdmin  = user.email === ADMIN_EMAIL;
  // A login that needs a device code: the code screen and nothing else until
  // this device is enrolled — and again the moment it is revoked, because the
  // gate entry lives on the /users record subscribed just above.
  const gate = deviceGateVerdict({
    permRecord, claims, isSuperAdmin, readError: permReadError, knownRequired: knownRequired(user.uid),
  });
  if (gate === "loading") return <LoadingScreen />;
  if (gate === "code") return <EnrolmentGate enrol={enrolWithCode} signIn={signInWithDeviceToken} />;
  const permissions   = Array.isArray(permRecord?.permissions) ? permRecord.permissions : [];
  // Fail closed for scoped users on a read error (super-admin still bypasses).
  const storeIds      = permReadError ? effectiveStoreIds({ storeIds: [] }, isSuperAdmin)
                                      : effectiveStoreIds(permRecord, isSuperAdmin);
  const hasPermission = (p) => isSuperAdmin || permissions.includes(p);
  // Push registration is torn down BEFORE the sign-out, while this user is
  // still authenticated — the only moment the database accepts it, since the
  // rules scope every write on those paths to auth.uid. These tablets are
  // shared: without this, the next person to sign in inherits a live token row
  // belonging to the last one, and starts receiving their alerts.
  //
  // Awaited, but never allowed to block: a failure logs and the sign-out
  // proceeds regardless. Someone tapping Sign out must always sign out.
  const doSignOut     = () =>
    revokeBeforeSignOut(user && !user.isAnonymous ? user.uid : null)
      .catch(() => {})
      .then(() => signOut(auth))
      .catch((err) => console.warn("signOut failed:", err));

  return (
    <PermissionsContext.Provider
      value={{ user, permRecord, isSuperAdmin, permissions, storeIds, hasPermission, signOut: doSignOut,
               deviceIdentity: identityFrom({ claims, permRecord, user }) }}>
      {children}
    </PermissionsContext.Provider>
  );
}
