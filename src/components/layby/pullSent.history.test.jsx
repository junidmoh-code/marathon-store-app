// "Sent" must clear the request in Today's history (31 Oct 2026).
//
// THE BUG: a hub marked a layby request Sent; the write landed on BOTH
// /laybyPulls and /laybys (live audit: 0 of 523 pulls still pending), but the
// warehouse queue re-listed the sent pull as a Ready row in Today's group and
// PullCard drew it with Sent + Reject regardless of its status — so it looked
// like an open request, and a second tap could overwrite the outcome (L-00350,
// Hub 3: sent, then rejected 10 minutes later from the same card).
//
// THIS TEST drives the real chain against an in-memory RTDB: the real
// markPullSent writes, the real queue mapping (laybyQueueRow, the one App.jsx
// uses) builds the row from what was written, and the real PullCard renders it.
import { describe, test, expect, vi, beforeEach } from "vitest";
import { create, act } from "react-test-renderer";

// ── In-memory RTDB. Like the real one, a write of null / {} / [] REMOVES the
// key (and an emptied parent goes with it), so a test can't pass on a shape
// production would never hold.
const store = { root: {} };
const isEmpty = (v) => v == null || (typeof v === "object" && Object.keys(v).length === 0);
function setPath(path, val) {
  const parts = path.split("/").filter(Boolean);
  const chain = [store.root];
  let node = store.root;
  for (const k of parts.slice(0, -1)) {
    if (typeof node[k] !== "object" || node[k] == null) node[k] = {};
    node = node[k]; chain.push(node);
  }
  const last = parts[parts.length - 1];
  if (isEmpty(val)) delete node[last]; else node[last] = JSON.parse(JSON.stringify(val));
  for (let i = chain.length - 1; i > 0; i--) if (isEmpty(chain[i])) delete chain[i - 1][parts[i - 1]];
}
function getPath(path) {
  let node = store.root;
  for (const k of path.split("/").filter(Boolean)) { if (node == null) return null; node = node[k]; }
  return node === undefined ? null : node;
}
const writes = [];
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "t" } } }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path = "") => ({ path }),
  get: async (r) => ({ val: () => getPath(r.path) }),
  update: async (r, patch) => {
    writes.push({ at: r.path, patch });
    for (const [k, v] of Object.entries(patch)) setPath(r.path ? `${r.path}/${k}` : k, v);
  },
  onValue: () => () => {},
}));

const { markPullSent, rejectPull } = await import("./useLayby.js");
const { laybyQueueRow, PULL_STATUS, LAYBY_STATUS } = await import("./contract.js");
const { PullCard } = await import("./LaybyTab.jsx");

const NOW_ISO = "2026-10-31T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function seed({ pullId, laybyId, hub, store: shop, invoiceNo }) {
  setPath(`laybys/${laybyId}`, { laybyId, invoiceNo, status: LAYBY_STATUS.PULL_REQUESTED, storageHub: hub, balanceRemaining: 30000 });
  setPath(`laybyPulls/${pullId}`, {
    pullId, laybyId, invoiceNo, status: PULL_STATUS.PENDING, storageHub: hub,
    requestingStore: shop, disposition: "collect", requestedAt: NOW_MS - 3600_000,
    customerName: "Sfiso", dueDate: "2026-11-20", itemCount: 1, balanceRemaining: 30000,
  });
  return JSON.parse(JSON.stringify(getPath(`laybyPulls/${pullId}`))); // a CARD holds a copy
}

const textIn = (inst) => typeof inst === "string" ? inst : (inst.children || []).map(textIn).join("");
const buttonsOf = (tree) => tree.root.findAllByType("button").map(textIn);
const render = (pull, hub) => {
  let tree;
  act(() => { tree = create(<PullCard pull={pull} selectedHub={hub} nowMs={NOW_MS} />); });
  return tree;
};

beforeEach(() => { store.root = {}; writes.length = 0; });

// All three hubs, all four stores (Concrete's parcels are at Hub 3).
const CASES = [
  { hub: "hub1", store: "marathon-pe" },
  { hub: "hub1", store: "trophy" },
  { hub: "hub3", store: "marathon-pine" },
  { hub: "hub3", store: "concrete" },
  { hub: "hub2", store: "trophy" },
];

