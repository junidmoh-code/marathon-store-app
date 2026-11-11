// ─── THE HOME CARD DOES NOT DOWNLOAD THE REGISTER ON EVERY VISIT TO HOME ─────
//
// The card shows one number from /settings/hubSneakerCount/register/{hub} and
// is mounted whenever anybody lands on Home. It used to get() the whole hub
// register each time: 274 reads of ~180 KB from 37 devices in 21 hours
// (profiler, 10–11 Nov 2026). What is counted here is the get() — the download.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const reads = [];
let registerNow = {};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => { reads.push(String(node.path)); return { val: () => registerNow[node.path] ?? null }; },
  update: vi.fn(), runTransaction: vi.fn(),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../device/deviceId", () => ({ getDeviceId: () => "dev-1" }));

const {
  loadRegister, loadRegisterForCard, CARD_REGISTER_TTL_MS, _clearCardRegisterForTests,
} = await import("./hubCleanupStore.js");

const HUB1 = "settings/hubSneakerCount/register/hub1";
const HUB3 = "settings/hubSneakerCount/register/hub3";
// The mirror cannot answer in these tests unless a test says so: straight to live.
const noMirror = (path, live) => live();

beforeEach(() => {
  reads.length = 0;
  registerNow = { [HUB1]: { p1__7: { qty: 1 }, p2__8: { qty: 2 } }, [HUB3]: { p9__6: { qty: 4 } } };
  _clearCardRegisterForTests();
});

describe("loadRegisterForCard", () => {
  it("ten visits to Home inside the window are ONE read, with the same rows every time", async () => {
    let t = 1_000_000;
    const opts = { now: () => t, readOnce: noMirror };
    const first = await loadRegisterForCard("hub1", opts);
    for (let i = 0; i < 9; i += 1) { t += 10_000; expect(await loadRegisterForCard("hub1", opts)).toEqual(first); }
    expect(first).toEqual({ p1__7: { qty: 1 }, p2__8: { qty: 2 } });
    expect(reads).toEqual([HUB1]);
  });

  it("reads again once the window has passed", async () => {
    let t = 0;
    const opts = { now: () => t, readOnce: noMirror };
    await loadRegisterForCard("hub1", opts);
    registerNow[HUB1] = { p1__7: { qty: 5 } };
    t += CARD_REGISTER_TTL_MS - 1;
    expect(await loadRegisterForCard("hub1", opts)).toEqual({ p1__7: { qty: 1 }, p2__8: { qty: 2 } });
    t += 1;
    expect(await loadRegisterForCard("hub1", opts)).toEqual({ p1__7: { qty: 5 } });
    expect(reads).toEqual([HUB1, HUB1]);
  });

  it("each hub has its own copy — switching the card's hub tab never shows the other hub's count", async () => {
    const opts = { now: () => 5, readOnce: noMirror };
    expect(await loadRegisterForCard("hub1", opts)).toEqual({ p1__7: { qty: 1 }, p2__8: { qty: 2 } });
    expect(await loadRegisterForCard("hub3", opts)).toEqual({ p9__6: { qty: 4 } });
    expect(reads).toEqual([HUB1, HUB3]);
  });

  it("coming back from registering on this device shows the new count with no extra read", async () => {
    const opts = { now: () => Date.now(), readOnce: noMirror };
    await loadRegisterForCard("hub1", opts);
    // The registration screen re-reads the register after every save, as it always did…
    registerNow[HUB1] = { p1__7: { qty: 1 }, p2__8: { qty: 2 }, p3__9: { qty: 1 } };
    await loadRegister("hub1");
    reads.length = 0;
    // …and the card is handed that, not the copy from before the save.
    expect(Object.keys(await loadRegisterForCard("hub1", opts))).toEqual(["p1__7", "p2__8", "p3__9"]);
    expect(reads).toEqual([]);
  });

  it("the device's local copy answers when it can, and nothing is downloaded", async () => {
    const asked = [];
    const mirror = async (path) => { asked.push(path); return { p1__7: { qty: 3 } }; };
    expect(await loadRegisterForCard("hub1", { now: () => 1, readOnce: mirror })).toEqual({ p1__7: { qty: 3 } });
    expect(asked).toEqual([HUB1]);
    expect(reads).toEqual([]);
  });

  it("an empty register is {} — and is not mistaken for 'nothing cached'", async () => {
    registerNow[HUB1] = null;
    const opts = { now: () => 1, readOnce: noMirror };
    expect(await loadRegisterForCard("hub1", opts)).toEqual({});
    expect(await loadRegisterForCard("hub1", opts)).toEqual({});
    expect(reads).toEqual([HUB1]);
  });

  it("a clock that went backwards does not serve the old copy for ever", async () => {
    let t = 10_000_000;
    const opts = { now: () => t, readOnce: noMirror };
    await loadRegisterForCard("hub1", opts);
    t = 1;
    await loadRegisterForCard("hub1", opts);
    expect(reads).toEqual([HUB1, HUB1]);
  });
});

describe("loadRegister — the registration and count screens' read — is unchanged", () => {
  it("always reads the node, however recently it was read", async () => {
    await loadRegister("hub1");
    await loadRegister("hub1");
    await loadRegisterForCard("hub1", { now: () => Date.now(), readOnce: noMirror });
    await loadRegister("hub1");
    expect(reads).toEqual([HUB1, HUB1, HUB1]);
  });
});

describe("wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  it("the Home card uses the card read; the registration screen does not", () => {
    const card = readFileSync(resolve(here, "HubCleanupCard.jsx"), "utf8");
    expect(card).toContain("Promise.all([loadCardSummary(hub), loadRegisterForCard(hub)])");
    expect(card).not.toMatch(/\bloadRegister\(/);
    const screen = readFileSync(resolve(here, "HubCleanup.jsx"), "utf8");
    expect(screen).not.toContain("loadRegisterForCard");
  });
});
