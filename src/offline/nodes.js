// ─── OFFLINE MIRROR — THE NODE REGISTRY ──────────────────────────────────────
//
// ONE declaration per mirrored RTDB node, and everything else is derived from
// it: the sync legs, the change-feed router, the Cloud Function triggers that
// feed /mirror_changes, the local readers, and the setup screen's progress.
//
// WHY A REGISTRY AND NOT A LIST PER FILE. The POS mirror's worst live failure
// was a path that existed in one file and not in another (`/stock/pe`), and it
// was silent in both directions: the leg read nothing, stamped itself healthy,
// and every till in the shop served an empty catalogue. A second copy of "which
// nodes do we mirror, and how deep is a row" is exactly that failure waiting to
// happen again, so there is one copy, here, and the trigger generator in
// functions/mirrorChanges reads THIS SHAPE rather than restating it.
//
// ── THE THREE THINGS A NODE DECLARES ────────────────────────────────────────
//
//   node    the RTDB path, no leading slash.
//
//   depth   how many path segments BELOW `node` identify one mirrored row.
//             0  the node is one document (small, read and replaced whole)
//             1  /products/{pid}                        row = pid
//             2  /stock/{loc}/{pid}                     row = loc|pid
//             3  /settings/displayRows/{store}/{pid}/{rowId}
//           Depth is what makes a change record cheap: a trigger fires at
//           exactly this depth, and the client re-reads exactly this child.
//           Too shallow and one edit re-downloads a megabyte; too deep and the
//           row count explodes for nothing.
//
//   feed    how the node stays current after setup:
//             "changes"    mutable — via /mirror_changes (functions trigger)
//             "keyRange"   append-only with push keys — orderByKey().startAfter
//             "tsRange"    append-only with an indexed ISO `ts` — orderByChild
//
// ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
//
// /barcodes (2.0 MB) — the store app never reads it whole; every call site is
// one code at a time. /laybys, /card_batches, /aiAssistant/*, /social_* — read
// on owner-or-admin-only screens, per record, rarely. /broadcasts (4 B) and
// /broadcastHistory (1.8 KB) — smaller than the change record that would track
// them. Mirroring a node costs every device its bytes at setup FOREVER; a live
// per-record read costs a few hundred bytes when someone presses something.
// See docs/store-offline-mirror.md §3.2.

// The object store each leg's rows live in. One store per leg rather than one
// shared store with a node index: count() is then O(1), a per-leg purge is a
// clear(), and a leg can carry its own index (movements does, on `ts`).
export const MIRROR_STORES = Object.freeze([
  "products",
  "stock",
  "customers",
  "orders",
  "refills",
  "movements",
  "insights",
  "restockLog",
  "restockRequests",
  "returnsLog",
  "displaySlots",
  "displayRows",
  "displayRegister",
  // Small whole-node documents, one record each, keyed by the node path.
  "docs",
]);

// Stores carrying an IndexedDB index, created with the store at version 1.
// `movements` is ranged locally by `ts` (App.jsx useClothingSoldMovements reads
// a 90-day window), so the index has to exist or that read walks 90,922 rows.
export const STORE_INDEXES = Object.freeze({
  movements: Object.freeze([{ name: "ts", keyPath: "ts" }]),
});

// ── PAGE SIZE ───────────────────────────────────────────────────────────────
//
// How many TOP-LEVEL children the setup download asks for at a time. This is
// not a tuning knob, it is a memory bound: a key page carries each child's
// WHOLE subtree, so for a depth-1 leg it is that many records and for a
// depth-2 leg it is that many entire /stock locations. One location is 1.6 MB;
// twenty dates of /restock_log are a few hundred kilobytes. Hence the spread.
const DEFAULT_PAGE_SIZE = 500;

// ── CENSUS TOLERANCE ────────────────────────────────────────────────────────
//
// The daily census counts each node server-side and publishes the number; a
// device compares its own count against it and re-downloads a leg that
// disagrees (sync.js). The census is a DAY old by the time most devices read
// it, so an exact match would mean re-downloading every leg every day.
//
// The default 2% matches health.js's shrink tolerance, which is the same
// question asked about a different pair of numbers. /orders is the one leg
// that needs more: its ids are recycled daily and a trading day turns over far
// more than 2% of ~3,000 rows.
const DEFAULT_CENSUS_TOLERANCE = 0.02;

const leg = (name, node, depth, feed, store, extra = {}) =>
  Object.freeze({
    name, node, depth, feed, store,
    pageSize: DEFAULT_PAGE_SIZE,
    censusTolerance: DEFAULT_CENSUS_TOLERANCE,
    ...extra,
  });

