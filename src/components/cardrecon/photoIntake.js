// ─── WHICH PICKED FILES GO INTO AN UPLOAD, AND WHAT THE MANAGER IS TOLD ───────
// Pure: no React, no canvas, no Firebase. The screen owns the state and the
// decoding; this owns the decision, so the decision can be tested without
// rendering a module that imports Firebase at load time (the house convention —
// see enginePolicyGates.test.jsx on why rendering is avoided here).
//
// Two slot shapes, one function:
//   the DETAIL roll accumulates up to its cap and refuses the excess by name
//   the SUMMARY is a single slot, so a new pick REPLACES what is there — a bad
//   shot is re-taken rather than removed and then re-taken

/** A long roll takes more frames than a short one. Six ~2000px sections is a
 *  comfortable margin over the four a 50-transaction batch needs, and stays
 *  well inside the callable's own ceiling of 14 photos per capture. */
export const MAX_DETAIL_PHOTOS = 6;
/** The header + totals block is one frame. */
export const MAX_SUMMARY_PHOTOS = 1;

/**
 * @param {object}   a
 * @param {any[]}    a.current   photos this upload already holds
 * @param {File[]}   a.files     what the picker just handed over
 * @param {number}   a.cap       slots for this upload
 * @param {boolean} [a.replace]  single-slot behaviour: the pick replaces
 * @param {(f:File)=>boolean} a.isImage
 * @param {(f:File)=>string}  a.describe
 * @returns {{ keep:any[], take:File[], refusal:string|null, notice:string|null }}
 *   `keep` is what survives from `current`; `take` is what should be decoded.
 *   `refusal` means nothing was taken. `notice` means some were.
 */
export function planPhotoIntake({ current, files, cap, replace = false, isImage, describe }) {
  const held = Array.isArray(current) ? current : [];
  const picked = Array.isArray(files) ? files : [];
  if (!picked.length) return { keep: held, take: [], refusal: null, notice: null };

  // A refusal NAMES the file. "That doesn't look like a photo" — about a photo
  // — is not something a manager on a shop floor can act on.
  //
  // And ONE bad file does not discard the good ones with it. A manager who
  // multi-selects six roll sections and catches a stray PDF should keep the six
  // and be told about the one, not start again at a till with a queue.
  const usable = picked.filter((f) => isImage(f));
  const unusable = picked.filter((f) => !isImage(f));
  const namedBad = unusable.length ? `Couldn't use ${unusable.map(describe).join("; ")}.` : null;
  if (!usable.length) {
    return { keep: held, take: [], notice: null, refusal: namedBad };
  }

  const keep = replace ? [] : held;
  const room = Math.max(0, cap - keep.length);
  if (room === 0) {
    return { keep: held, take: [], notice: null,
      refusal: `This upload already holds its ${cap} photo${cap === 1 ? "" : "s"} — tap one to remove it first.` };
  }

  const take = usable.slice(0, room);
  const dropped = usable.length - take.length;
  const overCap = dropped > 0
    ? `Only ${cap === 1 ? "1 photo fits" : `${cap} photos fit`} here, so ${dropped} of those weren't added.`
    : null;
  return {
    keep, take, refusal: null,
    notice: [namedBad, overCap].filter(Boolean).join(" ") || null,
  };
}

/**
 * Fold freshly-decoded photos into whatever state holds NOW.
 *
 * Separate from planPhotoIntake on purpose. The plan decides how many to DECODE,
 * from the value at pick time; this decides what the array BECOMES, and it has
 * to run against live state — decoding is slow (a HEIC on a mid-range Android
 * goes through a wasm decoder), the picker can be reopened while it runs, and
 * two overlapping picks that both wrote `[...theirOwnStaleCopy, ...theirs]`
 * would leave only the second one's photos, silently.
 *
 * Pass this to the state setter, not an array.
 */
export function mergeIntake({ prepared, cap, replace = false }) {
  return (prev) => {
    const base = replace ? [] : (Array.isArray(prev) ? prev : []);
    // The cap is re-applied here too: a racing pick may have filled slots since
    // the plan measured them, and losing a photo to a race is worse than
    // dropping one at the end of a list.
    return [...base, ...prepared].slice(0, cap);
  };
}
