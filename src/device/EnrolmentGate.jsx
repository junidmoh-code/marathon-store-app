// ─── DEVICE ENROLMENT — THE CODE SCREEN ──────────────────────────────────────
//
// What every device on a login that needs a code sees until it is enrolled
// (and again the second it is revoked): "Please ask MC for your code.", four
// boxes, a number pad. Nothing else — no menu, no way round it. AuthGate
// renders it INSTEAD of the app, so the app is not mounted underneath.
//
// Four digits submit on their own. enrolDevice (functions/deviceEnrolment/)
// checks the code and returns a custom token; signing in with it gives this
// device its own identity, AuthGate hears the new token (onIdTokenChanged) and
// the /users record's gate entry, and the app opens. Wrong codes and locks are
// counted on the server — this screen only shows what the server said.
//
// The pad is always on screen: wall tablets have no keyboard and some kiosk
// browsers never raise one. A physical keyboard's digits work too.

import { useCallback, useEffect, useRef, useState } from "react";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const BLUE = "#4A7FFF";

export const GATE_TITLE = "Please ask MC for your code.";

export function messageFor(result) {
  if (!result || result.ok) return null;
  switch (result.reason) {
    case "wrong":
      return result.attemptsLeft > 0
        ? `That code is not right. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left.`
        : "That code is not right.";
    case "locked": {
      const mins = Math.max(1, Math.ceil((Number(result.retryAfterMs) || 0) / 60e3));
      return `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
    }
    case "taken":
      return `This device is already enrolled${result.personName ? ` to ${result.personName}` : ""}. Ask MC to revoke it first.`;
    case "full":
      return `That code is already in use on ${result.max || 2} device${result.max === 1 ? "" : "s"}. Ask MC.`;
    default:
      return "That did not work. Try again.";
  }
}

function errorMessage(err) {
  const code = String(err?.code || "");
  if (code.includes("unavailable") || code.includes("deadline") || /network|offline|failed to fetch/i.test(String(err?.message))) {
    return "No internet connection. Connect and try again.";
  }
  return err?.message ? String(err.message).replace(/^.*?:\s*/, "") : "That did not work. Try again.";
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

/**
 * props:
 *   enrol(code) → Promise<{ok, token?, reason?, …}>   the enrolDevice callable
 *   signIn(token) → Promise                           signInWithCustomToken
 */
export default function EnrolmentGate({ enrol, signIn }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const busyRef = useRef(false);

  const submit = useCallback(async (value) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await enrol(value);
      if (res?.ok && res.token) {
        await signIn(res.token);
        // AuthGate takes it from here the moment the new token and the gate
        // entry both arrive; until then say so rather than look stuck.
        setDone(true);
        return;
      }
      setError(messageFor(res));
      setCode("");
    } catch (err) {
      setError(errorMessage(err));
      setCode("");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [enrol, signIn]);

  const press = useCallback((k) => {
    if (busyRef.current || done) return;
    if (k === "⌫") { setCode((c) => c.slice(0, -1)); return; }
    if (!/^\d$/.test(k)) return;
    setCode((c) => (c.length >= 4 ? c : c + k));
  }, [done]);

  // The fourth digit submits. An effect, not a side effect inside setCode's
  // updater, which React may run twice.
  useEffect(() => {
    if (code.length === 4 && !busyRef.current && !done) submit(code);
  }, [code, submit, done]);

  useEffect(() => {
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("⌫");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  return (
    <div data-enrolment-gate="" style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: FONT,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "24px 16px", boxSizing: "border-box" }}>
      <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, textAlign: "center", lineHeight: 1.25, maxWidth: 360 }}>
        {GATE_TITLE}
      </h1>

      <div aria-label="Code" role="group" style={{ display: "flex", gap: 12, marginTop: 28 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} data-code-box="" style={{
            width: 56, height: 64, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 30, fontWeight: 700,
            border: `2px solid ${i === code.length && !busy && !done ? BLUE : "rgba(255,255,255,.18)"}`,
            background: "rgba(255,255,255,.04)",
          }}>
            {code[i] ? "•" : ""}
          </div>
        ))}
      </div>

      <div role="status" aria-live="polite" style={{ minHeight: 44, marginTop: 14, maxWidth: 340, textAlign: "center",
        fontSize: 15, lineHeight: 1.4, color: error ? "#F87171" : "#8e8e93" }}>
        {done ? "Opening…" : busy ? "Checking…" : error || ""}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 76px)", gap: 12, marginTop: 6 }}>
        {KEYS.map((k, i) => (k === "" ? <div key={i} /> : (
          <button key={i} type="button" onClick={() => press(k)} disabled={busy || done}
            aria-label={k === "⌫" ? "Delete" : k}
            style={{ height: 64, borderRadius: 14, border: "1px solid rgba(255,255,255,.12)",
              background: "rgba(255,255,255,.06)", color: "#fff", fontSize: 26, fontWeight: 600,
              fontFamily: FONT, cursor: "pointer", opacity: busy || done ? 0.5 : 1, touchAction: "manipulation" }}>
            {k}
          </button>
        )))}
      </div>
    </div>
  );
}
