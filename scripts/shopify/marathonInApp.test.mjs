// ── THE IN-APP DETECTION IS TESTED AS THE ARTIFACT THAT SHIPS ────────────────
// This reads theme/assets/marathon-inapp.js off disk and evaluates it, rather
// than importing a second copy of the logic. A test that mirrors its subject
// passes happily while the shipped file rots.
//
// The user agents below are REAL strings, not invented ones: Facebook and
// Instagram in-app browsers on both platforms, plus the ordinary mobile and
// desktop browsers that must NOT be caught.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import vm from "node:vm";

const SRC = fileURLToPath(
  new URL("../../theme/assets/marathon-inapp.js", import.meta.url)
);

function load() {
  const code = readFileSync(SRC, "utf8");
  const sandbox = { window: {}, module: { exports: {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.MarathonInApp;
}

const M = load();

// ── real user agents ─────────────────────────────────────────────────────────
const UA = {
  fbAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.144 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.38.109;]",
  fbIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 [FBAN/FBIOS;FBDV/iPhone14,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5.1;FBSS/3;FBID/phone;FBLC/en_GB;FBOP/5]",
  igAndroid:
    "Mozilla/5.0 (Linux; Android 12; Pixel 5 Build/SP2A.220505.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.113 Android",
  igIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 328.0.0.44.90",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.144 Mobile Safari/537.36",
  safariIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
};

describe("isInAppBrowser — catches the ones we can help", () => {
  it("Facebook on Android", () => expect(M.isInAppBrowser(UA.fbAndroid)).toBe(true));
  it("Facebook on iOS", () => expect(M.isInAppBrowser(UA.fbIos)).toBe(true));
  it("Instagram on Android", () => expect(M.isInAppBrowser(UA.igAndroid)).toBe(true));
  it("Instagram on iOS", () => expect(M.isInAppBrowser(UA.igIos)).toBe(true));
});

describe("isInAppBrowser — never fires on a real browser", () => {
  it("Chrome on Android is NOT in-app", () =>
    expect(M.isInAppBrowser(UA.chromeAndroid)).toBe(false));
  it("Safari on iOS is NOT in-app", () =>
    expect(M.isInAppBrowser(UA.safariIos)).toBe(false));
  it("desktop Chrome is NOT in-app", () =>
    expect(M.isInAppBrowser(UA.desktop)).toBe(false));
  it("an empty or absent UA is NOT in-app", () => {
    expect(M.isInAppBrowser("")).toBe(false);
    expect(M.isInAppBrowser(undefined)).toBe(false);
    expect(M.isInAppBrowser(null)).toBe(false);
  });
  // A false positive is worse than a miss: it shows an "escape" panel to
  // somebody already in Chrome. "wv" alone is set by plenty of legitimate
  // Android browsers, so it must never be a trigger on its own.
  it("the bare Android WebView marker 'wv' is not a trigger by itself", () => {
    const bareWv =
      "Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0 Mobile Safari/537.36";
    expect(M.isInAppBrowser(bareWv)).toBe(false);
  });
});

describe("inAppSource — labels the cart attribute", () => {
  it("facebook", () => expect(M.inAppSource(UA.fbAndroid)).toBe("facebook"));
  it("facebook on iOS too", () => expect(M.inAppSource(UA.fbIos)).toBe("facebook"));
  it("instagram", () => expect(M.inAppSource(UA.igAndroid)).toBe("instagram"));
  it("standard for a real browser", () =>
    expect(M.inAppSource(UA.chromeAndroid)).toBe("standard"));
});

describe("platform — decides whether a button can work at all", () => {
  it("iOS is iOS", () => expect(M.platform(UA.fbIos)).toBe("ios"));
  it("Android is Android", () => expect(M.platform(UA.fbAndroid)).toBe("android"));
  it("desktop is neither", () => expect(M.platform(UA.desktop)).toBe("other"));
});

describe("androidIntentUrl — must name Chrome explicitly", () => {
  const url = "https://marathonclub.co.za/cart";
  it("builds an intent:// URL", () =>
    expect(M.androidIntentUrl(url)).toMatch(/^intent:\/\/marathonclub\.co\.za\/cart#Intent;/));
  it("names the Chrome package — an unqualified intent resolves back to the same WebView", () =>
    expect(M.androidIntentUrl(url)).toContain("package=com.android.chrome"));
  it("carries a fallback URL so a phone without Chrome still goes somewhere", () =>
    expect(M.androidIntentUrl(url)).toContain(
      "S.browser_fallback_url=" + encodeURIComponent(url)
    ));
  it("does not double the scheme", () =>
    expect(M.androidIntentUrl(url)).not.toContain("intent://https://"));
});
