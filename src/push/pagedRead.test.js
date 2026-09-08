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
    if (!limit) throw new Error("unbounded read reached the server");
    const keys = Object.keys(data).sort()
      .filter((k) => (after ? k > after.value : true))
      .slice(0, limit.value);
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
      expect(r.map((c) => c.kind)).toEqual(["orderByKey", "startAfter", "limitToFirst"]);
    }
    expect(reqs[1].find((c) => c.kind === "startAfter").value).toBe("u0009");
    expect(reqs[2].find((c) => c.kind === "startAfter").value).toBe("u0019");
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
    expect(await readByKeyPages(NODE)).toEqual({ data: {}, complete: true, pages: 1 });
  });
});

describe("truncation is reported, never passed off as the whole node", () => {
  it("says complete:false when the page budget runs out", async () => {
    serve(roster(100));
    const { data, complete, pages } = await readByKeyPages(NODE, { pageSize: 10, maxPages: 3 });
    expect(Object.keys(data)).toHaveLength(30);
    expect(pages).toBe(3);
    expect(complete).toBe(false, "a slice must never claim to be the whole roster");
  });

  it("the ceiling is finite by construction", async () => {
    expect(PAGE_SIZE * MAX_PAGES).toBeLessThanOrEqual(5000);
  });

  it("a server that never advances the cursor terminates instead of looping forever", async () => {
    // A misbehaving or misconfigured node that ignores startAfter would spin
    // this loop until the budget ran out; it must stop on the first repeat.
    getMock.mockImplementation(async () => ({
      forEach: (cb) => { for (const k of ["a", "b"]) if (cb({ key: k, val: () => 1 })) return true; return false; },
    }));
    const { data, complete } = await readByKeyPages(NODE, { pageSize: 2, maxPages: 50 });
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(data)).toEqual(["a", "b"]);
    expect(complete).toBe(true);
  });
});
