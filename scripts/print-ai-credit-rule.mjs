// ─── THE TWO AI-CREDIT NODES' RULES, AS TEXT TO PASTE ────────────────────────
// aiCreditScan writes two nodes. They are new top-level keys, and the root
// carries no .read/.write, so NEITHER IS READABLE BY ANY BROWSER until these
// rules are pasted in the Firebase console.
//
// NOTHING BREAKS WHILE THEY ARE MISSING, which is why this is a paste rather
// than an applier: the capture screen treats a denied read as silence (an
// unreadable node is not evidence of an empty wallet), so the only thing lost
// is the in-app explanation. The alarm email does not depend on this at all —
// it runs entirely on Cloud Monitoring.
//
// NEVER `firebase deploy --only database`: the repo's database.rules.json is
// STALE and deploying it would REGRESS the live rules. Paste these in the
// console, or apply them through the .settings/rules.json REST endpoint the
// way scripts/cardrecon/apply-card-intake-rules.mjs does.
//
//   node scripts/print-ai-credit-rule.mjs

const OWNER = "gunidmoh@gmail.com";

// THE SPLIT IS THE POINT. The full verdict carries the owner's AI spend, his
// remaining balance and his burn rate — owner-only, like every other money
// surface. The public node carries a level and a timestamp and NOT ONE FIGURE,
// so it can be read by the same people who capture slips without putting cost
// data on a shop floor handset. See captureOnly.test.js, which pins the set of
// nodes that screen may read.
const cardReconHolder =
  `auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && ` +
  `(auth.token.email === '${OWNER}' || root.child('users').child(auth.uid).child('permFlags').child('card_recon').val() === true)`;

const BLOCKS = {
  // Written by aiCreditScan (Admin SDK, which bypasses rules). Nothing else
  // may write it, and only the owner may read it.
  ai_credit_status: {
    ".read": `auth != null && auth.token.email === '${OWNER}'`,
    ".write": "false",
  },
  // { level, checkedAt } and nothing else.
  ai_credit_public: {
    ".read": cardReconHolder,
    ".write": "false",
  },
};

const rule = Object.entries(BLOCKS)
  .map(([name, block]) => `"${name}": ${JSON.stringify(block, null, 2)}`)
  .join(",\n");

console.log(`
────────────────────────────────────────────────────────────────────────────
PASTE THESE AT THE TOP LEVEL of the live rules — siblings of "card_batches",
not inside /pos and not inside /config.

Firebase console → Realtime Database → Rules. Add both blocks, publish.

Until then: the alarm still emails (it runs on Cloud Monitoring and reads
nothing from the database), but the Card machines screen cannot explain a
capture that failed because the credits ran out — it simply stays quiet.
────────────────────────────────────────────────────────────────────────────

${rule}

────────────────────────────────────────────────────────────────────────────
WHY EACH LINE IS WHAT IT IS

  ai_credit_status  .read  owner only. It holds amountUSD, spendUSD,
                           burnPerDayUSD and remainingUSD — the owner's cost
                           data, which has no place on a manager's handset.
                    .write false. aiCreditScan writes it with the Admin SDK,
                           which bypasses rules; a client write path would let
                           a handset silence its own alarm.

  ai_credit_public  .read  the same people who may capture a slip: the
                           card_recon permission flag, or the owner.
                           Anonymous sign-ins (the TV board) are excluded
                           explicitly rather than by assuming no anonymous
                           client will ever hold a permFlag.
                    .write false, for the same reason as above.

  Neither node carries an index: both are single small objects read whole,
  never queried.
────────────────────────────────────────────────────────────────────────────
`);
