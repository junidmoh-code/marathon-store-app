// ─── THE STAFF SWITCH — a MUTE, and it must never look like it is working ────
// Mutation-proven by scripts/mutation-proof-push-notify.mjs (T1–T4).
//
// Two failures are pinned here, and the second is what this release exists for.
//
//   1. A SWITCH THAT LOOKS ON WHILE NOTHING ARRIVES. Permission denied is the
//      case that matters: the browser will never prompt again, no amount of
//      tapping fixes it, and the only remedy is in site settings. A switch
//      sitting in the on position over that is worse than no switch.
//   2. A SWITCH THAT GRANTS. #569's version was an OPT-IN, load-bearing for
//      delivery — a person had to find it before an assignment could reach
//      them. Turning this one on writes an address and clears a veto. It puts
//      nobody in a hub audience, and no rule would let it.
//
// Rendered through react-test-renderer, like every other component test here.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import NotificationSettingsRow from "./NotificationSettingsRow";
import { PUSH_STATE } from "./registerPush";

const PUSH = (over = {}) => ({
  uid: "u1", state: PUSH_STATE.ON, busy: false,
  enablePush: vi.fn(async () => PUSH_STATE.ON),
  ...over,
});
const MUTE = (over = {}) => ({
  muted: false, known: true, busy: false, error: null,
  setMuted: vi.fn(async () => true),
  ...over,
});

const render = async (push, mute) => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<NotificationSettingsRow push={push} mute={mute} />); });
  return tree;
};
const text = (tree) => {
  const walk = (n) => {
    if (n === null || n === undefined || n === false) return "";
    if (Array.isArray(n)) return n.map(walk).join("");
    if (typeof n === "object") return walk(n.children);
    return String(n);
  };
  return walk(tree.toJSON());
};
const sw = (tree) => tree.root.findAll((n) => n.props && n.props.role === "switch")[0];

describe("the switch shows the OUTCOME, not the intention", () => {
  it("registered and not muted is ON", async () => {
    expect(sw(await render(PUSH(), MUTE())).props["aria-checked"]).toBe(true);
  });

  it("muted is OFF, however healthy the device", async () => {
    expect(sw(await render(PUSH(), MUTE({ muted: true }))).props["aria-checked"]).toBe(false);
  });

  it("A DENIED PERMISSION IS OFF — it must not sit there looking on while doing nothing", async () => {
    // The single most important assertion in this file. This person has not
    // muted themselves, so their INTENTION is on; their browser refuses, so
    // nothing arrives. The switch reports the second.
    const tree = await render(PUSH({ state: PUSH_STATE.BLOCKED }), MUTE({ muted: false }));
    expect(sw(tree).props["aria-checked"]).toBe(false);
  });

  it("every non-working state is OFF, not just the blocked one", async () => {
    for (const state of [PUSH_STATE.BLOCKED, PUSH_STATE.NEEDS_PERMISSION, PUSH_STATE.NEEDS_INSTALL,
      PUSH_STATE.UNSUPPORTED, PUSH_STATE.MISCONFIGURED, PUSH_STATE.ERROR, null]) {
      const tree = await render(PUSH({ state }), MUTE());
      expect(sw(tree).props["aria-checked"], `${state} must not render as on`).toBe(false);
    }
  });
});

describe("it says WHY, in words a person can act on", () => {
  it("BLOCKED names the browser, both platforms, and admits the switch cannot fix it", async () => {
    const t = text(await render(PUSH({ state: PUSH_STATE.BLOCKED }), MUTE()));
    expect(t).toContain("blocked");
    expect(t).toContain("Settings");        // the iPhone path
    expect(t).toContain("Site settings");   // the Android Chrome path
    expect(t).toContain("This switch cannot undo it.");
  });

  it("an iPhone in a tab is told to install, not that something is broken", async () => {
    expect(text(await render(PUSH({ state: PUSH_STATE.NEEDS_INSTALL }), MUTE())))
      .toContain("Add to Home Screen");
  });

  it("never asked is told there is one tap left", async () => {
    expect(text(await render(PUSH({ state: PUSH_STATE.NEEDS_PERMISSION }), MUTE())))
      .toContain("One tap left");
  });

  it("a muted person is told they are muted, and that an assignment will not override it", async () => {
    const t = text(await render(PUSH(), MUTE({ muted: true })));
    expect(t).toContain("Muted");
    expect(t).toContain("assigned");
  });

  it("A REFUSED SAVE IS NAMED, not swallowed", async () => {
    const t = text(await render(PUSH(), MUTE({ error: { kind: "write", message: "PERMISSION_DENIED" } })));
    expect(t).toContain("PERMISSION_DENIED");
    expect(t).toContain("Couldn't save");
  });

  it("A REFUSED READ IS NOT CALLED A FAILED SAVE — they saved nothing", async () => {
    // What everybody saw before PUSH-MUTE-RULE-DEPLOY.md was pasted. Telling
    // somebody their save failed when they had not saved anything sends them
    // looking for a tap they never made.
    const t = text(await render(PUSH(), MUTE({ error: { kind: "read", message: "PERMISSION_DENIED" }, known: false })));
    expect(t).toContain("couldn't be read");
    expect(t).not.toContain("Couldn't save");
    expect(t).toContain("tell Junid");
  });

  it("a muted person is told they are MUTED even when the device is also blocked", async () => {
    // Trouble used to win outright, so the mute went unmentioned — and the tap
    // that followed silently unmuted them with no visible change at all.
    const t = text(await render(PUSH({ state: PUSH_STATE.BLOCKED }), MUTE({ muted: true })));
    expect(t).toContain("Muted");
    expect(t).toContain("blocked");
  });

  it("does not claim 'On' while registration is still in flight", async () => {
    const t = text(await render(PUSH({ state: null }), MUTE()));
    expect(t).toContain("Setting up");
    expect(t).not.toContain("you'll be alerted");
  });

  it("a working row says what it does, without a warning", async () => {
    const t = text(await render(PUSH(), MUTE()));
    expect(t).toContain("you'll be alerted");
    expect(t).not.toContain("blocked");
  });
});

