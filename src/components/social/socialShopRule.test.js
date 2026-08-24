// ── THE SHOPS ARE NEVER MENTIONED, AND A DRAFT CAN BE APPROVED ───────────────
// Two owner rules from 2026-08-23, both enforced in socialCore.js because that
// is the one module imported by BOTH the browser queue and the Mac-mini
// publisher — so there is no second copy to drift.
//
// The approval tests are a REGRESSION SUITE for a live outage: the Approve
// button was disabled on postBlocker(), whose first branch refuses anything not
// already approved. A draft therefore reported "Not approved yet" as the reason
// it could not be approved, and nothing could ever be approved through the app.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  postBlocker, postReadiness, findShopMentions, shopMentionBlocker,
} from "./socialCore.js";

const ok = (over = {}) => ({
  status: "approved",
  media: [{ url: "https://example.test/a.jpg", type: "image" }],
  caption: "A clean caption with enough characters.",
  platforms: { instagram: true, facebook: true },
  ...over,
});

describe("a draft can be approved (the outage)", () => {
  it("postReadiness does NOT refuse a post merely for being a draft", () => {
    // The whole bug in one assertion.
    expect(postReadiness(ok({ status: "draft" }))).toBeNull();
  });

  it("postBlocker still refuses to SEND a draft — the two questions differ", () => {
    expect(postBlocker(ok({ status: "draft" }))).toMatch(/not approved/i);
  });

  it("every status that is not approved is unsendable but still approvable", () => {
    for (const status of ["draft", "discarded", "failed"]) {
      expect(postBlocker(ok({ status })), status).toBeTruthy();
      expect(postReadiness(ok({ status })), status).toBeNull();
    }
  });

  it("readiness still refuses the things that genuinely make a post unpostable", () => {
    expect(postReadiness(ok({ status: "draft", media: [] }))).toMatch(/no image/i);
    expect(postReadiness(ok({ status: "draft", caption: "hi" }))).toMatch(/too short/i);
    expect(postReadiness(ok({ status: "draft", platforms: {} }))).toMatch(/no platform/i);
    expect(postReadiness(ok({
      status: "draft",
      media: [{ url: "a", type: "video" }, { url: "b", type: "image" }],
    }))).toMatch(/either video or photos/i);
  });
});

describe("physical-shop mentions are refused", () => {
  const refused = [
    "Grab it in store today",
    "Available in-store and online",
    "Instore now",
    "Visit us this weekend",
    "Come see us for a fitting",
    "Pop in and try them on",
    "Swing by for a look",
    "Drop in any time",
    "Our store is open",
    "Our branches have stock",
    "At the shop right now",
    "Walk-in customers welcome",
    "Check the showroom",
    "Both physical stores have it",
    "Opening hours: 9am - 5pm",
    "Mon - Sat 9am till late",
    "Find us at 12 Smith Street",
    "New drop at Pine",
    "In stock at Marathon PE",
    "Trophy branch has your size",
  ];
  for (const caption of refused) {
    it(`refuses: "${caption}"`, () => {
      expect(shopMentionBlocker(caption), caption).toBeTruthy();
      // and it must block the actual send, not merely warn
      expect(postBlocker(ok({ caption: `${caption} — shop the drop now.` }))).toMatch(/online only/i);
    });
  }

  it("names the offending words so the caption can be fixed", () => {
    expect(shopMentionBlocker("Available in-store now")).toContain('"in-store"');
  });
});

describe("it does not refuse honest captions", () => {
  const allowed = [
    "Pine green colourway, online now",
    "The Trophy jacket just landed",
    "Shipping across South Africa",
    "Order online and we deliver",
    "Restocked — grab yours before it goes",
    "A store of one-offs" /* no possessive "our", no locational frame */,
    "Instant classic, in a fresh colourway",
    "Winter warmers, delivered to your door",
  ];
  for (const caption of allowed) {
    it(`allows: "${caption}"`, () => {
      expect(findShopMentions(caption), caption).toEqual([]);
      expect(postBlocker(ok({ caption: `${caption} and more.` })), caption).toBeNull();
    });
  }
});

describe("the rule reaches every surface of a post, not just the caption", () => {
  it("refuses a shop mention hiding in alt text", () => {
    expect(postBlocker(ok({ altText: "Photographed in our store" }))).toMatch(/online only/i);
  });
  it("refuses a shop mention hiding in a title", () => {
    expect(postBlocker(ok({ title: "Visit us in Pine" }))).toMatch(/online only/i);
  });
  it("a draft carrying one cannot be approved either", () => {
    expect(postReadiness(ok({ status: "draft", caption: "Come see us in store for this one." })))
      .toMatch(/online only/i);
  });
});

