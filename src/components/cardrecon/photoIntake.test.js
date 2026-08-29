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

describe("where the frames may come from", () => {
  it("neither upload restricts the picker to the camera", () => {
    // `capture="environment"` makes the OS open the camera and NOTHING else.
    // Without it a manager can shoot the whole roll in the Photos app first and
    // pick the frames afterwards, which is how a long roll actually gets
    // photographed.
    expect(code).not.toMatch(/capture=/);
  });

  // Slice each file input from `<input` to its self-closing `/>`. A regex over
  // `[^>]*` cannot do it: `disabled={x >= y}` and `=>` both carry a `>`.
  const fileInputs = () =>
    [...code.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0]).filter((t) => /type="file"/.test(t));

  it("…and the stripper this file relies on has not eaten the inputs", () => {
    // The guard for the bug above: if comment-stripping ever mangles the source
    // again, every other assertion here goes quietly green.
    expect(code).toContain('type="file"');
    expect(fileInputs(), "all three file inputs must survive stripping — PDF, roll, summary")
      .toHaveLength(3);
    expect(code, "a real comment must still be gone").not.toContain("the OS opens the camera");
  });

  it("but the two PHOTO uploads still accept images only", () => {
    const photoInputs = fileInputs().filter((t) => /setDetailPhotos|setSummaryPhotos/.test(t));
    expect(photoInputs).toHaveLength(2);
    for (const tag of photoInputs) expect(tag).toMatch(/accept="image\/\*"/);
  });

  it("the detail roll takes several frames; the summary takes one", () => {
    const inputs = fileInputs();
    const detail = inputs.find((t) => /setDetailPhotos/.test(t));
    const summary = inputs.find((t) => /setSummaryPhotos/.test(t));
    expect(detail, "the roll is shot in sections").toMatch(/\bmultiple\b/);
    expect(summary, "one slot — `multiple` would invite a pick the cap then drops")
      .not.toMatch(/\bmultiple\b/);
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

  it("every file the plan takes is put through it — no branch skips a source", () => {
    expect(code).toMatch(/for \(const f of take\) prepared\.push\(await downscalePhoto\(f\)\)/);
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

  it("the screen passes a FUNCTION to the setter, never an array", () => {
    expect(code).toMatch(/setter\(mergeIntake\(/);
    expect(code, "an array write here is the bug this section is about")
      .not.toMatch(/setter\(\[/);
  });

  it("and BOTH pickers are disabled while a decode is in flight", () => {
    // "somewhere in the file" is not enough: with only the summary button
    // guarded, this passed while the detail roll — the one that takes six
    // frames and so is by far the likeliest to be re-tapped mid-decode — was
    // wide open. A mutation proved it.
    // Both photo pickers gate on `preparing`, and both also gate on a PDF
    // being attached — the predicates differ, so match the shared prefix.
    expect([...code.matchAll(/disabled=\{!!pdfFile \|\| preparing > 0/g)],
      "both the detail and summary pickers must be disabled while decoding").toHaveLength(2);
    expect(code, "and the file line while reading").toMatch(/disabled=\{hasPhotos \|\| preparing > 0\}/);
    expect(code).toMatch(/Preparing photos/);
  });
});

describe("the copy matches what the buttons now do", () => {
  it("no instruction still says only SHOOT, now that choosing is allowed", () => {
    // The buttons say "Shoot or choose"; a hint that says "Shoot the detail
    // roll" quietly contradicts them and sends a manager back to the camera.
    // Found by probing the deployed bundle for the old label and getting a hit.
    // Per SENTENCE, not per word: "Shoot it here or pick it from your photos"
    // is fine, "Shoot the detail roll" is not. A bare word-match flagged the
    // correct copy and had to be replaced.
    // Split on sentence ends WITHOUT a lookbehind — a lookbehind is a
    // parse-time SyntaxError on Safari below 16.4 and the repo-wide guard
    // (noLookbehind.test.js) refuses one anywhere under src/, test files
    // included. Matching whole sentences does the same job.
    const sentences = code.match(/[^.!?\n]+[.!?]?/g) || [];
    const cameraOnly = sentences
      .filter((t) => /\bShoot\b/.test(t))
      .filter((t) => !/\b(choose|pick)\b/i.test(t))
      .map((t) => t.trim().slice(0, 60));
    expect(cameraOnly, `these still assume the camera: ${cameraOnly.join(" | ")}`).toEqual([]);
    // …and the alternative is actually offered somewhere, so this cannot pass
    // by the copy having been deleted rather than fixed.
    expect(code).toMatch(/Shoot or choose/);
  });
});

describe("the PDF path", () => {
  it("is the FIRST input, above both photo uploads", () => {
    const order = ["2 · The PDF", "3 · The detail roll", "4 · The summary"]
      .map((label) => code.indexOf(label));
    expect(order.every((i) => i > -1), "all three sections must exist").toBe(true);
    expect(order, "the PDF line comes first").toEqual([...order].sort((a, b) => a - b));
  });

  it("is one compact line, not a drop area like the photo uploads", () => {
    // The photo uploads use the full-width primary button (S.btn); the file
    // line uses the small ghost one with an auto width. If it ever grows into
    // a third drop area it stops being the quick path it exists to be.
    const pdfBlock = code.slice(code.indexOf("2 · The PDF"), code.indexOf("3 · The detail roll"));
    expect(pdfBlock).toMatch(/S\.btnGhost/);
    expect(pdfBlock, "the big primary button belongs to the photo uploads").not.toMatch(/\.\.\.S\.btn,/);
    expect(pdfBlock).toMatch(/Add file/);
  });

  it("accepts PDFs only", () => {
    const pdfInput = [...code.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0]).find((t) => /addPdf/.test(t));
    expect(pdfInput).toBeTruthy();
    expect(pdfInput).toMatch(/accept="application\/pdf,\.pdf"/);
    expect(pdfInput, "one file — a PDF is the whole slip").not.toMatch(/\bmultiple\b/);
  });

  it("ONE PATH: a PDF clears the photos, and photos disable the file line", () => {
    // Enforced here AND in the callable, which refuses a request carrying both.
    expect(code, "attaching a PDF clears anything photographed").toMatch(/setDetailPhotos\(\[\]\); setSummaryPhotos\(\[\]\)/);
    expect(code, "the file button is disabled once photos exist").toMatch(/disabled=\{hasPhotos \|\| preparing > 0\}/);
    expect(code, "the detail picker is disabled once a PDF exists").toMatch(/disabled=\{!!pdfFile \|\| preparing > 0 \|\| detailPhotos\.length/);
    expect(code, "the summary picker too").toMatch(/disabled=\{!!pdfFile \|\| preparing > 0\}/);
  });

  it("a PDF needs no summary photo to proceed", () => {
    // The photo path requires a summary and either a roll or the summary-only
    // tick. A PDF is the whole slip and requires neither.
    expect(code).toMatch(/pdfFile\s*\?\s*false/);
  });

  it("summary-only is not offered on the PDF path", () => {
    // A PDF with lines is never linesCaptured:false, so the tick would be a
    // way to record a worse capture than the file actually contains.
    expect(code).toMatch(/detailPhotos\.length === 0 && !pdfFile &&/);
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

  it("is applied to BOTH paths, before the call", () => {
    expect(code).toMatch(/payloadRefusal\(pdfFile \? \[pdfFile\] : photos\)/);
    expect(code, "and to the PDF as it is read, so an oversized file is caught at pick time")
      .toMatch(/payloadRefusal\(\[\{ base64 \}\]\)/);
  });

  it("counts nothing as nothing", () => {
    expect(payloadRefusal([])).toBeNull();
    expect(payloadRefusal(null)).toBeNull();
  });
});

describe("what must NOT have changed", () => {
  it("the two uploads are still separate — detail roll and summary", () => {
    expect(code).toMatch(/setDetailPhotos/);
    expect(code).toMatch(/setSummaryPhotos/);
    expect(code, "the summary-only fallback still exists").toMatch(/summaryOnly/);
  });

  it("summary-only is still driven by an empty detail roll", () => {
    // The server records linesCaptured:false from this; the client must keep
    // telling it the truth about whether a roll was shot.
    expect(code).toMatch(/summaryOnly: summaryOnly \|\| detailPhotos\.length === 0/);
  });
});

describe("starting over leaves nothing of the last slip behind", () => {
  // The comment-STRIPPED source: the explanatory comment above reset names
  // every setter, and matching that would pass with the code removed.
  const screen = code;

  it("reset clears the PDF as well as the photos", () => {
    // A retained pdfFile meant "Capture another slip" would re-submit the
    // PREVIOUS terminal's report against a freshly picked till — the wrong
    // figures, against the wrong person's name.
    const body = screen.slice(screen.indexOf("const reset ="), screen.indexOf("const reset =") + 400);
    expect(body, "reset must clear the picked till").toMatch(/setTid\(null\)/);
    expect(body, "reset must clear the detail roll").toMatch(/setDetailPhotos\(\[\]\)/);
    expect(body, "reset must clear the summary").toMatch(/setSummaryPhotos\(\[\]\)/);
    expect(body, "reset must clear the PDF").toMatch(/setPdfFile\(null\)/);
  });

  it("every piece of capture state reset holds is cleared by it", () => {
    // Named individually above; counted here so the NEXT input added to this
    // screen cannot quietly skip reset the way the PDF one did.
    const setters = new Set(
      (screen.match(/const \[[a-zA-Z]+, (set[A-Za-z]+)\]/g) || [])
        .map((m) => m.replace(/.*(set[A-Za-z]+).*/, "$1")),
    );
    const captureState = ["setTid", "setDetailPhotos", "setSummaryPhotos", "setSummaryOnly", "setPdfFile"];
    for (const s of captureState) {
      expect(setters.has(s), `${s} is no longer a state setter on this screen — update this list`).toBe(true);
    }
    const body = screen.slice(screen.indexOf("const reset ="), screen.indexOf("const reset =") + 400);
    const missed = captureState.filter((s) => !body.includes(s));
    expect(missed, `reset does not clear: ${missed.join(", ")}`).toEqual([]);
  });
});
