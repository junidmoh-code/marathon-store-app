// Which store's publishing node the browser addresses — see shopifyPublishStore.js.
// Its own module so a test that mocks the store still sees the real target.
//
// THE TARGET CANNOT MOVE UNDER WORK IN FLIGHT (architect review, PR #911).
// Every store call reads the target when it starts, so a batch publish that is
// half-way through would send its remaining products to the OTHER store's node
// if the tab switched. A batch (or any multi-step operation) holds the target
// with holdTarget() for its whole run; switching tabs is refused meanwhile.
export const PUBLISH_TARGETS = Object.freeze({ marathon: "shopify_publish", concrete: "shopify_publish_concrete" });
let target = "marathon";
let holds = 0;
export class TargetBusyError extends Error {
  constructor() { super("A publish is still running — wait for it to finish before switching store."); this.name = "TargetBusyError"; }
}
export function setPublishTarget(t) {
  if (!PUBLISH_TARGETS[t]) throw new Error(`unknown publish target "${t}"`);
  if (t === target) return;
  if (holds > 0) throw new TargetBusyError();
  target = t;
}
export function publishTarget() { return target; }
export const publishNodePath = () => PUBLISH_TARGETS[target];
export const targetBusy = () => holds > 0;
/** Hold the current target until the returned release() is called (idempotent). */
export function holdTarget() {
  holds += 1;
  let released = false;
  return () => { if (!released) { released = true; holds -= 1; } };
}
