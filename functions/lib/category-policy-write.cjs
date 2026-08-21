// ─── setCategoryPolicy — THE WRITE PATH ───────────────────────────────────────
//
// The whole of the callable's behaviour lives here, with `db` and the caller's
// email injected, so every branch — including the two that must never be
// deletable — is exercisable by a test with a fake database. functions/index.js
// holds only the onCall wrapper.
//
// ── GATE 3 OF 3: THE SERVER CHECK ────────────────────────────────────────────
// assertSuperAdmin below is the THIRD independent gate on the Engine Policy
// feature. The other two are in the client (the home tile does not render, and
// the route refuses to mount the component). Those two are CONVENIENCE AND
// HONESTY, not security: anyone can edit their own JavaScript. This one is the
// only gate an attacker cannot reach around, and it fails closed on an absent
// token, an anonymous session, a staff {username}@marathon.internal account,
// and any Google account that is not the owner's.
//
// ── AND IT IS STILL NOT A SECURITY BOUNDARY, TODAY ───────────────────────────
// STATE THIS PLAINLY BECAUSE IT IS TRUE: the ROOT RTDB rules on this database
// are `".read": "auth !== null", ".write": "auth !== null"`. /config has no
// tighter rule of its own. So ANY signed-in staff account can today write
// /config/refillEngine/categoryPolicy directly through the client SDK, bypass
// this function entirely, and neither the validation, the drift check, the
// rollback snapshot nor the audit entry below would run.
//
// This function is therefore the only SUPPORTED way to change the policy, and
// the only one that leaves evidence — but it is not yet the only POSSIBLE way.
// It becomes a real boundary the moment the console rule printed by
// scripts/print-engine-policy-rule.mjs is pasted into the Firebase console.
// Until then, treat every gate in this feature as an operational control, not
// a security control, and do not tell anyone otherwise.
//
// ── WHY THE HISTORY IS WRITTEN BEFORE THE MUTATION ───────────────────────────
// A rollback snapshot written afterwards is a snapshot you do not have when the
// write is the thing that went wrong. The order here is: read live → drift
// check → WRITE THE HISTORY ENTRY (holding `before` in full) → re-read live →
// drift check AGAIN → mutate → re-read and verify. If the process dies at any
// point after the history write, the previous policy is on disk in RTDB and one
// tap of Revert in the card restores it.

const {
  validateCategoryPolicy, diffCategoryPolicy, modelCategoryPolicy, defaultMinQty,
} = require("./category-policy.cjs");

const HISTORY_PATH = "engine_policy_history";
const POLICY_PATH = "config/refillEngine/categoryPolicy";

