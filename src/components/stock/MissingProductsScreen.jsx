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
import { computeMissingProducts } from "./missingProductsCore";
import { computeMissingFootwear } from "./missingFootwearCore";
import { partitionQueued } from "./missingScreenCore";
import { openingOrder, openRequestsByProduct, openLocationsByProduct, isSeat, productRow, sneakerRow, createFrozenOrder, freezeOrder, tapProblem, shopOwners, pickNext } from "./missingListCore";
import { useSlicedRows } from "./useSlicedRows";
import { useProductSolve } from "./NetworkTransfer";
import { useSneakerRequest } from "./MissingFootwear";
import { shopDestinations, shopsAreExclusive, destinationProblem } from "./divisionDestinations";
import { otherMarathonHub, marathonHubSeated, marathonSolveRefusal, SEATS_PATH, DIVISION_SHOPS } from "./concreteDivision";
import { hideProduct, unhideProduct, undoSneakerRequest, shopOwnersNow } from "./missingActions";
import HiddenProducts, { HoldSpot } from "./HiddenProducts";
import { PhotoLightbox } from "./healthWidgets";
import MissingRow, { Slot, SkeletonRow, CARD_H, CARD_GAP, LEAVE_MS } from "./MissingRow";
import { primaryPhotoUrl } from "../../utils/primaryPhoto";
import { stockSizeKey } from "../../utils/sizeKey";
import { setUpdateBusy } from "../../update/updateChecker";

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

export default function MissingProductsScreen({ products = [], onExit }) {
  const { registry: network, sections: mySections } = useMySections();
  const allStock = useStockCells();
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
  const requests = useMemo(() => (reqState.value ? Object.entries(reqState.value).map(([id, r]) => ({ id, ...r })) : []), [reqState.value]);

  // Never count against a half-loaded /stock: a zero then would say "nothing
  // is missing" at the moment nothing is known.
  // Ready once the read has ANSWERED — an empty node included (CodeRabbit, PR #964).
  const stockState = usePathState("stock");
  // (A read that FAILED is not "nothing missing": the skeletons stay.)
  const stockReady = (stockState.settled && !stockState.error) || (!!allStock && Object.keys(allStock).length > 0);

  // ── WHAT IS MISSING, per division — the two cores, memoised on what they read.
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
      out[sec] = { all, sneakers, hubs };
    }
    return out;
  }, [divisions, stockReady, allStock, products, network, cfg, heldLines, CENTRAL]);

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
        hiddenMap={hiddenMap} requests={requests} requestsSettled={reqState.settled && seatsSettled} requestsError={!!reqState.error || seatsError} seats={seats} cfg={cfg} cfgSettled={cfgState.settled}
        heldLines={heldLines} stockReady={stockReady} walked={walked} cards={cards} central={CENTRAL} onExit={onExit} />
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
  const sneaker = useSneakerRequest({ products: shared.products, section, cards: shared.cards[section]?.sneakers || [], onQueued: NOOP, targets: shared.targetsState.value });
  box.current[section] = { product: product.api, sneaker: sneaker.api };
  const ready = !!(product.api.ready && sneaker.api.ready);
  const canAct = !!product.api.canAct;
  useEffect(() => { report(section, { ready, canAct }); }, [report, section, ready, canAct]);
  useEffect(() => () => { delete box.current[section]; }, [box, section]);
  return null;
}

