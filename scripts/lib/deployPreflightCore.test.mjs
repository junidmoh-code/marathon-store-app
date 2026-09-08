// The preflight's decisions, driven directly. The script itself was proven
// end-to-end against the real Firebase CLI (it aborts both the hosting and the
// functions route with `predeploy error`), but end-to-end proof cannot stage a
// live build from an unpushed commit or a rollback, and those are exactly the
// cases a future edit is most likely to break.
import { describe, it, expect } from "vitest";
import { preflightDecision, liveShaFrom, REFUSAL } from "./deployPreflightCore.mjs";

const clean = {
  dirty: "", behindMain: 0, liveSha: "abc1234", liveKnown: true,
  behindLive: 0, ackNoLive: false, functionsOnly: false,
};

describe("the two refusals that can never be overridden", () => {
  it("a dirty tree refuses, even with the ack set", () => {
    expect(preflightDecision({ ...clean, dirty: " M src/App.jsx" }).refusal).toBe(REFUSAL.DIRTY);
    expect(preflightDecision({ ...clean, dirty: "?? scratch.txt", ackNoLive: true }).refusal).toBe(REFUSAL.DIRTY);
  });

  it("behind main refuses, even with the ack set", () => {
    expect(preflightDecision({ ...clean, behindMain: 1 }).refusal).toBe(REFUSAL.BEHIND_MAIN);
    expect(preflightDecision({ ...clean, behindMain: 9, ackNoLive: true }).refusal).toBe(REFUSAL.BEHIND_MAIN);
  });

  it("and they refuse a FUNCTIONS deploy too — the git invariants are not hosting's", () => {
    expect(preflightDecision({ ...clean, functionsOnly: true, dirty: " M x" }).refusal).toBe(REFUSAL.DIRTY);
    expect(preflightDecision({ ...clean, functionsOnly: true, behindMain: 2 }).refusal).toBe(REFUSAL.BEHIND_MAIN);
  });

  it("dirty is reported ahead of behind-main when both are true", () => {
    // Both are fatal; the message must name the one the deployer fixes first.
    expect(preflightDecision({ ...clean, dirty: " M a", behindMain: 3 }).refusal).toBe(REFUSAL.DIRTY);
  });

  it("whitespace-only porcelain output is NOT dirty", () => {
    expect(preflightDecision({ ...clean, dirty: "\n  \n" }).ok).toBe(true);
  });
});

describe("liveness", () => {
  it("unreadable liveness refuses by default", () => {
    expect(preflightDecision({ ...clean, liveSha: null }).refusal).toBe(REFUSAL.NO_LIVE);
  });

  it("...and is the ONE case the ack covers", () => {
    const d = preflightDecision({ ...clean, liveSha: null, ackNoLive: true });
    expect(d.ok).toBe(true);
    expect(d.liveUnverified).toBe(true);
  });

  it("a live commit this repo does not contain refuses, and the ack does NOT cover it", () => {
    expect(preflightDecision({ ...clean, liveKnown: false }).refusal).toBe(REFUSAL.LIVE_UNKNOWN);
    expect(preflightDecision({ ...clean, liveKnown: false, ackNoLive: true }).refusal).toBe(REFUSAL.LIVE_UNKNOWN);
  });

  it("a live build AHEAD of this checkout refuses — that is a rollback", () => {
    expect(preflightDecision({ ...clean, behindLive: 1 }).refusal).toBe(REFUSAL.ROLLBACK);
    expect(preflightDecision({ ...clean, behindLive: 4, ackNoLive: true }).refusal).toBe(REFUSAL.ROLLBACK);
  });

  it("a functions deploy skips liveness entirely, unreadable or not", () => {
    expect(preflightDecision({ ...clean, functionsOnly: true, liveSha: null }).ok).toBe(true);
    expect(preflightDecision({ ...clean, functionsOnly: true, liveKnown: false }).ok).toBe(true);
    expect(preflightDecision({ ...clean, functionsOnly: true, behindLive: 5 }).ok).toBe(true);
  });
});

describe("the happy path", () => {
  it("clean, current, live known and not ahead -> passes", () => {
    expect(preflightDecision(clean)).toEqual({ ok: true });
  });

  it("a pure rebuild of the live commit passes", () => {
    expect(preflightDecision({ ...clean, behindLive: 0 }).ok).toBe(true);
  });

  it("THE DEFAULTS FAIL CLOSED — an empty call refuses, it does not wave through", () => {
    // A caller that forgets to gather a fact must not get a pass. With no
    // liveSha supplied there is nothing to diff against, so the answer is the
    // same refusal an unreachable site gets. This is the property that makes a
    // future edit to the script safe: dropping a field breaks the deploy
    // loudly rather than disarming the guard silently.
    const d = preflightDecision({});
    expect(d.ok).toBe(false);
    expect(d.refusal).toBe(REFUSAL.NO_LIVE);
  });

  it("...and a functions-only empty call passes, because liveness is not its subject", () => {
    expect(preflightDecision({ functionsOnly: true }).ok).toBe(true);
  });
});

describe("liveShaFrom reads the build stamp vite writes", () => {
  it("takes the sha from `<sha>.<epoch>`", () => {
    expect(liveShaFrom({ version: "43e29b8a.1788898252675" })).toBe("43e29b8a");
    expect(liveShaFrom({ version: "6644a67.1788896740343" })).toBe("6644a67");
  });

  it("refuses anything that is not a sha, rather than returning a half-truth", () => {
    for (const v of [undefined, null, "", "dev", "nogit.123", "zzzz.1", 42, {}, []]) {
      expect(liveShaFrom({ version: v }), String(v)).toBe(null);
    }
    expect(liveShaFrom(null)).toBe(null);
    expect(liveShaFrom({})).toBe(null);
  });

  it("`dev` and `nogit` builds are not a live sha — a dev build must never be diffed against", () => {
    expect(liveShaFrom({ version: "dev" })).toBe(null);
    expect(liveShaFrom({ version: "nogit.1788896740343" })).toBe(null);
  });
});
