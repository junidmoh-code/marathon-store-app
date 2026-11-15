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
