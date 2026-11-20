// ─── ACTIVE STORE — switch, cancel, back home, daily/login reset, audit, stamps
// Run: npx vitest run src/utils/activeStore.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./serverTime", () => ({ saDateString: () => "2026-11-20", serverNowMs: () => 1795600000000 }));
vi.mock("../device/enrolment", () => ({ getDeviceIdentity: () => ({ deviceId: "dev-1", personName: "Asanda" }) }));
vi.mock("../device/deviceId", () => ({ getDeviceId: () => "dev-1" }));

const S = await import("./activeStore.js");
const { deviceStamp } = await import("../device/deviceStamp.js");

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

let storage, log, today;
const PE_USER = { uid: "u1", homeShop: "marathon-pe", name: "Asanda", signIn: "Thu, 20 Nov 2026 06:00:00 GMT", deviceId: "dev-1" };

beforeEach(() => {
  S.__resetActiveStoreForTests();
  storage = memStorage();
  log = vi.fn(async () => ({ data: { ok: true } }));
  today = "2026-11-20";
  S.__setActiveStoreDepsForTests({ storage, log, today: () => today, now: () => 1795600000000 });
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("switching", () => {
  it("starts at the home shop", () => {
    S.bindActiveStore(PE_USER);
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
    expect(S.isAwayFromHome()).toBe(false);
  });

  it("tapping another shop only stages it — nothing changes until confirmed", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete");
    expect(S.getActiveStore().pending).toBe("concrete");
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
    await flush();
    expect(log).not.toHaveBeenCalled();
  });

  it("cancel leaves everything as it was and logs nothing", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete");
    S.cancelSwitch();
    expect(S.getActiveStore()).toMatchObject({ activeShop: "marathon-pe", pending: null });
    await flush();
    expect(log).not.toHaveBeenCalled();
  });

  it("confirm switches, persists for the day and writes ONE audit line", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete");
    S.confirmSwitch();
    expect(S.getActiveStore()).toMatchObject({ activeShop: "concrete", pending: null });
    expect(S.isAwayFromHome()).toBe(true);
    expect(JSON.parse(storage.getItem(S.ACTIVE_STORE_KEY))).toEqual({ uid: "u1", shop: "concrete", saDate: "2026-11-20", signIn: PE_USER.signIn });
    await flush();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ id: expect.stringMatching(/^1795600000000_[a-z0-9]+$/), from: "marathon-pe", to: "concrete", home: "marathon-pe", reason: "switch", deviceId: "dev-1", clientAtMs: 1795600000000 });
    expect(storage.getItem("mc.activeStore.pendingLog.v1")).toBe(null);   // accepted → off the queue
  });

  it("Back to home needs no confirmation, and tapping the home chip is the same", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("trophy"); S.confirmSwitch();
    S.backToHome();
    expect(S.getActiveStore()).toMatchObject({ activeShop: "marathon-pe", pending: null });
    S.requestSwitch("trophy"); S.confirmSwitch();
    S.requestSwitch("marathon-pe");
    expect(S.getActiveStore()).toMatchObject({ activeShop: "marathon-pe", pending: null });
    await flush();
    expect(log.mock.calls.map((c) => c[0].reason)).toEqual(["switch", "back-home", "switch", "back-home"]);
  });

  it("tapping the shop you are already in does nothing", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("marathon-pe");
    expect(S.getActiveStore().pending).toBe(null);
    await flush();
    expect(log).not.toHaveBeenCalled();
  });

  it("an account with no home switches at once (nothing to leave) and is never 'away'", async () => {
    S.bindActiveStore({ uid: "owner", homeShop: null, signIn: "x" });
    expect(S.getActiveStore().activeShop).toBe(null);
    S.requestSwitch("trophy");
    expect(S.getActiveStore()).toMatchObject({ activeShop: "trophy", pending: null });
    expect(S.isAwayFromHome()).toBe(false);
    await flush();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ from: null, to: "trophy", reason: "switch" }));
  });
});

