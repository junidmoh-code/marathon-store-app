// ─── MISSING PRODUCTS — THE SCREEN (rebuilt, Junid 22 Nov 2026) ───────────────
// What Junid asked for after the first redesign shook under his finger:
//
//   Marathon | Concrete            each with how many cards are on its list
//   Sneakers | Clothing            two low boxes, edge to edge
//   the list                       nothing else above it
//
// THE CARD (MissingRow.jsx) is a fixed box: photo, name, one stock line, and
// the destinations as buttons. Tapping a destination IS the solve.
//
// THE DIVISION BUTTON (Junid, 23 Nov 2026) sits where Hide was: "Concrete" on
// a Marathon card, "Marathon" on a Concrete card. Two taps (24 Nov 2026 — the
// first arms it) say the product belongs to that division only (divisionMark.js — the pre-rebuild Concrete
// button's own data, plus its mirror). The card leaves this list for good and
// is never counted here; on the other list it shows only when it is genuinely
// missing there. Hide left the cards; the hidden tab still works.
//
// WHAT IS ON THE LIST is decided before a card is drawn (missingListCore.js):
// only a product a tap would send something for. The count on a division is
// the number of cards on its two lists, nothing else.
//
// NO SHAKE, by construction:
//   • every availability question is answered in the data layer, before the
//     card exists — there is no "checking…" state on a card and no panel;
//   • the order of a list is frozen while the screen is open (new rows join at
//     the end; nothing visible is re-sorted);
//   • a solved card stays exactly where it is until its write has landed, then
//     its slot closes in ONE transition and the cards below move up once;
//   • the confirmation is a toast fixed over the bottom of the screen (Undo for
//     a few seconds). It overlays; it pushes nothing.
//
// THIS FILE DECIDES NOTHING ABOUT STOCK. What is missing comes from the two
// cores that always decided it; what a tap writes is the two hooks'
// (NetworkTransfer.jsx useProductSolve, MissingFootwear.jsx useSneakerRequest)
// through their one-shop / one-hub entry; the quantities are the ones policy
// already computes.
//
// READS: the nodes the screen always subscribed to, through the same shared,
// mirror-backed hooks (one listener per path for the whole app). Nothing new.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BG, FONT, GRAY, GREEN, RED, AMBER, BLUE_L } from "./ui";
import { useStockCells, useStockTargetsState, useHiddenMissingProducts, usePathState, useStockHeld, useEngineConfigState } from "./useStock";
import { useMySections } from "../../utils/useMySections";
import { sectionName } from "../../utils/networkRegistry";
import { hubIds, storeIds, centralId, nameOf } from "./sectionRouting";
import { computeMissingProducts, concreteSection } from "./missingProductsCore";
import { computeMissingFootwear } from "./missingFootwearCore";
import { partitionQueued } from "./missingScreenCore";
import { openingOrder, openRequestsByProduct, openLocationsByProduct, isSeat, decideProductRow, decideSneakerRow, createFrozenOrder, freezeOrder, tapProblem, shopOwners, pickNext } from "./missingListCore";
import { strandedAtCentral, openRequestPids, notListedRows } from "./notListedCore";
import NotListed, { NotListedLine } from "./NotListed";
import { useSlicedRows } from "./useSlicedRows";
import { useProductSolve } from "./NetworkTransfer";
import { useSneakerRequest } from "./MissingFootwear";
import { shopDestinations, shopsAreExclusive, destinationProblem } from "./divisionDestinations";
import { otherMarathonHub, marathonHubSeated, marathonSolveRefusal, SEATS_PATH, DIVISION_SHOPS } from "./concreteDivision";
import { undoSneakerRequest, shopOwnersNow } from "./missingActions";
import { withDivisionMarks, listedForDivision, markDivision, undoDivision, clearDivision, restoreMarks, liveMarksOf, CONCRETE_INDEX_PATH, MARATHON_INDEX_PATH } from "./divisionMark";
import { ref, update, get, query, orderByChild, equalTo, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { unhideUpdate } from "./hiddenProductsCore";
import { usePermissions } from "../PermissionsContext";
import HiddenProducts, { HoldSpot } from "./HiddenProducts";
import { PhotoLightbox } from "./healthWidgets";
import MissingRow, { Slot, SkeletonRow, CARD_H, CARD_GAP, LEAVE_MS } from "./MissingRow";
import { searchTerms, matchesSearch } from "./missingSearch";
import { primaryPhotoUrl } from "../../utils/primaryPhoto";
import { stockSizeKey } from "../../utils/sizeKey";
import { setUpdateBusy } from "../../update/updateChecker";
import { owedBySize, figureChanged, productAtCentral, owedIndex } from "./missingFigures";
import { decodeSizeKey } from "../../utils/sizeKey";
import { serverNowMs } from "../../utils/serverTime";

// The division shown first, and the order of the switch: Marathon, Concrete.
const DIVISION_ORDER = [2, 1];
const KINDS = [["sneakers", "Sneakers"], ["clothing", "Clothing"]];
// Cards drawn at once; the rest follow as the list is scrolled.
const PAGE = 40;
const TOAST_MS = 7000;
const NONE = Object.freeze({});
const NO_PICK = Object.freeze([]);
const NOOP = () => {};
// What the buttons call the shops (the registry's "Marathon Pine" is "Pine" to
// everyone who works there).
const SHORT = { "marathon-pine": "Pine" };

const bucketId = (section, kind) => `${section}:${kind}`;

// Which division's list this is: "concrete" for the Concrete division's
// section, "marathon" for every other (divisionMark.js).
const listKindOf = (network, sec) => (sec === concreteSection(network) ? "concrete" : "marathon");

// ── THE SOLVE CLAIM (Junid, 24 Nov 2026) ─────────────────────────────────────
// /settings/missingSolveClaims/{pid} — held for the length of one Solve (a
// second or two), never longer than CLAIM_MS even if a phone dies mid-solve.
// It decides nothing about stock: it only says "someone is solving this now".
export const SOLVE_CLAIMS_PATH = "settings/missingSolveClaims";
export const CLAIM_MS = 30000;
export async function claimSolve(pid, token) {
  const now = serverNowMs();
  const r = await runTransaction(ref(database, `${SOLVE_CLAIMS_PATH}/${pid}`), (cur) => {
    if (cur && cur.token !== token && Number(cur.at) > now - CLAIM_MS) return undefined;   // someone else holds it
    return { token, at: now, by: auth.currentUser?.uid || null };
  });
  return !!(r && r.committed && r.snapshot?.val()?.token === token);
}
export async function releaseSolveClaim(pid, token) {
  await runTransaction(ref(database, `${SOLVE_CLAIMS_PATH}/${pid}`), (cur) => (cur && cur.token === token ? null : undefined));
}
// One product, live: its cells at `source` (decoded, as the screen holds them)
// and every request record for it (the productId index — never a whole node).
export async function readLiveProduct(source, pid) {
  const [cellsSnap, reqSnap] = await Promise.all([
    get(ref(database, `stock/${source}/${pid}`)),
    get(query(ref(database, "refill_requests"), orderByChild("productId"), equalTo(pid))),
  ]);
  const cells = {};
  for (const [k, c] of Object.entries(cellsSnap.val() || {})) cells[decodeSizeKey(k)] = c;
  const reqs = Object.entries(reqSnap.val() || {}).map(([id, r]) => ({ id, ...r }));
  return { cells, reqs };
}

export default function MissingProductsScreen({ products: rawProducts = [], onExit, onOpenEnginePolicy = null }) {
  const { registry: network, sections: mySections } = useMySections();
  // WHICH DIVISION A PRODUCT BELONGS TO (Junid, 23 Nov 2026): the two small
  // index nodes, live on every device, laid over the product records so a
  // mark made anywhere applies here at once (divisionMark.js).
  const concreteIdx = usePathState(CONCRETE_INDEX_PATH);
  const marathonIdx = usePathState(MARATHON_INDEX_PATH);
  const marksSettled = concreteIdx.settled && marathonIdx.settled;
  const marksError = !!(concreteIdx.error || marathonIdx.error);
  const products = useMemo(() => withDivisionMarks(rawProducts, concreteIdx.value, marathonIdx.value, marksSettled && !marksError), [rawProducts, concreteIdx.value, marathonIdx.value, marksSettled, marksError]);
  const allStockLive = useStockCells();
  const targetsState = useStockTargetsState();
  const hiddenMap = useHiddenMissingProducts();
  const reqState = usePathState("refill_requests");
  // WHO OWNS A PINE / CONCRETE PRODUCT includes where it is SEATED (Junid, 22
  // Nov 2026). The two shops' seat nodes only — never the whole seats tree.
  // (read only while a one-or-the-other division is open to this viewer — a
  // Marathon-only list never waits on them)
  const heldLines = useStockHeld();
  const cfgState = useEngineConfigState();
  const cfg = cfgState.raw;
  const CENTRAL = centralId(network);

  const divisions = useMemo(
    () => DIVISION_ORDER.filter((s) => mySections.includes(s) && (storeIds(network, { section: s }).length > 0 || hubIds(network, { section: s }).length > 0)),
    [network, mySections],
  );
  const needSeats = divisions.some((s) => shopsAreExclusive(network, s));
  const seatsA = usePathState(`${SEATS_PATH}/${DIVISION_SHOPS[0]}`, needSeats);
  const seatsB = usePathState(`${SEATS_PATH}/${DIVISION_SHOPS[1]}`, needSeats);
  const seats = useMemo(() => ({ [DIVISION_SHOPS[0]]: seatsA.value || NONE, [DIVISION_SHOPS[1]]: seatsB.value || NONE }), [seatsA.value, seatsB.value]);
  const seatsSettled = !needSeats || (seatsA.settled && seatsB.settled);
  const seatsError = needSeats && !!(seatsA.error || seatsB.error);
  const requestsLive = useMemo(() => (reqState.value ? Object.entries(reqState.value).map(([id, r]) => ({ id, ...r })) : []), [reqState.value]);
  // LIVE AT THE TAP (Junid, 24 Nov 2026 — "the numbers must be 100% accurate"):
  // when Solve's live read finds Central's cells or this product's requests
  // differ from what the screen holds, those live values are laid over the
  // screen's for that product at once, so its card redraws on the correct
  // figure without waiting for the feed. An entry is dropped as soon as the
  // feed itself says the same (or after a minute, whichever is first).
  const [liveFix, setLiveFix] = useState({});   // pid → { cells, reqs, at }
  const { allStock, requests } = useMemo(() => {
    const pids = Object.keys(liveFix);
    if (!pids.length) return { allStock: allStockLive, requests: requestsLive };
    const central = { ...(allStockLive?.central || {}) };
    for (const pid of pids) central[pid] = liveFix[pid].cells;
    const fixed = new Set(pids);
    return {
      allStock: { ...allStockLive, central },
      requests: [...requestsLive.filter((r) => !fixed.has(r.productId)), ...pids.flatMap((pid) => liveFix[pid].reqs)],
    };
  }, [allStockLive, requestsLive, liveFix]);
  useEffect(() => {
    const pids = Object.keys(liveFix);
    if (!pids.length) return undefined;
    const done = pids.filter((pid) => {
      const f = liveFix[pid];
      if (Date.now() - f.at > 60000) return true;
      const routes = cfgState.raw?.routes || {};
      const same = !figureChanged({ dests: [{ sizes: Object.keys({ ...(allStockLive?.central?.[pid] || {}), ...f.cells }) }] },
        { cells: allStockLive?.central?.[pid] || {}, owed: owedBySize(requestsLive, pid, { routes }) },
        { cells: f.cells, owed: owedBySize(f.reqs, pid, { routes }) });
      return same;
    });
    if (done.length) setLiveFix((m) => { const n = { ...m }; for (const pid of done) delete n[pid]; return n; });
    const t = setTimeout(() => setLiveFix((m) => ({ ...m })), 61000);
    return () => clearTimeout(t);
  }, [liveFix, allStockLive, requestsLive]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Never count against a half-loaded /stock: a zero then would say "nothing
  // is missing" at the moment nothing is known.
  // Ready once the read has ANSWERED — an empty node included (CodeRabbit, PR #964).
  const stockState = usePathState("stock");
  // (A read that FAILED is not "nothing missing": the skeletons stay.)
  const stockReady = (stockState.settled && !stockState.error) || (!!allStock && Object.keys(allStock).length > 0);

  // ── WHAT IS MISSING, per division — the two cores, memoised on what they read.
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const walked = useMemo(() => {
    const out = {};
    for (const sec of divisions) {
      const hubs = hubIds(network, { section: sec });
      // Marathon's is the call this list has always made; Concrete's names
      // its section and takes the engine config (central-fed shops).
      const all = !stockReady ? [] : sec === 2
        ? computeMissingProducts({ allStock, products })
        : computeMissingProducts({ allStock, products, network, section: sec, centralFed: cfg });
      const sneakers = !stockReady ? [] : computeMissingFootwear({ allStock, products, hubs, heldLines, central: CENTRAL });
      // A product marked for the other division is never on this one's list,
      // in either kind, and never counted in its number.
      const kindOf = listKindOf(network, sec);
      const mine = (c) => listedForDivision(byId.get(c.pid), kindOf);
      out[sec] = { all: all.filter(mine), sneakers: sneakers.filter(mine), hubs };
    }
    return out;
  }, [divisions, stockReady, allStock, products, byId, network, cfg, heldLines, CENTRAL]);

  // QUEUED AT CENTRAL → OFF THAT DIVISION'S LIST. One source of truth: a real
  // open request at one of the division's hubs (missingScreenCore.js). There
  // is no other "queued" mark anywhere — nothing is stored but the request.
  const cards = useMemo(() => {
    const out = {};
    for (const sec of divisions) {
      const w = walked[sec];
      out[sec] = { clothing: openingOrder(w.all), sneakers: openingOrder(partitionQueued(w.sneakers, requests, w.hubs).todo) };
    }
    return out;
  }, [divisions, walked, requests]);

  // Per division, as the Solve hooks expect it (see Engines below).
  const [resolving, setResolving] = useState({});
  const [solvedSession, setSolvedSession] = useState([]);
  const setResolvingFor = useCallback((section) => (fn) => setResolving((all) => {
    const cur = all[section] || NONE;
    const next = typeof fn === "function" ? fn(cur) : fn;
    return next === cur ? all : { ...all, [section]: next };
  }), []);

  const shared = { products, allStock, targetsState, walked, cards, resolving, setResolvingFor, solvedSession, setSolvedSession };
  // The one-tap surfaces of each division's hooks, by section. Engines render
  // before Body in the same pass, so Body always reads this render's; a tap
  // reads it at the moment of the tap.
  const apisBox = useRef({});
  // What Body must re-render for when only an Engine's own state moved.
  const [flags, setFlags] = useState({});   // section → { ready, canAct }
  const report = useCallback((sec, f) => setFlags((m) => (m[sec] && m[sec].ready === f.ready && m[sec].canAct === f.canAct ? m : { ...m, [sec]: f })), []);
  return (
    <>
      {/* KEYED BY DIVISION: a division that loads late, or leaves, never moves
          another division's Solve state, and never remounts the list. */}
      {divisions.map((sec) => <Engine key={sec} section={sec} shared={shared} box={apisBox} report={report} />)}
      <Body apis={apisBox.current} flags={flags} divisions={divisions} network={network} products={products} allStock={allStock} targets={targetsState}
        hiddenMap={hiddenMap} requests={requests} requestsSettled={reqState.settled && seatsSettled && marksSettled} requestsError={!!reqState.error || seatsError || marksError} seats={seats} cfg={cfg} cfgSettled={cfgState.settled}
        heldLines={heldLines} stockReady={stockReady} walked={walked} cards={cards} central={CENTRAL} onExit={onExit} onOpenEnginePolicy={onOpenEnginePolicy}
        liveFix={liveFix} setLiveFix={setLiveFix} />
    </>
  );
}

// ONE PAIR OF SOLVE HOOKS PER DIVISION. Each list solves into its own division
// only, and the hooks keep what is in flight per division — so they are
// mounted once for each, for as long as the screen is open, and the screen
// reaches them through their one-tap surface (`api`).
function Engine({ section, shared, box, report }) {
  const product = useProductSolve({
    products: shared.products, category: "all", allStock: shared.allStock, cards: shared.walked[section]?.all || [], section,
    targets: shared.targetsState.value, targetsSettled: shared.targetsState.settled, targetsError: shared.targetsState.error,
    solvedSession: shared.solvedSession, setSolvedSession: shared.setSolvedSession,
    resolving: shared.resolving[section] || NONE, setResolving: shared.setResolvingFor(section),
  });
  const sneaker = useSneakerRequest({ products: shared.products, section, cards: shared.cards[section]?.sneakers || [], onQueued: NOOP, targets: shared.targetsState.value, allStock: shared.allStock });
  box.current[section] = { product: product.api, sneaker: sneaker.api };
  const ready = !!(product.api.ready && sneaker.api.ready);
  const canAct = !!product.api.canAct;
  useEffect(() => { report(section, { ready, canAct }); }, [report, section, ready, canAct]);
  useEffect(() => () => { delete box.current[section]; }, [box, section]);
  return null;
}

function Body({ apis, flags, divisions, network, products, allStock, targets, hiddenMap, requests, requestsSettled, requestsError, seats, cfg, cfgSettled, heldLines, stockReady, walked, cards, central, onExit, onOpenEnginePolicy, liveFix = NONE, setLiveFix = NOOP }) {
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [pick, setPick] = useState(null);
  // THE DIVISION THIS PERSON OPENS ON (Junid, 24 Nov 2026): their own
  // /users/{uid}.missingProductsDivision ("marathon" | "concrete"), read from
  // the record the app already listens to. No setting → today's default
  // (Marathon first). A tap on the switch always wins for this visit.
  const { permRecord, isSuperAdmin } = usePermissions();
  const homeDivision = divisions.find((s) => listKindOf(network, s) === permRecord?.missingProductsDivision);
  const section = divisions.includes(pick) ? pick : (homeDivision ?? divisions[0]);
  const [kind, setKind] = useState("sneakers");
  const [view, setView] = useState("list");   // "list" | "hidden" | "notlisted"
  const [lightbox, setLightbox] = useState(null);
  // SEARCH (Junid, 23 Nov 2026): kept across a division or kind switch and
  // applied to the new list. It only hides cards that do not match — the
  // frozen order underneath is untouched, so clearing gives the same list.
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  const active = bucketId(section, kind);
  const canAct = divisions.length ? !!flags[divisions[0]]?.canAct : false;
  // Marking a division is Junid's / Jafer's / a stockRole admin's — the same
  // identities the pre-rebuild Concrete button had (the mark is the brand check).
  const canMark = !!isSuperAdmin || permRecord?.stockRole === "admin";

  const label = useCallback((loc) => SHORT[loc] || nameOf(loc, network), [network]);
  const reqByPid = useMemo(() => openRequestsByProduct(requests), [requests]);
  // What Central still owes, per product and size (missingFigures.js) — one pass.
  const owedAll = useMemo(() => owedIndex(requests, { routes: cfg?.routes || {}, central }), [requests, cfg, central]);

  // ── THE ROWS: every card asked, before it is drawn, what a tap would send ──
  const apisRef = useRef(apis); apisRef.current = apis;
  // WHY A CARD WAS DROPPED (bucket id → Map pid → reason), recorded by the
  // same build that decides the row — read by "Not listed" below.
  const whyRef = useRef({});
  const noteWhy = (id, pid, why) => { const m = (whyRef.current[id] ||= new Map()); if (why) m.set(pid, why); else m.delete(pid); };
  const ctx = useRef(null);
  // Where each product has ANY open request (fully sent or not): ownership.
  const openAt = useMemo(() => openLocationsByProduct(requests), [requests]);
  ctx.current = { byId, allStock, targets: targets.value, reqByPid, openAt, cfg, network, central, label, seats, requests, liveFix };
  const buckets = useMemo(() => divisions.flatMap((sec) => [
    {
      id: bucketId(sec, "sneakers"), cards: cards[sec].sneakers,
      build: (card) => {
        const c = ctx.current, api = apisRef.current[sec].sneaker;
        const open = c.reqByPid.get(card.pid);
        const d = decideSneakerRow({
          card, section: sec, dests: api.destinations, blocked: !!api.notLive, central: c.central, nameOf: c.label,
          // (a product whose live values are laid over the feed plans from them)
          planFor: c.liveFix[card.pid] ? (cd, hub) => api.planFor(cd, hub, c.requests) : api.planFor,
          hasPolicy: api.hasPolicy, requested: !!open && Object.keys(open).length > 0,
          // Hub 1 and Hub 2 never share a sneaker: the same test the write
          // makes (cells, target rows and open requests at the OTHER hub),
          // asked here so a hub that would be refused is never a live button.
          refusal: (cd, [hub]) => {
            const other = otherMarathonHub(hub);
            if (!other) return null;
            const cells = Object.fromEntries(Object.entries(c.allStock?.[other]?.[cd.pid] || {}).map(([k, v]) => [stockSizeKey(k), v]));
            return marathonHubSeated({ cells, rows: c.targets?.[other]?.[cd.pid], openRequest: !!open?.[other] }) ? marathonSolveRefusal(hub) : api.pickRefusal(cd, [hub]);
          },
        });
        // A CARD ALWAYS OFFERS A LOCATION (Junid, 24 Nov 2026): a row with none
        // is "Not listed", never a card whose only control is the division button.
        const row = d.row && d.row.dests.length ? d.row : null;
        noteWhy(bucketId(sec, "sneakers"), card.pid, row ? null : d.why || "unknown");
        return row;
      },
    },
    {
      id: bucketId(sec, "clothing"), cards: cards[sec].clothing,
      build: (card) => {
        const c = ctx.current, api = apisRef.current[sec].product;
        const dests = shopDestinations(c.network, sec);
        const open = c.reqByPid.get(card.pid) || NONE;
        const openAt = c.openAt;
        // ONE-OR-THE-OTHER SHOPS (Pine / Concrete): who already owns it.
        // Marathon's shops are not one-or-the-other and are left as they were.
        const owners = shopsAreExclusive(c.network, sec)
          ? shopOwners({ shops: dests, cells: Object.fromEntries(dests.map((d) => [d, c.allStock?.[d]?.[card.pid]])), seated: (d) => isSeat(c.seats?.[d]?.[card.pid]), queued: (d) => !!openAt.get(card.pid)?.has(d) })
          : null;
        const d = decideProductRow({
          card, section: sec, product: c.byId.get(card.pid), dests, tickable: api.tickableStores(card),
          planFor: api.planFor, openByLoc: open, allStock: c.allStock, central: c.central,
          routes: c.cfg?.routes, nameOf: c.label, owners,
        });
        const row = d.row && d.row.dests.length ? d.row : null;
        noteWhy(bucketId(sec, "clothing"), card.pid, row ? null : d.why || "unknown");
        return row;
      },
    },
  ]), [divisions, cards]);

  const enginesReady = divisions.every((s) => flags[s]?.ready && apis[s]);
  // An UNREADABLE request queue is not an empty one: nothing would look
  // promised, so no list is built — the screen says so and offers a Retry.
  const ready = stockReady && requestsSettled && !requestsError && cfgSettled && targets.settled && enginesReady;
  // Anything a plan reads. A new identity means "work the rows out again".
  const version = useMemo(() => ({}), [buckets, allStock, requests, cfg, targets.value, heldLines, products, network, canAct, seats, liveFix]);
  // The products whose own figures just moved: rebuilt at once (useSlicedRows `hot`).
  const prevSig = useRef(null);
  const hot = useMemo(() => {
    const sig = new Map();
    for (const [pid, cells] of Object.entries(allStock?.[central] || {})) sig.set(pid, JSON.stringify(cells));
    for (const [pid, o] of owedAll) sig.set(pid, `${sig.get(pid) || ""}|${JSON.stringify(o)}`);
    const prev = prevSig.current;
    prevSig.current = sig;
    if (!prev) return null;
    const out = [];
    for (const [k, v] of sig) if (prev.get(k) !== v) out.push(k);
    for (const k of prev.keys()) if (!sig.has(k)) out.push(k);
    return out.length && out.length <= 300 ? out : null;   // a mass change is the full pass's job
  }, [allStock, owedAll, central]);
  const sliced = useSlicedRows({ buckets, active, version, ready, hot });

  // ── OFF THE LIST FOR THIS VISIT: solved here, or hidden here ───────────────
  const [gone, setGone] = useState({});       // row key → true
  const [busy, setBusy] = useState({});       // row key → true while its Solve is written
  // WHAT IS CHOSEN ON EACH CARD (row key → location ids, in tap order). Lives
  // and dies with this screen: leaving it clears every choice.
  const [picks, setPicks] = useState({});
  const latestPicks = useRef(picks); latestPicks.current = picks;
  const latestRows = useRef(new Map());
  const inFlight = useRef(new Set());
  const listedOf = (id) => sliced.rows[id].filter((r) => !(hiddenMap && hiddenMap[r.pid]) && !gone[r.key]);
  const countOf = (sec) => (KINDS.every(([k]) => sliced.complete[bucketId(sec, k)])
    ? KINDS.reduce((t, [k]) => t + listedOf(bucketId(sec, k)).length, 0) : null);

  // ── NOT LISTED (Junid, 23 Nov 2026): nothing disappears silently ──────────
  // A product with units at Central and none at any shop or hub of the
  // division is a card on one of its two lists, or a row here with its
  // reason. Built from what this screen already holds (the whole /stock node,
  // the catalogue, the open requests, the hidden map) — nothing new is read.
  const strandedBy = useMemo(() => Object.fromEntries(divisions.map((sec) => {
    const locations = [...storeIds(network, { section: sec }), ...hubIds(network, { section: sec })];
    return [sec, { locations, hubs: hubIds(network, { section: sec }), stranded: stockReady ? strandedAtCentral({ allStock, locations, central }) : [] }];
  })), [divisions, network, allStock, stockReady, central]);
  // (keyed on the location ids, not on strandedBy: a stock tick must not rescan every request)
  const locKey = divisions.map((sec) => `${sec}=${[...storeIds(network, { section: sec }), ...hubIds(network, { section: sec })].join(",")}`).join(";");
  const openPidsBy = useMemo(() => Object.fromEntries(locKey.split(";").filter(Boolean).map((part) => { const [sec, locs] = part.split("="); return [Number(sec), openRequestPids(requests, locs.split(","))]; })), [locKey, requests]);
  const notListedOf = (sec) => {
    if (sec == null || !strandedBy[sec] || !KINDS.every(([k]) => sliced.complete[bucketId(sec, k)])) return null;
    const listedPids = new Set();
    const whyByPid = new Map();
    for (const [k] of KINDS) {
      const id = bucketId(sec, k);
      for (const r of sliced.rows[id] || []) if (!(hiddenMap && hiddenMap[r.pid])) listedPids.add(r.pid);
      const w = whyRef.current[id];
      if (w) for (const c of cards[sec]?.[k] || []) if (w.has(c.pid) && !whyByPid.has(c.pid)) whyByPid.set(c.pid, w.get(c.pid));
    }
    // Solved on this screen a moment ago: on its way, not "not listed".
    for (const key of Object.keys(gone)) { const [s2, , pid] = key.split(":"); if (Number(s2) === sec) listedPids.add(pid); }
    const { hubs } = strandedBy[sec];
    const heldAt = (pid) => hubs.some((h) => Object.values((heldLines && heldLines[h]) || {}).some((l) => l && l.productId === pid && Number(l.qty) > 0));
    const paused = (loc) => cfg?.pausedLocations?.[loc] === true;
    // A card dropped for NO POLICY is "Not listed" even when a shop or hub of
    // the division holds some of it (so it is not "stranded"): the card it
    // replaces was on the list before 24 Nov, and it must not vanish silently.
    const stranded = [...strandedBy[sec].stranded];
    const inStranded = new Set(stranded.map((x) => x.pid));
    for (const [pid, why] of whyByPid) {
      if (why !== "noPolicy" || inStranded.has(pid) || listedPids.has(pid)) continue;
      const centralUnits = Object.entries(allStock?.[central]?.[pid] || {}).reduce((t, [k, c]) => (k === "_meta" ? t : t + Math.max(Number(c?.qty) || 0, 0)), 0);
      if (centralUnits > 0) stranded.push({ pid, centralUnits });
    }
    // "Central N" here means what it means on a card: units at Central FREE to
    // send; what open requests already own is said beside it as "promised".
    return notListedRows({ stranded, listedPids, whyByPid, hiddenMap, byId, listKind: listKindOf(network, sec), allStock, locations: strandedBy[sec].locations, openPids: openPidsBy[sec], heldAt, paused })
      .map((r) => { const f = productAtCentral(allStock?.[central]?.[r.pid], owedAll.get(r.pid)); return { ...r, centralFree: f.free, centralOwed: f.owed }; });
  };

  // A card solved or hidden here stays off until the DATA no longer lists it;
  // then the mark is forgotten, so a product that goes missing again later in
  // the visit comes back by itself (Sonnet architect review, PR #964).
  useEffect(() => {
    const drop = Object.keys(gone).filter((k) => {
      const [sec, kind, pid] = k.split(":");
      const id = bucketId(Number(sec), kind);
      return sliced.complete[id] && !(sliced.rows[id] || []).some((r) => r.pid === pid);
    });
    if (drop.length) setGone((g) => { const n = { ...g }; for (const k of drop) delete n[k]; return n; });
  });

  // A write still on its way is a job in hand: no app update under it.
  // (an Undo's writes count too — undoing holds this until they are done)
  const [undoing, setUndoing] = useState(0);
  const writing = Object.keys(busy).length > 0 || undoing > 0;
  useEffect(() => {
    setUpdateBusy("missing-products", writing);
    return () => setUpdateBusy("missing-products", false);
  }, [writing]);

  // ── THE FROZEN ORDER, AND THE ONE MOVEMENT (a card leaving) ────────────────
  const frozen = useRef({});
  const [, repaint] = useState(0);
  const fz = (frozen.current[active] ||= { ...createFrozenOrder(), last: new Map(), shown: null, leaving: new Map() });
  // Is this list actually drawn right now? (Not while its rows are still being
  // worked out, and not behind the hidden tab.)
  const onScreen = view === "list" && section != null && !!sliced.complete[active];
  const listed = onScreen ? listedOf(active) : [];
  const listedBy = new Map(listed.map((r) => [r.key, r]));
  latestRows.current = listedBy;   // the rows as drawn, for Solve's second look
  const before = new Set(fz.seen);
  freezeOrder(fz, listed.map((r) => r.key));
  for (const r of listed) fz.last.set(r.key, r);
  if (fz.shown) for (const k of fz.shown) if (!listedBy.has(k) && !fz.leaving.has(k)) fz.leaving.set(k, null);
  for (const k of [...fz.leaving.keys()]) if (listedBy.has(k)) { clearTimeout(fz.leaving.get(k)); fz.leaving.delete(k); }
  const inOrder = fz.order.filter((k) => listedBy.has(k) || fz.leaving.has(k)).map((k) => ({
    key: k, row: listedBy.get(k) || fz.last.get(k), leaving: !listedBy.has(k),
    // put back by Undo (seen before, not on screen a moment ago): its slot opens
    entering: !!fz.shown && before.has(k) && listedBy.has(k) && !fz.shown.has(k),
  }));
  const display = inOrder;
  // What is drawn: the frozen list, narrowed by the search (no reads — the
  // rows and product records are the ones already on screen).
  const terms = searchTerms(query);
  const shown = terms.length ? display.filter((d) => matchesSearch(terms, d.row, byId.get(d.row.pid))) : display;
  // A search that finds nothing here: how many it finds on the other tab.
  const [otherKind, otherKindName] = KINDS.find(([k]) => k !== kind);
  const otherId = bucketId(section, otherKind);
  const otherFound = terms.length && section != null && sliced.complete[otherId]
    ? listedOf(otherId).filter((r) => matchesSearch(terms, r, byId.get(r.pid))).length : 0;
  // "Not listed" for the division on screen, narrowed by the same search.
  const notListedAll = view !== "hidden" && !requestsError ? notListedOf(section) : null;
  const notListed = notListedAll && terms.length ? notListedAll.filter((r) => matchesSearch(terms, r, byId.get(r.pid))) : notListedAll;
  const [nlLimit, setNlLimit] = useState(200);
  const [nlBusy, setNlBusy] = useState({});
  const nlInFlight = useRef(new Set());
  useEffect(() => {
    // A list that is not drawn has nothing "shown": when it comes back, its
    // cards are simply there — none of them enters or leaves.
    if (!onScreen) { for (const t of fz.leaving.values()) clearTimeout(t); fz.leaving.clear(); fz.shown = null; return; }
    fz.shown = new Set(listedBy.keys());
    for (const [k, t] of fz.leaving) {
      if (t) continue;
      fz.leaving.set(k, setTimeout(() => { fz.leaving.delete(k); repaint((n) => n + 1); }, LEAVE_MS + 60));
    }
  });
  // A list that was off screen starts clean: nothing "leaves" on arrival.
  const lastActive = useRef(active);
  if (lastActive.current !== active) {
    const prev = frozen.current[lastActive.current];
    if (prev) { for (const t of prev.leaving.values()) clearTimeout(t); prev.leaving.clear(); prev.shown = null; }
    lastActive.current = active;
  }
  useEffect(() => () => { for (const f of Object.values(frozen.current)) for (const t of f.leaving.values()) clearTimeout(t); }, []);

  const [shownN, setShownN] = useState({});
  const limit = shownN[active] || PAGE;
  const more = useRef(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !more.current) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setShownN((m) => ({ ...m, [active]: (m[active] || PAGE) + PAGE })); }, { rootMargin: "600px" });
    io.observe(more.current);
    return () => io.disconnect();
  }, [active, shown.length > limit]);

  // ── THE TOAST ──────────────────────────────────────────────────────────────
  const [toast, setToast] = useState(null);   // { id, ok, text, undo }
  const toastTimer = useRef(null);
  const say = useCallback((t) => {
    clearTimeout(toastTimer.current);
    const id = Date.now() + Math.random();
    setToast({ id, ...t });
    toastTimer.current = setTimeout(() => setToast((cur) => (cur && cur.id === id ? null : cur)), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const back = (key) => setGone((g) => { const n = { ...g }; delete n[key]; return n; });

  // ── CHOOSE, THEN SOLVE (Junid, 22 Nov 2026) ────────────────────────────────
  // A location tap only CHOOSES: it writes nothing. Where the locations are one
  // or the other — Hub 1 / Hub 2, Pine / Concrete — a tap switches the other
  // off; Hub 3 is the only location on its list; Marathon's shops may both be
  // chosen and one Solve sends to both (as that list always allowed).
  const exclusiveFor = (row) => row.kind === "sneakers" || shopsAreExclusive(ctx.current.network, row.section);
  // The same array while it still applies (so a card does not redraw for
  // nothing); filtered only when a chosen location has left the card.
  const chosen = (row) => {
    const p = picks[row.key];
    if (!p || !p.length) return NO_PICK;
    const ok = (d) => row.dests.some((x) => x.id === d);
    if (p.every(ok)) return p;
    const left = p.filter(ok);
    return left.length ? left : NO_PICK;
  };
  const act = useRef({});
  act.current.pick = (row, dest) => {
    if (!canAct || gone[row.key] || inFlight.current.has(row.pid) || !row.dests.some((x) => x.id === dest)) return;
    setPicks((m) => ({ ...m, [row.key]: pickNext(chosen(row), dest, { exclusive: exclusiveFor(row) }) }));
  };
  act.current.solve = async (row) => {
    // ONE SOLVE PER PRODUCT AT A TIME, across both divisions: a Hub 1 and a
    // Hub 3 solve of the same shoe must not both plan from the same free stock.
    if (inFlight.current.has(row.pid) || !canAct || gone[row.key]) return;   // (a leaving card takes no second Solve)
    const sel = chosen(row);
    if (!sel.length) return;                                   // nothing chosen: nothing happens
    const c = ctx.current;
    // A product marked for the other division is never sent into this one.
    if (!listedForDivision(c.byId.get(row.pid), listKindOf(c.network, row.section))) {
      say({ ok: false, text: "This product belongs to the other division — nothing sent." });
      return;
    }
    // THE GATE AT SOLVE, whatever the card showed: this list's own locations,
    // never both of a one-or-the-other pair, never a location with nothing to
    // send. The hooks ask destinationProblem again of what they write.
    const kindOf = row.kind === "sneakers" ? "sneaker" : "product";
    let problem = sel.map((dest) => tapProblem({ row, dest })).find(Boolean)
      || destinationProblem({ network: c.network, section: row.section, destinations: sel, kind: kindOf });
    inFlight.current.add(row.pid);
    setBusy((b) => ({ ...b, [row.key]: true }));
    // ONE OWNER, CHECKED LIVE (Pine / Concrete): a stale screen — another
    // device solved it to the other shop a minute ago — must not write a
    // second shop. Read now, per product: stock and seat at the other shop,
    // and its queued requests.
    // WHICH DIVISION IT BELONGS TO, asked of the server now: a mark made on
    // another device a moment ago is never sent into the other division.
    if (!problem) {
      try {
        const live = await liveMarksOf(row.pid);
        const mark = live.concrete ? "concrete" : live.marathon ? "marathon" : null;
        if (mark && mark !== listKindOf(c.network, row.section)) problem = "This product belongs to the other division — nothing sent.";
      } catch (e) {
        problem = `Couldn't check which division this belongs to — nothing sent, retry. (${e?.message || "error"})`;
      }
    }
    if (!problem && row.kind === "clothing" && shopsAreExclusive(c.network, row.section)) {
      const shops = shopDestinations(c.network, row.section);
      try {
        const owners = await shopOwnersNow(row.pid, shops, (d) => !!ctx.current.openAt.get(row.pid)?.has(d));
        const other = owners.find((o) => !sel.includes(o));
        if (other) problem = `${c.label(other)} already has this — it is not sent to ${sel.map(c.label).join(" or ")} as well.`;
      } catch (e) {
        problem = `Couldn't check where this belongs — nothing sent, retry. (${e?.message || "error"})`;
      }
    }
    // The choice is judged again after the live read: what is sent is what is
    // chosen NOW (a location that left the card meanwhile is not sent to).
    if (!problem) {
      const cur = latestRows.current.get(row.key);
      if (!cur) problem = "This product changed while it was being checked — nothing sent.";   // (CodeRabbit, PR #966)
      else {
        const now = (latestPicks.current[row.key] || []).filter((d) => cur.dests.some((x) => x.id === d));
        if (now.length !== sel.length || now.some((d, i) => d !== sel[i])) problem = "The choice changed — check it and Solve again.";
      }
    }
    if (problem) {
      inFlight.current.delete(row.pid);
      setBusy((b) => { const n = { ...b }; delete n[row.key]; return n; });
      say({ ok: false, text: problem });
      return;
    }
    // ── ONE SOLVE OF A PRODUCT AT A TIME, ON EVERY DEVICE (Junid, 24 Nov 2026)
    // A short claim, taken in a transaction before anything is read: a second
    // person tapping Solve on the same product meanwhile is told so and sends
    // nothing. When the first solve's requests land, its units are owed — they
    // leave the second person's card through the request feed.
    const token = `${auth.currentUser?.uid || "anon"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const release = () => releaseSolveClaim(row.pid, token).catch(() => {});
    let claimed = false;
    try { claimed = await claimSolve(row.pid, token); } catch (e) { problem = `Couldn't check whether someone else is solving this — nothing sent, retry. (${e?.message || "error"})`; }
    if (!problem && !claimed) problem = "Someone else is solving this product right now — nothing sent. Look again in a moment.";
    // ── THE CARD'S NUMBER, CHECKED LIVE AT THE TAP ───────────────────────────
    // Central's cells (or the hub's, for a hub-fed card) and this product's
    // open requests, read now. If the figure the card was drawn from differs
    // in any size, nothing is sent: the card is redrawn on the live figure
    // and the person decides again.
    let expect = null, liveOpen = null;
    if (!problem) {
      try {
        const live = await readLiveProduct(row.source, row.pid);
        const routes = c.cfg?.routes || {};
        const fromCentral = row.source === c.central;
        const owedNow = fromCentral ? owedBySize(live.reqs, row.pid, { routes, central: c.central }) : {};
        const changed = figureChanged(row,
          { cells: c.allStock?.[row.source]?.[row.pid] || {}, owed: fromCentral ? owedBySize(c.requests, row.pid, { routes, central: c.central }) : {} },
          { cells: live.cells, owed: owedNow });
        if (changed) {
          if (fromCentral) setLiveFix((m) => ({ ...m, [row.pid]: { cells: live.cells, reqs: live.reqs, at: Date.now() } }));
          problem = `${row.sourceName} now has ${changed.now.total} free, not ${changed.was.total} — nothing sent. The card shows the live number; check it and Solve again.`;
        } else {
          // Solve may send ONLY what the card shows: the hooks refuse a plan
          // that differs from this, and plan from these same live requests.
          expect = Object.fromEntries(row.dests.filter((d) => sel.includes(d.id)).map((d) => [d.id, { units: d.units, sizes: d.sizes }]));
          liveOpen = live.reqs;
        }
      } catch (e) {
        problem = `Couldn't read the live stock — nothing sent, retry. (${e?.message || "error"})`;
      }
    }
    if (problem) {
      if (claimed) release();
      inFlight.current.delete(row.pid);
      setBusy((b) => { const n = { ...b }; delete n[row.key]; return n; });
      say({ ok: false, text: problem });
      return;
    }
    const api = apisRef.current[row.section];
    let res;
    try { res = row.kind === "sneakers" ? await api.sneaker.solveTo(row.card, sel[0], { expect: expect[sel[0]], liveRequests: liveOpen }) : await api.product.solveTo(row.card, sel, { expect, liveRequests: liveOpen }); }
    catch (e) { res = { ok: false, msg: `Nothing changed — retry. (${e?.message || "error"})` }; }
    finally { release(); }
    inFlight.current.delete(row.pid);
    setBusy((b) => { const n = { ...b }; delete n[row.key]; return n; });
    if (!res || !res.ok) { say({ ok: false, text: res?.msg || "Nothing was sent." }); return; }   // the card stays put, choice kept
    setGone((g) => ({ ...g, [row.key]: true }));
    setPicks((m) => { const n = { ...m }; delete n[row.key]; return n; });
    const what = res.units > 0 ? ` · ${res.units} ${row.kind === "sneakers" ? "pair" : "unit"}${res.units === 1 ? "" : "s"}` : "";
    say({
      ok: true, text: `${sel.map(c.label).join(" + ")}${what}`,
      undo: async function undoIt() {
        let out;
        if (row.kind === "sneakers") out = await undoSneakerRequest(res);
        else {
          out = { ok: true };
          for (const u of res.rows || []) {
            // eslint-disable-next-line no-await-in-loop
            const r = await apisRef.current[row.section].product.undoEntry(u);
            if (!r || !r.ok) { out = { ok: false, msg: r?.msg || "Not undone." }; break; }
          }
          if (!(res.rows || []).length) out = { ok: false, msg: "Nothing to undo." };
        }
        // A failure that can be retried keeps its Undo; a refusal (Central has
        // started) does not.
        if (out.ok) { back(row.key); say({ ok: true, text: "Undone" }); } else say({ ok: false, text: out.msg, ...(out.retry ? { undo: undoIt } : {}) });
      },
    });
  };
  // THE DIVISION BUTTON (Junid, 23 Nov 2026), where Hide was: it marks the
  // product for the OTHER division; the card leaves this list for good. Since
  // 24 Nov it takes two taps on the same button (MissingRow arms it, "Tap
  // again to move to …"); this runs on the second.
  // It writes the mark only (divisionMark.js) — no stock, seat or request.
  act.current.division = async (row) => {
    if (inFlight.current.has(row.pid) || !canMark || gone[row.key]) return;
    const c = ctx.current;
    const product = c.byId.get(row.pid);
    if (!product) return;
    const to = listKindOf(c.network, row.section) === "concrete" ? "marathon" : "concrete";
    const name = to === "concrete" ? "Concrete" : "Marathon";
    inFlight.current.add(row.pid);
    setBusy((b) => ({ ...b, [row.key]: "division" }));
    let res;
    try { res = await markDivision(product, to); } catch (e) { res = { ok: false, msg: `Nothing changed — retry. (${e?.message || "error"})` }; }
    inFlight.current.delete(row.pid);
    setBusy((b) => { const n = { ...b }; delete n[row.key]; return n; });
    if (!res.ok) { say({ ok: false, text: res.msg }); return; }
    setGone((g) => ({ ...g, [row.key]: true }));
    setPicks((m) => { const n = { ...m }; delete n[row.key]; return n; });
    say({
      ok: true, text: res.msg || `${name} only`,
      // A failed Undo changed nothing (one write), so it keeps its Undo to retry.
      undo: async function undoMark() {
        const r = await undoDivision(row.pid, to, res.prior);
        if (r.ok) { back(row.key); say({ ok: !r.msg, text: r.msg || "Back on the list" }); } else say({ ok: false, text: r.msg, undo: undoMark });
      },
    });
  };
  // "NOT LISTED" ACTIONS — only what this screen already writes elsewhere:
  // Unhide (the hidden tab's update) and Unmark (the division button's marks).
  // A policy or a seat is Junid's, on the Engine Policy card.
  act.current.notListed = async (action, row) => {
    if (nlInFlight.current.has(row.pid)) return;
    if (action === "policy") { onOpenEnginePolicy?.(); return; }
    const product = byId.get(row.pid);
    nlInFlight.current.add(row.pid);
    setNlBusy((b) => ({ ...b, [row.pid]: true }));
    let res;
    try {
      if (action === "unhide") { await update(ref(database), unhideUpdate([row.pid])); res = { ok: true, msg: "Unhidden" }; }
      else if (action === "unmark") {
        res = await clearDivision(product);
        if (res.ok && !res.already) {
          const prior = res.prior;
          res = { ...res, msg: res.msg || "Unmarked", undo: async function undoClear() { const r = await restoreMarks(row.pid, prior); say(r.ok ? { ok: !r.msg, text: r.msg || "Mark back" } : { ok: false, text: r.msg, undo: undoClear }); } };
        }
      }
      else res = { ok: false, msg: "Nothing to do here." };
    } catch (e) { res = { ok: false, msg: `Nothing changed — retry. (${e?.message || "error"})` }; }
    nlInFlight.current.delete(row.pid);
    setNlBusy((b) => { const n = { ...b }; delete n[row.pid]; return n; });
    say({ ok: !!res.ok, text: res.msg || (res.ok ? "Done" : "Nothing changed"), ...(res.undo ? { undo: res.undo } : {}) });
  };
  const onNotListed = useCallback((action, row) => act.current.notListed(action, row), []);
  const nlCan = useMemo(() => ({ unhide: canMark || permRecord?.stockRole === "store" || permRecord?.stockRole === "warehouse", unmark: canMark, policy: !!onOpenEnginePolicy }), [canMark, permRecord?.stockRole, onOpenEnginePolicy]);
  const onPick = useCallback((row, dest) => act.current.pick(row, dest), []);
  const onSolve = useCallback((row) => act.current.solve(row), []);
  const onDivision = useCallback((row) => act.current.division(row), []);
  const onPhoto = useCallback((p) => { const url = primaryPhotoUrl(p) || p?.photoUrl; if (url) setLightbox(url); }, []);

  // The hidden tab lists every hidden product against the cards still missing.
  const hiddenCards = useMemo(() => {
    const seen = new Set();
    return divisions.flatMap((s) => [...(walked[s]?.all || []), ...(walked[s]?.sneakers || []).map((c) => ({ ...c, units: c.centralUnits }))])
      .filter((c) => (seen.has(c.pid) ? false : (seen.add(c.pid), true)));
  }, [divisions, walked]);
  const hiddenCount = Object.keys(hiddenMap || {}).length;

  const box = (on, h) => ({
    height: h, borderRadius: 11, cursor: "pointer", fontFamily: FONT, textAlign: "center", padding: 0, WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
    border: on ? "1px solid rgba(60,110,255,.75)" : "1px solid rgba(255,255,255,.12)",
    background: on ? "rgba(60,110,255,.22)" : "rgba(255,255,255,.03)", color: on ? "#fff" : "rgba(255,255,255,.55)",
  });

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      {/* COMPACT (Junid, 23 Nov 2026): every row 40 px, 4 px apart — six whole
          cards on an iPhone where three and a half fitted. */}
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "4px 8px 120px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 40, marginBottom: 4 }}>
          <button data-action="exit" onClick={() => (view !== "list" ? setView("list") : onExit?.())}
            style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.25)", color: BLUE_L, borderRadius: 10, padding: "0 12px", height: 40, fontWeight: 700, fontSize: 13.5, cursor: "pointer", fontFamily: FONT, flexShrink: 0 }}>← Back</button>
          <div data-title style={{ fontSize: 17, fontWeight: 800, whiteSpace: "nowrap" }}>{view === "hidden" ? `Hidden (${hiddenCount})` : view === "notlisted" ? `Not listed · ${section != null ? sectionName(network, section) : ""}${notListed ? ` (${notListed.length})` : ""}` : "Missing Products"}</div>
          {/* The hidden tab's entrance: the unlabelled press-and-hold spot
              (HiddenProducts.jsx HoldSpot — discretion, not access control). */}
          <HoldSpot onTrigger={() => setView("hidden")} />
        </div>

        {/* Sticks just below the iPhone status bar in the installed app (the
            inset is 0 in a browser tab). */}
        <div style={{ position: "sticky", top: "env(safe-area-inset-top, 0px)", zIndex: 5, background: BG, paddingBottom: 4 }}>
          <div aria-label="Division" style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(divisions.length, 1)}, 1fr)`, gap: 6, marginBottom: 4 }}>
            {divisions.map((sec) => {
              const on = sec === section && view === "list";
              const n = countOf(sec);
              return (
                <button key={sec} aria-pressed={on} data-division={sec} onClick={() => { setPick(sec); setView("list"); }}
                  style={{ ...box(on, 40), display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 800, lineHeight: "18px" }}>{sectionName(network, sec)}</span>
                  {/* A fixed-width count box: the name never moves when the number arrives. */}
                  <span data-division-count={sec} style={{ fontSize: 13.5, fontWeight: 700, lineHeight: "18px", minWidth: 34, textAlign: "left", fontVariantNumeric: "tabular-nums", color: on ? BLUE_L : "rgba(255,255,255,.45)" }}>{n == null ? " " : n}</span>
                </button>
              );
            })}
          </div>
          <div aria-label="Kind" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {KINDS.map(([k, name]) => (
              <button key={k} aria-pressed={kind === k && view === "list"} data-kind={k} onClick={() => { setKind(k); setView("list"); }}
                style={{ ...box(kind === k && view === "list", 40), fontSize: 14.5, fontWeight: 800 }}>{name}</button>
            ))}
          </div>
          {/* ONE THIN SEARCH FIELD. Fixed 32 px whatever is typed; 16 px text so
              iOS does not zoom the page on focus; the clear control is laid
              over the field's right end, so it appears without moving anything. */}
          {view !== "hidden" && <div data-search style={{ position: "relative", height: 32, marginTop: 4 }}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="2.5" strokeLinecap="round"
              style={{ position: "absolute", left: 10, top: 9, pointerEvents: "none" }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input ref={searchRef} data-search-input type="text" inputMode="search" enterKeyHint="search" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
              aria-label="Search" placeholder="Search" value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); else if (e.key === "Enter") e.currentTarget.blur(); }}
              style={{ display: "block", width: "100%", height: 32, boxSizing: "border-box", margin: 0, padding: "0 40px 0 30px", borderRadius: 9, outline: "none",
                border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.03)", color: "#fff", fontFamily: FONT, fontSize: 16, lineHeight: "30px",
                WebkitAppearance: "none", appearance: "none" }} />
            {query && (
              <button type="button" data-action="clear-search" aria-label="Clear search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                style={{ position: "absolute", right: 0, top: -4, width: 40, height: 40, padding: 0, border: "none", background: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>
                <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 9, background: "rgba(255,255,255,.22)", color: "#000", fontSize: 13, fontWeight: 800, lineHeight: "18px", textAlign: "center" }}>×</span>
              </button>
            )}
          </div>}
        </div>

        {!divisions.length && <div style={{ padding: 18, color: GRAY, fontSize: 14 }}>No division is open to this account.</div>}

        {view === "hidden" && <HiddenProducts products={products} cards={hiddenCards} hiddenMap={hiddenMap} />}

        {view === "notlisted" && section != null && (
          requestsError
            ? <div data-read-failed style={{ height: CARD_H + CARD_GAP, display: "flex", alignItems: "center", justifyContent: "center", color: GRAY, fontSize: 15 }}>Couldn't read the refill queue</div>
            : notListed
            ? <NotListed rows={notListed} searching={terms.length > 0} byId={byId} can={nlCan} busy={nlBusy} onAct={onNotListed} limit={nlLimit} onMore={() => setNlLimit((n) => n + 200)} />
            : Array.from({ length: 6 }, (_, i) => <SkeletonRow key={i} />)
        )}

        {view === "list" && section != null && (
          <div data-list={active}>
            {requestsError
              ? (
                <div data-read-failed style={{ height: CARD_H + CARD_GAP, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, color: GRAY, fontSize: 15 }}>
                  Couldn't read the refill queue
                  <button type="button" data-action="retry" onClick={() => window.location.reload()}
                    style={{ ...box(false, 44), padding: "0 16px", fontSize: 15, fontWeight: 800 }}>Retry</button>
                </div>
              )
              : !sliced.complete[active]
              ? Array.from({ length: 6 }, (_, i) => <SkeletonRow key={i} />)
              : !display.length
                ? <div data-empty style={{ height: CARD_H + CARD_GAP, display: "flex", alignItems: "center", justifyContent: "center", color: GRAY, fontSize: 15 }}>Nothing to send</div>
                : !shown.length
                ? (
                  <div data-nothing-found style={{ height: CARD_H + CARD_GAP, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: GRAY, fontSize: 15 }}>
                    Nothing found
                    {/* The screen opens on Sneakers and the search stays on
                        when the tab changes: say where the matches are. */}
                    {otherFound > 0 && (
                      <button type="button" data-action="other-kind" onClick={() => setKind(otherKind)}
                        style={{ ...box(false, 40), padding: "0 14px", fontSize: 14, fontWeight: 800, color: BLUE_L }}>{otherFound} under {otherKindName}</button>
                    )}
                  </div>
                )
                : shown.slice(0, limit).map((d) => (
                  <React.Fragment key={d.key}>
                    <Slot leaving={d.leaving} entering={d.entering} data-slot={d.key}>
                      <MissingRow row={d.row} product={byId.get(d.row.pid)} twinProduct={d.row.twin ? byId.get(d.row.twin) : null}
                        selected={d.leaving ? NO_PICK : chosen(d.row)} busy={!!busy[d.key]} canAct={canAct} onPick={onPick} onSolve={onSolve} onPhoto={onPhoto}
                        divisionLabel={canMark ? (listKindOf(network, d.row.section) === "concrete" ? "Marathon" : "Concrete") : null} onDivision={onDivision} />
                    </Slot>
                  </React.Fragment>
                ))}
            {sliced.complete[active] && shown.length > limit && (
              <button ref={more} data-action="show-more" onClick={() => setShownN((m) => ({ ...m, [active]: limit + PAGE }))}
                style={{ ...box(false, 48), display: "block", width: "100%", fontSize: 14, fontWeight: 700 }}>More</button>
            )}
            {/* NOT LISTED — the very bottom of the list, small and secondary. */}
            {notListed && (shown.length <= limit) && !(terms.length && !notListed.length) && <NotListedLine n={notListed.length} onOpen={() => setView("notlisted")} />}
          </div>
        )}
      </div>

      {toast && (
        <div data-toast={toast.ok ? "ok" : "fail"} role="status" aria-live="polite"
          style={{ position: "fixed", left: 12, right: 12, bottom: "calc(16px + env(safe-area-inset-bottom, 0px))", zIndex: 60, maxWidth: 696, margin: "0 auto",
            display: "flex", alignItems: "center", gap: 12, minHeight: 56, padding: "8px 8px 8px 16px", borderRadius: 16, boxSizing: "border-box",
            background: "#10141f", border: `1px solid ${toast.ok ? "rgba(74,222,128,.55)" : "rgba(248,113,113,.6)"}`, boxShadow: "0 18px 50px -12px rgba(0,0,0,.9)", fontFamily: FONT }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 700, lineHeight: 1.3, color: toast.ok ? GREEN : RED }}>{toast.ok && toast.undo ? "✓ " : ""}{toast.text}</div>
          {toast.undo && (
            <button data-action="undo" onClick={() => {
              const u = toast.undo; setToast(null); clearTimeout(toastTimer.current);
              setUndoing((n) => n + 1);
              Promise.resolve().then(u).catch((e) => say({ ok: false, text: `Not undone — ${e?.message || "error"}` }))
                .finally(() => setUndoing((n) => n - 1));
            }}
              style={{ height: 44, padding: "0 18px", borderRadius: 12, background: "rgba(251,191,36,.12)", border: "1px solid rgba(251,191,36,.5)", color: AMBER, fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: FONT, flexShrink: 0 }}>Undo</button>
          )}
        </div>
      )}
      <PhotoLightbox url={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
