// ─── STOCK AUDIT — the pure brain behind the two daily shelf checks ───────────
//
// WHAT THIS IS. Two lists, per store, that tell staff which shelf to walk to:
//
//   TAB A — OUT OF STOCK CHECKS. Every clothing line that came back
//   unavailable, NAMED WITH THE PLACE THE STOCK WAS SUPPOSED TO BE (the shop's
//   own cell, Hub 2, or Central). The point is to separate an OVERSTATED cell
//   (system says stock, shelf is empty — a phantom) from an UNDERSTATED one
//   (shelf has stock, system says zero — lost sales). Both are invisible until
//   somebody physically looks, and the list is what tells them where.
//
//   TAB B — NOT SELLING (ROTATION). A self-rotating sweep of every clothing
//   product HELD at that store, oldest-checked first, 30 at a time, three
//   mornings a week. It is deliberately NOT ranked by severity: severity
//   rankings check the same worst offenders forever and never discover the
//   quiet phantom sitting in the middle of the catalogue. Coverage is the
//   product. Two server-computed signals sit beside each row — has it sold in
//   the last 21 days, and is a display check registered for it at that store —
//   because the pair is the check itself: no sale AND no display means the
//   product is not on the floor; no sale WITH a display means the stock or the
//   size is wrong.
//
// SCOPE, FIXED. Clothing only (engine isClothing — accessories carry
// productType "clothing" deliberately and ARE in scope), and only the two
// stores that have staff to walk a shelf: Marathon PE and Trophy. No sneakers,
// no Hub 1, no Pine.
//
// WHY IT IS PURE. Everything here is a function of data the refill scan
// ALREADY holds in memory after its once-per-run snapshot (stock, products,
// refill_requests, movements, config.routes) plus three small pieces of the
// feature's own state. No Firebase, no clock, no I/O — nowMs is injected. That
// is what makes the daily pass free: the expensive reads were already paid for
// by the run that calls this.
//
// NOTHING HERE ROTATES BY ITSELF ON A HUMAN'S SAY-SO. The batch is a pure
// function of (universe, rotation stamps, SA date). There is no "generate"
// button anywhere in the feature, because a list that only appears when
// somebody remembers to press something is a list nobody reads.

"use strict";

const { isClothing } = require("./refill-engine.cjs");
const { saDateStringFromMs, SAST_OFFSET_MS } = require("./sa-time.cjs");

// The two shops this feature covers. Hard-coded, not config-driven: the scope
// is an owner decision about which floors have someone to walk them, and a
// config key would invite a third store to appear without anyone deciding it.
const AUDIT_STORES = ["marathon-pe", "trophy"];

// Weekday tokens as the config names them. Index matches Date#getUTCDay().
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULTS = Object.freeze({
  // 30 products a batch, three mornings a week — the owner's number. At the
  // live universe (PE 1,300 held clothing products, Trophy 721) that is a
  // ~14-week cycle at PE and ~8 at Trophy. See the PR body.
  batchSize: 30,
  rotationDays: ["Mon", "Wed", "Fri"],
  // "Has it sold at all recently" — 21 days, comfortably inside the scan's
  // 45-day movement slice, so this signal never needs a read of its own.
  soldWindowDays: 21,
  // How far back Tab A looks for a resolved-unavailable request. 24h means the
  // morning list is exactly what happened during yesterday's trading.
  lookbackHours: 24,
  // Hard ceiling on Tab A so one bad night cannot push the snapshot past the
  // size budget. Rows are ordered worst-first before the cut (see below).
  maxOutOfStockRows: 120,
  // The daily pass runs on the first scan at or after this SA hour.
  passHour: 7,
});

