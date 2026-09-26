// ─── setProductType — THE ONE WAY A PRODUCT'S TYPE CHANGES ───────────────────
// The edit page's Sneaker / Clothing toggle calls this instead of writing
// productType itself. Decisions are in lib/product-type.cjs: manager-only once
// a product has stock or sales, never strands Hub 1 stock, and every change is
// logged on the product under typeLog with the person, the device and the
// server's time. "Manager" is managerIdentity from device enrolment: Junid, or
// MC's enrolled code-making device.
//
// Reads are per path: the product, and its cell at each location (the location
// list is a shallow key read of /locations).
//
// Deploy by name, never bare:
//   firebase deploy --only functions:setProductType
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { randomUUID } = require("node:crypto");
const admin = require("firebase-admin");
const { planTypeChange } = require("../lib/product-type.cjs");
const { managerIdentity } = require("../deviceEnrolment/deviceEnrolment.js");

if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}

const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function readCells(db, pid) {
  const locSnap = await db.ref("locations").orderByKey().limitToFirst(100).once("value");
  const locs = [...new Set([...Object.keys(locSnap.val() || {}), "in_transit"])];
  const out = {};
  await Promise.all(locs.map(async (l) => {
    const v = (await db.ref(`stock/${l}/${pid}`).once("value")).val();
    if (v && typeof v === "object") out[l] = v;
  }));
  return out;
}

async function whoIs(db, auth, manager, clientDeviceId) {
  const t = auth.token || {};
  if (manager) return { personName: manager.by, deviceId: manager.deviceId || clientDeviceId || null, deviceVerified: !!manager.deviceId };
  if (typeof t.personName === "string" && typeof t.deviceId === "string") {
    return { personName: t.personName, deviceId: t.deviceId, deviceVerified: true };
  }
  const u = (await db.ref(`users/${auth.uid}`).once("value")).val() || {};
  return {
    personName: u.displayName || u.username || (t.email ? String(t.email).split("@")[0] : null),
    deviceId: clientDeviceId || null, deviceVerified: false,
  };
}

async function handleSetProductType(request, deps) {
  const { db } = deps;
  const auth = request.auth;
  if (!auth || !auth.uid || auth.token?.firebase?.sign_in_provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const pid = typeof request.data?.productId === "string" && PID_RE.test(request.data.productId) ? request.data.productId : null;
  if (!pid) throw new HttpsError("invalid-argument", "Which product?");
  const clientDeviceId = typeof request.data?.deviceId === "string" && DEVICE_RE.test(request.data.deviceId) ? request.data.deviceId : null;

  const [product, cellsByLoc, manager] = await Promise.all([
    db.ref(`products/${pid}`).once("value").then((s) => s.val()),
    readCells(db, pid),
    deps.managerIdentity(db, auth),
  ]);
  const plan = planTypeChange(product, request.data?.productType, { cellsByLoc, isManager: !!manager });
  if (!plan.ok) throw new HttpsError(plan.code, plan.message);
  if (plan.noop) return { ok: true, noop: true, productType: plan.after.productType };

  const now = deps.now();
  const by = await whoIs(db, auth, manager, clientDeviceId);
  const key = `${now}_${deps.newId().slice(0, 8)}`;
  const update = {
    ...Object.fromEntries(Object.entries(plan.patch).map(([k, v]) => [`products/${pid}/${k}`, v])),
    [`products/${pid}/typeChangedAt`]: now,
    [`products/${pid}/typeLog/${key}`]: {
      from: plan.before.productType || "sneaker", to: plan.after.productType, atMs: now,
      personName: by.personName || null, deviceId: by.deviceId || null, deviceVerified: by.deviceVerified,
      uid: auth.uid, manager: !!manager,
      hubsBefore: plan.before.hubs.length ? plan.before.hubs : null, hubsAfter: plan.after.hubs.length ? plan.after.hubs : null,
      sizesBefore: plan.before.sizes.length ? plan.before.sizes : null,
    },
  };
  await db.ref().update(update);
  return { ok: true, productType: plan.after.productType, hubs: plan.after.hubs, patch: plan.patch };
}

exports.setProductType = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30, maxInstances: 5 },
  (request) => handleSetProductType(request, {
    db: admin.database(), now: () => Date.now(), newId: () => randomUUID(), managerIdentity,
  }),
);
exports._handleSetProductType = handleSetProductType;
