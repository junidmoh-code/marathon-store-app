// ─── THE CONSOLE RULE CHANGE FOR MANUAL TRANSFERS (for Junid to paste) ───────
// The app opens Stock → Transfer to anyone with stockRole admin|warehouse OR
// the `stock_management` permission (src/components/stock/stockAccess.js).
// The live rules accept a transfer only from stockRole warehouse|store|admin.
// Five live accounts (26 Nov 2026) sit in the gap — stock_management, but
// stockRole missing (ayob, alliibro, casimu) or "pos" (zee, the "jafer"
// login) — and every send they make is refused.
//
// ORDER MATTERS: stockRole.val().matches(...) on a MISSING stockRole is a
// rule-evaluation ERROR, and an error fails the whole expression even inside
// `||` — so the stock_management test goes FIRST in every OR below.
//
// The narrow change: on the transfer write paths ONLY, also accept
// users/{uid}/permFlags/stock_management === true (the server-readable mirror
// of that permission, already set on all five). Nothing else is widened:
// received/opening/adjustment/sold/return keep their stockRole gates, and
// refill_requests is deliberately NOT touched (CLAUDE.md: request rules are
// Junid's own call).
//
// Plus /logs/transferFailures: append-only, signed-in staff, write-only from
// the app; readable by Junid and Jafer.
//
// Run `node scripts/emulator/proposedTransferRules.mjs <live-rules.json>` to
// print the exact replacement blocks. The emulator test applies the same
// function to the live rules, so what is printed is what was tested.

export const SM = "root.child('users').child(auth.uid).child('permFlags').child('stock_management').val() === true";
const SIGNED = "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).exists()";
const ROLE_TRANSFER = "root.child('users').child(auth.uid).child('stockRole').val().matches(/^(warehouse|store|admin)$/)";
const SUPERS = "((auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com') && auth.token.email_verified === true)";

const STOCK_WRITE = `${SIGNED} && (${SM} || root.child('users').child(auth.uid).child('stockRole').exists())`;

export const TRANSFER_FAILURES_RULE = {
  ".read": `auth != null && ${SUPERS}`,
  "$id": {
    ".write": `${SIGNED} && !data.exists() && newData.exists()`,
    ".validate": "newData.hasChildren(['code', 'atMs']) && newData.child('atMs').isNumber() && newData.child('atMs').val() > now - 300000 && newData.child('atMs').val() < now + 300000 && newData.child('code').isString() && newData.child('code').val().length <= 60",
    "uid": { ".validate": "newData.val() === auth.uid" },
    "message": { ".validate": "newData.isString() && newData.val().length <= 300" },
    "code": { ".validate": "newData.isString()" },
    "role": { ".validate": "newData.isString() && newData.val().length <= 30" },
    "from": { ".validate": "newData.isString() && newData.val().length <= 40" },
    "to": { ".validate": "newData.isString() && newData.val().length <= 40" },
    "productId": { ".validate": "newData.isString() && newData.val().length <= 80" },
    "lines": { ".validate": "newData.isNumber()" },
    "stage": { ".validate": "newData.isString() && newData.val().length <= 30" },
    "build": { ".validate": "newData.isString() && newData.val().length <= 60" },
    "atMs": { ".validate": "newData.isNumber()" },
    "$other": { ".validate": false },
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// Returns { rules, changes } — the full patched rules, and each changed block
// as { path, before, after } for printing.
export function applyProposedTransferRules(liveRulesDoc) {
  const doc = clone(liveRulesDoc);
  const R = doc.rules;
  const changes = [];
  const set = (path, obj, key, after) => {
    const before = obj[key];
    obj[key] = after;
    changes.push({ path, before, after });
  };

  // 1. The transit record.
  const t = R.transfers.$transferId;
  if (!t[".write"].includes(ROLE_TRANSFER)) throw new Error("live /transfers rule changed — re-derive the patch");
  set("transfers/$transferId/.write", t, ".write", t[".write"].replace(ROLE_TRANSFER, `(${SM} || ${ROLE_TRANSFER})`));

  // 2. The ledger movement — transfer_out and transfer_in branches only.
  const ty = R.stock_movements.$mvId.type;
  let v = ty[".validate"];
  for (const kind of ["transfer_out", "transfer_in"]) {
    const branch = `(newData.val() === '${kind}' && ${ROLE_TRANSFER})`;
    if (!v.includes(branch)) throw new Error(`live ${kind} branch changed — re-derive the patch`);
    v = v.replace(branch, `(newData.val() === '${kind}' && (${SM} || ${ROLE_TRANSFER}))`);
  }
  set("stock_movements/$mvId/type/.validate", ty, ".validate", v);

  // 3. The stock cells a transfer moves (stockRole exists → or stock_management).
  const cell = R.stock.$loc.$pid.$size;
  set("stock/$loc/$pid/$size/.write", cell, ".write", STOCK_WRITE);

  // 4. Stock provenance counters written beside a move.
  for (const k of ["s", "k", "u"]) {
    const node = R.stock_provenance.$loc.$pid[k];
    set(`stock_provenance/$loc/$pid/${k}/.write`, node, ".write", `${STOCK_WRITE} && newData.exists()`);
  }

  // 5. The failure log.
  R.logs = R.logs || {};
  set("logs/transferFailures", R.logs, "transferFailures", clone(TRANSFER_FAILURES_RULE));

  return { rules: doc, changes };
}

// CLI: print the blocks Junid pastes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs");
  const live = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const { changes } = applyProposedTransferRules(live);
  for (const c of changes) {
    console.log(`\n### ${c.path}\n${JSON.stringify(c.after, null, 2)}`);
  }
}
