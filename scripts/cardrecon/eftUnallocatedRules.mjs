// ─── THE UNALLOCATED-REMAINDER RULE — ONE DEFINITION ─────────────────────────
// /eft_unallocated holds the remainders of consumed EFT payments that settled
// sales WITH NO CUSTOMER attached — money the shop owes someone it cannot yet
// name. Written only by the Admin SDK (functions/eftPool/eftPool.js
// finishRemainder; removed by allocate/reverse); the owner's panel reads it
// WHOLE, which is safe because resolving an entry removes it — the node's size
// is the owner's backlog, not history.
//
// Same discipline as eftRules.mjs: printed AND applied from here
// (apply-eft-unallocated-rules.mjs). `database.rules.json` in this repo is NOT
// deployed and must not be edited — the live document is patched through the
// `.settings/rules.json` REST endpoint with the house method.
import { OWNER } from "./intakeRules.mjs";

const ownerOnly = `auth != null && auth.token.email === '${OWNER}'`;

export const EFT_UNALLOCATED_RULE_BLOCKS = {
  // Owner-only read, like /eft_pool: an entry names a payer, an amount and a
  // slip. ".write": "false" is the guarantee nothing but the Admin SDK writes
  // here — the same wall every recon node carries.
  eft_unallocated: {
    ".read": ownerOnly,
    ".write": "false",
  },
};

export const RATIONALE = `
".read" owner-only — an unallocated remainder is a payer's name, an amount and
  the sale it came from: the same material /eft_pool is owner-only for. The
  panel that lists it is the owner's, and the allocate action that resolves it
  is refused server-side for anyone else regardless of this rule.
".write" false — entries are created by finishRemainder and removed by
  allocate/reverse, all Admin SDK. A client write here could fabricate or hide
  money the shop owes.
No ".indexOn" — the node is read whole, deliberately: it is the owner's open
  backlog and resolving an entry deletes it, so it stays small by construction.
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(EFT_UNALLOCATED_RULE_BLOCKS, null, 2));
  console.log(RATIONALE);
}
