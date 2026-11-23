// ─── "SIGNED IN" IS NOT "STAFF" — THE RULES PATCH (pure, no I/O) ─────────────
//
// Client sign-up is open on the project (it cannot be closed without also
// closing new anonymous sessions, which every TV board needs — see
// docs/security/2026-11-audit.md). So anyone on the internet can hold a
// signed-in, non-anonymous token, and 179 rules in the live document treat
// exactly that as "staff".
//
// The patch is ADDITIVE and mechanical, so it can be re-applied to whatever
// the live document is on the day without hand-editing it:
//
//   auth.token.firebase.sign_in_provider != 'anonymous'
//     → … && root.child('users').child(auth.uid).exists()
//
//   (auth.token.email === '<owner>' || auth.token.email === '<owner2>')
//     → (… && auth.token.email_verified === true)
//
// For every caller that HAS a /users record (every staff member, every till,
// both owners, the card-recon poller's service identity) the first conjunct
// is true, so A && true === A and nothing they could do changes. Both owners
// sign in with Google, whose tokens carry email_verified: true. Admin SDK
// writers (every Cloud Function, every Mac-mini job) bypass rules entirely.
//
// Idempotent: a document already carrying the conjunct is returned unchanged.
export const NON_ANON = "auth.token.firebase.sign_in_provider != 'anonymous'";
export const HAS_RECORD = "root.child('users').child(auth.uid).exists()";
export const OWNER_MACRO = "(auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com')";
export const OWNER_VERIFIED = "((auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com') && auth.token.email_verified === true)";

export function patchRequireUserRecord(text) {
  let out = text;
  // 1. non-anonymous → non-anonymous AND has a /users record (skip ones already patched)
  const marker = "\u0000ALREADY\u0000";
  out = out.split(`${NON_ANON} && ${HAS_RECORD}`).join(marker);
  out = out.split(NON_ANON).join(`${NON_ANON} && ${HAS_RECORD}`);
  out = out.split(marker).join(`${NON_ANON} && ${HAS_RECORD}`);
  // 2. owner email → owner email AND verified (skip ones already patched)
  const m2 = "\u0000OWNERV\u0000";
  out = out.split(OWNER_VERIFIED).join(m2);
  out = out.split(OWNER_MACRO).join(OWNER_VERIFIED);
  out = out.split(m2).join(OWNER_VERIFIED);
  return out;
}

export function countPatch(before, after) {
  const c = (t, s) => t.split(s).length - 1;
  return {
    nonAnon: c(before, NON_ANON),
    withRecordAfter: c(after, `${NON_ANON} && ${HAS_RECORD}`),
    owner: c(before, OWNER_MACRO) - c(before, OWNER_VERIFIED),
    ownerVerifiedAfter: c(after, OWNER_VERIFIED),
  };
}
