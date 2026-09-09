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

  // ── THE MUTE IS SAID FIRST, EVEN WHEN THE DEVICE ALSO HAS TROUBLE ────────
  // Trouble used to win outright, so somebody muted AND blocked read only
  // "Notifications are blocked…" — nothing said they had also silenced
  // themselves. They would tap to fix the blocking, silently unmute on the way
  // past (the tap's job when muted), see no change at all because the browser
  // still refuses, and Junid's card would flip from "muted" to blank with
  // nobody having meant it. Both facts are true, so both are printed, the
  // account-wide one first because it is the one they can act on from here.
  const MUTED_LINE = "Muted — your phone stays quiet even when you're assigned to a hub. Switch on to hear about orders again.";
  const sub = error
    // A refused read or write of the setting itself. Named rather than
    // swallowed: this is what everybody saw before PUSH-MUTE-RULE-DEPLOY.md was
    // pasted, and "nothing happened" would send them to Junid with no
    // information. A READ that failed is not a save that failed — printing the
    // second over the first told people their save had failed when they had
    // saved nothing.
    ? (error.kind === "read"
      ? `Your alert setting couldn't be read on this device, so this switch can only ask for permission — tell Junid. (${error.message})`
      : `Couldn't save this setting on your account. ${error.message}`)
    : muted
      ? (trouble ? `${MUTED_LINE} Also: ${trouble}` : MUTED_LINE)
      : trouble
        // Registration still in flight. Saying "On — you'll be alerted" beside
        // a switch that is rendering OFF is the copy contradicting the control.
        || (state === null
          ? "Setting up alerts on this device…"
          : "On — you'll be alerted when a shop places an order for a hub you're assigned to.");

  // ── THE SWITCH IS THE DEVICE. THE MUTE IS THE ACCOUNT. ───────────────────
  // These come apart, and the row has to let them.
  //
  // A mute is account-wide: it silences that person's phone from wherever they
  // write it. Registration is per-BROWSER. So a picker whose phone is buzzing
  // can perfectly well be sitting at the shop desktop, where this browser is
  // UNSUPPORTED or blocked — and they must still be able to say "stop".
  //
  // Driving the tap off the rendered `on` made that impossible: `on` is false
  // on that desktop (correctly — this browser receives nothing), so every tap
  // read as "turn it on", ran the permission request, and never wrote the mute.
  // The switch moved, nothing was stored, and their phone kept ringing. The tap
  // therefore branches on the three real cases, not on the two the switch has
  // room to show.
  const onToggle = async () => {
    if (busy) return;
    // ── THE PERMISSION REQUEST IS NEVER GATED ON THE MUTE READ ───────────────
    // If the setting could not be read we do not know the baseline, so we may
    // not WRITE a mute — but asking the browser for permission is unrelated to
    // that node and must always be reachable. Locking the whole control on
    // `known` is what made a refused /push_mutes read reproduce the original
    // outage: no prompt, from a node that has nothing to do with prompting.
    if (!known) { await enablePush(); return; }
    if (muted) {
      // MUTED → AUDIBLE. Both halves, in this order, and both every time.
      //
      // The permission request FIRST, because it is the half that can fail and
      // the half a tap is required for. Safe when permission is already
      // granted — it re-registers the address, which is what somebody whose
      // token rotated needs anyway.
      //
      // The unmute REGARDLESS of what permission said. Somebody who denies the
      // prompt has still expressed "I want these", and storing that means the
      // day they fix it in site settings it simply works, with nothing further
      // to find. A mute left standing behind a denied prompt would be a
      // second, invisible reason they hear nothing.
      await enablePush();
      await setMuted(false);
      return;
    }
    if (state === PUSH_STATE.ON) { await setMuted(true); return; }
    // NOT MUTED, and this browser cannot receive. The switch reads off, so a
    // tap is a request to make it work — try the permission path. It must NOT
    // mute them: they never asked for quiet, and a switch that silences an
    // account because the device it was tapped on is unsupported is the worst
    // outcome available here. Muting from this state is the explicit link
    // below, which says what it does.
    await enablePush();
  };

  // The escape hatch for the case above: audible, on a browser that cannot
  // receive, wanting quiet on the device that CAN. Offered only in that exact
  // state — a "silence everything" link under a working switch would be a
  // second control for the thing the switch already does.
  const showSilenceLink = known && !muted && !!trouble && !error;

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
          {showSilenceLink && (
            <button
              onClick={() => { if (!busy) setMuted(true); }}
              disabled={busy}
              style={{
                marginTop: 5, padding: 0, border: 0, background: "transparent",
                cursor: (busy || !known) ? "not-allowed" : "pointer",
                color: BLUE, fontSize: 11, fontWeight: 700, fontFamily: "inherit",
              }}>
              Silence alerts on all my devices
            </button>
          )}
        </span>

        <button
          role="switch"
          aria-checked={on}
          aria-label="New order alerts"
          // Locked only while a write is in flight, or before the first
          // snapshot of the setting has landed. Toggling from an unknown
          // baseline is how a switch ends up flipping back on its own.
          // Only while a write is in flight. NOT on `known` — see onToggle.
          disabled={busy}
          onClick={onToggle}
          style={{
            flex: "0 0 auto", width: 52, height: 30, borderRadius: 999,
            cursor: busy ? "wait" : "pointer",
            border: `1px solid ${on ? "rgba(74,127,255,.6)" : "rgba(255,255,255,.12)"}`,
            background: on ? "rgba(74,127,255,.32)" : "rgba(255,255,255,.05)",
            position: "relative", padding: 0, opacity: busy ? 0.6 : 1,
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
