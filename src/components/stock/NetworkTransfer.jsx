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
// retires its card instantly. Strictly clothing; strictly existing tokens.

import React, { useEffect, useMemo, useState } from "react";
import { ref, get, update, onValue } from "firebase/database";
import { database, auth } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey, stockCellPath } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { serverNowMs, serverNowIso } from "../../utils/serverTime";
import { seedLocations, solvePlan as computeSolvePlan, qualifyingSizes as computeQualifyingSizes, effectiveStandard, ruleTargetsEnabledFor } from "./solvePlan";
import { computeMissingProducts } from "./missingProductsCore";

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
export default function NetworkTransfer({ products = [], category = "all", allStock = {}, cards: allCards = null }) {
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
  const qtyAt = (loc, pid, size) => Math.max(Number(allStock?.[loc]?.[pid]?.[String(size)]?.qty) || 0, 0);
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
  // The standard THIS product is governed by — subcategory policy where one
  // applies, the size run otherwise (solvePlan.js mirrors resolveTarget).
  const runFor = (pid) => effectiveStandard({
    std: stdRun, subRun, subcategory: byId.get(pid)?.subcategory, sizes: catalogSizes(pid),
  });
  // Sizes safe to seed — a positive standard at every seed location (solvePlan.js).
  // A size with no standard would seed a cell the engine never refills, then vanish
  // with a false "solved", so it's excluded. (Codex fix a.)
  //
  // The rule-switch check is the same guarantee one level up: with rule-based
  // targeting off at a seed location the engine refills NOTHING there by rule, so
  // no size qualifies, whatever the standards say. Returning empty here is what
  // greys the button, disables the confirm action AND makes solve() bail — one
  // choke point rather than three places to keep in step.
  const qualifyingSizes = (card, store) => {
    if (!seedLocations(card.source, store).every(ruleOn)) return [];
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
  const solve = async (card) => {
    const store = solveDest[card.pid] || STORES[0];
    if (solveBusy || !canAct || !store) return;
    const sizes = qualifyingSizes(card, store);
    if (!sizes.length) return; // guarded by the disabled button — never a false success
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
        const sOpen = solvePid === card.pid;
        const sResult = solved[card.pid];
        // Default to a store this product can ACTUALLY be solved at, not simply
        // STORES[0]. With an asymmetric policy (say Trophy rolled out before PE)
        // the outer button is armed because SOME store qualifies, while the panel
        // opened on a store that doesn't — leaving a correctly-disabled confirm
        // button under an enabled Solve, which reads as broken. The operator can
        // still pick either store; this only changes which one is pre-selected.
        const sStore = solveDest[card.pid] || STORES.find((s) => qualifyingSizes(card, s).length > 0) || STORES[0];
        const plan = sOpen ? solvePlan(card, sStore) : null;
        // Solvable only if the engine has a standard for at least one of its sizes
        // at at least one store. This used to probe STORES[0] alone, on the grounds
        // that the PE and Trophy size runs are identical — true of defaultRunByStore,
        // but NOT guaranteed of a subcategory policy, which is configured per
        // location and could name one store and not the other. Probing every store
        // keeps the button honest; the panel's own button still re-checks the store
        // actually nominated, so a store with no policy remains unsolvable.
        const solvable = STORES.some((s) => qualifyingSizes(card, s).length > 0);
        // Why it's greyed — three genuinely different situations that all used to
        // read "no standard sizes", which sent people looking at the product when
        // the answer was the engine's switch or a config still loading.
        const armed = STORES.some((s) => seedLocations(card.source, s).every(ruleOn));
        const whyNot = !cfg ? "Checking the engine's settings…"
          : cfgErr ? "Couldn't read the engine's settings — Solve is off until it loads. Use Move manually."
          : !armed ? "Rule-based refills are switched off — the engine wouldn't refill this, so there's nothing to seed. Use Move manually."
          : "No refill policy covers this product — use Move manually";
        return (
          <ProductCard key={card.pid}
            photo={card.photo} name={card.name}
            badges={<>
              <Badge tone={AMBER}>{card.kind.toUpperCase()}</Badge>
              <Badge tone={BLUE_L}>{card.units} units at {LOC_LABEL[card.source]}</Badge>
            </>}
            right={
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { setSolvePid(sOpen ? null : card.pid); setOpenPid(null); setSolved((d) => { const n = { ...d }; delete n[card.pid]; return n; }); }} disabled={!canAct || !solvable}
                        title={!solvable ? whyNot : undefined}
                        style={{ background: sOpen ? "rgba(74,222,128,.15)" : "rgba(74,222,128,.1)", border: "1px solid rgba(74,222,128,.4)", color: GREEN, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: (canAct && solvable) ? "pointer" : "default", opacity: (canAct && solvable) ? 1 : 0.4, fontFamily: FONT }}>
                  {sOpen ? "Close" : "Solve"}
                </button>
                <button onClick={() => { setOpenPid(open ? null : card.pid); setSolvePid(null); }}
                        style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", borderRadius: 10, padding: "7px 10px", fontWeight: 600, fontSize: 11.5, cursor: "pointer", fontFamily: FONT }}>
                  {open ? "Close" : "Move manually"}
                </button>
              </div>
            }
          >
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
                <button onClick={() => solve(card)} disabled={solveBusy === card.pid || !canAct || plan.sizes.length === 0}
                        style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: solveBusy === card.pid || !canAct || plan.sizes.length === 0 ? 0.5 : 1 }}>
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
                <button onClick={() => transfer(card)} disabled={busyPid === card.pid || total === 0 || !canAct}
                        style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: busyPid === card.pid || total === 0 || !canAct ? 0.5 : 1 }}>
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