// ── config ───────────────────────────────────────────────────────────────────
// Every field defaults, and every field is validated to the shape the rest of
// this module assumes. A hand-typed console value ("30" as a string, a
// rotationDays of ["Monday"], a batchSize of 0) must degrade to the default
// rather than silently produce an empty batch forever — an audit that quietly
// stops auditing is the one failure mode nobody notices.
function auditConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const posInt = (v, d, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= max ? Math.floor(n) : d;
  };
  const days = Array.isArray(c.rotationDays)
    ? c.rotationDays.map((d) => String(d).slice(0, 3)).filter((d) => WEEKDAYS.includes(d))
    : [];
  return {
    enabled: c.enabled === true,
    batchSize: posInt(c.batchSize, DEFAULTS.batchSize, 200),
    rotationDays: days.length ? [...new Set(days)] : [...DEFAULTS.rotationDays],
    soldWindowDays: posInt(c.soldWindowDays, DEFAULTS.soldWindowDays, 45),
    lookbackHours: posInt(c.lookbackHours, DEFAULTS.lookbackHours, 168),
    maxOutOfStockRows: posInt(c.maxOutOfStockRows, DEFAULTS.maxOutOfStockRows, 400),
    passHour: Number.isFinite(Number(c.passHour)) && Number(c.passHour) >= 0 && Number(c.passHour) <= 23
      ? Math.floor(Number(c.passHour)) : DEFAULTS.passHour,
  };
}

// SA wall-clock hour of an instant. SAST is UTC+2 with no DST, so a shift and a
// UTC read is exact — no Intl, no timezone database, testable from a number.
function saHour(nowMs) {
  return new Date(nowMs + SAST_OFFSET_MS).getUTCHours();
}

function saWeekday(saDate) {
  // saDate is already the SA calendar day; UTC noon avoids any boundary wobble.
  return WEEKDAYS[new Date(`${saDate}T12:00:00.000Z`).getUTCDay()];
}

// ── the once-a-day gate ──────────────────────────────────────────────────────
// The scan fires every 15 minutes; this pass must run ONCE. The guard is a
// stored SA date string, not a timestamp and not a counter: re-running the same
// scan, a retry, an overlapping run and a redeploy all compare equal and do
// nothing. `lastPassDate` in the FUTURE (a clock skew, a hand-edited node) must
// not wedge the pass forever — a strict inequality would. It compares !== so a
// wrong-direction stamp self-corrects on the next SA day.
function shouldRunDailyPass({ nowMs, lastPassDate, passHour = DEFAULTS.passHour }) {
  const saDate = saDateStringFromMs(nowMs);
  if (saHour(nowMs) < passHour) return { run: false, saDate, why: "before_pass_hour" };
  if (lastPassDate === saDate) return { run: false, saDate, why: "already_ran_today" };
  return { run: true, saDate, why: "due" };
}

