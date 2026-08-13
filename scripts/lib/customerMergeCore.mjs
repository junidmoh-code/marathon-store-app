// Customer phone-duplicate census + merge core — PURE logic only, no RTDB.
//
// The same person exists under several /customers keys because the key IS the
// phone digits and three dialects of the same number were minted over time:
// "0813995333" (POS local form), "27813995333" (order-flow international form)
// and "813995333" (bare national, no trunk 0). This module holds every decision
// rule shared by the census (scripts/customer-phone-census.mjs), the guarded
// merge runner and their tests, so the census, the runner and the proofs can
// never drift apart — the same house rule as headwearCollapseCore.mjs.
//
// Canonical identity: E.164 South Africa, "+27" + 9 significant digits.
// Everything that is NOT a well-formed SA number (too short, too long, non-SA
// country code, the "unknown" sentinel) is classified but NEVER grouped and
// NEVER merged — mangling a foreign or malformed number into +27 is exactly
// the bug this project exists to kill, so the core refuses to guess.
//
// Money safety: this module only PLANS. It never sums two credit amounts —
// live rules validate customers/$id/storeCredit/$creditId/remainingAmount as
// monotonically decreasing, so credits can only MOVE as intact records.

import { normalizeSAPhone } from "../../src/utils/phone.js";

// ── format classification ───────────────────────────────────────────────────

// Classify one raw phone string (a /customers key or a phone field value) into
// the format dialect it was stored in. Used for the census "distinct formats"
// table; grouping uses canonicalSA below, not this.
export function formatClass(raw) {
  const s = (raw == null ? "" : String(raw)).trim();
  if (!s) return "empty";
  if (s === "unknown") return "unknown-sentinel";
  const hasPlus = s.startsWith("+");
  const d = s.replace(/\D/g, "");
  if (!d) return "no-digits";
  if (hasPlus) {
    if (/^27\d{9}$/.test(d)) return "plus27-e164";        // +27813995333
    if (d.startsWith("27")) return "plus27-malformed";     // +27 but wrong length
    return "plus-foreign";                                 // +44…, +91…, …
  }
  if (/^0\d{9}$/.test(d)) return "local-0";                // 0813995333
  if (/^27\d{9}$/.test(d)) return "intl-27";               // 27813995333
  if (/^\d{9}$/.test(d) && !d.startsWith("0")) return "bare-9"; // 813995333
  if (d.startsWith("27")) return "intl-27-malformed";
  if (d.startsWith("0")) return "local-0-malformed";
  return `other-${d.length}d`;
}

// The canonical E.164 identity of a raw phone, or null when the input is not
// a well-formed SA number (9 significant digits after stripping +27/27/0).
// Null means: classify, report, leave alone.
export function canonicalSA(raw) {
  const s = (raw == null ? "" : String(raw)).trim();
  if (!s || s === "unknown") return null;
  const e164 = normalizeSAPhone(s);
  return /^\+27\d{9}$/.test(e164) ? e164 : null;
}

// The identity phone of a /customers record: the record KEY is the till-lookup
// identity (both apps probe key variants), so the key decides the group. The
// phone FIELD is censused separately; a field that canonicalises differently
// from its own key is reported as a mismatch, never silently regrouped.
export function recordCanonical(key) {
  return canonicalSA(key);
}

// ── grouping ────────────────────────────────────────────────────────────────

// customers: { key → record }. Returns Map<canonical, [{key, rec}, …]> holding
// ONLY canonicals with 2+ LIVE records (the collapse groups), plus side lists:
// unmergeable (no canonical identity) and tombstones (already merged away).
// Tombstones are excluded from membership — counting them would freeze a
// triple at "group of 3" forever after its first pair-merge, and make every
// post-merge dry run refuse the pairs it already merged (Fable review, #364).
export function collapseGroups(customers) {
  const byCanon = new Map();
  const unmergeable = [];
  const tombstones = [];
  for (const [key, rec] of Object.entries(customers || {})) {
    if (rec?.mergedInto) { tombstones.push({ key, rec }); continue; }
    const canon = recordCanonical(key);
    if (!canon) { unmergeable.push({ key, rec }); continue; }
    if (!byCanon.has(canon)) byCanon.set(canon, []);
    byCanon.get(canon).push({ key, rec });
  }
  const groups = new Map();
  for (const [canon, members] of byCanon) {
    if (members.length >= 2) groups.set(canon, members);
  }
  return { groups, byCanon, unmergeable, tombstones };
}

