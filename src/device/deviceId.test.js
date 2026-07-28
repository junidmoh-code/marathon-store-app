import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDeviceId } from "./deviceId";

// Minimal localStorage stub — vitest's default env has no DOM storage.
function installStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

describe("getDeviceId", () => {
  beforeEach(() => installStorage());

  it("mints an id and persists it under marathon.deviceId", () => {
    const id = getDeviceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(localStorage.getItem("marathon.deviceId")).toBe(id);
  });

  it("returns the SAME id on repeat calls (stable per browser)", () => {
    expect(getDeviceId()).toBe(getDeviceId());
  });

  it("returns null (never throws) when storage is unavailable — e.g. private mode", () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(() => getDeviceId()).not.toThrow();
    expect(getDeviceId()).toBeNull();
  });
});
