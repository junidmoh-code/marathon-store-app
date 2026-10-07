#!/usr/bin/env node
// Builds docs/SECTIONS-RULES.md from a copy of the LIVE database rules.
//
//   node scripts/sections/print-rules.cjs <live-rules.json>
//
// The live rules are console-managed; database.rules.json in this repo is
// stale and is never edited. This reads the live copy (fetch it read-only and
// keep it OUTSIDE the repo), keeps every existing expression word for word,
// and prints the keys to paste — so pasting cannot revert a console edit made
// since the last time this document was generated. It writes nothing but the
// document.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const src = process.argv[2];
if (!src) { console.error("usage: print-rules.cjs <live-rules.json>"); process.exit(2); }
const live = JSON.parse(fs.readFileSync(src, "utf8").replace(/^\s*\/\/.*$/mg, "")).rules;
const clone = (v) => JSON.parse(JSON.stringify(v));
const OWNER = "auth != null && auth.token.email === 'gunidmoh@gmail.com'";
const SIGNED_IN = "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'";

// The section of a location, read from the registry. `expr` is a rules
// expression for a location id that the caller has already shown to exist.
const sec = (expr) => `root.child('network').child('locations').child(${expr}).child('section')`;
const sameSide = (a, b) => `(!${sec(a)}.exists() || !${sec(b)}.exists() || ${sec(a)}.val() === ${sec(b)}.val())`;

// ── STEP 1: additive keys and children — safe before the deploy ──────────────
const NL = "newData.parent().parent().parent().child('locations')";
const hubOk = `newData.isString() && ${NL}.child(newData.val()).child('type').val() === 'hub' && ${NL}.child(newData.val()).child('section').val() === ${NL}.child($store).child('section').val()`;
const counter = {
  ".read": SIGNED_IN,
  ".write": SIGNED_IN,
  ".validate": "newData.hasChildren(['day','counter']) && newData.child('day').isString() && newData.child('counter').isNumber() && newData.child('counter').val() >= 1 && newData.child('counter').val() <= 999",
};
const step1 = {
  network: {
    ".read": SIGNED_IN,
    ".write": OWNER,
    creditScope: { ".validate": "newData.val() === 'shared' || newData.val() === 'section'" },
    // The two divisions' names (#701): fixed ids, an owner-named 1–40 char name.
    sections: { $n: {
      ".validate": "$n === '1' || $n === '2'",
      name: { ".validate": "newData.isString() && newData.val().length >= 1 && newData.val().length <= 40" },
    } },
    updatedAt: { ".validate": "newData.isNumber() && newData.val() <= now + 60000" },
    locations: { $id: {
      // The two switches (7 Oct 2026). `live` stays accepted for a record written
      // before the split; the apps read it only when neither new field is stored.
      solve: { ".validate": "newData.isBoolean()" },
      autoRefill: { ".validate": "newData.val() === 'off' || newData.val() === 'solved' || newData.val() === 'all'" },
      live: { ".validate": "newData.isBoolean()" },
      type: { ".validate": "newData.val() === 'store' || newData.val() === 'hub' || newData.val() === 'central'" },
      section: { ".validate": "newData.val() === 1 || newData.val() === 2" },
    } },
    backStock: { $store: { $category: { ".validate": hubOk } } },
    productOverrides: { $store: { $pid: { ".validate": hubOk } } },
    posStores: { $posId: { section: { ".validate": "newData.val() === 1 || newData.val() === 2" } } },
  },
  orderCounter_byStore: { $shop: counter },
  refillCounter_byStore: { $shop: counter },
  central_dispatch: {
    ".read": OWNER,
    $mvId: {
      ".write": `!data.exists() && newData.exists() && ${SIGNED_IN} && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(warehouse|store|admin)$/)`,
      // The row must describe the movement written with it: same id, same
      // origin, destination and quantity — and the origin must be Central.
      ".validate": "newData.hasChildren(['productId','size','qty','from','to','ts','actor','movementId']) && newData.child('actor').val() === auth.uid && newData.child('movementId').val() === $mvId && newData.child('qty').isNumber() && newData.child('qty').val() > 0 && newData.parent().parent().child('stock_movements').child($mvId).exists() && newData.parent().parent().child('stock_movements').child($mvId).child('from').val() === newData.child('from').val() && newData.parent().parent().child('stock_movements').child($mvId).child('qty').val() === newData.child('qty').val() && newData.parent().parent().child('network').child('locations').child(newData.child('from').val()).child('type').val() !== 'store' && newData.parent().parent().child('network').child('locations').child(newData.child('from').val()).child('type').val() !== 'hub'",
    },
  },
  sections_repair: { ".read": OWNER, ".write": false },
};
// push_assignments: one more optional hub child (the existing $other refuses it today).
const push = clone(live.push_assignments);
if (push && push.$uid) push.$uid["concrete-stockroom"] = { ".validate": "newData.isBoolean()" };
// users: the section fields. /users is owner-write at its root today and has
// no child .write, so nobody can write their own record; these only shape it.
const users = clone(live.users);
users.$uid = { ...(users.$uid || {}),
  sections: { $n: { ".validate": "($n === '1' || $n === '2') && newData.val() === true" } },
  allSections: { ".validate": "newData.val() === true" },
};
step1.push_assignments = push;
step1.users = users;