describe("automatic return home", () => {
  it("at SA midnight an away choice goes home by itself and is logged as a daily reset", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    today = "2026-11-21";
    expect(S.checkDayRollover()).toBe(false);   // first sighting: could be a clock correction
    expect(S.getActiveStore().activeShop).toBe("concrete");
    expect(S.checkDayRollover()).toBe(true);    // still a new day a minute later: go home
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
    await flush();
    expect(log.mock.calls.at(-1)[0]).toMatchObject({ from: "concrete", to: "marathon-pe", reason: "daily-reset" });
  });

  it("a reload on the SAME day and SAME login keeps the choice", () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    S.__resetActiveStoreForTests();
    S.__setActiveStoreDepsForTests({ storage, log, today: () => today });
    S.bindActiveStore(PE_USER);
    expect(S.getActiveStore().activeShop).toBe("concrete");
  });

  it("opening the app the next day starts at home (daily-reset logged)", async () => {
    storage.setItem(S.ACTIVE_STORE_KEY, JSON.stringify({ uid: "u1", shop: "concrete", saDate: "2026-11-19", signIn: PE_USER.signIn }));
    S.bindActiveStore(PE_USER);
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
    await flush();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ from: "concrete", to: "marathon-pe", reason: "daily-reset" }));
  });

  it("a fresh login on the same day starts at home (fresh-login logged)", async () => {
    storage.setItem(S.ACTIVE_STORE_KEY, JSON.stringify({ uid: "u1", shop: "concrete", saDate: "2026-11-20", signIn: "an earlier sign-in" }));
    S.bindActiveStore(PE_USER);
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
    await flush();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ reason: "fresh-login" }));
  });

  it("another person's saved choice is never inherited", () => {
    storage.setItem(S.ACTIVE_STORE_KEY, JSON.stringify({ uid: "someone-else", shop: "concrete", saDate: "2026-11-20", signIn: PE_USER.signIn }));
    S.bindActiveStore(PE_USER);
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
  });

  it("sign-out forgets the choice on a shared tablet", () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    S.resetActiveStore();
    expect(storage.getItem(S.ACTIVE_STORE_KEY)).toBe(null);
    expect(S.getActiveStore().uid).toBe(null);
  });
});

