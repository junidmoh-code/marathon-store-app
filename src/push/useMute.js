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

import { useCallback, useEffect, useState } from "react";
import { onValue, ref, update } from "firebase/database";
import { database } from "../firebase";
import { serverNowMs } from "../utils/serverTime";
import { isMuted, muteUpdates, pushMutePath } from "./pushMute";

/**
 * @param {object} args
 * @param {string|null} args.uid
 * @returns {{muted: boolean, known: boolean, busy: boolean, error: string|null,
 *            setMuted: (next: boolean) => Promise<boolean>}}
 */
export function usePushMute({ uid }) {
  const [muted, setMutedState] = useState(false);
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Reset on every uid change BEFORE subscribing. On a shared tablet the
    // previous person's mute must never be shown as this one's, not even for
    // the frame before the first snapshot.
    setMutedState(false); setKnown(false); setError(null);
    if (!uid) return undefined;
    const node = ref(database, pushMutePath(uid));
    const unsub = onValue(
      node,
      (snap) => { setMutedState(isMuted(snap.val())); setKnown(true); setError(null); },
      (err) => {
        console.error("[push] could not read your notification setting:", err);
        setKnown(false);
        setError(err && err.message ? err.message : "Could not read this setting.");
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
    const prev = muted;
    setMutedState(want);
    setBusy(true);
    try {
      await update(ref(database), muteUpdates(uid, want, serverNowMs()));
      setError(null);
      return true;
    } catch (e) {
      console.error("[push] could not save your notification setting:", e);
      setMutedState(prev);
      setError(e && e.message ? e.message : "Could not save this setting.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [uid, muted]);

  return { muted, known, busy, error, setMuted };
}
