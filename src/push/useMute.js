// ─── READING AND WRITING ONE PERSON'S OWN MUTE ───────────────────────────────
// A live subscription to /push_mutes/{uid}, and the one writer.
//
// ── ONE LEAF, ONE LISTENER, OWN UID ONLY ────────────────────────────────────
// The path is per-uid and the rule scopes both read and write to auth.uid, so
// this cannot see or change anybody else's. It is a listener rather than a
// one-shot get because the switch has to be right on a second device: someone
// who mutes on their phone and then opens the app on the shop tablet must see
// muted there too, not a switch that says on until they reload.
//
// The record is a stamp and a boolean, so the listener costs the size of a
// couple of hundred bytes at most, once per session.
//
// ── `known` MUST NEVER LOCK THE PERMISSION REQUEST ──────────────────────────
// It gates the MUTE WRITE and nothing else. Gating the whole control on it put
// the app one refused read away from the outage it was built to fix: before the
// /push_mutes rule was published this listener was denied for everybody, `known`
// stayed false, the switch was permanently disabled, and Notification.request-
// Permission() was unreachable again — from a node that has nothing to do with
// permission. See the tap logic in NotificationSettingsRow.
//
// ── "NOT KNOWN" IS NOT "NOT MUTED" ──────────────────────────────────────────
// `known` is false until the first snapshot arrives, and false again if the
// read is refused. The switch renders from `muted`, which defaults to false —
// so a screen that has not heard back shows AUDIBLE, which is the truth for
// everybody who has never touched it and the safe direction for the rest: the
// worst case is a switch that looks on for a moment before settling.
//
// What `known` gates is the WRITE. Toggling from an unknown baseline is how you
// get a switch that flips back on the next snapshot, so the control is disabled
// until the first one lands. Same reasoning as the locked hub switches on the
// admin card when its assignment read fails.
//
// ── A REFUSED READ IS THE UNPASTED RULE, AND IT SAYS SO ─────────────────────
// /push_mutes is a new top-level node. Until its rule is published (see
// PUSH-MUTE-RULE-DEPLOY.md) both the read and the write are PERMISSION_DENIED,
// and the row has to say that rather than sit there looking broken. The error
// is surfaced, not swallowed.

import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref, update } from "firebase/database";
import { database } from "../firebase";
import { serverNowMs } from "../utils/serverTime";
import { isMuted, muteUpdates, pushMutePath } from "./pushMute";

/**
 * @param {object} args
 * @param {string|null} args.uid
 * @returns {{muted: boolean, known: boolean, busy: boolean,
 *            error: {kind: "read"|"write", message: string}|null,
 *            setMuted: (next: boolean) => Promise<boolean>}}
 */
export function usePushMute({ uid }) {
  const [muted, setMutedState] = useState(false);
  const [known, setKnown] = useState(false);
  // ── ROLL BACK TO THE SERVER, NOT TO WHAT WAS ON SCREEN ───────────────────
  // The optimistic write used to capture the value it replaced and restore
  // that on a refusal. With two tabs open that restores a STALE answer: tab A
  // starts audible and its mute is refused slowly; tab B mutes successfully
  // meanwhile; A's listener has already moved to `true`, and A's catch then
  // overwrites it with the `false` it captured before any of that happened. A
  // sits there reading audible over a stored mute until some later snapshot
  // happens to arrive.
  //
  // This ref always holds the last value the LISTENER saw, so a refusal
  // reverts to what the database actually says rather than to what this tab
  // last believed.
  const serverMuted = useRef(false);
  const [busy, setBusy] = useState(false);
  // ── A FAILED READ AND A FAILED WRITE ARE DIFFERENT SENTENCES ─────────────
  // The row printed "Couldn't save this setting" over both, so somebody who had
  // saved nothing was told their save failed — and before the rule was pasted
  // that was what EVERYBODY saw. `kind` is "read" or "write"; `message` is the
  // raw SDK text, which the row may show but must not present as the whole
  // explanation.
  const [error, setError] = useState(null);   // null | { kind, message }

  useEffect(() => {
    // Reset on every uid change BEFORE subscribing. On a shared tablet the
    // previous person's mute must never be shown as this one's, not even for
    // the frame before the first snapshot.
    setMutedState(false); setKnown(false); setError(null);
    serverMuted.current = false;
    if (!uid) return undefined;
    const node = ref(database, pushMutePath(uid));
    const unsub = onValue(
      node,
      (snap) => {
        const v = isMuted(snap.val());
        serverMuted.current = v;
        setMutedState(v); setKnown(true); setError(null);
      },
      (err) => {
        console.error("[push] could not read your notification setting:", err);
        setKnown(false);
        setError({ kind: "read", message: (err && err.message) || "Could not read this setting." });
      },
    );
    return () => { unsub(); };
  }, [uid]);

  /**
   * Write the mute. OPTIMISTIC, then reconciled by the listener — and rolled
   * back by hand on a refusal, because a refused write produces no snapshot to
   * correct the optimistic one and the switch would otherwise sit in a state
   * nothing had stored.
   *
   * @returns {Promise<boolean>} whether the write landed
   */
  const setMuted = useCallback(async (next) => {
    if (!uid) return false;
    const want = !!next;
    setMutedState(want);
    setBusy(true);
    try {
      await update(ref(database), muteUpdates(uid, want, serverNowMs()));
      setError(null);
      return true;
    } catch (e) {
      console.error("[push] could not save your notification setting:", e);
      setMutedState(serverMuted.current);
      setError({ kind: "write", message: (e && e.message) || "Could not save this setting." });
      return false;
    } finally {
      setBusy(false);
    }
    // `muted` is deliberately NOT a dependency any more: the rollback reads a
    // ref, so this callback no longer closes over a value that goes stale.
  }, [uid]);

  return { muted, known, busy, error, setMuted };
}
