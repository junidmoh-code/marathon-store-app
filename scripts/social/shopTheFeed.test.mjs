// Tests for the two decisions Shop the Feed makes on its own: which products
// the bio page carries and in what order, and what has to change in Shopify to
// make that true. Everything else in that program is a Shopify call.
import { describe, it, expect } from "vitest";
import { feedHandlesFrom, planFeedMembership, FEED_MAX } from "./shop-the-feed.mjs";

const post = (over = {}) => ({
  id: "p1",
  status: "posted",
  postedAt: 1000,
  products: [{ handle: "shoe-a", displayName: "Shoe A" }],
  ...over,
});

describe("feedHandlesFrom", () => {
  it("takes the product behind each posted item", () => {
    const out = feedHandlesFrom([post()]);
    expect(out).toEqual([{ handle: "shoe-a", displayName: "Shoe A", postId: "p1" }]);
  });

  it("orders newest posted first", () => {
    const out = feedHandlesFrom([
      post({ id: "old", postedAt: 100, products: [{ handle: "old-shoe" }] }),
      post({ id: "new", postedAt: 900, products: [{ handle: "new-shoe" }] }),
    ]);
    expect(out.map((o) => o.handle)).toEqual(["new-shoe", "old-shoe"]);
  });

  it("falls back to scheduledAt when postedAt is absent", () => {
    const out = feedHandlesFrom([
      { id: "a", status: "posted", scheduledAt: 100, products: [{ handle: "a" }] },
      { id: "b", status: "posted", scheduledAt: 900, products: [{ handle: "b" }] },
    ]);
    expect(out.map((o) => o.handle)).toEqual(["b", "a"]);
  });

  // A story and its feed twin are the same product on the same day. Two tiles
  // for one product would waste a slot and make the page look padded.
  it("shows a product once however many posts featured it", () => {
    const out = feedHandlesFrom([
      post({ id: "story", postedAt: 900 }),
      post({ id: "feed", postedAt: 800 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].postId).toBe("story");
  });

  // The bio page mirrors what people actually saw. A draft or an approved-but-
  // unsent post has not been seen by anyone.
  it("ignores anything not actually posted", () => {
    const out = feedHandlesFrom([
      post({ id: "draft", status: "draft", products: [{ handle: "draft-shoe" }] }),
      post({ id: "approved", status: "approved", products: [{ handle: "soon-shoe" }] }),
      post({ id: "failed", status: "failed", products: [{ handle: "failed-shoe" }] }),
    ]);
    expect(out).toEqual([]);
  });

  it("caps the feed", () => {
    const many = Array.from({ length: FEED_MAX + 10 }, (_, i) =>
      post({ id: `p${i}`, postedAt: 10000 - i, products: [{ handle: `h${i}` }] })
    );
    expect(feedHandlesFrom(many)).toHaveLength(FEED_MAX);
  });

  it("carries every product of a multi-product post, in slot order", () => {
    const out = feedHandlesFrom([
      post({ products: [{ handle: "top" }, { handle: "bottom" }, { handle: "shoe" }] }),
    ]);
    expect(out.map((o) => o.handle)).toEqual(["top", "bottom", "shoe"]);
  });

  it("survives posts with no products, blank handles and junk", () => {
    expect(feedHandlesFrom([])).toEqual([]);
    expect(feedHandlesFrom(null)).toEqual([]);
    expect(feedHandlesFrom([post({ products: null })])).toEqual([]);
    expect(feedHandlesFrom([post({ products: [{ handle: "  " }, null, {}] })])).toEqual([]);
  });

  it("trims whitespace off a handle rather than emitting a broken URL", () => {
    const out = feedHandlesFrom([post({ products: [{ handle: "  spaced  " }] })]);
    expect(out[0].handle).toBe("spaced");
  });
});

describe("planFeedMembership", () => {
  it("adds what is missing and drops what fell out of the feed", () => {
    expect(planFeedMembership(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] });
  });

  it("is a no-op when the feed already matches", () => {
    expect(planFeedMembership(["a", "b"], ["a", "b"])).toEqual({ add: [], remove: [] });
  });

  it("seeds an empty collection", () => {
    expect(planFeedMembership([], ["a", "b"])).toEqual({ add: ["a", "b"], remove: [] });
  });

  // Order is applied by a separate reorder call, so a pure reshuffle must not
  // churn membership — removing and re-adding would lose the collection's
  // published state on every run.
  it("does not churn membership on a pure reorder", () => {
    expect(planFeedMembership(["a", "b", "c"], ["c", "a", "b"])).toEqual({ add: [], remove: [] });
  });

  it("tolerates null inputs", () => {
    expect(planFeedMembership(null, null)).toEqual({ add: [], remove: [] });
  });
});
