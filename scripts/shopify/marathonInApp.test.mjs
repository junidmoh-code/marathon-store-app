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

// ── THE TWO GUARDS THAT COME FROM A REAL PRODUCTION FAILURE ─────────────────
// Both of these were found by driving the live store, not by reading the code.
//
//   1. /cart/<id>:<qty> does NOT land on the cart page. Shopify forwards it
//      straight to checkout, so the destination browser never runs our script
//      and anything worth recording has to travel IN the URL.
//   2. Loading /cart in the destination browser overwrote the arrival
//      attributes with {browser: standard, escaped: no} — observed live.
describe("handoffUrl — the basket AND the attribution have to travel", () => {
  const items = [{ id: 47733373239445, quantity: 1 }, { id: 111, quantity: 2 }];
  const url = M.handoffUrl("https://marathonclub.co.za", items, "facebook");

  it("is a cart permalink, so the basket is rebuilt in the destination browser", () => {
    expect(url).toContain("/cart/47733373239445:1,111:2");
  });
  it("carries the browser attribution, because the destination never runs our script", () => {
    expect(url).toContain("attributes[browser]=facebook");
  });
  it("carries the arrival stamp, which is the 'it worked' signal", () => {
    expect(url).toContain("attributes[escaped]=arrived-from-facebook");
  });
  it("returns null for an empty basket rather than a bare /cart/ link", () => {
    expect(M.handoffUrl("https://x", [], "facebook")).toBe(null);
    expect(M.handoffUrl("https://x", null, "facebook")).toBe(null);
  });
  it("skips malformed line items instead of emitting 'undefined:undefined'", () => {
    const u = M.handoffUrl("https://x", [{ id: 5, quantity: 1 }, { id: null, quantity: 3 }], "instagram");
    expect(u).toContain("/cart/5:1");
    expect(u).not.toContain("null");
    expect(u).not.toContain("undefined");
  });
});

describe("isArrivalStamp — an arrival must never be clobbered", () => {
  it("recognises an arrival", () => {
    expect(M.isArrivalStamp("arrived-from-facebook")).toBe(true);
    expect(M.isArrivalStamp("arrived-from-instagram")).toBe(true);
  });
  it("does not treat the default stamp as an arrival", () => {
    expect(M.isArrivalStamp("no")).toBe(false);
    expect(M.isArrivalStamp("tapped-android-chrome")).toBe(false);
    expect(M.isArrivalStamp("copied-link")).toBe(false);
  });
  it("survives a missing or non-string value", () => {
    expect(M.isArrivalStamp(undefined)).toBe(false);
    expect(M.isArrivalStamp(null)).toBe(false);
    expect(M.isArrivalStamp(123)).toBe(false);
  });
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
