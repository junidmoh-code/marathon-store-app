// ─── THE SOCIAL CARD AND THE LISTS RTDB CANNOT STORE ─────────────────────────
// The card blanked out to the screen error boundary in production with
// "null is not an object (evaluating 's.some')". Two separate defects sit
// behind that class of failure and both are pinned here:
//
//   1. A list read back as null / absent / an object-keyed map, and used
//      directly. RTDB cannot store an empty array — writing [] deletes the
//      key, and so does removing a list's last child.
//   2. `posts.some(...)` running on the FIRST render, when `posts` is still
//      the useState(null) that means "not loaded yet". That is the one that
//      actually took the card down, and it needed no bad record at all.
//
// THE FAKE DATABASE REPRODUCES RTDB, NOT A CONVENIENT VERSION OF IT.
// update({tags: []}) DELETES the key here, exactly as the real thing does,
// and removing a list's last child leaves the parent ABSENT. A fake that
// politely handed back [] would pass every one of these tests while the
// product went on crashing.
import { test, expect, vi, beforeEach } from "vitest";
import { create, act } from "react-test-renderer";
import RowBoundary from "./RowBoundary";

// ── THE FAKE ─────────────────────────────────────────────────────────────────
let store = {};
let updates = [];
// Lets one test make a read fail the way a missing rule does.
let readShouldThrow = null;

const at = (path) => path.split("/").filter(Boolean);
function readPath(p) {
  let cur = store;
  for (const seg of at(p)) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[seg]; }
  return cur;
}
/** RTDB's actual write semantics: empty array / empty object / null DELETES. */
function isDeletion(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}
function writePath(p, value) {
  const segs = at(p);
  const last = segs.pop();
  let cur = store;
  for (const seg of segs) { if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {}; cur = cur[seg]; }
  if (isDeletion(value)) {
    delete cur[last];
    // …and a parent left with no children disappears too, which is how a list
    // becomes ABSENT rather than empty.
    if (segs.length && Object.keys(cur).length === 0) writePath(segs.join("/"), null);
    return;
  }
  cur[last] = value;
}

vi.mock("../../firebase", () => ({
  database: {}, storage: {}, functions: {},
  auth: { currentUser: { uid: "u1", email: "j@x" } },
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1_700_000_000_000 }));
vi.mock("firebase/storage", () => ({
  ref: (_s, path) => ({ path }),
  uploadBytes: async () => ({}),
  getDownloadURL: async (r) => `https://example/${r.path}`,
  deleteObject: async () => {},
}));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  query: (r) => r,
  orderByChild: () => ({}),
  equalTo: (v) => ({ v }),
  startAt: () => ({}),
  endAt: () => ({}),
  limitToLast: () => ({}),
  push: (r) => ({ path: `${r.path}/newid`, key: "newid" }),
  get: async (r) => {
    if (readShouldThrow) throw readShouldThrow;
    return { val: () => readPath(r.path) ?? null };
  },
  update: async (r, fields) => {
    // Every payload is recorded. The RESULT of an empty-array write and an
    // explicit-null write is identical in the database — both delete the key —
    // so asserting on the store cannot tell the two apart. The contract this
    // branch added is about the PAYLOAD: nothing bare goes into update().
    updates.push({ path: r.path, fields });
    for (const [k, v] of Object.entries(fields)) writePath(`${r.path}/${k}`, v);
  },
  remove: async (r) => writePath(r.path, null),
}));

import {
  loadPostsByStatus, loadRefPage, addStyleRef, editStyleRef, createManualPost, mergeRefPage,
  retryPost,
} from "./socialStore";

const POST = (over = {}) => ({
  status: "draft", kind: "single", caption: "a caption long enough to pass", createdAt: 1,
  platforms: { instagram: true }, media: [{ url: "u", type: "image" }], products: ["p1"], ...over,
});

beforeEach(() => { store = {}; updates = []; readShouldThrow = null; });

/** The value a given field was actually handed to update(). */
const sentField = (name) => {
  const hit = [...updates].reverse().find((u) => Object.prototype.hasOwnProperty.call(u.fields, name));
  return hit ? hit.fields[name] : undefined;
};

