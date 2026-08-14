// ─── The store's transaction mutators, pinned ────────────────────────────────
// Everything subtle in the write layer lives inside runTransaction mutators:
// the isOn refusals, the condition gate on every path to live, the
// blocked→awaiting unblock, and normalizedFields pinning liveState when a
// write upgrades a legacy state string ("draft" must land as live+OFF, never
// let the legacy-live fallback read it as ON). firebase is fully mocked — the
// mock drives the mutator the way the SDK does (with the server value) and
// treats undefined as an abort, so refusal paths are exercised for real.
import { describe, it, expect, vi, beforeEach } from "vitest";

let serverNode = null; // the value runTransaction hands the mutator

vi.mock("firebase/database", () => ({
  ref: () => ({}),
  child: () => ({}),
  get: () => Promise.resolve({ val: () => null }),
  query: (x) => x,
  orderByChild: () => ({}),
  equalTo: () => ({}),
  runTransaction: (_ref, mutate) => {
    const next = mutate(serverNode);
    if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: () => serverNode } });
    serverNode = next;
    return Promise.resolve({ committed: true, snapshot: { val: () => next } });
  },
}));
vi.mock("../../firebase", () => ({
  database: { app: { options: { databaseURL: "https://x" } } },
  auth: { currentUser: { uid: "u1", getIdToken: () => Promise.resolve("t") } },
}));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1755000000000 }));

const { approveName, publishProduct, setDesiredState, setCondition, setPublishPhotos, publishPhotoListProblem } =
  await import("./shopifyPublishStore");
const { CONDITIONS } = await import("./shopifyPublishCore");
const COND = CONDITIONS[0];
const FS = (n) => `https://firebasestorage.googleapis.com/v0/b/x/o/products%2Fp1%2Fshopify%2F${n}.jpg?alt=media`;

beforeEach(() => { serverNode = null; });

describe("publishProduct — the one path from review to intent", () => {
  it("stamps name approval and desiredState on, clears a stale blockedReason", async () => {
    serverNode = { state: "awaiting", condition: COND, blockedReason: "old refusal" };
    const res = await publishProduct("p1", serverNode, "Low-top sneaker black");
    expect(res.ok).toBe(true);
    expect(res.node).toMatchObject({
      state: "awaiting", desiredState: "on", cleanName: "Low-top sneaker black",
      nameApprovedAt: 1755000000000, blockedReason: null, updatedBy: "u1",
    });
  });
  it("refuses without a condition — the gate to live has no default", async () => {
    serverNode = { state: "awaiting" };
    const res = await publishProduct("p1", serverNode, "Low-top sneaker black");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Condition not set/);
    expect(serverNode.desiredState).toBeUndefined(); // nothing written
  });
  it("refuses when the SERVER says the product is already on", async () => {
    serverNode = { state: "live", liveState: "on", condition: COND };
    const res = await publishProduct("p1", { state: "awaiting", condition: COND }, "Low-top sneaker black");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Already ON/);
  });
  it("refuses a name that trips the trigger check", async () => {
    serverNode = { state: "awaiting", condition: COND };
    const res = await publishProduct("p1", serverNode, "Nike Air Force 1");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/brand trigger/);
  });
});

describe("setDesiredState — the on/off switch writes intent only", () => {
  it("off is always allowed and leaves confirmed state alone", async () => {
    serverNode = { state: "live", liveState: "on", desiredState: "on", condition: COND };
    const res = await setDesiredState("p1", serverNode, "off");
    expect(res.ok).toBe(true);
    expect(res.node).toMatchObject({ state: "live", liveState: "on", desiredState: "off" });
  });
  it("on re-checks the condition gate", async () => {
    serverNode = { state: "live", liveState: "off", desiredState: "off" }; // no condition
    const res = await setDesiredState("p1", serverNode, "on");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Condition not set/);
  });
  it("a write on a LEGACY draft node pins liveState off — never misread as on", async () => {
    serverNode = { state: "draft", condition: COND }; // pre-migration node
    const res = await setDesiredState("p1", serverNode, "on");
    expect(res.ok).toBe(true);
    // normalizedFields must pin liveState from the LEGACY value: draft was
    // never published. state:"live" without liveState would read as ON.
    expect(res.node).toMatchObject({ state: "live", liveState: "off", desiredState: "on" });
  });
});