describe("audit delivery", () => {
  it("a day 'change' seen only once (server offset correction) does not send anyone home", () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    today = "2026-11-21"; S.checkDayRollover();
    today = "2026-11-20"; S.checkDayRollover();
    today = "2026-11-21"; S.checkDayRollover();
    expect(S.getActiveStore().activeShop).toBe("concrete");
  });

  it("signing out while away audits the return home BEFORE the session ends; the state clears only after", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    await S.auditSignOut();
    expect(log.mock.calls.at(-1)[0]).toMatchObject({ from: "concrete", to: "marathon-pe", reason: "sign-out" });
    expect(S.getActiveStore().activeShop).toBe("concrete");        // sign-out not done yet: still working
    const n = log.mock.calls.length;
    S.resetActiveStore();                                           // sign-out happened
    await flush();
    expect(log.mock.calls.length).toBe(n);                          // not audited twice
    expect(S.getActiveStore().uid).toBe(null);
  });

  it("a failed sign-out leaves the account working", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    await S.auditSignOut();
    S.signOutFailed();
    expect(S.getActiveStore()).toMatchObject({ uid: "u1", activeShop: "concrete" });
    S.requestSwitch("marathon-pe");
    expect(S.getActiveStore().activeShop).toBe("marathon-pe");
  });

  it("a line survives a reload in the middle of sending it", async () => {
    let release;
    log.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    await flush();
    const q = JSON.parse(storage.getItem("mc.activeStore.pendingLog.v1"));
    expect(q).toHaveLength(1);                                      // still queued while in flight
    expect(q[0]).toMatchObject({ uid: "u1", to: "concrete" });
    release({});
  });

  it("Junid re-homing someone moves them and is audited", async () => {
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    S.bindActiveStore({ ...PE_USER, homeShop: "trophy" });
    expect(S.getActiveStore()).toMatchObject({ homeShop: "trophy", activeShop: "trophy" });
    await flush();
    expect(log.mock.calls.at(-1)[0]).toMatchObject({ from: "concrete", to: "trophy", reason: "rehomed" });
  });

  it("a queued line is only ever sent by the account it belongs to", async () => {
    log.mockRejectedValueOnce(new Error("offline"));
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    await flush(); await flush();
    S.resetActiveStore();
    log.mockClear();
    S.bindActiveStore({ uid: "u2", homeShop: "trophy", signIn: "z" });
    await flush(); await flush();
    expect(log).not.toHaveBeenCalled();                       // u2 never sends u1's line
    expect(JSON.parse(storage.getItem("mc.activeStore.pendingLog.v1"))[0].uid).toBe("u1");
  });

  it("a line the server refuses for good is dropped, not retried forever", async () => {
    log.mockRejectedValueOnce(Object.assign(new Error("bad"), { code: "functions/invalid-argument" }));
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    await flush(); await flush();
    expect(storage.getItem("mc.activeStore.pendingLog.v1")).toBe(null);
  });

  it("another tab's switch is followed, so every tab stamps the same shop", () => {
    S.bindActiveStore(PE_USER);
    storage.setItem(S.ACTIVE_STORE_KEY, JSON.stringify({ uid: "u1", shop: "trophy", saDate: "2026-11-20", signIn: PE_USER.signIn }));
    S.adoptStoredChoice();
    expect(S.getActiveStore().activeShop).toBe("trophy");
  });

  it("a failed audit call is queued (bounded) and flushed on the next bind", async () => {
    log.mockRejectedValueOnce(new Error("offline"));
    S.bindActiveStore(PE_USER);
    S.requestSwitch("concrete"); S.confirmSwitch();
    await flush(); await flush();
    expect(JSON.parse(storage.getItem("mc.activeStore.pendingLog.v1"))).toHaveLength(1);
    await S.flushPendingLog();
    expect(log).toHaveBeenCalledTimes(2);
    expect(storage.getItem("mc.activeStore.pendingLog.v1")).toBe(null);
  });
});

describe("every stamped write records the active shop", () => {
  it("deviceStamp names the shop the action counts for, the person's own shop and away", () => {
    S.bindActiveStore(PE_USER);
    expect(deviceStamp("placed")).toMatchObject({ deviceId: "dev-1", store: "marathon-pe", homeStore: "marathon-pe" });
    expect(deviceStamp("placed").away).toBeUndefined();
    S.requestSwitch("concrete"); S.confirmSwitch();
    expect(deviceStamp("fulfilled")).toMatchObject({ store: "concrete", homeStore: "marathon-pe", away: true });
  });

  it("a transaction body that runs after a switch still names the shop the person acted in", async () => {
    const { stampTxn } = await import("../device/deviceStamp.js");
    S.bindActiveStore(PE_USER);
    const body = stampTxn((cur) => ({ ...cur, status: "done" }), "fulfil");   // action taken at PE
    S.requestSwitch("concrete"); S.confirmSwitch();                         // switch lands before commit
    const out = body({ id: "o1" });
    expect(Object.values(out.stamps)[0]).toMatchObject({ store: "marathon-pe", homeStore: "marathon-pe" });
    expect(Object.values(out.stamps)[0].away).toBeUndefined();
  });

  it("activeStoreStamp gives orders the same three facts", () => {
    expect(S.activeStoreStamp({ activeShop: "concrete", homeShop: "marathon-pe" })).toEqual({ actingStore: "concrete", actingHomeStore: "marathon-pe", actingAway: true });
    expect(S.activeStoreStamp({ activeShop: "trophy", homeShop: null })).toEqual({ actingStore: "trophy", actingHomeStore: null, actingAway: false });
  });

  it("no account bound → the stamp is unchanged from before", () => {
    const s = deviceStamp("x");
    expect(s.store).toBeUndefined(); expect(s.homeStore).toBeUndefined();
  });
});
