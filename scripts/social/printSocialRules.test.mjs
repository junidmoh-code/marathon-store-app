// ─── THE PRINTED RULES ARE THE ONES WE MEANT (vitest) ────────────────────────
// print-social-rules.mjs produces text a human pastes into the Firebase console
// by hand. Nothing downstream validates it: a wrong clause is not a failing
// build, it is a permission hole or a locked-out screen discovered days later.
//
// These assertions were checked ONCE against the live rules document (fetched
// from the running database on 2026-08-23) — the shopify_publish and
// photoProposals blocks printed here differ from live on exactly one line each,
// and that line is the `.write`. CI cannot re-run that comparison (it has no
// credentials), so what is pinned here are the PROPERTIES that made the
// comparison come out right, and which a careless edit would break:
//
//   · the new clause is a strict SUPERSET of the old one — nobody who can write
//     today loses the ability tomorrow
//   · the ledger has a read rule and NO write rule
//   · the permission is read from permFlags, compared to literal `true`
//   · the social keys are NOT widened to the named permissions
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./print-social-rules.mjs", import.meta.url));
const printed = JSON.parse(execFileSync("node", [SCRIPT, "--json"], { encoding: "utf8" }));

const ADMIN = "gunidmoh@gmail.com";
const shopifyWrite = printed.shopifyRule.shopify_publish.$pid[".write"];
const photoWrite   = printed.aiAssistantChildren.photoProposals[".write"];

describe("PART 2 — shopify_publish gains a permission without losing anyone", () => {
  it("still accepts the super-admin email", () => {
    expect(shopifyWrite).toContain(`auth.token.email === '${ADMIN}'`);
  });

  it("still accepts stockRole admin", () => {
    expect(shopifyWrite).toContain("root.child('users').child(auth.uid).child('stockRole').val() === 'admin'");
  });

  it("also accepts the named permission, read from permFlags", () => {
    expect(shopifyWrite).toContain(
      "root.child('users').child(auth.uid).child('permFlags').child('shopify_publish').val() === true",
    );
  });

  // The permission is compared to literal `true`. permFlagsFor writes exactly
  // that (pinned in permissionFlags.test.js); a rule comparing to a string or
  // relying on truthiness would silently disagree with the map we write.
  it("compares to literal true, not to a truthy value", () => {
    expect(shopifyWrite).not.toMatch(/permFlags'\)\.child\('shopify_publish'\)\.exists\(\)/);
    expect(shopifyWrite).toMatch(/child\('shopify_publish'\)\.val\(\) === true/);
  });

  it("still refuses anonymous sign-in", () => {
    expect(shopifyWrite).toContain("auth.token.firebase.sign_in_provider != 'anonymous'");
  });
});

describe("PART 3 — the photo permission is self-sufficient", () => {
  it("photoProposals accepts the named permission as well as a stockRole", () => {
    expect(photoWrite).toContain("child('stockRole').exists()");
    expect(photoWrite).toContain(
      "root.child('users').child(auth.uid).child('permFlags').child('photo_generation').val() === true",
    );
  });

  // A ledger a client can write is not a ledger. Only the Cloud Functions write
  // it, through the Admin SDK, which bypasses rules — so the correct rule is a
  // read and nothing else.
  it("the spend ledger is readable by the owner and writable by nobody", () => {
    const usage = printed.aiAssistantChildren.usage;
    expect(usage[".read"]).toBe(`auth != null && auth.token.email === '${ADMIN}'`);
    expect(usage).not.toHaveProperty(".write");
  });

  it("pastes only the two children it means to, never the whole aiAssistant key", () => {
    // nameProposals and styleKit must NOT appear: printing them would invite
    // pasting over children this change has no business touching.
    expect(Object.keys(printed.aiAssistantChildren).sort()).toEqual(["photoProposals", "usage"]);
  });
});

describe("PART 1 — Social is NOT widened by this pass", () => {
  // Owner decision 2026-08-23: dropping mc's stockRole must cost him the Social
  // card. If either social key ever learns a named permission, that intent is
  // quietly reversed — so it is asserted here rather than remembered.
  it.each(["social_posts", "social_style_refs"])("%s stays on email-or-stockRole", (key) => {
    const node = printed.socialRules[key];
    const write = node.$postId?.[".write"] ?? node.$refId?.[".write"];
    expect(write).toContain(`auth.token.email === '${ADMIN}'`);
    expect(write).toContain("child('stockRole').val() === 'admin'");
    expect(write).not.toContain("permFlags");
  });

  it("both social keys carry the index their queries need", () => {
    // Without these, every bounded query the queue and library make degrades to
    // a full-node scan.
    expect(printed.socialRules.social_posts[".indexOn"]).toEqual(["status"]);
    expect(printed.socialRules.social_style_refs[".indexOn"]).toEqual(["addedAt"]);
  });
});
