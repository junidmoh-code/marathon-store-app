#!/usr/bin/env node
// ─── STEP 1 — INVESTIGATE (read-only) ────────────────────────────────────────
// Resolves both products, lists every stock cell of both per location, maps
// the sizes, and lists everything that references the duplicate. Writes
// nothing to the database. Every read is narrow: by product id, by key prefix,
// or by an indexed query — never a whole node.
//
//   node scripts/merge-dunk-grey-kids/investigate.mjs [--out file.json]
//
// Uses Application Default Credentials (gcloud auth application-default login).
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { adminRequire } from "../adminRequire.mjs";
import { KEEP_ID, REMOVE_ID, KEEP_STYLE_NORMALISED, mapSizes, sameProductProblems, sizeCells } from "./core.mjs";

const { COUNT_SESSIONS_PATH, COUNTED_PATH } = createRequire(import.meta.url)("../../functions/lib/merge-disposition.cjs");

export async function investigate(db) {
  const val = async (path) => (await db.ref(path).once("value")).val();
  const keep = await val(`products/${KEEP_ID}`);
  const remove = await val(`products/${REMOVE_ID}`);
  const claim = await val(`style_code_index/${KEEP_STYLE_NORMALISED}`);
  const removeClaims = (await db.ref("style_code_index").orderByChild("productId").equalTo(REMOVE_ID).once("value")).val();
  const registry = (await val("locations")) || {};
  const locs = Object.keys(registry);

  const keepStock = {};
  const removeStock = {};
  for (const loc of locs) {
    const k = await val(`stock/${loc}/${KEEP_ID}`);
    const r = await val(`stock/${loc}/${REMOVE_ID}`);
    if (k) keepStock[loc] = k;
    if (r) removeStock[loc] = r;
  }

  // Sales: the ledger from the moment the ORIGINAL was created (19 Nov) — a
  // bounded, indexed (ts) window, filtered to the two ids.
  const fromIso = new Date(Number(KEEP_ID.slice(1))).toISOString();
  const mv = (await db.ref("stock_movements").orderByChild("ts").startAt(fromIso).once("value")).val() || {};
  const sales = { [KEEP_ID]: { sold: 0, returned: 0, last: null }, [REMOVE_ID]: { sold: 0, returned: 0, last: null } };
  const removeMovements = [];
  for (const [id, m] of Object.entries(mv)) {
    if (!m || !sales[m.productId]) continue;
    const s = sales[m.productId];
    if (m.type === "sold") { s.sold += Number(m.qty) || 0; if (!s.last || m.ts > s.last) s.last = m.ts; }
    if (m.type === "return") s.returned += Number(m.qty) || 0;
    if (m.productId === REMOVE_ID) removeMovements.push({ id, type: m.type, size: m.size, qty: m.qty, from: m.from || null, to: m.to || null, ts: m.ts, reason: m.reason || null });
  }

  // References to the duplicate.
  const barcodeCodes = Object.values(remove?.barcodes || {}).filter(Boolean);
  const barcodeRows = {};
  for (const code of barcodeCodes) barcodeRows[code] = await val(`barcodes/${code}`);
  const openRequests = Object.entries((await db.ref("refill_requests").orderByChild("productId").equalTo(REMOVE_ID).once("value")).val() || {})
    .filter(([, r]) => r && r.status === "open")
    .map(([id, r]) => ({ id, requestingLocation: r.requestingLocation, size: r.size, qty: r.qty, sentQty: r.sentQty || 0, createdAt: r.createdAt, via: r.createdFrom?.via || null, by: Object.values(r.stamps || {})[0]?.personName || null }));
  const keepOpenRequests = Object.entries((await db.ref("refill_requests").orderByChild("productId").equalTo(KEEP_ID).once("value")).val() || {})
    .filter(([, r]) => r && r.status === "open")
    .map(([id, r]) => ({ id, requestingLocation: r.requestingLocation, size: r.size, qty: r.qty, createdAt: r.createdAt, engine: !!r.createdFrom?.engine }));
  const displayRegister = [];
  for (const loc of locs) {
    const hits = (await db.ref(`settings/hubSneakerCount/register/${loc}`).orderByKey().startAt(`${REMOVE_ID}__`).endAt(`${REMOVE_ID}__`).once("value")).val();
    for (const k of Object.keys(hits || {})) if (k.startsWith(`${REMOVE_ID}__`)) displayRegister.push(`${loc}/${k}`);
  }
  const sessions = (await val(COUNT_SESSIONS_PATH)) || {};
  const countedRecords = [];
  const countedByLoc = {};
  for (const loc of Object.keys(removeStock)) {
    const sid = sessions[loc]?.sessionId;
    countedByLoc[loc] = [];
    if (!sid) continue;
    for (const pid of [REMOVE_ID, KEEP_ID]) {
      const hits = (await db.ref(`${COUNTED_PATH}/${loc}/${sid}`).orderByKey().startAt(`${pid}::`).endAt(`${pid}::`).once("value")).val();
      for (const [k, rec] of Object.entries(hits || {})) {
        if (!k.startsWith(`${pid}::`)) continue;
        if (pid === REMOVE_ID) countedRecords.push(`${loc}/${sid}/${k}`);
        countedByLoc[loc].push({ key: k, rec });
      }
    }
  }
  const targets = [];
  for (const loc of locs) if (await val(`stock_targets/${loc}/${REMOVE_ID}`)) targets.push(loc);
  const attention = [];
  for (const list of ["marketing", "display"]) if (await val(`attention_lists/${list}/items/${REMOVE_ID}`)) attention.push(list);
  const pairId = [REMOVE_ID, KEEP_ID].sort().join("__");
  const pairRow = await val(`duplicate_candidates/${pairId}`);
  const openPairs = (await db.ref("duplicate_candidates").orderByChild("status").equalTo("open").once("value")).val() || {};
  const openDuplicatePairsOther = Object.keys(openPairs).filter((k) => k.includes(REMOVE_ID) && k !== pairId);

  const refs = {
    openRequests, displayRegister, countedRecords, targets, attention, openDuplicatePairsOther,
    barcodeRows,
    styleCodeClaims: removeClaims ? Object.keys(removeClaims) : [],
    duplicatePairRow: pairRow || null,
    shopifyPublish: await val(`shopify_publish/${REMOVE_ID}`),
    cellHolds: await val(`online_cell_holds/${REMOVE_ID}`),
    productAttributes: !!(await val(`product_attributes/${REMOVE_ID}`)),
  };

  const brief = (p) => p && ({
    name: p.name, styleCode: p.styleCode || null, styleCodeNormalised: p.styleCodeNormalised || null,
    brand: p.brand, categoryKey: p.categoryKey, sizes: p.sizes || [], sku: p.sku, barcodes: p.barcodes || {},
    hasPhoto: !!(p.photoUrl || p.photoCutoutUrl || p.photoMeta?.url), retailPrice: p.retailPrice, stockPrice: p.stockPrice,
    hubs: p.hubs || [], mergedInto: p.mergedInto || null,
  });
  const cells = (stock) => Object.fromEntries(Object.entries(stock).map(([loc, n]) => [loc, Object.fromEntries(Object.entries(sizeCells(n)).map(([k, c]) => [k, c.qty]))]));
  return {
    at: new Date().toISOString(),
    keep: { id: KEEP_ID, ...brief(keep), claim, sales: sales[KEEP_ID], openRequests: keepOpenRequests },
    remove: { id: REMOVE_ID, ...brief(remove), sales: sales[REMOVE_ID], movements: removeMovements },
    sameProductProblems: sameProductProblems(keep, remove),
    sizeMap: mapSizes(remove?.sizes, keep?.sizes),
    stock: { keep: cells(keepStock), remove: cells(removeStock) },
    raw: { keepStock, removeStock },
    countedByLoc,
    refs,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const admin = adminRequire(import.meta.url)("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const out = await investigate(admin.database());
  const i = process.argv.indexOf("--out");
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 2));
  const { raw, ...shown } = out;
  console.log(JSON.stringify(shown, null, 2));
  process.exit(0);
}