// ── STEP 4: the wall — after the deploy and after Set up the network ─────────
const mv = clone(live.stock_movements);
const from = "newData.child('from').val()", to = "newData.child('to').val()";
const pairWall = `(!newData.child('from').exists() || !newData.child('to').exists() || ${sameSide(from, to)})`;
const saleStore = "root.child('pos').child('sales').child(newData.child('link').child('saleId').val()).child('storeId')";
const posSec = `root.child('network').child('posStores').child(${saleStore}.val()).child('section')`;
const posWall = (type, side) => `(newData.child('type').val() !== '${type}' || !newData.child('link').child('saleId').exists() || !newData.child('${side}').exists() || !${sec(side === "to" ? to : from)}.exists() || !${saleStore}.exists() || !${posSec}.exists() || ${posSec}.val() === ${sec(side === "to" ? to : from)}.val())`;
// A device enrolled for a section (custom-token claim `section`) writes stock
// only in that section or at Central. No claim (every account and device that
// predates sections) = no restriction.
const claimOk = (expr) => `(auth.token.section === null || !${sec(expr)}.exists() || ${sec(expr)}.val() === auth.token.section)`;
const claimWall = `(!newData.child('from').exists() || ${claimOk(from)}) && (!newData.child('to').exists() || ${claimOk(to)})`;
mv.$mvId[".validate"] = `${live.stock_movements.$mvId[".validate"]} && ${pairWall} && ${posWall("return", "to")} && ${posWall("sold", "from")} && ${claimWall}`;

const tr = clone(live.transfers);
tr.$transferId[".validate"] = `!newData.exists() || !newData.child('from').exists() || !newData.child('to').exists() || ${sameSide("newData.child('from').val()", "newData.child('to').val()")}`;

const orders = clone(live.orders);
const shop = "newData.child('destShop').val()";
orders.$id[".validate"] = `data.exists() || !newData.exists() || !newData.child('destShop').exists() || ((!newData.child('placedAtHub').exists() || ${sameSide("newData.child('placedAtHub').val()", shop)}) && (!newData.child('hub').exists() || ${sameSide("newData.child('hub').val()", shop)}))`;

const rr = clone(live.refill_requests);
const req = "newData.child('requestingLocation').val()";
rr.$refillId[".validate"] = `data.exists() || !newData.exists() || !newData.child('requestingLocation').exists() || ((!newData.child('source').exists() || ${sameSide("newData.child('source').val()", req)}) && (!newData.child('createdFrom').child('source').exists() || ${sameSide("newData.child('createdFrom').child('source').val()", req)}) && (!newData.child('store').exists() || ${sameSide("newData.child('store').val()", req)}))`;
const step4 = { stock_movements: mv, transfers: tr, orders, refill_requests: rr };

