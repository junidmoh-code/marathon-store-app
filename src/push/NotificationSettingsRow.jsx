// ─── THE ONE PERSONAL SETTING IN THIS APP, BESIDE THE ONE SIGN-OUT ───────────
// This app has no "My Settings" screen and did not need one invented. It has
// exactly one place where a staff member acts on their own account rather than
// on stock: the row at the bottom of the home page they sign out from (owner
// directive 2026-08-08, "one logout in one place"). The notification switch
// goes directly above it, in the same block, on both the desktop and mobile
// home branches — so the answer to "where do I turn this off?" is the same
// answer as "where do I sign out?", which every staff member already knows.
//
// It is where it was before #573 deleted it, on purpose: staff who used it
// already know where to look.
//
// ── IT IS A MUTE, NOT AN OPT-IN, AND THE DIFFERENCE IS THE WHOLE POINT ──────
// Turning it ON does not subscribe anybody to anything. Junid's assignment is
// the only thing that grants a hub, and it lives on nodes this browser cannot
// write. What this switch does is:
//
//   ON  — asks the browser for notification permission and registers this
//         device's address, then clears any mute. It is THE ONLY PATH IN THE
//         APP THAT CAN ASK FOR PERMISSION, because a permission prompt is only
//         honoured from a real user gesture. Between #573 and this release
//         there was no such path and nobody could receive anything at all.
//   OFF — writes a mute. That person's phone stays quiet whatever they are
//         assigned to, until they switch it back on.
//
// Somebody who has NEVER touched it is not muted. If their browser already
// allows notifications they are already reachable and an assignment works the
// moment it is made; if it does not, this is the tap that fixes it. Nobody ever
// has to find this switch in order to START receiving — that was the failure of
// the opt-in model, and it is not rebuilt here.
//
// ── IT SAYS WHY IT IS OFF ───────────────────────────────────────────────────
// A switch that sits looking on while nothing arrives is worse than no switch.
// So every state in which this device CANNOT receive is named in the sub-line,
// in the words a person can act on — and the switch shows OFF in every one of
// them, because it is off, whatever the person intended. Permission denied is
// the one that matters most: the browser will never prompt again, no amount of
// tapping this will change it, and the only fix is in site settings.

import { PUSH_STATE } from "./registerPush";

const BLUE = "#4A7FFF";
const BLUE_L = "#9DBCFF";
const AMBER = "#F5A623";

// ── THE STATES WHERE THE DEVICE IS THE OBSTACLE ─────────────────────────────
// Keyed by PUSH_STATE. Anything not listed is a working "on". Each says what is
// wrong and where the fix is; none of them pretends this switch can do it.
const TROUBLE = {
  [PUSH_STATE.BLOCKED]:
    "Notifications are blocked for this site, so nothing can reach this device — "
    + "and your browser will not ask again. On iPhone: Settings → Notifications → Marathon → Allow Notifications. "
    + "On Android Chrome: tap the ⋮ menu → Site settings → Notifications → Allow. "
    + "This switch cannot undo it.",
  [PUSH_STATE.NEEDS_INSTALL]:
    "On iPhone and iPad, alerts only work from the Home Screen copy. Tap Share → Add to Home Screen, then open Marathon from there and switch this on.",
  [PUSH_STATE.NEEDS_PERMISSION]:
    "One tap left — switch this on and choose Allow when your browser asks.",
  [PUSH_STATE.UNSUPPORTED]:
    "This browser can't show alerts. Chrome on Android, or the Home Screen app on iPhone, can.",
  [PUSH_STATE.MISCONFIGURED]:
    "Alerts aren't set up on the server yet. Nothing you can fix from here — tell Junid.",
  [PUSH_STATE.ERROR]:
    "Couldn't set alerts up on this device. Reopening the app usually clears it.",
};

/**
 * @param {object} props
 * @param {object} props.push  usePushRegistration() — uid, state, busy, enablePush
 * @param {object} props.mute  usePushMute()         — muted, known, busy, error, setMuted
 */
