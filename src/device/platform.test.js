import { describe, it, expect } from "vitest";
import {
  detectPlatform,
  isDesktopPlatform,
  isMobilePlatform,
  isNarrowFor,
  narrowBreakpointFor,
  DESKTOP_NARROW_FLOOR,
} from "./platform";

// The regression this locks in (2026-08-01): the shop's Proline POS terminals —
// Windows x64, 10-point touchscreen, 1024x600 panel — were getting the phone UI,
// because the desktop workspaces switched on viewport width alone and
// `(max-width: 1024px)` matches at exactly 1024. Platform must come from the OS,
// so no panel size, touchscreen or display-scaling setting can downgrade a
// computer. Phones and Android tablets must still classify as mobile.

// Only the fields detectPlatform is allowed to read.
const nav = ({ ua = "", uaData, maxTouchPoints = 0 } = {}) => ({
  userAgent: ua,
  userAgentData: uaData,
  maxTouchPoints,
});

const UA = {
  prolineTill:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  chromeOS:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  androidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  // Android tablets drop the "Mobile" token — the classic sniffing miss.
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ in its default "desktop site" mode claims to be a Macintosh.
  ipadDesktopMode:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
};

describe("the Proline Windows POS terminal is a computer", () => {
  it("is a desktop even with a 10-point touchscreen", () => {
    expect(detectPlatform(nav({ ua: UA.prolineTill, maxTouchPoints: 10 }))).toBe("desktop");
  });

  it("is a desktop via Chromium client hints", () => {
    const uaData = { mobile: false, platform: "Windows" };
    expect(detectPlatform(nav({ ua: UA.prolineTill, uaData, maxTouchPoints: 10 }))).toBe("desktop");
  });

  it("stays a desktop even if a client hint wrongly claims mobile", () => {
    const uaData = { mobile: true, platform: "Windows" };
    expect(detectPlatform(nav({ ua: UA.prolineTill, uaData, maxTouchPoints: 10 }))).toBe("desktop");
  });
});

describe("other computers get the desktop workspace", () => {
  it.each([
    ["macOS", UA.mac, 0],
    ["Linux", UA.linux, 0],
    ["ChromeOS", UA.chromeOS, 0],
    ["Windows 2-in-1 with touch", UA.prolineTill, 10],
  ])("%s is a desktop", (_label, ua, maxTouchPoints) => {
    expect(isDesktopPlatform(nav({ ua, maxTouchPoints }))).toBe(true);
  });

  it("does not mistake a real Mac for an iPad", () => {
    expect(detectPlatform(nav({ ua: UA.ipadDesktopMode, maxTouchPoints: 0 }))).toBe("desktop");
  });

  it("falls back to desktop for an unrecognised or empty user agent", () => {
    expect(detectPlatform(nav({ ua: "SomeKioskBrowser/1.0" }))).toBe("desktop");
    expect(detectPlatform(nav({ ua: "" }))).toBe("desktop");
  });

  it("falls back to desktop when there is no navigator at all", () => {
    expect(detectPlatform(undefined)).toBe("desktop");
  });
});

// The layout floor. A computer holds the desktop layout well below the phone
// breakpoint — but a genuinely small window must still stack, which is the
// behaviour that went missing when a computer was simply "never narrow".
describe("isNarrowFor — the per-platform breakpoint", () => {
  const BP = 1024; // what the desktop workspaces pass

  it("keeps the 1024x600 Proline till on the desktop layout", () => {
    // The original bug: 1024 <= 1024 matched, so the till got the phone UI.
    expect(isNarrowFor("desktop", 1024, BP)).toBe(false);
  });

  it("keeps the till on desktop at 125% Windows scaling (819px)", () => {
    expect(isNarrowFor("desktop", 819, BP)).toBe(false);
  });

  it("STILL stacks a computer once the window is genuinely small", () => {
    expect(isNarrowFor("desktop", 700, BP)).toBe(true);
    expect(isNarrowFor("desktop", 500, BP)).toBe(true);
  });

  it("switches a computer exactly at the floor, not before", () => {
    expect(isNarrowFor("desktop", DESKTOP_NARROW_FLOOR + 1, BP)).toBe(false);
    expect(isNarrowFor("desktop", DESKTOP_NARROW_FLOOR, BP)).toBe(true);
  });

  it("leaves phones and tablets on their own breakpoint", () => {
    expect(isNarrowFor("mobile", 1024, BP)).toBe(true);   // iPad landscape: mobile UI
    expect(isNarrowFor("mobile", 820, BP)).toBe(true);
    expect(isNarrowFor("mobile", 1200, BP)).toBe(false);
  });

  it("never RAISES a caller's breakpoint for a computer", () => {
    // A caller asking for 700 keeps 700 — the floor is a maximum, not a default.
    expect(narrowBreakpointFor("desktop", 700)).toBe(700);
    expect(narrowBreakpointFor("desktop", 1024)).toBe(DESKTOP_NARROW_FLOOR);
    expect(narrowBreakpointFor("mobile", 1024)).toBe(1024);
  });

  it("is defensive about a missing width", () => {
    expect(isNarrowFor("desktop", undefined, BP)).toBe(true);
  });
});

describe("phones and tablets keep the mobile UI", () => {
  it.each([
    ["Android phone", UA.androidPhone, 5],
    ["Android tablet (no Mobile token)", UA.androidTablet, 10],
    ["iPhone", UA.iphone, 5],
  ])("%s is mobile", (_label, ua, maxTouchPoints) => {
    expect(isMobilePlatform(nav({ ua, maxTouchPoints }))).toBe(true);
  });

  it("classifies an Android tablet as mobile via client hints too", () => {
    const uaData = { mobile: false, platform: "Android" }; // tablets report mobile:false
    expect(detectPlatform(nav({ ua: UA.androidTablet, uaData, maxTouchPoints: 10 }))).toBe("mobile");
  });

  it("sees through iPadOS desktop mode (Mac UA + multi-touch)", () => {
    expect(detectPlatform(nav({ ua: UA.ipadDesktopMode, maxTouchPoints: 5 }))).toBe("mobile");
  });
});
