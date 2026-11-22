// ─── MISSING PRODUCTS — network transfer workflow ─────────────────────────────
// Owner spec (2026-07-12 v3): "Only in Central" / "Only in Hub 2" must be a
// complete transfer workflow, not a report. Every clothing product that exists
// upstream but is missing downstream appears as an expandable card:
//
//   photo · name · Available-at badges · Missing-from badges
//   → per-size stepper chips (capped at the source's live stock)
//   → destination chips (Hub 2 / Marathon PE / Trophy, as applicable)
//   → Transfer — immediate one-step applyMovement, straight from Health.
//
// SECTIONS (2026-10). Central supplies two sections, and the Solve is ONE
// screen for both: a block per section (Section 1 — Pine, Concrete; Section 2
// — Marathon PE, Trophy), a tick per store, one confirm. Each ticked store
// gets its shop sizes by the same policy, and the excess goes to ITS OWN
// back-stock hub (Hub 2 for Marathon PE and Trophy, Hub 3 for Pine, Hub 3 or
// the Concrete Stockroom for Concrete — the network registry's mapping). It is
// the same Solve per store, not a second one: solveSections.js deals Central's
// units across the ticked stores and every store then runs through the same
// first-batch / seed functions as before, with its hub passed in. Every
// location list and name on this screen comes from the registry.
//
// Data is computed LIVE from /stock (not the scan snapshot) so a transfer
// retires its card instantly. Every product outside the footwear group
// (clothing, perfume, and since 2026-09-17 every other non-footwear record —
// see missingProductsCore's inFootwearGroup note); strictly existing tokens.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ref, get, update, onValue, runTransaction, push, query, orderByChild, equalTo } from "firebase/database";
import { database, auth } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey, stockCellPath, decodedCellKey, stockSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import MissingCard, { primaryBtn } from "./MissingCard";
import { whyProduct, brandOf, categoryLabelOf } from "./missingScreenCore";
import { serverNowMs, serverNowIso } from "../../utils/serverTime";
import { seedLocations, solvePlan as computeSolvePlan, qualifyingSizes as computeQualifyingSizes, resolvedRun, ruleTargetsEnabledFor } from "./solvePlan";
import { computeMissingProducts, isClothing, cardSection } from "./missingProductsCore";
import { useMySections } from "../../utils/useMySections";
import { solveOn, sectionName, trustedCellsOnly } from "../../utils/networkRegistry";
import { trustStamp, cellTrusted } from "./stockTrust";
import { centralId, isCentral, storeIds, solveHubFor, solveHubsOfSection } from "./sectionRouting";
import { engineConfigView } from "./policyTemplate";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";
import { solveBlocks, allocationOrder, planSectionSolve, mergeSolveUpdates, undoablePaths } from "./solveSections";
import { HIDDEN_ROOT, HIDE_REASONS, hideEntry, bulkHideUpdate } from "./hiddenProductsCore";
import { undoCellTxn, solveUndoBlockers } from "./solveUndo";
// FIRST BATCH DIRECT TO SHOP (owner spec 2026-09-17) — see firstBatchCore.js.
import { isCentralFedProduct, centralFedPerSize, centralFedSizes } from "./centralFed";
import { concreteDivisionPolicy, isDivisionFootwear, isDivisionOneSize } from "./concreteDivision";
import { firstBatchEligible, buildFirstBatchSolveUpdate, trustExistingEmptyUpdates, firstBatchEstimate, firstBatchUndoBlockers, firstBatchUndoCancelTxn, solveIdFor, firstBatchRunId, buildPlacementIndex, firstBatchHistory, firstBatchStoreChoice, firstBatchSizeHints, centralReservedBySize, centralFreeFor, pruneClosedLocks, lockRefillIds, isSneakerOrSlide, hub2PresenceSignals } from "./firstBatchCore";
import { solveReason, solveConfirmReason, moveReason } from "./actionReasons";
import { setUpdateBusy } from "../../update/updateChecker";
import { stampRecord, stampTxn } from "../../device/deviceStamp";
// CONCRETE-ONLY + THE SOLVED TAB (Junid, 20 Nov 2026).
import { isConcreteProduct } from "../../utils/concreteListing";
import { markConcreteProduct } from "../concrete/concreteStore";
import { concreteSection } from "./missingProductsCore";
import { buildSolveLogEntry, buildConcreteLogEntry, mergeSolved, standing, normalizeSolvedEntry, newSolvedKey, undoRecordProblem } from "./solvedLog";
import { useSolvedLog, saveSolvedRows, markSolvedUndone } from "./solvedLogStore";
import { notePendingUpdate } from "../../offline/pendingWrites";
import { PrimaryPhoto } from "../shared/PrimaryPhoto";
import { switchShopPick, shopsAreExclusive, destinationProblem } from "./divisionDestinations";

