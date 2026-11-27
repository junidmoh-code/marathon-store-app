// ─── setProductName — HOW THE APP RENAMES A PRODUCT (Junid, 27 Nov 2026) ─────
// The Admin product page's Name field (Edit → Save) calls this instead of
// writing /products/{pid}/name itself. Built the same way as setProductType,
// sharing its reads: same staff check, same "manager-only once a product has
// stock or sales" rule, and every rename logged under product_name_log with
// the person, the device and the server's time. The decisions are pure, in
// lib/product-rename.cjs (which also says what else a rename updates, and
// why refill requests are never written).
//
// Reads are per path: the product, its cell at each location (bounded
// /locations registry), its pending name proposal, and its open refill
// requests by the productId index (counted only — they are matched by pid
// and stay attached).
//
// THE TWIN CHECK, ON BOTH SIDES. The page refuses a name another product has
// (against the catalogue it holds, normalised — case and spacing). The server
// re-checks the exact name with an INDEXED query over REST (findByName): if
// /products has no "name" index, the REST API refuses the query with "Index
// not defined" instead of downloading the catalogue, and the server says so
// in its log and leans on the page's check. (The Admin SDK would silently read
// the whole node for an unindexed orderByChild — never used here.) The index
// is a console rule: products/.indexOn ["styleCodeNormalised", "name"].
//
// THE NAME IS COMPARE-AND-SET. A transaction on products/{pid}/name writes the
// new name only while the stored name is still the one the person started
// editing; then one multi-path update carries the name (again, idempotent),
// its history and the log entry. If that update fails, the name is put back.
//
// Deploy by name, never bare:
//   firebase deploy --only functions:setProductName
"use strict";
const { requireStaffRecord } = require("../lib/require-staff-record.cjs");

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { randomUUID } = require("node:crypto");
const admin = require("firebase-admin");
const { planRename, renameUpdate, twinsOf, NAME_PROPOSALS_ROOT } = require("../lib/product-rename.cjs");
const { managerIdentity } = require("../deviceEnrolment/deviceEnrolment.js");
const { _readCells: readCells, _whoIs: whoIs } = require("./setProductType.js");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function countOpenRequests(db, pid) {
  const snap = await db.ref("refill_requests").orderByChild("productId").equalTo(pid).once("value");
  return Object.values(snap.val() || {}).filter((r) => r && !r.resolvedAt
    && !["fulfilled", "cancelled", "closed", "resolved", "out_of_stock"].includes(r.status)).length;
}

// Exact-name lookup through the REST API's index. Returns the matching
// products, or null when the index is not live (the API refuses; nothing read).
async function findByNameRest(name) {
  const app = admin.app();
  const base = app.options.databaseURL || "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
  const { access_token: token } = await app.options.credential.getAccessToken();
  const url = `${base}/products.json?orderBy=${encodeURIComponent('"name"')}&equalTo=${encodeURIComponent(JSON.stringify(name))}&limitToFirst=5`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 400) return null;              // "Index not defined" — refused, nothing downloaded
  if (!res.ok) throw new Error(`name lookup ${res.status}`);
  return (await res.json()) || {};
}

async function handleSetProductName(request, deps) {
  const { db } = deps;
  const auth = request.auth;
  await requireStaffRecord(db, auth, HttpsError);
  const pid = typeof request.data?.productId === "string" && PID_RE.test(request.data.productId) ? request.data.productId : null;
  if (!pid) throw new HttpsError("invalid-argument", "Which product?");
  const clientDeviceId = typeof request.data?.deviceId === "string" && DEVICE_RE.test(request.data.deviceId) ? request.data.deviceId : null;

  const [product, cellsByLoc, manager, proposal] = await Promise.all([
    db.ref(`products/${pid}`).once("value").then((s) => s.val()),
    readCells(db, pid),
    deps.managerIdentity(db, auth),
    db.ref(`${NAME_PROPOSALS_ROOT}/${pid}`).once("value").then((s) => s.val()),
  ]);
  const plan = planRename(product, request.data?.name, {
    from: request.data?.from, cellsByLoc, isManager: !!manager, extras: request.data?.extras,
  });
  if (!plan.ok) throw new HttpsError(plan.code, plan.message);
  if (plan.noop) return { ok: true, noop: true, name: plan.to };

  // The server's own twin check (indexed; see the header).
  let twins = null;
  try { twins = await deps.findByName(plan.to); } catch (e) { console.warn(`setProductName: name lookup failed: ${e?.message || e}`); }
  if (twins === null) console.warn("setProductName: no /products name index — relying on the page's twin check");
  const twin = twinsOf(twins || {}, pid, plan.to)[0];
  if (twin) {
    throw new HttpsError("already-exists",
      `“${twin.name}” is already the name of another product (${twins[twin.id]?.styleCode || twin.id}). Choose a different name.`);
  }

  const openRequests = await countOpenRequests(db, pid).catch(() => 0);
  const now = deps.now();
  const by = await whoIs(db, auth, manager, clientDeviceId);
  const key = `${now}_${deps.newId().slice(0, 8)}`;

  // Compare-and-set on the name the person started editing.
  const expected = plan.from;
  let clash = false;
  const txn = await db.ref(`products/${pid}/name`).transaction((cur) => {
    if (cur === null && expected) return null;                // cold-cache probe
    if ((cur ?? "") !== expected) { clash = true; return undefined; }
    clash = false;
    return plan.to;
  });
  if (!txn.committed || clash || txn.snapshot.val() !== plan.to) {
    throw new HttpsError("aborted", "Someone else renamed this product a moment ago. Look again, then try again.");
  }
  const update = renameUpdate({ pid, plan, now, key, by, uid: auth.uid, manager, proposal, openRequests });
  // ONE multi-path write: the name, its history and the log land together.
  try {
    await db.ref().update(update);
  } catch (err) {
    // Put the name back so it never stands without its log entry.
    await db.ref(`products/${pid}/name`).transaction((cur) => (cur === null ? null : cur === plan.to ? expected : undefined)).catch(() => {});
    throw new HttpsError("unavailable", `The rename could not be saved (${err?.message || err}). Nothing was changed — try again.`);
  }
  const patch = { name: plan.to, nameChangedAt: now, previousNames: plan.previousNames.length ? plan.previousNames : null, ...plan.extras };
  return { ok: true, name: plan.to, from: plan.from, openRefillRequests: openRequests, patch };
}

exports.setProductName = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30, maxInstances: 5 },
  (request) => handleSetProductName(request, {
    db: admin.database(), now: () => Date.now(), newId: () => randomUUID(), managerIdentity, findByName: findByNameRest,
  }),
);
exports._handleSetProductName = handleSetProductName;