// ── name agreement → SAFE / REVIEW ──────────────────────────────────────────

// Normalise a customer name for comparison: lowercase, unicode-fold, strip
// everything but letters/digits/spaces, collapse whitespace.
export function nameNorm(name) {
  return (name == null ? "" : String(name))
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Classify one collapse group by name agreement.
//   SAFE   — same person beyond doubt: every NAMED record carries the same
//            normalised name (records with no name at all don't contradict —
//            they are order-flow records minted before a name was captured).
//            A group where NO record has a name is also SAFE: there is no
//            conflicting identity evidence, only the same phone.
//   REVIEW — two or more distinct non-empty names. A typo or a shared phone,
//            NOT provably one person. NEVER auto-merged; listed for the owner.
// The tag subdivides REVIEW so the owner can judge fast; it never loosens the
// classification (a subset/prefix name like "John" vs "John Smith" is still
// REVIEW — "probably the same" is not "beyond doubt").
export function classifyGroup(members) {
  const names = [...new Set(members.map((m) => nameNorm(m.rec?.name)).filter(Boolean))];
  if (names.length <= 1) {
    return { classification: "SAFE", tag: names.length === 0 ? "all-nameless" : "names-agree" };
  }
  const tokenSets = names.map((n) => new Set(n.split(" ")));
  const subset = tokenSets.some((a, i) =>
    tokenSets.some((b, j) => i !== j && [...a].every((t) => b.has(t))));
  return { classification: "REVIEW", tag: subset ? "name-subset" : "names-differ" };
}

// ── survivor selection ──────────────────────────────────────────────────────

// The surviving record of a group is the one with the MOST SALE HISTORY.
// Total order (first difference wins), computed per member:
//   1. posSales     — count of /customer_index/sales/{key} entries (POS sales)
//   2. orderCount   — the record's store-app order counter
//   3. lastOrderAt  — most recent activity
//   4. named beats nameless
//   5. local 0-form key beats other dialects (the canonical mint key)
//   6. lexically smaller key (pure determinism, never reached in practice)
// Deterministic regardless of member order — same rule shape as the client's
// beatsHeldCustomer, extended with real sale counts.
export function pickSurvivor(members, saleCounts = {}) {
  const score = (m) => ({
    posSales: saleCounts[m.key] || 0,
    orderCount: Number(m.rec?.orderCount) || 0,
    lastOrderAt: Date.parse(m.rec?.lastOrderAt || "") || 0,
    named: nameNorm(m.rec?.name) ? 1 : 0,
    localKey: /^0\d{9}$/.test(m.key) ? 1 : 0,
  });
  const sorted = [...members].sort((a, b) => {
    const sa = score(a), sb = score(b);
    return (sb.posSales - sa.posSales)
      || (sb.orderCount - sa.orderCount)
      || (sb.lastOrderAt - sa.lastOrderAt)
      || (sb.named - sa.named)
      || (sb.localKey - sa.localKey)
      || (a.key < b.key ? -1 : 1);
  });
  return { survivor: sorted[0], losers: sorted.slice(1) };
}

// ── credit accounting (census + merge invariant) ────────────────────────────

// Sum of every storeCredit child's remainingAmount on one record, in the units
// the records store (cents). Malformed amounts are counted as 0 but reported.
//
// Two live shapes exist: the current map { creditId: { remainingAmount, … } }
// and a LEGACY bare number (POS displays it but cannot redeem it). A legacy
// number is returned as { legacyNumber } — it cannot MOVE as a record (there
// is no record, only a scalar), so any group holding a positive legacy credit
// is unmergeable until that credit is converted by hand. Zero is just the
// POS's create-time default and counts as empty.
export function creditBalance(rec) {
  const credits = rec?.storeCredit;
  if (typeof credits === "number") {
    return { total: credits > 0 ? credits : 0, count: 0, bad: [], legacyNumber: credits };
  }
  let total = 0;
  const bad = [];
  for (const [id, c] of Object.entries(credits || {})) {
    const amt = c?.remainingAmount;
    if (typeof amt === "number" && Number.isFinite(amt) && amt >= 0) total += amt;
    else bad.push(id);
  }
  return { total, count: Object.keys(credits || {}).length, bad };
}

// Total credit across an entire { key → record } map — THE merge invariant:
// this number must be byte-identical before and after any merge.
export function totalCreditAcross(customers) {
  let total = 0, records = 0, credits = 0;
  for (const rec of Object.values(customers || {})) {
    const b = creditBalance(rec);
    if (b.count > 0) { records += 1; credits += b.count; total += b.total; }
  }
  return { total, records, credits };
}

// Apply a multi-path update map (the exact object handed to db.ref().update())
// to a plain JS tree, returning a NEW tree. null values delete, exactly like
// RTDB. Pure — exists so tests can simulate a merge end-to-end and prove the
// money invariant on the simulated result without touching any database.
export function applyUpdates(tree, updates) {
  const out = structuredClone(tree ?? {});
  for (const [path, value] of Object.entries(updates)) {
    const segs = path.split("/").filter(Boolean);
    let node = out;
    for (let i = 0; i < segs.length - 1; i++) {
      if (node[segs[i]] == null || typeof node[segs[i]] !== "object") node[segs[i]] = {};
      node = node[segs[i]];
    }
    const leaf = segs[segs.length - 1];
    if (value === null) delete node[leaf];
    else node[leaf] = structuredClone(value);
  }
  // RTDB never stores an empty object — a node whose last child is removed
  // ceases to exist. Prune so the simulation matches what a real read returns.
  const prune = (node) => {
    if (node == null || typeof node !== "object" || Array.isArray(node)) return node;
    for (const k of Object.keys(node)) {
      prune(node[k]);
      if (node[k] != null && typeof node[k] === "object" && !Array.isArray(node[k]) && Object.keys(node[k]).length === 0) {
        delete node[k];
      }
    }
    return node;
  };
  return prune(out);
}

// Read a path off a plain tree (test-side mirror of db.ref(path).once()).
export function readTreePath(tree, path) {
  let node = tree;
  for (const seg of path.split("/").filter(Boolean)) {
    if (node == null || typeof node !== "object") return null;
    node = node[seg];
  }
  return node === undefined ? null : node;
}

// ── the merge plan ──────────────────────────────────────────────────────────
//
// buildMergePlan is PURE: it takes everything the runner freshly read for one
// pair and returns either { refusals } (the group is skipped, with reasons) or
// { updates, preState, checks } where `updates` is ONE multi-path map applied
// atomically by a single update() call. Money rules baked in:
//
//   * storeCredit children MOVE VERBATIM (same creditId, same object, same
//     remainingAmount) from loser to survivor. Never summed, never rewritten —
//     live rules only ever let a credit amount decrease, and this plan never
//     writes an amount at all: it writes whole records to a path where none
//     existed and deletes the original. checks.creditCentsMoved proves the
//     totals conserve.
//   * pos/creditLedger balances are the one place two numbers become one:
//     survivor.balance + loser.balance (signed cents, value conserved, nothing
//     created or destroyed). Loser txns move verbatim; a zero-amount
//     "customer_merge" migration txn documents the fold on the survivor.
//   * NOTHING else is deleted: the loser record keeps name/phone/code and
//     gains mergedInto/mergedAt/mergedBatchId; every byte the plan touches is
//     captured in preState (the reversal recipe, persisted by the runner).

// The loser-referencing slices of the three small whole nodes. ONE predicate,
// used by the runner at plan time AND at drift-check time, so the records the
// plan writes from are exactly the records the drift fingerprint covers — a
// layby/order created for the loser after planning changes the slice and
// aborts the pair (Codex review, PR #364).
//
// Matching is on STRIPPED DIGITS, the same comparison the census uses — a
// layby whose customerPhone is stored as "+27619467420" belongs to the
// "27619467420" loser exactly as the census counted it (Fable review, #364).
// A value that canonicalises into this GROUP but matches neither member's
// digits (e.g. a bare-9 string when the pair is 0-form/27-form) lands in
// `ambiguous`, and buildMergePlan refuses the pair rather than stranding a
// layby on the tombstone silently.
export function extractLoserRefs(loserKey, laybys = {}, laybyPulls = {}, orders = {}, opts = {}) {
  const { survivorKey = null, canonical = null } = opts;
  const digitsOf = (v) => String(v || "").replace(/\D/g, "");
  const ambiguous = [];
  const pick = (node, field, kind) => {
    const out = {};
    for (const [id, v] of Object.entries(node || {})) {
      const d = digitsOf(v?.[field]);
      if (!d) continue;
      if (d === loserKey) { out[id] = v; continue; }
      if (d !== survivorKey && canonical && canonicalSA(d) === canonical) {
        ambiguous.push({ kind, id, value: v?.[field] });
      }
    }
    return out;
  };
  return {
    laybys: pick(laybys, "customerPhone", "layby"),
    pulls: pick(laybyPulls, "customerPhone", "laybyPull"),
    orders: pick(orders, "customerId", "order"),
    ambiguous,
  };
}

// Sales-history edges the plan re-points for the LOSER: customer_index/sales
// pointers move to the survivor and each pos/sales record's customerId is
// rewritten (the index is derived from pos/sales — re-pointing only the index
// would be undone by the next backfill, and layby instalments would keep
// writing money to the loser via sale.customerId).
export function buildMergePlan(input) {
  const {
    canonical, survivorKey, loserKey, survivor, loser,
    survivorLedger, loserLedger, survivorIndex, loserIndex,
    loserSaleOwners = {},      // saleId → pos/sales/{id}/customerId (fresh)
    loserCreditOwners = {},    // creditId → pos/storeCredits/{id}/customerId (fresh)
    loserRefs = { laybys: {}, pulls: {}, orders: {} }, // extractLoserRefs output
    loserAudit = {},           // { issued, removed, onAccount, onAccountConfig }
    survivorAudit = {},        // same shape — destinations, collision-checked
    classification, nowIso, mergeId, batchId,
  } = input;

  const refusals = [];
  const refuse = (why) => refusals.push({ canonical, why });

  const resweep = input.resweep === true;

  if (classification !== "SAFE") refuse(`classification is ${classification} — only SAFE groups merge`);
  for (const a of loserRefs.ambiguous || []) {
    refuse(`${a.kind} ${a.id} carries ${JSON.stringify(a.value)} — canonically this group but matching neither member key; fix the record by hand first`);
  }
  if (!survivor) refuse("survivor record missing on fresh read");
  if (!loser) refuse("loser record missing on fresh read");
  // resweep mode re-folds NEW accruals off an already-merged tombstone (the
  // POS can still write onto it until it ships mergedInto awareness) — there
  // the tombstone pointer is the precondition, not a refusal.
  if (!resweep && loser?.mergedInto) refuse(`loser already merged into ${loser.mergedInto}`);
  if (resweep && !loser?.mergedInto) refuse("resweep requested but loser carries no mergedInto pointer");
  if (survivor?.mergedInto) refuse(`survivor is itself merged into ${survivor.mergedInto}`);
  // A bare-9 survivor key is unreachable by the POS's variant probe (it lacks
  // the bare-9 dialect): every future till visit would re-mint a duplicate.
  // Sale history stays the stated survivor rule; a bare-9 winner REFUSES the
  // pair for an owner decision instead (Sonnet architect review, #364).
  if (/^\d{9}$/.test(survivorKey) && !survivorKey.startsWith("0"))
    refuse(`survivor ${survivorKey} is a bare-9 key the POS probe cannot find — owner must pick the survivor by hand`);

  const sBal = creditBalance(survivor || {});
  const lBal = creditBalance(loser || {});
  if (typeof survivor?.storeCredit === "number" && survivor.storeCredit > 0)
    refuse(`survivor has LEGACY number-shaped storeCredit ${survivor.storeCredit} — convert by hand first`);
  if (typeof loser?.storeCredit === "number" && loser.storeCredit > 0)
    refuse(`loser has LEGACY number-shaped storeCredit ${loser.storeCredit} — cannot move a scalar as a record`);
  if (sBal.bad.length || lBal.bad.length)
    refuse(`malformed credit records: ${[...sBal.bad, ...lBal.bad].join(",")}`);

  const loserCredits = (loser?.storeCredit && typeof loser.storeCredit === "object") ? loser.storeCredit : {};
  const survivorCredits = (survivor?.storeCredit && typeof survivor.storeCredit === "object") ? survivor.storeCredit : {};
  for (const cid of Object.keys(loserCredits)) {
    if (survivorCredits[cid] !== undefined) refuse(`creditId collision under survivor: ${cid}`);
    const owner = loserCreditOwners[cid];
    if (owner !== undefined && owner !== null && owner !== loserKey)
      refuse(`pos/storeCredits/${cid}.customerId is ${owner}, expected loser ${loserKey}`);
  }

  const loserHoldings = (loser?.laybyHoldings && typeof loser.laybyHoldings === "object") ? loser.laybyHoldings : {};
  const survivorHoldings = (survivor?.laybyHoldings && typeof survivor.laybyHoldings === "object") ? survivor.laybyHoldings : {};
  for (const sid of Object.keys(loserHoldings)) {
    if (survivorHoldings[sid] !== undefined) refuse(`laybyHoldings saleId collision under survivor: ${sid}`);
  }

  // On-account ledger fold rules: refuse any conflict a human should decide.
  const sLed = survivorLedger || null;
  const lLed = loserLedger || null;
  const sType = sLed?.accountType ?? null;
  const lType = lLed?.accountType ?? null;
  if (sType && lType && sType !== lType) refuse(`accountType conflict: survivor=${sType} loser=${lType}`);
  const sLimit = Number(sLed?.creditLimit) || 0;
  const lLimit = Number(lLed?.creditLimit) || 0;
  if (sLimit > 0 && lLimit > 0 && sLimit !== lLimit) refuse(`creditLimit conflict: survivor=${sLimit} loser=${lLimit}`);
  const sTxns = sLed?.txns || {};
  const lTxns = lLed?.txns || {};
  for (const tid of Object.keys(lTxns)) {
    if (sTxns[tid] !== undefined) refuse(`ledger txn id collision: ${tid}`);
  }
  if (sTxns[`merge_${mergeId}`] !== undefined) refuse(`merge txn merge_${mergeId} already on survivor ledger`);

  // Audit destinations are READ, never assumed absent: a collision would let
  // the move overwrite a survivor event, and rollback (whose preState would
  // wrongly say "absent") would then delete it (Codex review, PR #364).
  for (const k of ["issued", "removed", "onAccount", "onAccountConfig"]) {
    for (const eventId of Object.keys(loserAudit[k] || {})) {
      if ((survivorAudit[k] || {})[eventId] !== undefined)
        refuse(`audit event id collision under survivor (${k}): ${eventId}`);
    }
  }

  const loserIdx = loserIndex || {};
  const survivorIdx = survivorIndex || {};
  for (const saleId of Object.keys(loserIdx)) {
    if (survivorIdx[saleId] !== undefined) refuse(`customer_index sale pointer collision: ${saleId}`);
    const owner = loserSaleOwners[saleId];
    if (owner !== undefined && owner !== null && owner !== loserKey)
      refuse(`pos/sales/${saleId}.customerId is ${owner}, expected loser ${loserKey}`);
  }

  if (refusals.length) return { refusals };

  // ── build the single atomic update map ────────────────────────────────────
  const updates = {};
  const preState = {};
  const touch = (path, prior) => { preState[path] = prior === undefined ? null : prior; };

  // survivor bookkeeping fold (never overwrite survivor identity with loser's)
  const foldName = survivor.name || loser.name || "";
  if (foldName !== (survivor.name || "")) {
    touch(`customers/${survivorKey}/name`, survivor.name ?? null);
    updates[`customers/${survivorKey}/name`] = foldName;
  }
  if (loser.optedIn && !survivor.optedIn) {
    touch(`customers/${survivorKey}/optedIn`, survivor.optedIn ?? null);
    updates[`customers/${survivorKey}/optedIn`] = true;
  }
  const firsts = [survivor.firstOrderAt, loser.firstOrderAt].filter(Boolean).sort();
  if (firsts.length && firsts[0] !== (survivor.firstOrderAt || null)) {
    touch(`customers/${survivorKey}/firstOrderAt`, survivor.firstOrderAt ?? null);
    updates[`customers/${survivorKey}/firstOrderAt`] = firsts[0];
  }
  const lasts = [survivor.lastOrderAt, loser.lastOrderAt].filter(Boolean).sort();
  if (lasts.length && lasts[lasts.length - 1] !== (survivor.lastOrderAt || null)) {
    touch(`customers/${survivorKey}/lastOrderAt`, survivor.lastOrderAt ?? null);
    updates[`customers/${survivorKey}/lastOrderAt`] = lasts[lasts.length - 1];
  }
  const loserOrders = Number(loser.orderCount) || 0;
  if (loserOrders > 0) {
    touch(`customers/${survivorKey}/orderCount`, survivor.orderCount ?? null);
    updates[`customers/${survivorKey}/orderCount`] = (Number(survivor.orderCount) || 0) + loserOrders;
  }

  // store credit records MOVE verbatim
  let creditCentsMoved = 0;
  for (const [cid, credit] of Object.entries(loserCredits)) {
    touch(`customers/${survivorKey}/storeCredit/${cid}`, undefined);
    touch(`customers/${loserKey}/storeCredit/${cid}`, credit);
    updates[`customers/${survivorKey}/storeCredit/${cid}`] = credit;
    updates[`customers/${loserKey}/storeCredit/${cid}`] = null;
    creditCentsMoved += Number(credit?.remainingAmount) || 0;
    if (loserCreditOwners[cid] !== undefined) {
      touch(`pos/storeCredits/${cid}/customerId`, loserCreditOwners[cid]);
      updates[`pos/storeCredits/${cid}/customerId`] = survivorKey;
    }
  }

  // layby holdings MOVE verbatim
  for (const [sid, holding] of Object.entries(loserHoldings)) {
    touch(`customers/${survivorKey}/laybyHoldings/${sid}`, undefined);
    touch(`customers/${loserKey}/laybyHoldings/${sid}`, holding);
    updates[`customers/${survivorKey}/laybyHoldings/${sid}`] = holding;
    updates[`customers/${loserKey}/laybyHoldings/${sid}`] = null;
  }

  // on-account ledger fold
  let ledgerCentsMoved = 0;
  if (lLed) {
    const sBalance = Number(sLed?.balance) || 0;
    const lBalance = Number(lLed.balance) || 0;
    touch(`pos/creditLedger/${loserKey}`, lLed);
    updates[`pos/creditLedger/${loserKey}`] = null;
    touch(`pos/creditLedger/${survivorKey}/balance`, sLed?.balance ?? null);
    updates[`pos/creditLedger/${survivorKey}/balance`] = sBalance + lBalance;
    ledgerCentsMoved = lBalance;
    if (!sType && lType) {
      touch(`pos/creditLedger/${survivorKey}/accountType`, null);
      updates[`pos/creditLedger/${survivorKey}/accountType`] = lType;
    }
    if (lLimit > 0 && sLimit === 0) {
      touch(`pos/creditLedger/${survivorKey}/creditLimit`, sLed?.creditLimit ?? null);
      updates[`pos/creditLedger/${survivorKey}/creditLimit`] = lLimit;
    }
    for (const [tid, txn] of Object.entries(lTxns)) {
      touch(`pos/creditLedger/${survivorKey}/txns/${tid}`, undefined);
      updates[`pos/creditLedger/${survivorKey}/txns/${tid}`] = txn;
    }
    const mtid = `merge_${mergeId}`;
    touch(`pos/creditLedger/${survivorKey}/txns/${mtid}`, undefined);
    updates[`pos/creditLedger/${survivorKey}/txns/${mtid}`] = {
      txnId: mtid, amount: 0, source: "migration", kind: "customer_merge",
      at: nowIso, ref: mergeId, note: `folded ledger of ${loserKey} (balance ${lBalance}) into ${survivorKey}`,
    };
  }

  // sale-history pointers + the sale records they derive from
  for (const [saleId, ptr] of Object.entries(loserIdx)) {
    touch(`customer_index/sales/${survivorKey}/${saleId}`, undefined);
    touch(`customer_index/sales/${loserKey}/${saleId}`, ptr);
    updates[`customer_index/sales/${survivorKey}/${saleId}`] = ptr;
    updates[`customer_index/sales/${loserKey}/${saleId}`] = null;
  }
  // Re-point scope: index rows + layby holdings + laybys carrying the loser's
  // phone (laybyId === saleId). The laybys leg covers an open layby whose
  // holding or index row was never written — its instalments read
  // sale.customerId and must land on the survivor (Codex review, PR #364).
  const salesToRepoint = new Set([
    ...Object.keys(loserIdx).filter((sid) => loserSaleOwners[sid] === loserKey),
    ...Object.keys(loserHoldings).filter((sid) => loserSaleOwners[sid] === loserKey),
    ...Object.keys(loserRefs.laybys).filter((sid) => loserSaleOwners[sid] === loserKey),
  ]);
  for (const saleId of salesToRepoint) {
    touch(`pos/sales/${saleId}/customerId`, loserKey);
    updates[`pos/sales/${saleId}/customerId`] = survivorKey;
  }

  // laybys / laybyPulls carry the loser KEY as customerPhone — re-point.
  // The slices arrive pre-filtered (extractLoserRefs, the same predicate the
  // drift check fingerprints), so iteration here is total.
  const repointedLaybys = [];
  for (const [id, l] of Object.entries(loserRefs.laybys)) {
    touch(`laybys/${id}/customerPhone`, l.customerPhone);
    updates[`laybys/${id}/customerPhone`] = survivorKey;
    repointedLaybys.push({ id, invoiceNo: l.invoiceNo, status: l.status });
  }
  for (const [id, p] of Object.entries(loserRefs.pulls)) {
    touch(`laybyPulls/${id}/customerPhone`, p.customerPhone);
    updates[`laybyPulls/${id}/customerPhone`] = survivorKey;
  }

  // open store-app orders pointing at the loser
  for (const [id] of Object.entries(loserRefs.orders)) {
    touch(`orders/${id}/customerId`, loserKey);
    updates[`orders/${id}/customerId`] = survivorKey;
  }

  // audit subtrees MOVE verbatim (event push-keys are globally unique)
  const auditMap = {
    issued: "pos/audit/store_credit_issued",
    removed: "pos/audit/store_credit_removed",
    onAccount: "pos/audit/on_account",
    onAccountConfig: "pos/audit/on_account_config",
  };
  for (const [k, base] of Object.entries(auditMap)) {
    for (const [eventId, ev] of Object.entries(loserAudit[k] || {})) {
      touch(`${base}/${survivorKey}/${eventId}`, undefined);
      touch(`${base}/${loserKey}/${eventId}`, ev);
      updates[`${base}/${survivorKey}/${eventId}`] = ev;
      updates[`${base}/${loserKey}/${eventId}`] = null;
    }
  }

  // tombstone the loser (identity fields preserved) + the merge record. On a
  // resweep the pointer is re-aimed at the ULTIMATE survivor (the chain may
  // have moved since the original merge).
  touch(`customers/${loserKey}/mergedInto`, loser.mergedInto ?? null);
  touch(`customers/${loserKey}/mergedAt`, loser.mergedAt ?? null);
  touch(`customers/${loserKey}/mergedBatchId`, loser.mergedBatchId ?? null);
  updates[`customers/${loserKey}/mergedInto`] = survivorKey;
  updates[`customers/${loserKey}/mergedAt`] = nowIso;
  updates[`customers/${loserKey}/mergedBatchId`] = batchId;

  // Recorded in preState (as previously-absent) so a disk-snapshot rollback
  // removes the bookkeeping rows too, not just the data writes. The audit row
  // follows the established pos/audit shape — {category}/{customerId}/{eventId}
  // — so a per-customer audit-trail reader finds merges without special-casing
  // (Sonnet architect review, #364).
  touch(`customer_merges/${mergeId}`, undefined);
  touch(`pos/audit/customer_merge/${survivorKey}/${mergeId}`, undefined);
  updates[`customer_merges/${mergeId}`] = {
    mergeId, batchId, canonical, survivor: survivorKey, loser: loserKey, at: nowIso,
    resweep, creditCentsMoved, ledgerCentsMoved,
    loserRecord: loser,                      // full pre-merge loser record
    preState,                                // every path this merge changed, prior value
  };
  updates[`pos/audit/customer_merge/${survivorKey}/${mergeId}`] = {
    action: "customer_merge", actingUserUid: "customer-merge-script",
    timestamp: nowIso, targetCustomerId: survivorKey,
    details: { loser: loserKey, canonical, mergeId, batchId, resweep },
  };

  return {
    updates,
    preState,
    checks: {
      creditCentsMoved,
      creditRecordsMoved: Object.keys(loserCredits).length,
      ledgerCentsMoved,
      ledgerTxnsMoved: Object.keys(lTxns).length,
      holdingsMoved: Object.keys(loserHoldings).length,
      salesRepointed: salesToRepoint.size,
      indexPointersMoved: Object.keys(loserIdx).length,
      laybysRepointed: repointedLaybys,
      expectedSurvivorCreditCents: sBal.total + lBal.total,
      expectedLoserCreditCents: 0,
    },
  };
}