// ── 1. A RECORD WHOSE LIST KEY IS ABSENT ─────────────────────────────────────
test("a post whose products key was never written reads back as an array", async () => {
  const p = POST();
  delete p.products;
  store.social_posts = { a: p };
  const { posts } = await loadPostsByStatus("draft");
  expect(posts[0].products).toEqual([]);
  expect(() => posts[0].products.some(Boolean)).not.toThrow();
});

test("a style reference whose tags key is absent reads back as an array", async () => {
  // This is the LIVE shape: all six references in /social_style_refs have no
  // tags key, because parseTags("") returned [] and the write dropped it.
  store.social_style_refs = { r1: { url: "u", addedAt: 5, type: "image" } };
  const { refs } = await loadRefPage({});
  expect(refs[0].tags).toEqual([]);
});

// ── 2. A LIST EMPTIED BY DELETING ITS LAST CHILD ─────────────────────────────
test("removing a list's last child leaves the key ABSENT, and the read still gives an array", async () => {
  store.social_posts = { a: POST({ media: [{ url: "u1", type: "image" }] }) };
  // The real deletion path: the last child goes, and RTDB drops the parent.
  writePath("social_posts/a/media/0", null);
  expect(readPath("social_posts/a/media")).toBeUndefined();   // the fake behaves like RTDB
  const { posts } = await loadPostsByStatus("draft");
  expect(posts[0].media).toEqual([]);
  expect(() => posts[0].media.map((m) => m.url)).not.toThrow();
});

test("clearing every tag stores an explicit null instead of a silently dropped []", async () => {
  store.social_style_refs = { r1: { url: "u", addedAt: 5, tags: ["moody"] } };
  await editStyleRef("r1", { tags: "" });
  expect(readPath("social_style_refs/r1/tags")).toBeUndefined();
  expect(readPath("social_style_refs/r1/url")).toBe("u");      // nothing else disturbed
  const { refs } = await loadRefPage({});
  expect(refs[0].tags).toEqual([]);
});

test("a new reference with no tags does not lose its other fields to the empty list", async () => {
  const res = await addStyleRef({ name: "a.jpg", type: "image/jpeg", size: 10 }, { note: "n", tags: "" });
  expect(res.ok).toBe(true);
  const body = readPath(`social_style_refs/${res.refId}`);
  expect(body.note).toBe("n");
  expect(body.tags).toBeUndefined();
});

test("an empty tag list goes into update() as an EXPLICIT null, never a bare []", async () => {
  // The database deletes the key either way, so this is the only assertion
  // that can tell a deliberate deletion from an accident. Mutation-proved:
  // reverting addStyleRef to a bare parseTags() kills this test and nothing
  // else, which is why it exists.
  const res = await addStyleRef({ name: "a.jpg", type: "image/jpeg", size: 10 }, { note: "n", tags: "" });
  expect(res.ok).toBe(true);
  expect(sentField("tags")).toBe(null);
  expect(Array.isArray(sentField("tags"))).toBe(false);
});

test("clearing tags on an existing reference sends null, not []", async () => {
  store.social_style_refs = { r1: { url: "u", addedAt: 5, tags: ["moody"] } };
  await editStyleRef("r1", { tags: "" });
  expect(sentField("tags")).toBe(null);
});

test("a tag list that still has tags is sent as a real array", async () => {
  store.social_style_refs = { r1: { url: "u", addedAt: 5 } };
  await editStyleRef("r1", { tags: "moody, flat lay" });
  expect(sentField("tags")).toEqual(["moody", "flat lay"]);
});

test("a hand-made post sends products as null and media as a real array", async () => {
  await createManualPost({
    media: [{ url: "u", type: "image" }], caption: "a caption long enough", platforms: { instagram: true },
  });
  expect(sentField("products")).toBe(null);
  expect(sentField("media")).toEqual([{ url: "u", type: "image" }]);
});

test("a hand-made post has no products, and that costs it nothing else", async () => {
  const res = await createManualPost({
    media: [{ url: "u", type: "image" }], caption: "a caption long enough", platforms: { instagram: true },
  });
  expect(res.ok).toBe(true);
  expect(readPath("social_posts/newid/products")).toBeUndefined();
  expect(readPath("social_posts/newid/status")).toBe("draft");
});

