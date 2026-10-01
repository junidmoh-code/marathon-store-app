// ─── THE ONE HOOK THAT KEEPS A DEVICE'S REGISTRATION HONEST ──────────────────
// Called once, at the app root, on every load. Two jobs:
//
//   1. RE-ARM. Refresh this browser's FCM token row on EVERY load, so that the
//      moment Junid assigns this person to a hub the very next order reaches
//      them. A token rotates silently and a rotated token is a dead address, so
//      this cannot be a once-per-install step (src/push/registerPush.js).
//   2. OFFER A WAY IN. Expose `enablePush()` — the ONE path in this app that
//      may call Notification.requestPermission(), because it is the one that a
//      real user gesture reaches.
//
// ── WHY (2) HAD TO COME BACK ────────────────────────────────────────────────
// Between 2026-09-07 and this release there was no such path at all. The
// personal toggle was deleted with the opt-in model it belonged to, and it was
// the only caller that ever passed `promptIfNeeded: true`. What was left called
// ensurePushRegistration with `promptIfNeeded: false` on every load and nothing
// else, so a browser sitting at `Notification.permission === "default"` — which
// is EVERY browser that has never been asked, i.e. all of them — resolved to
// NEEDS_PERMISSION, wrote nothing, and was never asked again by anything.
//
// The consequence was total and silent: no permission was ever granted, so no
// token was ever minted, so /push_tokens stayed empty, so every row on the
// Order alerts card read "no device" and no order notified anybody. The feature
// was not misconfigured — it had no entrance.
//
// The re-arm on every load was correct and is unchanged. What is restored is
// the door: src/push/NotificationSettingsRow.jsx calls enablePush() from a tap.
//
// ── AN ASSIGNMENT STILL GRANTS, AND ONLY AN ASSIGNMENT ──────────────────────
// Registering a token is not a subscription; it is an ADDRESS. A token with no
// assignment is never sent to, because the fan-out resolves recipients from
// /push_hub_audience and nothing else. `enablePush()` writes an ADDRESS — a
// /push_tokens row — and nothing else. It does NOT touch /push_mutes: clearing
// a mute is a second, separate step made by the row component after this
// resolves (NotificationSettingsRow.onToggle). Said precisely because the loose
// version of this sentence invites a future reader to delete that second step
// as redundant, which would leave anybody who had muted themselves muted for
// ever however often they switched back on. Either way it cannot put somebody
// in a hub audience, and no rule would let it: /push_hub_audience is
// super-admin-write-only.
//
// `buckets` is ALWAYS empty, which makes every load CLEAR this uid out of the
// legacy /push_audience index — the fan-out stopped reading it on 2026-09-07,
// and self-healing on the way past means the live node empties itself.
//
// ── WHAT IT COSTS ───────────────────────────────────────────────────────────
// One small token row per app open, for the devices that can actually receive,
// plus the single-leaf mute read in usePushMute. A browser that has never been
// granted permission writes nothing at all.

import { useCallback, useEffect, useRef, useState } from "react";
import { PUSH_STATE, ensurePushRegistration, pushCapability } from "./registerPush";

/**
 * @param {object} args
 * @param {object|null} args.user  firebase auth user
 */
export function usePushRegistration({ user }) {
  const uid = user && !user.isAnonymous ? user.uid : null;
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  // ── ONLY THE NEWEST ATTEMPT MAY WRITE THE STATE ──────────────────────────
  // Two registrations can be in flight at once: the passive one this hook
  // starts on mount, and the one a tap starts through enablePush(). They
  // resolve in whatever order the network gives them, and both used to call
  // setState unconditionally — so a passive attempt that started first and
  // finished LAST could overwrite a successful ON with its own older,
  // pre-permission NEEDS_PERMISSION or ERROR. `ready` would then be false over
  // a live token, and the foreground banner and chime would stay switched off
  // until something re-registered.
  //
  // Every attempt takes a ticket. A stale one writes nothing. Same discipline
  // as the load generation counter in PushAssignmentsCard.
  const attempt = useRef(0);

  useEffect(() => {
    if (!uid) { setState(null); return undefined; }
    let cancelled = false;
    const mine = ++attempt.current;
    const live = () => !cancelled && attempt.current === mine;
    // Cleared before every attempt AND on a uid change, so a previous user's
    // successful registration can never be read as this one's. On a shared
    // tablet that is the difference between "B is registered" and "A was".
    setState(null);
    // BUSY WHILE IT RUNS. A first-ever load registers a service worker and
    // mints a token, which is seconds on a phone — and a tap during that window
    // used to start a SECOND ensurePushRegistration concurrently, racing two
    // getToken calls and two transactions on the same token row. The switch is
    // disabled for those seconds instead, which is also the honest reading: a
    // registration really is in flight.
    setBusy(true);
    // PASSIVE. An effect is not a user gesture: Chrome ignores a prompt fired
    // from one and Safari holds it against the site. This path only refreshes
    // a registration that OS permission already allows.
    ensurePushRegistration({ uid, wanted: true, buckets: [], promptIfNeeded: false })
      .then((r) => { if (live()) setState(r.state); })
      .catch((e) => { if (live()) { console.error("[push]", e); setState(PUSH_STATE.ERROR); } })
      .finally(() => { if (live()) setBusy(false); });
    return () => { cancelled = true; };
  }, [uid]);

  /**
   * Ask the browser for permission and register a token. THE ONLY CALLER MAY BE
   * A TAP — passing promptIfNeeded from anywhere else reintroduces the prompt
   * that browsers ignore and Safari penalises.
   *
   * Resolves to the resulting PUSH_STATE so the caller can react to a refusal
   * in the same turn rather than waiting for the next render.
   *
   * @returns {Promise<string>} a PUSH_STATE value
   */
  const enablePush = useCallback(async () => {
    if (!uid) return PUSH_STATE.ERROR;
    const mine = ++attempt.current;
    setBusy(true);
    try {
      const r = await ensurePushRegistration({ uid, wanted: true, buckets: [], promptIfNeeded: true });
      if (attempt.current === mine) setState(r.state);
      // The RESULT is returned either way — the caller asked this question and
      // is entitled to its answer even if a newer attempt now owns the state.
      return r.state;
    } catch (e) {
      console.error("[push] enable failed:", e);
      if (attempt.current === mine) setState(PUSH_STATE.ERROR);
      return PUSH_STATE.ERROR;
    } finally {
      setBusy(false);
    }
  }, [uid]);

  return {
    uid,
    // ── WHAT THE FOREGROUND LISTENER MUST GATE ON ────────────────────────────
    // Registration can be in flight, or have come back BLOCKED, UNSUPPORTED,
    // NEEDS_PERMISSION or ERROR — and several of those paths leave an earlier
    // token alive, so a payload can reach the tab and chime at somebody whose
    // registration is not actually working. `ready` says the current uid's
    // registration returned ON, and nothing else does.
    ready: state === PUSH_STATE.ON,
    state,
    busy,
    enablePush,
    capability: pushCapability(),
  };
}
