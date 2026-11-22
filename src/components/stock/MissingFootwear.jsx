// ─── MISSING SNEAKERS — request workflow ──────────────────────────────────────
// The footwear sibling of NetworkTransfer.jsx, same idiom and same widgets:
//
//   photo · name · kind badge · units-at-Central badge
//   → per-size stepper chips (capped at Central's live stock)
//   → destination chips (Hub 1 / Hub 2)
//   → Request — raises /refill_requests into that hub's Source lane.
//
// NOTHING ON THIS SCREEN MOVES STOCK (owner, 2026-07-31). Both buttons raise a
// request and Central picks it through the normal Source queue. The old "Move"
// button applied a transfer_out the instant it was pressed, which shifted
// inventory with no picking step and no paper trail anyone was watching — it had
// to be reversed by hand twice on the day it shipped (3 units of Air Jordan 4,
// 10 of a Gucci platform). If a genuine immediate transfer is ever needed again
// it belongs behind its own explicitly-labelled control, not on this list.
//
// The two buttons differ only in WHERE THE NUMBER COMES FROM:
//   Solve   — the policy quantity for that hub (footwearSolvePlan).
//   Request — whatever the operator typed into the steppers (footwearPickPlan).
// Both share the same guard rails: free stock net of other hubs' reservations,
// no duplicate line for a size already open at that hub, short asks capped
// rather than refused.
//
// Deliberately a SIBLING rather than a `variant` prop on NetworkTransfer. That
// component runs the live clothing workflow; threading a second product class
// through its solve/qualifying/standard-run logic would put the working queue at
// risk to save duplication that is mostly JSX. Detection lives in
// missingFootwear.js and is shared with the Health stat card, so the count and
// this list can never disagree — the one thing the clothing pair does get wrong.
//
// TWO KINDS, TWO ACTION SETS:
//   NEVER INTRODUCED — no cell at either hub. Request AND Solve.
//   SOLD OUT         — a hub cell exists but is empty. Request only where there
//                      is nothing absent left to seed; Solve is offered ONLY for
//                      the sizes genuinely missing a cell. Seeding is
//                      seed-if-absent, so a blanket Solve here would write
//                      nothing and still report success.
//
// Rows clear when real units ARRIVE at a hub (the rule is unit-based). Neither
// button moves stock any more, so neither retires a card on its own — the card
// clears once Central actually picks the request and the units land.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ref, get, push, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { useStockCells, useStockHeld } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, FONT } from "./ui";
import { SizeFactChip, CHIP_GRID } from "./healthWidgets";
import MissingCard, { primaryBtn } from "./MissingCard";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";
import { serverNowIso } from "../../utils/serverTime";
import { footwearSolveReason, footwearConfirmReason } from "./actionReasons";
import { computeMissingFootwear, footwearSolvePlan, footwearPairPlan, sizeKeyOf } from "./missingFootwearCore";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { DIVISION_HUB, SNEAKER_SOLVE_HUBS, sneakerSolvePairAllowed, otherMarathonHub, marathonHubSeated, marathonSolveRefusal } from "./concreteDivision";
import { trustStamp } from "./stockTrust";
import { switchHubPick } from "./hubChooser";
import { partitionQueued, whySneaker, brandOf, categoryLabelOf } from "./missingScreenCore";
import { sneakerDestinations, destinationProblem } from "./divisionDestinations";

// (The typed-quantity request — your own sizes and numbers — was switched off
// on 1 Nov 2026: the scan is the only requester. Its button, panel and writer
// were dead weight on the card and are gone. What remains raises the POLICY
// quantity, and is what the card calls Request.)
import { isDeactivated } from "../../utils/deactivation";
import { FOOTWEAR_OWN_NUMBERS_KEYS } from "../../utils/footwearLine.js";
import { useRefillRequests } from "./useStock";
import { readPathOnce } from "../../offline/localReads";
import { stampRecord } from "../../device/deviceStamp";
import { useMySections } from "../../utils/useMySections";
import { hubIds, liveSections, centralId, nameOf } from "./sectionRouting";
import { policyKeyFor, sectionName } from "../../utils/networkRegistry";

// THE HUBS COME FROM THE NETWORK REGISTRY, ONE SECTION AT A TIME (see the
// component): DETECTION scope is that section's hubs — "missing" = zero units
// at every one of them (Hub 1 and Hub 2 for Section 2, as this list always
// read; Hub 3 and the Concrete Stockroom for Section 1).
// Where a human may RAISE a line. HUB 1 IS BACK (owner order 2026-08-26,
// reversing the 2026-08-25 single-path narrowing FOR THIS SURFACE ONLY):
// Missing Products seeds both hubs again, like before — the owner's picks
// here are deliberate introductions, not the reactive noise the single-path
// decision silenced. The Tomorrow writer and sale-driven rows stay hub2-only
// (see reactiveRefillHubs.js); the engine treats an open human hub1 row as
// inbound, so no cell is ever double-asked.
// REQUESTABLE = that section's hubs with SOLVE on (Network card). A hub with
// Solve off is shown in the card's facts but takes no Solve from here.
// Solve raises work into a hub's refill queue. Both hubs have one: the queue
// component is now destination-parameterised (it was hub2-only because CLOTHING
// is not kept at Hub 1, not because Hub 1 lacks refills — sneakers make Hub 1 the
// bigger buffer at 3,967 units vs Hub 2's 3,288).
// How long a card this device has just queued stays off the list before the
// live request records alone decide (their echo is normally 1–2 s).
const QUEUED_HOLD_MS = 90000;
// A destination pill: a full-size tap target that plainly reads on or off.
const bigPill = (on) => ({
  minHeight: 46, padding: "10px 20px", borderRadius: 999, fontSize: 14.5, fontWeight: 800, cursor: "pointer", fontFamily: FONT,
  border: on ? "1px solid rgba(60,110,255,.7)" : "1px solid rgba(255,255,255,.16)",
  background: on ? "rgba(60,110,255,.24)" : "rgba(255,255,255,.03)",
  color: on ? "#fff" : "rgba(255,255,255,.55)",
});

