// ─── THE LANE'S PAGED READ, AGAINST THE REAL QUERY BUILDER ───────────────────
// This file exists because a mock hid a crash. The view's tests stub the whole
// store, so `loadProposalPage` was never CONSTRUCTED during a test — and the
// first version built `query(…equalTo("awaiting"), startAfter(null, key), …)`,
// which throws at runtime on every page after the first:
//
//   equalTo: Starting point was already set (by another call to startAt/
//   startAfter or equalTo).
//
// `equalTo(v)` is not a separate operator — @firebase/database expands it to
// startAt(v, key) + endAt(v, key). So the only supported cursor inside an
// equal set is equalTo's own optional key argument.
//
// These tests therefore use the REAL firebase/database query builder (only the
// network `get` is faked), so an illegal combination throws here instead of in
// Junid's hands.
//
// AND THAT WAS STILL NOT ENOUGH. The second version used `equalTo(v, key)` as
// the cursor, these tests asserted the query PARAMS it produced, and they all
// passed — because the params were exactly what I intended. What I intended was
// wrong: `equalTo(v, k)` expands to startAt(v,k) + endAt(v,k), pinning BOTH
// ends to one key, so a "page" after the first held a single record and the
// walk stopped. Measured against the live node: 300 of 1,375 rows, and the lane
// would have reported no more names with a thousand still waiting.
//
// The lesson is in the last test: assert the RANGE, not just the start. A test
// that only pins what you meant cannot tell you that you meant the wrong thing.
import { describe, it, expect, vi, beforeEach } from "vitest";

let captured = null;   // the query the store built
let serverPage = [];   // [ [key, value], … ] the fake server returns, in order

// A REAL Database instance. No network is touched — `get` is faked below —
// but query() needs a genuine Query to attach its params to, and a stub object
// is exactly what let the illegal query through in the first place.
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
const realApp = initializeApp(
  { databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" },
  "proposalPagingTest",
);
const realDb = getDatabase(realApp);
vi.mock("../../firebase", () => ({
  get database() { return realDb; },
  auth: { currentUser: { uid: "u1" } },
}));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1755000000000 }));

// Only `ref` and `get` are faked. query/orderByChild/equalTo/limitToFirst are
// the REAL ones — that is the whole point.
vi.mock("firebase/database", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    child: () => ({}),
    runTransaction: () => Promise.resolve({ committed: false, snapshot: { val: () => null } }),
    get: (q) => {
      captured = q;
      const rows = serverPage;
      return Promise.resolve({
        forEach(cb) { for (const [key, val] of rows) cb({ key, val: () => val }); },
      });
    },
  };
});

const { loadProposalPage, PROPOSAL_PAGE_SIZE } = await import("./shopifyPublishStore");

// What the real builder recorded, so the test can assert the SHAPE rather than
// trusting that "it didn't throw" means "it was right".
const params = () => captured._queryParams;

beforeEach(() => { captured = null; serverPage = []; });

describe("loadProposalPage — the query it actually builds", () => {
  it("first page: the whole awaiting range, with a server-side limit and no cursor", () => {
    serverPage = [["p1", { state: "awaiting" }]];
    return loadProposalPage({ pageSize: 2 }).then(() => {
      expect(params().getIndexStartValue()).toBe("awaiting");
      expect(params().getIndexEndValue()).toBe("awaiting");
      expect(params().getLimit()).toBe(2);          // bounded BY THE SERVER
      expect(params().getIndexStartName()).toBe("[MIN_NAME]");
      expect(params().getIndexEndName()).toBe("[MAX_NAME]");
    });
  });

  it("a continued page starts at the cursor and still ends at the END of the range", () => {
    serverPage = [["p7", { state: "awaiting" }], ["p8", { state: "awaiting" }]];
    return loadProposalPage({ after: "p7", pageSize: 2 }).then(() => {
      expect(params().getIndexStartValue()).toBe("awaiting");
      expect(params().getIndexStartName()).toBe("p7");   // the cursor
      expect(params().getLimit()).toBe(3);               // pageSize + the overlap
      // THE ASSERTION THAT WOULD HAVE CAUGHT IT. equalTo(v, key) pins the END
      // to the cursor too, making the page one record long and the walk stop
      // after page 1. The end must stay at the top of the range.
      expect(params().getIndexEndValue()).toBe("awaiting");
      expect(params().getIndexEndName()).toBe("[MAX_NAME]");
    });
  });

  it("drops the inclusive overlap record so a page is never delivered twice", async () => {
    serverPage = [["p7", { state: "awaiting" }], ["p8", { state: "awaiting" }], ["p9", { state: "awaiting" }]];
    const { nodes, lastKey } = await loadProposalPage({ after: "p7", pageSize: 2 });
    expect(Object.keys(nodes)).toEqual(["p8", "p9"]);   // p7 was already delivered
    expect(lastKey).toBe("p9");
  });

  it("a short page is the end", async () => {
    serverPage = [["p1", {}]];
    expect((await loadProposalPage({ pageSize: 5 })).done).toBe(true);
  });

  it("a FULL page is not the end", async () => {
    serverPage = [["p1", {}], ["p2", {}]];
    expect((await loadProposalPage({ pageSize: 2 })).done).toBe(false);
  });

  it("a continued page holding ONLY the overlap is the end, not an empty page forever", async () => {
    // The regression this guards: judging `done` on the records KEPT rather
    // than the records RETURNED. A last page that is nothing but the cursor
    // keeps zero records — and "kept < pageSize" would be true, which is
    // right by luck; but a FULL page of records where every one is the
    // overlap would read as "more to come" for ever. Judge on what came back.
    serverPage = [["p7", {}]];
    const r = await loadProposalPage({ after: "p7", pageSize: 2 });
    expect(r.nodes).toEqual({});
    expect(r.done).toBe(true);
  });

  it("the default page size is bounded, not the whole node", () => {
    expect(PROPOSAL_PAGE_SIZE).toBeGreaterThan(0);
    expect(PROPOSAL_PAGE_SIZE).toBeLessThanOrEqual(500);
  });
});
