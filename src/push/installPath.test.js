// ─── THE INSTALL PATH ────────────────────────────────────────────────────────
// Web push on iPhone works ONLY from the Home Screen copy. That makes the
// manifest and the hosting headers part of this feature rather than background
// PWA housekeeping, and both carry a defect class worth pinning.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const json = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

describe("the manifest installs THIS app", () => {
  const m = json("../../public/manifest.json");

  it("opens the store app, at its root", () => {
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.name).toBe("Marathon Club");
  });

  it("pins an explicit id, so a start_url change cannot mint a SECOND install", () => {
    // Without `id`, install identity is DERIVED from start_url. Change start_url
    // and the browser treats it as a different app: a second icon appears and
    // the original keeps opening the old URL — the same shape as the POS app's
    // known "installing yields the wrong screen" defect. This PR introduces
    // query-string deep links on "/", which is exactly when that bites.
    expect(m.id).toBe("/");
  });

  it("ships every icon it names", () => {
    for (const icon of m.icons) {
      expect(() => readFileSync(new URL(`../../public${icon.src}`, import.meta.url))).not.toThrow();
    }
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
});

describe("hosting headers", () => {
  const cfg = json("../../firebase.json");
  const headersFor = (source) =>
    cfg.hosting.headers.filter((h) => h.source === source).flatMap((h) => h.headers);

  it("the push worker is NEVER cached", () => {
    // The catch-all "**/*.@(js|css)" rule sets max-age=31536000, immutable — and
    // it matches firebase-messaging-sw.js. Without a later, more specific rule
    // the push worker would freeze on staff devices for a YEAR, and no deploy
    // could reach it. /service-worker.js already had this exemption; the new
    // worker needs its own.
    const cc = headersFor("/firebase-messaging-sw.js").find((h) => h.key === "Cache-Control");
    expect(cc, "no Cache-Control override for /firebase-messaging-sw.js").toBeTruthy();
    expect(cc.value).toMatch(/no-store/);
  });

  it("that override comes AFTER the immutable js rule, which is what makes it win", () => {
    const idx = (source) => cfg.hosting.headers.findIndex((h) => h.source === source);
    expect(idx("/firebase-messaging-sw.js")).toBeGreaterThan(idx("**/*.@(js|css)"));
  });
});