// ── 3. AN OBJECT-MAP-SHAPED VALUE ────────────────────────────────────────────
test("a media list stored as a sparse object map reads back as a list, in NUMERIC order", async () => {
  store.social_posts = {
    a: POST({ media: { 10: { url: "eleventh" }, 2: { url: "third" }, 0: { url: "first" } } }),
  };
  const { posts } = await loadPostsByStatus("draft");
  // Not ["eleventh", "first", "third"] — RTDB sorts keys as strings, and taking
  // that order would silently reorder the pictures on a live Instagram post.
  expect(posts[0].media.map((m) => m.url)).toEqual(["first", "third", "eleventh"]);
});

test("object-map tags survive the trip through the library merge", async () => {
  store.social_style_refs = { r1: { url: "u", addedAt: 5, tags: { 0: "flat lay", 1: "moody" } } };
  const { refs } = await loadRefPage({});
  expect(refs[0].tags).toEqual(["flat lay", "moody"]);
  expect(mergeRefPage(null, refs)[0].tags).toEqual(["flat lay", "moody"]);
});

test("mergeRefPage survives a null held list and a null page", () => {
  expect(mergeRefPage(null, null)).toEqual([]);
  expect(mergeRefPage(undefined, [{ id: "a", addedAt: 1 }])).toHaveLength(1);
});

// ── 4. THE CRASH ITSELF: .some ON THE FIRST RENDER ───────────────────────────
// No malformed record is involved. `posts` is useState(null) and the line ran
// before any fetch resolved, so the card died on every single open.
test("the queue renders before any post has loaded, without throwing", async () => {
  const SocialView = (await import("./SocialView.jsx")).default;
  store.social_posts = {};
  let tree;
  // A SYNCHRONOUS act, deliberately: it renders and stops, without flushing the
  // pending fetch, so what is asserted is the very render in which `posts` is
  // still the useState(null). That is the render that threw in production, and
  // an `await act(async () => ...)` here would have resolved the load first and
  // sailed straight past the bug.
  act(() => { tree = create(<SocialView products={[]} onExit={() => {}} />); });
  expect(JSON.stringify(tree.toJSON())).toContain("Loading");
  await act(async () => {});     // now let it settle, and confirm it survives that too
  expect(JSON.stringify(tree.toJSON())).toContain("Nothing here");
  tree.unmount();
});

// ── 5. THE BLAST RADIUS ──────────────────────────────────────────────────────
// Proved on RowBoundary directly with a child that throws, rather than on a
// record the queue happens to survive today. The question this answers is not
// "does this record crash" — it is "when SOMETHING crashes, how much of the
// screen goes with it", and the answer must be: that row.
test("a row that throws is contained — its siblings render, and it offers a way out", () => {
  const Boom = () => { throw new Error("null is not an object (evaluating 's.some')"); };
  const Fine = ({ label }) => <div>{label}</div>;
  let cleared = null;
  let tree;
  // React logs the caught error; silence it so the run stays readable.
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  act(() => {
    tree = create(
      <div>
        <RowBoundary recordId="post-a" label="post"><Fine label="row before" /></RowBoundary>
        <RowBoundary recordId="post-bad" label="post" actionLabel="Discard it" onAction={() => { cleared = "post-bad"; }}>
          <Boom />
        </RowBoundary>
        <RowBoundary recordId="post-c" label="post"><Fine label="row after" /></RowBoundary>
      </div>
    );
  });
  const text = JSON.stringify(tree.toJSON());
  expect(text).toContain("row before");
  expect(text).toContain("row after");                       // one bad row, not the list
  // The heading is JSX with the label interpolated, so it arrives as three
  // adjacent children rather than one string.
  expect(text).toContain('"This ","post"," couldn\'t be shown"');
  expect(text).toContain("post-bad");                        // it names itself
  expect(text).toContain("evaluating 's.some'");             // and says what threw
  expect(text).toContain("Discard it");

  // The affordance actually runs the caller's action.
  const btn = tree.root.findAll((n) => n.type === "button" && n.children[0] === "Discard it")[0];
  act(() => { btn.props.onClick(); });
  expect(cleared).toBe("post-bad");
  spy.mockRestore();
  tree.unmount();
});