// ─── THE LEGS ───────────────────────────────────────────────────────────────
//
// Order matters: this is the order the setup download runs in, and it is
// smallest-useful-first on purpose. A device that has finished `products`,
// `stock` and `orders` can already show a shelf; the two history nodes are the
// biggest and the least urgent, so they finish last and the progress bar spends
// its time where the bytes actually are.
export const MIRROR_LEGS = Object.freeze([
  leg("locations", "locations", 0, "changes", "docs"),
  leg("taxonomy", "settings/productTaxonomy", 0, "changes", "docs"),
  leg("stockHold", "settings/stockHold", 0, "changes", "docs"),
  leg("hiddenProducts", "settings/missingProductsHidden", 0, "changes", "docs"),
  leg("transitConfig", "config/transit", 0, "changes", "docs"),
  leg("clothingOos", "clothing_sold_refills", 0, "changes", "docs"),
  leg("users", "users", 1, "changes", "docs"),

  leg("products", "products", 1, "changes", "products", { pageSize: 400 }),
  // One /stock location per page: marathon-pe alone is 1.6 MB.
  leg("stock", "stock", 2, "changes", "stock", { pageSize: 1 }),
  // /orders ids are recycled daily, so a trading day turns over far more of
  // this node than any other. See DEFAULT_CENSUS_TOLERANCE.
  leg("orders", "orders", 1, "changes", "orders", { censusTolerance: 0.25 }),
  leg("customers", "customers", 1, "changes", "customers"),

  leg("displaySlots", "settings/displaySlots", 2, "changes", "displaySlots", { pageSize: 2 }),
  leg("displayRows", "settings/displayRows", 3, "changes", "displayRows", { pageSize: 2 }),
  leg("displayRegister", "settings/hubSneakerCount", 3, "changes", "displayRegister", { pageSize: 1 }),

  leg("refills", "refill_requests", 1, "changes", "refills", { pageSize: 1000 }),
  // /restock_requests is {date}/{key}, like /restock_log — depth 2, not 1.
  leg("restockRequests", "restock_requests", 2, "changes", "restockRequests", { pageSize: 20 }),
  leg("returnsLog", "returns_log", 1, "changes", "returnsLog"),
  leg("restockLog", "restock_log", 2, "changes", "restockLog", { pageSize: 20 }),

  // The two big append-only histories. Neither needs the change log: their own
  // key or field IS a forward cursor, which is cheaper and cannot fall behind a
  // retention window.
  leg("movements", "stock_movements", 1, "tsRange", "movements",
    { tsField: "ts", pageSize: 2000, censusTolerance: 0.05 }),
  leg("insights", "insights_log", 1, "keyRange", "insights",
    { pageSize: 2000, censusTolerance: 0.05 }),
]);

export const LEG_BY_NAME = Object.freeze(
  Object.fromEntries(MIRROR_LEGS.map((l) => [l.name, l])),
);

// The legs the /mirror_changes log is responsible for — the exact set the
// Cloud Function must install a trigger for. functions/mirrorChanges/legs.js
// asserts its own list against this one so a leg added here and forgotten
// there fails a test rather than a trading day.
export const CHANGE_FED_LEGS = Object.freeze(
  MIRROR_LEGS.filter((l) => l.feed === "changes"),
);

// ─── APPEND-ONLY vs SNAPSHOT ────────────────────────────────────────────────
//
// The two append-only legs are downloaded and maintained by the SAME code
// path: a forward walk from a cursor. Their setup download is just that walk
// starting from nothing, so they need no staging and no atomic swap — a
// part-finished download of an append-only node is a correct PREFIX of it, and
// the next pass continues from where it stopped.
//
// Every other leg is a SNAPSHOT: it is read whole at setup, staged page by
// page, validated (non-empty, not shrunk) and swapped in one transaction, and
// thereafter never read whole again. The distinction decides which guards
// apply, so it is asked of the registry rather than restated at each leg.
export const isAppendOnly = (l) => l.feed === "keyRange" || l.feed === "tsRange";

// node path -> leg. The change record carries the node, never the leg name, so
// a rename on this side cannot orphan records already in the log.
export const LEG_BY_NODE = Object.freeze(
  Object.fromEntries(MIRROR_LEGS.map((l) => [l.node, l])),
);

// ─── ROW KEYS ───────────────────────────────────────────────────────────────
//
// A row key joins the path segments below the node with "|". "|" cannot occur
// in an RTDB key (the illegal set is . $ # [ ] / and control characters — "|"
// is legal), so this is NOT a safe separator by construction and the join is
// therefore checked rather than assumed: a segment containing "|" would make
// two different rows collide into one, silently, which is the whole class of
// failure this mirror exists to end.
export const ROW_KEY_SEP = "|";

export class MirrorRowKeyError extends Error {
  constructor(segments, detail) {
    super(`offline mirror: cannot build a row key from ${JSON.stringify(segments)} — ${detail}`);
    this.name = "MirrorRowKeyError";
    this.segments = segments;
  }
}

export function rowKey(segments) {
  const parts = Array.isArray(segments) ? segments : [segments];
  for (const s of parts) {
    if (typeof s !== "string" || s.length === 0) {
      throw new MirrorRowKeyError(parts, "every segment must be a non-empty string");
    }
    if (s.includes(ROW_KEY_SEP)) {
      throw new MirrorRowKeyError(parts, `a segment contains ${ROW_KEY_SEP}, which would collide with another row`);
    }
  }
  return parts.join(ROW_KEY_SEP);
}

export function rowKeySegments(key) {
  return String(key).split(ROW_KEY_SEP);
}

// The full RTDB path of one row.
export function rowPath(legDef, key) {
  if (legDef.depth === 0) return legDef.node;
  return `${legDef.node}/${rowKeySegments(key).join("/")}`;
}

// The IndexedDB key a row is stored under.
//
// Every leg with its OWN object store keys by the row key, because within one
// store the row key is already unique. The shared `docs` store holds several
// legs at once (a 19 KB taxonomy, a 927 B location registry, one record per
// user), so a bare row key there would let two legs collide — `locations` is
// depth 0 and keys at "", and so is `config/transit`. Keying `docs` by the full
// RTDB path makes the leg part of the key, which is the only thing that can be
// collision-free across legs.
export function storeKey(legDef, key) {
  if (legDef.store === "docs") return rowPath(legDef, key);
  return key;
}

// A depth-0 leg has exactly one row and it has no segments of its own. "" is
// its row key everywhere: in the store (via storeKey, which turns it into the
// node path), in the change log, and in the health record.
export const DOC_ROW_KEY = "";