const body = (obj) => { const j = JSON.stringify(obj, null, 2); return j.slice(j.indexOf("\n") + 1, j.lastIndexOf("\n")); };
const md = `# Sections — database rule changes to paste in the console

\`database.rules.json\` in this repo is stale and is not touched. This document is
GENERATED by \`scripts/sections/print-rules.cjs\` from the live rules as read on
${new Date().toISOString().slice(0, 10)}. Every existing expression is kept word for word; each key
below REPLACES the key of the same name under \`rules\` (keys that do not exist
yet are new). Nothing else in the live rules changes. If a rule under one of
these keys is edited in the console later, regenerate before pasting.

## The order

| step | what | when |
|---|---|---|
| 1 | Paste **block A** (new keys and optional children — it refuses nothing that works today) | any time; safest BEFORE the deploy |
| 2 | Deploy both apps and the changed functions | |
| 3 | Home → Network → **Set up the network** | after block A |
| 4 | Paste **block B** (the wall) | only after steps 2 and 3 |

## What happens if a step is missing

| missing | effect |
|---|---|
| block A, \`network\` | The Network card cannot save. Both apps run on the built-in seed: Section 2 as today; Section 1 Solve ON with Auto-refill "solved products only" (7 Oct 2026). Nothing breaks. |
| block A, \`orderCounter_byStore\` / \`refillCounter_byStore\` | Pine and Concrete orders keep drawing from the SHARED sequence, exactly as Pine does today. Once pasted, Pine's order keys become \`P001\` and Pine's TV board must be opened at \`?section=1#tv\`. |
| block A, \`central_dispatch\` | Stock still moves. The dispatch cost row is dropped (one refused attempt, then the move lands without it) and is not back-filled. |
| block A, \`push_assignments\` | Only switching the Concrete Stockroom on as an alert hub is refused. |
| block A, \`users\` | Nothing: /users is owner-write already. The children only constrain the shape of the section fields. |
| step 3 | Block B's clauses read each location's section from \`/network\`. Until it is set up they judge nothing and pass everything. The apps enforce the wall from their built-in seed regardless. |
| block B | The wall is enforced by the apps and the functions only, not by the database. |
| block B pasted BEFORE step 2 | A till still on the old POS can route a Pine sneaker sale to Hub 1 or Hub 2; the rule refuses that write and the till queues it. Deploy first. |

\`/pos_meta/byStore\` (Pine's and Concrete's own sale numbers) needs no rule:
\`/pos_meta\` is already writable by any signed-in account.

## Block A — new keys and optional children

\`\`\`json
${body(step1)}
\`\`\`

## Block B — the section wall

| key | added to the existing rule |
|---|---|
| \`stock_movements\` | (1) a two-location movement must not pair a Section 1 location with a Section 2 one; (2) a \`return\` linked to a POS record must land in the section of the store that took it; (3) a \`sold\` linked to a POS record must deduct in the selling store's section; (4) a device enrolled for a section writes stock only in that section or at Central. Central has no section and pairs with anything. |
| \`transfers\` | a transfer's \`from\` and \`to\` must not be on opposite sides. This is what covers a transit send, whose movements only name \`in_transit\`. |
| \`orders\` | on create only: the order's hub and its \`destShop\` must not be on opposite sides. |
| \`refill_requests\` | on create only: the requesting location and its source (and the shop it is for) must not be on opposite sides. |

\`\`\`json
${body(step4)}
\`\`\`

## Limits, stated plainly

- Every lookup on a value that may be missing is guarded by an \`exists()\`
  first: a rule that calls \`child()\` on a missing value fails closed and would
  refuse the write.
- A rule cannot see where a customer is standing. Clauses 2 and 3 on
  \`stock_movements\` rely on the POS record the movement links to; a movement
  with no link, or whose record does not exist yet, is not judged by them. The
  POS code is the first wall for those paths; the rule is the second.
- Clause 4 applies to devices enrolled with a section. An account's own
  section (User Management) limits what its screens show; it is not enforced
  by a rule.
- The \`orders\` and \`refill_requests\` clauses apply on create, so a record
  written before the paste can still be worked and closed.
- The admin SDK (Cloud Functions, the repair scripts) bypasses rules. The
  functions carry their own checks: the engine acts only on live, same-side
  routes (both ends with Auto-refill on); the first-batch trigger writes nothing
  for a shop whose Auto-refill is off; the stranded-transit sweep releases nothing
  into a location with both switches off.
- These expressions have not been run against an emulator. They are checked
  for JSON validity, balanced brackets and guarded lookups by
  \`src/utils/sectionsRulesDoc.test.js\`.
`;
fs.writeFileSync(path.join(__dirname, "..", "..", "docs", "SECTIONS-RULES.md"), md);
console.log("block A keys:", Object.keys(step1).join(", "), "| block B keys:", Object.keys(step4).join(", "));
