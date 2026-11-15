// Which store's publishing node the browser addresses — see shopifyPublishStore.js.
// Its own module so a test that mocks the store still sees the real target.
export const PUBLISH_TARGETS = Object.freeze({ marathon: "shopify_publish", concrete: "shopify_publish_concrete" });
let target = "marathon";
export function setPublishTarget(t) {
  if (!PUBLISH_TARGETS[t]) throw new Error(`unknown publish target "${t}"`);
  target = t;
}
export function publishTarget() { return target; }
export const publishNodePath = () => PUBLISH_TARGETS[target];
