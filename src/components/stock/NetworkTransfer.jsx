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
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { serverNowMs, serverNowIso } from "../../utils/serverTime";
import { seedLocations, solvePlan as computeSolvePlan, qualifyingSizes as computeQualifyingSizes, resolvedRun, ruleTargetsEnabledFor } from "./solvePlan";
import { computeMissingProducts, isClothing, cardSection } from "./missingProductsCore";
import { useMySections } from "../../utils/useMySections";
import { solveOn, sectionName, trustedCellsOnly } from "../../utils/networkRegistry";
import { trustStamp, cellTrusted } from "./stockTrust";
import { centralId, isCentral, storeIds, solveHubFor, solveHubsOfSection } from "./sectionRouting";
import { engineConfigView } from "./policyTemplate";
import { solveBlocks, allocationOrder, planSectionSolve, mergeSolveUpdates, undoablePaths } from "./solveSections";
import { HIDDEN_ROOT, HIDE_REASONS, hideEntry, bulkHideUpdate } from "./hiddenProductsCore";
import { undoCellTxn, solveUndoBlockers } from "./solveUndo";
// FIRST BATCH DIRECT TO SHOP (owner spec 2026-09-17) — see firstBatchCore.js.
import { firstBatchEligible, buildFirstBatchSolveUpdate, trustExistingEmptyUpdates, firstBatchEstimate, firstBatchUndoBlockers, firstBatchUndoCancelTxn, solveIdFor, firstBatchRunId, buildPlacementIndex, firstBatchHistory, firstBatchStoreChoice, firstBatchSizeHints, centralReservedBySize, centralFreeFor, pruneClosedLocks, lockRefillIds, isSneakerOrSlide, hub2PresenceSignals } from "./firstBatchCore";
import { solveReason, solveConfirmReason, moveReason } from "./actionReasons";
import { setUpdateBusy } from "../../update/updateChecker";
import { stampRecord, stampTxn } from "../../device/deviceStamp";