export default function NotificationSettingsRow({ push, mute }) {
  if (!push || !push.uid || !mute) return null;
  const { state, enablePush } = push;
  const { muted, known, error, setMuted } = mute;

  // ── WHAT THE SWITCH SHOWS ────────────────────────────────────────────────
  // Not the intention — the OUTCOME. A person who has not muted themselves but
  // whose browser refuses notifications is not receiving anything, and a switch
  // sitting in the on position over that is the exact lie this row exists to
  // stop. So: on means this device is registered AND not muted, and nothing
  // else does.
  //
  // `state === null` is registration still in flight. It renders as off with no
  // warning (TROUBLE has no null key), which settles within a moment.
  const trouble = TROUBLE[state] || null;
  const on = !muted && state === PUSH_STATE.ON;
  const busy = !!push.busy || !!mute.busy;

  const sub = error
    // A refused read or write of the setting itself. Named rather than
    // swallowed: until PUSH-MUTE-RULE-DEPLOY.md is pasted this is what
    // everybody sees, and "nothing happened" would send them to Junid with no
    // information.
    ? `Couldn't save this setting on your account. ${error}`
    : trouble
      || (muted
        ? "Muted — your phone stays quiet even when you're assigned to a hub. Switch on to hear about orders again."
        : "On — you'll be alerted when a shop places an order for a hub you're assigned to.");

  const onToggle = async () => {
    if (busy) return;
    if (on) { await setMuted(true); return; }
    // OFF → ON. Two things, in this order, and both every time.
    //
    // The permission request FIRST, because it is the half that can fail and
    // the half a tap is required for. It is safe to call when permission is
    // already granted — it re-registers the address, which is what a person
    // whose token rotated needs anyway.
    //
    // The unmute regardless of what permission said. Somebody who denies the
    // prompt has still expressed "I want these", and storing that means the day
    // they fix it in site settings it simply works, with nothing further to
    // find. A mute left standing behind a denied prompt would be a second,
    // invisible reason they hear nothing.
    await enablePush();
    if (muted) await setMuted(false);
  };

  return (
    <div style={{ marginTop: 34, paddingTop: 18, borderTop: "1px solid rgba(255,255,255,.07)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 13, minHeight: 48,
        padding: "12px 14px", borderRadius: 13,
        border: `1px solid ${on ? "rgba(74,127,255,.35)" : "rgba(255,255,255,.08)"}`,
        background: on ? "rgba(74,127,255,.07)" : "rgba(255,255,255,.022)",
      }}>
        <span style={{
          width: 34, height: 34, flex: "0 0 auto", borderRadius: 11, display: "grid", placeItems: "center",
          color: on ? BLUE_L : "rgba(233,238,255,.4)",
          background: on ? "rgba(74,127,255,.14)" : "rgba(255,255,255,.04)",
          border: `1px solid ${on ? "rgba(74,127,255,.28)" : "rgba(255,255,255,.07)"}`,
        }}>
          {/* A struck-through bell while muted: the state is legible from
              across the room, before anybody reads the sub-line. */}
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
            {muted && <path d="M3 3l18 18" />}
          </svg>
        </span>

        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "#fff" }}>
            New order alerts
          </span>
          <span style={{ display: "block", fontSize: 11.5, lineHeight: 1.45, color: (trouble || error) ? AMBER : "rgba(233,238,255,.5)" }}>
            {sub}
          </span>
        </span>

        <button
          role="switch"
          aria-checked={on}
          aria-label="New order alerts"
          // Locked only while a write is in flight, or before the first
          // snapshot of the setting has landed. Toggling from an unknown
          // baseline is how a switch ends up flipping back on its own.
          disabled={busy || !known}
          onClick={onToggle}
          style={{
            flex: "0 0 auto", width: 52, height: 30, borderRadius: 999,
            cursor: busy ? "wait" : (known ? "pointer" : "not-allowed"),
            border: `1px solid ${on ? "rgba(74,127,255,.6)" : "rgba(255,255,255,.12)"}`,
            background: on ? "rgba(74,127,255,.32)" : "rgba(255,255,255,.05)",
            position: "relative", padding: 0, opacity: (busy || !known) ? 0.6 : 1,
            transition: "background .18s, border-color .18s",
          }}>
          <span style={{
            position: "absolute", top: 3, left: on ? 25 : 3, width: 22, height: 22, borderRadius: "50%",
            background: on ? "#fff" : "rgba(255,255,255,.45)", transition: "left .18s",
          }} />
        </button>
      </div>
    </div>
  );
}
