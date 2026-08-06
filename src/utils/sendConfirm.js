// ─── DISPLAY SEND CONFIRM — the state machine behind the warehouse card ──────
// (Owner fix 2026-08-06.) The old card put the size buttons inline and a single
// tap COMMITTED — no confirm, no undo, and a mis-tap silently stamped the wrong
// size on the order while the card vanished. This machine makes committing a
// three-step deliberate act:
//
//     idle ──OPEN_SEND──▶ size ──PICK_SIZE──▶ confirm ──CONFIRM──▶ commit
//       │                   │                    │
//       └──OPEN_OOS──▶ oos-confirm ──CONFIRM──▶ commit (out of stock)
//     CANCEL from ANY step returns to idle with nothing changed.
//
// PURE on purpose: the ONLY way to obtain a commit directive is the CONFIRM
// action from a confirm step. Picking a size yields no commit; cancelling
// yields no commit; the UI merely renders the state and executes directives.
// That is the property the mutation tests pin.

export function sendFlowInit() {
  return { step: "idle" };
}

export function sendFlowReduce(state, action) {
  const s = state && state.step ? state : sendFlowInit();
  switch (action && action.type) {
    case "OPEN_SEND":
      return { step: "size" };
    case "OPEN_OOS":
      return { step: "oos-confirm" };
    case "PICK_SIZE":
      // Picking a size NEVER commits — it moves to the confirm step, where the
      // operator sees the product and the size in large type first.
      return s.step === "size" && action.size ? { step: "confirm", size: String(action.size) } : s;
    case "CONFIRM":
      if (s.step === "confirm" && s.size) return { step: "idle", commit: { kind: "send", size: s.size } };
      if (s.step === "oos-confirm") return { step: "idle", commit: { kind: "oos" } };
      return s;
    case "CANCEL":
      // From any step: back to the queue, nothing changed.
      return sendFlowInit();
    default:
      return s;
  }
}

/** The large-type confirm line — names the product AND the size AND the hub. */
export function sendConfirmCopy({ productName, size, hubLabel }) {
  return `Sending ${productName || "this product"}, size ${size}${hubLabel ? ` from ${hubLabel}` : ""}`;
}

/** What the post-commit banner shows for a few seconds after the card leaves. */
export function sentBannerCopy(commit, { productName, hubLabel }) {
  if (!commit) return "";
  if (commit.kind === "oos") return `Marked out of stock — ${productName || "product"}`;
  return `Sent — ${productName || "product"}, size ${commit.size}${hubLabel ? ` from ${hubLabel}` : ""}`;
}