function Body({ apis, flags, divisions, network, products, allStock, targets, hiddenMap, requests, requestsSettled, requestsError, seats, cfg, cfgSettled, heldLines, stockReady, walked, cards, central, onExit }) {
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [pick, setPick] = useState(null);
  const section = divisions.includes(pick) ? pick : divisions[0];
  const [kind, setKind] = useState("sneakers");
  const [view, setView] = useState("list");   // "list" | "hidden"
  const [lightbox, setLightbox] = useState(null);
  const active = bucketId(section, kind);
  const canAct = divisions.length ? !!flags[divisions[0]]?.canAct : false;

  const label = useCallback((loc) => SHORT[loc] || nameOf(loc, network), [network]);
  const reqByPid = useMemo(() => openRequestsByProduct(requests), [requests]);

  // ── THE ROWS: every card asked, before it is drawn, what a tap would send ──
  const apisRef = useRef(apis); apisRef.current = apis;
  const ctx = useRef(null);
  // Where each product has ANY open request (fully sent or not): ownership.
  const openAt = useMemo(() => openLocationsByProduct(requests), [requests]);
  ctx.current = { byId, allStock, targets: targets.value, reqByPid, openAt, cfg, network, central, label, seats };
  const buckets = useMemo(() => divisions.flatMap((sec) => [
    {
      id: bucketId(sec, "sneakers"), cards: cards[sec].sneakers,
      build: (card) => {
        const c = ctx.current, api = apisRef.current[sec].sneaker;
        const open = c.reqByPid.get(card.pid);
        return sneakerRow({
          card, section: sec, dests: api.destinations, planFor: api.planFor, blocked: !!api.notLive, central: c.central, nameOf: c.label,
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
        return productRow({
          card, section: sec, product: c.byId.get(card.pid), dests, tickable: api.tickableStores(card),
          planFor: api.planFor, openByLoc: open, allStock: c.allStock, central: c.central,
          routes: c.cfg?.routes, nameOf: c.label, owners,
        });
      },
    },
  ]), [divisions, cards]);

  const enginesReady = divisions.every((s) => flags[s]?.ready && apis[s]);
  // An UNREADABLE request queue is not an empty one: nothing would look
  // promised, so no list is built — the screen says so and offers a Retry.
  const ready = stockReady && requestsSettled && !requestsError && cfgSettled && targets.settled && enginesReady;
  // Anything a plan reads. A new identity means "work the rows out again".
  const version = useMemo(() => ({}), [buckets, allStock, requests, cfg, targets.value, heldLines, products, network, canAct, seats]);
  const sliced = useSlicedRows({ buckets, active, version, ready });

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
  // Shoes waiting for a policy sit together at the top, under one label.
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
  const display = [...inOrder.filter((d) => d.row.needsPolicy), ...inOrder.filter((d) => !d.row.needsPolicy)];
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
  }, [active, display.length > limit]);

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
      const cur = latestRows.current.get(row.key) || row;
      const now = (latestPicks.current[row.key] || []).filter((d) => cur.dests.some((x) => x.id === d));
      if (now.length !== sel.length || now.some((d, i) => d !== sel[i])) problem = "The choice changed — check it and Solve again.";
    }
    if (problem) {
      inFlight.current.delete(row.pid);
      setBusy((b) => { const n = { ...b }; delete n[row.key]; return n; });
      say({ ok: false, text: problem });
      return;
    }
    const api = apisRef.current[row.section];
    let res;
    try { res = row.kind === "sneakers" ? await api.sneaker.solveTo(row.card, sel[0]) : await api.product.solveTo(row.card, sel); }
    catch (e) { res = { ok: false, msg: `Nothing changed — retry. (${e?.message || "error"})` }; }
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
  act.current.hide = async (row) => {
    if (inFlight.current.has(row.pid) || !canAct) return;
    inFlight.current.add(row.pid);
    setBusy((b) => ({ ...b, [row.key]: "hide" }));
    const res = await hideProduct(row.pid);
    inFlight.current.delete(row.pid);
    setBusy((b) => { const n = { ...b }; delete n[row.key]; return n; });
    if (!res.ok) { say({ ok: false, text: res.msg }); return; }
    setGone((g) => ({ ...g, [row.key]: true }));
    say({ ok: true, text: "Hidden", undo: async () => { const r = await unhideProduct(row.pid); if (r.ok) { back(row.key); say({ ok: true, text: "Back on the list" }); } else say({ ok: false, text: r.msg }); } });
  };
  const onPick = useCallback((row, dest) => act.current.pick(row, dest), []);
  const onSolve = useCallback((row) => act.current.solve(row), []);
  const onHide = useCallback((row) => act.current.hide(row), []);
  const onPhoto = useCallback((p) => { const url = primaryPhotoUrl(p) || p?.photoUrl; if (url) setLightbox(url); }, []);

  // The hidden tab lists every hidden product against the cards still missing.
  const hiddenCards = useMemo(() => {
    const seen = new Set();
    return divisions.flatMap((s) => [...(walked[s]?.all || []), ...(walked[s]?.sneakers || []).map((c) => ({ ...c, units: c.centralUnits }))])
      .filter((c) => (seen.has(c.pid) ? false : (seen.add(c.pid), true)));
  }, [divisions, walked]);
  const hiddenCount = Object.keys(hiddenMap || {}).length;

  const box = (on, h) => ({
    height: h, borderRadius: 14, cursor: "pointer", fontFamily: FONT, textAlign: "center", padding: 0, WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
    border: on ? "1px solid rgba(60,110,255,.75)" : "1px solid rgba(255,255,255,.12)",
    background: on ? "rgba(60,110,255,.22)" : "rgba(255,255,255,.03)", color: on ? "#fff" : "rgba(255,255,255,.55)",
  });
  const firstNormal = display.findIndex((d) => !d.row.needsPolicy);
  const anyNeeds = display.some((d) => d.row.needsPolicy && !d.leaving);

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "12px 12px 120px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 44, marginBottom: 10 }}>
          <button data-action="exit" onClick={() => (view === "hidden" ? setView("list") : onExit?.())}
            style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.25)", color: BLUE_L, borderRadius: 11, padding: "0 14px", height: 44, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: FONT, flexShrink: 0 }}>← Back</button>
          <div data-title style={{ fontSize: 19, fontWeight: 800, whiteSpace: "nowrap" }}>{view === "hidden" ? `Hidden (${hiddenCount})` : "Missing Products"}</div>
          {/* The hidden tab's entrance: the unlabelled press-and-hold spot
              (HiddenProducts.jsx HoldSpot — discretion, not access control). */}
          <HoldSpot onTrigger={() => setView("hidden")} />
        </div>

        <div style={{ position: "sticky", top: 0, zIndex: 5, background: BG, paddingBottom: 10 }}>
          <div aria-label="Division" style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(divisions.length, 1)}, 1fr)`, gap: 8, marginBottom: 8 }}>
            {divisions.map((sec) => {
              const on = sec === section && view === "list";
              const n = countOf(sec);
              return (
                <button key={sec} aria-pressed={on} data-division={sec} onClick={() => { setPick(sec); setView("list"); }} style={box(on, 62)}>
                  <div style={{ fontSize: 16, fontWeight: 800, lineHeight: "20px" }}>{sectionName(network, sec)}</div>
                  <div data-division-count={sec} style={{ fontSize: 14, fontWeight: 700, lineHeight: "18px", height: 18, marginTop: 2, color: on ? BLUE_L : "rgba(255,255,255,.45)" }}>{n == null ? " " : n}</div>
                </button>
              );
            })}
          </div>
          <div aria-label="Kind" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {KINDS.map(([k, name]) => (
              <button key={k} aria-pressed={kind === k && view === "list"} data-kind={k} onClick={() => { setKind(k); setView("list"); }}
                style={{ ...box(kind === k && view === "list", 44), fontSize: 15, fontWeight: 800 }}>{name}</button>
            ))}
          </div>
        </div>

        {!divisions.length && <div style={{ padding: 18, color: GRAY, fontSize: 14 }}>No division is open to this account.</div>}

        {view === "hidden" && <HiddenProducts products={products} cards={hiddenCards} hiddenMap={hiddenMap} />}

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
                : display.slice(0, limit).map((d, i) => (
                  <React.Fragment key={d.key}>
                    {i === 0 && anyNeeds && <div data-needs-label style={{ height: 26, fontSize: 12.5, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: AMBER }}>Needs policy</div>}
                    {i === firstNormal && i > 0 && anyNeeds && <div aria-hidden="true" style={{ height: 14 }} />}
                    <Slot leaving={d.leaving} entering={d.entering} data-slot={d.key}>
                      <MissingRow row={d.row} product={byId.get(d.row.pid)} twinProduct={d.row.twin ? byId.get(d.row.twin) : null}
                        selected={d.leaving ? NO_PICK : chosen(d.row)} busy={!!busy[d.key]} canAct={canAct} onPick={onPick} onSolve={onSolve} onHide={onHide} onPhoto={onPhoto} />
                    </Slot>
                  </React.Fragment>
                ))}
            {sliced.complete[active] && display.length > limit && (
              <button ref={more} data-action="show-more" onClick={() => setShownN((m) => ({ ...m, [active]: limit + PAGE }))}
                style={{ ...box(false, 48), display: "block", width: "100%", fontSize: 14, fontWeight: 700 }}>More</button>
            )}
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
