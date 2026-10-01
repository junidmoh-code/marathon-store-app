import { describe, it, expect } from "vitest";
import { describeDevice } from "./deviceLabel";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

describe("describeDevice", () => {
  it("names the OS, the browser, and whether it is the installed copy", () => {
    expect(describeDevice({ userAgent: IPHONE, deviceId: "4f2c9a11", standalone: true }))
      .toBe("iPhone Safari · installed · 4f2c");
  });

  it("does not mistake a Chromium browser for Safari", () => {
    expect(describeDevice({ userAgent: ANDROID_CHROME, deviceId: "abcd", standalone: false }))
      .toBe("Android Chrome · browser · abcd");
    expect(describeDevice({ userAgent: WINDOWS_CHROME, deviceId: "abcd", standalone: false }))
      .toBe("Windows Chrome · browser · abcd");
  });

  it("survives a browser with no device id (private mode) rather than throwing", () => {
    expect(describeDevice({ userAgent: IPHONE, deviceId: null, standalone: false }))
      .toBe("iPhone Safari · browser · nodev");
  });

  it("degrades to generic words on an unrecognised agent", () => {
    expect(describeDevice({ userAgent: "something-else", deviceId: "zzzz" }))
      .toBe("Device Browser · browser · zzzz");
  });
});
