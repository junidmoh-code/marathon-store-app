// Every refusal carries its own evidence — owner-only, card numbers cut to the
// last four, size-capped. Run against the REAL extracted lines of every file in
// the corpus, so a layout that prints a PAN differently is caught here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  maskEvidenceLine, evidenceRecord, refusedPdfPath, EVIDENCE_PATH, REFUSED_PDF_PREFIX,
  EVIDENCE_MAX_LINES, EVIDENCE_MAX_LINE_CHARS,
} from "./intakeCore.mjs";
import { INTAKE_RULE_BLOCKS, OWNER } from "./intakeRules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "../../functions/test/fixtures/card-recon-real");
// Kept on the Mac mini only (gitignored — public repo); skipped elsewhere.
const HAVE_REAL = existsSync(CORPUS);
const corpusLines = () => readdirSync(CORPUS).filter((f) => f.endsWith(".lines.json"))
  .flatMap((f) => JSON.parse(readFileSync(join(CORPUS, f), "utf8")));

describe("maskEvidenceLine", () => {
  it.skipIf(!HAVE_REAL)("leaves no BIN on any line of any real report — only the last four survive", () => {
    const lines = corpusLines();
    const masked = lines.filter((l) => /[*]{4,}\d{4}\b/.test(l));
    expect(masked.length, "the corpus does print masked PANs").toBeGreaterThan(100);
    for (const l of lines.map(maskEvidenceLine)) {
      expect(l).not.toMatch(/\d{6}[*xX·•#]{2,}/);
      if (!/^\s*Merchant\b/i.test(l)) expect(l).not.toMatch(/\b\d{16}\b/);
    }
    expect(maskEvidenceLine("518103******4436")).toBe("******4436");
    expect(maskEvidenceLine("4111 11** **** 1111")).toBe("******1111");
  });

  it("withholds a card number printed unmasked, but keeps the merchant id", () => {
    expect(maskEvidenceLine("PAN 4111111111111111")).toBe("PAN [card number withheld]");
    expect(maskEvidenceLine("Merchant: 100000001178101")).toBe("Merchant: 100000001178101");
    // …but only the merchant id: a card number later on that line is still withheld.
    expect(maskEvidenceLine("Merchant: 100000001178101 card 4111111111111111")).toBe("Merchant: 100000001178101 card [card number withheld]");
    // What a refusal needs to be readable is left alone.
    for (const l of ["RRN: 04Yewn059002", "Auth Code: 932966", "TSN:2 Batch:59", "Total: ZAR 900.00", "Terminal: 67365901"]) {
      expect(maskEvidenceLine(l)).toBe(l);
    }
  });

  it("catches the rarer shapes: eight digits shown, a number run into a label", () => {
    expect(maskEvidenceLine("4111 1111 **** 1111")).toBe("******1111");
    expect(maskEvidenceLine("PAN4111111111111111")).toBe("PAN[card number withheld]");
    expect(maskEvidenceLine("2026 1015 1630 0001")).toBe("2026 1015 1630 0001");
  });

  it("caps a line's length", () => {
    expect(maskEvidenceLine("x".repeat(500)).length).toBe(EVIDENCE_MAX_LINE_CHARS);
  });
});

describe("evidenceRecord", () => {
  it("keeps the full reason, the PDF path and the masked lines, capped", () => {
    const lines = Array.from({ length: EVIDENCE_MAX_LINES + 50 }, (_, i) => (i === 3 ? "518103******4436" : `line ${i}`));
    const rec = evidenceRecord({
      items: [{ filename: "FNB-Txn-Notification.pdf", reason: "The lines add up to R10.00 but the total is R20.00.", lines, pdfPath: refusedPdfPath("-Pabc") }],
      at: 5, parserVersion: 2,
    });
    const a = rec.attachments[0];
    expect(rec.parserVersion).toBe(2);
    expect(a.reason).toContain("R10.00");
    expect(a.pdfPath).toBe(`${REFUSED_PDF_PREFIX}/-Pabc.pdf`);
    expect(a.lines.length).toBe(EVIDENCE_MAX_LINES);
    expect(a.lineCount).toBe(EVIDENCE_MAX_LINES + 50);
    expect(a.truncated).toBe(true);
    expect(a.lines[3]).toBe("******4436");
  });

  it("files second and later attachments beside the first", () => {
    expect(refusedPdfPath("-Pabc", 0)).toBe("card_recon_refused/-Pabc.pdf");
    expect(refusedPdfPath("-Pabc", 2)).toBe("card_recon_refused/-Pabc-2.pdf");
  });
});

describe("where the evidence lives", () => {
  it("is an owner-only node, never the manager-readable intake row", () => {
    const rule = INTAKE_RULE_BLOCKS[EVIDENCE_PATH];
    expect(rule[".read"]).toBe(`auth != null && auth.token.email === '${OWNER}'`);
    expect(rule[".write"]).toBe("false");
    expect(INTAKE_RULE_BLOCKS.card_batch_intake[".read"]).not.toBe(rule[".read"]);
  });

  it("the poller writes lines only to the evidence node, and the row only a path", () => {
    const src = readFileSync(join(HERE, "email-poller.mjs"), "utf8");
    expect(src).toMatch(/\[`\$\{EVIDENCE_PATH\}\/\$\{intakeId\}`\]: evidence\.record/);
    expect(src).toMatch(/f\.row\.evidence = evidence\.paths\.get\(f\) \|\| null/);
    // The row is built AFTER the path is set on it (intakeRecord copies rows).
    expect(src.indexOf("f.row.evidence =")).toBeLessThan(src.indexOf("const record = intakeRecord({ message, results, skipped"));
  });

  it("the storage path is owner-only in storage.rules, and never writable", () => {
    const rules = readFileSync(join(HERE, "../../storage.rules"), "utf8");
    const block = rules.slice(rules.indexOf(`match /${REFUSED_PDF_PREFIX}/`));
    expect(block).toMatch(/allow read: if request\.auth != null\s+&& request\.auth\.token\.email == "gunidmoh@gmail\.com";/);
    // The block's own body: from its opening line to the first closing brace
    // on a line of its own.
    const body = block.slice(0, block.search(/\n\s*\}\n/));
    expect(body).toMatch(/allow write: if false;/);
  });
});
