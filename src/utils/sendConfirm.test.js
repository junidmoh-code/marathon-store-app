// ─── DISPLAY SEND CONFIRM — "a size cannot be sent without an explicit ────────
// confirm", proven against the exact machine the card renders.

import { describe, it, expect } from "vitest";
import { sendFlowInit, sendFlowReduce, sendConfirmCopy, sentBannerCopy } from "./sendConfirm";

const run = (actions) => actions.reduce(sendFlowReduce, sendFlowInit());

describe("only Confirm commits", () => {
  it("picking a size does NOT commit — it opens the confirm step", () => {
    const s = run([{ type: "OPEN_SEND" }, { type: "PICK_SIZE", size: "8" }]);
    expect(s.step).toBe("confirm");
    expect(s.size).toBe("8");
    expect(s.commit).toBeUndefined();
  });

  it("the commit directive exists ONLY after CONFIRM from the confirm step", () => {
    const s = run([{ type: "OPEN_SEND" }, { type: "PICK_SIZE", size: "8" }, { type: "CONFIRM" }]);
    expect(s.commit).toEqual({ kind: "send", size: "8" });
    // CONFIRM from anywhere else yields nothing:
    expect(run([{ type: "CONFIRM" }]).commit).toBeUndefined();
    expect(run([{ type: "OPEN_SEND" }, { type: "CONFIRM" }]).commit).toBeUndefined();
  });

  it("Cancel changes nothing, from every step", () => {
    for (const path of [
      [{ type: "OPEN_SEND" }, { type: "CANCEL" }],
      [{ type: "OPEN_SEND" }, { type: "PICK_SIZE", size: "8" }, { type: "CANCEL" }],
      [{ type: "OPEN_OOS" }, { type: "CANCEL" }],
    ]) {
      const s = run(path);
      expect(s).toEqual({ step: "idle" });
      expect(s.commit).toBeUndefined();
    }
    // …and a Cancel-then-Confirm cannot resurrect the abandoned intent:
    expect(run([{ type: "OPEN_SEND" }, { type: "PICK_SIZE", size: "8" }, { type: "CANCEL" }, { type: "CONFIRM" }]).commit).toBeUndefined();
  });

  it("Out of Stock gets the same treatment — its own confirm step", () => {
    const mid = run([{ type: "OPEN_OOS" }]);
    expect(mid.step).toBe("oos-confirm");
    expect(mid.commit).toBeUndefined();
    expect(run([{ type: "OPEN_OOS" }, { type: "CONFIRM" }]).commit).toEqual({ kind: "oos" });
  });

  it("no inline path exists from idle to a commit", () => {
    // A PICK_SIZE that never went through OPEN_SEND is inert — the exact
    // "size buttons sit inline and commit" defect this machine removes.
    expect(run([{ type: "PICK_SIZE", size: "8" }])).toEqual({ step: "idle" });
  });
});

describe("copy", () => {
  it("the confirm line names the product, the size and the hub in one sentence", () => {
    expect(sendConfirmCopy({ productName: "Nike Air Force 1 Cream Black Grey", size: "8", hubLabel: "Hub 1" }))
      .toBe("Sending Nike Air Force 1 Cream Black Grey, size 8 from Hub 1");
  });
  it("the post-commit banner says what was actually done", () => {
    expect(sentBannerCopy({ kind: "send", size: "8" }, { productName: "AF1", hubLabel: "Hub 1" }))
      .toBe("Sent — AF1, size 8 from Hub 1");
    expect(sentBannerCopy({ kind: "oos" }, { productName: "AF1" })).toMatch(/out of stock/i);
  });
});