// The section whose list HealthView hands this screen (computeMissingProducts'
// default) — the other section's list is one tap away for a viewer who may
// see it.
const HOME_SECTION = 2;
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
export default function NetworkTransfer({ products = [], category = "all", allStock = {}, cards: allCards = null, targets = null, targetsSettled = false, targetsError = false, undoables: undoablesProp = null, setUndoables: setUndoablesProp = null }) {
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canAct = ["store", "warehouse", "admin"].includes(actorRole);

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
  const listSection = sectionPick && sectionPick !== HOME_SECTION && sectionChoices.includes(sectionPick) ? sectionPick : null;

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
  const [solveBusy, setSolveBusy] = useState(null);
  const [solved, setSolved] = useState({});         // pid → {store, sizes, msg, ok}

  // ── SOLVE UNDO — this session's solves, each reversible while safe ─────────
  // A solved card leaves the list the moment its seed lands, so the undo
  // affordance cannot live on the card: each successful solve is recorded
  // and rendered as a strip above the list. The record and every guard rule
  // live in solveUndo.js. The list itself is OWNED BY HealthView and passed
  // down, so a glance at the Sneakers or Hidden chip — which unmounts this
  // component — cannot silently drop a fresh undo (Sonnet substitute review,
  // PR #361); the local fallback only serves standalone use.
  const [localUndoables, setLocalUndoables] = useState([]);
  const undoables = undoablesProp ?? localUndoables;
  const setUndoables = setUndoablesProp ?? setLocalUndoables;
  // In-flight keys in a ref: the render-closure `u.busy` is stale under a
  // double-tap, and two overlapping undos of one entry would race their own
  // reads (Kimi substitute review, PR #361).
  const undoInFlight = useRef(new Set());
  const undoSolve = async (u) => {
    if (!canAct || u.busy || undoInFlight.current.has(u.key)) return;
    undoInFlight.current.add(u.key);
    setUndoables((l) => l.map((x) => (x.key === u.key ? { ...x, busy: true, err: null } : x)));
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
        const fbBlockers = firstBatchUndoBlockers({ liveRequests: liveFb, storeLabel: LOC_LABEL[u.store] });
        if (fbBlockers.length) {
          setUndoables((l) => l.map((x) => (x.key === u.key ? { ...x, busy: false, err: fbBlockers[0] } : x)));
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
        setUndoables((l) => l.map((x) => (x.key === u.key ? { ...x, busy: false, err: blockers[0] } : x)));
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
        const standing = stood.length ? ` Central had already started on size${stood.length === 1 ? "" : "s"} ${stood.map(sizeLabel).join(", ")} — ${stood.length === 1 ? "that request stands" : "those requests stand"}.` : "";
        setUndoables((l) => l.map((x) => (x.key === u.key ? { ...x, busy: false, err: `${ownPaths.length - kept.length} of ${ownPaths.length} seeded cells removed — the rest took real stock or counts since the solve and were kept. Use Adjust for those.${standing}` } : x)));
      } else {
        // Fully undone: the entry leaves the strip (the card reappearing IS
        // the feedback), and the stale "Solved ✓" banner is cleared so the
        // returning card offers Solve again, not last week's success message.
        setUndoables((l) => l.filter((x) => x.key !== u.key));
        setSolved((d) => { const n = { ...d }; delete n[u.pid]; return n; });
      }
    } catch (e) {
      setUndoables((l) => l.map((x) => (x.key === u.key ? { ...x, busy: false, err: `Couldn't undo — nothing changed, retry. (${e?.message || "error"})` } : x)));
    } finally {
      undoInFlight.current.delete(u.key);
    }
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
  const cards = useMemo(() => {
    // The other section's list is built here, on demand, from the same
    // function (it is not HealthView's to count while that section has no
    // live shop).
    const all = listSection
      ? computeMissingProducts({ allStock, products, network, section: listSection })
      : (allCards || computeMissingProducts({ allStock, products }));
    return category && category !== "all" ? all.filter((c) => c.group === category) : all;
  }, [allCards, allStock, products, category, listSection, network]);

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
    const undoBusy = (undoables || []).some((u) => u?.busy);
    setUpdateBusy("network-transfer", typed || busyPid != null || solveBusy != null || undoBusy || !!bulkBusy || hideBusy != null);
    return () => setUpdateBusy("network-transfer", false);
  }, [cards, edits, busyPid, done, solveBusy, undoables, bulkBusy, hideBusy]);
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
      categoryPolicy: pcfg?.categoryPolicy, categoryKey: byId.get(pid)?.categoryKey,
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
  const qualifyingSizes = (card, store) => {
    if (!targetsReady) return [];
    const hub = hubOf(card, store);
    if (!hub) return [];
    return computeQualifyingSizes(catalogSizes(card.pid), card.source, store, runFor(card.pid), hub);
  };

  // Confirm estimate via the pure helper (solvePlan.js), over the QUALIFYING sizes
  // only — availability closes over live /stock; std falls back if config is slow.
  // `centralTaken` (optional): units of a size this confirm has already dealt
  // to an earlier-ticked store — never shown as available twice.
  const solvePlan = (card, store, centralTaken = null) => computeSolvePlan({
    std: runFor(card.pid),
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
  const blocksFor = (card) => solveBlocks({ network, sections: [divisionOf(card)].filter((s) => mySections.includes(s)), source: card.source, product: byId.get(card.pid), productId: card.pid });
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
  const toggleTick = (card, store) => {
    const cur = ticksFor(card);
    setSolveTicks((prev) => ({ ...prev, [card.pid]: cur.includes(store) ? cur.filter((x) => x !== store) : [...cur, store] }));
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
      run: runFor(card.pid),
      maxUnitsPerIntent: cfg?.maxUnitsPerIntent,
      centralFree: (sz) => centralFreeFor({ qtyAt: (x) => qtyAt(CENTRAL, card.pid, x), reserved, size: sz }),
      storeInfo: (store) => {
        const hub = hubOf(card, store);
        const sizes = qualifyingSizes(card, store);
        const eligible = firstBatchOk && eligibleAt(card, store, openByLoc);
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
    if (solveBusy || !canAct || !ticks.length) return;
    // ONE DIVISION PER SOLVE — the list's own. A tick from the other division
    // (or a hub across the wall) is refused here, whatever the panel offered.
    const division = divisionOf(card);
    const stray = ticks.find((st) => sectionOfStore(st) !== division || sectionOfStore(hubOf(card, st) || st) !== division);
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
    setSolveBusy(card.pid);
    const uid = auth.currentUser?.uid || null;
    const now = serverNowIso();
    // A Solve seed is TRUSTED from the start (stockTrust.js): Solve is the act
    // that introduces the product here, so the engine may arm the cell at a
    // "solved products only" location before its first batch has even landed.
    const seedCell = (loc) => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: now, updatedBy: uid, ...(trustedCellsOnly(network, loc) ? trustStamp("solve", now) : {}) });
    const many = ticks.length > 1;
    try {
      // LIVE lock table first (one scoped read per routed location): the
      // split is sized from Central's free at the moment of the write, never
      // from the panel's earlier read. A size the reservations leave nothing
      // of takes the normal path — and if that is every size, the whole
      // Solve does (the seed-only branch below), exactly as when Central had
      // none. An unreadable lock table is an UNKNOWN hub presence: the guard
      // fails closed and this Solve is the old one (hub + shop seeded).
      let openNow = null;
      if (onPath) { try { openNow = await readOpenLocks(card.pid); } catch { openNow = null; } }
      const plan = planFor(card, ticks, openNow || {}, { firstBatchOk: onPath && !!openNow });
      const baseSolveId = solveIdFor(card.pid, serverNowMs());
      // /stock rows already read in this confirm (two shops share their hub).
      const rows = {};
      const rowOf = async (loc) => {
        if (!(loc in rows)) rows[loc] = (await get(ref(database, `stock/${loc}/${card.pid}`))).val() || {};
        return rows[loc];
      };
      const parts = [];      // each store's part of the ONE update
      const entries = [];    // each store's undo record
      const msgs = [];
      for (const line of plan.lines) {
        const { store, hub, sizes } = line;
        const key = many ? `${card.pid}_${now}_${store}` : `${card.pid}_${now}`;
        if (line.firstBatch) {
          const locs = [hub, store];
          const existing = {};
          const priorOpen = {};
          for (const loc of locs) {
            existing[loc] = await rowOf(loc);
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
          parts.push(trustExistingEmptyUpdates({ pid: card.pid, locs, sizes, existing, nowIso: now, uid, isSolvedLoc: (l) => trustedCellsOnly(network, l), cellTrusted }));
          entries.push({ key, pid: card.pid, name: card.name, store, locs, paths, priorOpen, firstBatch: { solveId, requestIds, store, units: line.units } });
          msgs.push(`${line.units} unit${line.units === 1 ? "" : "s"} requested from Central for ${LOC_LABEL[store]} — Central picks it from Source › ${sourceTab(store)} at the next release; ${LOC_LABEL[hub]} is seeded now and its own batch follows from Central's remainder.`);
          continue;
        }
        const locs = seedLocations(card.source, store, hub);
        const updates = {};
        // The engine locks that exist BEFORE this solve, snapshotted into the
        // undo record. Undo blocks on any lock NOT in this snapshot — identity
        // comparison, never clocks: a lock's createdAt is its scan's START
        // time, so a scan spanning the solve would timestamp-classify as
        // "before" while being causally after (substitute pair, PR #361).
        const priorOpen = {};
        for (const loc of locs) {
          const existing = await rowOf(loc);
          priorOpen[loc] = (await get(ref(database, `refill_engine/open/${loc}/${card.pid}`))).val();
          for (const sz of sizes) {
            if (existing[stockSizeKey(sz)] === undefined) updates[stockCellPath(loc, card.pid, sz)] = seedCell(loc);
          }
        }
        parts.push(updates);
        const existingRows = {};
        for (const loc of locs) existingRows[loc] = await rowOf(loc);
        parts.push(trustExistingEmptyUpdates({ pid: card.pid, locs, sizes, existing: existingRows, nowIso: now, uid, isSolvedLoc: (l) => trustedCellsOnly(network, l), cellTrusted }));
        // Reversible while safe — recorded with the EXACT paths written, so
        // undo can never touch a cell the solve did not create (a cell that
        // already existed was skipped above and must survive an undo).
        if (Object.keys(updates).length) entries.push({ key, pid: card.pid, name: card.name, store, locs, paths: Object.keys(updates), priorOpen });
        msgs.push(`Carrying ${sizes.length} size${sizes.length === 1 ? "" : "s"} at ${LOC_LABEL[store]}${isCentral(card.source, network) ? ` (via ${LOC_LABEL[hub]})` : ""} — the engine will refill on its next scan.`);
      }
      // ONE atomic update for the whole confirm: every store's seeds and
      // requests land together or not at all (the old Solve's contract — a
      // failure leaves NOTHING written and the row stays for a clean retry).
      const updates = mergeSolveUpdates(parts);
      if (Object.keys(updates).length) {
        await update(ref(database), updates);
        setUndoables((l) => [...entries, ...l]);
      }
      setSolved((d) => ({ ...d, [card.pid]: { ok: true, store: ticks[0], sizes: plan.lines[0]?.sizes || [], msg: msgs.join(" ") } }));
    } catch (e) {
      // Nothing was written (atomic). Collapse the panel and surface the error on
      // the row so its Solve button reads "Solve" again — one click re-opens the
      // confirm (which clears this) for a clean retry.
      setSolvePid((cur) => (cur === card.pid ? null : cur));
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store: ticks[0], sizes: [], msg: `Couldn't seed — nothing changed, retry. (${e?.message || "error"})` } }));
    }
    setSolveBusy(null);
  };

  // MOVE MANUALLY — by hand, inside the wall. From Central: the hubs and
  // hubs and stores of the LIST'S OWN division (owner rule 8 Oct 2026 — the
  // other division moves from its own list). From a hub: that hub's own
  // division's stores. A location with its switches off can be sent to by hand.
  const destOptions = (card) => {
    const p = byId.get(card.pid);
    if (!isCentral(card.source, network)) return storeIds(network, { section: sectionOfStore(card.source) });
    const home = divisionOf(card);
    return mySections.includes(home) ? [...solveHubsOfSection(network, home, p, card.pid), ...storeIds(network, { section: home })] : [];
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

  // The undo strip renders in BOTH branches — solving the last card empties
  // the list, and that is exactly when its undo must not vanish.
  const undoStrip = undoables.map((u) => (
    <div key={u.key} style={{ ...GLASS, padding: "9px 12px", marginBottom: 8, fontSize: 12.5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ flex: 1, color: "rgba(255,255,255,.75)" }}>
          {u.firstBatch
            ? <>Solved — <b style={{ color: "#fff" }}>{u.name}</b>: {u.firstBatch.units} unit{u.firstBatch.units === 1 ? "" : "s"} requested from Central for {LOC_LABEL[u.store]} ({LOC_LABEL[u.locs[0]]}'s batch follows)</>
            : <>Solved — <b style={{ color: "#fff" }}>{u.name}</b> now carried at {LOC_LABEL[u.store]}{u.locs.length > 1 && u.locs[0] !== u.store ? ` (via ${LOC_LABEL[u.locs[0]]})` : ""}</>}
        </span>
        {canAct && (
          <button onClick={() => undoSolve(u)} disabled={u.busy}
                  style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.4)", color: AMBER, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT, flexShrink: 0 }}>
            {u.busy ? "…" : "Undo"}
          </button>
        )}
      </div>
      {u.err && <div style={{ fontSize: 11.5, color: RED, lineHeight: 1.4, marginTop: 6 }}>{u.err}</div>}
    </div>
  ));

  // WHICH SECTION'S LIST — only when this viewer has more than one to look at.
  const sectionSwitch = sectionChoices.length > 1 ? (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
      {sectionChoices.map((sec) => (
        <button key={sec} onClick={() => { setSectionPick(sec); setOpenPid(null); setSolvePid(null); setHidePid(null); exitSelect(); }}
                style={destChip((listSection || HOME_SECTION) === sec)}>
          Missing from {sectionName(network, sec)}
        </button>
      ))}
    </div>
  ) : null;

  if (!cards.length) {
    return <>
      {undoStrip}
      {sectionSwitch}
      <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>No stranded products — everything upstream also exists in at least one shop.</div>
    </>;
  }

  return (
    <>
      {!canAct && <div style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>You need a stock role to transfer — viewing only.</div>}
      {undoStrip}
      {sectionSwitch}
      {canAct && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center", justifyContent: "flex-end" }}>
          {selectMode ? (
            <>
              <span style={{ fontSize: 11.5, color: GRAY, marginRight: "auto" }}>{selectedPids.length} marked — tap cards to mark</span>
              <button onClick={() => setSelected(Object.fromEntries(cards.map((c) => [c.pid, true])))}
                      style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", borderRadius: 10, padding: "7px 10px", fontWeight: 600, fontSize: 11.5, cursor: "pointer", fontFamily: FONT }}>
                Mark all ({cards.length})
              </button>
              <button onClick={exitSelect}
                      style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", borderRadius: 10, padding: "7px 10px", fontWeight: 600, fontSize: 11.5, cursor: "pointer", fontFamily: FONT }}>
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => { setSelectMode(true); setOpenPid(null); setSolvePid(null); setHidePid(null); }}
                    style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.4)", borderRadius: 10, padding: "7px 10px", fontWeight: 600, fontSize: 11.5, cursor: "pointer", fontFamily: FONT }}>
              Mark &amp; hide
            </button>
          )}
        </div>
      )}
      {cards.map((card) => {
        // Select mode: the card IS the checkbox — panels and actions stand
        // down so a mis-tap can only toggle selection, never move stock.
        if (selectMode) {
          const on = !!selected[card.pid];
          const toggle = () => setSelected((s) => ({ ...s, [card.pid]: !s[card.pid] }));
          return (
            <div key={card.pid} role="checkbox" aria-checked={on} tabIndex={0} onClick={toggle}
                 onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
                 style={{ cursor: "pointer" }}>
              <ProductCard
                photo={card.photo} name={card.name}
                badges={<>
                  <Badge tone={AMBER}>{card.kind.toUpperCase()}</Badge>
                  <Badge tone={BLUE_L}>{card.units} units at {LOC_LABEL[card.source]}</Badge>
                </>}
                right={
                  <div style={{ width: 26, height: 26, borderRadius: 13, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14,
                                border: on ? "1px solid rgba(74,222,128,.6)" : "1px solid rgba(255,255,255,.2)",
                                background: on ? "rgba(74,222,128,.2)" : "rgba(255,255,255,.03)", color: on ? GREEN : "rgba(255,255,255,.3)" }}>
                    {on ? "✓" : ""}
                  </div>
                }
              />
            </div>
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
          (ticks.length ? null : (solveConfirmReason({ canAct, busy: solveBusy === card.pid, sizesInPlan: 1 }) || "Tick at least one store."))
          || sPlan.lines.map((l) => solveConfirmReason({ canAct, busy: solveBusy === card.pid, sizesInPlan: l.sizes.length, storeLabel: LOC_LABEL[l.store] })).find(Boolean)
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
        const armed = tickable.some((st) => seedLocations(card.source, st, hubOf(card, st)).every(ruleOn));
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
        return (
          <ProductCard key={card.pid}
            photo={card.photo} name={card.name}
            badges={<>
              <Badge tone={AMBER}>{card.kind.toUpperCase()}</Badge>
              <Badge tone={BLUE_L}>{card.units} units at {LOC_LABEL[card.source]}</Badge>
            </>}
            right={
              // The action row keeps the card's established language — ONE
              // green primary (Solve), ONE ghost secondary (Move manually).
              // Hide is deliberately NOT a third button box: as one it read
              // as a disabled sibling and crowded the name column (owner
              // feedback, 2026-08-13). It rides below the row as a small dim
              // text control — subordinate, but a full-size tap target.
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { setSolvePid(sOpen ? null : card.pid); setOpenPid(null); setHidePid(null); setSolved((d) => { const n = { ...d }; delete n[card.pid]; return n; }); }} disabled={!!solveBlocked}
                        title={solveBlocked || undefined}
                        style={{ background: sOpen ? "rgba(74,222,128,.15)" : "rgba(74,222,128,.1)", border: "1px solid rgba(74,222,128,.4)", color: GREEN, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: solveBlocked ? "default" : "pointer", opacity: solveBlocked ? 0.4 : 1, fontFamily: FONT }}>
                  {sOpen ? "Close" : "Solve"}
                </button>
                <button onClick={() => { setOpenPid(open ? null : card.pid); setSolvePid(null); setHidePid(null); }}
                        style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", borderRadius: 10, padding: "7px 10px", fontWeight: 600, fontSize: 11.5, cursor: "pointer", fontFamily: FONT }}>
                  {open ? "Close" : "Move manually"}
                </button>
              </div>
              {canAct && (
                <button onClick={() => { setHidePid(hOpen ? null : card.pid); setSolvePid(null); setOpenPid(null); }}
                        /* dim but not small: the visual is a text link, the
                           HIT AREA is button-sized (CodeRabbit, PR #359 — a
                           1px-padded target on a warehouse tablet is a miss) */
                        style={{ background: "none", border: "none", color: "rgba(255,255,255,.35)", fontSize: 11, fontWeight: 600, cursor: "pointer", padding: "8px 6px 4px", margin: "-6px -4px 0", minHeight: 28, fontFamily: FONT }}>
                  {hOpen ? "Cancel" : "Hide from list"}
                </button>
              )}
              </div>
            }
          >
            {/* NEVER A SILENTLY DEAD BUTTON. Whenever Solve is greyed the row says
                why, in the same words the (hover-only, tablet-invisible) tooltip
                used to hide. It sits above the panels so it is readable with the
                row collapsed — which is the state an operator meets it in. */}
            {solveBlocked && (
              <div style={{ fontSize: 11.5, color: AMBER, lineHeight: 1.4, marginBottom: sOpen || open || hOpen ? 8 : 0 }}>
                Solve unavailable — {solveBlocked}
              </div>
            )}
            {hOpen ? (
              <>
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
              </>
            ) : sResult ? (
              <div style={{ fontSize: 12.5 }}>
                <span style={{ color: sResult.ok ? GREEN : RED, fontWeight: 700 }}>{sResult.msg}</span>
              </div>
            ) : sOpen ? (
              <>
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
                                  role="checkbox" aria-checked={on} title={st.blocked || undefined}
                                  style={{ ...destChip(on), ...(st.blocked ? { opacity: 0.4, cursor: "default" } : null) }}>
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
                <button onClick={() => solve(card)} disabled={!!confirmBlocked}
                        title={confirmBlocked || undefined}
                        style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: confirmBlocked ? 0.5 : 1 }}>
                  {solveBusy === card.pid ? (anyFirstBatch ? "Requesting…" : "Seeding…")
                    : sPlan.lines.length === 1
                      ? (sPlan.lines[0].firstBatch ? `Solve — send ${sPlan.lines[0].units} to ${LOC_LABEL[sPlan.lines[0].store]} first` : `Solve — carry at ${LOC_LABEL[sPlan.lines[0].store]}`)
                      : `Solve — ${sPlan.lines.length ? `${sPlan.lines.length} stores` : "tick a store"}`}
                </button>
              </>
            ) : result ? (
              <div style={{ fontSize: 12.5 }}>
                <span style={{ color: GREEN, fontWeight: 700 }}>{result.moved} units → {LOC_LABEL[result.dest]} ✓</span>
                {result.failed.length > 0 && <div style={{ color: RED, marginTop: 4 }}>Failed: {result.failed.join(" · ")}</div>}
              </div>
            ) : open && (
              <>
                <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "2px 0 6px" }}>
                  Missing from: {card.missing.map((l) => LOC_LABEL[l]).join(" · ")}
                </div>
                <div style={CHIP_GRID}>
                  {card.sizes.map((s) => (
                    <SizeStepperChip key={s.size}
                      size={s.size} qty={qtyOf(card, s)} max={s.avail}
                      onChange={(v) => setEdits((e) => ({ ...e, [`${card.pid}|${s.size}`]: v }))}
                      hint={`${s.avail} at ${LOC_LABEL[card.source]}`}
                      disabled={!canAct || busyPid === card.pid}
                    />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
                  {destOptions(card).map((d) => (
                    <button key={d} onClick={() => setDests((prev) => ({ ...prev, [card.pid]: d }))} style={destChip(dest === d)}>
                      → {LOC_LABEL[d]}
                    </button>
                  ))}
                </div>
                {moveBlocked && (
                  <div style={{ fontSize: 11.5, color: AMBER, lineHeight: 1.4, marginTop: 8 }}>{moveBlocked}</div>
                )}
                <button onClick={() => transfer(card)} disabled={!!moveBlocked}
                        title={moveBlocked || undefined}
                        style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: moveBlocked ? 0.5 : 1 }}>
                  {busyPid === card.pid ? "Transferring…" : `Transfer ${total} unit${total === 1 ? "" : "s"} to ${LOC_LABEL[dest]}`}
                </button>
              </>
            )}
          </ProductCard>
        );
      })}
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
}
