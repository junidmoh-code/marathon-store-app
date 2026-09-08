// ─── STOCK AUDIT — the pure brain behind the two daily shelf checks ──────────
//
// TWO LISTS. THEY DO NOT SHARE A SCOPE, AND THAT IS DELIBERATE.
//
//   TAB A — OUT OF STOCK CHECKS, PER HUB, SNEAKERS ONLY.
//   Every sneaker line a hub answered with "sold out" or "coming tomorrow".
//   Those are the two answers that send a customer away, and each one is a
//   claim about a shelf that nobody has looked at. The list is that claim,
//   addressed to the hub that made it, with the quantity the system believed
//   was there beside it — because a hub that says "sold out" against a cell
//   reading three is a phantom, and a hub that says it against a cell reading
//   zero is simply a hub that is out.
//   NOT in this list: rejections (a refill request refused is a different
//   conversation between two warehouses, not a customer turned away), clothing,
//   and negative cells.
//
//   TAB B — NOT SELLING, PER SHOP, CLOTHING ONLY.
//   A self-rotating sweep of the clothing a shop HOLDS and has NOT SOLD in
//   three weeks: 30 lines a batch, three mornings a week. Not ranked by
//   severity — severity rankings check the same worst offenders forever and
//   never find the quiet phantom in the middle of the catalogue. Coverage is
//   the product. Marathon PE and Trophy only.
//
// WHY IT IS PURE. Everything here is a function of data the refill scan
// ALREADY holds in memory after its once-per-run snapshot — /orders, /stock,
// /products, the 45-day movement slice — plus this feature's own small state.
// No Firebase, no clock, no I/O; nowMs is injected. That is what makes the
// daily pass free: the expensive reads were already paid for by the run that
// calls it.
//
// NOTHING HERE ROTATES ON A HUMAN'S SAY-SO. The batch is a pure function of
// (universe, rotation stamps, SA date). There is no "generate" button, because
// a list that only appears when somebody remembers to press something is a list
// nobody reads.

"use strict";

const { isClothing } = require("./refill-engine.cjs");
const { saDateStringFromMs, SAST_OFFSET_MS } = require("./sa-time.cjs");

// The two shops this feature covers. Hard-coded, not config-driven: the scope
// is an owner decision about which floors have someone to walk them, and a
// config key would invite a third store to appear without anyone deciding it.
const AUDIT_STORES = ["marathon-pe", "trophy"];

// The hubs that answer customer orders. Measured on live /orders 2026-09-08:
// every one of the three produces sold-out and coming-tomorrow answers
// (hub1 20, hub2 14, hub3 7 in a single day), so all three get a list.
const AUDIT_HUBS = ["hub1", "hub2", "hub3"];

// The two answers that send a customer away, and the order field that records
// each. Nothing else belongs in Tab A: a rejected refill request is two
// warehouses talking to each other, not a customer being turned away.
const UNAVAILABLE_ANSWERS = [
  { key: "out_of_stock", field: "outOfStockAt" },
  { key: "coming_tomorrow", field: "comingTomorrowAt" },
];

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

// The size as a human reads it, from the /stock key it is stored under.
//
// Mirrors src/utils/sizeKey.js decodeSizeKey: only digit_digit becomes a
// decimal ("5_5" -> "5.5"), never a broad underscore replace, which would
// mangle "ONE_SIZE" and the "_" sentinel. Clothing runs S–XXXL and needed
// nothing but the sentinel — but Tab A is SNEAKERS, where half sizes are
// ordinary, and a row reading "5_5" is a row that looks like a bug to the
// person holding the shoe.
function sizeLabel(sizeKey) {
  if (sizeKey === "_") return "One size";
  return String(sizeKey).replace(/(\d)_(\d)/g, "$1.$2");
}