test("one malformed post is one broken row — the rest of the queue still renders", async () => {
  const SocialView = (await import("./SocialView.jsx")).default;
  store.social_posts = {
    good: POST({ createdAt: 2, caption: "the good one, long enough" }),
    // `kind` is read via postKind(); a media entry that is not an object is
    // what a half-written record looks like, and Cover reaches into it.
    bad: POST({ createdAt: 1, media: [null], caption: "the bad one, long enough" }),
  };
  let tree;
  await act(async () => { tree = create(<SocialView products={[]} onExit={() => {}} />); });
  await act(async () => {});
  const text = JSON.stringify(tree.toJSON());
  // Whatever happens to the bad row, the good one is on screen and the card is
  // not the error boundary.
  expect(text).toContain("the good one");
  tree.unmount();
});

// ── 6. RETRY MUST NOT RESURRECT A STALE RESULT ───────────────────────────────
// update() REPLACES the child it is given, so writing the whole `results`
// object back swaps the live subtree for whatever the browser last loaded. The
// queue polls only while something is due and unclaimed, so the tab's copy goes
// stale the moment the Mac mini writes a result — and a stale "sending" written
// over a live "ok" is a duplicate public Instagram post on the next run.
test("retry reads results from the DATABASE, not from the screen's stale copy", async () => {
  // What the screen loaded: a failed post, both platforms ERRORED.
  //
  // "errored" and not "sending", and that is the whole test. retryPost skips a
  // "sending" entry either way, so a stale-vs-live difference between two
  // "sending"s changes nothing and the test proved nothing — it passed against
  // the very mutation it was named for. Caught by review, and worth writing
  // down: the mutation proof still reported that guard KILLED, truthfully,
  // because two OTHER tests caught it. A guard covered by accident reads
  // exactly like a guard covered on purpose unless you check which test failed.
  //
  // Errored is also the more faithful story: the screen says the post failed,
  // which is precisely when a person reaches for Retry.
  const stale = POST({
    status: "failed",
    results: { instagram: { state: "error", attempts: 2 }, facebook: { state: "error", attempts: 2 } },
  });
  // A DEEP copy, and it is load-bearing: `{ ...stale }` shares the `results`
  // object by reference, and writePath mutates it in place — so the "stale"
  // caller copy would quietly agree with the database and there would be no
  // staleness left to test.
  store.social_posts = { a: JSON.parse(JSON.stringify(stale)) };
  // What the publisher has since confirmed, straight into the database.
  writePath("social_posts/a/results/instagram", { state: "ok", id: "IG123" });
  writePath("social_posts/a/results/facebook", { state: "ok", id: "FB456" });

  // Junid taps Retry while still looking at the old screen.
  const res = await retryPost("a", stale);
  expect(res.ok).toBe(true);

  // Both confirmed sends survive. Trusting the screen's copy would have DELETED
  // both — they read "error" there — and the next run, seeing two platforms
  // with no result, would have posted to both live accounts a second time.
  expect(readPath("social_posts/a/results/instagram")).toEqual({ state: "ok", id: "IG123" });
  expect(readPath("social_posts/a/results/facebook")).toEqual({ state: "ok", id: "FB456" });
  expect(readPath("social_posts/a/status")).toBe("draft");
});

test("retry clears ONLY the errored platform, by its own path", async () => {
  store.social_posts = {
    a: POST({
      status: "failed",
      results: {
        instagram: { state: "ok", id: "IG1" },
        facebook: { state: "error", error: "rate limited", attempts: 2 },
        tiktok: { state: "sending" },
      },
    }),
  };
  await retryPost("a", null);
  expect(readPath("social_posts/a/results/instagram")).toEqual({ state: "ok", id: "IG1" });
  expect(readPath("social_posts/a/results/tiktok")).toEqual({ state: "sending" });
  expect(readPath("social_posts/a/results/facebook")).toBeUndefined();
  // The parent is written per-path, never wholesale.
  const paths = updates.flatMap((u) => Object.keys(u.fields));
  expect(paths).toContain("results/facebook");
  expect(paths).not.toContain("results");
});

test("retry called with no in-memory post still protects the live results", async () => {
  // The exported signature allows retryPost(id) with no post. The old code then
  // saw {} and wrote results: null, deleting every "ok" it could not see.
  store.social_posts = { a: POST({ status: "failed", results: { instagram: { state: "ok" } } }) };
  await retryPost("a");
  expect(readPath("social_posts/a/results/instagram")).toEqual({ state: "ok" });
});

