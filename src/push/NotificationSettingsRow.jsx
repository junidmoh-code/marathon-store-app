// ─── THE ONE PERSONAL SETTING IN THIS APP, BESIDE THE ONE SIGN-OUT ───────────
// This app has no "My Settings" screen and did not need one invented. It has
// exactly one place where a staff member acts on their own account rather than
// on stock: the row at the bottom of the home page they sign out from (owner
// directive 2026-08-08, "one logout in one place"). The notification switch goes
// directly above it, in the same block, on both the desktop and mobile home
// branches — so the answer to "where do I turn this off?" is the same answer as
// "where do I sign out?", which every staff member already knows.
//
// ── IT SAYS WHY IT IS ON ────────────────────────────────────────────────────
// Default-on only works if a person who did not choose it can tell what
// happened. So the sub-line distinguishes "on because of your role" from "on
// because you chose it", and the states where the browser is the obstacle —
// permission denied, or an iPhone that has not been added to the Home Screen —
// say exactly that, because no amount of tapping this switch will fix either.

import { PUSH_STATE } from "./registerPush";

const BLUE = "#4A7FFF";
const BLUE_L = "#9DBCFF";

// state → what a person needs to read. Anything not listed is a working "on".
const TROUBLE = {
  [PUSH_STATE.BLOCKED]:
    "Notifications are blocked for this site. Turn them back on in your browser or phone settings — this switch cannot.",
  [PUSH_STATE.NEEDS_INSTALL]:
    "On iPhone and iPad, alerts only work from the Home Screen copy. Tap Share → Add to Home Screen, then open Marathon from there.",
  [PUSH_STATE.NEEDS_PERMISSION]:
    "One tap left — switch this on and allow notifications when your browser asks.",
  [PUSH_STATE.UNSUPPORTED]:
    "This browser can't show alerts. Chrome on Android, or the Home Screen app on iPhone, can.",
  [PUSH_STATE.MISCONFIGURED]:
    "Alerts aren't configured on the server yet. Nothing you can fix from here — tell Junid.",
  [PUSH_STATE.ERROR]:
    "Couldn't set alerts up on this device. Reopening the app usually clears it.",
};

export default function NotificationSettingsRow({ push }) {
  if (!push || !push.uid) return null;
  const { enabled, reason, hasExplicit, state, busy, setEnabled, clearExplicit } = push;

  // NOT gated on `enabled`. setEnabled(true) records the preference only once
  // the browser has granted permission, so a DENIED prompt leaves the resolved
  // value at the role default — off — while the state holds the only
  // explanation of why the tap did nothing. Gating on `enabled` showed that
  // user "Off for your role. Switch it on…", beside a switch that would not
  // move, with the real cause hidden. Every key in TROUBLE is a non-working
  // state, so an actually-working "on" user still sees no warning.
  const trouble = TROUBLE[state] || null;
  const sub = trouble
    || (enabled
      ? (reason === "role_default_on"
        ? "On because you fulfil refills. Switch it off if you'd rather not be alerted."
        : "On — you'll be alerted on this device even when the app is closed.")
      : (reason === "explicit_off"
        ? "Off — you won't be alerted when new refill requests come in."
        : "Off for your role. Switch it on to be alerted when refill requests come in."));

  return (
    <div style={{ marginTop: 34, paddingTop: 18, borderTop: "1px solid rgba(255,255,255,.07)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 13, minHeight: 48,
        padding: "12px 14px", borderRadius: 13,
        border: `1px solid ${enabled && !trouble ? "rgba(74,127,255,.35)" : "rgba(255,255,255,.08)"}`,
        background: enabled && !trouble ? "rgba(74,127,255,.07)" : "rgba(255,255,255,.022)",
      }}>
        <span style={{
          width: 34, height: 34, flex: "0 0 auto", borderRadius: 11, display: "grid", placeItems: "center",
          color: enabled && !trouble ? BLUE_L : "rgba(233,238,255,.4)",
          background: enabled && !trouble ? "rgba(74,127,255,.14)" : "rgba(255,255,255,.04)",
          border: `1px solid ${enabled && !trouble ? "rgba(74,127,255,.28)" : "rgba(255,255,255,.07)"}`,
        }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
          </svg>
        </span>

        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "#fff" }}>
            Refill request alerts
          </span>
          <span style={{ display: "block", fontSize: 11.5, lineHeight: 1.45, color: trouble ? "#F5A623" : "rgba(233,238,255,.5)" }}>
            {sub}
          </span>
          {/* Only offered once a person has overridden their role, and only
              then: a "use the default" link under a switch nobody has touched
              is a control that does nothing. */}
          {hasExplicit && (
            <button
              onClick={clearExplicit}
              style={{
                marginTop: 4, padding: 0, border: 0, background: "transparent", cursor: "pointer",
                color: BLUE, fontSize: 11, fontWeight: 700, fontFamily: "inherit",
              }}>
              Use my role's default
            </button>
          )}
        </span>

        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Refill request alerts"
          disabled={busy}
          onClick={() => setEnabled(!enabled)}
          style={{
            flex: "0 0 auto", width: 52, height: 30, borderRadius: 999, cursor: busy ? "wait" : "pointer",
            border: `1px solid ${enabled ? "rgba(74,127,255,.6)" : "rgba(255,255,255,.12)"}`,
            background: enabled ? "rgba(74,127,255,.32)" : "rgba(255,255,255,.05)",
            position: "relative", padding: 0, opacity: busy ? 0.6 : 1, transition: "background .18s, border-color .18s",
          }}>
          <span style={{
            position: "absolute", top: 3, left: enabled ? 25 : 3, width: 22, height: 22, borderRadius: "50%",
            background: enabled ? "#fff" : "rgba(255,255,255,.45)", transition: "left .18s",
          }} />
        </button>
      </div>
    </div>
  );
}
