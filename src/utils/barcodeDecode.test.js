// ─── DECODING THE SYMBOL, AND THE LADDER BELOW IT ────────────────────────────
// The decoder itself is ZXing (via html5-qrcode) and needs a DOM and a real
// image, so what is proven here is the part we wrote: which of three frames'
// readings is accepted, that an unchecked reading never is, and that the OCR
// fallback faces the same gate as the camera. `decode` and `readLabel` are
// injected, so these run with no browser and no network.

import { describe, it, expect, vi } from "vitest";

// html5-qrcode reaches for the DOM at import time in some builds; the module
// under test only uses it inside decodeBlob, which these tests never call.
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class { scanFile() { return Promise.resolve(""); } clear() {} },
  Html5QrcodeSupportedFormats: { QR_CODE: 0, EAN_13: 9, EAN_8: 10, UPC_A: 14, UPC_E: 15 },
}));

const { Html5QrcodeSupportedFormats: FORMATS } = await import("html5-qrcode");
const { pickDecodedBarcode, decodeFrames, readPrintedDigits, RETAIL_1D_FORMATS } =
  await import("./barcodeDecode");

const OUD_MOOD = "6291106065114";
const EPIC = "6291103660466";
const BAD_CHECK = "6291106065115";           // one digit off — must never be used

const framesOf = (n) => Array.from({ length: n }, (_, i) => ({ blob: { i }, base64: `b64-${i}` }));

describe("the decoder is asked for retail 1D symbologies only", () => {
  it("restricts to EAN-13, EAN-8 and UPC-A", () => {
    // Asserted against the ENUM MEMBERS, not against the numbers this test's
    // own mock supplies — comparing self-supplied literals would be testing the
    // mock. This pins WHICH symbologies are requested, which is the real
    // guarantee: widening to QR/Aztec/PDF-417 gives the decoder more ways to
    // resolve noise into a plausible number. (Kimi review, PR #340.)
    expect(RETAIL_1D_FORMATS).toEqual([FORMATS.EAN_13, FORMATS.EAN_8, FORMATS.UPC_A]);
    expect(RETAIL_1D_FORMATS).not.toContain(FORMATS.QR_CODE);
    expect(RETAIL_1D_FORMATS).not.toContain(FORMATS.UPC_E);
  });
});

describe("pickDecodedBarcode — first VALID frame wins", () => {
  it("takes the first frame that decodes to a checked code", () => {
    expect(pickDecodedBarcode([OUD_MOOD, EPIC])).toEqual({ ok: true, code: OUD_MOOD, frameIndex: 0 });
  });

  it("skips frames that decoded to nothing", () => {
    expect(pickDecodedBarcode([null, "", OUD_MOOD])).toEqual({ ok: true, code: OUD_MOOD, frameIndex: 2 });
  });

  it("DISCARDS a reading that fails its check digit and uses a later good frame", () => {
    // This is the whole reason three frames are shot instead of one: a decoder
    // that resolves a smudged symbol into a plausible number is caught by the
    // check digit, and the burst carries on rather than accepting it.
    const picked = pickDecodedBarcode([BAD_CHECK, OUD_MOOD]);
    expect(picked).toEqual({ ok: true, code: OUD_MOOD, frameIndex: 1 });
  });

  it("refuses outright when every frame fails the check digit", () => {
    const picked = pickDecodedBarcode([BAD_CHECK, BAD_CHECK, BAD_CHECK]);
    expect(picked.ok).toBe(false);
    expect(picked.message).toMatch(/check digit/i);
  });

  it("refuses when no frame decoded at all, and says so", () => {
    const picked = pickDecodedBarcode([null, null, null]);
    expect(picked.ok).toBe(false);
    expect(picked.reason).toBe("no_symbol");
  });

  it("handles a missing/garbled readings list without throwing", () => {
    expect(pickDecodedBarcode(undefined).ok).toBe(false);
    expect(pickDecodedBarcode([]).ok).toBe(false);
  });
});

describe("decodeFrames — the burst", () => {
  it("decodes each frame's blob in order and returns the first valid one", async () => {
    const decode = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(BAD_CHECK)
      .mockResolvedValueOnce(EPIC);
    const out = await decodeFrames(framesOf(3), { decode });
    expect(out).toEqual({ ok: true, code: EPIC, frameIndex: 2 });
    expect(decode).toHaveBeenCalledTimes(3);
  });

  it("tolerates a frame with no blob", async () => {
    const decode = vi.fn().mockResolvedValue(OUD_MOOD);
    const out = await decodeFrames([{ base64: "x" }, ...framesOf(1)], { decode });
    expect(out.ok).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);   // the blobless frame is not decoded
  });
});

describe("readPrintedDigits — the OCR fallback faces the SAME gate", () => {
  it("accepts a valid UPC/EAN run read off the label", async () => {
    const readLabel = vi.fn().mockResolvedValue({ data: { upc: OUD_MOOD } });
    const out = await readPrintedDigits(framesOf(1), readLabel);
    expect(out).toEqual({ ok: true, code: OUD_MOOD, fromDigits: true });
  });

  it("REFUSES an OCR'd number that fails its check digit — never writes it", async () => {
    // OCR misreading a digit is the failure mode this fallback is most exposed
    // to. A plausible-looking number that no box carries must not get through
    // merely because a human is tired of retaking the photo.
    const readLabel = vi.fn().mockResolvedValue({ data: { upc: BAD_CHECK } });
    const out = await readPrintedDigits(framesOf(1), readLabel);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/check digit/i);
  });

  it("keeps trying later frames when one call throws", async () => {
    const readLabel = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ data: { upc: EPIC } });
    const out = await readPrintedDigits(framesOf(2), readLabel);
    expect(out).toEqual({ ok: true, code: EPIC, fromDigits: true });
  });

  it("prefers a valid later reading over an invalid earlier one", async () => {
    const readLabel = vi.fn()
      .mockResolvedValueOnce({ data: { upc: BAD_CHECK } })
      .mockResolvedValueOnce({ data: { upc: OUD_MOOD } });
    const out = await readPrintedDigits(framesOf(2), readLabel);
    expect(out).toEqual({ ok: true, code: OUD_MOOD, fromDigits: true });
  });

  it("reports a dead end when no frame yields any digits", async () => {
    const readLabel = vi.fn().mockResolvedValue({ data: { upc: "" } });
    const out = await readPrintedDigits(framesOf(2), readLabel);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("no_digits");
    expect(out.message).toMatch(/type it/i);
  });
});
