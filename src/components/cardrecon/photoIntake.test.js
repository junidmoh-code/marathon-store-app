// The capture screen's photo intake: where frames may come from, how many fit,
// and — the one that decides whether a capture uploads at all on shop wifi —
// that EVERY picked file is downscaled, not just the ones from the camera.
//
// The decision is pure (photoIntake.js) and tested directly. The parts that
// need a browser — decoding and state — are asserted at the source, the same
// compromise enginePolicyGates.test.jsx makes and for the same reason: the
// screen imports Firebase at module scope, so rendering it would mean mocking
// most of the app, and the mock would be likelier to be wrong than the thing
// under test.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planPhotoIntake, mergeIntake, payloadRefusal, MAX_PAYLOAD_BYTES, MAX_DETAIL_PHOTOS, MAX_SUMMARY_PHOTOS } from "./photoIntake";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "CardReconScreen.jsx"), "utf8");

// STRIP COMMENTS LINE-WISE, not with /\/\*[\s\S]*?\*\//.
//
// That naive form treats the `/*` inside `accept="image/*"` as the start of a
// block comment and eats the source from there to the next `*/` — which is
// exactly the region these tests assert about. It was silently deleting one of
// the two file inputs, and every assertion here was running against the
// wreckage: `expect(code).not.toMatch(/capture=/)` passes very easily against
// text with the inputs removed.
//
// A block comment in this file always OPENS a line (`/**`, `/*`, or a JSX
// `{/*`). An `accept="image/*"` never does. So anchor on that.
const code = SOURCE
  .split("\n")
  .reduce(({ out, inBlock }, line) => {
    if (inBlock) return { out, inBlock: !/\*\//.test(line) };
    if (/^\s*\{?\/\*/.test(line)) return { out, inBlock: !/\*\//.test(line) };
    if (/^\s*\/\//.test(line)) return { out, inBlock: false };
    return { out: [...out, line], inBlock: false };
  }, { out: [], inBlock: false })
  .out.join("\n");

const f = (name) => ({ name, type: "image/jpeg" });
const many = (n, p = "s") => Array.from({ length: n }, (_, i) => f(`${p}${i}.jpg`));
const opts = { isImage: () => true, describe: (x) => x.name };

describe("the picker, and how a tap opens it", () => {
  // Slice each file input from `<input` to its self-closing `/>`. A regex over
  // `[^>]*` cannot do it: `disabled={x >= y}` and `=>` both carry a `>`.
  const fileInputs = () =>
    [...code.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0]).filter((t) => /type="file"/.test(t));

  it("the stripper this file relies on has not eaten the input", () => {
    // If comment-stripping ever mangles the source again, every other assertion
    // here goes quietly green.
    expect(code).toContain('type="file"');
    expect(fileInputs(), "one upload per till card, and it must survive stripping")
      .toHaveLength(1);
    expect(code, "a real comment must still be gone").not.toContain("the label IS the control");
  });

  it("does not restrict the picker to the camera", () => {
    // `capture="environment"` makes the OS open the camera and NOTHING else.
    // Without it the manager can shoot the slip in the Photos app first and pick
    // the frame afterwards.
    expect(code).not.toMatch(/capture=/);
  });

  it("takes images only, one of them", () => {
    const [input] = fileInputs();
    expect(input).toMatch(/accept="image\/\*"/);
    expect(input, "one slip, one frame — `multiple` invites a pick the cap then drops")
      .not.toMatch(/\bmultiple\b/);
  });

  // ── THE BUG THIS SCREEN WAS REBUILT AROUND ────────────────────────────────
  // The picker is opened by the LABEL the card is made of, natively, with no
  // JavaScript in the path — and the input is laid out (1px, transparent)
  // rather than display:none, because a file input the browser has not laid out
  // is one phone browsers and webviews quietly refuse to activate. Both halves
  // are pinned: either one alone brings the dead button back.
  it("the card is a <label> around the input — nothing calls .click()", () => {
    expect(code, "the tappable card must be a label").toMatch(/<label\b/);
    expect(code, "a programmatic click is the failure mode this replaced")
      .not.toMatch(/\.click\(\)/);
    expect(code, "…and no ref stands in for one").not.toMatch(/useRef\(null\)/);
  });

  it("the input is laid out, never display:none", () => {
    const from = code.indexOf("input: {");
    expect(from, "the input's own style has moved — this scan must follow it").toBeGreaterThan(-1);
    const style = code.slice(from, code.indexOf("}", from));
    expect(style, "it must occupy layout").toMatch(/position: "absolute"/);
    expect(style, "…while being invisible").toMatch(/opacity: 0/);
    expect(code, "display:none is what a phone browser refuses to open")
      .not.toMatch(/display: "none"/);
  });

  it("nothing stands between the pick and the call", () => {
    // The screen this replaced parked the photo and waited for a second button
    // — one that was disabled unless a checkbox in the section above had been
    // ticked, and which looked identical disabled. The upload now starts on the
    // pick itself: onPick decodes and sends, with no button in between.
    const from = code.indexOf("const onPick =");
    expect(from, "onPick has been renamed — this scan must follow it").toBeGreaterThan(-1);
    const body = code.slice(from, code.indexOf("\n  };", from));
    expect(body, "the pick itself must reach the callable").toMatch(/await send\(tid, photo\.base64, false\)/);
    expect(code, "no checkbox may gate a capture again").not.toMatch(/type="checkbox"/);
  });
});

describe("the ~2000px downscale reaches library photos too", () => {
  // A file input cannot say whether a File came from the camera or the library.
  // The guarantee is therefore structural: ONE decode path, taken by every file.
  it("there is exactly one decode path and it carries the 2000px budget", () => {
    expect(code).toMatch(/const MAX_PHOTO_DIM = 2000;/);
    expect(code).toMatch(/decodeImageFile\(file,\s*MAX_PHOTO_DIM\)/);
    expect([...code.matchAll(/downscalePhoto\(/g)]).toHaveLength(2); // its definition + its one caller
  });

  it("the picked file is put through it before anything is sent", () => {
    // No branch may reach the callable with an undownscaled file: the only
    // base64 that leaves this screen is the one downscalePhoto produced.
    expect(code).toMatch(/photo = await downscalePhoto\(take\[0\]\)/);
    expect(code, "and that is what is sent").toMatch(/await send\(tid, photo\.base64, false\)/);
  });

  it("decoding goes through the shared decoder, so a library HEIC opens at all", () => {
    // FileReader + `new Image()` cannot decode HEIC anywhere but Safari, and an
    // iPhone's library stores HEIC. Removing `capture` without this would have
    // broken gallery selection on exactly the phones it is for.
    // Scoped to downscalePhoto: the PDF path legitimately uses readAsDataURL to
    // turn a file into base64, which is not image decoding and must not be
    // confused with it.
    //
    // ANCHORED TO THE FUNCTION'S OWN END, not to whatever happens to follow it.
    // This used to slice up to `const S = {`, and when the style block moved to
    // cardReconStyles.js the slice silently grew to the rest of the file and
    // swallowed the PDF path — a guard that failed for a reason having nothing
    // to do with what it guards. A landmark you do not own is not an anchor.
    const from = code.indexOf("async function downscalePhoto");
    expect(from, "downscalePhoto has been renamed — this scan must follow it").toBeGreaterThan(-1);
    const body = code.slice(from, code.indexOf("\n}\n", from) + 3);
    expect(body.length, "the slice must actually cover the function").toBeGreaterThan(200);
    expect(body, "…and must stop at its closing brace").not.toMatch(/const addPdf/);
    expect(body).toMatch(/decodeImageFile\(/);
    expect(body, "the naive decode path must be gone").not.toMatch(/new Image\(\)/);
    expect(body, "…and the image path must not read files as data URLs").not.toMatch(/readAsDataURL/);
  });

  it("and releases the decoded bitmap — six frames on a phone is where that shows", () => {
    expect(code).toMatch(/\.release\(\)/);
  });
});

describe("how many frames fit", () => {
  it("six on the detail roll, one on the summary", () => {
    expect(MAX_DETAIL_PHOTOS).toBe(6);
    expect(MAX_SUMMARY_PHOTOS).toBe(1);
  });

  it("takes all six, then refuses the seventh by name", () => {
    const six = planPhotoIntake({ current: [], files: many(6), cap: MAX_DETAIL_PHOTOS, ...opts });
    expect(six.take).toHaveLength(6);
    expect(six.refusal).toBeNull();
    expect(six.notice).toBeNull();

    const held = ["a", "b", "c", "d", "e", "f"];
    const seventh = planPhotoIntake({ current: held, files: [f("s7.jpg")], cap: MAX_DETAIL_PHOTOS, ...opts });
    expect(seventh.take).toEqual([]);
    expect(seventh.keep, "nothing already captured is lost to a refusal").toBe(held);
    expect(seventh.refusal).toMatch(/already holds its 6 photos/);
  });

  it("a nine-frame pick keeps six and says what it dropped", () => {
    const r = planPhotoIntake({ current: [], files: many(9), cap: MAX_DETAIL_PHOTOS, ...opts });
    expect(r.take).toHaveLength(6);
    expect(r.notice).toBe("Only 6 photos fit here, so 3 of those weren't added.");
    expect(r.refusal).toBeNull();
  });

  it("a partly-full roll takes only what fits", () => {
    const r = planPhotoIntake({ current: ["a", "b", "c", "d"], files: many(4), cap: MAX_DETAIL_PHOTOS, ...opts });
    expect(r.take).toHaveLength(2);
    expect(r.keep).toHaveLength(4);
    expect(r.notice).toMatch(/2 of those weren't added/);
  });

  it("the summary REPLACES rather than refuses — a bad shot is re-taken", () => {
    const r = planPhotoIntake({
      current: ["the first summary"], files: [f("sum2.jpg")],
      cap: MAX_SUMMARY_PHOTOS, replace: true, ...opts,
    });
    expect(r.keep, "the old shot is dropped, not kept alongside").toEqual([]);
    expect(r.take).toHaveLength(1);
    expect(r.refusal, "a manager is never stuck with a bad summary shot").toBeNull();
    expect(r.notice).toBeNull();
  });

  it("…and a multi-file pick into the one slot still lands exactly one", () => {
    const r = planPhotoIntake({
      current: [], files: many(3), cap: MAX_SUMMARY_PHOTOS, replace: true, ...opts,
    });
    expect(r.take).toHaveLength(1);
    expect(r.notice).toBe("Only 1 photo fits here, so 2 of those weren't added.");
  });

  it("a file the decoder will not accept is refused BY NAME, and nothing is decoded", () => {
    const r = planPhotoIntake({
      current: [], files: [f("notes.pdf")], cap: MAX_DETAIL_PHOTOS,
      isImage: () => false, describe: (x) => x.name,
    });
    expect(r.take, "an unusable file never reaches the decoder").toEqual([]);
    expect(r.refusal).toMatch(/notes\.pdf/);
  });

  it("…but one stray file does NOT discard the good ones picked with it", () => {
    // A manager who multi-selects six sections and catches a stray PDF should
    // keep the six and be told about the one, not start again at a till with a
    // queue behind them.
    const files = [...many(3), f("notes.pdf"), ...many(3, "t")];
    const r = planPhotoIntake({
      current: [], files, cap: MAX_DETAIL_PHOTOS,
      isImage: (x) => x.name.endsWith(".jpg"), describe: (x) => x.name,
    });
    expect(r.take).toHaveLength(6);
    expect(r.take.map((x) => x.name), "the stray is filtered OUT, not merely sliced off the end")
      .not.toContain("notes.pdf");
    expect(r.refusal, "the good ones went through, so this is a notice not a refusal").toBeNull();
    expect(r.notice).toMatch(/notes\.pdf/);
  });

  it("an empty pick — the manager cancelled — changes nothing and says nothing", () => {
    const held = ["a"];
    const r = planPhotoIntake({ current: held, files: [], cap: MAX_DETAIL_PHOTOS, ...opts });
    expect(r).toEqual({ keep: held, take: [], refusal: null, notice: null });
  });
});

describe("two picks at once must not lose photos", () => {
  // The regression this exists for: decoding is slow (a HEIC goes through a
  // wasm decoder), the picker can be reopened while it runs, and a write of
  // `[...ownStaleCopy, ...prepared]` from each of two overlapping picks leaves
  // only the second one's photos — silently, with the manager none the wiser.
  it("mergeIntake folds into LIVE state, not a captured copy", () => {
    const first = mergeIntake({ prepared: ["a", "b", "c"], cap: MAX_DETAIL_PHOTOS });
    const second = mergeIntake({ prepared: ["d", "e"], cap: MAX_DETAIL_PHOTOS });
    // Both were planned against an EMPTY roll; they resolve in order.
    let state = [];
    state = first(state);
    state = second(state);
    expect(state, "nothing from the first pick is lost").toEqual(["a", "b", "c", "d", "e"]);
  });

  it("…and the cap still holds when two picks race past it", () => {
    let state = [];
    state = mergeIntake({ prepared: ["a", "b", "c", "d"], cap: MAX_DETAIL_PHOTOS })(state);
    state = mergeIntake({ prepared: ["e", "f", "g", "h"], cap: MAX_DETAIL_PHOTOS })(state);
    expect(state).toHaveLength(MAX_DETAIL_PHOTOS);
    expect(state.slice(0, 4), "the earlier photos are the ones kept").toEqual(["a", "b", "c", "d"]);
  });

  it("replace still replaces, whatever is in state when it lands", () => {
    const fold = mergeIntake({ prepared: ["new"], cap: MAX_SUMMARY_PHOTOS, replace: true });
    expect(fold(["old"])).toEqual(["new"]);
    expect(fold([])).toEqual(["new"]);
  });

  it("a till that is uploading cannot be re-tapped", () => {
    // The screen now sends on the pick, so a second pick mid-flight would be a
    // second capture of the same batch — refused by the server as a duplicate,
    // but only after the manager has been told nothing for a minute. The input
    // is disabled while its own card is busy, and a disabled input is one its
    // label cannot open.
    expect(code).toMatch(/disabled=\{busy\}/);
    expect(code, "…and the card says so").toMatch(/Reading…/);
  });

  it("each card is busy on its own — one upload does not freeze the others", () => {
    // Four tills, four independent captures. A single screen-wide `busy` flag
    // would make the slowest phone's one upload lock the whole screen.
    expect(code, "work is keyed by till").toMatch(/const \[work, setWork\] = useState\(\{\}\)/);
    expect(code).toMatch(/const state = work\[t\.tid\] \|\| \{\}/);
  });
});

describe("the screen says only what it must", () => {
  it("no numbered steps, no instructional prose, no split to explain", () => {
    // A manager uses this for ten seconds. The screen it replaced carried four
    // numbered sections, a paragraph on PDFs versus photos, an explanation of
    // the detail roll and a fallback checkbox — every one of them something to
    // read before anything could be done, and one of them the reason nothing
    // could be.
    for (const gone of [/\d · /, /detail roll/i, /summary only/i, /Read the slip/i, /Shoot/]) {
      expect(code, `${gone} belongs to the screen this replaced`).not.toMatch(gone);
    }
  });

  it("says recorded or why not, and no figure either way", () => {
    // Pinned here as copy as well as in captureOnly.test.js as fields: the
    // manager is never shown what the slip said, only whether it landed.
    for (const gone of [/variance/i, /confidence/i, /expected/i, /R\$\{/]) {
      expect(code, `${gone} is the owner's business, on his own reports tab`).not.toMatch(gone);
    }
  });
});

describe("the payload pre-flight", () => {
  it("lets a normal capture through", () => {
    const photos = Array.from({ length: 7 }, () => ({ base64: "x".repeat(600 * 1024) }));
    expect(payloadRefusal(photos)).toBeNull();
  });

  it("refuses an oversized one with a sentence, not a transport error", () => {
    const photos = Array.from({ length: 7 }, () => ({ base64: "x".repeat(1_400_000) }));
    const refusal = payloadRefusal(photos);
    expect(refusal).toMatch(/too much to send/i);
    expect(refusal, "it must say what to do").toMatch(/Remove a section/);
    expect(refusal, "and how big it actually was").toMatch(/9\.[0-9]MB/);
  });

  it("sits under the callable's own 10MB ceiling, with room for the rest of the request", () => {
    expect(MAX_PAYLOAD_BYTES).toBeLessThan(10 * 1024 * 1024);
  });

  it("is applied before the call, on the downscaled photo", () => {
    // After the downscale, not before it: refusing the file a phone camera
    // produced would refuse every capture, since that file is the reason the
    // downscale exists.
    const from = code.indexOf("const onPick =");
    const body = code.slice(from, code.indexOf("\n  };", from));
    expect(body).toMatch(/payloadRefusal\(\[photo\]\)/);
    expect(body.indexOf("downscalePhoto"), "…and after it")
      .toBeLessThan(body.indexOf("payloadRefusal"));
  });

  it("counts nothing as nothing", () => {
    expect(payloadRefusal([])).toBeNull();
    expect(payloadRefusal(null)).toBeNull();
  });
});

describe("what must NOT have changed behind the upload", () => {
  // The rebuild is presentation. Everything the callable is told, and every
  // refusal it can answer with, is the same — so the parts of the request that
  // decide what gets recorded are pinned here.
  it("the till that was tapped is what the slip is checked against", () => {
    expect(code).toMatch(/pickedTid: tid/);
    expect(code, "the server rejects a slip whose printed TID is not this one — never overridden here")
      .not.toMatch(/pickedTid: (?!tid)/);
  });

  it("one photo is still declared summary-only", () => {
    // The old screen sent `summaryOnly || detailPhotos.length === 0`, so a
    // single-photo capture was flagged summary-only either way. The record
    // still carries the server's warning that no line match can run for it.
    expect(code).toMatch(/summaryOnly: true/);
  });

  it("extract then submit, with the draft the server parked", () => {
    expect(code).toMatch(/action: "extract"/);
    expect(code).toMatch(/action: "submit", draftId: data\.draftId/);
    expect(code, "the client never invents a draft id").not.toMatch(/draftId: [^d]/);
  });

  it("BOTH calls are unwrapped from the callable's envelope", () => {
    // A callable resolves to { data }. Reading `.ok` off the envelope makes
    // every submit look refused, with an undefined reason — an empty red box
    // that says nothing about a slip that was in fact recorded. Caught by
    // driving the real screen; pinned here because the two calls are written
    // differently and only one of them was wrong.
    expect([...code.matchAll(/await cardBatchCaptureFn\(/g)],
      "extract and submit, and nothing else calls it").toHaveLength(2);
    expect([...code.matchAll(/\{ data[^}]*\} = await cardBatchCaptureFn/g)],
      "both results must be destructured").toHaveLength(2);
  });

  it("a capture that succeeded ticks the card, and is remembered for the day", () => {
    // The tick for the hand-captured till is this app's only record of it —
    // /card_batches is owner-only and unreadable here — so losing this write
    // means a manager who captured PE Till 1 sees an untouched card and
    // photographs it again.
    const from = code.indexOf("const send =");
    const body = code.slice(from, code.indexOf("\n  };", from));
    expect(body).toMatch(/rememberHandCapture\(tid, today\)/);
    expect(body, "…and the screen ticks without waiting for a reload")
      .toMatch(/setMine\(\(prev\) => new Set\(prev\)\.add\(tid\)\)/);
  });

  it("a refusal never renders as an empty box", () => {
    expect(code).toMatch(/const reasonOf = /);
    expect(code, "every refusal path goes through it")
      .not.toMatch(/reason: (data|done)\.reason/);
  });

  it("a refusal is shown verbatim, and a duplicate can still be corrected", () => {
    // `correction` is the only way to replace a batch already recorded, and it
    // keeps both records. Losing it would leave a bad capture permanent.
    expect(code).toMatch(/phase: "failed", reason: reasonOf\(data\)/);
    expect(code).toMatch(/already captured\|resubmit as a correction/);
    // …and the words matched are the server's own, so a re-word there is
    // caught here rather than at a till.
    const server = readFileSync(resolve(here, "../../../functions/lib/card-recon.cjs"), "utf8");
    expect(server, "the duplicate refusal still says one of them").toMatch(/already captured|resubmit as a correction/);
    expect(code).toMatch(/correction/);
  });
});
