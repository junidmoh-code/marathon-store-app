import { describe, it, expect, vi } from "vitest";
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: null } }));
const { setPublishTarget, publishTarget, publishNodePath } = await import("./shopifyPublishStore.js");

describe("publish target", () => {
  it("defaults to Marathon's node and switches to Concrete's", () => {
    expect(publishTarget()).toBe("marathon");
    expect(publishNodePath()).toBe("shopify_publish");
    setPublishTarget("concrete");
    expect(publishNodePath()).toBe("shopify_publish_concrete");
    setPublishTarget("marathon");
    expect(publishNodePath()).toBe("shopify_publish");
    expect(() => setPublishTarget("other")).toThrow();
  });
});

describe("the target cannot move under work in flight", async () => {
  const { setPublishTarget, publishTarget, holdTarget, targetBusy } = await import("./publishTarget.js");
  it("a held target refuses a switch until released", () => {
    setPublishTarget("marathon");
    const release = holdTarget();
    expect(targetBusy()).toBe(true);
    expect(() => setPublishTarget("concrete")).toThrow(/still running/);
    expect(publishTarget()).toBe("marathon");
    release(); release();
    expect(targetBusy()).toBe(false);
    setPublishTarget("concrete");
    expect(publishTarget()).toBe("concrete");
    setPublishTarget("marathon");
  });
});
