// ─── LOGIN ────────────────────────────────────────────────────────────────────
// Staff sign-in form. Two fields — Username + 4-digit PIN. Behind the scenes
// the username is synthesised into a `{username}@marathon.internal` address
// and passed to Firebase Auth's signInWithEmailAndPassword with the PIN as
// password. Staff never see or type the synthetic email.
//
// Errors map known Firebase auth codes to plain-language messages. The
// rate-limit response (auth/too-many-requests) gets its own copy so staff
// know they're locked out for a minute rather than wrong-PIN'd forever.
//
// Touch-only hardware (wall tablets, TV boxes double-tapped out of #tv) has
// no physical keyboard and some kiosk browsers never raise the native one, so
// staff could not sign in at all. On such devices (coarse pointer only, no
// mouse/trackpad) an on-screen keyboard renders IN-FLOW below the form —
// never covering the focused field — and inputMode="none" keeps a native OSK
// from doubling up. Desktops and laptops never see it.

import { useRef, useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";
import { toAuthPassword, usernameToEmail } from "../utils/auth-utils";
import OnScreenKeyboard, { isTouchOnlyDevice } from "./OnScreenKeyboard";

const FONT   = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const BLUE   = "#4A7FFF";
const BLUE_L = "#6A9FFF";

export default function Login() {
  const [username, setUsername] = useState("");
  const [pin,      setPin]      = useState("");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState(null);

  // Evaluated once per mount — pointer capabilities don't change mid-session.
  const [osk] = useState(isTouchOnlyDevice);
  const [activeField, setActiveField] = useState("username");
  const pinRef      = useRef(null);
  const usernameRef = useRef(null);

  const canSubmit = !busy && username.trim().length > 0 && pin.length === 4;

  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const email    = usernameToEmail(username);
      const password = toAuthPassword(pin);
      await signInWithEmailAndPassword(auth, email, password);
      // AuthGate's onAuthStateChanged handler fires next; this component unmounts.
    } catch (err) {
      if (err.code === "auth/too-many-requests") {
        setError("Too many attempts. Try again in a few minutes.");
      } else if (
        err.code === "auth/wrong-password" ||
        err.code === "auth/user-not-found" ||
        err.code === "auth/invalid-credential" ||
        err.code === "auth/invalid-email"
      ) {
        setError("Wrong username or PIN.");
      } else {
        setError(err.message || String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  // On-screen keyboard routing: keys land in whichever field was last focused.
  // PIN keeps its digits-only / 4-max normalisation; username is free text.
  const oskKey = (ch) => {
    if (activeField === "pin") setPin(p => (p + ch).replace(/\D/g, "").slice(0, 4));
    else setUsername(u => u + ch);
  };
  const oskBackspace = () => {
    if (activeField === "pin") setPin(p => p.slice(0, -1));
    else setUsername(u => u.slice(0, -1));
  };
  // Submit key: from the username field it advances to the PIN (like Tab);
  // from the PIN field it signs in.
  const oskSubmit = () => {
    if (activeField === "username") {
      setActiveField("pin");
      pinRef.current?.focus();
    } else {
      submit();
    }
  };

  const inputStyle = {
    width:"100%", padding:"10px 12px",
    background:"rgba(255,255,255,.03)", border:"1px solid rgba(60,110,255,.2)",
    borderRadius:10, color:"#fff", fontSize:15, fontFamily:"inherit",
    outline:"none", boxSizing:"border-box",
  };

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT,
                  display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                  padding:"1rem", boxSizing:"border-box", gap:12 }}>
      <form onSubmit={submit}
            style={{ width:"100%", maxWidth:360,
                     background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.12)",
                     borderRadius:14, padding:"2rem 1.5rem",
                     boxShadow:"0 0 12px rgba(60,110,255,.15)" }}>
        <h1 style={{ margin:0, marginBottom:"0.4rem", fontSize:"1.4rem", fontWeight:700, letterSpacing:"0.02em" }}>
          Marathon staff sign-in
        </h1>
        <p style={{ margin:0, marginBottom:"1.5rem", color:"#888", fontSize:"0.85rem" }}>
          Enter your username and 4-digit PIN.
        </p>

        <label style={{ display:"block", marginBottom:12 }}>
          <span style={{ color:"#888", fontSize:"0.78rem", display:"block", marginBottom:4 }}>Username</span>
          <input value={username}
                 ref={usernameRef}
                 onChange={(e) => setUsername(e.target.value)}
                 onFocus={() => setActiveField("username")}
                 autoFocus
                 autoComplete="username"
                 inputMode={osk ? "none" : undefined}
                 style={inputStyle} />
        </label>

        <label style={{ display:"block", marginBottom:18 }}>
          <span style={{ color:"#888", fontSize:"0.78rem", display:"block", marginBottom:4 }}>PIN</span>
          <input value={pin}
                 ref={pinRef}
                 onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                 onFocus={() => setActiveField("pin")}
                 type="password"
                 inputMode={osk ? "none" : "numeric"}
                 pattern="[0-9]*"
                 maxLength={4}
                 autoComplete="current-password"
                 style={{ ...inputStyle, letterSpacing:"0.3em" }} />
        </label>

        <button type="submit" disabled={!canSubmit}
                style={{ width:"100%", padding:"0.85rem",
                         background:BLUE, color:"#fff", border:"none",
                         borderRadius:10, fontSize:15, fontWeight:700,
                         cursor: busy ? "default" : "pointer",
                         opacity: canSubmit ? 1 : 0.5 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {error && (
          <div style={{ marginTop:12, padding:"8px 12px",
                        background:"rgba(248,113,113,.08)",
                        border:"1px solid rgba(248,113,113,.3)",
                        color:"#F87171", fontSize:13, borderRadius:8 }}>
            {error}
          </div>
        )}

        <div style={{ marginTop:20, textAlign:"center", fontSize:12, color:"#555" }}>
          Admin? <a href="#admin" style={{ color:BLUE_L, textDecoration:"none" }}>Sign in with Google</a>
        </div>
      </form>

      {/* Touch-only devices: in-flow keyboard BELOW the form (never covers it).
          Layout follows the focused field — QWERTY for username, PIN pad for PIN. */}
      {osk && (
        <OnScreenKeyboard
          layout={activeField === "pin" ? "numeric" : "text"}
          onKey={oskKey}
          onBackspace={oskBackspace}
          onSubmit={oskSubmit}
          submitLabel={activeField === "pin" ? (busy ? "…" : "Sign in") : "Next"}
          canSubmit={activeField === "pin" ? canSubmit : username.trim().length > 0}
          accent={BLUE}
        />
      )}
    </div>
  );
}
