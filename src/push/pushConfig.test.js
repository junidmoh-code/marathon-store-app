// ─── THE THREE THINGS THAT MUST STAY TRUE ABOUT THE PUSH WORKER ──────────────
// This suite guards a rollback, not a feature. Service workers were disabled
// app-wide on 2026-05-09 because a caching worker blanked four screens inside
// the installed iOS PWA. Web push needs a worker, so one came back — under
// conditions that are only worth anything if something watches them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  AUDIENCE_ALL,
  AUDIENCE_BUCKETS,
  PUSH_SW_SCOPE,
  PUSH_SW_URL,
  VAPID_PUBLIC_KEY,
  hubLabel,
  pushAudienceEntryPath,
  pushTokenPath,
} from "./pushConfig";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the messaging service worker cannot become the worker that was rolled back", () => {
  const sw = stripComments(read("../../public/firebase-messaging-sw.js"));

  it("registers NO fetch handler — the browser must bypass it for every request", () => {
    expect(sw).not.toMatch(/addEventListener\s*\(\s*["']fetch["']/);
    expect(sw).not.toMatch(/onfetch/);
  });

  it("opens NO cache", () => {
    expect(sw).not.toMatch(/caches\./);
    expect(sw).not.toMatch(/cache\.addAll/);
  });

  it("is scoped to a path no page in this app navigates to", () => {
    expect(PUSH_SW_SCOPE).toBe("/fcm/");
    expect(PUSH_SW_URL).toBe("/firebase-messaging-sw.js");
  });
});

describe("main.jsx still unregisters every OTHER service worker", () => {
  const main = stripComments(read("../main.jsx"));

  it("keeps the blanket unregister sweep", () => {
    expect(main).toMatch(/getRegistrations\(\)/);
    expect(main).toMatch(/\.unregister\(\)/);
  });

  it("spares the messaging worker by name, and nothing else", () => {
    expect(main).toMatch(/firebase-messaging-sw\.js/);
    // The sweep must still be a filter, not a wholesale skip: if the filter
    // ever disappears, every worker survives and the rollback is undone.
    expect(main).toMatch(/\.filter\(/);
  });

  it("still clears every cache", () => {
    expect(main).toMatch(/caches\.delete/);
  });
});

describe("the VAPID key", () => {
  it("is present, so registration cannot silently no-op", () => {
    expect(typeof VAPID_PUBLIC_KEY).toBe("string");
    expect(VAPID_PUBLIC_KEY.length).toBeGreaterThan(80);
  });

  it("is a literal, not a build-time injection of an environment variable", () => {
    // It is a PUBLIC key, so it belongs in source. Reading it from the env via
    // vite would put a KEY-shaped `define` in the build — the exact thing
    // src/noBakedKeys.test.js exists to forbid.
    const cfg = stripComments(read("./pushConfig.js"));
    expect(cfg).not.toMatch(/import\.meta\.env/);
    expect(cfg).not.toMatch(/process\.env/);
  });
});

describe("paths and buckets", () => {
  it("keys tokens per user per device", () => {
    expect(pushTokenPath("u1", "d1")).toBe("push_tokens/u1/d1");
  });

  it("keys audience entries per bucket per user", () => {
    expect(pushAudienceEntryPath("hub1", "u1")).toBe("push_audience/hub1/u1");
  });

  it("includes the wildcard bucket and every destination a request can name", () => {
    expect(AUDIENCE_BUCKETS).toContain(AUDIENCE_ALL);
    for (const dest of ["hub1", "hub2", "marathon-pe", "trophy", "marathon-pine"]) {
      expect(AUDIENCE_BUCKETS).toContain(dest);
    }
  });

  it("labels an unknown hub readably rather than blanking it", () => {
    expect(hubLabel("hub1")).toBe("Hub 1");
    expect(hubLabel("hub9")).toBe("hub9");
    expect(hubLabel(null)).toBe("a hub");
  });
});