// Canonical JSON, for equality only. Key order in RTDB is not stable across
// reads, so a raw JSON.stringify comparison would report drift that is not
// there — and a drift check that cries wolf gets switched off.
function canonical(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const sameValue = (a, b) => canonical(a) === canonical(b);

// ── GATE 3 ───────────────────────────────────────────────────────────────────
// Email identity, deliberately, and deliberately NOT a permissions array:
// the owner's own /users record carries no permissions array at all — his
// access works because hasPermission short-circuits on the hardcoded admin
// constant. A permission-based gate here would lock out the one person the
// feature exists for while letting through anyone a permission was granted to.
// Staff sign in as {username}@marathon.internal and can never match.
//
// DELETING THIS FUNCTION, OR ITS CALL, MUST FAIL TESTS. See
// scripts/mutation-proof-engine-policy.mjs (M-SERVER).
function assertSuperAdmin(callerEmail, adminEmail) {
  if (!adminEmail) throw httpsError("failed-precondition", "Admin identity is not configured.");
  if (typeof callerEmail !== "string" || callerEmail !== adminEmail) {
    throw httpsError("permission-denied", "Engine policy is owner-only.");
  }
}

// The callable protocol's error shape, produced without importing
// firebase-functions so this module stays unit-testable in plain node. The
// wrapper in index.js re-throws these as real HttpsErrors.
function httpsError(code, message, details) {
  const e = new Error(message);
  e.httpsCode = code;
  if (details) e.details = details;
  return e;
}

// Paged map read. Live bandwidth is billed and a preview must not cost a
// whole-node download; this is the same cursor discipline as
// scripts/lib/rtdbPaged.mjs (snapshot iteration order, inclusive startAt,
// terminate on NEW records rather than raw key count).
async function readMapPaged(db, path, pageSize = 500) {
  const out = {};
  let lastKey = null;
  for (;;) {
    let q = db.ref(path).orderByKey().limitToFirst(pageSize + (lastKey ? 1 : 0));
    if (lastKey) q = q.startAt(lastKey);
    const snap = await q.once("value");
    const keys = [];
    snap.forEach((c) => { keys.push(c.key); });
    let added = 0;
    for (const k of keys) {
      if (k === lastKey) continue;
      out[k] = snap.child(k).val();
      added += 1;
    }
    if (added === 0) break;
    lastKey = keys[keys.length - 1];
    if (added < pageSize) break;
  }
  return out;
}

const val = (db, path) => db.ref(path).once("value").then((s) => s.val());

// ── NORMALISE THE INCOMING EDIT ──────────────────────────────────────────────
// The card sends whole numbers or blanks. Blank "Ask at" means ABSENT, which is
// a real and different policy from 0 (absent = top up eagerly; 0 = ask only
// when the shelf is empty), so it is dropped from the object rather than
// coerced. minQty is filled from ceil(keep / 2) when the caller omits it, which
// is the ratio every armed batch has used and what the engine falls back to
// anyway — so the owner never types it from scratch and the value is never a
// surprise.
function normalizePolicy(input) {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out = {};
  if (input.perSize === true) out.perSize = true;
  for (const [loc, raw] of Object.entries(input)) {
    if (loc === "perSize") continue;
    if (raw === null || raw === undefined) continue;      // location removed
    if (typeof raw !== "object" || Array.isArray(raw)) { out[loc] = raw; continue; }
    // Unknown fields are CARRIED THROUGH, not stripped. Stripping them would
    // make the validator's unknown-field guard unreachable and turn a typo
    // ("reorderpoint: 2") into a silently ignored edit that the owner watches
    // save successfully and then does nothing. Let validation say so instead.
    const entry = { ...raw, target: raw.target };
    entry.minQty = raw.minQty === undefined || raw.minQty === null
      ? defaultMinQty(raw.target)
      : raw.minQty;
    if (raw.reorderPoint === undefined || raw.reorderPoint === null) delete entry.reorderPoint;
    out[loc] = entry;
  }
  return out;
}

// ── THE PREVIEW ──────────────────────────────────────────────────────────────
// Reads only what the model needs: the catalogue, and the stock / target /
// open-intent maps for the locations actually involved. Central is always
// included because it is the only place a hub deficit can be filled from and
// "Central holds N" is half the verdict.
async function buildPreview(db, { config, categoryKey, policyAfter, locations }) {
  const configAfter = {
    ...config,
    categoryPolicy: { ...(config.categoryPolicy || {}), ...(policyAfter === null ? {} : { [categoryKey]: policyAfter }) },
  };
  if (policyAfter === null) delete configAfter.categoryPolicy[categoryKey];

  const involved = new Set(["central"]);
  for (const src of [config.categoryPolicy?.[categoryKey], policyAfter]) {
    if (src && typeof src === "object") for (const k of Object.keys(src)) if (k !== "perSize") involved.add(k);
  }
  // Carriage has to be answered for EVERY location the card can offer, not just
  // the armed ones — "Not carried" is the reason a row is not editable, so the
  // card needs the answer for the rows it greys out too.
  const carriageLocs = [...new Set([...involved, ...(locations || [])])];

  const products = await readMapPaged(db, "products");
  const stock = {}, targets = {}, openIndex = {};
  for (const loc of carriageLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`);
  for (const loc of involved) {
    targets[loc] = await readMapPaged(db, `stock_targets/${loc}`);
    openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`);
  }
  const args = {
    products, stock, targets, openIndex, categoryKey, locations: carriageLocs,
    maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
  };
  return {
    before: modelCategoryPolicy({ config, ...args }),
    after: modelCategoryPolicy({ config: configAfter, ...args }),
  };
}

