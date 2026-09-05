// ─── THE /customers RULE PATCH, AS DATA ──────────────────────────────────────
//
// WHAT IS BROKEN. The live rule on /customers is:
//
//   ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'"
//
// — any signed-in till. The POS shipped a customer Remove (delete when nothing
// points at the customer, archive otherwise) gated on `isSuperAdmin`, which is
// an EMAIL COMPARISON IN THE BROWSER. A cashier who never opens that screen can
// still delete or archive a customer record straight from the database. The UI
// makes a promise the database does not keep.
//
// ── WHY THE `.write` MOVES DOWN A LEVEL ──────────────────────────────────────
// A `.write` that is true at an ancestor grants EVERY write beneath it, and no
// descendant rule can take that back — a child `.write` or a `.validate` cannot
// subtract permission an ancestor already gave. So the grant cannot stay on
// /customers and be narrowed underneath; it has to move to /customers/$id,
// where a rule can see the record's before and after.
//
// Nothing writes AT the /customers node itself (every client write in both apps
// is `customers/{id}` or deeper, and the Admin SDK bypasses rules entirely), so
// moving the grant down also closes "rewrite the whole customer book in one
// call", which nothing should ever be able to do.
//
// ── WHY IT IS A `.write` AND NOT A `.validate` ───────────────────────────────
// A `.validate` is SKIPPED when the new value is null. Guarding `archivedAt`
// with a validate would stop an archive and happily allow an UNARCHIVE, and
// would not see a whole-record delete at all. `.write` runs on every write,
// including deletes, and — evaluated at $customerId — sees the whole record
// either side of a write made at any depth beneath it.
//
// ── WHAT IT SAYS ─────────────────────────────────────────────────────────────
// The owner may do anything. Everyone else may write only if, after the write:
//   · the record still EXISTS  (so: no delete), and
//   · archivedAt and archivedBy are exactly what they were (so: no archive, and
//     no unarchive either — the pair is frozen against every non-owner).
// Every ordinary till write — a name, a phone field, the C-number transaction,
// store credit, lay-by holdings, an order-time upsert, a brand-new customer —
// leaves the record existing and those two fields untouched, so all of it
// passes unchanged.
//
// ── THE ONE FLOW THIS DELIBERATELY STOPS ─────────────────────────────────────
// marathon-pos-app's phone re-key (editCustomer.js — the "I mistyped the number
// at signup" typo fix) DELETES customers/{oldKey} as its final step, and its
// Edit button is NOT owner-gated. Under this rule a till's re-key would be
// refused at that last step, AFTER the new key was already claimed — leaving
// two records. That is worse than either outcome, so the POS gates a phone
// change on the owner in the same breath as this rule (marathon-pos-app #309).
// A name edit is untouched: it writes a field and deletes nothing.
//
// The emulator proof for every clause above is scripts/rules/customers-rules.test.mjs.

export const OWNER_EMAIL = "gunidmoh@gmail.com";

// The exact string this patch expects to find on the live /customers node. A
// live value that is not this one means someone has already changed the rule,
// and the applier refuses rather than overwriting a decision it cannot see.
export const EXPECTED_CUSTOMERS_WRITE =
  "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'";

// The grant, moved down to the record and narrowed. Written as one line because
// that is how it lands in the rules document, and a diff of the live document
// is the artefact a person checks.
export const CUSTOMER_RECORD_WRITE =
  "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && (" +
    `auth.token.email === '${OWNER_EMAIL}'` +
    " || (" +
      "newData.exists()" +
      " && newData.child('archivedAt').val() === data.child('archivedAt').val()" +
      " && newData.child('archivedBy').val() === data.child('archivedBy').val()" +
    ")" +
  ")";

/**
 * Patch a whole live rules document. PURE — it copies, it never mutates its
 * input, and it touches exactly two keys:
 *   customers        — the node-level ".write" is REMOVED
 *   customers/$customerId — a ".write" is ADDED
 * Everything else, including the storeCredit validate, is carried through
 * untouched. Throws rather than guessing if the live shape is not what it
 * expects; the applier turns that into a refusal.
 */
export function patchCustomersRules(live) {
  const next = JSON.parse(JSON.stringify(live));
  const node = next?.rules?.customers;
  if (!node) throw new Error("live rules have no /customers node — refusing to guess");
  if (node[".write"] !== EXPECTED_CUSTOMERS_WRITE) {
    throw new Error(
      `/customers .write is not the rule this patch expects to replace.\n` +
      `  expected: ${EXPECTED_CUSTOMERS_WRITE}\n` +
      `  found:    ${node[".write"]}`
    );
  }
  if (!node.$customerId) throw new Error("live rules have no /customers/$customerId node — refusing to guess");
  if (node.$customerId[".write"] !== undefined) {
    throw new Error(`/customers/$customerId already has a .write: ${node.$customerId[".write"]}`);
  }
  delete node[".write"];
  node.$customerId[".write"] = CUSTOMER_RECORD_WRITE;
  return next;
}

// ─── /orders customerId INDEX ────────────────────────────────────────────────
// The POS's customer-removal check answers "does anything still point at this
// customer?" by reading the WHOLE /orders node — 2.44 MB measured 2026-09-04 —
// and filtering `v.customerId === id` in JavaScript, because /orders carries no
// index that would let the server answer it. It does that read up to three
// times per removal (plan, re-plan, and again on the delete branch): ~7.8 MB to
// decide one deletion.
//
// An .indexOn is in a different class from a .validate: it is a query-planning
// hint, never evaluated against a write, with no deny path and no input that
// can reject anything. The only things it changes are that an orderByChild
// query is answered from an index instead of by streaming the node, and that a
// write to /orders maintains one more index entry.
export const EXPECTED_ORDERS_INDEX = ["destShop", "readyNotifyPending"];
export const NEXT_ORDERS_INDEX = ["destShop", "readyNotifyPending", "customerId"];

/** Pure, same discipline: adds ONE array element and refuses any other shape. */
export function patchOrdersIndex(live) {
  const next = JSON.parse(JSON.stringify(live));
  const node = next?.rules?.orders;
  if (!node) throw new Error("live rules have no /orders node — refusing to guess");
  const cur = node[".indexOn"];
  if (JSON.stringify(cur) === JSON.stringify(NEXT_ORDERS_INDEX)) return next; // idempotent
  if (JSON.stringify(cur) !== JSON.stringify(EXPECTED_ORDERS_INDEX)) {
    throw new Error(
      `/orders .indexOn is not the array this patch expects to extend.\n` +
      `  expected: ${JSON.stringify(EXPECTED_ORDERS_INDEX)}\n` +
      `  found:    ${JSON.stringify(cur)}`
    );
  }
  node[".indexOn"] = NEXT_ORDERS_INDEX;
  return next;
}