describe("empty and odd input", () => {
  it("treats missing text as clean rather than throwing", () => {
    for (const v of [null, undefined, "", 0, false]) expect(findShopMentions(v)).toEqual([]);
  });
});

// ── THE WIRING, NOT JUST THE FUNCTION ────────────────────────────────────────
// Everything above proves postReadiness behaves. None of it proves the QUEUE
// uses it — and the outage was in the wiring, not the logic. Revert one JSX
// attribute and every test above stays green while the Approve button goes
// grey again. So the wiring is asserted directly, against the source.
describe("the Approve button is wired to readiness, not to approval", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./SocialView.jsx", import.meta.url)), "utf8",
  );

  it("computes readiness separately from the send-time blocker", () => {
    expect(src).toMatch(/const\s+notReady\s*=\s*postReadiness\(post\)/);
  });

  it("disables Approve on readiness — never on postBlocker", () => {
    expect(src).toMatch(/disabled=\{busy\s*\|\|\s*!!notReady\}/);
    // The specific regression: gating Approve on postBlocker refuses every
    // draft, because a draft is by definition not approved.
    expect(src).not.toMatch(/disabled=\{busy\s*\|\|\s*!!blocker\}/);
  });

  it("explains the refusal using the same readiness reason it gated on", () => {
    expect(src).toMatch(/Can't approve yet — \{notReady\}/);
  });

  it("PAINTS the button from the same condition it gates on", () => {
    // The second half of the same bug. `disabled` was fixed but the style was
    // left keyed on `blocker`, which is truthy for every draft — so the button
    // was clickable and painted dead, at 45% opacity with a not-allowed
    // cursor. To a person that is indistinguishable from broken, and it is what
    // "still not approving" turned out to mean.
    expect(src).toMatch(/opacity:\s*notReady\s*\?/);
    expect(src).toMatch(/cursor:\s*notReady\s*\?/);
    expect(src).not.toMatch(/opacity:\s*blocker\s*\?/);
    expect(src).not.toMatch(/cursor:\s*blocker\s*\?/);
  });

  it("does not keep a postBlocker result around for the queue to misuse", () => {
    // Nothing in this component may key off "is it already approved".
    expect(src).not.toMatch(/const\s+blocker\s*=/);
  });
});

// ── POST NOW MOVES A DATE, IT DOES NOT PUBLISH ───────────────────────────────
// The browser must never publish. The Meta credentials live in Secret Manager
// and are read by the Mac mini; a browser path to them is a browser path to the
// shop's Instagram. A second publisher would also be a second copy of the send
// logic, the claim transaction and the retry rules — two implementations that
// have to agree forever about what has already gone out.
//
// So the button writes scheduledAt = now and stops. The publisher on the mini
// is still the only thing that has ever posted, and every gate still applies.
describe("the Post now button is wired to the schedule, not to a publisher", () => {
  const store = readFileSync(
    fileURLToPath(new URL("./socialStore.js", import.meta.url)), "utf8");
  const view = readFileSync(
    fileURLToPath(new URL("./SocialView.jsx", import.meta.url)), "utf8");

  it("postNow writes a schedule and nothing else about status", () => {
    const fn = store.slice(store.indexOf("export async function postNow"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/scheduledAt:\s*serverNowMs\(\)/);
    // Must not silently approve something, and must not mark it posted.
    expect(body).not.toMatch(/status:/);
  });

  it("the browser holds no platform token and no send code", () => {
    for (const src of [store, view]) {
      expect(src).not.toMatch(/graph\.facebook\.com/);
      expect(src).not.toMatch(/media_publish|access_token/);
    }
  });

  it("the button is offered only on an APPROVED post", () => {
    // Otherwise it becomes a way to publish something that never passed the
    // approval gate.
    const i = view.indexOf("Post now");
    const before = view.slice(Math.max(0, i - 700), i);
    expect(before).toMatch(/post\.status === "approved"/);
  });

  it("tells the truth about when it will go out", () => {
    // The publisher ticks; "immediately" would be a promise the agent cannot
    // keep, and a person watching Instagram for a post that is 90 seconds away
    // will refresh and then press the button again.
    expect(view).toMatch(/next tick|two minutes/i);
  });
});