// ── 7. A ROW THAT RECOVERS STOPS SAYING IT IS BROKEN ─────────────────────────
test("RowBoundary clears its error when the record's data changes", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  let boom = true;
  const Child = () => { if (boom) throw new Error("half-written record"); return <div>recovered row</div>; };
  let tree;
  act(() => { tree = create(<RowBoundary recordId="p1" label="post" resetKey={1}><Child /></RowBoundary>); });
  expect(JSON.stringify(tree.toJSON())).toContain("couldn't be shown");

  // The record is refetched and is now whole. Same id, so the SAME boundary
  // instance — nothing remounts — but updatedAt moved.
  boom = false;
  act(() => { tree.update(<RowBoundary recordId="p1" label="post" resetKey={2}><Child /></RowBoundary>); });
  const after = JSON.stringify(tree.toJSON());
  expect(after).toContain("recovered row");
  expect(after).not.toContain("couldn't be shown");

  spy.mockRestore();
  tree.unmount();
});

test("RowBoundary keeps showing the error while the record has NOT changed", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const Child = () => { throw new Error("still broken"); };
  let tree;
  act(() => { tree = create(<RowBoundary recordId="p1" label="post" resetKey={1}><Child /></RowBoundary>); });
  act(() => { tree.update(<RowBoundary recordId="p1" label="post" resetKey={1}><Child /></RowBoundary>); });
  expect(JSON.stringify(tree.toJSON())).toContain("still broken");
  spy.mockRestore();
  tree.unmount();
});

test("a retry whose read is refused changes NOTHING and says so", async () => {
  store.social_posts = { a: POST({ status: "failed", results: { instagram: { state: "error" } } }) };
  readShouldThrow = new Error("PERMISSION_DENIED: Permission denied");
  const res = await retryPost("a", null);
  readShouldThrow = null;
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/refused this write/i);
  // Untouched: it must not clear a result it could not read.
  expect(readPath("social_posts/a/results/instagram")).toEqual({ state: "error" });
  // Still "failed": a refused read must not half-apply the transition either.
  expect(readPath("social_posts/a/status")).toBe("failed");
});

test("an illegal post id comes back as a sentence, not an unhandled rejection", async () => {
  // safeSeg throws. Hoisted out of the try it would escape the row's click
  // handler as an unhandled rejection instead of a message on screen.
  const res = await retryPost("bad/id", null);
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/illegal key/i);
});

// ── 8. THE RESET KEY HAS TO MOVE WHEN THE RECORD DOES ────────────────────────
// A boundary that clears on `updatedAt` looks right and is not. The Mac mini
// publisher writes results through `${POSTS}/${id}/results/${platform}` and
// never touches updatedAt — so the field most likely to have been malformed is
// exactly the one updatedAt is blind to. Style refs are worse: addedAt is
// written once, so editing a bad `tags` could never have cleared the row.
test("rowKey moves when a platform result changes, though updatedAt does not", async () => {
  store.social_posts = { a: POST({ updatedAt: 100, results: { instagram: { state: "sending", attempts: 1 } } }) };
  const before = (await loadPostsByStatus("draft")).posts[0];

  // Exactly what recordResult does: one platform path, updatedAt untouched.
  writePath("social_posts/a/results/instagram", { state: "ok", attempts: 1 });
  const after = (await loadPostsByStatus("draft")).posts[0];

  expect(after.updatedAt).toBe(before.updatedAt);   // the publisher did not move it
  expect(after.rowKey).not.toBe(before.rowKey);     // but the row knows it changed
});

test("rowKey moves when a style reference's tags are edited, though addedAt does not", async () => {
  store.social_style_refs = { r1: { url: "u", addedAt: 5, tags: ["bad"], enabled: true } };
  const before = (await loadRefPage({})).refs[0];
  await editStyleRef("r1", { tags: "fixed" });
  const after = (await loadRefPage({})).refs[0];
  expect(after.addedAt).toBe(before.addedAt);
  expect(after.rowKey).not.toBe(before.rowKey);
});

test("rowKey is STABLE when nothing about the record changed", async () => {
  store.social_posts = { a: POST({ updatedAt: 100 }) };
  const first = (await loadPostsByStatus("draft")).posts[0];
  const second = (await loadPostsByStatus("draft")).posts[0];
  // Otherwise every poll would clear a genuinely-broken row's error and the
  // boundary would churn instead of settling.
  expect(second.rowKey).toBe(first.rowKey);
});