function isRotationDay(saDate, rotationDays) {
  return rotationDays.includes(saWeekday(saDate));
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ── THE /stock CELL KEY — the client's fold, not the engine's ────────────────
// Byte-identical mirror of src/utils/sizeKey.js `stockSizeKey`, which is what
// actually WROTE every cell in /stock (through applyMovement, the single
// writer). The engine's encodeSizeKey is NOT the same function: it trims first,
// so " M" becomes "M" there and "_M" here, and it does not fold the synthetic
// "Free Size" label that the assistant order screen shows for a one-size line.
//
// Using the engine's encoder here produced a row that named a cell which does
// not exist: it reported "system 0" for a size actually holding 6 in "_M",
// staff read it as understated, tapped Adjust, and applyMovement — using the
// CLIENT fold — created a second cell "M" beside the real one. One size, two
// cells: the exact split #279 folded "Free Size" to close.
//
// A row's `sk` is therefore always a literal /stock key, from either side, and
// decodeSizeKey(sk) round-trips back through this fold unchanged.
function stockSizeKey(size) {
  if (size == null || size === "" || size === "Free Size") return "_";
  const s = typeof size === "number" ? String(size) : size;
  if (typeof s !== "string") return s;
  return s.replace(/[.#$[\]/\s]/g, "_");
}
const qtyAt = (stock, loc, pid, sizeKey) => num(stock?.[loc]?.[pid]?.[sizeKey]?.qty);

// The identity of one checkable line: a product, a size, and the PLACE the
// stock was supposed to be. The place is part of the key on purpose — the same
// shirt missing from the shop floor and missing from Hub 2 are two different
// walks to two different shelves, and collapsing them would send staff to one.
function cellKey(pid, sizeKey, where) {
  return `${pid}__${sizeKey}__${where}`;
}

// A product's display name, never undefined (RTDB rejects undefined, and a row
// with no name is a row staff cannot act on).
function nameOf(products, pid) {
  return String(products?.[pid]?.name || pid);
}

// Decode "_" back to the empty/one-size label the shop screens use. Every other
// key round-trips through the engine encoder unchanged for clothing sizes
// (S–XXXL contain no illegal character), so this is the only case to handle.
function sizeLabel(sizeKey) {
  return sizeKey === "_" ? "One size" : sizeKey;
}

// ─── TAB A — OUT OF STOCK CHECKS ─────────────────────────────────────────────
//
// Three sources, all already in the scan's memory. Each produces rows carrying
// WHERE the stock was believed to be and WHAT quantity the system believed:
//
//   1. Requests from this store that came back unavailable in the lookback
//      window. Four flavours, and the distinction matters to the person
//      walking the shelf:
//        rejected          — a human at the source said "not here" (an rr
//                            cancelled with NO cancelReason: engine
//                            self-withdrawals always stamp one, so an unstamped
//                            cancel is a person's answer — the same load-bearing
//                            reading the reject-streak guard uses)
//        unfillable        — the engine found zero anywhere upstream
//        awaiting_upstream — the engine found the source cell empty
//      A rejected line whose source cell still reads a positive quantity is the
//      loudest phantom the system can produce, and `q` is what makes that
//      visible on the row.
//
//   2. STILL-OPEN requests whose source cell reads zero or negative. Nobody has
//      answered these yet; the source says it cannot answer.
//
//   3. Clothing cells that have gone NEGATIVE at the store or at its source. A
//      negative cell is arithmetic that already happened — it is not a
//      prediction, it is proof the count is wrong.
//
// ORDERING BEFORE THE CAP. Rows are sorted by how load-bearing they are, so a
// cap can only ever drop the least informative tail: negatives first (proof),
// then rejections against a positive cell (phantoms), then everything else.
function buildOutOfStock({ store, nowMs, cfg, stock, products, refillRequests, routes }) {
  const rows = new Map();   // cellKey → row (first writer wins, see add())
  const source = routes?.[store] || null;              // the store's supplier (hub2)
  const upstream = source ? (routes?.[source] || null) : null;  // and its supplier (central)
  const since = nowMs - cfg.lookbackHours * 3600e3;

  // THE STRONGER READING WINS, not the first one to arrive.
  //
  // This was first-writer-wins, on the assumption that pushing the sources in
  // descending evidential strength was enough. It is not, and the hole is
  // inside a single source: /refill_requests is iterated in RTDB child order,
  // which for push-id keys is chronological, so two records for the SAME
  // product+size+place are seen oldest first. An old still-open request
  // (rank 2) would then claim the cell and silently drop a NEWER human
  // rejection against a cell that still reads positive (rank 1) — which is the
  // single loudest phantom this tab exists to surface, and the first row a cap
  // would truncate away. Duplicate records for one cell are not hypothetical
  // here; requests that outlive their engine lock have happened before.
  //
  // Comparing rank makes the outcome independent of iteration order.
  // (Adversarial architecture review, PR #580.)
  // Ties inside a rank are broken by the FRESHER evidence, so the surviving row
  // never depends on iteration order either. Comparing rank alone left that
  // half unfixed: `unfillable`, `awaiting_upstream` and a rejection against a
  // non-positive cell are all rank 2, so for a cell carrying two of them the
  // reason pill flipped with push-id order — a narrower guarantee than the
  // sentence above claimed.
  const add = (row) => {
    const cur = rows.get(row.k);
    if (!cur || row.rank < cur.rank || (row.rank === cur.rank && row.at > cur.at)) rows.set(row.k, row);
  };

  // ── 3. negative cells (strongest evidence: it already happened) ────────────
  for (const loc of [store, source, upstream].filter(Boolean)) {
    const byPid = stock?.[loc] || {};
    for (const pid of Object.keys(byPid)) {
      if (!isClothing(products?.[pid])) continue;
      for (const sizeKey of Object.keys(byPid[pid] || {})) {
        const q = num(byPid[pid][sizeKey]?.qty);
        if (q >= 0) continue;
        // A cell carries no timestamp of its own; it is standing evidence, and
        // rank 0 is never contested by anything else, so 0 is honest here.
        add({ k: cellKey(pid, sizeKey, loc), p: pid, n: nameOf(products, pid),
              s: sizeLabel(sizeKey), sk: sizeKey, w: loc, q, r: "negative_cell", rank: 0, at: 0 });
      }
    }
  }

  // ── 1 + 2. refill requests from this store ────────────────────────────────
  for (const rr of Object.values(refillRequests || {})) {
    if (!rr || rr.requestingLocation !== store) continue;
    const pid = rr.productId;
    if (!pid || !isClothing(products?.[pid])) continue;
    // Where the stock was supposed to be: the request records its own source,
    // and the route table is the fallback for older records that predate it.
    const where = rr.createdFrom?.source || source;
    if (!where) continue;
    const sizeKey = stockSizeKey(rr.size);
    const believed = qtyAt(stock, where, pid, sizeKey);

    if (rr.status === "open") {
      if (believed > 0) continue;                       // the source can still answer
      add({ k: cellKey(pid, sizeKey, where), p: pid, n: nameOf(products, pid),
            s: sizeLabel(sizeKey), sk: sizeKey, w: where, q: believed,
            r: "open_source_empty", rank: 2, at: Date.parse(rr.createdAt || 0) || 0 });
      continue;
    }
    if (rr.status !== "cancelled") continue;            // fulfilled — nothing to check
    const resolvedAt = Date.parse(rr.resolvedAt || rr.createdAt || 0);
    if (!Number.isFinite(resolvedAt) || resolvedAt < since) continue;
    const why = rr.cancelReason || "rejected";
    // no_longer_needed / already_in_stock / order_lost / hold_released are the
    // engine tidying its own bookkeeping — the line never came back unavailable
    // and putting it on a shelf-walk list would be a wild goose chase.
    if (why !== "rejected" && why !== "unfillable" && why !== "awaiting_upstream") continue;
    // A human "not here" against a cell that still reads stock is the phantom
    // this whole tab exists to surface — rank it above the ordinary cases.
    const rank = why === "rejected" && believed > 0 ? 1 : 2;
    add({ k: cellKey(pid, sizeKey, where), p: pid, n: nameOf(products, pid),
          s: sizeLabel(sizeKey), sk: sizeKey, w: where, q: believed, r: why, rank, at: resolvedAt });
  }

  const byWeight = (a, b) =>
    a.rank - b.rank || b.at - a.at || a.n.localeCompare(b.n) || a.s.localeCompare(b.s) || a.w.localeCompare(b.w);
  const all = [...rows.values()].sort(byWeight);
  const total = all.length;

  // THE CAP IS SPLIT, because the upstream half is SHARED. Both audit stores
  // route to the same Hub 2 and the same Central, so every negative cell there
  // is emitted into BOTH lists — at rank 0, ahead of every rejection and every
  // open-request row either shop owns. One bad dispatch run producing 120
  // negative clothing cells upstream would fill Marathon PE's whole list with
  // Central rows and cut every one of PE's own phantoms.
  //
  // Measured 2026-09-08: 0 negative clothing cells at hub2 and central, 57 at
  // Marathon PE and 43 at Trophy — so the starvation is not live today. It is
  // one dispatch away, and the fix is a fair split rather than a hope.
  //
  // Each side gets half the budget guaranteed and may take the other's unused
  // half, so neither starves and a quiet upstream costs the store nothing.
  const ownRows = all.filter((r) => r.w === store);
  const upstreamRows = all.filter((r) => r.w !== store);
  const cap = cfg.maxOutOfStockRows;
  const half = Math.ceil(cap / 2);
  const ownTake = Math.min(ownRows.length, Math.max(half, cap - upstreamRows.length));
  const kept = [...ownRows.slice(0, ownTake), ...upstreamRows.slice(0, cap - ownTake)].sort(byWeight);

  // `rank` and `at` are sort keys, not something the card renders — drop them
  // rather than pay for them in every row's bytes.
  return {
    rows: kept.map(({ rank, at, ...r }) => r),
    total,
    truncated: total > kept.length,
  };
}

// ─── TAB B — THE ROTATION ────────────────────────────────────────────────────
//
// UNIVERSE: every clothing product this store HOLDS — at least one cell with a
// positive quantity. A zero-everywhere product has no shelf to walk to; a
// negative one is Tab A's business.
//
// ORDER: longest since last checked first, NEVER CHECKED COUNTING AS LONGEST.
// That single rule is what makes the sweep cover the whole set: a new product
// enters at the front, every checked product goes to the back, and no product
// can be starved because its stamp only ever moves in one direction. There is
// deliberately no severity ranking — see the file header.
//
// TIE-BREAK BY PRODUCT ID. Every never-checked product shares one sort value,
// so without a deterministic second key the batch would depend on object key
// order and two runs of the same day could disagree about what to check.
function rotationUniverse({ store, stock, products }) {
  const out = [];
  const byPid = stock?.[store] || {};
  for (const pid of Object.keys(byPid)) {
    if (!isClothing(products?.[pid])) continue;
    const sizes = [];
    for (const sizeKey of Object.keys(byPid[pid] || {})) {
      const q = num(byPid[pid][sizeKey]?.qty);
      if (q > 0) sizes.push({ sk: sizeKey, q });
    }
    if (sizes.length) {
      sizes.sort((a, b) => a.sk.localeCompare(b.sk));
      out.push({ pid, sizes });
    }
  }
  return out;
}

function selectRotationBatch({ universe, rotationState, batchSize }) {
  const stampOf = (pid) => {
    const at = Number(rotationState?.[pid]?.at);
    // Never checked → -1, which sorts ahead of every real stamp. A stamp that
    // is missing, zero, negative or unparseable lands here too, deliberately:
    // an unreadable stamp is not evidence the shelf was walked, and the safe
    // direction for an audit is to check it again rather than to trust it.
    return Number.isFinite(at) && at > 0 ? at : -1;
  };
  return [...universe]
    .sort((a, b) => stampOf(a.pid) - stampOf(b.pid) || a.pid.localeCompare(b.pid))
    .slice(0, batchSize);
}

// ── the two signals, both from data the scan already holds ───────────────────
// soldPids: every clothing product SOLD FROM this store inside the window. From
// the movement slice the scan already reads; `from` is the selling location and
// `size` on a movement is the RAW catalogue size, so it goes through the engine
// encoder before it can be compared to a /stock key.
function soldIndex({ store, nowMs, movements, soldWindowDays }) {
  const since = nowMs - soldWindowDays * 864e5;
  const byPid = new Set();
  const bySize = new Set();
  for (const m of movements || []) {
    if (!m || m.type !== "sold" || m.from !== store || !m.productId) continue;
    const ts = Date.parse(m.ts || m.appliedAt || 0);
    if (!Number.isFinite(ts) || ts < since) continue;
    byPid.add(m.productId);
    bySize.add(`${m.productId}__${stockSizeKey(m.size)}`);
  }
  return { byPid, bySize };
}

// displayKeys: the KEYS of /displayChecks_active/{store}, which are
// "{productId}__{sizeKey}". Keys only — the bodies carry photo URLs and applied-
// movement maps and are ~1 MB a store; the question here is only "is one
// registered", which a key answers. The caller supplies them (a shallow read);
// this function does not care where they came from.
function displayIndex(displayKeys) {
  const byPid = new Set();
  const bySize = new Set();
  for (const k of displayKeys || []) {
    const i = String(k).indexOf("__");
    if (i <= 0) continue;
    byPid.add(String(k).slice(0, i));
    bySize.add(String(k));
  }
  return { byPid, bySize };
}

function buildRotation({ store, nowMs, cfg, saDate, stock, products, movements, rotationState, displayKeys, prevBatchPids, prevBatchAt }) {
  const universe = rotationUniverse({ store, stock, products });
  const fresh = isRotationDay(saDate, cfg.rotationDays);
  // On a rotation day a new batch is minted. On every other day the batch that
  // is already up stays up — staff finish the one they were given rather than
  // watching it change under them, and nobody has to press anything either way.
  let picked;
  let batchAt = nowMs;
  if (fresh || !prevBatchPids || !prevBatchPids.length) {
    picked = selectRotationBatch({ universe, rotationState, batchSize: cfg.batchSize });
  } else {
    const inUniverse = new Map(universe.map((u) => [u.pid, u]));
    picked = prevBatchPids.map((pid) => inUniverse.get(pid)).filter(Boolean);
    // A carried batch that has emptied out (every product sold to zero) would
    // leave the card blank until the next rotation day. Refill it rather than
    // show nothing. A batch emptied by being CHECKED is a different thing and
    // is handled below — that one should show as finished, not restart.
    if (!picked.length) picked = selectRotationBatch({ universe, rotationState, batchSize: cfg.batchSize });
    else batchAt = Number(prevBatchAt) || 0;
  }

  // ── A BATCH ALREADY WALKED MUST NOT COME BACK AS A QUESTION ────────────────
  // The "already actioned" memory (/settings/stockAudit/{store}/results/{day})
  // is per SA DAY, but a carried batch outlives the day it was checked on. So a
  // batch cleared on Monday came back in full on Tuesday, Thursday, Saturday
  // and Sunday — four days out of seven — with every button live and nothing on
  // screen saying it had been done. Staff redid finished work, the real sweep
  // ran far slower than the cycle length claims, and a line stamped "present
  // but slow" was re-asked the very next morning, which is exactly the owner
  // rule that a confirmed slow mover must not come back as a question.
  //
  // The rotation stamp is the durable record and it was already being read.
  // A product stamped at or after this batch was minted has been walked FOR
  // THIS BATCH and drops out of the rows — while staying in the batch list, so
  // tomorrow still knows which thirty products the batch was.
  const walked = new Set(
    picked.filter(({ pid }) => {
      const at = Number(rotationState?.[pid]?.at);
      return Number.isFinite(at) && at > 0 && at >= batchAt;
    }).map((x) => x.pid)
  );
  const batchPids = picked.map((x) => x.pid);
  picked = picked.filter(({ pid }) => !walked.has(pid));

  const sold = soldIndex({ store, nowMs, movements, soldWindowDays: cfg.soldWindowDays });
  const disp = displayIndex(displayKeys);

  const rows = picked.map(({ pid, sizes }) => {
    const st = rotationState?.[pid] || null;
    return {
      p: pid,
      n: nameOf(products, pid),
      // Product-level signals — what the PRODUCT view shows.
      sold: sold.byPid.has(pid),
      disp: disp.byPid.has(pid),
      // "Present but slow" from a previous cycle. Carried so the card can show
      // the line as settled rather than re-raising it as a problem — the owner
      // rule that a confirmed slow mover must not come back as a question.
      slow: st?.o === "slow",
      last: Number.isFinite(Number(st?.at)) ? Number(st.at) : null,
      // Per-size rows — what the SIZE view shows. Same batch, same signals,
      // resolved to the cell.
      z: sizes.map(({ sk, q }) => ({
        s: sizeLabel(sk), sk, q,
        sold: sold.bySize.has(`${pid}__${sk}`),
        disp: disp.bySize.has(`${pid}__${sk}`),
      })),
    };
  });

  return {
    rows, universeSize: universe.length, refreshed: fresh, batchDate: saDate,
    batchAt, batchPids, walked: walked.size,
  };
}

// ─── THE SNAPSHOT ────────────────────────────────────────────────────────────
// Exactly what the card renders and nothing else. The audit trail is
// /stock_movements (for adjustments) and /settings/stockAudit/{store}/results
// (for outcomes) — this node is a render cache and may be thrown away and
// recomputed at any time.
function buildStoreSnapshot({ store, nowMs, cfg, saDate, stock, products, refillRequests, movements, routes, rotationState, displayKeys, prevBatchPids, prevBatchAt }) {
  const oos = buildOutOfStock({ store, nowMs, cfg, stock, products, refillRequests, routes });
  const rot = buildRotation({ store, nowMs, cfg, saDate, stock, products, movements, rotationState, displayKeys, prevBatchPids, prevBatchAt });
  const snap = {
    computedAt: new Date(nowMs).toISOString(),
    saDate,
    store,
    oos: { rows: oos.rows, total: oos.total, truncated: oos.truncated },
    rotation: {
      rows: rot.rows,
      batchDate: rot.batchDate,
      refreshed: rot.refreshed,
      universeSize: rot.universeSize,
      // Cycle length in batches, so the card can say how long a full sweep
      // takes without the client counting anything.
      cycleBatches: Math.ceil(rot.universeSize / cfg.batchSize) || 0,
      // How many of this batch have already been walked — so the card can say
      // the batch is finished rather than showing an empty list that reads the
      // same as "nothing to check".
      walked: rot.walked,
      batchSize: rot.batchPids.length,
    },
  };
  // The full batch, for the pass's own state — never part of what the card
  // reads, and deliberately not inside the snapshot's byte budget.
  snap.batchPids = rot.batchPids;
  snap.batchAt = rot.batchAt;
  return snap;
}

module.exports = {
  AUDIT_STORES, WEEKDAYS, DEFAULTS,
  auditConfig, saHour, saWeekday, shouldRunDailyPass, isRotationDay,
  cellKey, sizeLabel, stockSizeKey,
  buildOutOfStock, rotationUniverse, selectRotationBatch, soldIndex, displayIndex,
  buildRotation, buildStoreSnapshot,
};
