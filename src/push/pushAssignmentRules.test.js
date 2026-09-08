// ─── A NON-ADMIN CANNOT WRITE AN ASSIGNMENT ──────────────────────────────────
// The enforcement is an RTDB rule, and a rule lives in the Firebase console —
// no test in this repo can execute it. What CAN be pinned is the artifact that
// gets pasted: PUSH-ASSIGNMENT-RULES-DEPLOY.md is the document Junid copies
// from, so if its JSON ever drifts to `auth != null`, to a stockRole, or to a
// blanket `true`, the thing that would be published is already wrong and this
// goes red before anybody pastes it.
//
// It is a real guard rather than a lint: the whole recipient list lives on
// /push_hub_audience, so a client-writable rule there means a staff member can
// add themselves to Hub 1 and receive every Hub 1 order, or delete a
// colleague's entry and silently stop their alerts — a failure indistinguishable
// from the feature not working. The three client-side gates (tile, route,
// component) are all bypassable; this clause is not.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PUSH_ASSIGNMENTS_PATH, PUSH_HUB_AUDIENCE_PATH, PUSH_HUBS } from "./pushAssignments";

const DOC = readFileSync(new URL("../../PUSH-ASSIGNMENT-RULES-DEPLOY.md", import.meta.url), "utf8");
const ADMIN_EMAIL = "gunidmoh@gmail.com";

// The one fenced JSON block in the document, parsed as an object so the
// assertions are about STRUCTURE and not about where a line break falls.
const rules = JSON.parse(`{${DOC.match(/```json\n([\s\S]*?)```/)[1]}}`);

describe("the rules that will be pasted", () => {
  it("covers both paths the feature writes, under the names the code uses", () => {
    expect(Object.keys(rules).sort()).toEqual([PUSH_ASSIGNMENTS_PATH, PUSH_HUB_AUDIENCE_PATH].sort());
  });

  for (const path of ["push_assignments", "push_hub_audience"]) {
    describe(`/${path}`, () => {
      const node = () => rules[path];

      it("gates .write on the super-admin email, and on nothing weaker", () => {
        const w = node()[".write"];
        expect(typeof w).toBe("string");
        expect(w).toContain(`auth.token.email === '${ADMIN_EMAIL}'`);
        // The three ways this clause has historically been softened.
        expect(w).not.toMatch(/stockRole/);
        expect(w).not.toMatch(/auth\.uid\s*===\s*\$uid/);
        expect(w.replace(/\s/g, "")).not.toBe("auth!=null");
        expect(w).not.toBe("true");
      });

      it("gates .read the same way — the index is roster data about other people", () => {
        expect(node()[".read"]).toContain(`auth.token.email === '${ADMIN_EMAIL}'`);
        expect(node()[".read"]).not.toBe("true");
      });

      it("names no OTHER email — a second address is a second key to the feature", () => {
        const emails = JSON.stringify(node()).match(/[\w.+-]+@[\w.-]+/g) || [];
        expect([...new Set(emails)]).toEqual([ADMIN_EMAIL]);
      });
    });
  }

  it("stores an assignment as a CLOSED shape: a boolean per hub and a number", () => {
    const rec = rules.push_assignments.$uid;
    // Derived from PUSH_HUBS, so adding a hub to the code without adding it to
    // the document Junid pastes fails HERE, before the write is refused live.
    for (const hub of PUSH_HUBS) {
      expect(rec[hub], `the rule must know about ${hub}`).toBeTruthy();
      expect(rec[hub][".validate"]).toContain("isBoolean()");
    }
    expect(rec.updatedAt[".validate"]).toContain("isNumber()");
    // Without this, anything a future bug or a console paste parks on a record
    // is stored and served forever.
    expect(rec.$other[".validate"]).toBe(false);
  });

  // ── THE COMPATIBILITY HINGE ───────────────────────────────────────────────
  // Every record written before 2026-09-08 has hub1, hub2 and updatedAt and no
  // hub3. If hub3 were REQUIRED, each of those becomes invalid the moment
  // anything touches it, and so does a write from any browser still running a
  // cached two-hub bundle — which a service worker can hold for a while. The
  // required set must therefore stay at the three children every record has
  // ever had, with the new hub optional and type-checked.
  describe("a legacy two-hub record must still be writable", () => {
    const required = () => {
      const m = rules.push_assignments.$uid[".validate"].match(/hasChildren\(\[(.*?)\]\)/);
      return JSON.parse(`[${m[1].replace(/'/g, '"')}]`);
    };

    it("requires exactly hub1, hub2 and updatedAt — the children every record has", () => {
      expect(required().sort()).toEqual(["hub1", "hub2", "updatedAt"]);
    });

    it("does NOT require hub3 — that would refuse every assignment made so far", () => {
      expect(required()).not.toContain("hub3");
    });

    it("but DOES type-check hub3 when it is present, so a string cannot land there", () => {
      expect(rules.push_assignments.$uid.hub3[".validate"]).toContain("isBoolean()");
    });

    it("every hub beyond the required set is optional and validated", () => {
      // Whatever PUSH_HUBS grows to, a new hub must arrive this way — declared,
      // type-checked, and NOT added to hasChildren.
      for (const hub of PUSH_HUBS.filter((h) => !required().includes(h))) {
        expect(rules.push_assignments.$uid[hub][".validate"]).toContain("isBoolean()");
      }
    });
  });

  it("stores an index entry as a CLOSED shape too", () => {
    const entry = rules.push_hub_audience.$hub.$uid;
    expect(entry[".validate"]).toContain("hasChild('at')");
    expect(entry.at[".validate"]).toContain("isNumber()");
    expect(entry.$other[".validate"]).toBe(false);
  });
});

describe("the deploy note says the things a person acting on it needs", () => {
  it("says the repo's database.rules.json must NOT be deployed", () => {
    expect(DOC).toMatch(/database\.rules\.json/);
    expect(DOC).toMatch(/STALE/);
  });
  it("names the screen that proves the paste took", () => {
    expect(DOC).toContain("#admin/notifications");
  });
});
