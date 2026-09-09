// ─── A STAFF MEMBER MAY MUTE THEMSELVES, AND NOBODY ELSE ─────────────────────
// The enforcement is an RTDB rule and a rule lives in the Firebase console — no
// test in this repo can execute it. What CAN be pinned is the artifact that
// gets pasted: PUSH-MUTE-RULE-DEPLOY.md is the document Junid copies from, so
// if its JSON ever drifts the thing that would be published is already wrong
// and this goes red before anybody pastes it.
//
// Same discipline, and the same reason, as src/push/pushAssignmentRules.test.js.
//
// The attack this clause stops is specific: a blanket `auth != null` on .write
// would let any signed-in staff member mute a COLLEAGUE — a targeted denial of
// service against somebody else's working day, invisible from both ends, and
// indistinguishable from the feature being broken.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PUSH_MUTES_PATH } from "./pushMute";

const DOC = readFileSync(new URL("../../PUSH-MUTE-RULE-DEPLOY.md", import.meta.url), "utf8");
const ADMIN_EMAIL = "gunidmoh@gmail.com";

const rules = JSON.parse(`{${DOC.match(/```json\n([\s\S]*?)```/)[1]}}`);

describe("the mute rule that will be pasted", () => {
  it("covers the node the code writes, under the name the code uses", () => {
    expect(Object.keys(rules)).toEqual([PUSH_MUTES_PATH]);
  });

  const node = () => rules[PUSH_MUTES_PATH].$uid;

  it("SCOPES .write TO THE OWNER, and to nobody else at all", () => {
    const w = node()[".write"];
    expect(w).toContain("auth.uid === $uid");
    expect(w).toContain("auth != null");
    // Not the admin either: Junid ASSIGNS, staff MUTE. An owner who could
    // write this node could silence a colleague, which is not a decision this
    // feature gives anybody.
    expect(w).not.toContain(ADMIN_EMAIL);
    expect(w.replace(/\s/g, "")).not.toBe("auth!=null");
    expect(w).not.toBe("true");
  });

  it("lets the OWNER read it, so a silenced assignment is visible on the card", () => {
    const r = node()[".read"];
    expect(r).toContain("auth.uid === $uid");
    expect(r).toContain(`auth.token.email === '${ADMIN_EMAIL}'`);
    expect(r).not.toBe("true");
  });

  it("IS NOT A NODE-LEVEL READ — every read is one bounded leaf per row", () => {
    // A .read above $uid would make a whole-node fetch legal, and this node
    // grows with headcount for ever. Same lesson as the /push_tokens read
    // (PUSH-TOKENS-ADMIN-READ-RULE.md).
    expect(rules[PUSH_MUTES_PATH][".read"]).toBeUndefined();
    expect(rules[PUSH_MUTES_PATH][".write"]).toBeUndefined();
  });

  it("names no OTHER email — a second address is a second key to the feature", () => {
    const emails = JSON.stringify(rules).match(/[\w.+-]+@[\w.-]+/g) || [];
    expect([...new Set(emails)]).toEqual([ADMIN_EMAIL]);
  });

  it("stores a CLOSED shape: one boolean and one number, and nothing else", () => {
    expect(node()[".validate"]).toBe("newData.hasChildren(['muted','updatedAt'])");
    expect(node().muted[".validate"]).toBe("newData.isBoolean()");
    expect(node().updatedAt[".validate"]).toBe("newData.isNumber()");
    // Without this, anything a future bug or a console paste parks on the
    // record is stored and served for ever.
    expect(node().$other[".validate"]).toBe(false);
  });

  it("REFUSES A STRING — isMuted counts only a real boolean, and the rule says so too", () => {
    expect(node().muted[".validate"]).not.toContain("isString");
  });

  it("THE RULE GRANTS NO HUB — a mute may never touch the assignment nodes", () => {
    // The safety argument for a client-writable node in this feature. If this
    // paste ever mentioned push_assignments or push_hub_audience, a staff
    // member's own switch would be writing the thing that decides recipients.
    const json = JSON.stringify(rules);
    expect(json).not.toContain("push_assignments");
    expect(json).not.toContain("push_hub_audience");
    expect(json).not.toContain("push_tokens");
  });
});

describe("the document says what has to be done with it", () => {
  it("tells the reader to paste in the console, and NOT to deploy the stale local file", () => {
    expect(DOC).toContain("Firebase Console");
    expect(DOC).toContain("database.rules.json");
    expect(DOC).toContain("STALE");
  });

  it("names the order of operations against the hosting deploy", () => {
    expect(DOC).toMatch(/BEFORE the hosting deploy/i);
  });
});
