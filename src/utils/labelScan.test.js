// ─── LABEL QR/DATAMATRIX INTERPRETATION — stability rules, proven ────────────
import { describe, it, expect } from "vitest";
import { interpretLabelScan } from "./labelScan";

describe("what a decoded label code may mean", () => {
  it("a style-code-shaped value is used directly — deterministic beats OCR", () => {
    expect(interpretLabelScan("CT8527-016")).toMatchObject({ kind: "code", code: "CT8527-016" });
    expect(interpretLabelScan("IE3437")).toMatchObject({ kind: "code" });
  });

  it("form-varying brands are NOT taken from the QR — the printed reference stays canonical", () => {
    // Lacoste's label prints 7-43SMA0033 1R5; its web/QR form is the bare
    // 43SMA0034. Accepting either from a QR would give one shoe two identities
    // depending on whether the QR decoded — so the OCR path decides.
    expect(interpretLabelScan("7-43SMA00331R5")).toMatchObject({ kind: "ignore", reason: "brand_form_varies" });
    expect(interpretLabelScan("43SMA0034")).toMatchObject({ kind: "ignore", reason: "brand_form_varies" });
  });

  it("a URL carrying a stable shaped token yields that token; form-varying brands don't", () => {
    expect(interpretLabelScan("https://www.adidas.com/us/shoe/IE3437.html"))
      .toMatchObject({ kind: "code", code: "IE3437" });
    expect(interpretLabelScan("https://www.lacoste.com/us/lacoste/men/43SMA0034.html"))
      .toMatchObject({ kind: "ignore", reason: "url_without_code" });
    expect(interpretLabelScan("https://example.com/help")).toMatchObject({ kind: "ignore", reason: "url_without_code" });
  });

  it("GS1 payloads are IGNORED — a per-size GTIN must never become an identity", () => {
    expect(interpretLabelScan("0195244656714")).toMatchObject({ kind: "ignore", reason: "gs1_numeric" });
    expect(interpretLabelScan("0104066765432109211234567")).toMatchObject({ kind: "ignore" });
    expect(interpretLabelScan("01040667654321\x1d21SERIAL9")).toMatchObject({ kind: "ignore", reason: "gs1_separators" });
  });

  it("composite payloads surface an embedded shaped token", () => {
    expect(interpretLabelScan("ART:CT8527-016;SZ:9")).toMatchObject({ kind: "code", code: "CT8527-016" });
  });

  it("unknown payloads are ignored, never guessed into an identity", () => {
    expect(interpretLabelScan("HELLOWORLDDATA")).toMatchObject({ kind: "ignore", reason: "unknown_stability" });
    expect(interpretLabelScan("")).toMatchObject({ kind: "ignore", reason: "empty" });
  });
});
