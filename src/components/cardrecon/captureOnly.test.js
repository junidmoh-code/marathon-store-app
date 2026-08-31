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
//
// STRIPPED LINE-WISE, deliberately. The obvious
// `src.replace(/\/\*[\s\S]*?\*\//g, "")` treats the `/*` inside
// `accept="image/*"` as a block-comment opener and deletes everything up to the
// next `*/`. Ten files under src/ contain that string — App.jsx among them — so
// this scan was reading wreckage, and a scan that has deleted half a file finds
// nothing very convincingly. A block comment always OPENS a line; an
// `accept="image/*"` never does.
const stripComments = (src) =>
  src.split("\n").reduce(({ out, inBlock }, line) => {
    if (inBlock) return { out, inBlock: !/\*\//.test(line) };
    if (/^\s*\{?\/\*/.test(line)) return { out, inBlock: !/\*\//.test(line) };
    if (/^\s*\/\//.test(line)) return { out, inBlock: false };
    return { out: [...out, line], inBlock: false };
  }, { out: [], inBlock: false }).out.join("\n");

describe("the store app is capture-only", () => {
  it("the comment stripper has not eaten the files this scan reads", () => {
    // Without this, the scan below can pass because the source it searched was
    // blanked rather than because the reference is absent.
    //
    // COUNT, do not merely look. The naive stripper eats from the FIRST
    // `accept="image/*"` to the next `*/`, which leaves later ones intact — so
    // "the string is still in there somewhere" is satisfied by a file with half
    // its inputs deleted. Ten files under src/ carry that string.
    const count = (t, needle) => t.split(needle).length - 1;
    for (const file of ["src/components/cardrecon/CardReconScreen.jsx", "src/App.jsx"]) {
      const raw = readFileSync(resolve(root, file), "utf8");
      expect(count(stripComments(raw), 'accept="image/*"'),
        `${file}: stripping must not consume an accept="image/*"`).toBe(count(raw, 'accept="image/*"'));
      expect(stripComments(raw).length / raw.length,
        `${file} must not be largely deleted by stripping`).toBeGreaterThan(0.5);
    }
    // …and a real comment must still go. The probe is a phrase that exists in
    // the screen's header block and nowhere in its code, so a stripper that
    // stopped stripping would fail here rather than pass on absence.
    expect(stripComments(readFileSync(resolve(root, "src/components/cardrecon/CardReconScreen.jsx"), "utf8")))
      .not.toContain("the label IS the control");
  });

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

  it("the card recon screens read exactly five nodes, and each is named here on purpose", () => {
    // An ALLOW-LIST, not a ceiling. Each entry had to be argued for:
    //
    //   config/cardTerminals   the TID→till map the picker needs.
    //
    //   card_batch_intake      what the mailbox poller did with each emailed
    //                          PDF — outcomes only: a sender, a subject, a file
    //                          name, recorded-or-why-not. NO figures, no lines,
    //                          no PANs; the evidence itself stays in the
    //                          owner-only records. It is read here because a
    //                          refused emailed slip means a terminal is not
    //                          reconciling, and a refusal only the owner could
    //                          ever see is the failure this feature exists to
    //                          prevent.
    //
    //   card_batch_poll_status  the poller's heartbeat — one small node saying
    //                          when the mailbox was last checked and nothing
    //                          else. It is read because a quiet mailbox and a
    //                          dead poller are the same empty feed without it,
    //                          and "no refusals" from a poller that stopped
    //                          hours ago is the most dangerous thing this panel
    //                          could imply.
    //
    //   eft_pool               the EFT payment pool — the second reader on the
    //                          same mailbox. UNLIKE the other three this node
    //                          carries figures (amounts, payers, references),
    //                          which is why its rule is OWNER-ONLY like
    //                          /card_batches, and why EftPool.jsx renders null
    //                          for anyone but the super-admin: the panel exists
    //                          so a payment that silently fails to land — or a
    //                          forgery attempt — is seen by the one person who
    //                          can act on it. Managers never see it, and the
    //                          rule refuses them anyway.
    //
    //   eft_unallocated        the remainders of consumed EFT payments that
    //                          settled sales with NO customer attached — money
    //                          the shop owes someone it cannot yet name. Read
    //                          WHOLE, deliberately: resolving an entry (the
    //                          owner allocates it to a customer, or reverses
    //                          the settlement) removes it, so the node is the
    //                          owner's open backlog, small by construction —
    //                          and a hold that aged out of a bounded tail
    //                          would be exactly the silently-vanished money
    //                          this feature exists to prevent. Owner-only by
    //                          rule AND by render, same as /eft_pool: it is
    //                          rendered inside EftPool.jsx, behind the same
    //                          isSuperAdmin gate.
    //
    // Everything else about a slip still goes to the callable and comes back as
    // an acknowledgement. A SIXTH node appearing here is a change of policy and
    // must be made deliberately, in this list, with its reason.
    // EVERY file in the feature, not one of them: the emailed-slip panel is its
    // own file now, and a scan naming a single file goes stale the moment
    // something is extracted.
    const reads = [];
    for (const file of readdirSync(resolve(root, "src/components/cardrecon"))) {
      if (!/\.jsx?$/.test(file) || /\.test\./.test(file)) continue;
      const src = stripComments(readFileSync(resolve(root, "src/components/cardrecon", file), "utf8"));
      for (const m of src.matchAll(/dbRef\(\s*database\s*,\s*["'`]([^"'`]+)/g)) reads.push(m[1]);
    }
    // DEDUPED: the capture screen and the emailed-slip panel both read
    // /card_batch_intake — the screen for the per-till tick, the panel for the
    // feed — and the same node read twice is still one node. What this pins is
    // the SET of nodes this feature touches, which is the thing that must not
    // grow quietly.
    expect([...new Set(reads)].sort()).toEqual(["card_batch_intake", "card_batch_poll_status", "config/cardTerminals", "eft_pool", "eft_unallocated"]);
  });

  it("the emailed-slip feed is read as a bounded TAIL, never as a whole node", () => {
    // It grows by a row per message for ever. A whole-node read on a handset on
    // shop wifi is the mistake this repo keeps a rule against.
    const code = stripComments(readFileSync(resolve(root, "src/components/cardrecon/EmailedSlips.jsx"), "utf8"));
    const at = code.indexOf("card_batch_intake");
    expect(at, "the feed read has moved — this scan must follow it").toBeGreaterThan(-1);
    expect(code.slice(at, at + 200)).toMatch(/limitToLast/);
    // The heartbeat is ONE small node and is read whole, deliberately; that is
    // the difference this assertion must not blur.
    expect(code).toMatch(/card_batch_poll_status/);
  });

  it("the emailed-slip feed renders outcomes, never money", () => {
    // The panel is new surface on a capture-only screen, so it gets the same
    // treatment as the review: if a figure appears here, it came from somewhere
    // it should not have.
    //
    // WHOLE FILES, NOT A SLICE OF ONE. The first version of this scanned only
    // the pure helper, which sorts and counts and never names a record field —
    // it could not have contained these tokens if it tried. The second sliced
    // the panel's function body out of CardReconScreen.jsx by string index,
    // which any ordinary refactor escapes: extract a row renderer, place it
    // below the screen component, and it renders whatever it likes outside the
    // slice while both anchor assertions still pass.
    //
    // So the panel is its OWN FILE, and both files are scanned entire. A helper
    // extracted from the panel lands beside it and is scanned too. The manual
    // review section — which legitimately shows totalCents and purchasesCents,
    // the slip in the manager's own hand — stays in CardReconScreen.jsx, where
    // it is not scanned and does not need to be.
    // (CodeRabbit, then independent review, PR #510.)
    // WORD BOUNDARIES, because `pan` is a substring of `<span>` and of
    // `aria-expanded` — an unbounded match makes this test fail on markup and
    // teaches the next person to weaken it. The token being forbidden is the
    // record FIELD, so that is what is matched.
    const forbidden = [/\btotalCents\b/, /\bpurchasesCents\b/, /\bvarianceCents\b/, /\bamountCents\b/, /\bpan\b/, /\bcashiers\b/];
    // THE DIRECTORY, MINUS THE ONE FILE THAT IS ALLOWED. A hand-list is the
    // same disease as the string slice it replaced: extract a row renderer into
    // a new sibling and it renders whatever it likes while the scan passes.
    // Scanning everything except CardReconScreen.jsx — the manual review, which
    // legitimately shows the slip in the manager's own hand — means a new file
    // is covered the moment it exists, without anyone remembering to add it.
    // (Independent review, PR #510: the first attempt at this fix hand-listed
    // two files 45 lines after criticising single-file naming for going stale.)
    // EftPool.jsx is the SECOND allowed file, and the exemption is argued the
    // same way CardReconScreen.jsx's is: it renders the EFT payment pool,
    // which is owner-only by rule (/eft_pool, the /card_batches isolation
    // pattern) AND owner-only by render (it returns null for anyone but the
    // super-admin — pinned by its own test below). The figures it shows are
    // EFT amounts the owner must see to know a payment landed; they are not
    // card-batch material leaking to a manager's handset.
    let scanned = 0;
    for (const file of readdirSync(resolve(root, "src/components/cardrecon"))) {
      // THE CAPTURE SCREEN IS NO LONGER EXEMPT. It used to render the slip in
      // the manager's own hand — the review step, where a total and a purchases
      // figure were legitimately shown so the OCR could be checked against the
      // paper. That step is gone: the reading happens server-side and the
      // manager is told recorded or not-recorded and nothing else, so the
      // screen has no business naming a money field and is scanned like every
      // other file here. EftPool.jsx remains the one exemption, argued above.
      if (!/\.jsx?$/.test(file) || /\.test\./.test(file) || file === "EftPool.jsx") continue;
      scanned++;
      const code = stripComments(readFileSync(resolve(root, "src/components/cardrecon", file), "utf8"));
      for (const token of forbidden) {
        expect(code, `${file} must not handle ${token}`).not.toMatch(token);
      }
    }
    expect(scanned, "the scan found no files — it is passing on nothing").toBeGreaterThan(1);
    // The scan is only worth anything if it CAN fail, so prove the tokens are
    // findable in this directory: the EFT pool — the one exempt file — renders
    // amounts, and it is exempt precisely because it is owner-gated in render.
    // (The control used to be the capture screen's review section. That section
    // no longer exists, and an anchor pointed at deleted code is an assertion
    // that passes on nothing.)
    const exempt = stripComments(readFileSync(resolve(root, "src/components/cardrecon/EftPool.jsx"), "utf8"));
    expect(exempt, "the exempt panel still renders a money field — if this fails the scan above proves nothing").toMatch(/\bamountCents\b/);
  });

  it("the EFT pool panel is owner-gated in render and reads a bounded tail", () => {
    // The panel above is EXEMPT from the money scan on the strength of exactly
    // these two properties, so they are pinned: nobody but the super-admin gets
    // a render at all (the rule refuses everyone else anyway — this keeps the
    // panel from teaching managers to ignore a permanent warning), and the
    // pool — which grows by a record per payment for ever — is read as a tail.
    const code = stripComments(readFileSync(resolve(root, "src/components/cardrecon/EftPool.jsx"), "utf8"));
    expect(code, "the render gate must exist").toMatch(/if \(!isSuperAdmin\) return null/);
    const at = code.indexOf("eft_pool");
    expect(at, "the pool read has moved — this scan must follow it").toBeGreaterThan(-1);
    expect(code.slice(at, at + 200)).toMatch(/limitToLast/);
  });

  it("the silence notice is recomputed while the screen sits open", () => {
    // THE ONE THING THIS PANEL EXISTS TO SAY is that the mailbox has stopped
    // being checked — and nothing about a dead poller changes, so nothing
    // re-renders. A clock read once at mount sits at the moment the tab was
    // opened and the notice never appears, on a screen a manager leaves open on
    // a counter. (CodeRabbit, PR #510.)
    const code = stripComments(readFileSync(resolve(root, "src/components/cardrecon/EmailedSlips.jsx"), "utf8"));
    expect(code, "the clock must be state, not a render-time read").toMatch(/setNowMs\(serverNowMs\(\)\)/);
    expect(code, "…on a bounded timer").toMatch(/setInterval/);
    expect(code, "…cleared on unmount").toMatch(/clearInterval/);
    expect(code, "…and the notice must use it").toMatch(/silenceNotice\(lastAt, nowMs/);
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
