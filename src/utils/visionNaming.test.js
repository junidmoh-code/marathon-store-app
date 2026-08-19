// ─── Vision naming — parsing, the validator gate, and the two outputs ────────
// Everything decidable without an API key is decided in visionNaming.js, so all
// of it is tested here. The transport (one HTTPS call per photo) is the only
// part that needs a key, and it is deliberately the only part not covered.
import { describe, it, expect } from "vitest";
import {
  VISION_PROMPT, VISION_NAME_SOURCE, NAME_PROPOSAL_KEY,
  COST_PER_NAME_USD, projectCost, regenerationNote,
  parseVisionResponse, validateVisionName, identityTextFrom,
  buildNameProposal, isPendingProposal, isRefusedProposal, mayProposeFor,
} from "./visionNaming.js";
import { triggersInText } from "./shopifyTriggers.js";

const good = (over = {}) => JSON.stringify({
  identified: true, brand: "Lacoste", model: "Gripshot", colourway: "White Navy",
  confidence: 0.82, publicName: "Low-top canvas sneaker white and navy", ...over,
});

describe("the prompt asks for both answers and forbids the brand in one of them", () => {
  it("names every field the parser expects", () => {
    for (const k of ["identified", "brand", "model", "colourway", "confidence", "publicName"]) {
      expect(VISION_PROMPT).toContain(`"${k}"`);
    }
  });
  it("tells the model not to invent a brand", () => {
    expect(VISION_PROMPT).toMatch(/Do NOT invent a brand/);
    expect(VISION_PROMPT).toMatch(/identified":\s*false/);
  });
  it("forbids brand/model wording in the PUBLIC name specifically", () => {
    expect(VISION_PROMPT).toMatch(/NO brand name/);
    expect(VISION_PROMPT).toMatch(/NO model\s+or silhouette name/);
  });
});

describe("cost", () => {
  it("quotes a batch before anything is spent", () => {
    expect(projectCost(0)).toMatchObject({ names: 0, usd: 0, zar: 0 });
    const q = projectCost(372);
    expect(q.names).toBe(372);
    expect(q.usd).toBeCloseTo(372 * COST_PER_NAME_USD, 4);
    expect(q.zar).toBeGreaterThan(0);
    expect(q.perNameUsd).toBe(COST_PER_NAME_USD);
  });
  it("scales linearly — one image per call, no batching discount to assume", () => {
    expect(projectCost(200).usd).toBeCloseTo(projectCost(100).usd * 2, 4);
  });
});

describe("parseVisionResponse", () => {
  it("reads both outputs from a clean answer", () => {
    const r = parseVisionResponse(good());
    expect(r.ok).toBe(true);
    expect(r.publicName).toBe("Low-top canvas sneaker white and navy");
    expect(r.identity).toEqual({ brand: "Lacoste", model: "Gripshot", colourway: "White Navy", confidence: 0.82 });
  });

  it("survives the code fence models add however much you ask them not to", () => {
    expect(parseVisionResponse("```json\n" + good() + "\n```").ok).toBe(true);
    expect(parseVisionResponse("```\n" + good() + "\n```").ok).toBe(true);
  });

  it("WRITES NO IDENTITY when the model says it could not identify the item", () => {
    const r = parseVisionResponse(good({ identified: false, brand: "Nike", model: "Dunk" }));
    expect(r.ok).toBe(true);
    expect(r.identity).toBeNull();      // the brand it offered anyway is discarded
    expect(r.publicName).toBeTruthy();  // the description is still useful
  });

  it("treats a MISSING identified flag as not identified — never as a yes", () => {
    // A model ignoring the contract must not get its guess written as fact.
    const r = parseVisionResponse(JSON.stringify({ brand: "Nike", model: "Dunk", confidence: 0.9, publicName: "Low-top sneaker black" }));
    expect(r.identity).toBeNull();
    expect(r.identified).toBe(false);
  });

  it("'identified: true' with nothing nameable is not an identification", () => {
    const r = parseVisionResponse(good({ brand: "", model: "", colourway: "" }));
    expect(r.identity).toBeNull();
  });

  it("clamps a confidence outside 0..1 and treats a missing one as zero", () => {
    expect(parseVisionResponse(good({ confidence: 4 })).identity.confidence).toBe(1);
    expect(parseVisionResponse(good({ confidence: -2 })).identity.confidence).toBe(0);
    expect(parseVisionResponse(good({ confidence: "very" })).identity.confidence).toBe(0);
    expect(parseVisionResponse(good({ confidence: undefined })).identity.confidence).toBe(0);
  });

  it("fails loudly rather than salvaging a half-read answer", () => {
    expect(parseVisionResponse("")).toMatchObject({ ok: false });
    expect(parseVisionResponse("I think it is a Nike shoe.")).toMatchObject({ ok: false, error: "response was not JSON" });
    expect(parseVisionResponse("[1,2]")).toMatchObject({ ok: false });
    expect(parseVisionResponse("null")).toMatchObject({ ok: false });
    expect(parseVisionResponse(good({ publicName: "" }))).toMatchObject({ ok: false, error: "no publicName in the response" });
    expect(parseVisionResponse(good({ publicName: "   " }))).toMatchObject({ ok: false });
  });
});

describe("validateVisionName — the model never polices itself", () => {
  it("passes a clean descriptive name", () => {
    expect(validateVisionName("Low-top canvas sneaker white and navy")).toMatchObject({ ok: true, problems: [] });
  });

  it("catches the brand the prompt asked it not to use", () => {
    const v = validateVisionName("Lacoste Gripshot low-top sneaker");
    expect(v.ok).toBe(false);
    expect(v.triggers).toContain("lacoste");
    expect(v.triggers).toContain("gripshot");
  });

  it("catches a model name even with no parent brand", () => {
    expect(validateVisionName("Samba style indoor trainer").ok).toBe(false);
    expect(validateVisionName("Air Force inspired low-top").ok).toBe(false);
  });

  it("applies the SAME shape guards a hand-typed name gets", () => {
    expect(validateVisionName("").problems).toContain("name is empty");
    expect(validateVisionName("7 panel runner").problems).toContain("cannot start with a digit");
    expect(validateVisionName("ab").problems).toContain("under 3 characters");
    expect(validateVisionName("x".repeat(81)).problems).toContain("over 80 characters");
    expect(validateVisionName("QUILTED BOMBER JACKET BLACK").problems).toContain("is ALL CAPS");
  });
});

describe("identityTextFrom — the searchable sentence", () => {
  it("is brand, model, colourway in that order", () => {
    expect(identityTextFrom({ brand: "Lacoste", model: "Gripshot", colourway: "White Navy" }))
      .toBe("Lacoste Gripshot White Navy");
  });
  it("skips what is missing without leaving gaps", () => {
    expect(identityTextFrom({ brand: "Lacoste", model: "", colourway: "White" })).toBe("Lacoste White");
    expect(identityTextFrom({ brand: "Lacoste" })).toBe("Lacoste");
  });
  it("is empty for no identity at all", () => {
    expect(identityTextFrom(null)).toBe("");
    expect(identityTextFrom({})).toBe("");
  });
});

describe("buildNameProposal — proposed, never applied", () => {
  const base = {
    publicName: "Low-top canvas sneaker white and navy",
    identity: { brand: "Lacoste", model: "Gripshot", colourway: "White Navy", confidence: 0.82 },
    previousName: "Lace Boot White Navy", model: "gemini-2.5-flash", at: 1786900000000,
  };

  it("carries the vision source, so the review surface can tell it apart", () => {
    expect(buildNameProposal(base).source).toBe(VISION_NAME_SOURCE);
    expect(NAME_PROPOSAL_KEY).toBe("nameProposal");
    // NOT cleanName — that is the applied name and this must not be it.
    expect(NAME_PROPOSAL_KEY).not.toBe("cleanName");
  });

  it("records the PREVIOUS name, which is what makes a bad batch revertible", () => {
    expect(buildNameProposal(base).previousName).toBe("Lace Boot White Navy");
    expect(buildNameProposal({ ...base, previousName: null }).previousName).toBeNull();
  });

  it("records the guess AS a guess — confidence and the searchable text", () => {
    const p = buildNameProposal(base);
    expect(p.identity).toMatchObject({ brand: "Lacoste", model: "Gripshot", confidence: 0.82, text: "Lacoste Gripshot White Navy" });
  });

  it("a refused name is KEPT in its own lane with the reason, never dropped", () => {
    const p = buildNameProposal({ ...base, refusedFor: "brand trigger: lacoste", attempts: 2 });
    expect(p.status).toBe("refused");
    expect(p.refusedFor).toBe("brand trigger: lacoste");
    expect(p.attempts).toBe(2);
    // The name is still recorded, so a human can see WHAT it produced.
    expect(p.name).toBe(base.publicName);
  });

  it("a clean proposal is pending, not approved", () => {
    expect(buildNameProposal(base).status).toBe("pending");
  });

  it("no identity means null, not an empty shell", () => {
    expect(buildNameProposal({ ...base, identity: null }).identity).toBeNull();
  });
});

describe("the review worklist", () => {
  const pending = { [NAME_PROPOSAL_KEY]: { status: "pending", name: "x" } };
  const refused = { [NAME_PROPOSAL_KEY]: { status: "refused", name: "x", refusedFor: "y" } };
  it("separates pending from refused — refused is never bulk-approvable", () => {
    expect(isPendingProposal(pending)).toBe(true);
    expect(isRefusedProposal(pending)).toBe(false);
    expect(isRefusedProposal(refused)).toBe(true);
    expect(isPendingProposal(refused)).toBe(false);
  });
  it("ignores nodes with no proposal", () => {
    expect(isPendingProposal({})).toBe(false);
    expect(isPendingProposal(null)).toBe(false);
    expect(isRefusedProposal(undefined)).toBe(false);
  });
});

describe("mayProposeFor — a manual name is never overwritten", () => {
  it("refuses a product Junid named by hand", () => {
    expect(mayProposeFor({ cleanName: "Junid's title", cleanNameSource: "manual" })).toBe(false);
  });
  it("allows exactly what needs fixing — lexicon names, AI names, and no name", () => {
    expect(mayProposeFor({ cleanName: "Sneaker Gold", cleanNameSource: "lexicon" })).toBe(true);
    expect(mayProposeFor({ cleanName: "Sneaker Gold", cleanNameSource: "ai" })).toBe(true);
    expect(mayProposeFor({ cleanName: "Sneaker Gold", cleanNameSource: VISION_NAME_SOURCE })).toBe(true);
    expect(mayProposeFor({})).toBe(true);
    expect(mayProposeFor(null)).toBe(true);
  });
});

describe("regenerationNote — a bare retry gets the same answer back", () => {
  it("NAMES the offending terms so the model knows what to avoid", () => {
    const note = regenerationNote(["lacoste", "gripshot"]);
    expect(note).toContain("lacoste");
    expect(note).toContain("gripshot");
    expect(note).toMatch(/rejected/i);
  });
  it("still says something useful when the terms are unknown", () => {
    expect(regenerationNote([])).toMatch(/forbidden brand or model term/);
    expect(regenerationNote(null)).toMatch(/forbidden/);
  });
});

// ─── THE PROMPT MAY NOT SUGGEST A WORD THE VALIDATOR REFUSES ─────────────────
// This is not a style rule, it is a cost and quality rule. The first version of
// the prompt listed "suede" as a material to reach for and used it in worked
// example A — and "suede" is a silhouette in the compliance lexicon (the PUMA
// model), so every name that followed the prompt's own advice was refused,
// regenerated at full price, and often refused again because the second attempt
// reached for the same obvious word. A prompt that argues with its own validator
// is a defect the tests must catch, not something to rediscover on a bill.
describe("the prompt and the validator must agree", () => {
  it("every worked example quoted in the prompt passes validateVisionName", () => {
    const quoted = [...VISION_PROMPT.matchAll(/"([A-Z][^"]{10,60})"/g)].map((m) => m[1]);
    expect(quoted.length).toBeGreaterThan(6); // the eight lead shapes are in there
    for (const example of quoted) {
      const verdict = validateVisionName(example);
      expect(verdict.ok, `${example} → ${verdict.problems.join("; ")}`).toBe(true);
    }
  });

  it("no material the prompt recommends is a brand trigger", () => {
    const list = VISION_PROMPT.match(/when it is obvious \(([^)]+)\)/);
    expect(list).toBeTruthy();
    for (const word of list[1].split(",").map((w) => w.trim())) {
      expect(triggersInText(word), `prompt recommends "${word}"`).toEqual([]);
    }
  });

  it("suede is still refused — the fix is the prompt, never a softened validator", () => {
    expect(validateVisionName("Brushed suede low-top in sand").ok).toBe(false);
  });
});
