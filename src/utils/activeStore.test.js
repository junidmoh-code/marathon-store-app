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
    expect(log).toHaveBeenCalledWith({ from: "marathon-pe", to: "concrete", home: "marathon-pe", reason: "switch", deviceId: "dev-1", clientAtMs: 1795600000000 });
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
    expect(S.checkDayRollover()).toBe(true);
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

  it("activeStoreStamp gives orders the same three facts", () => {
    expect(S.activeStoreStamp({ activeShop: "concrete", homeShop: "marathon-pe" })).toEqual({ actingStore: "concrete", actingHomeStore: "marathon-pe", actingAway: true });
    expect(S.activeStoreStamp({ activeShop: "trophy", homeShop: null })).toEqual({ actingStore: "trophy", actingHomeStore: null, actingAway: false });
  });

  it("no account bound → the stamp is unchanged from before", () => {
    const s = deviceStamp("x");
    expect(s.store).toBeUndefined(); expect(s.homeStore).toBeUndefined();
  });
});