describe("approveName — bulk review write", () => {
  it("refuses only while the product is ON the storefront", async () => {
    serverNode = { state: "live", liveState: "on", condition: COND };
    expect((await approveName("p1", serverNode, "Court low grey")).ok).toBe(false);
    serverNode = { state: "live", liveState: "off", condition: COND };
    const res = await approveName("p1", serverNode, "Court low grey");
    expect(res.ok).toBe(true);
    expect(res.node).toMatchObject({ state: "live", liveState: "off", cleanName: "Court low grey" });
  });
});

describe("setPublishPhotos — the publishing photo set", () => {
  it("writes the ordered list through the node transaction, state fields intact", async () => {
    serverNode = { state: "awaiting", condition: COND };
    const res = await setPublishPhotos("p1", serverNode, [FS("a"), FS("b")]);
    expect(res.ok).toBe(true);
    expect(res.node).toMatchObject({ state: "awaiting", photos: [FS("a"), FS("b")], updatedBy: "u1" });
  });
  it("null clears the custom set back to the record's photos", async () => {
    serverNode = { state: "awaiting", condition: COND, photos: [FS("a")] };
    const res = await setPublishPhotos("p1", serverNode, null);
    expect(res.ok).toBe(true);
    expect(res.node.photos).toBeNull();
  });
  it("refuses while the listing is ON — customers see the current set", async () => {
    serverNode = { state: "live", liveState: "on", condition: COND };
    const res = await setPublishPhotos("p1", serverNode, [FS("a")]);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/switch it off/);
  });
  it("publishPhotoListProblem mirrors the media.mjs push guards", () => {
    expect(publishPhotoListProblem([FS("a")])).toBeNull();
    expect(publishPhotoListProblem([])).toMatch(/imageless/);          // empty never ships
    expect(publishPhotoListProblem([FS("a"), FS("a")])).toMatch(/duplicate/);
    expect(publishPhotoListProblem(["http://firebasestorage.googleapis.com/x.jpg"])).toMatch(/Firebase Storage/); // not https
    expect(publishPhotoListProblem(["https://evil.example.com/x.jpg"])).toMatch(/Firebase Storage/); // wrong host
    expect(publishPhotoListProblem(["not a url"])).toMatch(/invalid URL/);
    expect(publishPhotoListProblem(Array.from({ length: 21 }, (_, i) => FS(String(i))))).toMatch(/At most 20/);
  });
});

describe("setCondition — the unblock path", () => {
  it("blocked → awaiting, refusal reason cleared", async () => {
    serverNode = { state: "blocked", blockedReason: "validator said no" };
    const res = await setCondition("p1", serverNode, COND);
    expect(res.ok).toBe(true);
    expect(res.node).toMatchObject({ state: "awaiting", condition: COND, blockedReason: null });
  });
  it("refuses while ON; live-off keeps its state", async () => {
    serverNode = { state: "live", liveState: "on", condition: COND };
    expect((await setCondition("p1", serverNode, CONDITIONS[1])).ok).toBe(false);
    serverNode = { state: "live", liveState: "off", condition: COND };
    const res = await setCondition("p1", serverNode, CONDITIONS[1]);
    expect(res.ok).toBe(true);
    expect(res.node).toMatchObject({ state: "live", liveState: "off", condition: CONDITIONS[1] });
  });
  it("rejects a value outside the three grades", async () => {
    serverNode = { state: "awaiting" };
    expect((await setCondition("p1", serverNode, "Mint")).ok).toBe(false);
  });
});
