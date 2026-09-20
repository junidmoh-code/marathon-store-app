// ─── THE BOUNDED READ — DOES IT ACTUALLY BOUND, AND DOES IT GET EVERYTHING ───
// Two properties that pull against each other: the read must never ask for an
// unbounded node, and it must still come back with every child. A test for
// either one alone passes for a broken implementation of the other.
//
// The fake below is a real little query engine — it sorts by key, honours
// startAfter and limitToFirst, and hands back a snapshot whose forEach yields
// children in that order. A fake that ignored the constraints and returned
// everything would make the paging vacuous: the cursor could be wrong, or
// missing entirely, and every test here would still pass.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMock = vi.fn();
vi.mock("firebase/database", () => ({
  get: (...a) => getMock(...a),
  query: (node, ...constraints) => ({ node, constraints }),
  orderByKey: () => ({ kind: "orderByKey" }),
  limitToFirst: (n) => ({ kind: "limitToFirst", value: n }),
  startAfter: (v) => ({ kind: "startAfter", value: v }),
  startAt: (v) => ({ kind: "startAt", value: v }),
}));

const { readByKeyPages, PAGE_SIZE, MAX_PAGES } = await import("./pagedRead");

const NODE = { path: "users" };

/** A server holding `data`, answering orderByKey/startAfter/limitToFirst. */
const serve = (data) => {
  const requests = [];
  getMock.mockImplementation(async (q) => {
    requests.push(q.constraints);
    const limit = q.constraints.find((c) => c.kind === "limitToFirst");
    const after = q.constraints.find((c) => c.kind === "startAfter");
    const from = q.constraints.find((c) => c.kind === "startAt");
    if (!limit) throw new Error("unbounded read reached the server");
    // THE SERVER APPLIES THE LIMIT, then the SDK drops the excluded row.
    // That is why `startAfter(k) + limitToFirst(n)` yields n-1 children —
    // measured against production, 2026-09-20 — and why a pager that ends on
    // a short page ends on its second request. This fake reproduces it, so
    // that defect cannot come back silently.
    const all = Object.keys(data).sort();
    const keys = after
      ? all.filter((k) => k >= after.value).slice(0, limit.value).filter((k) => k > after.value)
      : all.filter((k) => (from ? k >= from.value : true)).slice(0, limit.value);
    return { forEach: (cb) => { for (const k of keys) if (cb({ key: k, val: () => data[k] })) return true; return false; } };
  });
  return requests;
};

const roster = (n) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`u${String(i).padStart(4, "0")}`, { i }]));

beforeEach(() => { getMock.mockReset(); });

describe("every request is bounded", () => {
  it("orders by key and limits, on the FIRST page", async () => {
    const reqs = serve(roster(3));
    await readByKeyPages(NODE);
    expect(reqs[0].map((c) => c.kind)).toEqual(["orderByKey", "limitToFirst"]);
  });

  it("and on every later page, which also carries a cursor", async () => {
    const reqs = serve(roster(25));
    await readByKeyPages(NODE, { pageSize: 10 });
    expect(reqs).toHaveLength(3);
    for (const r of reqs.slice(1)) {
      // startAt, not startAfter — see the module header. startAfter makes the
      // server return one fewer child than asked for, which turns "the page
      // came back short" into "we are done" on the second request.
      expect(r.map((c) => c.kind)).toEqual(["orderByKey", "startAt", "limitToFirst"]);
    }
    expect(reqs[1].find((c) => c.kind === "startAt").value).toBe("u0009");
    expect(reqs[2].find((c) => c.kind === "startAt").value).toBe("u0018");
  });

  it("the fake REFUSES an unbounded read — so the assertions above are not decorative", async () => {
    getMock.mockImplementation(async () => { throw new Error("unbounded read reached the server"); });
    await expect(readByKeyPages(NODE)).rejects.toThrow("unbounded");
  });
});

describe("and still returns everything", () => {
  it("stitches the pages back into one object, in key order", async () => {
    serve(roster(25));
    const { data, complete, pages } = await readByKeyPages(NODE, { pageSize: 10 });
    expect(Object.keys(data)).toHaveLength(25);
    expect(Object.keys(data)[0]).toBe("u0000");
    expect(data.u0024).toEqual({ i: 24 });
    expect(complete).toBe(true);
    expect(pages).toBe(3);
  });

  it("one page when the node fits in one page", async () => {
    const reqs = serve(roster(35));                 // the live roster's size
    const { data, complete, pages } = await readByKeyPages(NODE);
    expect(pages).toBe(1);
    expect(reqs).toHaveLength(1);
    expect(Object.keys(data)).toHaveLength(35);
    expect(complete).toBe(true);
  });

  it("an exactly-full last page still terminates, with one extra empty request", async () => {
    serve(roster(20));
    const { data, complete, pages } = await readByKeyPages(NODE, { pageSize: 10 });
    expect(Object.keys(data)).toHaveLength(20);
    expect(pages).toBe(3);
    expect(complete).toBe(true);
  });

  it("an empty node is complete, not an error", async () => {
    serve({});
    expect(await readByKeyPages(NODE)).toEqual({ data: {}, complete: true, pages: 1, lastKey: null });
  });
});

