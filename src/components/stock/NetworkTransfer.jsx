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
// Data is computed LIVE from /stock (not the scan snapshot) so a transfer
// retires its card instantly. Clothing and perfume (2026-08-13 — see
// missingProductsCore's isPerfume note); strictly existing tokens.

import React, { useEffect, useMemo, useState } from "react";
import { ref, get, update, onValue } from "firebase/database";
import { database, auth } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey, stockCellPath, decodedCellKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { serverNowMs, serverNowIso } from "../../utils/serverTime";
import { seedLocations, solvePlan as computeSolvePlan, qualifyingSizes as computeQualifyingSizes, resolvedRun, ruleTargetsEnabledFor } from "./solvePlan";
import { computeMissingProducts, isClothing } from "./missingProductsCore";
import { solveReason, solveConfirmReason, moveReason } from "./actionReasons";

const STORES = ["marathon-pe", "trophy"];
const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
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
export default function NetworkTransfer({ products = [], category = "all", allStock = {}, cards: allCards = null, targets = null, targetsSettled = false, targetsError = false }) {
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canAct = ["store", "warehouse", "admin"].includes(actorRole);

  const [openPid, setOpenPid] = useState(null);
  const [dests, setDests] = useState({});     // pid → chosen destination
  const [edits, setEdits] = useState({});     // `${pid}|${size}` → qty
  const [busyPid, setBusyPid] = useState(null);
  const [done, setDone] = useState({});       // pid → {moved, dest, failed[]}

  // Solve (engine-managed) — separate from the manual transfer above.
  const [solvePid, setSolvePid] = useState(null);   // which row's Solve panel is open
  const [solveDest, setSolveDest] = useState({});   // pid → nominated store
  const [solveBusy, setSolveBusy] = useState(null);
  const [solved, setSolved] = useState({});         // pid → {store, sizes, msg, ok}

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
  const std = cfg?.defaultRunByStore;
  const subRun = cfg?.subcategoryRunByLocation;
  // Mirrors the engine's kill switch exactly (solvePlan.js). Absent → off.
  const ruleOn = (dest) => ruleTargetsEnabledFor(cfg?.ruleBasedTargets, dest);

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
    const all = allCards || computeMissingProducts({ allStock, products });
    return category && category !== "all" ? all.filter((c) => c.group === category) : all;
  }, [allCards, allStock, products, category]);

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
      targets: targetRows, pid, ruleBasedTargets: cfg?.ruleBasedTargets,
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
  const qualifyingSizes = (card, store) => {
    if (!targetsReady) return [];
    return computeQualifyingSizes(catalogSizes(card.pid), card.source, store, runFor(card.pid));
  };

  // Confirm estimate via the pure helper (solvePlan.js), over the QUALIFYING sizes
  // only — availability closes over live /stock; std falls back if config is slow.
  const solvePlan = (card, store) => computeSolvePlan({
    std: runFor(card.pid),
    sizes: qualifyingSizes(card, store),
    source: card.source,
    store,
    availAt: (loc, sz) => qtyAt(loc, card.pid, sz),
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
  const defaultStoreFor = (card) => STORES.find((s) => qualifyingSizes(card, s).length > 0) || STORES[0];
  const storeFor = (card) => solveDest[card.pid] || defaultStoreFor(card);

  const solve = async (card) => {
    const store = storeFor(card);
    if (solveBusy || !canAct || !store) return;
    const sizes = qualifyingSizes(card, store);
    // Unreachable while the confirm button is gated on the same store — but a
    // bare `return` here is a dead button by another name, so it speaks.
    if (!sizes.length) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store, sizes: [], msg: `Nothing to seed at ${LOC_LABEL[store]} — no refill policy covers this product there.` } }));
      return;
    }
    const locs = seedLocations(card.source, store);
    setSolveBusy(card.pid);
    const uid = auth.currentUser?.uid || null;
    const now = serverNowIso();
    const okMsg = `Carrying ${sizes.length} size${sizes.length === 1 ? "" : "s"} at ${LOC_LABEL[store]}${card.source === "central" ? " (via Hub 2)" : ""} — the engine will refill on its next scan.`;
    try {
      const updates = {};
      for (const loc of locs) {
        const existing = (await get(ref(database, `stock/${loc}/${card.pid}`))).val() || {};
        for (const sz of sizes) {
          if (existing[encodeSizeKey(sz)] === undefined) {
            updates[stockCellPath(loc, card.pid, sz)] = { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: now, updatedBy: uid };
          }
        }
      }
      // All-or-nothing: one update() writes every absent cell together, so a
      // failure leaves NOTHING seeded and the row stays for a clean retry.
      if (Object.keys(updates).length) await update(ref(database), updates);
      setSolved((d) => ({ ...d, [card.pid]: { ok: true, store, sizes, msg: okMsg } }));
    } catch (e) {
      // Nothing was written (atomic). Collapse the panel and surface the error on
      // the row so its Solve button reads "Solve" again — one click re-opens the
      // confirm (which clears this) for a clean retry.
      setSolvePid((cur) => (cur === card.pid ? null : cur));
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, store, sizes, msg: `Couldn't seed — nothing changed, retry. (${e?.message || "error"})` } }));
    }
    setSolveBusy(null);
  };

  const destOptions = (card) => (card.source === "central" ? ["hub2", ...STORES] : STORES);
  const qtyOf = (card, s) => {
    const v = edits[`${card.pid}|${s.size}`];
    // Default: seed the destination with a sensible starter (up to 2 per size).
    return Math.max(0, Math.min(v == null ? Math.min(2, s.avail) : v, s.avail));
  };

  const transfer = async (card) => {
    const dest = dests[card.pid] || destOptions(card)[0];
    if (busyPid || !canAct || !dest) return;
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

  if (!cards.length) {
    return <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>No stranded products — everything upstream also exists in at least one shop.</div>;
  }

  return (
    <>
      {!canAct && <div style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>You need a stock role to transfer — viewing only.</div>}
      {cards.map((card) => {
        const open = openPid === card.pid;
        const result = done[card.pid];
        const dest = dests[card.pid] || destOptions(card)[0];
        const total = card.sizes.reduce((t, s) => t + qtyOf(card, s), 0);
        const moveBlocked = moveReason({ canAct, busy: busyPid === card.pid, units: total });
        const sOpen = solvePid === card.pid;
        const sResult = solved[card.pid];
        // Default to a store this product can ACTUALLY be solved at, not simply
        // STORES[0]. With an asymmetric policy (say Trophy rolled out before PE)
        // the outer button is armed because SOME store qualifies, while the panel
        // opened on a store that doesn't — leaving a correctly-disabled confirm
        // button under an enabled Solve, which reads as broken. The operator can
        // still pick either store; this only changes which one is pre-selected.
        const sStore = storeFor(card);
        const plan = sOpen ? solvePlan(card, sStore) : null;
        // The confirm button asks the question of the ONE nominated store, which
        // a per-location policy can answer differently from "any store".
        const confirmBlocked = sOpen ? solveConfirmReason({
          canAct, busy: solveBusy === card.pid, sizesInPlan: plan.sizes.length, storeLabel: LOC_LABEL[sStore],
        }) : null;
        // Solvable only if the engine has a standard for at least one of its sizes
        // at at least one store. This used to probe STORES[0] alone, on the grounds
        // that the PE and Trophy size runs are identical — true of defaultRunByStore,
        // but NOT guaranteed of a subcategory policy, which is configured per
        // location and could name one store and not the other. Probing every store
        // keeps the button honest; the panel's own button still re-checks the store
        // actually nominated, so a store with no policy remains unsolvable.
        const policyAtAnyStore = STORES.some((s) => qualifyingSizes(card, s).length > 0);
        // Why it's greyed. Every disabled action on this row now carries its own
        // sentence (actionReasons.js) and renders it as VISIBLE text — the old
        // `whyNot` went to `title=`, a desktop hover tooltip, which on a warehouse
        // tablet is no explanation at all. `solveBlocked` is both the reason string
        // and the disabled test, so the button cannot go grey without the row
        // saying why.
        const armed = STORES.some((s) => seedLocations(card.source, s).every(ruleOn));
        // The kill switch is only a REMEDY for products the rule branches can
        // serve — and those are nested inside isClothing (see runFor). For a
        // perfume the switch's position changes nothing: on or off, only an
        // explicit row can arm it. So a non-clothing card must never be told
        // "automatic refills are switched off" — that sends the operator to
        // flip a switch that cannot help — and instead falls through to the
        // one-size "needs a target set" sentence, which is the actual remedy.
        // Clothing keeps the real switch state, byte-for-byte. (Sonnet review,
        // PR #350.)
        const solveBlocked = solveReason({
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
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { setSolvePid(sOpen ? null : card.pid); setOpenPid(null); setSolved((d) => { const n = { ...d }; delete n[card.pid]; return n; }); }} disabled={!!solveBlocked}
                        title={solveBlocked || undefined}
                        style={{ background: sOpen ? "rgba(74,222,128,.15)" : "rgba(74,222,128,.1)", border: "1px solid rgba(74,222,128,.4)", color: GREEN, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: solveBlocked ? "default" : "pointer", opacity: solveBlocked ? 0.4 : 1, fontFamily: FONT }}>
                  {sOpen ? "Close" : "Solve"}
                </button>
                <button onClick={() => { setOpenPid(open ? null : card.pid); setSolvePid(null); }}
                        style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", borderRadius: 10, padding: "7px 10px", fontWeight: 600, fontSize: 11.5, cursor: "pointer", fontFamily: FONT }}>
                  {open ? "Close" : "Move manually"}
                </button>
              </div>
            }
          >
            {/* NEVER A SILENTLY DEAD BUTTON. Whenever Solve is greyed the row says
                why, in the same words the (hover-only, tablet-invisible) tooltip
                used to hide. It sits above the panels so it is readable with the
                row collapsed — which is the state an operator meets it in. */}
            {solveBlocked && (
              <div style={{ fontSize: 11.5, color: AMBER, lineHeight: 1.4, marginBottom: sOpen || open ? 8 : 0 }}>
                Solve unavailable — {solveBlocked}
              </div>
            )}
            {sResult ? (
              <div style={{ fontSize: 12.5 }}>
                <span style={{ color: sResult.ok ? GREEN : RED, fontWeight: 700 }}>{sResult.msg}</span>
              </div>
            ) : sOpen ? (
              <>
                {/* Nominate the store this product should be carried at. */}
                <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "2px 0 6px" }}>
                  Carry at
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {STORES.map((s) => (
                    <button key={s} onClick={() => setSolveDest((prev) => ({ ...prev, [card.pid]: s }))} style={destChip(sStore === s)}>
                      {LOC_LABEL[s]}
                    </button>
                  ))}
                </div>
                {/* Inline confirm — what gets seeded + what the engine will then want. */}
                <div style={{ ...GLASS, padding: "10px 12px", marginTop: 10, fontSize: 12.5, color: "rgba(255,255,255,.75)" }}>
                  {plan.sizes.length === 1 && plan.sizes[0] === "_"
                    ? <b style={{ color: "#fff" }}>One size</b>
                    : <><b style={{ color: "#fff" }}>{plan.sizes.length} size{plan.sizes.length === 1 ? "" : "s"}</b> ({plan.sizes.map(sizeLabel).join(" · ")})</>
                  } → seeds {card.source === "central" ? <b>Hub 2 + {LOC_LABEL[sStore]}</b> : <b>{LOC_LABEL[sStore]}</b>} at qty 0.
                  <div style={{ marginTop: 5, color: GRAY }}>
                    The engine will then want ~<b style={{ color: BLUE_L }}>{plan.storeUnits} units</b> at {LOC_LABEL[sStore]}
                    {plan.twoLeg
                      ? <> · Hub 2 pulls ~{plan.hubUnits} from Central ({plan.cover >= plan.hubUnits ? <span style={{ color: GREEN }}>covers ✓</span> : <span style={{ color: AMBER }}>Central has {plan.cover}/{plan.hubUnits}</span>})</>
                      : <> · Hub 2 {plan.cover >= plan.storeUnits ? <span style={{ color: GREEN }}>has all {plan.storeUnits} ✓</span> : <span style={{ color: AMBER }}>has {plan.cover}/{plan.storeUnits}</span>}</>}
                  </div>
                  <div style={{ marginTop: 5, color: "rgba(255,255,255,.4)", fontSize: 11 }}>No stock moves now — this just marks it carried; the engine raises the refills.</div>
                </div>
                {confirmBlocked && (
                  <div style={{ fontSize: 11.5, color: AMBER, lineHeight: 1.4, marginTop: 8 }}>{confirmBlocked}</div>
                )}
                <button onClick={() => solve(card)} disabled={!!confirmBlocked}
                        title={confirmBlocked || undefined}
                        style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: confirmBlocked ? 0.5 : 1 }}>
                  {solveBusy === card.pid ? "Seeding…" : `Solve — carry at ${LOC_LABEL[sStore]}`}
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
    </>
  );
}