const destChip = (on) => ({
  padding: "8px 13px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
  border: on ? "1px solid rgba(60,110,255,.55)" : "1px solid rgba(255,255,255,.1)",
  background: on ? "rgba(60,110,255,.15)" : "rgba(255,255,255,.03)",
  color: on ? BLUE_L : "rgba(255,255,255,.5)",
});

// THE LOGIC, AS A HOOK (Junid, 22 Nov 2026). The Missing Products screen lists
// sneakers and everything else in ONE list per division, so this component's
// body is a hook that hands back its cards and a way to draw each one; the
// screen interleaves them with NetworkTransfer's. Everything that decides what
// is raised is exactly where it was — only who calls the render changed.
//   section   the division list being shown (controlled by the screen). Absent
//             ⇒ this list keeps its own switch (the stand-alone list, below).
//   cards     that division's cards, already less the queued (the screen
//             builds them once, for the counts and the list alike). Absent ⇒
//             built here.
//   onQueued  told (pid, hubs, message) the moment a request has been written.
//   targets   /stock_targets as the screen already holds it (optional). See
//             `withRows` below: a per-product target row Junid has set at a
//             hub fills the sizes the footwear run does not name.
export function useSneakerRequest({ products = [], section: sectionProp = null, cards: cardsProp = null, onQueued = null, onPhoto = null, targets = null } = {}) {
  const allStock = useStockCells();                 // live — a card clears when units land
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canAct = ["store", "warehouse", "admin"].includes(actorRole);

  const [solvePid, setSolvePid] = useState(null);
  const [solveBusy, setSolveBusy] = useState(null);
  const [solveHub, setSolveHub] = useState({});   // pid → the hub pills lit (absent = this list's first hub)
  const [solved, setSolved] = useState({});

  // ── WHICH SECTION'S SNEAKERS ───────────────────────────────────────────────
  // A section's list is its OWN stranded stock: shoes Central holds that none
  // of that section's hubs do. The default is the first section with a live
  // store (Section 2 on the registry's seed — the list this screen always
  // showed); a viewer who may see the other section gets a switch to it.
  const { registry: network, sections: mySections } = useMySections();
  const sectionChoices = useMemo(
    () => [...liveSections(network), ...[1, 2]].filter((s, i, a) => a.indexOf(s) === i && mySections.includes(s) && hubIds(network, { section: s }).length > 0),
    [network, mySections],
  );
  const [sectionPick, setSectionPick] = useState(null);
  const section = sectionProp || (sectionPick && sectionChoices.includes(sectionPick) ? sectionPick : (sectionChoices[0] ?? 2));
  const HUBS = useMemo(() => hubIds(network, { section }), [network, section]);
  const REQUESTABLE_HUBS = useMemo(() => hubIds(network, { section, solveOnly: true }), [network, section]);
  // Hubs a person may raise their OWN request for: every hub of the section,
  // live or not. On Section 2 this is the same list as REQUESTABLE_HUBS.
  // Central's shelf is shared by both sections, so what is already promised
  // out of it is counted across this section's hubs AND every other hub that
  // anything routes to (Solve or Auto-refill on).
  const RESERVING_HUBS = useMemo(() => [...new Set([...HUBS, ...hubIds(network, { solveOnly: true }), ...hubIds(network, { autoRefillOnly: true })])], [HUBS, network]);
  const CENTRAL = centralId(network);
  const LOC_LABEL = useMemo(() => Object.fromEntries([...HUBS, CENTRAL].map((l) => [l, nameOf(l, network)])), [HUBS, CENTRAL, network]);
  const notLive = REQUESTABLE_HUBS.length === 0
    ? `Solve is off for ${HUBS.map((h) => nameOf(h, network)).join(" and ")} (Network card).`
    : null;

  // The footwear standard, read ONCE. Absent until footwear targeting is
  // configured — Solve stays disabled until then rather than seeding cells the
  // engine would never refill.
  const [footwearRun, setFootwearRun] = useState(null);
  const [hub3Leg, setHub3Leg] = useState(null);   // the footwear group's Hub 3 leg: keep per declared size
  // Have the two policy reads ANSWERED (value or not)? The one-tap screen
  // draws no button until they have — a card must never light up, or drop
  // out, a moment after it was shown.
  const [policyRead, setPolicyRead] = useState({ run: false, hub3: false, own: false });
  // KIDS SHOES' OWN NUMBERS (Junid, 22 Nov 2026 — policy-resolve.cjs
  // FOOTWEAR_OWN_NUMBERS_KEYS): the one footwear category the Engine Policy
  // card may give numbers of its own. One small node per such category.
  const [ownPolicy, setOwnPolicy] = useState({});
  const [ownPolicyErr, setOwnPolicyErr] = useState(false);   // a failed read is not "no policy"
  const allRequests = useRefillRequests();
  useEffect(() => {
    let alive = true;
    get(ref(database, "config/refillEngine/footwearRunByLocation"))
      .then((s) => { if (alive) setFootwearRun(s.val() || null); })
      .catch(() => { /* leave null — Solve disabled, Request unaffected */ })
      .finally(() => { if (alive) setPolicyRead((r) => ({ ...r, run: true })); });
    Promise.all(FOOTWEAR_OWN_NUMBERS_KEYS.map((k) => get(ref(database, `config/refillEngine/categoryPolicy/${k}`)).then((s) => [k, s.val() || null], () => { if (alive) setOwnPolicyErr(true); return [k, null]; })))
      .then((pairs) => { if (alive) setOwnPolicy(Object.fromEntries(pairs)); })
      .finally(() => { if (alive) setPolicyRead((r) => ({ ...r, own: true })); });
    get(ref(database, "config/refillEngine/policyGroups/footwear-all/policy/hub3"))
      .then((s) => { if (alive) setHub3Leg(s.val() || null); })
      .catch(() => { /* leave null — Hub 3 offers nothing to raise */ })
      .finally(() => { if (alive) setPolicyRead((r) => ({ ...r, hub3: true })); });
    return () => { alive = false; };
  }, []);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // Held (parked-box) units count as hub stock — a fully-in-transit product is
  // not missing, and a Solve on it would double-send (count-integrity hold lane).
  const heldLines = useStockHeld();
  const cardsAll = useMemo(
    // (not walked when the screen hands the cards in)
    () => (cardsProp ? [] : computeMissingFootwear({ allStock, products, hubs: HUBS, heldLines, central: CENTRAL })),
    [allStock, products, heldLines, HUBS, CENTRAL, cardsProp],
  );
  // QUEUED AT CENTRAL → OFF THIS DIVISION'S LIST (missingScreenCore.js). A card
  // whose request from this screen is still open at one of THIS division's
  // hubs has been dealt with; it returns if the request is cancelled or
  // rejected before stock moves. `justQueued` covers the moment between this
  // device's own write and its echo, per hub, so the other division's list
  // keeps the card. Display only — no request is read differently or written.
  const [justQueued, setJustQueued] = useState({});   // `${hub}|${pid}` → true
  const queueTimers = useRef({});
  useEffect(() => () => { for (const t of Object.values(queueTimers.current)) clearTimeout(t); }, []);
  const noteQueued = (pid, hubs, msg) => {
    if (onQueued) { onQueued(pid, hubs, msg); return; }   // the screen owns the list: it drops the card and keeps the note
    setJustQueued((m) => ({ ...m, ...Object.fromEntries(hubs.map((h) => [`${h}|${pid}`, true])) }));
    for (const h of hubs) {
      const k = `${h}|${pid}`;
      clearTimeout(queueTimers.current[k]);
      // The backstop: the live requests are the truth once they have echoed.
      queueTimers.current[k] = setTimeout(() => setJustQueued((m) => { const n = { ...m }; delete n[k]; return n; }), QUEUED_HOLD_MS);
    }
  };
  const { todo: ownCards, waiting } = useMemo(
    () => partitionQueued(cardsProp ? [] : cardsAll, allRequests, HUBS,
      Object.fromEntries(Object.keys(justQueued).filter((k) => HUBS.includes(k.split("|")[0])).map((k) => [k.split("|").slice(1).join("|"), true]))),
    [cardsAll, cardsProp, allRequests, HUBS, justQueued],
  );
  const cards = cardsProp || ownCards;

  const catalogSizes = (pid) => (byId.get(pid)?.sizes || []).map(String).filter((s) => s && s !== "_");

  // THE CHOOSER OFFERS THIS LIST'S OWN HUBS AND NO OTHERS (Junid, 22 Nov 2026 —
  // divisionDestinations.js): Hub 1 and Hub 2 on "Missing from Marathon", Hub 3
  // on "Missing from Concrete". A sneaker wanted in both divisions is requested
  // once from each list. (It used to offer all three hubs on every card.)
  const SOLVE_HUBS = useMemo(() => sneakerDestinations(network, section), [network, section]);
  // Untouched, the panel opens on this list's own first hub. Once a pill has
  // been tapped the selection is exactly what was tapped — an EMPTY selection
  // included, so turning the last pill off never re-lights a default behind
  // the finger (that would be a pill that looks dead).
  const solveHubsOf = (card) => {
    const stored = solveHub[card.pid];
    if (stored === undefined) return REQUESTABLE_HUBS.slice(0, 1);
    return stored.filter((h) => SOLVE_HUBS.includes(h));
  };
  const hubFor = (card) => solveHubsOf(card)[0];
  const openAtHub = (requests, hub, pid) => (requests || []).some((r) => r && r.status === "open" && !r.shadow && r.requestingLocation === hub && r.productId === pid);
  // Hub 1 and Hub 2 never share a sneaker, across separate Solves too: the live
  // cells and target rows of the OTHER hub, read when the Solve is tapped.
  const seatRefusal = async (pid, hubs, requests) => {
    for (const h of hubs) {
      const other = otherMarathonHub(h);
      if (!other) continue;
      // eslint-disable-next-line no-await-in-loop
      const [cells, rows] = await Promise.all([get(ref(database, `stock/${other}/${pid}`)), get(ref(database, `stock_targets/${other}/${pid}`))]);
      if (marathonHubSeated({ cells: cells.val(), rows: rows.val(), openRequest: openAtHub(requests, other, pid) })) return marathonSolveRefusal(h);
    }
    return null;
  };
  // A TAP ALWAYS CHANGES THE SELECTION (Junid, 22 Nov 2026 — hubChooser.js):
  // Hub 1 and Hub 2 switch each other off, Hub 3 toggles on its own. The old
  // version refused the tap when the result was not allowed, which left the
  // pill dead under the finger.
  const togglePick = (card, hub) => {
    setSolveHub((d) => ({ ...d, [card.pid]: switchHubPick(solveHubsOf(card), hub) }));
  };
  // Why this selection cannot be confirmed as it stands — said on the panel,
  // never by ignoring the tap. Units and open requests only, here: this screen
  // has no target rows, so a zero cell (which may be switched off) is left for
  // Confirm, which reads them live (seatRefusal).
  const pickRefusal = (card, hubs) => {
    for (const h of hubs) {
      const other = otherMarathonHub(h);
      if (!other) continue;
      const seated = marathonHubSeated({
        cells: Object.fromEntries(Object.entries(allStock?.[other]?.[card.pid] || {}).filter(([, c]) => Number(c?.qty) > 0)),
        openRequest: openAtHub(allRequests, other, card.pid),
      });
      if (seated) return marathonSolveRefusal(h);
    }
    return null;
  };
  // Units already promised to ANY hub for this product. Central's shelf count is
  // not free stock: two hubs solving the same shoe would otherwise each claim it.
  const reservedFor = (pid, requests) => (requests || [])
    .filter((r) => r && r.status === "open" && r.productId === pid && RESERVING_HUBS.includes(r.requestingLocation))
    .reduce((acc, r) => {
      // sizeKeyOf, NOT encodeSizeKey: the plan keys `reserved` with sizeKeyOf,
      // which trims before encoding. encodeSizeKey does not, so a size stored as
      // " 8" would be written here as "_8" and looked up as "8" — the reservation
      // would silently not be found and the units double-promised. One encoder on
      // both sides is the only way these can't drift. (CodeRabbit #291.)
      const k = sizeKeyOf(r.size);
      acc[k] = (acc[k] || 0) + (Number(r.qty) || 0);
      return acc;
    }, {});
  const openSizesFor = (pid, hub) => (allRequests || [])
    .filter((r) => r && r.status === "open" && r.requestingLocation === hub && r.productId === pid)
    .map((r) => r.size);

  // The hub's footwear run — its own, or (the same policy for every hub
  // unless it has its own) the run of the hub it is declared to be like.
  // Hub 3 keeps its own number per declared size (the group's Hub 3 leg).
  const runFor = (card, hub) => (hub === DIVISION_HUB
    ? (hub3Leg?.target > 0 ? Object.fromEntries(catalogSizes(card.pid).map((s) => [sizeKeyOf(s), hub3Leg.target])) : {})
    : withRows(runAt(hub), card, hub));
  const runAt = (hub) => footwearRun?.[policyKeyFor(network, footwearRun, hub)] || {};
  // A PER-PRODUCT TARGET ROW FILLS WHAT THE RUN DOES NOT NAME (Junid, 22 Nov
  // 2026). The footwear run is adult sizes; a kids shoe (24–35) has no entry
  // in it, so a Request computed nothing to raise although Central held 30
  // pairs — and said "already queued", which was never true. Where Junid has
  // set a target row for this product at this hub (/stock_targets, the Engine
  // Policy override), that row IS the policy for the sizes the run is silent
  // on. A size the run names keeps the run's number, exactly as before; with
  // no row, and for every caller that passes no `targets`, nothing changes.
  // After the row, a category entry of its OWN (Kids Shoes only) — the
  // engine's order: explicit row first, then the category's policy.
  // KIDS SHOES ONLY: an adult shoe's request is exactly what it always was,
  // whatever rows it has for sizes the run does not name (Sonnet architect
  // review, PR #964 — that would change adult request quantities).
  const withRows = (run, card, hub) => {
    if (!FOOTWEAR_OWN_NUMBERS_KEYS.includes(effectiveCategoryKey(byId.get(card.pid)))) return run;
    const rows = targets?.[hub]?.[card.pid];
    const own = ownPolicy[effectiveCategoryKey(byId.get(card.pid))]?.[hub];
    if ((!rows || typeof rows !== "object") && (!own || typeof own !== "object")) return run;
    let out = run;
    for (const s of catalogSizes(card.pid)) {
      const k = sizeKeyOf(s);
      if (k in run) continue;
      const row = Number(rows?.[k]?.target);
      const pol = own && typeof own === "object" ? Number(own.sizes && typeof own.sizes === "object" ? own.sizes[k]?.target : own.target) : NaN;
      const t = rows?.[k] && Number.isFinite(row) ? row : pol;
      if (!(t > 0)) continue;
      if (out === run) out = { ...run };
      out[k] = t;
    }
    return out;
  };
  // `requests` (optional): the LIVE request read a write makes — so a size
  // someone queued since the render is never raised twice (CodeRabbit, PR #964).
  const planFor = (card, hub = hubFor(card), requests = null) => footwearSolvePlan({
    catalogSizes: catalogSizes(card.pid),
    policy: runFor(card, hub),
    centralCells: allStock?.[CENTRAL]?.[card.pid] || {},
    openSizes: requests ? (requests || []).filter((r) => r && r.status === "open" && r.requestingLocation === hub && r.productId === card.pid).map((r) => r.size) : openSizesFor(card.pid, hub),
    reserved: reservedFor(card.pid, requests || allRequests),
  });
  // One line list per picked hub. A single hub is the plan it always was.
  const planOf = (card, hubs, requests = allRequests) => {
    if (hubs.length < 2) return { [hubs[0]]: planFor(card, hubs[0], requests === allRequests ? null : requests) };
    return footwearPairPlan({
      catalogSizes: catalogSizes(card.pid), hubs,
      policies: Object.fromEntries(hubs.map((h) => [h, runFor(card, h)])),
      centralCells: allStock?.[CENTRAL]?.[card.pid] || {},
      openSizes: Object.fromEntries(hubs.map((h) => [h, (requests || []).filter((r) => r && r.status === "open" && r.requestingLocation === h && r.productId === card.pid).map((r) => r.size)])),
      reserved: reservedFor(card.pid, requests),
      marathonHub: hubs.find((h) => h !== DIVISION_HUB),
    });
  };

  // SOLVE = raise the day's work, not a silent ledger move. One /refill_requests
  // row per size, in the shape the engine writes, so the lines land in the
  // existing Source -> Hub 2 queue and close through its normal fulfil path.
  // Stock does NOT move here — Central staff pick it size by size from that queue.
  // `only` (Junid, 22 Nov 2026 — one-tap): the Missing Products card names its
  // ONE hub itself; there is no panel and no pill state. Every gate below is
  // the same, and what is planned and raised for that hub is exactly what the
  // panel's confirm raised with that one pill lit. Several cards may be tapped
  // in a row, so a one-tap call does not wait behind another card's write (the
  // screen allows one call per card). The outcome is also RETURNED —
  // { ok, msg, hubs, units, requestIds, seedPaths, seat } — for the toast and
  // its Undo.
  const solve = async (card, only = null) => {
    const picked = only || solveHubsOf(card);
    // THE SECOND GATE (divisionDestinations.js): whatever a chooser showed —
    // a stale screen included — nothing is raised for a hub outside this
    // list's division, nor for Hub 1 and Hub 2 together.
    const wrong = destinationProblem({ network, section, destinations: picked, kind: "sneaker" });
    if (wrong) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: `Nothing raised — ${wrong}` } }));
      return { ok: false, msg: `Nothing raised — ${wrong}` };
    }
    const hub = picked[0];
    if (picked.length > 1 || picked.includes(DIVISION_HUB)) return solveDivision(card, picked, !!only);
    const lines = planFor(card, hub);
    if ((solveBusy && !only) || !canAct || !lines.length || !REQUESTABLE_HUBS.includes(hub)) {   // guarded by the disabled button
      return { ok: false, msg: !canAct ? "You need a stock role to raise requests." : "Nothing to raise there." };
    }
    // A stale screen can hold a card deactivated since render — never raise a
    // request for a finished line (the row itself is filtered in the core).
    if (isDeactivated(byId.get(card.pid))) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: "This product was deactivated — no refills are raised for it." } }));
      return { ok: false, msg: "This product was deactivated — no refills are raised for it." };
    }
    setSolveBusy(card.pid);
    const now = serverNowIso();
    let outcome;
    try {
      // Re-read live so a size queued by someone else between render and click is
      // not raised twice; the plan is recomputed against it rather than trusted.
      const liveRequests = Object.values((await readPathOnce("refill_requests",
        async () => (await get(ref(database, "refill_requests"))).val())) || {});
      const refused = await seatRefusal(card.pid, [hub], liveRequests);
      if (refused) {
        setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: refused } }));
        setSolveBusy(null);
        return { ok: false, msg: refused };
      }
      const liveOpen = liveRequests
        .filter((r) => r && r.status === "open" && r.requestingLocation === hub && r.productId === card.pid)
        .map((r) => r.size);
      const fresh = footwearSolvePlan({
        catalogSizes: catalogSizes(card.pid),
        policy: runFor(card, hub),   // = runAt(hub) unless a target row fills a size the run does not name
        centralCells: allStock?.[CENTRAL]?.[card.pid] || {},
        openSizes: liveOpen,
        // Recomputed from the SAME fresh read, so a sibling hub's request raised
        // between render and click is subtracted too. Two people clicking in the
        // same instant can still overlap — closing that needs a server-side
        // transaction, which this deliberately does not attempt.
        reserved: reservedFor(card.pid, liveRequests),
      });
      if (!fresh.length) {
        setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: `Already queued at ${LOC_LABEL[hub]} — nothing new to raise.` } }));
        outcome = { ok: false, msg: `Already queued at ${LOC_LABEL[hub]} — nothing new to raise.` };
      } else {
        // ONE atomic multi-path write: a partial failure would leave some sizes
        // queued and no way to tell which, so all lines land together or none do.
        const updates = {};
        for (const l of fresh) {
          const id = push(ref(database, "refill_requests")).key;
          updates[`refill_requests/${id}`] = {
            productId: card.pid,
            size: l.size,
            qty: l.qty,
            requestingLocation: hub,
            status: "open",
            createdAt: now,
            createdFrom: { manual: true, source: CENTRAL, via: "missing_sneakers" },
            requestSource: "solve",
          };
          updates[`refill_requests/${id}`] = stampRecord(updates[`refill_requests/${id}`], "raise");
        }
        await update(ref(database), updates);
        const short = fresh.filter((l) => l.qty < l.want);
        const okMsg = `Requested ${fresh.length} size${fresh.length === 1 ? "" : "s"} (${fresh.map((l) => `${l.size}\u00d7${l.qty}`).join(" · ")}) into ${LOC_LABEL[hub]}'s refill list`
              + (short.length ? ` — ${short.map((l) => `${l.size} short (${l.avail} at Central, wanted ${l.want})`).join(", ")}` : "")
              + ". Central picks it as part of today's work.";
        setSolved((d) => ({ ...d, [card.pid]: { ok: true, msg: okMsg } }));
        setSolvePid((cur) => (cur === card.pid ? null : cur));
        noteQueued(card.pid, [hub], okMsg);
        outcome = { ok: true, msg: okMsg, hubs: [hub], units: fresh.reduce((t, l) => t + l.qty, 0), requestIds: Object.keys(updates).map((k) => k.split("/")[1]), seedPaths: [], seat: null };
      }
    } catch (e) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: `Couldn't raise the request — nothing changed, retry. (${e?.message || "error"})` } }));
      outcome = { ok: false, msg: `Couldn't raise the request — nothing changed, retry. (${e?.message || "error"})` };
    }
    setSolveBusy(null);
    return outcome;
  };

  // A SOLVE THAT NAMES HUB 3 (alone or in an allowed pair). The Marathon hub's
  // single-hub Solve above is untouched: its rows carry nothing new.
  const solveDivision = async (card, hubs, oneTap = false) => {
    if ((solveBusy && !oneTap) || !canAct || !sneakerSolvePairAllowed(hubs)) return { ok: false, msg: !canAct ? "You need a stock role to raise requests." : "Nothing to raise there." };
    if (destinationProblem({ network, section, destinations: hubs, kind: "sneaker" })) return { ok: false, msg: "Not a destination on this list." };   // solve() has already said why
    if (isDeactivated(byId.get(card.pid))) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: "This product was deactivated — no refills are raised for it." } }));
      return { ok: false, msg: "This product was deactivated — no refills are raised for it." };
    }
    setSolveBusy(card.pid);
    const now = serverNowIso();
    const solveId = `sn_${card.pid}_${Date.parse(now)}`;
    let seat = null, seated = false;
    let outcome;
    try {
      const liveRequests = Object.values((await readPathOnce("refill_requests",
        async () => (await get(ref(database, "refill_requests"))).val())) || {});
      const refused = await seatRefusal(card.pid, hubs, liveRequests);
      if (refused) {
        setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: refused } }));
        setSolveBusy(null);
        return { ok: false, msg: refused };
      }
      const plan = planOf(card, hubs, liveRequests);
      if (!hubs.some((h) => (plan[h] || []).length)) {
        setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: `Already queued, or Central has none free — nothing new to raise.` } }));
        setSolveBusy(null);
        return { ok: false, msg: "Already queued, or Central has none free — nothing new to raise." };
      }
      seat = httpsCallable(functions, "seatDivisionSolve");
      if (hubs.includes(DIVISION_HUB)) { await seat({ location: DIVISION_HUB, pid: card.pid, hubs, solveId }); seated = true; }
      const updates = {};
      const paired = hubs.length > 1 ? { solveHubs: hubs } : {};
      for (const h of hubs) {
        for (const l of plan[h] || []) {
          const id = push(ref(database, "refill_requests")).key;
          updates[`refill_requests/${id}`] = stampRecord({
            productId: card.pid, size: l.size, qty: l.qty, requestingLocation: h, status: "open", createdAt: now,
            createdFrom: { manual: true, source: CENTRAL, via: "missing_sneakers", ...paired, ...(h === DIVISION_HUB ? { divisionSolve: true } : {}) },
            requestSource: "solve",
          }, "raise");
        }
      }
      // Hub 3 is seeded for every declared size, so the scan can keep them.
      if (hubs.includes(DIVISION_HUB)) {
        const row = (await get(ref(database, `stock/${DIVISION_HUB}/${card.pid}`))).val() || {};
        for (const s of catalogSizes(card.pid)) {
          const k = sizeKeyOf(s);
          if (row[k] !== undefined) continue;
          updates[`stock/${DIVISION_HUB}/${card.pid}/${k}`] = { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: now, updatedBy: auth.currentUser?.uid || null, ...trustStamp("solve", now) };
        }
      }
      await update(ref(database), updates);
      const okMsg = `Requested ${hubs.map((h) => `${(plan[h] || []).reduce((t, l) => t + l.qty, 0)} for ${nameOf(h, network)}`).join(" and ")}. Central picks it as part of today's work.`;
      setSolved((d) => ({ ...d, [card.pid]: { ok: true, msg: okMsg } }));
      setSolvePid((cur) => (cur === card.pid ? null : cur));
      noteQueued(card.pid, hubs.filter((h) => (plan[h] || []).length), okMsg);
      outcome = {
        ok: true, msg: okMsg, hubs, units: hubs.reduce((t, h) => t + (plan[h] || []).reduce((n, l) => n + l.qty, 0), 0),
        requestIds: Object.keys(updates).filter((k) => k.startsWith("refill_requests/")).map((k) => k.split("/")[1]),
        seedPaths: Object.keys(updates).filter((k) => k.startsWith("stock/")),
        seat: seated ? { location: DIVISION_HUB, pid: card.pid, solveId } : null,
      };
    } catch (e) {
      // The seat this Solve claimed is cleared before "nothing changed" is said;
      // if it cannot be, the message says so (CodeRabbit, PR #964).
      let seatLeft = false;
      if (seated) { try { await seat({ location: DIVISION_HUB, pid: card.pid, clear: true, solveId }); } catch { seatLeft = true; } }
      const msg = seatLeft
        ? `Couldn't raise the request, and Hub 3's seat for it could not be cleared — retry to finish. (${e?.message || "error"})`
        : `Couldn't raise the request — nothing changed, retry. (${e?.message || "error"})`;
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg } }));
      outcome = { ok: false, msg };
    }
    setSolveBusy(null);
    return outcome;
  };

  // The section switch — only for the stand-alone list (the screen has its own).
  const sectionSwitch = !sectionProp && sectionChoices.length > 1 ? (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
      {sectionChoices.map((s) => (
        <button key={s} data-division={s} onClick={() => { setSectionPick(s); setSolvePid(null); }} style={destChip(section === s)}>
          Missing from {sectionName(network, s)}
        </button>
      ))}
    </div>
  ) : null;

  // What was just queued — the card has left the list, so its confirmation is
  // said here (it used to sit on a card that never went away).
  const queuedStrip = !sectionProp && waiting.length > 0 ? (
    <div data-queued-strip style={{ ...GLASS, padding: "9px 12px", marginBottom: 10, fontSize: 12, color: "rgba(255,255,255,.75)" }}>
      <b style={{ color: GREEN }}>{waiting.length} queued at Central</b> — off this list until Central picks {waiting.length === 1 ? "it" : "them"}; back here if a request is cancelled.
      {waiting.filter((w) => solved[w.card.pid]?.ok).map((w) => (
        <div key={w.card.pid} style={{ marginTop: 5, color: GRAY }}><b style={{ color: "#fff" }}>{w.card.name}</b>: {solved[w.card.pid].msg}</div>
      ))}
    </div>
  ) : null;

  const hubNames = (hubs) => hubs.map((h) => nameOf(h, network));
  // ── ONE CARD ───────────────────────────────────────────────────────────────
  const renderCard = (card) => {
    const p = byId.get(card.pid);
    const sOpen = solvePid === card.pid;
    const sResult = solved[card.pid];
    const sHubs = solveHubsOf(card);
    const sPlan = sHubs.length ? planOf(card, sHubs) : {};
    const solveLines = sHubs.flatMap((h) => (sPlan[h] || []).map((l) => ({ ...l, hub: h })));
    const solvable = SOLVE_HUBS.some((h) => planFor(card, h).length > 0);
    // A string means disabled AND is the text shown on the card (actionReasons.js).
    const solveBlocked = notLive || footwearSolveReason({ canAct, runLoaded: !!footwearRun, linesAtAnyHub: solvable });
    // `busy` is the GLOBAL in-flight flag — the button is disabled by the
    // global one, so its reason must read the same flag (Sonnet review, PR #342).
    const confirmBlocked = destinationProblem({ network, section, destinations: sHubs, kind: "sneaker" }) || pickRefusal(card, sHubs) || footwearConfirmReason({
      canAct, busy: !!solveBusy, lines: solveLines.length, hubLabel: hubNames(sHubs).join(" + "),
    });
    const twinId = card.duplicateOf;
    const twin = twinId ? byId.get(twinId) : null;
    const { why, holds } = whySneaker(card, { nameOf: (l) => nameOf(l, network), central: CENTRAL, hubs: HUBS });
    const pieces = solveLines.reduce((t, l) => t + l.qty, 0);
    return (
      <MissingCard key={`sneaker:${card.pid}`} pid={card.pid} name={card.name} product={p} photo={card.photo}
        meta={[brandOf(p), categoryLabelOf(p, effectiveCategoryKey(p))].join(" · ")}
        why={why} holds={holds} onPhoto={onPhoto ? () => onPhoto(p || { id: card.pid, photoUrl: card.photo }) : undefined}
        twin={twinId ? { product: twin, productId: twinId, name: twin?.name || card.name, where: hubNames(HUBS.filter((h) => Object.values(allStock?.[h]?.[twinId] || {}).some((c) => Number(c?.qty) > 0))).join(" and ") || "a hub" } : null}
        onTwinPhoto={onPhoto && twin ? () => onPhoto(twin) : undefined}
        primary={{ label: "Request", action: "open-request", tone: BLUE_L, disabled: !!solveBlocked, title: solveBlocked,
          onClick: () => { setSolvePid(card.pid); setSolved((d) => { const n = { ...d }; delete n[card.pid]; return n; }); } }}
        explains={`Asks Central for the policy number of pairs into ${SOLVE_HUBS.length === 1 ? `${hubNames(SOLVE_HUBS)[0]}'s` : "a hub's"} refill list. Nothing moves until Central picks it.`}
        blocked={solveBlocked ? `Request unavailable — ${solveBlocked}` : null}
        notice={sResult && !sOpen ? { ok: sResult.ok, text: sResult.msg } : null}
        panelOpen={sOpen} onClosePanel={() => setSolvePid(null)}>
        <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 7 }}>Request into</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {SOLVE_HUBS.map((h) => (
            <button key={h} role="checkbox" aria-checked={sHubs.includes(h)} data-dest={h} onClick={() => togglePick(card, h)} style={bigPill(sHubs.includes(h))}>
              {nameOf(h, network)}{planFor(card, h).length ? "" : " · nothing to raise"}
            </button>
          ))}
        </div>
        {sHubs.length > 0 && (
          <div data-raises style={{ fontSize: 12.5, color: GRAY, marginBottom: 9, lineHeight: 1.4 }}>
            Raises this into <b style={{ color: "#fff" }}>Source → {sHubs.map((h) => `${nameOf(h, network)} Refill`).join(" and ")}</b> as today's work.
            Central picks it size by size; stock does not move yet.
          </div>
        )}
        {!sHubs.length ? null : solveLines.length ? (
          <>
            <div style={CHIP_GRID}>
              {solveLines.map((l) => (
                <SizeFactChip key={`${l.hub}|${l.size}`} size={sHubs.length > 1 ? `${nameOf(l.hub, network)} ${l.size}` : l.size}
                  value={l.qty < l.want ? `${l.qty} of ${l.want} · only ${l.avail} at Central` : `${l.qty}`}
                  tone={l.qty < l.want ? AMBER : GREEN} />
              ))}
            </div>
            <div data-pieces style={{ fontSize: 12.5, color: GRAY, margin: "9px 0" }}>
              {pieces} pieces across {solveLines.length} size{solveLines.length === 1 ? "" : "s"}
              {solveLines.some((l) => l.qty < l.want) ? " — short sizes are capped by Central stock, not policy." : "."}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 9 }}>
            Nothing to raise at {hubNames(sHubs).join(" + ")} — every size is already queued there, or Central has none.
          </div>
        )}
        {sResult && !sResult.ok && <div data-notice style={{ fontSize: 13, fontWeight: 700, color: RED, lineHeight: 1.4, marginBottom: 8 }}>{sResult.msg}</div>}
        {confirmBlocked && <div data-confirm-blocked style={{ fontSize: 12.5, color: AMBER, lineHeight: 1.4, marginBottom: 8 }}>{confirmBlocked}</div>}
        <button data-action="confirm-request" onClick={() => solve(card)} disabled={!!confirmBlocked}
                title={confirmBlocked || undefined} style={primaryBtn(BLUE_L, !!confirmBlocked)}>
          {solveBusy === card.pid ? "Requesting…" : sHubs.length ? `Request ${pieces} for ${hubNames(sHubs).join(" + ")}` : "Request"}
        </button>
      </MissingCard>
    );
  };

  const viewOnly = !canAct ? <div style={{ color: AMBER, fontSize: 12.5, marginBottom: 10 }}>You need a stock role to raise requests — viewing only.</div> : null;
  // THE ONE-TAP SURFACE (Junid, 22 Nov 2026): what the Missing Products screen
  // needs to know, BEFORE a card is drawn, what a request into each hub would
  // raise (planFor — the function the write plans with), whether the other
  // Marathon hub already has the shoe (pickRefusal), and to raise it in one
  // tap (solveTo → solve above, one hub). No quantity is decided here.
  const api = {
    canAct, ready: policyRead.run && policyRead.hub3 && policyRead.own, notLive,
    destinations: SOLVE_HUBS,
    solveTo: (card, hub) => solve(card, [hub]),
    planFor, pickRefusal,
    // Does ANY of this shoe's sizes have a number at this hub? (No → the card
    // reads "No policy yet" rather than being listed as something to send.)
    // Only Kids Shoes is ever "waiting for a policy" (Junid, 22 Nov 2026); any
    // other shoe with nothing to send is simply not listed. A policy read that
    // FAILED is unknown, never "no policy".
    hasPolicy: (card, hub) => {
      if (!FOOTWEAR_OWN_NUMBERS_KEYS.includes(effectiveCategoryKey(byId.get(card.pid))) || ownPolicyErr) return true;
      const run = runFor(card, hub); return catalogSizes(card.pid).some((s) => Number(run[sizeKeyOf(s)]) > 0);
    },
  };
  return { cards, waiting, renderCard, sectionSwitch, queuedStrip, viewOnly, section, busy: !!solveBusy, api };
}

// THE STAND-ALONE LIST: one division's sneakers, with its own switch. The
// Missing Products screen does not use this — it calls the hook — but it is
// the same cards drawn by the same function.
export default function MissingFootwear({ products = [], section = null }) {
  const m = useSneakerRequest({ products, section });
  return (
    <>
      {m.sectionSwitch}
      {m.queuedStrip}
      {m.viewOnly}
      {!m.cards.length
        ? <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>{m.waiting.length ? "Nothing left to do here — everything else is queued at Central." : "No stranded sneakers — everything at Central is also held by a hub."}</div>
        : m.cards.map(m.renderCard)}
    </>
  );
}