describe("what a tap actually does", () => {
  it("ON asks for permission FIRST — it is the half that needs the gesture", async () => {
    const push = PUSH({ state: PUSH_STATE.NEEDS_PERMISSION });
    const mute = MUTE({ muted: true });
    await act(async () => { sw(await render(push, mute)).props.onClick(); });
    expect(push.enablePush).toHaveBeenCalled();
  });

  it("ON clears the mute", async () => {
    const push = PUSH({ state: PUSH_STATE.NEEDS_PERMISSION });
    const mute = MUTE({ muted: true });
    await act(async () => { sw(await render(push, mute)).props.onClick(); });
    expect(mute.setMuted).toHaveBeenCalledWith(false);
  });

  it("ON CLEARS THE MUTE EVEN WHEN PERMISSION IS REFUSED", async () => {
    // "I want these" is what they said, and storing it means the day they fix
    // site settings it simply works with nothing further to find. A mute left
    // standing behind a denied prompt is a second, invisible reason they hear
    // nothing.
    const push = PUSH({ state: PUSH_STATE.NEEDS_PERMISSION, enablePush: vi.fn(async () => PUSH_STATE.BLOCKED) });
    const mute = MUTE({ muted: true });
    await act(async () => { sw(await render(push, mute)).props.onClick(); });
    expect(mute.setMuted).toHaveBeenCalledWith(false);
  });

  it("OFF writes the mute and asks for nothing", async () => {
    const push = PUSH();
    const mute = MUTE();
    await act(async () => { sw(await render(push, mute)).props.onClick(); });
    expect(mute.setMuted).toHaveBeenCalledWith(true);
    expect(push.enablePush).not.toHaveBeenCalled();
  });

  it("A GRANTED, UNMUTED PERSON WHO TAPS IS MUTED — not re-prompted", async () => {
    const push = PUSH();
    const mute = MUTE();
    await act(async () => { sw(await render(push, mute)).props.onClick(); });
    expect(mute.setMuted).toHaveBeenCalledWith(true);
  });

  it("an already-audible person tapping a BLOCKED row re-asks and writes no mute", async () => {
    // The switch reads off (correctly), so a tap is a request to turn it ON.
    // They are not muted, so there is nothing to unmute — and it must not
    // MUTE them, which is what a naive "toggle the record" would do.
    const push = PUSH({ state: PUSH_STATE.BLOCKED });
    const mute = MUTE({ muted: false });
    await act(async () => { sw(await render(push, mute)).props.onClick(); });
    expect(push.enablePush).toHaveBeenCalled();
    expect(mute.setMuted).not.toHaveBeenCalled();
  });
});

describe("it grants nothing, and it cannot be tapped from an unknown baseline", () => {
  it("IS NOT DISABLED BY AN UNREADABLE SETTING — that locked the permission request itself", async () => {
    // The near-miss Fable caught. Gating the whole control on `known` put the
    // app one refused /push_mutes read away from the original outage: no
    // prompt reachable, from a node that has nothing to do with prompting.
    expect(sw(await render(PUSH(), MUTE({ known: false }))).props.disabled).toBe(false);
  });

  it("but WRITES NO MUTE from an unknown baseline — it only asks for permission", async () => {
    const push = PUSH();
    const mute = MUTE({ known: false });
    await act(async () => { sw(await render(push, mute)).props.onClick(); });
    expect(push.enablePush).toHaveBeenCalled();
    expect(mute.setMuted).not.toHaveBeenCalled();
  });

  it("is disabled while a write is in flight", async () => {
    expect(sw(await render(PUSH(), MUTE({ busy: true }))).props.disabled).toBe(true);
    expect(sw(await render(PUSH({ busy: true }), MUTE())).props.disabled).toBe(true);
  });

  it("offers an explicit way to mute from a device that cannot receive", async () => {
    // The account-wide mute must be reachable from the shop desktop, where this
    // browser is unsupported. Driving the tap off the rendered switch made that
    // impossible — every tap read as "turn it on" and never wrote the mute,
    // while their phone kept ringing.
    const mute = MUTE({ muted: false });
    const tree = await render(PUSH({ state: PUSH_STATE.UNSUPPORTED }), mute);
    const link = tree.root.findAll((n) => n.props && typeof n.props.onClick === "function"
      && n.props.role !== "switch")[0];
    await act(async () => { link.props.onClick(); });
    expect(mute.setMuted).toHaveBeenCalledWith(true);
  });

  it("does not offer it on a healthy row — that is what the switch is for", async () => {
    const tree = await render(PUSH(), MUTE());
    expect(text(tree)).not.toContain("Silence alerts on all my devices");
  });

  it("a disabled switch does nothing when its handler is called anyway", async () => {
    const push = PUSH();
    const mute = MUTE({ busy: true });
    await act(async () => { sw(await render(push, mute)).props.onClick(); });
    expect(mute.setMuted).not.toHaveBeenCalled();
    expect(push.enablePush).not.toHaveBeenCalled();
  });

  it("renders nothing at all when signed out", async () => {
    expect((await render(PUSH({ uid: null }), MUTE())).toJSON()).toBe(null);
    expect((await render(null, MUTE())).toJSON()).toBe(null);
    expect((await render(PUSH(), null)).toJSON()).toBe(null);
  });
});
