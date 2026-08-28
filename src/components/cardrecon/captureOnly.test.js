// REQUIREMENT: this app CAPTURES slips and learns nothing else.
//
// The manager photographs the batch report, the callable OCRs it, and the reply
// is an acknowledgement — slip recorded, batch number, whether the detail roll
// made it in. No variance, no expected figure, no cashier list, no card numbers.
// The owner reviews reconciliation on his own account, in the POS reports tree.
//
// The records themselves now live at TOP-LEVEL /card_batches (and
// /card_batch_drafts, /card_batch_overrides), owner-only read and write, moved
// out from under /pos so no parent grant reaches them. This app must never read
// any of them: it has no screen that should show one, and reaching for one from
// a manager's handset would be refused by the rules anyway — a silent empty
// panel instead of an honest one.
//
// That is enforced HERE, at the source, rather than by remembering. The server
// half is enforced separately: the callable's response shape carries no figure
// (see #499), so there is nothing to uncover by calling it directly.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function everySourceFile(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { everySourceFile(full, out); continue; }
    if (/\.(js|jsx)$/.test(entry) && !/\.test\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

// The whole client bundle, not a hand-listed subset — a hand-listed one goes
// stale the moment somebody adds a screen.
const CLIENT_FILES = everySourceFile(resolve(root, "src"));

const FORBIDDEN = [
  ["the card_batches record node", /card_batches/],
  ["the card_batch_drafts node", /card_batch_drafts/],
  ["the card_batch_overrides node", /card_batch_overrides/],
];

// Comments may EXPLAIN the nodes; code may not name them.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the store app is capture-only", () => {
  it("reads none of the card-recon nodes, anywhere in src/", () => {
    const offenders = [];
    for (const file of CLIENT_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [what, pattern] of FORBIDDEN) {
        if (pattern.test(code)) offenders.push(`${file.slice(root.length + 1)} references ${what}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the capture screen reads exactly one node — the till picker's registry", () => {
    // config/cardTerminals is the TID→till map the picker needs, and it is the
    // only database read the capture flow makes. Everything else about a slip
    // goes to the callable and comes back as an acknowledgement.
    const src = readFileSync(resolve(root, "src/components/cardrecon/CardReconScreen.jsx"), "utf8");
    const reads = [...stripComments(src).matchAll(/dbRef\(\s*database\s*,\s*["'`]([^"'`]+)/g)].map((m) => m[1]);
    expect(reads).toEqual(["config/cardTerminals"]);
  });

  it("shows no variance, expected figure or cashier list on the handset", () => {
    // #499 removed these from the callable's response. If a screen starts
    // rendering one again it means the response shape grew back.
    const code = stripComments(readFileSync(resolve(root, "src/components/cardrecon/CardReconScreen.jsx"), "utf8"));
    for (const forbidden of ["varianceCents", "expectedCardCents", "expectedByKind", "cashiers"]) {
      expect(code, `the capture screen must not render ${forbidden}`).not.toMatch(new RegExp(forbidden));
    }
  });
});