describe("Sent → Today's history row shows SENT with no action buttons", () => {
  for (const c of CASES) {
    test(`${c.store} via ${c.hub}`, async () => {
      const pull = seed({ pullId: "P1", laybyId: "L1", hub: c.hub, store: c.store, invoiceNo: "L-00628" });

      // Before: an open request — Incoming, Sent + Reject offered.
      const before = laybyQueueRow(pull, c.hub, NOW_ISO);
      expect(before.status).toBe("incoming");
      const openCard = buttonsOf(render(before._pull, c.hub)).join(" ");
      expect(openCard).toContain("Sent");
      expect(openCard).toContain("Reject");

      await markPullSent(pull, c.hub);

      // The write: both nodes, one update.
      expect(getPath("laybyPulls/P1/status")).toBe(PULL_STATUS.SENT);
      expect(getPath("laybys/L1/status")).toBe(LAYBY_STATUS.SENT);
      expect(getPath("laybyPulls/P1/sentBy")).toBe(c.hub);

      // After: the row rebuilt from what was WRITTEN is a Ready row dated today…
      const after = laybyQueueRow(getPath("laybyPulls/P1"), c.hub, NOW_ISO);
      expect(after.status).toBe("ready");
      expect(after.createdAt).toBe(getPath("laybyPulls/P1/sentAt"));
      // …and its card says SENT TO STORE and offers nothing to press.
      const tree = render(after._pull, c.hub);
      expect(tree.root.findAllByType("button")).toHaveLength(0);
      expect(tree.root.findByProps({ "data-testid": "pull-outcome" }).props.children).toBe("SENT TO STORE");
    });
  }
});

describe("one outcome per pull", () => {
  test("Reject on an already-sent pull is refused and writes nothing", async () => {
    const pull = seed({ pullId: "P1", laybyId: "L1", hub: "hub3", store: "marathon-pine", invoiceNo: "L-00350" });
    await markPullSent(pull, "hub3");
    const n = writes.length;
    // A stale card still holding the pending copy:
    await expect(rejectPull(pull, "Exchange of shoe type", "hub3")).rejects.toMatchObject({ code: "already-resolved", status: PULL_STATUS.SENT });
    expect(writes.length).toBe(n);
    expect(getPath("laybyPulls/P1/status")).toBe(PULL_STATUS.SENT);
    expect(getPath("laybys/L1/status")).toBe(LAYBY_STATUS.SENT);
  });

  test("a second Sent does not re-stamp sentAt", async () => {
    const pull = seed({ pullId: "P1", laybyId: "L1", hub: "hub1", store: "trophy", invoiceNo: "L-1" });
    await markPullSent(pull, "hub1");
    const first = getPath("laybyPulls/P1/sentAt");
    await expect(markPullSent(pull, "hub1")).rejects.toMatchObject({ code: "already-resolved" });
    expect(getPath("laybyPulls/P1/sentAt")).toBe(first);
  });

  test("a stale card that taps Sent says it was already done and keeps no buttons", async () => {
    const pull = seed({ pullId: "P1", laybyId: "L1", hub: "hub1", store: "trophy", invoiceNo: "L-1" });
    await markPullSent(pull, "hub1");
    const tree = render(pull, "hub1"); // the pending copy, as a not-yet-refreshed card holds it
    const sent = tree.root.findAllByType("button").find((b) => textIn(b).includes("Sent"));
    await act(async () => { await sent.props.onClick(); });
    expect(tree.root.findByProps({ "data-testid": "pull-refused" })).toBeTruthy();
    expect(tree.root.findAllByType("button")).toHaveLength(0);
  });

  test("rejected and returned pulls render their outcome, never buttons", () => {
    for (const status of [PULL_STATUS.REJECTED, PULL_STATUS.RETURNED_TO_STOCK]) {
      const tree = render({ pullId: "P", laybyId: "L", invoiceNo: "L-9", status, storageHub: "hub1", rejectionReason: "x" }, "hub1");
      expect(tree.root.findAllByType("button")).toHaveLength(0);
    }
  });
});