// ─── TAB A — OUT OF STOCK CHECKS (per hub, sneakers) ─────────────────────────
//
// One source, and it is one the scan already holds: /orders. A hub answers a
// customer order with "sold out" (`outOfStockAt`) or "coming tomorrow"
// (`comingTomorrowAt`), and either answer is a statement about a shelf that
// nobody has since walked. That is the list.
//
// RESOLVED LINES ARE NOT CHECKS. An order that later reached `readyAt` or
// `collectedAt` was found and handed over — the shelf answered for itself, and
// putting it in front of staff is work they cannot do. Same principle the
// refill engine applies when it withdraws unpickable requests.
//
// THE BELIEVED QUANTITY IS THE WHOLE POINT. It is free — /stock for every hub
// is already in memory — and without it a row is just a complaint. "Sold out"
// against a cell reading 3 is a phantom worth walking to; "sold out" against a
// cell reading 0 is a hub that is genuinely out and needs a refill, not a
// count. The row carries the number so the reader can tell which they have.
//
// DEDUPED BY CELL, not by order: three customers refused the same size on the
// same day is ONE shelf to walk to, and listing it three times is how a list
// becomes noise. The count rides along instead.
function buildOutOfStock({ hub, nowMs, cfg, stock, products, orders }) {
  const since = nowMs - cfg.lookbackHours * 3600e3;
  const rows = new Map();

  for (const o of Object.values(orders || {})) {
    if (!o || o.productType !== "sneaker") continue;
    if ((o.placedAtHub || o.hub) !== hub) continue;
    // Found and handed over — nothing left to check.
    if (o.readyAt || o.collectedAt) continue;

    const answer = UNAVAILABLE_ANSWERS.find((a) => o[a.field]);
    if (!answer) continue;
    const at = Date.parse(o[answer.field]);
    if (!Number.isFinite(at) || at < since) continue;

    const pid = o.productId;
    if (!pid) continue;
    const sizeKey = stockSizeKey(o.size);
    const k = cellKey(pid, sizeKey, hub);
    const cur = rows.get(k);
    if (cur) {
      cur.c += 1;
      // The freshest answer names the row, and "sold out" outranks "coming
      // tomorrow" — a hub that said it has none at all is the stronger claim
      // about the shelf, whichever answer happened to be recorded last.
      if (answer.key === "out_of_stock" && cur.r !== "out_of_stock") { cur.r = answer.key; cur.at = at; }
      else if (answer.key === cur.r && at > cur.at) cur.at = at;
      continue;
    }
    rows.set(k, {
      k, p: pid,
      // The order carries the name it showed the customer. Falling back to the
      // catalogue keeps a row readable when a product record has been renamed
      // or merged since; falling back to the id keeps it from ever being blank.
      n: String(o.productName || products?.[pid]?.name || pid),
      s: sizeLabel(sizeKey), sk: sizeKey, w: hub,
      q: qtyAt(stock, hub, pid, sizeKey),
      r: answer.key, at, c: 1,
    });
  }

  // Worst first: a hub that said "sold out" while its own cell reads stock is
  // the only row here that is certainly wrong, so it leads. Then everything
  // else by how recently it was said — a customer turned away this morning is
  // a fresher lead than one turned away last night.
  const phantom = (r) => (r.r === "out_of_stock" && r.q > 0 ? 0 : 1);
  const out = [...rows.values()].sort((a, b) =>
    phantom(a) - phantom(b) || b.at - a.at || a.n.localeCompare(b.n) || a.s.localeCompare(b.s));
  const total = out.length;
  return {
    rows: out.slice(0, cfg.maxOutOfStockRows).map(({ at, ...r }) => r),
    total,
    truncated: total > cfg.maxOutOfStockRows,
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
function rotationUniverse({ store, stock, products, soldPids = null }) {
  const out = [];
  const byPid = stock?.[store] || {};
  for (const pid of Object.keys(byPid)) {
    if (!isClothing(products?.[pid])) continue;
    // NOT SOLD IN THE WINDOW is part of the UNIVERSE, not a badge on the row.
    // The tab is "not selling": a line that sold last week is not what anyone
    // is looking for, and leaving it in the rotation spends batches on
    // products that are working. Measured 2026-09-08: this narrows Marathon PE
    // from 1,296 held clothing lines to 641 and Trophy from 724 to 466.
    if (soldPids && soldPids.has(pid)) continue;
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

function buildRotation({ store, nowMs, cfg, saDate, stock, products, movements, rotationState, prevBatchPids, prevBatchAt }) {
  const sold = soldIndex({ store, nowMs, movements, soldWindowDays: cfg.soldWindowDays });
  const universe = rotationUniverse({ store, stock, products, soldPids: sold.byPid });
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
    // A carried batch with NO recorded mint time falls back to now, not to
    // zero. Zero would make every stamp in history read as "walked for this
    // batch" and blank the whole list; now makes none of them, and the batch is
    // shown in full. Both are wrong in that state, but only one of them hides
    // work — an audit must fail towards showing the shelf, never away from it.
    else batchAt = Number(prevBatchAt) > 0 ? Number(prevBatchAt) : nowMs;
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

  const rows = picked.map(({ pid, sizes }) => {
    const st = rotationState?.[pid] || null;
    return {
      p: pid,
      n: nameOf(products, pid),
      // "Present but slow" from a previous cycle. Carried so the card can show
      // the line as settled rather than re-raising it as a problem — the owner
      // rule that a confirmed slow mover must not come back as a question.
      slow: st?.o === "slow",
      last: Number.isFinite(Number(st?.at)) ? Number(st.at) : null,
      // Per-size rows — what the SIZE view shows, same batch resolved to cells.
      // No per-size sold flag: the whole batch is already "not sold", so the
      // only honest per-size fact is the quantity.
      z: sizes.map(({ sk, q }) => ({ s: sizeLabel(sk), sk, q })),
    };
  });

  return {
    rows, universeSize: universe.length, refreshed: fresh,
    // The day the batch was MINTED, not the day the pass ran — otherwise a
    // batch carried since Monday reports itself as Thursday's, and the one
    // field that could tell staff how old their list is would agree with
    // whatever day they happened to read it.
    batchDate: saDateStringFromMs(batchAt),
    batchAt, batchPids, walked: walked.size,
  };
}

// ─── THE SNAPSHOT ────────────────────────────────────────────────────────────
// Exactly what the card renders and nothing else. The audit trail is
// /stock_movements (for adjustments) and /settings/stockAudit/{store}/results
// (for outcomes) — this node is a render cache and may be thrown away and
// recomputed at any time.
// ── THE SNAPSHOTS ────────────────────────────────────────────────────────────
// One per hub for Tab A, one per shop for Tab B. Separate nodes because they
// have separate scopes, separate audiences and separate chip rows — a hub
// storeman opening this never needs Trophy's clothing rotation, and merging
// them would put both in front of both.
function buildHubSnapshot({ hub, nowMs, cfg, saDate, stock, products, orders }) {
  const oos = buildOutOfStock({ hub, nowMs, cfg, stock, products, orders });
  return {
    computedAt: new Date(nowMs).toISOString(), saDate, hub,
    oos: { rows: oos.rows, total: oos.total, truncated: oos.truncated },
  };
}

function buildStoreSnapshot({ store, nowMs, cfg, saDate, stock, products, movements, rotationState, prevBatchPids, prevBatchAt }) {
  const rot = buildRotation({ store, nowMs, cfg, saDate, stock, products, movements, rotationState, prevBatchPids, prevBatchAt });
  const snap = {
    computedAt: new Date(nowMs).toISOString(),
    saDate,
    store,
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
  AUDIT_STORES, AUDIT_HUBS, UNAVAILABLE_ANSWERS, WEEKDAYS, DEFAULTS,
  auditConfig, saHour, saWeekday, shouldRunDailyPass, isRotationDay,
  cellKey, sizeLabel, stockSizeKey,
  buildOutOfStock, rotationUniverse, selectRotationBatch, soldIndex,
  buildRotation, buildStoreSnapshot, buildHubSnapshot,
};