describe("truncation is reported, never passed off as the whole node", () => {
  it("says complete:false when the page budget runs out", async () => {
    serve(roster(100));
    const { data, complete, pages } = await readByKeyPages(NODE, { pageSize: 10, maxPages: 3 });
    // 10, then 9, then 9: one slot of every page after the first is the
    // inclusive bound re-sending the cursor's own row.
    expect(Object.keys(data)).toHaveLength(28);
    expect(pages).toBe(3);
    expect(complete, "a slice must never claim to be the whole roster").toBe(false);
  });

  it("the ceiling is finite by construction", async () => {
    expect(PAGE_SIZE * MAX_PAGES).toBeLessThanOrEqual(5000);
  });

  it("a server that never advances the cursor terminates instead of looping forever", async () => {
    // A misbehaving or misconfigured node that ignores the lower bound would
    // spin this loop until the budget ran out. It must stop the moment the
    // cursor stops moving FORWARD — the alternating case ("a","b" for ever,
    // with the bound landing on each in turn) is what a plain equality check
    // on the last key misses.
    getMock.mockImplementation(async () => ({
      forEach: (cb) => { for (const k of ["a", "b"]) if (cb({ key: k, val: () => 1 })) return true; return false; },
    }));
    const { data, complete } = await readByKeyPages(NODE, { pageSize: 2, maxPages: 50 });
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(data)).toEqual(["a", "b"]);
    expect(complete).toBe(true);
  });
});

// ── lastKey: the cursor a caller needs to follow the node forward ────────────
// Added for the /insights_log all-time reader, which pages the history and
// then tails from where the walk stopped. A walk that reported no cursor
// would leave the tail either re-reading the whole node or starting after
// nothing — both of which are the unbounded read this pager exists to avoid.
// ─── THE DEFECT THIS PAGER SHIPPED WITH ──────────────────────────────────────
//
// `startAfter(cursor) + limitToFirst(n)` comes back with n-1 children, every
// time. A pager that ends on "the page was short" ends on its SECOND request
// and reports complete: true holding a fraction of the node. Against
// /insights_log that was 19,999 rows out of 112,968, with three screens'
// all-time figures computed from the fraction.
describe("a node bigger than several pages is read WHOLE", () => {
  it("reads every child of a node many pages long", async () => {
    serve(roster(1000));
    const r = await readByKeyPages(NODE, { pageSize: 100, maxPages: 50 });
    expect(Object.keys(r.data).length).toBe(1000);
    expect(r.complete).toBe(true);
  });

  it("does not stop at the second page", async () => {
    const requests = serve(roster(1000));
    await readByKeyPages(NODE, { pageSize: 100, maxPages: 50 });
    expect(requests.length).toBeGreaterThan(2);
  });

  it("uses an INCLUSIVE lower bound, and skips the row it re-reads", async () => {
    const requests = serve(roster(300));
    const r = await readByKeyPages(NODE, { pageSize: 100, maxPages: 50 });
    // Every page after the first bounds with startAt, never startAfter.
    for (const cs of requests.slice(1)) {
      expect(cs.map((c) => c.kind)).toContain("startAt");
      expect(cs.map((c) => c.kind)).not.toContain("startAfter");
    }
    // …and no row is duplicated or lost by the re-read.
    expect(Object.keys(r.data).length).toBe(300);
  });

  it("still reports truncation when the budget genuinely runs out", async () => {
    serve(roster(1000));
    const r = await readByKeyPages(NODE, { pageSize: 100, maxPages: 3 });
    expect(r.complete).toBe(false);
    expect(Object.keys(r.data).length).toBeLessThan(1000);
  });
});

describe("readByKeyPages — the forward cursor", () => {
  it("reports the highest key it read", async () => {
    serve(roster(3));
    const { lastKey } = await readByKeyPages(NODE);
    expect(lastKey).toBe("u0002");
  });

  it("reports null for an empty node — there is nothing to continue from", async () => {
    serve({});
    const { lastKey } = await readByKeyPages(NODE);
    expect(lastKey).toBeNull();
  });

  it("reports a cursor even when the page budget ran out", async () => {
    serve(roster(30));
    const r = await readByKeyPages(NODE, { pageSize: 10, maxPages: 2 });
    expect(r.complete).toBe(false);
    expect(r.lastKey).toBe("u0018");
  });
});
