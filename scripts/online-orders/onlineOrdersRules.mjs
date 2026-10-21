// ── The online-orders rules, as one patch over a rules document ─────────────
// docs/ONLINE-ORDERS-RULES.json is the block Junid pastes as SIBLINGS under
// the top-level "rules" key. The staff switch is the one exception: it lives
// INSIDE the existing "config" node (config/onlineOrders), so it is a single
// child added there — pasting a second "config" key would replace the whole
// existing config block. prove-online-orders-rules.mjs runs this exact patch.
import { readFileSync } from "node:fs";

export const OWNER_EMAIL = "gunidmoh@gmail.com";
export const BLOCK = JSON.parse(readFileSync(new URL("../../docs/ONLINE-ORDERS-RULES.json", import.meta.url), "utf8"));
export const CONFIG_CHILD = {
  onlineOrders: {
    ".write": `auth != null && auth.token.email === '${OWNER_EMAIL}' && auth.token.email_verified === true`,
  },
};

export function patchOnlineOrdersRules(doc) {
  const out = JSON.parse(JSON.stringify(doc));
  for (const [k, v] of Object.entries(BLOCK)) out.rules[k] = v;
  out.rules.config = { ...(out.rules.config || {}), ...CONFIG_CHILD };
  return out;
}
