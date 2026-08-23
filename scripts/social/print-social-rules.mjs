// ── THE CONSOLE RULES THIS FEATURE NEEDS ─────────────────────────────────────
//   node scripts/social/print-social-rules.mjs
//
// Prints the RTDB rule blocks Junid pastes into the Firebase console. It changes
// nothing — not the console, not database.rules.json, not Storage.
//
// ── WHY A PASTE AND NOT A DEPLOY ─────────────────────────────────────────────
// The LIVE rules and the repo's database.rules.json have drifted, and not
// slightly: the live document carries 59 top-level keys (counted against the
// running database on 2026-08-23) including /specials, /shopify_sync,
// /shopify_publish, /style_code_index and a dozen more the file has never held.
// `firebase deploy --only database` would DELETE every one of them. So new nodes
// are added by hand in the console, exactly as /shopify_publish was, and this
// script exists so the text is never retyped from memory.
//
// ── WHY THE FEATURE IS DEAD UNTIL THIS IS PASTED ─────────────────────────────
// The live database has NO root rule (also verified 2026-08-23). An unlisted
// top-level path therefore defaults to deny, so /social_posts and
// /social_style_refs refuse every read and every write until these blocks exist.
// The app says so in plain words rather than showing an empty screen (see
// socialStore.js writeError), and the generator — which uses the Admin SDK and
// bypasses rules — would happily fill a queue nobody could open. Paste this
// first.
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
// /social_signal — the cached sell-through ranking. It is written and read ONLY
// by the Cloud Function through the Admin SDK, which bypasses rules entirely,
// and the browser never touches it. A node with no rule is a node no client can
// read, which for that cache is the correct access.
//
// Storage: nothing is owed. Style-reference media and generated post media are
// written under `aiStudio/social/…`, inside the existing
// `match /aiStudio/{allPaths=**}` block — public read, super-admin write. That
// is exactly the access these files need, and it is why the ground rule about
// never touching storage.rules costs this feature nothing.

const ADMIN = "gunidmoh@gmail.com";

const SIGNED_IN = "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'";

// ── THE IDENTITY CLAUSES ────────────────────────────────────────────────────
// SOCIAL_WRITE is copied verbatim from the LIVE /shopify_publish rule as it
// stood before this change (fetched from the running database, not from the
// repo file). The Social screen is deliberately left on it: Social is the
// owner's surface, and nobody is being given it in this pass.
const SOCIAL_WRITE = `${SIGNED_IN} && (auth.token.email === '${ADMIN}' || root.child('users').child(auth.uid).child('stockRole').val() === 'admin')`;
const READ = SIGNED_IN;

