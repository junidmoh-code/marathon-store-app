// ── THE CONSOLE RULES THIS FEATURE NEEDS ─────────────────────────────────────
//   node scripts/social/print-social-rules.mjs
//
// Prints the two RTDB rule blocks Junid pastes into the Firebase console. It
// changes nothing — not the console, not database.rules.json, not Storage.
//
// ── WHY A PASTE AND NOT A DEPLOY ─────────────────────────────────────────────
// The LIVE rules and the repo's database.rules.json have drifted: the live
// tree carries rules for /specials, /shopify_sync, /shopify_publish,
// /style_code_index and a dozen more that the file has never held. Deploying
// the file would DELETE all of them. So new nodes are added by hand in the
// console, exactly as /shopify_publish was, and this script exists so the text
// is never retyped from memory.
//
// ── WHY THE FEATURE IS DEAD UNTIL THIS IS PASTED ─────────────────────────────
// The live database has NO root rule. An unlisted top-level path therefore
// defaults to deny, so /social_posts and /social_style_refs refuse every read
// and every write until these blocks exist. The app says so in plain words
// rather than showing an empty screen (see socialStore.js writeError), and the
// generator — which uses the Admin SDK and bypasses rules — would happily fill
// a queue nobody could open. Paste these first.
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
// /social_signal — the cached sell-through ranking. It is written and read
// ONLY by the Cloud Function through the Admin SDK, which bypasses rules
// entirely, and the browser never touches it. A node with no rule is a node no
// client can read, which for that cache is the correct access.
//
// Storage: nothing is owed. Style-reference media and generated post media are
// written under `aiStudio/social/…`, inside the existing
// `match /aiStudio/{allPaths=**}` block — public read, super-admin write. That
// is exactly the access these files need, and it is why the ground rule about
// never touching storage.rules costs this feature nothing.

const ADMIN = "gunidmoh@gmail.com";

// The identity clause, copied verbatim from the LIVE /shopify_publish rule
// (fetched from the running database, not from the repo file) so the two
// surfaces accept exactly the same people: Junid, or a user whose
// /users/{uid}/stockRole is "admin".
const WRITE = `auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && (auth.token.email === '${ADMIN}' || root.child('users').child(auth.uid).child('stockRole').val() === 'admin')`;
const READ = "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'";

const rules = {
  social_posts: {
    ".read": READ,
    // The queue reads one bounded query per status. WITHOUT this index every
    // one of those becomes an unindexed scan of the whole node — the read
    // pattern the whole store layer is built to avoid.
    ".indexOn": ["status"],
    $postId: {
      ".write": WRITE,
      // A post must always carry a status. Anything else is a record the
      // publisher's gate cannot reason about.
      ".validate": "!newData.exists() || newData.hasChildren(['status'])",
      status: {
        ".validate": "newData.isString() && newData.val().matches(/^(draft|approved|posting|posted|failed|discarded)$/)",
      },
      caption: { ".validate": "newData.isString() && newData.val().length <= 2200" },
      link: { ".validate": "newData.isString() && newData.val().length <= 500" },
      // A schedule in the far past or far future is a bug, not an intention.
      scheduledAt: { ".validate": "!newData.exists() || (newData.isNumber() && newData.val() > 0)" },
      updatedAt: { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= now + 86400000" },
      // Everything else (media, platforms, products, results, the generator's
      // provenance fields) rides the $other clause. The publisher writes
      // `results` with the Admin SDK and bypasses rules anyway; constraining
      // it here would only be able to break the browser's view of it.
      $other: { ".validate": true },
    },
  },
  social_style_refs: {
    ".read": READ,
    // The library pages newest-first through this index. Same reasoning as
    // above: without it, every page is a full-node scan.
    ".indexOn": ["addedAt"],
    $refId: {
      ".write": WRITE,
      ".validate": "!newData.exists() || newData.hasChildren(['url', 'addedAt'])",
      url: { ".validate": "newData.isString() && newData.val().beginsWith('https://')" },
      type: { ".validate": "newData.isString() && newData.val().matches(/^(image|video)$/)" },
      note: { ".validate": "newData.isString() && newData.val().length <= 400" },
      addedAt: { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= now + 86400000" },
      $other: { ".validate": true },
    },
  },
};

console.log(`
════════════════════════════════════════════════════════════════════════════
  RTDB CONSOLE RULES — paste into the EXISTING rules, do not replace them
════════════════════════════════════════════════════════════════════════════

  Firebase console → Realtime Database → Rules. Add these TWO keys inside the
  top-level "rules" object, alongside "shopify_publish". Do NOT paste over the
  whole document and do NOT run \`firebase deploy --only database\` — the live
  rules hold nodes the repo file does not, and both would delete them.

  Until this is in, the Social screen refuses to load and says so.

────────────────────────────────────────────────────────────────────────────
${JSON.stringify(rules, null, 2).replace(/^\{\n|\n\}$/g, "").replace(/^ {2}/gm, "")}
────────────────────────────────────────────────────────────────────────────

  Storage rules: NONE needed. Social media lives under aiStudio/social/…,
  already covered by the existing match /aiAssistant-adjacent aiStudio block.

  Then check it worked — open Social in the app, or:
      node scripts/social/publish.mjs --status
`);