// The section whose list HealthView hands this screen (computeMissingProducts'
// default) — the other section's list is one tap away for a viewer who may
// see it.
const HOME_SECTION = 2;
// The BACKSTOP for a just-solved card the live list still carries unchanged:
// the mirror's echo is 1.2–1.5 s, but its fallback cadence is a minute.
const DONE_HOLD_MS = 90000;
// The Source tab a shop's first-batch request lands on (App.jsx SOURCE_SHOP_TABS).
// A shop not named here is listed under its own name.
const SOURCE_TAB_LABEL = { "marathon-pe": "Marathon", trophy: "Trophy" };
// "_" is the catalogue's one-size sentinel — a real cell key, but never shown raw.
const sizeLabel = (s) => (String(s) === "_" ? "One size" : String(s));
// Fallback size-standard if config/refillEngine can't be read — mirrors the live
// defaultRunByStore (2026-07). Only used for the confirm ESTIMATE; the engine
// computes the real numbers from its own config regardless.
const STD_FALLBACK = {
  hub2: { L: 3, M: 3, S: 2, XL: 2, XXL: 2, XXXL: 1 },
  "marathon-pe": { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
  trophy: { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
};

// isClothing / the stranded-card build / size ordering all moved to
// missingProductsCore.js, so the chip counts in HealthView and this list are one
// function. Do not reintroduce a local copy — that is exactly how the old count
// and list drifted apart.

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

// `allStock` is passed IN by HealthView rather than subscribed here. Two
// independent onValue listeners on the whole ~3.6MB /stock tree meant two
// separate React states settling on their own schedule, so the chip counts above
// this list could show one snapshot while the list below rendered the previous
// one — the same count-disagrees-with-list class of bug this tab was just fixed
// for. One subscription, one snapshot, and one less full-tree listener.
// (Codex review, PR #308.) HealthView is the only renderer of this component.
// THE LOGIC, AS A HOOK (Junid, 22 Nov 2026). The Missing Products screen lists
// sneakers and everything else in ONE list per division, so this component's
// body is a hook that hands back its cards and a way to draw each one; the
// screen interleaves them with MissingFootwear's. Every rule about what a
// Solve writes is exactly where it was — only who calls the render changed.
//   section   the division list being shown (controlled by the screen). Absent
//             ⇒ this list keeps its own switch (the stand-alone list, below).
//   cards     with `section`: that division's cards, as the screen built them
//             for its counts. Without: the home division's (HealthView's old
//             contract).
export function useProductSolve({ products = [], category = "all", allStock = {}, cards: allCards = null, targets = null, targetsSettled = false, targetsError = false, solvedSession: solvedSessionProp = null, setSolvedSession: setSolvedSessionProp = null, resolving: resolvingProp = null, setResolving: setResolvingProp = null, onOpenSolved = null, section: sectionProp = null, onPhoto = null }) {
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canAct = ["store", "warehouse", "admin"].includes(actorRole);
  // Marking Concrete-only is Junid's / a stockRole admin's (the mark IS the
  // brand check — concreteStore.canVerifyBrand's identities).
  const canMarkConcrete = isSuperAdmin || permRecord?.stockRole === "admin";
  const actorName = permRecord?.displayName || permRecord?.username || null;

  // THE NETWORK REGISTRY: every store, hub, section and name on this screen.
  const { registry: network, sections: mySections } = useMySections();
  const CENTRAL = centralId(network);
  // id → name, for every location the registry knows (the labels the pure
  // helpers take, and what every sentence here is written with).
  const LOC_LABEL = useMemo(
    () => Object.fromEntries(Object.values(network.locations).map((l) => [l.id, l.name])),
    [network],
  );
  const sourceTab = (store) => SOURCE_TAB_LABEL[store] || LOC_LABEL[store] || store;
  // WHICH DIVISION'S LIST. "Missing from Marathon" (the default, the list
  // HealthView hands over) is every product held at Central or at a Marathon
  // hub that no Marathon shop or Marathon back-stock hub carries yet; "Missing
  // from Concrete" is the same question for Pine, Concrete and Hub 3. A viewer
  // who may see both divisions can switch. EACH LIST SOLVES AND MOVES INTO ITS
  // OWN DIVISION ONLY (owner rule 8 Oct 2026) — enforced in solve() and
  // transfer() below, not only in what is offered.
  const sectionChoices = useMemo(
    () => [HOME_SECTION, ...[1, 2].filter((x) => x !== HOME_SECTION)].filter((x) => mySections.includes(x) && storeIds(network, { section: x }).length > 0),
    [network, mySections],
  );
  const [sectionPick, setSectionPick] = useState(null);
  const pickedSection = sectionProp || (sectionChoices.includes(sectionPick) ? sectionPick : null);
  const listSection = pickedSection && pickedSection !== HOME_SECTION ? pickedSection : null;

  const [openPid, setOpenPid] = useState(null);
  const [dests, setDests] = useState({});     // pid → chosen destination
  const [edits, setEdits] = useState({});     // `${pid}|${size}` → qty
  const [busyPid, setBusyPid] = useState(null);
  const [done, setDone] = useState({});       // pid → {moved, dest, failed[]}

  // ── HIDE — a view filter, never an action on stock ─────────────────────────
  // Writes ONE entry to /settings/missingProductsHidden/{pid} (who, when,
  // optional reason — hiddenProductsCore.js) and nothing else. The card leaves
  // the list because HealthView's partition reacts to the node, so removal is
  // as live as every other state on this screen. Reason is OPTIONAL by owner
  // decision — the panel's third choice hides with no reason at all.
  const [hidePid, setHidePid] = useState(null);   // which row's hide panel is open
  const [hideBusy, setHideBusy] = useState(null);
  const [hideErr, setHideErr] = useState({});     // pid → message (write failed)
  const hide = async (card, reason) => {
    if (hideBusy || !canAct) return;
    setHideBusy(card.pid);
    try {
      await update(ref(database), {
        [`${HIDDEN_ROOT}/${card.pid}`]: hideEntry({ at: serverNowMs(), by: auth.currentUser?.uid, reason }),
      });
      // The card vanishes via the subscription; clearing the panel state just
      // keeps a stale pid from re-opening on a product hidden and unhidden.
      setHidePid((cur) => (cur === card.pid ? null : cur));
      setHideErr((e) => { const n = { ...e }; delete n[card.pid]; return n; });
    } catch (e) {
      setHideErr((prev) => ({ ...prev, [card.pid]: `Couldn't hide — nothing changed, retry. (${e?.message || "error"})` }));
    }
    setHideBusy(null);
  };

  // ── BULK HIDE — the scale path (hundreds of seasonal entries at once) ──────
  // Select mode turns every card into a checkbox; the action bar hides the
  // WHOLE selection in ONE multi-path update built by bulkHideUpdate, which
  // writes exactly the selected pids' entries and nothing else (pinned in
  // hiddenProductsCore.test.js). Same provenance shape as a single hide: one
  // gesture, one at/by/reason for the batch.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState({});   // pid → true
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState(null);
  const exitSelect = () => { setSelectMode(false); setSelected({}); setBulkErr(null); };
  // A selection is a statement about the cards the operator was LOOKING AT.
  // Switching chips swaps the list under the checkboxes, so carrying the
  // selection across would let a Clothing selection ride silently into a
  // Perfume bulk hide. Reset on category change.
  useEffect(() => { exitSelect(); }, [category]);   // eslint-disable-line react-hooks/exhaustive-deps
  const bulkHide = async (reason) => {
    if (bulkBusy || !canAct || !selectedPids.length) return;
    setBulkBusy(true);
    try {
      await update(ref(database), bulkHideUpdate(selectedPids, { at: serverNowMs(), by: auth.currentUser?.uid, reason }));
      exitSelect();
    } catch (e) {
      setBulkErr(`Couldn't hide — nothing changed, retry. (${e?.message || "error"})`);
    }
    setBulkBusy(false);
  };

  // Solve (engine-managed) — separate from the manual transfer above.
  const [solvePid, setSolvePid] = useState(null);   // which row's Solve panel is open
  const [solveTicks, setSolveTicks] = useState({}); // pid → the stores ticked, IN THE ORDER TICKED (absent = the default tick)
  // Solves still writing, by pid. Several may be in flight at once (each card
  // resolves the moment it is tapped — Junid, 20 Nov 2026); one pid never twice.
  const [solving, setSolving] = useState({});
  const solveBusy = Object.keys(solving)[0] ?? null;   // "a solve is writing" — for setUpdateBusy
  const [solved, setSolved] = useState({});         // pid → {store, sizes, msg, ok}

  // ── SOLVED — every solve and Concrete mark, each reversible while safe ─────
  // (Junid, 20 Nov 2026.) A solved card leaves the list the moment Junid taps,
  // so its Undo cannot live on the card. Every action is recorded twice:
  //   • the SESSION list (owned by HealthView, so a glance at the Sneakers or
  //     Hidden chip — which unmounts this component — cannot drop a fresh
  //     undo; Sonnet substitute review, PR #361), and
  //   • the saved history /settings/missingProductsSolved (solvedLog.js), which
  //     the Solved tab pages through, newest first.
  // The main list shows only the LAST action (one confirm may be several
  // stores); everything else lives in the Solved tab. Every guard rule lives
  // in solveUndo.js, unchanged.
  const [localSession, setLocalSession] = useState([]);
  const solvedSession = solvedSessionProp ?? localSession;
  const setSolvedSession = setSolvedSessionProp ?? setLocalSession;
  // RESOLVING: cards hidden the moment their action was tapped (pid → "pending"
  // while the write is in flight, "done" once it landed — kept hidden until the
  // live list stops carrying the card, so it never flickers back). Owned by
  // HealthView too, so the chip counts drop with the card.
  const [localResolving, setLocalResolving] = useState({});
  const resolving = resolvingProp ?? localResolving;
  const setResolving = setResolvingProp ?? setLocalResolving;
  const solvedLog = useSolvedLog(true);
  const solvedAll = useMemo(() => mergeSolved(solvedLog.entries, solvedSession), [solvedLog.entries, solvedSession]);
  // The rows still standing: the siblings an undo must not take shared cells from.
  const undoables = useMemo(() => standing(solvedAll), [solvedAll]);
  // Busy / error per row, by key.
  const [undoUi, setUndoUi] = useState({});
  const setRow = (key, patch) => setUndoUi((m) => ({ ...m, [key]: { ...(m[key] || {}), ...patch } }));
  // A row fully undone: the saved row says so (best effort — the session row
  // says so regardless), the card may return, and its stale banner clears.
  const finishUndo = async (u) => {
    setSolvedSession((l) => {
      const hit = l.some((x) => x.key === u.key);
      return hit ? l.map((x) => (x.key === u.key ? { ...x, status: "undone" } : x)) : [...l, { ...u, status: "undone" }];
    });
    clearTimeout(doneTimers.current[u.pid]); delete doneTimers.current[u.pid]; delete doneSnap.current[u.pid];
    setResolving((m) => { const n = { ...m }; delete n[u.pid]; return n; });
    setSolved((d) => { const n = { ...d }; delete n[u.pid]; return n; });
    if (u.saved !== false) {
      try { await markSolvedUndone(u.key, { at: serverNowMs(), by: auth.currentUser?.uid }); }
      catch { /* the session row already says Undone; the saved row just keeps "done" */ }
    }
  };
  // In-flight keys in a ref: the render-closure `busy` is stale under a
  // double-tap, and two overlapping undos of one entry would race their own
  // reads (Kimi substitute review, PR #361).
  const undoInFlight = useRef(new Set());
  const undoSolve = async (u) => {
    if (!canAct || undoUi[u.key]?.busy || undoInFlight.current.has(u.key)) return;
    // A row read back from the (staff-writable) history is checked first.
    const bad = undoRecordProblem(u, Object.keys(network.locations || {}));
    if (bad) { setRow(u.key, { err: `This row cannot be undone safely — it names ${bad}. Nothing was changed.` }); return; }
    undoInFlight.current.add(u.key);
    setRow(u.key, { busy: true, err: null });
    try {
      // Engine guard first: any CURRENT lock on a seeded size that was not in
      // the solve-time snapshot means the engine has raised work on the seed —
      // deleting its cells would orphan queue entries, so refuse before
      // touching anything. (No clock comparisons — see solveUndo.js.)
      const openByLoc = {};
      await Promise.all(u.locs.map(async (loc) => {
        openByLoc[loc] = (await get(ref(database, `refill_engine/open/${loc}/${u.pid}`))).val();
      }));
      // FIRST BATCH: reversible only while Central has not started on the
      // shop's requests (live re-read, never the render snapshot). The lock
      // the server claimed FOR this solve is not "the engine raised work" —
      // it is exempted by its runId; any other new lock still blocks.
      let liveFb = null;
      if (u.firstBatch) {
        liveFb = {};
        await Promise.all(u.firstBatch.requestIds.map(async (id) => {
          liveFb[id] = (await get(ref(database, `refill_requests/${id}`))).val();
        }));
        // Every request this row names must be THIS product's, raised for
        // THIS store — a history row is staff-writable, and the cancel below
        // must never reach another product's request (substitute Sonnet
        // review, PR #952).
        const foreign = Object.entries(liveFb).find(([, r]) => r && (r.productId !== u.pid || r.requestingLocation !== u.firstBatch.store));
        if (foreign) { setRow(u.key, { busy: false, err: "This row names a request that is not this solve's — nothing was changed." }); return; }
        const fbBlockers = firstBatchUndoBlockers({ liveRequests: liveFb, storeLabel: LOC_LABEL[u.store] });
        if (fbBlockers.length) {
          setRow(u.key, { busy: false, err: fbBlockers[0] });
          return;
        }
      }
      // The cells this undo may take back: its own seeds, minus any a sibling
      // solve of the same product still standing in this list also wrote (two
      // shops of one confirm share their hub's seeds, and the hub stays
      // seeded while either stands). For a one-store solve that is every path.
      const ownPaths = undoablePaths(u, undoables);
      const blockers = solveUndoBlockers({ paths: ownPaths, openByLoc, priorOpenByLoc: u.priorOpen, ownRunId: u.firstBatch ? firstBatchRunId(u.firstBatch.solveId) : null });
      if (blockers.length) {
        setRow(u.key, { busy: false, err: blockers[0] });
        return;
      }
      // Cancel the shop's open requests FIRST, with the solve_undone reason:
      // the trigger then raises no Hub 2 leg and the engine withdraws the lock
      // as its own kind of close (no cooldown, no confirmed-out strike). Only
      // then are the seeds removed, so no request can outlive its cell. Each
      // cancel is a CAS (firstBatchUndoCancelTxn): a row Central got to first
      // aborts and stands, and its cell — now holding real units — is kept by
      // undoCellTxn below, so the two halves can never disagree.
      let stood = [];
      if (liveFb) {
        const txn = stampTxn(firstBatchUndoCancelTxn({ nowIso: serverNowIso(), uid: auth.currentUser?.uid || null }), "solve-undo");
        // Only rows still OPEN: a retry after a partial undo must not re-run
        // the CAS on its own already-cancelled rows (they would abort and be
        // reported as "standing"). (CodeRabbit, PR #607.)
        const ids = Object.keys(liveFb).filter((id) => liveFb[id] && liveFb[id].status === "open");
        const outcomes = await Promise.all(ids.map((id) => runTransaction(ref(database, `refill_requests/${id}`), txn)));
        stood = ids.filter((id, i) => !outcomes[i].committed).map((id) => liveFb[id].size);
      }
      // Per-cell TRANSACTIONS, not read-then-delete: each cell is re-verified
      // as the untouched seed INSIDE the CAS, so a count/sale/transfer landing
      // mid-undo aborts that cell's delete instead of being erased (the
      // substitute pair's TOCTOU HIGH). A cell that aborts stays, and the row
      // says which and why; the committed ones are genuinely just seeds, so a
      // partial undo leaves nothing broken — the product simply still carries
      // the touched sizes.
      const results = await Promise.all(ownPaths.map((p) => runTransaction(ref(database, p), undoCellTxn)));
      const kept = ownPaths.filter((p, i) => !results[i].committed);
      if (kept.length || stood.length) {
        const standingMsg = stood.length ? ` Central had already started on size${stood.length === 1 ? "" : "s"} ${stood.map(sizeLabel).join(", ")} — ${stood.length === 1 ? "that request stands" : "those requests stand"}.` : "";
        setRow(u.key, { busy: false, err: `${ownPaths.length - kept.length} of ${ownPaths.length} seeded cells removed — the rest took real stock or counts since the solve and were kept. Use Adjust for those.${standingMsg}` });
      } else {
        // Fully undone: the row reads Undone (the card reappearing IS the
        // feedback), and the stale "Solved ✓" banner is cleared so the
        // returning card offers Solve again, not last week's success message.
        setRow(u.key, { busy: false, err: null });
        await finishUndo(u);
      }
    } catch (e) {
      setRow(u.key, { busy: false, err: `Couldn't undo — nothing changed, retry. (${e?.message || "error"})` });
    } finally {
      undoInFlight.current.delete(u.key);
    }
  };
  // Undo a Concrete mark: the product returns to Marathon's list, and a
  // Marathon listing the mark itself switched off is switched back on.
  const undoConcrete = async (u) => {
    if (!canMarkConcrete || undoInFlight.current.has(u.key)) return;
    undoInFlight.current.add(u.key);
    setRow(u.key, { busy: true, err: null });
    try {
      const r = await markConcreteProduct(u.pid, false);
      if (!r.ok) { setRow(u.key, { busy: false, err: `Couldn't undo — ${r.message}` }); return; }
      // markConcreteProduct(…, false) also puts back a Marathon listing the
      // mark itself switched off (concreteStore.restoreMarathonListing).
      setRow(u.key, { busy: false, err: r.warning || null });
      await finishUndo(u);
    } finally {
      undoInFlight.current.delete(u.key);
    }
  };
  const undoEntry = (u) => (u.kind === "concrete" ? undoConcrete(u) : undoSolve(u));
  // Record actions in the session list now and in the saved history after
  // (best effort, AFTER the action committed — a refused log write must never
  // fail a Solve; solvedLog.js). A row that did not save says so.
  const recordSolved = async (rows) => {
    if (!rows.length) return;
    setSolvedSession((l) => [...rows, ...l]);
    try {
      await saveSolvedRows(rows);
    } catch (e) {
      const keys = new Set(rows.map((r) => r.key));
      setSolvedSession((l) => l.map((x) => (keys.has(x.key) ? { ...x, saved: false, saveErr: String(e?.message || e) } : x)));
    }
  };

  // ── CONCRETE — one tap, the row moves to the Concrete division ─────────────
  // Sets concreteProduct through the ONE helper (concreteListing.js). The row
  // leaves the Marathon list at once; the product appears in the Concrete
  // division's list (missingProductsCore.listedInSection). A refused write
  // brings the row back and says why in red.
  const markConcrete = async (card) => {
    if (!canMarkConcrete || resolving[card.pid]) return;
    doneSnap.current[card.pid] = (card.missing || []).join("|");
    setResolving((m) => ({ ...m, [card.pid]: "pending" }));
    setSolved((d) => { const n = { ...d }; delete n[card.pid]; return n; });
    const r = await markConcreteProduct(card.pid, true);
    if (!r.ok) {
      setResolving((m) => { const n = { ...m }; delete n[card.pid]; return n; });
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store: null, sizes: [], msg: `Not marked Concrete — ${r.message}` } }));
      return;
    }
    setResolving((m) => ({ ...m, [card.pid]: "done" }));
    const at = serverNowMs();
    const key = newSolvedKey(at);
    const log = buildConcreteLogEntry({ pid: card.pid, name: card.name, photo: card.photo, at, by: auth.currentUser?.uid, byName: actorName, division: divisionOf(card) });
    await recordSolved([{ ...log, key, batch: key, log }]);
  };

  // The engine config, LIVE (onValue, not the one-shot get this used to do).
  // Solve's enabled state is a promise about what the engine will do next, so it
  // has to track the engine's switches rather than a snapshot taken when the tab
  // was opened: an operator who kills rule-based targets — or deletes the watch
  // policy — while this screen sits open would otherwise keep seeing an armed
  // Solve button and seed cells nothing will ever refill. One small config node.
  //
  // null = not read yet, and everything downstream treats that as OFF, so the
  // button starts greyed and lights up only on evidence.
  const [cfg, setCfg] = useState(null);
  // Tracked separately because the fail-safe {} is indistinguishable from a real
  // config with no switches set — without this the tooltip would blame the kill
  // switch for what is actually a failed read, sending someone to check a
  // setting that was never the problem. (CodeRabbit, PR #305.)
  const [cfgErr, setCfgErr] = useState(false);
  useEffect(() => onValue(
    ref(database, "config/refillEngine"),
    (s) => { setCfgErr(false); setCfg(s.val() || {}); },
    () => { setCfgErr(true); setCfg({}); },   // unreadable → no switches → Solve off (fail-safe)
  ), []);
  // "THE SAME POLICY FOR EVERY STORE UNLESS IT HAS ITS OWN." The policy maps
  // are read as the ENGINE reads them (policyTemplate.engineConfigView, the
  // one browser copy of the engine's template step): a LIVE location with no
  // numbers of its own — Pine, Concrete, Hub 3, the Concrete Stockroom —
  // reads the location it is declared to be like. Marathon PE, Trophy, Hub 1
  // and Hub 2 have their own and read exactly what they always read; a
  // location that is not live reads what is stored (and cannot be ticked).
  // `cfg` stays the stored node; `pcfg` is a view and is never written.
  const pcfg = useMemo(() => engineConfigView(cfg, network), [network, cfg]);
  const std = pcfg?.defaultRunByStore;
  const subRun = pcfg?.subcategoryRunByLocation;
  // Mirrors the engine's kill switch exactly (solvePlan.js). Absent → off.
  const ruleOn = (dest) => ruleTargetsEnabledFor(pcfg?.ruleBasedTargets, dest);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // /stock_targets, LIVE, handed down by HealthView (it already subscribes for
  // the migration count — a second full-tree listener here is the drift the
  // allStock note below warns about).
  //
  // GATE ON `settled`, NEVER ON THE VALUE. RTDB returns null for an empty node,
  // for a node that has not answered yet, AND (via usePath's warn-only error
  // path) for a read that was DENIED. Gating on `targets != null` therefore
  // greyed EVERY clothing Solve — including sized products, which never needed a
  // target row at all — behind a permanent "still loading" whenever
  // /stock_targets was empty or unreadable. That was a regression on pre-PR
  // behaviour, where Solve did not read this node at all. (Kimi review, PR #342.)
  //
  // A FAILED read degrades rather than blocks: explicit rows become UNKNOWN, so
  // the rule-based path keeps working exactly as it did before this file learned
  // about targets, and only an explicit-row-only product stays greyed — with a
  // sentence that names the failed read instead of blaming the product.
  const targetsReady = targetsSettled;
  const targetRows = targetsError ? null : targets;
  // On-hand for a RAW catalogue size against the DECODED cell map HealthView
  // passes down (useStockCells decodes on the way in). decodedCellKey, never
  // `String(size)`: the raw size and the cell key part company the moment a size
  // needs encoding — a padded " 8" lives in the cell "_8" — and a miss here reads
  // as a silent zero, which is precisely how the sneaker Solve lost whole sizes.
  // Letters and the "_" sentinel are unaffected either way; this is the lookup
  // that is right for all three.
  const qtyAt = (loc, pid, size) => Math.max(Number(allStock?.[loc]?.[pid]?.[decodedCellKey(size)]?.qty) || 0, 0);
  // ("carries" lived here and is now missingProductsCore's alone — the carriage
  // rule belongs with the card build it gates. Keeping a copy would be a second
  // implementation of the engine's storeCarries idea. CodeRabbit, PR #308.)

  // Stranded clothing: real upstream stock, NOT carried anywhere downstream.
  // Built by missingProductsCore so this list and the chip counts above it come
  // from ONE function and cannot drift (they did before: 391 vs 380).
  //
  // HealthView has already built the full list to count the chips, so it hands
  // it straight over and this only filters — no second walk of the central+hub2
  // union and its size arithmetic on every stock write. The fallback keeps the
  // component usable on its own; it just isn't the path the app takes.
  // (Senior-architect review, PR #308.)
  // The list before the chip filter — "is this card still live anywhere on
  // this screen" is asked of it, never of one chip's slice.
  const allLive = useMemo(() => (sectionProp && allCards ? allCards : listSection
    // The other section's list is built here, on demand, from the same
    // function (it is not HealthView's to count while that section has no
    // live shop).
    ? computeMissingProducts({ allStock, products, network, section: listSection, centralFed: cfg })
    : (allCards || computeMissingProducts({ allStock, products }))), [allCards, allStock, products, listSection, network, cfg]);
  const cardsLive = useMemo(
    () => (category && category !== "all" ? allLive.filter((c) => c.group === category) : allLive),
    [allLive, category],
  );
  // RESOLVING (Junid, 20 Nov 2026): a card Junid has just solved or marked
  // Concrete leaves at once. A "done" entry (the write landed) is dropped as
  // soon as the live list stops carrying the card — or after DONE_HOLD_MS
  // whatever happens, so a card that is STILL missing somewhere (one store of
  // several solved) comes back with what is left (Sonnet review, PR #952 B1).
  const cards = useMemo(() => cardsLive.filter((c) => !resolving[c.pid]), [cardsLive, resolving]);
  // What the card was missing when its action was tapped: a live card whose
  // missing set has CHANGED has caught up with the write (one store of
  // several solved) and comes back with what is left. A card unchanged stays
  // hidden until it goes, or until the backstop (substitute Sonnet review,
  // PR #952: a fixed 8 s could show Solve again before a slow echo).
  const doneSnap = useRef({});
  const doneTimers = useRef({});
  const releaseDone = (pids) => {
    for (const pid of pids) { clearTimeout(doneTimers.current[pid]); delete doneTimers.current[pid]; delete doneSnap.current[pid]; }
    setResolving((m) => { const n = { ...m }; let ch = false; for (const pid of pids) if (n[pid] === "done") { delete n[pid]; ch = true; } return ch ? n : m; });
  };
  useEffect(() => {
    const live = new Map(allLive.map((c) => [c.pid, c]));
    const release = Object.keys(resolving).filter((pid) => {
      if (resolving[pid] !== "done") return false;
      const c = live.get(pid);
      if (!c) return true;
      const snap = doneSnap.current[pid];
      return snap != null && snap !== (c.missing || []).join("|");
    });
    if (release.length) releaseDone(release);
    for (const [pid, st] of Object.entries(resolving)) {
      if (st !== "done" || doneTimers.current[pid]) continue;
      doneTimers.current[pid] = setTimeout(() => releaseDone([pid]), DONE_HOLD_MS);
    }
  }, [allLive, resolving]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { for (const t of Object.values(doneTimers.current)) clearTimeout(t); }, []);

  // Typed quantities on a card still in the list, or a move going through,
  // are a job in hand — see Transfer.jsx's transfer-basket for why this is
  // registered. Only edits for cards still SHOWN count: a card retired by a
  // live stock update or a finished move leaves its keys behind, and they
  // must not hold the device busy for as long as the screen is open.
  useEffect(() => {
    const live = new Set((cards || []).map((c) => c.pid));
    const typed = Object.keys(edits).some((k) => live.has(k.split("|")[0]) && !done[k.split("|")[0]]);
    // A solve, an undo or a bulk hide still writing is a job in hand too.
    // (CodeRabbit, PR #640.)
    const undoBusy = Object.values(undoUi).some((x) => x?.busy);
    setUpdateBusy("network-transfer", typed || busyPid != null || solveBusy != null || undoBusy || !!bulkBusy || hideBusy != null);
    return () => setUpdateBusy("network-transfer", false);
  }, [cards, edits, busyPid, done, solving, undoUi, bulkBusy, hideBusy]);
  // Selection reconciled against the RENDERED list (`cards`, not the allCards
  // prop): a selected card that resolves out mid-select — or that the
  // standalone-fallback path computed locally, where allCards is null — must
  // neither inflate the "N selected" count nor ride into the bulk write.
  // Deriving from the prop broke select mode entirely on the fallback path
  // (empty set → nothing ever counted). (Kimi + Sonnet substitute pair,
  // PR #356.)
  const cardPidSet = useMemo(() => new Set(cards.map((c) => c.pid)), [cards]);
  const selectedPids = Object.keys(selected).filter((k) => selected[k] && cardPidSet.has(k));

  // Catalog sizes to seed. The one-size "_" sentinel is KEPT (it used to be
  // dropped here): it is a real, seedable cell key for a one-size product, and
  // dropping it made every such product unsolvable before qualifyingSizes ever
  // got a say. The standard lookup is what excludes it now — "_" has no entry in
  // a garment-letter run, so a one-size product with no subcategory policy still
  // ends up with zero qualifying sizes and a greyed Solve, exactly as before.
  //
  // A BLANK catalogue size stays filtered out. It looks like another spelling of
  // one-size, but the two encodings disagree where it counts: stockSizeKey("")
  // is "_" while encodeSizeKey("") is "", so seeding one would arm a phantom ""
  // cell beside the real "_" stock. No live product has one (checked across all
  // 3,953), and the engine refuses to target one either (refill-engine.cjs).
  // filter on TRIMMED content, not truthiness: "   " is truthy and would sail
  // through to be seeded, while the engine's own guard rejects it — the exact
  // UI/engine divergence this module exists to prevent. (CodeRabbit, PR #305.)
  const catalogSizes = (pid) => (byId.get(pid)?.sizes || []).map(String).filter((s) => s.trim() !== "");
  // Once the live config has arrived, TRUST IT ALONE. The old merge
  // ({...STD_FALLBACK, ...std}) was shallow per location, so any location the
  // live defaultRunByStore omits kept the hardcoded map — letting Solve qualify
  // a size the engine has no standard for and seed a cell it would never refill.
  // The fallback cannot serve its original "config is slow" purpose any more
  // either: cfg === null now disables Solve outright via ruleOn. So it survives
  // only as the pre-load placeholder, where nothing can act on it.
  // (CodeRabbit, PR #305.)
  const stdRun = useMemo(() => (cfg ? (std || {}) : STD_FALLBACK), [cfg, std]);
  // The target THIS product is governed by, at every location — resolveTarget's
  // full priority order folded into one run map (solvePlan.js resolvedRun):
  // explicit /stock_targets row (wins, and survives the kill switch), else the
  // subcategory policy, else the size run (both only where the switch is on).
  //
  // THE FIX (2026-08-10). This used to be effectiveStandard alone — subcategory
  // policy over the size run — with the kill switch applied one level up in
  // qualifyingSizes. That left out the engine's FIRST branch entirely, and the
  // omission was not merely incomplete, it was structural: an explicit row is the
  // only way a ONE-SIZE product can ever hold a target, because its single size is
  // the "_" sentinel and putting "_" in defaultRunByStore was rejected outright
  // (it is shared by every one-size product, so it would arm sunglasses and belts
  // too). One-size products could therefore never be solved, no matter what an
  // operator configured — which is what greyed out every beanie. Applying the kill
  // switch per location INSIDE resolvedRun is the other half: explicit rows must
  // outlive it, exactly as they do in resolveTarget.
  // NON-CLOTHING CARDS (perfume, 2026-08-13) SEE EXPLICIT ROWS ONLY. The
  // engine's rule branches — the size run AND the subcategory policy — are both
  // nested inside isClothing(product) (refill-engine.cjs resolveTarget), so for
  // a perfume they can never fire, whatever the config says. This mirror must
  // refuse them too, or a mis-filed perfume carrying a stray letter size would
  // light Solve up on the strength of a garment run the engine will never
  // apply — the exact false-solve (seed, vanish, never refill) this module
  // exists to prevent. solvePlan.js's own header called this the "one mirror
  // gap that lives elsewhere" back when the cards list was clothing-only; with
  // perfume admitted, "elsewhere" is here. Clothing is byte-for-byte unchanged.
  const runFor = (pid) => {
    const ruleEligible = isClothing(byId.get(pid));
    return resolvedRun({
      std: ruleEligible ? stdRun : {}, subRun: ruleEligible ? subRun : undefined,
      subcategory: byId.get(pid)?.subcategory, sizes: catalogSizes(pid),
      targets: targetRows, pid, ruleBasedTargets: pcfg?.ruleBasedTargets,
      // CATEGORY POLICY (2026-08-13): the engine's standing owner-armed source,
      // between the rules and the explicit rows — a mapped category (perfume)
      // is solvable with NO row, exactly as the engine will refill it. Rides
      // the same config subscription as every other switch on this screen.
      // unitsAnywhere feeds the per-size dead-size test from the same decoded
      // allStock map the coverage estimate reads.
      // The EFFECTIVE key (trimmed; legacy sneaker → "sneakers") and the
      // policy groups — the engine's own resolution (policyCategoryKey +
      // effectivePolicyFor), so a padded or grouped key cannot grey a card
      // the engine is refilling. (Junid, 20 Nov 2026 — solvePlan.js entryFor.)
      categoryPolicy: pcfg?.categoryPolicy, policyGroups: pcfg?.policyGroups, categoryKey: effectiveCategoryKey(byId.get(pid)),
      unitsAnywhere: (sz) => Object.keys(allStock || {}).reduce((t, loc) => t + qtyAt(loc, pid, sz), 0),
    });
  };
  // Sizes safe to seed — a positive target at every seed location (solvePlan.js).
  // A size with no target would seed a cell the engine never refills, then vanish
  // with a false "solved", so it's excluded. (Codex fix a.)
  //
  // Still ONE choke point: this greys the button, disables the confirm action AND
  // makes solve() bail, rather than three places to keep in step. What changed is
  // only what feeds it — the kill switch now lives inside runFor, per location, so
  // that an explicit row can survive it.
  //
  // Targets not loaded yet → nothing qualifies, so Solve starts greyed and lights
  // up on evidence, matching how cfg === null is already handled. The row says
  // which of the two it is waiting on.
  // THE HUB BEHIND A STORE for this product — the registry's mapping
  // (sectionRouting.solveHubFor): Hub 2 for Marathon PE and Trophy, Hub 3 for
  // Pine, Hub 3 or the Concrete Stockroom for Concrete. Staff never choose it.
  const hubOf = (card, store) => solveHubFor(network, store, byId.get(card.pid), card.pid);
  // CENTRAL-FED CLOTHING (centralFed.js — Concrete, owner 8 Oct 2026): the
  // store keeps this clothing in the shop, N of EVERY declared size, straight
  // from Central — no hub, no hub seed, no hub leg. Read from the engine
  // config the owner sets on the Engine Policy card; absent ⇒ off.
  // THE CONCRETE DIVISION (Junid, 12 Nov 2026): every non-footwear item at Pine
  // and Concrete is kept in the shop from Central, whatever Hub 3 ever held.
  const divisionPolicy = concreteDivisionPolicy(cfg);
  const divisionCard = (card, store) => !!divisionPolicy && sectionOfStore(store) === 1 && !isDivisionFootwear(byId.get(card.pid));
  const cfAt = (card, store) => isCentralFedProduct(cfg, network, store, byId.get(card.pid));
  const divisionShopKeep = (card) => {
    const leg = divisionPolicy?.shopOnly;
    return leg ? (isDivisionOneSize(byId.get(card.pid)) ? leg.oneSize : leg.perSize) : null;
  };
  // The run a store's lines are planned from: the policy run, with a
  // central-fed store's row replaced by N per declared size.
  // An explicit /stock_targets row for the size wins (0 = excluded) — the
  // engine's own precedence (resolveTarget: explicit row before central-fed).
  const cfTargetAt = (card, st, sz) => {
    const row = targetRows?.[st]?.[card.pid]?.[encodeSizeKey(sz)];
    if (row && typeof row.target === "number") return row.target;
    return divisionCard(card, st) ? divisionShopKeep(card) : centralFedPerSize(cfg, network, st);
  };
  const runAt = (card, stores) => {
    const run = runFor(card.pid);
    for (const st of stores || []) {
      if (!cfAt(card, st)) continue;
      run[st] = Object.fromEntries(centralFedSizes(byId.get(card.pid)).map((sz) => [String(sz).toUpperCase(), cfTargetAt(card, st, sz)]));
    }
    return run;
  };
  // A central-fed size is a GAP when the store has no cell, or an UNTRUSTED
  // cell holding nothing (sold-out legacy stock — Solve trusts that cell in
  // place, metadata only). An untrusted cell holding units waits for a count.
  const cfGap = (card, store, sz) => {
    const c = allStock?.[store]?.[card.pid]?.[decodedCellKey(sz)];
    if (c == null) return true;
    return !cellTrusted(c) && !(Number(c?.qty) > 0);
  };
  const qualifyingSizes = (card, store) => {
    if (!targetsReady) return [];
    // Every declared size the store has no cell for yet (a size it already
    // carries is the engine's to top up — never asked for twice).
    if (cfAt(card, store)) return centralFedSizes(byId.get(card.pid)).filter((sz) => cfGap(card, store, sz) && cfTargetAt(card, store, sz) > 0);
    const hub = hubOf(card, store);
    if (!hub) return [];
    return computeQualifyingSizes(catalogSizes(card.pid), card.source, store, runFor(card.pid), hub);
  };

  // Confirm estimate via the pure helper (solvePlan.js), over the QUALIFYING sizes
  // only — availability closes over live /stock; std falls back if config is slow.
  // `centralTaken` (optional): units of a size this confirm has already dealt
  // to an earlier-ticked store — never shown as available twice.
  const solvePlan = (card, store, centralTaken = null) => computeSolvePlan({
    std: runAt(card, [store]),
    sizes: qualifyingSizes(card, store),
    source: card.source,
    store,
    availAt: (loc, sz) => Math.max(qtyAt(loc, card.pid, sz) - (isCentral(loc, network) && centralTaken ? (centralTaken[String(sz)] || 0) : 0), 0),
    hub: hubOf(card, store),
    hubLabel: LOC_LABEL[hubOf(card, store)],
  });

  // Seed carriage — qty-0 cells written as ONE ATOMIC multi-path update (Codex fix
  // b: no per-cell partial that could drop the row mid-failure). Seed-if-absent: a
  // fresh read excludes any cell that already exists, so a real quantity is never
  // overwritten (and the SEED rule branch itself rejects a write onto an existing
  // cell). Store for a hub2-stranded product; Hub 2 AND store for a central-stranded
  // one. NO targets, NO requests — the engine's standard + cascade does the refill.
  // The store a Solve acts on. ONE function, because the panel's label and the
  // write MUST agree: this used to be `solveDest[pid] || STORES[0]` here and
  // `solveDest[pid] || STORES.find(qualifying) || STORES[0]` in the render, so
  // with an asymmetric policy — a target row at Trophy but not at Marathon PE,
  // exactly what a per-shop beanie policy creates — the panel read
  // "Solve — carry at Trophy" while this wrote for Marathon PE, found no
  // qualifying sizes there and returned silently. A button that says Trophy,
  // does nothing, and reports nothing: the precise failure this tab is being
  // fixed to abolish. (Kimi review, PR #342.)
  // LOCATION HISTORY (owner rule 2026-09-17, firstBatchCore.js): on the
  // first-batch path the default nomination is history-ranked among the shops
  // the policy allows — the product's own row, its style siblings' shops,
  // its category's placement — from the two nodes this screen already holds
  // (no new reads). The index is ONE walk of the catalogue per /stock change;
  // each card's history is then a lookup. Off the path (hub-stranded, a shop
  // not routed via Hub 2) today's default stands byte-for-byte.
  // ONE INDEX PER SECTION: a product's history is read among the shops of ONE
  // section (the category's placement is "which of THESE shops keeps more of
  // it"), so Marathon PE vs Trophy is judged exactly as before and Pine vs
  // Concrete on its own.
  const placementIndexes = useMemo(() => Object.fromEntries([1, 2].map((sec) => {
    const stores = storeIds(network, { section: sec });
    return [sec, { stores, index: buildPlacementIndex({ products, allStock, stores }) }];
  })), [products, allStock, network]);
  const sectionOfStore = (store) => network.locations[store]?.section;
  const historyFor = (card, store) => {
    const pi = placementIndexes[sectionOfStore(store)] || { stores: [], index: null };
    return firstBatchHistory({ pid: card.pid, product: byId.get(card.pid), index: pi.index, allStock, targets: targetRows, stores: pi.stores });
  };
  // ── THE BLOCKS — one per section this viewer may see ───────────────────────
  // Every store is listed; a store that may not be routed to (not live, its
  // hub not live, or across the wall from a hub-stranded card) carries the
  // sentence that says why and cannot be ticked (solveSections.solveBlocks).
  // The card's division — the list it is on — is the only block offered.
  const divisionOf = (card) => cardSection(card, network);
  // DESTINATIONS FOLLOW THE LIST (Junid, 22 Nov 2026 — divisionDestinations.js):
  // a card offers its OWN division's shops and nothing else. "Missing from
  // Concrete" offers Pine and Concrete; "Missing from Marathon" offers
  // Marathon's shops. (A Concrete-only row used to offer both divisions.)
  const solveSectionsFor = (card) => [divisionOf(card)].filter((x) => mySections.includes(x));
  const blocksFor = (card) => solveBlocks({ network, sections: solveSectionsFor(card), source: card.source, product: byId.get(card.pid), productId: card.pid, engineConfig: cfg });
  const tickableStores = (card) => blocksFor(card).flatMap((b) => b.stores).filter((st) => !st.blocked).map((st) => st.id);
  // HUB PRESENCE (the hard precondition — firstBatchCore.hub2PresenceSignals),
  // judged at the STORE'S OWN hub. From the /stock node this screen already
  // holds plus, when read, the engine's lock table for the product
  // (openLocks). Without the lock read the answer is the static one (cells);
  // the WRITE always judges with the live lock table (solve()). Anything but
  // an explicit `false` keeps the old path (firstBatchEligible fails closed).
  // Presence reads the RAW hub lock node (a lock whose request has closed is
  // still the engine bookkeeping the hub for this product — the server judges
  // the raw node too) and the hold lane's held lines for that hub (units on
  // the way). Both arrive with the lock read (`hubRaw`, `heldByHub`).
  const hubPresentFor = (pid, hub, openByLoc) => hub2PresenceSignals({
    hub2Node: allStock?.[hub]?.[pid],
    hub2Locks: openByLoc ? (openByLoc.hubRaw?.[hub] ?? openByLoc[hub]) : null,
    hub2OpenRequestIds: openByLoc ? openByLoc.openHubRequests?.[hub] : null,
    heldLines: openByLoc ? openByLoc.heldByHub?.[hub] : null, pid,
  }).length > 0;
  // The store's ENGINE route must run through its hub — that is what "kept at
  // the hub" means to the engine, and without it nothing would refill the
  // shop after the first batch. The route is config.routes for a store it
  // names; a LIVE store it does not name (Pine, Concrete) is routed by the
  // registry, as the engine routes it (firstBatchEligible). A store with no
  // engine route takes the old seed-only Solve.
  const eligibleAt = (card, store, openByLoc) => {
    if (cfAt(card, store)) {
      // The DIRECT first batch: Central → the store, no hub presence test.
      return !!cfg && !targetsError
        && firstBatchEligible({ source: card.source, store, product: byId.get(card.pid), productId: card.pid, centralFed: true });
    }
    const hub = hubOf(card, store);
    return !!cfg && !targetsError && !!hub
      && firstBatchEligible({ source: card.source, store, product: byId.get(card.pid), productId: card.pid, hub,
        routes: cfg.routes, network, hub2Present: hubPresentFor(card.pid, hub, openByLoc) });
  };
  // THE DEFAULT TICK — one store, the one the old Solve nominated: within the
  // card's OWN section, the first store with qualifying sizes, history-ranked
  // on the first-batch path. Never a store in the other section: a card on
  // the Section 1 stranded list must not open with Marathon PE or Trophy
  // already ticked and the confirm live (which, while Section 1 is not live,
  // it always would have). The owner can still tick the other section by hand.
  const storeChoiceFor = (card) => {
    const tickable = tickableStores(card);
    const home = cardSection(card, network);
    for (const sec of [home]) {
      const candidates = tickable.filter((st) => sectionOfStore(st) === sec && qualifyingSizes(card, st).length > 0);
      if (!candidates.length) continue;
      const onPath = candidates.some((st) => eligibleAt(card, st, openLocks[card.pid]));
      if (!onPath) return { store: candidates[0], tier: null, sentence: null };
      const c = firstBatchStoreChoice({ history: historyFor(card, candidates[0]), candidates, labels: LOC_LABEL });
      return c.store ? c : { store: candidates[0], tier: null, sentence: null };
    }
    return { store: tickable.find((st) => sectionOfStore(st) === home) || null, tier: null, sentence: null };
  };
  const defaultStoreFor = (card) => storeChoiceFor(card).store;
  // THE TICKS, in the order ticked — which is the order Central's units are
  // dealt in (solveSections.allocationOrder). Untouched, the panel opens with
  // the default store ticked, so "open, confirm" is the Solve it always was.
  const ticksFor = (card) => {
    const tickable = new Set(tickableStores(card));
    const raw = solveTicks[card.pid] ?? [defaultStoreFor(card)].filter(Boolean);
    return allocationOrder({ network, ticked: raw, tickable: (st) => tickable.has(st) });
  };
  // PINE AND CONCRETE ARE ONE OR THE OTHER: on the Concrete list a tap is a
  // switch (the tapped shop on, the other off). Marathon's shops tick freely,
  // as they always have. A tap always changes the selection.
  const toggleTick = (card, store) => {
    const cur = ticksFor(card);
    setSolveTicks((prev) => ({ ...prev, [card.pid]: switchShopPick(cur, store, { exclusive: shopsAreExclusive(network, divisionOf(card)) }) }));
  };

  // CENTRAL'S OPEN RESERVATIONS (2026-09-17, firstBatchCore.js
  // centralReservedBySize). The panel reads the engine's lock node for this
  // product at every routed location ONCE when its Solve panel opens (one
  // scoped read per location); the estimate nets them out, and the confirm
  // waits for the read so the number shown is the number written. solve()
  // re-reads them live, so a lock that lands while the panel is open is
  // still honoured at the moment of the write.
  const [openLocks, setOpenLocks] = useState({});   // pid → { loc: node|null } (undefined = not read yet)
  // The engine's routed locations, plus any store or hub with a switch on
  // that the routes do not name yet (a lock there can still be promising
  // Central's units).
  const routeLocs = useMemo(() => {
    const routed = Object.values(network.locations).filter((l) => l.type !== "central" && (l.solve === true || l.autoRefill !== "off")).map((l) => l.id);
    return [...new Set([...Object.keys(cfg?.routes || {}), ...routed])];
  }, [cfg, network]);
  // The hubs whose presence a Solve of this product can turn on: the hub
  // behind each store with Solve on.
  const presenceHubsFor = (pid) => [...new Set(storeIds(network, { solveOnly: true })
    .map((st) => solveHubFor(network, st, byId.get(pid), pid)).filter((h) => h && solveOn(network, h)))];
  const readOpenLocks = async (pid) => {
    const raw = {};
    await Promise.all(routeLocs.map(async (loc) => {
      raw[loc] = (await get(ref(database, `refill_engine/open/${loc}/${pid}`))).val();
    }));
    const hubs = presenceHubsFor(pid);
    // A lock whose request is gone or closed is dead, not a reservation
    // (firstBatchCore.pruneClosedLocks): one scoped read per lock it names.
    const requestsById = {};
    // OPEN HUB REQUESTS WITHOUT A LOCK (the on-hold "coming tomorrow" flow):
    // a per-product query of /refill_requests needs the productId index —
    // run only once the owner has pasted it and flipped
    // config/refillEngine.refillRequestsProductIdIndex (never a whole-node
    // read from here). Mirrors the trigger (first-batch.cjs openHub2RequestIds).
    const openAtHubs = cfg?.refillRequestsProductIdIndex === true && hubs.length
      ? get(query(ref(database, "refill_requests"), orderByChild("productId"), equalTo(pid))).then((s) => Object.entries(s.val() || {}).filter(([, r]) => r && r.status === "open" && hubs.includes(r.requestingLocation)))
      : Promise.resolve([]);
    const heldByHub = {};
    const [openRows] = await Promise.all([
      openAtHubs,
      ...hubs.map(async (hub) => { heldByHub[hub] = (await get(ref(database, `settings/stockHold/held/${hub}`))).val() ?? null; }),
      ...lockRefillIds(raw).map(async (id) => { requestsById[id] = (await get(ref(database, `refill_requests/${id}`))).val(); }),
    ]);
    const hubRaw = {};
    const openHubRequests = {};
    for (const hub of hubs) {
      hubRaw[hub] = raw[hub] ?? null;
      openHubRequests[hub] = openRows.filter(([, r]) => r.requestingLocation === hub).map(([id]) => id);
    }
    // Non-enumerable extras: centralReservedBySize walks the enumerable
    // locations, and these are inputs to the PRESENCE test only.
    const pruned = pruneClosedLocks({ openByLoc: raw, requestsById });
    Object.defineProperty(pruned, "hubRaw", { value: hubRaw, enumerable: false });
    Object.defineProperty(pruned, "heldByHub", { value: heldByHub, enumerable: false });
    Object.defineProperty(pruned, "openHubRequests", { value: openHubRequests, enumerable: false });
    return pruned;
  };
  useEffect(() => {
    if (!solvePid || !cfg) return undefined;
    // Only a card the first-batch path can take needs Central's reservations
    // read; off the path (and while the path is OFF — FIRST_BATCH_ENABLED)
    // the panel never waits on them, so nothing is read. (Sonnet review of
    // the incident revert: four scoped reads per panel open for a number
    // nothing used.)
    const openCard = (cards || []).find((c) => c.pid === solvePid);
    if (!openCard || !tickableStores(openCard).some((st) => eligibleAt(openCard, st, undefined))) return undefined;
    let live = true;
    const pid = solvePid;
    setOpenLocks((m) => { const n = { ...m }; delete n[pid]; return n; });
    readOpenLocks(pid).then((locks) => { if (live) setOpenLocks((m) => ({ ...m, [pid]: locks })); })
      // an unreadable lock table reads as "nothing promised" — the write
      // re-reads and the engine's own reconcile shrinks any over-ask; the
      // panel just must not stay gated forever
      .catch(() => { if (live) setOpenLocks((m) => ({ ...m, [pid]: {} })); });
    return () => { live = false; };
  }, [solvePid, cfg]);   // eslint-disable-line react-hooks/exhaustive-deps
  const locksReadyFor = (pid) => openLocks[pid] !== undefined;

  // ── THE PLAN — what each ticked store will get (solveSections.js) ──────────
  // One line per ticked store, in tick order. A store on the first-batch path
  // gets its split from what Central has FREE (on hand, less the engine's open
  // reservations, less what the stores ticked before it were dealt), so no
  // unit is promised twice and the quantities shown are the quantities
  // written. `firstBatchOk: false` (the live lock table could not be read at
  // the write) puts every store on the old seed-only path.
  const planFor = (card, ticks, openByLoc = openLocks[card.pid], { firstBatchOk = true } = {}) => {
    const reserved = cfg ? centralReservedBySize({ openByLoc: openByLoc || {}, routes: cfg.routes }) : {};
    return planSectionSolve({
      stores: ticks,
      run: runAt(card, ticks),
      maxUnitsPerIntent: cfg?.maxUnitsPerIntent,
      centralFree: (sz) => centralFreeFor({ qtyAt: (x) => qtyAt(CENTRAL, card.pid, x), reserved, size: sz }),
      storeInfo: (store) => {
        const cf = cfAt(card, store);
        const hub = cf ? null : hubOf(card, store);
        const sizes = qualifyingSizes(card, store);
        const eligible = firstBatchOk && eligibleAt(card, store, openByLoc);
        if (cf) return { hub: null, sizes, eligible, centralFed: true };
        return {
          hub, sizes, eligible,
          // LOCATION HISTORY informs the split (firstBatchCore.
          // firstBatchSizeHints): a size the shop's own history says does not
          // belong there stays at its hub first — the normal route serves it.
          sizeHints: eligible ? firstBatchSizeHints({ history: historyFor(card, store), store, sizes, labels: LOC_LABEL, hub }) : undefined,
        };
      },
    });
  };

  const solve = async (card) => {
    const ticks = ticksFor(card);
    if (solving[card.pid] || resolving[card.pid] || !canAct || !ticks.length) return;
    // ONE DIVISION PER SOLVE — the list's own. A tick from the other division
    // (or a hub across the wall) is refused here, whatever the panel offered.
    const division = divisionOf(card);
    // A Concrete-only row may tick the other division's stores too (see
    // solveSectionsFor) — each still routed through a hub of ITS OWN section.
    const allowed = new Set(solveSectionsFor(card));
    // THE SECOND GATE (divisionDestinations.js): a shop outside this list's
    // division, or Pine and Concrete together, is refused here whatever a
    // screen — a stale one included — offered.
    const wrong = destinationProblem({ network, section: division, destinations: ticks, kind: "product" });
    if (wrong) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store: ticks[0], sizes: [], msg: `Not solved — ${wrong}` } }));
      return;
    }
    const stray = ticks.find((st) => !allowed.has(sectionOfStore(st)) || (!cfAt(card, st) && sectionOfStore(hubOf(card, st) || st) !== sectionOfStore(st)));
    if (stray) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store: stray, sizes: [], msg: `Not solved — ${LOC_LABEL[stray] || stray} is not in ${sectionName(network, division)}. Solve from the "Missing from ${sectionName(network, sectionOfStore(stray))}" list instead.` } }));
      return;
    }
    // Never a hub seed for a sneaker or slide (see `offTab` in the render).
    if (isSneakerOrSlide(byId.get(card.pid))) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store: ticks[0], sizes: [], msg: "Not seeded — sneakers and slides are refilled from the Sneakers tab." } }));
      return;
    }
    // Unreachable while the confirm button is gated on the same stores — but a
    // bare `return` here is a dead button by another name, so it speaks.
    const empty = ticks.find((st) => !qualifyingSizes(card, st).length);
    if (empty) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store: empty, sizes: [], msg: `Nothing to seed at ${LOC_LABEL[empty]} — no refill policy covers this product there.` } }));
      return;
    }
    // FIRST BATCH DIRECT TO SHOP (owner spec 2026-09-17). For an in-scope
    // store — the card Central-stranded, the shop routed via its hub, any
    // category except sneakers and slides (firstBatchCore.js) — the sizes
    // Central can send become the shop's OWN request from Central (Source ›
    // that shop's tab); its hub is seeded too and the server raises the hub's
    // leg when the shop's is fulfilled. Sizes Central has none of follow the
    // old path unchanged. Everything else (hub-stranded, a shop not routed via
    // its hub) is byte-for-byte the old Solve: qty-0 seeds, nothing more.
    const onPath = ticks.some((st) => eligibleAt(card, st, openLocks[card.pid]));
    // ── FAST SOLVE (Junid, 20 Nov 2026) ──────────────────────────────────────
    // MEASURED before (scripts/diag + solveLatency.harness.test.jsx, live
    // RTTs ~180 ms): the row waited on FOUR sequential read waves and the
    // write (~0.9 s), then on the offline mirror's change feed bringing the
    // seeds back to /stock (~1.2–1.6 s more; up to a minute if the live signal
    // is missed) before it left the list. Now:
    //   1. OPTIMISTIC — the row resolves the moment Junid taps (resolving
    //      "pending"); the panel closes. Nothing below blocks the screen.
    //   2. TWO read waves, not four — the live lock table, every /stock row
    //      and every prior-lock snapshot this confirm needs are read IN
    //      PARALLEL (they never depended on each other); only the lock
    //      table's own request lookups follow.
    //   3. The ONE atomic multi-path update, unchanged — then echoed into the
    //      mirror (notePendingUpdate) so the live list drops the card too.
    //   4. A failure brings the row back with the reason in red; nothing was
    //      written (atomic).
    // What is written is byte-for-byte what was written before: the same
    // reads feed the same builders in the same order.
    setSolving((m) => ({ ...m, [card.pid]: true }));
    doneSnap.current[card.pid] = (card.missing || []).join("|");
    setResolving((m) => ({ ...m, [card.pid]: "pending" }));
    setSolvePid((cur) => (cur === card.pid ? null : cur));
    setSolved((d) => { const n = { ...d }; delete n[card.pid]; return n; });
    const uid = auth.currentUser?.uid || null;
    const now = serverNowIso();
    // A Solve seed is TRUSTED from the start (stockTrust.js): Solve is the act
    // that introduces the product here, so the engine may arm the cell at a
    // "solved products only" location before its first batch has even landed.
    const seedCell = (loc) => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: now, updatedBy: uid, ...(trustedCellsOnly(network, loc) ? trustStamp("solve", now) : {}) });
    const many = ticks.length > 1;
    try {
      // Every location this confirm can touch: each ticked store and the hub
      // behind it (a central-fed store has none).
      const touchLocs = [...new Set(ticks.flatMap((st) => (cfAt(card, st) ? [st] : [hubOf(card, st), st])).filter(Boolean))];
      // /stock rows and the solve-time lock snapshots, in parallel with the
      // LIVE lock table (one scoped read per routed location): the split is
      // sized from Central's free at the moment of the write, never from the
      // panel's earlier read. A size the reservations leave nothing of takes
      // the normal path — and if that is every size, the whole Solve does
      // (the seed-only branch below), exactly as when Central had none. An
      // unreadable lock table is an UNKNOWN hub presence: the guard fails
      // closed and this Solve is the old one (hub + shop seeded).
      const rows = {};
      const priorRaw = {};
      let openNow = null;
      await Promise.all([
        onPath ? readOpenLocks(card.pid).then((v) => { openNow = v; }, () => { openNow = null; }) : null,
        ...touchLocs.map(async (loc) => { rows[loc] = (await get(ref(database, `stock/${loc}/${card.pid}`))).val() || {}; }),
        // The engine locks that exist BEFORE this solve, snapshotted into the
        // undo record. Undo blocks on any lock NOT in this snapshot — identity
        // comparison, never clocks: a lock's createdAt is its scan's START
        // time, so a scan spanning the solve would timestamp-classify as
        // "before" while being causally after (substitute pair, PR #361).
        ...touchLocs.map(async (loc) => { priorRaw[loc] = (await get(ref(database, `refill_engine/open/${loc}/${card.pid}`))).val(); }),
      ]);
      const rowOf = (loc) => rows[loc] || {};
      const plan = planFor(card, ticks, openNow || {}, { firstBatchOk: onPath && !!openNow });
      const baseSolveId = solveIdFor(card.pid, serverNowMs());
      const parts = [];      // each store's part of the ONE update
      const entries = [];    // each store's undo record
      const msgs = [];
      for (const line of plan.lines) {
        const { store, hub, sizes } = line;
        // The row's key in the Solved history (chronological, and unique per
        // store, so two shops of one confirm are two rows).
        const key = newSolvedKey(serverNowMs());
        const direct = cfAt(card, store);
        // CENTRAL-FED with nothing Central can send: nothing to write — the
        // sizes stay on "Missing from" until Central has them.
        if (direct && !line.firstBatch) {
          msgs.push(`Nothing sent to ${LOC_LABEL[store]} — Central has none of ${sizes.map(sizeLabel).join(" · ")}; they stay on the Missing list until it does.`);
          continue;
        }
        if (line.firstBatch) {
          const locs = direct ? [store] : [hub, store];
          const existing = {};
          const priorOpen = {};
          for (const loc of locs) {
            existing[loc] = rowOf(loc);
            priorOpen[loc] = openNow[loc] ?? null;
          }
          // One solve id per store: the server stamps it on that shop's lock
          // and on its hub leg, and nets the OTHER shop's lock as a
          // reservation — which it could not do if two shops shared an id.
          const solveId = many ? `${baseSolveId}_${store}` : baseSolveId;
          const { updates, requestIds, paths } = buildFirstBatchSolveUpdate({
            pid: card.pid, store, hub, split: line.split, existing, solveId, nowIso: now, uid,
            seedCell,
            newKey: () => push(ref(database, "refill_requests")).key,
          });
          for (const id of requestIds) {
            const k = `refill_requests/${id}`;
            if (updates[k] && typeof updates[k] === "object") updates[k] = stampRecord(updates[k], "raise");
          }
          parts.push(updates);
          // A direct batch trusts only the store cells of the sizes Central sends.
          const trustSizes = direct ? line.split.firstBatch.map((l) => l.size) : sizes;
          parts.push(trustExistingEmptyUpdates({ pid: card.pid, locs, sizes: trustSizes, existing, nowIso: now, uid, isSolvedLoc: (l) => trustedCellsOnly(network, l), cellTrusted }));
          entries.push({ key, pid: card.pid, name: card.name, store, locs, paths, priorOpen, firstBatch: { solveId, requestIds, store, units: line.units } });
          msgs.push(direct
            ? `${line.units} unit${line.units === 1 ? "" : "s"} requested from Central for ${LOC_LABEL[store]} — Central picks it from Source › ${sourceTab(store)} at the next release; it stays in the shop and refills straight from Central.`
            : `${line.units} unit${line.units === 1 ? "" : "s"} requested from Central for ${LOC_LABEL[store]} — Central picks it from Source › ${sourceTab(store)} at the next release; ${LOC_LABEL[hub]} is seeded now and its own batch follows from Central's remainder.`);
          continue;
        }
        const locs = seedLocations(card.source, store, hub);
        const updates = {};
        const priorOpen = {};
        for (const loc of locs) {
          const existing = rowOf(loc);
          priorOpen[loc] = priorRaw[loc] ?? null;
          for (const sz of sizes) {
            if (existing[stockSizeKey(sz)] === undefined) updates[stockCellPath(loc, card.pid, sz)] = seedCell(loc);
          }
        }
        parts.push(updates);
        const existingRows = {};
        for (const loc of locs) existingRows[loc] = rowOf(loc);
        parts.push(trustExistingEmptyUpdates({ pid: card.pid, locs, sizes, existing: existingRows, nowIso: now, uid, isSolvedLoc: (l) => trustedCellsOnly(network, l), cellTrusted }));
        // Reversible while safe — recorded with the EXACT paths written, so
        // undo can never touch a cell the solve did not create (a cell that
        // already existed was skipped above and must survive an undo).
        if (Object.keys(updates).length) entries.push({ key, pid: card.pid, name: card.name, store, locs, paths: Object.keys(updates), priorOpen });
        msgs.push(`Carrying ${sizes.length} size${sizes.length === 1 ? "" : "s"} at ${LOC_LABEL[store]}${isCentral(card.source, network) ? ` (via ${LOC_LABEL[hub]})` : ""} — the engine will refill on its next scan.`);
      }
      // ONE atomic update for the whole confirm: every store's seeds and
      // requests land together or not at all (the old Solve's contract — a
      // failure leaves NOTHING written and the row comes back for a clean retry).
      const updates = mergeSolveUpdates(parts);
      if (Object.keys(updates).length) {
        await update(ref(database), updates);
        // THE WRITE HAS LANDED. Nothing below may report "nothing changed":
        // a retry would raise the first batch twice (Sonnet review, PR #952 S4).
        setResolving((m) => ({ ...m, [card.pid]: "done" }));
        try {
          // The offline mirror shows this device its own write at once.
          try { notePendingUpdate(updates); } catch { /* the echo is a courtesy */ }
          // Into the Solved history — AFTER the write landed (solvedLog.js).
          const at = serverNowMs();
          const msg = msgs.join(" ");
          const solvedRows = entries.map((e) => {
            const log = buildSolveLogEntry(e, { at, by: uid, byName: actorName, photo: card.photo, msg, division });
            return { ...normalizeSolvedEntry(e.key, log), batch: baseSolveId, log };
          });
          await recordSolved(solvedRows);
        } catch { /* recordSolved already keeps the row for this visit and flags it unsaved */ }
      } else {
        // Nothing to write (a central-fed store Central cannot serve): the
        // row comes back and says so.
        setResolving((m) => { const n = { ...m }; delete n[card.pid]; return n; });
      }
      setSolved((d) => ({ ...d, [card.pid]: { ok: true, store: ticks[0], sizes: plan.lines[0]?.sizes || [], msg: msgs.join(" ") } }));
    } catch (e) {
      // Nothing was written (atomic). The row comes back with the error on it
      // so its Solve button reads "Solve" again — one click re-opens the
      // confirm (which clears this) for a clean retry.
      setResolving((m) => { const n = { ...m }; delete n[card.pid]; return n; });
      setSolvePid((cur) => (cur === card.pid ? null : cur));
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store: ticks[0], sizes: [], msg: `Couldn't solve ${card.name} — nothing changed, retry. (${e?.message || "error"})` } }));
    }
    setSolving((m) => { const n = { ...m }; delete n[card.pid]; return n; });
  };

  // MOVE MANUALLY — by hand, inside the wall. From Central: the hubs and
  // hubs and stores of the LIST'S OWN division (owner rule 8 Oct 2026 — the
  // other division moves from its own list). From a hub: that hub's own
  // division's stores. A location with its switches off can be sent to by hand.
  const destOptions = (card) => {
    const p = byId.get(card.pid);
    const home = divisionOf(card);
    if (!mySections.includes(home)) return [];
    // From a hub: that hub's own division's shops — and only on that
    // division's list (a Concrete-list card can sit in a Marathon hub; it is
    // not moved to Marathon's shops from here).
    if (!isCentral(card.source, network)) return sectionOfStore(card.source) === home ? storeIds(network, { section: home }) : [];
    // From Central: the list's own shops, and its hubs — except on the
    // Concrete list, where everything that is not a sneaker goes to Pine or
    // Concrete and never to a hub (Junid, 22 Nov 2026).
    const hubs = shopsAreExclusive(network, home) ? [] : solveHubsOfSection(network, home, p, card.pid);
    return [...hubs, ...storeIds(network, { section: home })];
  };
  // The stored choice counts only while it is one of THIS list's options — a
  // choice made on the other division's list falls back to the first option.
  const chosenDest = (card) => { const opts = destOptions(card); return opts.includes(dests[card.pid]) ? dests[card.pid] : opts[0]; };
  const qtyOf = (card, s) => {
    const v = edits[`${card.pid}|${s.size}`];
    // Default: seed the destination with a sensible starter (up to 2 per size).
    return Math.max(0, Math.min(v == null ? Math.min(2, s.avail) : v, s.avail));
  };

  const transfer = async (card) => {
    const dest = chosenDest(card);
    if (busyPid || !canAct || !dest) return;
    if (!destOptions(card).includes(dest)) {       // the list's own division only
      setDone((d) => ({ ...d, [card.pid]: { moved: 0, dest, failed: [`${LOC_LABEL[dest] || dest} is not in ${sectionName(network, divisionOf(card))}`] } }));
      return;
    }
    const lines = card.sizes.map((s) => ({ s, qty: qtyOf(card, s) })).filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusyPid(card.pid);
    const batch = `net_${serverNowMs().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { s, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: card.pid, size: s.size, qty,
          from: card.source, to: dest, actorRole,
          reason: "network_rebalance",
          movementId: `${batch}_${card.pid}_${encodeSizeKey(s.size)}`,
          link: { transferId: batch },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += qty; else failed.push(`${s.size}: ${res.reason}`);
    }
    setDone((d) => ({ ...d, [card.pid]: { moved, dest, failed } }));
    setBusyPid(null);
  };

  // ── ONE ROW OF THE SOLVED HISTORY — where it went, who, when, and Undo ─────
  // "Where it went", lower-case so it reads after the name: "…: 4 units
  // requested from Central for Marathon PE" / "… now carried at Trophy".
  const whereText = (u) => {
    if (u.kind === "concrete") return ": made Concrete-only — moved to the Concrete division's list";
    if (u.firstBatch) return `: ${u.firstBatch.units} unit${u.firstBatch.units === 1 ? "" : "s"} requested from Central for ${LOC_LABEL[u.store] || u.store}${u.locs[0] && u.locs[0] !== u.store ? ` (${LOC_LABEL[u.locs[0]] || u.locs[0]}'s batch follows)` : ""}`;
    return ` now carried at ${LOC_LABEL[u.store] || u.store}${u.locs.length > 1 && u.locs[0] !== u.store ? ` (via ${LOC_LABEL[u.locs[0]] || u.locs[0]})` : ""}`;
  };
  const whenText = (at) => {
    if (!at) return "";
    const d = new Date(at);
    return d.toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const canUndo = (u) => (u.kind === "concrete" ? canMarkConcrete : canAct);
  const solvedRow = (u, { compact = false } = {}) => {
    const ui = undoUi[u.key] || {};
    const p = byId.get(u.pid);
    const undone = u.status === "undone";
    return (
      <div key={u.key} data-solved-key={u.key} style={{ ...GLASS, padding: "9px 12px", marginBottom: 8, fontSize: 12.5, opacity: undone ? 0.55 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!compact && (
            <div style={{ width: 44, height: 44, borderRadius: 9, overflow: "hidden", flexShrink: 0, background: "rgba(60,110,255,.1)" }}>
              {(p || u.photo) && <PrimaryPhoto product={p || { id: u.pid, photoUrl: u.photo }} productId={u.pid} snapshot={u.photo || null} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
            </div>
          )}
          <span style={{ flex: 1, minWidth: 0, color: "rgba(255,255,255,.75)" }}>
            {u.kind === "concrete" ? "Concrete — " : "Solved — "}<b style={{ color: "#fff" }}>{u.name}</b>{whereText(u)}
            {!compact && <span style={{ display: "block", fontSize: 11, color: GRAY, marginTop: 2 }}>{[u.byName, whenText(u.at)].filter(Boolean).join(" · ")}{undone ? " · Undone" : ""}</span>}
          </span>
          {!undone && canUndo(u) && (
            <button onClick={() => undoEntry(u)} disabled={!!ui.busy}
                    style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.4)", color: AMBER, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT, flexShrink: 0 }}>
              {ui.busy ? "…" : "Undo"}
            </button>
          )}
        </div>
        {/* The solve's own sentence — what Central does next, what the engine
            will refill (it used to sit on the row, which now leaves at once). */}
        {u.msg && u.kind !== "concrete" && <div style={{ fontSize: 11.5, color: GRAY, lineHeight: 1.4, marginTop: 6 }}>{u.msg}</div>}
        {ui.err && <div style={{ fontSize: 11.5, color: RED, lineHeight: 1.4, marginTop: 6 }}>{ui.err}</div>}
        {u.saved === false && <div style={{ fontSize: 11, color: AMBER, lineHeight: 1.4, marginTop: 6 }}>Not saved to the Solved history ({u.saveErr || "write refused"}) — Undo works until you leave this screen.</div>}
      </div>
    );
  };

  // THE LAST ACTION — the only undo on the main list (one confirm may be
  // several stores, so it is every row of the newest batch still standing).
  // Everything older lives in the Solved tab. It renders in BOTH branches —
  // solving the last card empties the list, and that is exactly when its undo
  // must not vanish.
  const lastBatch = solvedSession[0]?.batch;
  const lastRows = lastBatch ? solvedSession.filter((u) => u.batch === lastBatch && u.status !== "undone") : [];
  // Still saving (a slow or offline line): never a silently missing card.
  const pendingNames = Object.keys(resolving).filter((pid) => resolving[pid] === "pending").map((pid) => byId.get(pid)?.name || pid);
  const savingLine = pendingNames.length ? (
    <div style={{ fontSize: 11.5, color: GRAY, margin: "0 2px 8px" }}>Saving {pendingNames.join(", ")}… it comes back here with the reason if the save fails.</div>
  ) : null;
  const undoStrip = lastRows.length || savingLine ? (
    <div>
      {savingLine}
      {lastRows.map((u) => solvedRow(u, { compact: true }))}
      {onOpenSolved && lastRows.length > 0 && (
        <button onClick={onOpenSolved} style={{ background: "none", border: "none", color: BLUE_L, fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: "0 2px 10px", fontFamily: FONT }}>
          Everything solved → Queued & solved
        </button>
      )}
    </div>
  ) : null;

  // ── THE SOLVED TAB ─────────────────────────────────────────────────────────
  const solvedView = (
      <>
        <div style={{ fontSize: 11.5, color: GRAY, lineHeight: 1.4, marginBottom: 10 }}>
          Everything solved or marked Concrete from Missing Products, newest first. Undo reverses exactly what that action wrote.
        </div>
        {solvedLog.error && <div style={{ fontSize: 11.5, color: AMBER, marginBottom: 8 }}>Couldn't read the saved history ({solvedLog.error}) — showing this visit's actions only.</div>}
        {!solvedAll.length && <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>{solvedLog.settled ? "Nothing solved yet." : "Loading…"}</div>}
        {solvedAll.map((u) => solvedRow(u))}
        {solvedLog.hasMore && (
          <button onClick={solvedLog.loadMore} style={{ ...destChip(false), display: "block", margin: "6px auto 0" }}>Show older</button>
        )}
      </>
  );

  // WHICH DIVISION'S LIST — only for the stand-alone list (the screen has its own).
  const sectionSwitch = !sectionProp && sectionChoices.length > 1 ? (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
      {sectionChoices.map((sec) => (
        <button key={sec} data-division={sec} onClick={() => { setSectionPick(sec); setOpenPid(null); setSolvePid(null); setHidePid(null); exitSelect(); }}
                style={destChip((listSection || HOME_SECTION) === sec)}>
          Missing from {sectionName(network, sec)}
        </button>
      ))}
    </div>
  ) : null;

  const viewOnly = !canAct ? <div style={{ color: AMBER, fontSize: 12.5, marginBottom: 10 }}>You need a stock role to solve or move — viewing only.</div> : null;

  // MARK & HIDE — the bar that turns the list into checkboxes.
  const smallBtn = { background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.12)", color: "rgba(255,255,255,.6)", borderRadius: 10, padding: "9px 12px", minHeight: 40, fontWeight: 600, fontSize: 12.5, cursor: "pointer", fontFamily: FONT };
  const selectBar = canAct && cards.length > 0 ? (
    <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center", justifyContent: "flex-end" }}>
      {selectMode ? (
        <>
          <span style={{ fontSize: 12, color: GRAY, marginRight: "auto" }}>{selectedPids.length} marked — tap cards to mark</span>
          <button data-action="mark-all" onClick={() => setSelected(Object.fromEntries(cards.map((c) => [c.pid, true])))} style={smallBtn}>Mark all ({cards.length})</button>
          <button data-action="mark-cancel" onClick={exitSelect} style={smallBtn}>Cancel</button>
        </>
      ) : (
        <button data-action="mark-and-hide" onClick={() => { setSelectMode(true); setOpenPid(null); setSolvePid(null); setHidePid(null); }} style={smallBtn}>Mark &amp; hide</button>
      )}
    </div>
  ) : null;

  const nameOfLoc = (l) => LOC_LABEL[l] || l;
  const metaOf = (pid) => { const p = byId.get(pid); return [brandOf(p), categoryLabelOf(p, effectiveCategoryKey(p))].join(" · "); };
  // ── ONE CARD ───────────────────────────────────────────────────────────────
  const renderCard = (card) => {
    const product = byId.get(card.pid);
    const { why, holds } = whyProduct(card, { nameOf: nameOfLoc, central: CENTRAL, division: sectionName(network, divisionOf(card)) });
    // Select mode: the card IS the checkbox — panels and actions stand down so
    // a mis-tap can only toggle selection, never move stock.
    if (selectMode) {
      const on = !!selected[card.pid];
      return (
        <MissingCard key={`product:${card.pid}`} pid={card.pid} name={card.name} product={product} photo={card.photo}
          meta={metaOf(card.pid)} why={why} holds={holds}
          select={{ on, toggle: () => setSelected((x) => ({ ...x, [card.pid]: !x[card.pid] })) }} />
      );
    }
        const open = openPid === card.pid;
        const result = done[card.pid];
        const dest = chosenDest(card);
        const total = card.sizes.reduce((t, s) => t + qtyOf(card, s), 0);
        const moveBlocked = moveReason({ canAct, busy: busyPid === card.pid, units: total });
        const sOpen = solvePid === card.pid;
        const sResult = solved[card.pid];
        // THE TICKED STORES, in tick order, and what each will get. Untouched,
        // the one store the old Solve nominated is ticked — a store this
        // product can ACTUALLY be solved at, never simply the first in the
        // list (an asymmetric policy would otherwise open the panel on a
        // store that cannot be confirmed).
        const ticks = sOpen ? ticksFor(card) : [];
        const blocks = sOpen ? blocksFor(card) : [];
        const sPlan = sOpen ? planFor(card, ticks) : null;
        // The history sentence, when history had a say (first-batch path only).
        // When the operator has ticked differently, the line says what
        // history suggested and what was chosen — never "X first" over a
        // panel that is about to send to Y. (Spec review, PR #608.)
        const storeWhy = (() => {
          if (!sOpen) return null;
          const c = storeChoiceFor(card);
          if (!c.sentence) return null;
          if (ticks.length === 1 && ticks[0] === c.store) return c.sentence;
          if (!ticks.length) return c.sentence.replace(/ first — /, " was suggested — ");
          return `${c.sentence.replace(/ first — /, " was suggested — ")} You chose ${ticks.map((st) => LOC_LABEL[st]).join(" + ")}.`;
        })();
        // A sneaker or slide that reached this list (a clothing-typed record
        // with a footwear key) is never seeded here: the old path's hub seed
        // would ARM its carriedOnly hub policy — the exact auto-refill the
        // owner forbids. Its refills live on the Sneakers tab. (Adversarial
        // review, PR #608.)
        const offTab = isSneakerOrSlide(byId.get(card.pid));
        const hOpen = hidePid === card.pid;
        // The confirm button asks the question of EVERY ticked store, which a
        // per-location policy can answer differently from "any store". On the
        // path, the confirm waits for the lock read so the estimate shown IS
        // the request written (never a false "2" over a promised 1).
        const confirmBlocked = sOpen ? (
          (ticks.length ? null : (solveConfirmReason({ canAct, busy: !!solving[card.pid], sizesInPlan: 1 }) || "Tick at least one store."))
          || sPlan.lines.map((l) => solveConfirmReason({ canAct, busy: !!solving[card.pid], sizesInPlan: l.sizes.length, storeLabel: LOC_LABEL[l.store] })).find(Boolean)
          || (sPlan.lines.some((l) => l.split) && !locksReadyFor(card.pid) ? "One moment — checking what Central has already promised…" : null)
        ) : null;
        const anyFirstBatch = !!sPlan && sPlan.lines.some((l) => l.firstBatch);
        // The stores this card could be solved into at all (live, on the
        // right side of the wall).
        const tickable = tickableStores(card);
        // Solvable only if the engine has a standard for at least one of its sizes
        // at at least one store. This used to probe STORES[0] alone, on the grounds
        // that the PE and Trophy size runs are identical — true of defaultRunByStore,
        // but NOT guaranteed of a subcategory policy, which is configured per
        // location and could name one store and not the other. Probing every store
        // keeps the button honest; the panel's own button still re-checks the store
        // actually nominated, so a store with no policy remains unsolvable.
        const policyAtAnyStore = tickable.some((st) => qualifyingSizes(card, st).length > 0);
        // Why it's greyed. Every disabled action on this row now carries its own
        // sentence (actionReasons.js) and renders it as VISIBLE text — the old
        // `whyNot` went to `title=`, a desktop hover tooltip, which on a warehouse
        // tablet is no explanation at all. `solveBlocked` is both the reason string
        // and the disabled test, so the button cannot go grey without the row
        // saying why.
        // (A central-fed store answers N itself — above the kill switch, like the engine.)
        const armed = tickable.some((st) => cfAt(card, st) || seedLocations(card.source, st, hubOf(card, st)).every(ruleOn));
        // The kill switch is only a REMEDY for products the rule branches can
        // serve — and those are nested inside isClothing (see runFor). For a
        // perfume the switch's position changes nothing: on or off, only an
        // explicit row can arm it. So a non-clothing card must never be told
        // "automatic refills are switched off" — that sends the operator to
        // flip a switch that cannot help — and instead falls through to the
        // one-size "needs a target set" sentence, which is the actual remedy.
        // Clothing keeps the real switch state, byte-for-byte. (Sonnet review,
        // PR #350.)
        const solveBlocked = (offTab ? "this is a sneaker or slide — it is refilled from the Sneakers tab, never seeded here." : null) || solveReason({
          canAct, configLoaded: !!cfg, configError: cfgErr, targetsLoaded: targetsReady,
          hasSourceStock: card.units > 0, policyAtAnyStore,
          ruleOnAnywhere: isClothing(byId.get(card.pid)) ? armed : true, targetsError,
          // `.every` is vacuously true on an empty list, which would have called a
          // product with no usable catalogue size "one-size" and told the operator
          // to go and set a target for a size it does not have. (Sonnet, PR #342.)
          oneSize: catalogSizes(card.pid).length > 0 && catalogSizes(card.pid).every((s) => s === "_"),
        });

    const panel = hOpen ? "hide" : sOpen ? "solve" : open ? "move" : null;
    const closePanels = () => { setSolvePid(null); setOpenPid(null); setHidePid(null); };
    const links = [];
    if (destOptions(card).length) links.push({ action: "open-move", label: "Move by hand", onClick: () => { setOpenPid(card.pid); setSolvePid(null); setHidePid(null); setDone((d) => { const n = { ...d }; delete n[card.pid]; return n; }); } });
    if (canAct) links.push({ action: "open-hide", label: "Hide from list", onClick: () => { setHidePid(card.pid); setSolvePid(null); setOpenPid(null); } });
    // CONCRETE (Junid, 20 Nov 2026): one tap makes it Concrete-only — it leaves
    // this Marathon list and appears in the Concrete division's.
    if (canMarkConcrete && divisionOf(card) !== concreteSection(network) && !isConcreteProduct(product)) {
      links.push({ action: "mark-concrete", label: "Make Concrete-only", disabled: !!resolving[card.pid], title: "Concrete-only — sold on the Concrete website only; handled by the Concrete division", onClick: () => markConcrete(card) });
    }
    const notice = sResult ? { ok: !!sResult.ok, text: sResult.msg }
      : result ? { ok: !result.failed.length, text: `${result.moved} units → ${LOC_LABEL[result.dest]}${result.failed.length ? ` · failed: ${result.failed.join(" · ")}` : " ✓"}` }
      : hideErr[card.pid] ? { ok: false, text: hideErr[card.pid] } : null;
    return (
      <MissingCard key={`product:${card.pid}`} pid={card.pid} name={card.name} product={product} photo={card.photo}
        meta={metaOf(card.pid)} why={why} holds={holds}
        onPhoto={onPhoto ? () => onPhoto(product || { id: card.pid, photoUrl: card.photo }) : undefined}
        primary={{ label: "Solve", action: "open-solve", tone: GREEN, disabled: !!solveBlocked, title: solveBlocked,
          onClick: () => { setSolvePid(card.pid); setOpenPid(null); setHidePid(null); setSolved((d) => { const n = { ...d }; delete n[card.pid]; return n; }); } }}
        explains="Starts keeping it at the shop you pick. Central sends the first batch; refills follow by themselves."
        blocked={solveBlocked ? `Solve unavailable — ${solveBlocked}` : null}
        notice={panel ? null : notice} links={links}
        panelOpen={!!panel} onClosePanel={closePanels}>
        {panel === "hide" && <>
                {/* Hide = discretion, not action: the sentence says so, and the
                    reason is one optional tap — never a form, never required. */}
                <div style={{ fontSize: 11.5, color: GRAY, lineHeight: 1.4, marginBottom: 8 }}>
                  Hide from this list only — stock, refills and every other screen carry on as normal. Staff can unhide it from the hidden list.
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {HIDE_REASONS.map((r) => (
                    <button key={r.key} onClick={() => hide(card, r.key)} disabled={hideBusy === card.pid} style={destChip(false)}>
                      {r.label}
                    </button>
                  ))}
                  <button onClick={() => hide(card)} disabled={hideBusy === card.pid} style={destChip(false)}>
                    {hideBusy === card.pid ? "Hiding…" : "Hide without a reason"}
                  </button>
                </div>
                {hideErr[card.pid] && (
                  <div style={{ fontSize: 11.5, color: RED, lineHeight: 1.4, marginTop: 8 }}>{hideErr[card.pid]}</div>
                )}
</>}
        {panel === "solve" && <>
                {/* ONE SCREEN, BOTH SECTIONS: tick the stores this product
                    should be carried at — any in either or both sections —
                    and confirm once. A store that cannot be routed to is
                    listed with its reason and cannot be ticked. */}
                <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "2px 0 6px" }}>
                  Carry at
                </div>
                {blocks.map((b) => (
                  <div key={b.section} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)", margin: "0 0 5px" }}>{b.name}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {b.stores.map((st) => {
                        const on = ticks.includes(st.id);
                        return (
                          <button key={st.id} onClick={() => toggleTick(card, st.id)} disabled={!!st.blocked}
                                  role="checkbox" aria-checked={on} data-dest={st.id} title={st.blocked || undefined}
                                  style={{ ...bigPill(on), ...(st.blocked ? { opacity: 0.4, cursor: "default" } : null) }}>
                            {on ? `✓ ${st.name}` : st.name}
                          </button>
                        );
                      })}
                    </div>
                    {b.stores.filter((st) => st.blocked).map((st) => (
                      <div key={st.id} style={{ fontSize: 11, color: GRAY, lineHeight: 1.4, marginTop: 4 }}>{st.name}: {st.blocked}.</div>
                    ))}
                  </div>
                ))}
                {/* Location history's one line — why this shop is pre-ticked.
                    Informational: the ticks above still decide. */}
                {storeWhy && (
                  <div style={{ fontSize: 11.5, color: GRAY, lineHeight: 1.4, marginTop: 6 }}>{storeWhy}</div>
                )}
                {/* Central is one shelf for every ticked store: the units are
                    dealt in the order ticked, and each line below is what
                    that store will actually get. */}
                {sPlan.lines.length > 1 && (
                  <div style={{ fontSize: 11.5, color: GRAY, lineHeight: 1.4, marginTop: 6 }}>
                    Central's stock is dealt in the order ticked: {sPlan.lines.map((l) => LOC_LABEL[l.store]).join(" → ")}.
                  </div>
                )}
                {/* Inline confirm, one box per ticked store — what gets seeded
                    + what the engine will then want. */}
                {sPlan.lines.map((line) => {
                  const sStore = line.store;
                  // CENTRAL-FED (centralFed.js): no hub — the panel never names one.
                  if (cfAt(card, sStore)) {
                    const cfSplit = line.split;
                    const sent = cfSplit ? cfSplit.firstBatch : [];
                    const none = cfSplit ? cfSplit.normal : line.sizes;
                    return (
                      <div key={sStore} data-central-fed={sStore} style={{ ...GLASS, padding: "10px 12px", marginTop: 10, fontSize: 12.5, color: "rgba(255,255,255,.75)" }}>
                        {sent.length > 0
                          ? <><b style={{ color: "#fff" }}>{line.units} unit{line.units === 1 ? "" : "s"}</b> ({sent.map((l) => `${sizeLabel(l.size)}×${l.qty}`).join(" · ")}) go to <b style={{ color: "#fff" }}>{LOC_LABEL[sStore]}</b> — requested from Central now; Central picks it from Source › {sourceTab(sStore)} at the next release.</>
                          : <>Central has none of this product's sizes — nothing to send to <b style={{ color: "#fff" }}>{LOC_LABEL[sStore]}</b> yet.</>}
                        {sent.length > 0 && none.length > 0 && (
                          <div style={{ marginTop: 5, color: AMBER }}>{none.map(sizeLabel).join(" · ")}: Central has none — they stay on the Missing list until it does.</div>
                        )}
                        <div style={{ marginTop: 5, color: GRAY }}>
                          {divisionCard(card, sStore)
                            ? `${LOC_LABEL[sStore]} keeps this in the shop: ${divisionShopKeep(card)} ${isDivisionOneSize(byId.get(card.pid)) ? "per design" : "of every size"}, refilled straight from Central.`
                            : <>{LOC_LABEL[sStore]} keeps this clothing in the shop: {centralFedPerSize(cfg, network, sStore)} of every size, refilled straight from Central.</>}
                        </div>
                      </div>
                    );
                  }
                  const hubName = LOC_LABEL[line.hub] || line.hub;
                  const fbSplit = line.split;
                  const fb = line.firstBatch ? firstBatchEstimate({ split: fbSplit, run: runFor(card.pid), hub: line.hub }) : null;
                  const plan = solvePlan(card, sStore, sPlan.taken);
                  const unitCap = Number(cfg?.maxUnitsPerIntent) > 0 ? Number(cfg.maxUnitsPerIntent) : 20;
                  const shortLines = fb ? fbSplit.firstBatch.filter((l) => l.qty < Math.min(l.target, unitCap)) : [];
                  return fb ? (
                <div key={sStore} style={{ ...GLASS, padding: "10px 12px", marginTop: 10, fontSize: 12.5, color: "rgba(255,255,255,.75)" }}>
                  <b style={{ color: "#fff" }}>{fb.shopNow} unit{fb.shopNow === 1 ? "" : "s"}</b> ({fbSplit.firstBatch.map((l) => `${sizeLabel(l.size)}×${l.qty}`).join(" · ")}) go to <b style={{ color: "#fff" }}>{LOC_LABEL[sStore]}</b> first — requested from Central now; Central picks it from Source › {sourceTab(sStore)} at the next release.
                  {/* Central ran short for this store (its own stock, or what
                      the stores ticked before it were dealt): say what it wanted. */}
                  {shortLines.length > 0 && (
                    <div style={{ marginTop: 5, color: AMBER }}>
                      Central is short: {shortLines.map((l) => `${sizeLabel(l.size)} ${l.qty} of ${Math.min(l.target, unitCap)}`).join(" · ")}.
                    </div>
                  )}
                  <div style={{ marginTop: 5, color: GRAY }}>
                    {hubName} is seeded now; its own ~<b style={{ color: BLUE_L }}>{fb.hubAfter} units</b> follow automatically from what Central still has — the engine raises them on its next scan, or the fulfil of {LOC_LABEL[sStore]}'s request does.
                  </div>
                  {fb.sizesNormal.length > 0 && (
                    <div style={{ marginTop: 5, color: GRAY }}>
                      {fb.sizesNormal.map(sizeLabel).join(" · ")}: Central has none — seeded at {hubName} + {LOC_LABEL[sStore]} for the engine as usual.
                    </div>
                  )}
                  {/* Location history's say on the SPLIT: sizes held at the hub first. */}
                  {fb.held.map((h) => (
                    <div key={h.size} style={{ marginTop: 5, color: GRAY }}>{h.why || `${sizeLabel(h.size)} stays at ${hubName} first.`}</div>
                  ))}
                  <div style={{ marginTop: 5, color: "rgba(255,255,255,.4)", fontSize: 11 }}>No stock moves now — it moves when Central fulfils; then the normal route resumes.</div>
                </div>
                ) : (
                <div key={sStore} style={{ ...GLASS, padding: "10px 12px", marginTop: 10, fontSize: 12.5, color: "rgba(255,255,255,.75)" }}>
                  {plan.sizes.length === 1 && plan.sizes[0] === "_"
                    ? <b style={{ color: "#fff" }}>One size</b>
                    : <><b style={{ color: "#fff" }}>{plan.sizes.length} size{plan.sizes.length === 1 ? "" : "s"}</b> ({plan.sizes.map(sizeLabel).join(" · ")})</>
                  } → seeds {isCentral(card.source, network) ? <b>{hubName} + {LOC_LABEL[sStore]}</b> : <b>{LOC_LABEL[sStore]}</b>} at qty 0.
                  {/* Location history held EVERY size at the hub first: say so — the
                      operator must see the decision that removed the first batch. */}
                  {fbSplit && fbSplit.held && fbSplit.held.map((h) => (
                    <div key={h.size} style={{ marginTop: 5, color: GRAY }}>{h.why || `${sizeLabel(h.size)} stays at ${hubName} first.`}</div>
                  ))}
                  <div style={{ marginTop: 5, color: GRAY }}>
                    The engine will then want ~<b style={{ color: BLUE_L }}>{plan.storeUnits} units</b> at {LOC_LABEL[sStore]}
                    {plan.twoLeg
                      ? <> · {hubName} pulls ~{plan.hubUnits} from Central ({plan.cover >= plan.hubUnits ? <span style={{ color: GREEN }}>covers ✓</span> : <span style={{ color: AMBER }}>Central has {plan.cover}/{plan.hubUnits}</span>})</>
                      : <> · {hubName} {plan.cover >= plan.storeUnits ? <span style={{ color: GREEN }}>has all {plan.storeUnits} ✓</span> : <span style={{ color: AMBER }}>has {plan.cover}/{plan.storeUnits}</span>}</>}
                  </div>
                  <div style={{ marginTop: 5, color: "rgba(255,255,255,.4)", fontSize: 11 }}>No stock moves now — this just marks it carried; the engine raises the refills.</div>
                </div>
                  );
                })}
                {confirmBlocked && (
                  <div style={{ fontSize: 11.5, color: AMBER, lineHeight: 1.4, marginTop: 8 }}>{confirmBlocked}</div>
                )}
                <button data-action="confirm-solve" onClick={() => solve(card)} disabled={!!confirmBlocked}
                        title={confirmBlocked || undefined}
                        style={{ ...primaryBtn(GREEN, !!confirmBlocked), marginTop: 10 }}>
                  {solving[card.pid] ? (anyFirstBatch ? "Requesting…" : "Seeding…")
                    : sPlan.lines.length === 1
                      ? (sPlan.lines[0].firstBatch ? `Solve — send ${sPlan.lines[0].units} to ${LOC_LABEL[sPlan.lines[0].store]} first` : `Solve — carry at ${LOC_LABEL[sPlan.lines[0].store]}`)
                      : `Solve — ${sPlan.lines.length ? `${sPlan.lines.length} stores` : "tick a store"}`}
                </button>
</>}
        {panel === "move" && <>
                <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "2px 0 6px" }}>
                  Missing from: {card.missing.map((l) => LOC_LABEL[l]).join(" · ")}
                </div>
                <div style={CHIP_GRID}>
                  {card.sizes.map((s) => (
                    <SizeStepperChip key={s.size}
                      size={s.size} qty={qtyOf(card, s)} max={s.avail}
                      onChange={(v) => setEdits((e) => ({ ...e, [`${card.pid}|${s.size}`]: v }))}
                      hint={s.centralNone ? "Central has none" : `${s.avail} at ${LOC_LABEL[card.source]}`}
                      disabled={!canAct || busyPid === card.pid}
                    />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
                  {destOptions(card).map((d) => (
                    <button key={d} data-move-dest={d} onClick={() => setDests((prev) => ({ ...prev, [card.pid]: d }))} style={destChip(dest === d)}>
                      → {LOC_LABEL[d]}
                    </button>
                  ))}
                </div>
                {moveBlocked && (
                  <div style={{ fontSize: 11.5, color: AMBER, lineHeight: 1.4, marginTop: 8 }}>{moveBlocked}</div>
                )}
                <button data-action="confirm-move" onClick={() => transfer(card)} disabled={!!moveBlocked}
                        title={moveBlocked || undefined}
                        style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: moveBlocked ? 0.5 : 1 }}>
                  {busyPid === card.pid ? "Transferring…" : `Transfer ${total} unit${total === 1 ? "" : "s"} to ${LOC_LABEL[dest]}`}
                </button>
</>}
      </MissingCard>
    );
  };

  const bulkBar = (
    <>
      {selectMode && selectedPids.length > 0 && (
        <div style={{ ...GLASS, position: "sticky", bottom: 8, padding: "10px 12px", marginTop: 10, background: "rgba(20,22,30,.97)" }}>
          {/* ONE primary action: hide everything marked, no reason attached —
              the owner's stated flow (2026-08-13). The two reason tags stay
              as secondary chips for the batches that want one. */}
          <button onClick={() => bulkHide()} disabled={bulkBusy}
                  style={{ ...bGreen, width: "100%", padding: "12px", fontSize: 13 }}>
            {bulkBusy ? "Hiding…" : `Hide ${selectedPids.length} marked`}
          </button>
          <div style={{ fontSize: 11, color: GRAY, margin: "8px 0 6px" }}>
            Hides from this list only — stock and refills carry on as normal. Or tag the batch with a reason:
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {HIDE_REASONS.map((r) => (
              <button key={r.key} onClick={() => bulkHide(r.key)} disabled={bulkBusy} style={destChip(false)}>{r.label}</button>
            ))}
          </div>
          {bulkErr && <div style={{ fontSize: 11.5, color: RED, marginTop: 8 }}>{bulkErr}</div>}
        </div>
      )}
    </>
  );

  return { cards, renderCard, sectionSwitch, viewOnly, selectBar, bulkBar, strip: undoStrip, solvedView, selectMode, section: listSection || HOME_SECTION, busy: solveBusy != null || busyPid != null };
}

// THE STAND-ALONE LIST: one division's cards with its own switch (and, with
// view="solved", the Solved history). The Missing Products screen does not use
// this — it calls the hook — but it is the same cards drawn by the same function.
export default function NetworkTransfer(props) {
  const n = useProductSolve(props);
  if (props.view === "solved") return n.solvedView;
  return (
    <>
      {n.viewOnly}
      {n.strip}
      {n.sectionSwitch}
      {n.selectBar}
      {n.cards.length
        ? n.cards.map(n.renderCard)
        : <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>No stranded products — everything upstream also exists in at least one shop.</div>}
      {n.bulkBar}
    </>
  );
}