// ── THE ENTRY POINT ──────────────────────────────────────────────────────────
async function applyCategoryPolicy({ db, callerEmail, adminEmail, callerUid, data, nowMs }) {
  assertSuperAdmin(callerEmail, adminEmail);

  const d = data && typeof data === "object" ? data : {};
  const categoryKey = d.categoryKey;
  const dryRun = d.dryRun === true;

  const [config, taxonomy, locationsNode] = await Promise.all([
    val(db, "config/refillEngine"), val(db, "settings/productTaxonomy"), val(db, "locations"),
  ]);
  const cfg = config && typeof config === "object" ? config : {};
  const knownCategoryKeys = Object.keys(taxonomy?.cats || {});
  const knownLocations = Object.keys(locationsNode || {});

  const policyAfter = normalizePolicy(d.policy === undefined ? null : d.policy);
  const err = validateCategoryPolicy(categoryKey, policyAfter, { knownLocations, knownCategoryKeys });
  if (err) throw httpsError("invalid-argument", err);

  const before = cfg.categoryPolicy?.[categoryKey] ?? null;

  // ── DRIFT ─────────────────────────────────────────────────────────────────
  // The card sends back the exact entry it rendered the editor from. If live no
  // longer matches it, somebody (or something) changed the policy while this
  // edit was open, and saving would silently discard their change. Abort and
  // make the owner re-open it.
  //
  // A dryRun skips this on purpose: a preview is a question, not a write, and
  // refusing to answer it because the world moved is unhelpful.
  //
  // DELETING THIS CHECK MUST FAIL TESTS. See mutation M-DRIFT.
  if (!dryRun && d.expectedBefore !== undefined && !sameValue(before, d.expectedBefore === null ? null : d.expectedBefore)) {
    throw httpsError("failed-precondition",
      "The policy changed while this was open. Close and re-open the category to see the current numbers.",
      { drift: true, live: before });
  }

  const changes = diffCategoryPolicy(before, policyAfter);
  const preview = await buildPreview(db, { config: cfg, categoryKey, policyAfter, locations: knownLocations });

  if (dryRun) {
    return { ok: true, dryRun: true, categoryKey, before, after: policyAfter, changes, preview, live: before };
  }
  if (!changes.length) {
    return { ok: true, noChange: true, categoryKey, before, after: policyAfter, changes: [], preview };
  }

  // ── HISTORY FIRST ─────────────────────────────────────────────────────────
  const historyRef = db.ref(HISTORY_PATH).push();
  await historyRef.set({
    categoryKey,
    at: nowMs,
    by: callerEmail,
    byUid: callerUid || null,
    before: before === undefined ? null : before,
    after: policyAfter,
    changes,
    // The model the decision was taken on, kept small: the per-leg totals only,
    // not the row lists. A revert six weeks from now should be able to see what
    // was expected at the time without re-deriving it against stock that moved.
    modelled: {
      requestsBefore: preview.before.totalRequests, requestsAfter: preview.after.totalRequests,
      unitsBefore: preview.before.totalUnits, unitsAfter: preview.after.totalUnits,
      centralOnHand: preview.after.centralOnHand, cap: preview.after.cap,
      overriddenProducts: preview.after.overriddenProducts,
    },
    status: "pending",
  });

  // ── RE-READ AND DRIFT AGAIN, IMMEDIATELY BEFORE THE MUTATION ──────────────
  // The preview above can take seconds (it pages the catalogue). This is the
  // check that actually protects the write; the earlier one just fails fast.
  const liveNow = await val(db, `${POLICY_PATH}/${categoryKey}`);
  if (!sameValue(liveNow ?? null, before)) {
    await historyRef.update({ status: "aborted_on_drift", liveAtAbort: liveNow ?? null });
    throw httpsError("failed-precondition",
      "The policy changed while this was being saved. Nothing was written.",
      { drift: true, live: liveNow ?? null, historyId: historyRef.key });
  }

  await db.ref(`${POLICY_PATH}/${categoryKey}`).set(policyAfter);

  // ── POST-VERIFY ───────────────────────────────────────────────────────────
  const written = await val(db, `${POLICY_PATH}/${categoryKey}`);
  const verified = sameValue(written ?? null, policyAfter);
  await historyRef.update({ status: verified ? "applied" : "unverified", verifiedAt: nowMs });
  if (!verified) {
    throw httpsError("internal",
      "The policy was written but did not read back as expected. Check the category before relying on it.",
      { historyId: historyRef.key, written: written ?? null });
  }

  return { ok: true, categoryKey, before, after: policyAfter, changes, preview, historyId: historyRef.key };
}

module.exports = {
  applyCategoryPolicy, assertSuperAdmin, normalizePolicy, canonical, sameValue,
  HISTORY_PATH, POLICY_PATH, httpsError, readMapPaged,
};