// PERM(key) — the named-permission clause. It reads the MAP at
// /users/{uid}/permFlags, not the `permissions` ARRAY beside it, because RTDB
// rules cannot ask whether an array contains a value: an array reaches the rules
// engine as an object keyed by POSITION ({"0":"insights","1":"barcode"}), so the
// only testable question is "is index 3 equal to X" — which changes meaning the
// moment any other permission is toggled and the array reindexes.
//
// permFlags is written as a whole object in the same update() as the array it
// mirrors (see permFlagsFor in src/components/permissionCatalog.js), so a
// revoked permission's flag disappears by construction rather than by anyone
// remembering to delete it.
//
// IT CANNOT BE SELF-GRANTED: the live /users rule is
// `.write: "auth.token.email === 'gunidmoh@gmail.com'"` — only Junid writes that
// node at all, so a staff member can no more give themselves a flag than they
// can give themselves a stockRole.
const PERM = (key) =>
  `root.child('users').child(auth.uid).child('permFlags').child('${key}').val() === true`;

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — the two new social keys
// ─────────────────────────────────────────────────────────────────────────────
const socialRules = {
  social_posts: {
    ".read": READ,
    // The queue reads one bounded query per status. WITHOUT this index every one
    // of those becomes an unindexed scan of the whole node — the read pattern
    // the whole store layer is built to avoid.
    ".indexOn": ["status"],
    $postId: {
      ".write": SOCIAL_WRITE,
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
      // `results` with the Admin SDK and bypasses rules anyway; constraining it
      // here would only be able to break the browser's view of it.
      $other: { ".validate": true },
    },
  },
  social_style_refs: {
    ".read": READ,
    // The library pages newest-first through this index. Same reasoning as
    // above: without it, every page is a full-node scan.
    ".indexOn": ["addedAt"],
    $refId: {
      ".write": SOCIAL_WRITE,
      ".validate": "!newData.exists() || newData.hasChildren(['url', 'addedAt'])",
      url: { ".validate": "newData.isString() && newData.val().beginsWith('https://')" },
      type: { ".validate": "newData.isString() && newData.val().matches(/^(image|video)$/)" },
      note: { ".validate": "newData.isString() && newData.val().length <= 400" },
      addedAt: { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= now + 86400000" },
      $other: { ".validate": true },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — /shopify_publish, wired to a NAMED PERMISSION
// ─────────────────────────────────────────────────────────────────────────────
// This REPLACES the existing shopify_publish key. Everything below is byte-for
// byte the live rule except the one `.write` line, which gains a third accepted
// identity. Nobody who can write today loses the ability.
const SHOPIFY_WRITE_BEFORE =
  `${SIGNED_IN} && (auth.token.email === '${ADMIN}' || root.child('users').child(auth.uid).child('stockRole').val() === 'admin')`;
const SHOPIFY_WRITE_AFTER =
  `${SIGNED_IN} && (auth.token.email === '${ADMIN}' || root.child('users').child(auth.uid).child('stockRole').val() === 'admin' || ${PERM("shopify_publish")})`;

const shopifyRule = {
  shopify_publish: {
    ".read": READ,
    ".indexOn": ["state"],
    $pid: {
      ".write": SHOPIFY_WRITE_AFTER,
      ".validate": "!newData.exists() || (newData.hasChildren(['state']) && root.child('products').child($pid).exists())",
      state: { ".validate": "newData.isString() && newData.val().matches(/^(awaiting|live|blocked|none|nominated|draft)$/)" },
      liveState: { ".validate": "newData.isString() && newData.val().matches(/^(on|off)$/)" },
      desiredState: { ".validate": "newData.isString() && newData.val().matches(/^(on|off)$/)" },
      blockedReason: { ".validate": "newData.isString() && newData.val().length <= 1000" },
      cleanName: { ".validate": "newData.isString() && newData.val().length >= 3 && newData.val().length <= 255" },
      cleanNameSource: { ".validate": "newData.isString() && newData.val().matches(/^(lexicon|ai|manual)$/)" },
      updatedAt: { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= now + 86400000" },
      updatedBy: { ".validate": "newData.isString() && newData.val() === auth.uid" },
      $other: { ".validate": true },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — photo generation: the spend log, and the approve step
// ─────────────────────────────────────────────────────────────────────────────
// aiAssistant is an EXISTING key with three children (nameProposals,
// photoProposals, styleKit) and no rule of its own. Paste these two children
// into it — do not replace the whole aiAssistant key, or styleKit and
// nameProposals go with it.
//
//   usage           — the spend ledger. Every paid AI run has always written a
//                     line here; nothing could read it, so the money was being
//                     recorded into the dark. Read is SUPER-ADMIN ONLY: what the
//                     business spends is not staff-visible. There is no `.write`
//                     on purpose — only the Cloud Functions write it, through the
//                     Admin SDK, which bypasses rules. A node no client can write
//                     is the correct access for a ledger.
//
//   photoProposals  — UNCHANGED except that its `.write` gains the named
//                     permission. Without this the permission is not actually
//                     self-sufficient: a holder could generate photos (that runs
//                     server-side) and would then be REFUSED when they pressed
//                     Approve, which writes the proposal's status from the
//                     browser. Everything else about the clause is verbatim.
const PHOTO_PROPOSALS_WRITE_BEFORE =
  `${SIGNED_IN} && (root.child('users').child(auth.uid).child('stockRole').exists() || auth.token.email === '${ADMIN}')`;
const PHOTO_PROPOSALS_WRITE_AFTER =
  `${SIGNED_IN} && (root.child('users').child(auth.uid).child('stockRole').exists() || auth.token.email === '${ADMIN}' || ${PERM("photo_generation")})`;

const aiAssistantChildren = {
  usage: {
    ".read": `auth != null && auth.token.email === '${ADMIN}'`,
  },
  photoProposals: {
    ".read": READ,
    ".write": PHOTO_PROPOSALS_WRITE_AFTER,
  },
};

// ── rendering ───────────────────────────────────────────────────────────────
// Strip the outer braces and one level of indentation so what is printed can be
// dropped straight in beside the existing keys.
const body = (obj) =>
  JSON.stringify(obj, null, 2).replace(/^\{\n|\n\}$/g, "").replace(/^ {2}/gm, "");

const rule = process.argv.includes("--json");
if (rule) {
  // Machine-readable form, for the test that pins this script's output.
  console.log(JSON.stringify({ socialRules, shopifyRule, aiAssistantChildren }, null, 2));
} else {
  console.log(`
════════════════════════════════════════════════════════════════════════════
  RTDB CONSOLE RULES — one paste, three parts
════════════════════════════════════════════════════════════════════════════

  Firebase console → Realtime Database → Rules.

  Do NOT paste over the whole document, and do NOT run
  \`firebase deploy --only database\`: the live rules hold 59 top-level keys
  the repo file does not, and either would delete them.

────────────────────────────────────────────────────────────────────────────
  PART 1 — ADD these two NEW keys, alongside "shopify_publish"
────────────────────────────────────────────────────────────────────────────
${body(socialRules)}

────────────────────────────────────────────────────────────────────────────
  PART 2 — REPLACE the existing "shopify_publish" key with this
────────────────────────────────────────────────────────────────────────────
  Only ONE line differs from what is live: the "$pid" .write clause.

  BEFORE (live today — stockRole "admin" is the only way in besides Junid):
    ${SHOPIFY_WRITE_BEFORE}

  AFTER (adds the named permission as a third way in; nobody loses access):
    ${SHOPIFY_WRITE_AFTER}

  PERMISSION KEY:  shopify_publish
  Grant it in the app: User Management → the staff member → Online & Content
                       → "Shopify Publishing".

${body(shopifyRule)}

────────────────────────────────────────────────────────────────────────────
  PART 3 — inside the EXISTING "aiAssistant" key, add "usage" and
           REPLACE "photoProposals"
────────────────────────────────────────────────────────────────────────────
  Leave "nameProposals" and "styleKit" exactly as they are.

  "usage" is new — the AI spend ledger. It has a .read and deliberately NO
  .write: only the Cloud Functions write it, via the Admin SDK, which bypasses
  rules entirely.

  "photoProposals" changes on ONE line, its .write:

  BEFORE:
    ${PHOTO_PROPOSALS_WRITE_BEFORE}

  AFTER:
    ${PHOTO_PROPOSALS_WRITE_AFTER}

  PERMISSION KEY:  photo_generation
  Grant it in the app: User Management → the staff member → Online & Content
                       → "Photo Generation".

${body(aiAssistantChildren)}

────────────────────────────────────────────────────────────────────────────

  Storage rules: NONE needed. Social media lives under aiStudio/social/…,
  already covered by the existing match /aiStudio/{allPaths=**} block.

  Then check it worked:
      • the Social tile opens the queue instead of a permission error
      • AI Studio → Spend loads instead of saying it cannot read the log
      • node scripts/social/publish.mjs --status
`);
}
