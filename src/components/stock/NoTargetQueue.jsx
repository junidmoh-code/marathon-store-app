// ─── DECISION QUEUE — GENUINE business decisions ONLY (owner v8, 2026-07-13) ──
// This is where products are INTRODUCED into the inventory network, primarily
// by Central:
//
//   Supplier → receive into Central → unpack/count/QC (Receiving Session keeps
//   the engine paused) → THIS QUEUE → distribute → the engine takes over.
//
// v8 split: a product already circulating at PE/Trophy/Hub 2 with no targets is
// NOT new and NOT a decision — the approved standard run already covers it. It
// belongs to the one-tap "Introduce Existing Products" migration on the Health
// screen (IntroduceExisting.jsx) and NEVER appears here. Classification is in
// LOCKSTEP with functions/lib/refill-engine.cjs — change both together.
//
// Card kinds that remain (all clothing, live-computed, cards clear instantly):
//   NEW PRODUCT     — stock at Central ONLY (no stock at any destination, no
//                     targets anywhere): genuinely entering the business for
//                     the first time. The introduction wizard sets targets and
//                     suggests the initial distribution — the one place target
//                     quantities are a business decision.
//   NO STANDARD RUN — circulating with no targets, but its stocked sizes are
//                     numeric (jeans etc.): no approved standard quantities
//                     exist, a human must set them.
//   UNCONFIGURED    — stock at a location with no target THERE for a product
//                     that HAS targets elsewhere: include, transfer, or exclude.
// All kinds support the two postponements (never a permanent blind spot):
//   Remind me later          — 30/60/90 days, then the card returns
//   Ignore until stock moves — suppressed until the product's network-wide
//                              stock fingerprint changes (any receive / sale /
//                              transfer resurfaces it)

import React, { useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { useStockCells, useStockTargets, useTargetDecisions, useEngineConfig } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { isDeactivated } from "../../utils/deactivation";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, SizeFactChip, CHIP_GRID } from "./healthWidgets";
import { computeUnintroduced, stockedStandardSizes, destsFrom, effectiveRun } from "./introduceExistingCore";
import { categoryPolicyLocs } from "./solvePlan";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { sizeRank } from "./hubSizeRank";

const ALL_LOCS = ["marathon-pe", "trophy", "hub2", "central"];
const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
// Approved standard run (owner policy 2026-07-13, reduced) — single source of
// truth is introduceExisting.js; this import keeps the wizard prefill aligned.
const STANDARD_RUN = { S: 1, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 };
// Numeric-aware ordering via hubSizeRank (imported at top): letters keep their
// historical ranks; shoe/waist sizes sort numerically after them instead of
// tying at 99 and rendering in arbitrary map order (12/13 would land anywhere).

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

// Documented copy of functions/lib/refill-engine.cjs stockFingerprint — MUST
// stay in lockstep (the engine compares this to decide when an "ignore until
// inventory changes" decision has expired).
function stockFingerprint(allStock, pid) {
  const parts = [];
  for (const loc of Object.keys(allStock || {}).sort()) {
    const bySize = allStock[loc]?.[pid];
    if (!bySize) continue;
    for (const size of Object.keys(bySize).sort()) {
      const q = Number(bySize[size]?.qty) || 0;
      if (q !== 0) parts.push(`${loc}:${encodeSizeKey(size)}:${q}`);
    }
  }
  return parts.join("|") || "empty";
}

const pill = (on) => ({
  padding: "7px 13px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
  border: on ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
  background: on ? "rgba(60,110,255,.14)" : "rgba(255,255,255,.03)",
  color: on ? BLUE_L : "rgba(255,255,255,.45)",
});

export default function NoTargetQueue({ products = [] }) {
  const allStock = useStockCells();
  const allTargetsRaw = useStockTargets();   // null until the listener answers
  const allTargets = allTargetsRaw || {};
  const decisions = useTargetDecisions() || {};
  const engineConfig = useEngineConfig();
  const dests = useMemo(() => destsFrom(engineConfig), [engineConfig]);
  // Never classify against half-loaded data: with targets still null EVERY
  // product would render as a wrong card for a moment.
  const loading = allTargetsRaw == null || !allStock || !Object.keys(allStock).length;
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const isAdmin = actorRole === "admin";
  const canTransfer = ["store", "warehouse", "admin"].includes(actorRole);

  const [openKey, setOpenKey] = useState(null);
  const [action, setAction] = useState({});     // key → "wizard" | "targets" | "transfer" | "later"
  const [edits, setEdits] = useState({});       // `${key}|${size}` → value
  const [locsOn, setLocsOn] = useState({});     // `${key}|${loc}` → false (default true)
  const [destPick, setDestPick] = useState({});
  const [busyKey, setBusyKey] = useState(null);
  const [doneMsg, setDoneMsg] = useState(null);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const sumAt = (loc, pid) => Object.values(allStock?.[loc]?.[pid] || {}).reduce((t, c) => t + Math.max(Number(c?.qty) || 0, 0), 0);

  const decisionActive = (loc, pid) => {
    const d = decisions?.[loc]?.[pid];
    if (!d) return false;
    if (d.decision === "keep") return true;
    if (d.decision === "snooze") return Date.parse(d.until || 0) > serverNowMs();
    if (d.decision === "until_change") return d.fingerprint === stockFingerprint(allStock, pid);
    return false;
  };

  const cards = useMemo(() => {
    const out = [];
    if (loading) return out;
    // CATEGORY-MAPPED = ALREADY DECIDED (2026-08-13). The category policy
    // governs a product with no explicit row, and it survives the kill switch
    // — so a mapped product must never be offered as a manual decision here.
    // Mirrors the engine's managedHere fix (same review, PR #352): the moment
    // the 136 old-number rows fall through to the map, their products would
    // otherwise flood this queue as row-less "decisions". Per-size entries
    // decide every declared size; one-size entries decide the "_" cell (the
    // blind-spot loop below filters that size rather than the whole product,
    // because its letter cells genuinely stay the run's business).
    const policy = engineConfig?.categoryPolicy;
    const mappedAt = (pid, loc) => categoryPolicyLocs(policy, byId.get(pid)?.categoryKey).includes(loc);
    const mappedAnywhere = (pid) => categoryPolicyLocs(policy, byId.get(pid)?.categoryKey).length > 0;
    const mappedPerSize = (pid) => policy?.[byId.get(pid)?.categoryKey]?.perSize === true;
    // GENUINELY NEW at Central — no targets anywhere AND never circulated.
    // Circulation evidence is cell PRESENCE, not quantity (lockstep with the
    // engine): a sold-to-zero destination cell still proves the product was
    // out in the network, so it can never flip back to "NEW".
    for (const [pid, bySize] of Object.entries(allStock?.central || {})) {
      const p = byId.get(pid);
      if (!isClothing(p)) continue;
      if (isDeactivated(p)) continue;   // retired finished line — no decision is owed on it
      if (mappedAnywhere(pid)) continue;   // the category already decided
      if (dests.some((d) => allTargets?.[d]?.[pid])) continue;
      if (dests.some((d) => Object.keys(allStock?.[d]?.[pid] || {}).length)) continue;
      if (decisionActive("central", pid)) continue;
      const sizes = Object.entries(bySize || {})
        .map(([size, c]) => ({ size, qty: Math.max(Number(c?.qty) || 0, 0) }))
        .filter((s) => s.qty > 0).sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      if (!sizes.length) continue;
      out.push({
        key: `central|${pid}`, loc: "central", pid, isNew: true,
        name: p?.name || pid, photo: p?.photoUrl, sizes,
        units: sizes.reduce((t, s) => t + s.qty, 0),
        network: ALL_LOCS.map((l) => ({ loc: l, units: sumAt(l, pid) })),
      });
    }
    // Remaining GENUINE decisions at managed locations: numeric-size products
    // (no approved standard quantities) and assortment leftovers (targets exist
    // elsewhere, none here). Standard-size circulating products are handled by
    // the Introduce Existing migration and are deliberately absent.
    for (const loc of dests) {
      for (const [pid, bySize] of Object.entries(allStock?.[loc] || {})) {
        const p = byId.get(pid);
        if (!isClothing(p)) continue;
        if (isDeactivated(p)) continue;   // retired finished line — no decision is owed on it
        if (mappedAt(pid, loc)) continue;   // the category already decided here
        if (allTargets?.[loc]?.[pid]) continue;
        const introducedElsewhere = dests.some((d) => allTargets?.[d]?.[pid]);
        if (!introducedElsewhere && stockedStandardSizes(allStock, pid).length) continue; // → migration
        if (decisionActive(loc, pid)) continue;
        const sizes = Object.entries(bySize || {})
          .map(([size, c]) => ({ size, qty: Math.max(Number(c?.qty) || 0, 0) }))
          .filter((s) => s.qty > 0).sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
        if (!sizes.length) continue;
        out.push({
          key: `${loc}|${pid}`, loc, pid, isNew: false, noStandard: !introducedElsewhere,
          name: p?.name || pid, photo: p?.photoUrl, sizes,
          units: sizes.reduce((t, s) => t + s.qty, 0),
          network: ALL_LOCS.map((l) => ({ loc: l, units: sumAt(l, pid) })),
        });
      }
    }
    // SIZE-SCOPED blind spot (lockstep with the engine's guard; WIDENED
    // 2026-07-13): EVERY stocked size lacking a target under a managed product
    // surfaces — numeric sizes AND standard sizes that arrived after the
    // product was introduced (a new "S" of a product migrated on M/L would
    // otherwise never generate a refill, silently, forever). Hub 2 cards also
    // pick up new sizes stocked at Central with no target anywhere — new sizes
    // land upstream first and must surface at the buffer to start flowing.
    for (const loc of dests) {
      for (const [pid, byTarget] of Object.entries(allTargets?.[loc] || {})) {
        const p = byId.get(pid);
        if (!isClothing(p)) continue;
        if (isDeactivated(p)) continue;   // retired finished line — no decision is owed on it
        if (mappedAt(pid, loc) && mappedPerSize(pid)) continue;   // every declared size decided
        if (decisionActive(loc, pid)) continue;
        const sizes = Object.entries(allStock?.[loc]?.[pid] || {})
          .map(([size, c]) => ({ size, qty: Math.max(Number(c?.qty) || 0, 0) }))
          .filter((s) => s.qty > 0 && !byTarget[encodeSizeKey(s.size)])
          // a one-size map entry decides the "_" cell — its letter cells stay
          // the run's business exactly as before.
          .filter((s) => !(mappedAt(pid, loc) && encodeSizeKey(s.size) === "_"));
        if (loc === "hub2") {
          const seen = new Set(sizes.map((s) => encodeSizeKey(s.size)));
          for (const [size, c] of Object.entries(allStock?.central?.[pid] || {})) {
            const sk = encodeSizeKey(size);
            if (seen.has(sk) || byTarget[sk]) continue;
            if ((Number(c?.qty) || 0) > 0 && !dests.some((d) => allTargets?.[d]?.[pid]?.[sk])) {
              sizes.push({ size, qty: Math.max(Number(c?.qty) || 0, 0), atCentral: true });
            }
          }
        }
        sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
        if (!sizes.length) continue;
        out.push({
          key: `${loc}|${pid}|sizes`, loc, pid, isNew: false, noStandard: true,
          name: p?.name || pid, photo: p?.photoUrl, sizes,
          units: sizes.reduce((t, s) => t + s.qty, 0),
          network: ALL_LOCS.map((l) => ({ loc: l, units: sumAt(l, pid) })),
        });
      }
    }
    return out.sort((a, b) => (a.isNew === b.isNew ? b.units - a.units : a.isNew ? -1 : 1));
  }, [loading, allStock, allTargets, decisions, byId, dests, engineConfig]);

  // Pointer only — migration lives on the Health screen, not in this queue.
  const migratableCount = useMemo(
    () => (loading ? 0 : computeUnintroduced(allStock, allTargets, byId, dests, engineConfig?.categoryPolicy).filter((i) => i.migratable).length),
    [loading, allStock, allTargets, byId, dests, engineConfig],
  );

  if (loading) {
    return (
      <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 13.5, color: GRAY }}>Loading live stock and targets…</div>
      </div>
    );
  }

  // ── shared decision writers ──────────────────────────────────────────────────
  const finish = (card, text) => { setDoneMsg({ name: card.name, text }); setBusyKey(null); };

  const postpone = async (card, days) => {
    if (busyKey) return;
    setBusyKey(card.key);
    const d = days
      ? { decision: "snooze", until: new Date(serverNowMs() + days * 864e5).toISOString(), decidedAt: serverNowIso() }
      : { decision: "until_change", fingerprint: stockFingerprint(allStock, card.pid), decidedAt: serverNowIso() };
    try {
      await update(ref(database), { [`stock_targets_decisions/${card.loc}/${card.pid}`]: d });
      finish(card, days ? `snoozed — returns in ${days} days` : "ignored until its stock moves again");
    } catch (e) { finish(card, `write failed — ${String(e?.message || e)}`); }
  };

  // The wizard's steppers define the SHOP quantities. Hub 2 — when ticked on a
  // NEW-product introduction — always receives its own deeper BUFFER run
  // (effectiveRun), never the shop numbers: the buffer supplies both stores.
  // Editing a stepper therefore never under-fills Hub 2.
  const targetOf = (card, size) => Math.max(0, Number(edits[`${card.key}|${size}`] ?? (STANDARD_RUN[size] ?? 1)) || 0);
  const targetFor = (card, size, loc) =>
    (card.isNew && loc === "hub2")
      ? Math.max(0, Number(effectiveRun(engineConfig, "hub2")[String(size).toUpperCase()] ?? 1) || 0)
      : targetOf(card, size);
  const locEnabled = (card, loc) => locsOn[`${card.key}|${loc}`] !== false;

  // Suggested initial distribution: deal each enabled location its target from
  // Central's pool, in order, never exceeding what Central actually has.
  const distributionOf = (card) => {
    const remaining = Object.fromEntries(card.sizes.map((s) => [s.size, s.qty]));
    const perLoc = [];
    for (const loc of dests) {
      if (!locEnabled(card, loc)) continue;
      const lines = [];
      for (const s of card.sizes) {
        const want = targetFor(card, s.size, loc);
        const give = Math.max(0, Math.min(want, remaining[s.size]));
        if (give > 0) lines.push({ size: s.size, qty: give });
        remaining[s.size] -= give;
      }
      if (lines.length) perLoc.push({ loc, lines });
    }
    return { perLoc, remaining };
  };

  const saveTargets = async (card, { distribute }) => {
    if (busyKey || !isAdmin) return;
    setBusyKey(card.key);
    const now = serverNowIso();
    const upd = {};
    const locs = card.isNew ? dests.filter((l) => locEnabled(card, l)) : [card.loc];
    for (const loc of locs) {
      for (const s of card.sizes) {
        const t = targetFor(card, s.size, loc);
        upd[`stock_targets/${loc}/${card.pid}/${encodeSizeKey(s.size)}`] = {
          target: t, minQty: Math.ceil(t / 2), source: "manual",
          batchId: "decision-queue", approvedBy: "decision-queue", approvedAt: now,
        };
      }
    }
    try {
      await update(ref(database), upd);
    } catch (e) { return finish(card, `target write failed — ${String(e?.message || e)}`); }

    if (!distribute) return finish(card, `targets set for ${locs.map((l) => LOC_LABEL[l]).join(", ")} — engine takes over`);

    // Initial distribution: generate every Central→location transfer.
    const { perLoc } = distributionOf(card);
    const batch = `intro_${serverNowMs().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { loc, lines } of perLoc) {
      for (const { size, qty } of lines) {
        let res;
        try {
          res = await applyMovement({
            type: "transfer_out", productId: card.pid, size, qty,
            from: "central", to: loc, actorRole,
            reason: "initial_distribution",
            movementId: `${batch}_${loc}_${card.pid}_${encodeSizeKey(size)}`,
            link: { transferId: batch },
          });
        } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
        if (res.ok) moved += qty; else failed.push(`${LOC_LABEL[loc]} ${size}: ${res.reason}`);
      }
    }
    finish(card, failed.length
      ? `targets saved · ${moved} units distributed · failed: ${failed.join(" · ")}`
      : `introduced — targets saved, ${moved} units distributed, engine takes over`);
  };

  const excludeHere = async (card) => {
    if (busyKey || !isAdmin) return;
    setBusyKey(card.key);
    const now = serverNowIso();
    const upd = {};
    const locs = card.isNew ? dests.filter((l) => locEnabled(card, l)) : [card.loc];
    for (const loc of locs) {
      for (const s of card.sizes) {
        upd[`stock_targets/${loc}/${card.pid}/${encodeSizeKey(s.size)}`] = {
          target: 0, minQty: 0, source: "excluded", batchId: "decision-queue", approvedBy: "decision-queue", approvedAt: now,
        };
      }
    }
    try {
      await update(ref(database), upd);
      finish(card, `excluded from ${locs.map((l) => LOC_LABEL[l]).join(", ")} — surplus flows to Excess`);
    } catch (e) { finish(card, `write failed — ${String(e?.message || e)}`); }
  };

  const transfer = async (card) => {
    if (busyKey || !canTransfer) return;
    const dest = destPick[card.key] || (card.loc === "hub2" || card.loc === "central" ? (card.loc === "central" ? "hub2" : "central") : "hub2");
    const lines = card.sizes
      .map((s) => ({ s, qty: Math.max(0, Math.min(Number(edits[`${card.key}|t|${s.size}`] ?? s.qty) || 0, s.qty)) }))
      .filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusyKey(card.key);
    const batch = `ntq_${serverNowMs().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { s, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: card.pid, size: s.size, qty,
          from: card.loc, to: dest, actorRole,
          reason: "network_rebalance",
          movementId: `${batch}_${card.pid}_${encodeSizeKey(s.size)}`,
          link: { transferId: batch },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += qty; else failed.push(`${s.size}: ${res.reason}`);
    }
    finish(card, failed.length ? `${moved} moved · failed: ${failed.join(" · ")}` : `${moved} units → ${LOC_LABEL[dest]} ✓`);
  };

  if (!cards.length) {
    return (
      <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: GREEN }}>Queue clear 🎉</div>
        <div style={{ color: GRAY, fontSize: 12.5, marginTop: 6 }}>
          Every product is introduced, excluded, or deliberately postponed.
          {migratableCount > 0 && <> {migratableCount} existing product{migratableCount === 1 ? "" : "s"} await engine onboarding under <b>Introduce Existing</b> on Health — not decisions, one tap.</>}
        </div>
      </div>
    );
  }

  const newCount = cards.filter((c) => c.isNew).length;

  return (
    <div>
      {doneMsg && (
        <div style={{ ...GLASS, padding: "10px 13px", marginBottom: 12, fontSize: 12.5 }}>
          <span style={{ color: doneMsg.text.includes("failed") ? RED : GREEN, fontWeight: 700 }}>{doneMsg.name}</span>
          <span style={{ color: GRAY }}> — {doneMsg.text}</span>
        </div>
      )}
      {migratableCount > 0 && (
        <div style={{ ...GLASS, padding: "10px 13px", marginBottom: 12, fontSize: 12.5, color: GRAY }}>
          {migratableCount} existing product{migratableCount === 1 ? "" : "s"} are waiting for engine onboarding — those are
          <b> not decisions</b>: use <b>Introduce Existing</b> on the Health screen to migrate them in one tap.
        </div>
      )}
      {newCount > 0 && (
        <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "2px 2px 8px" }}>
          New products at Central ({newCount}) — introduce into the network
        </div>
      )}
      {cards.map((card, idx) => {
        const open = openKey === card.key;
        const mode = action[card.key] || null;
        const dist = card.isNew ? distributionOf(card) : null;
        const showUnconfHeader = !card.isNew && (idx === 0 || cards[idx - 1].isNew);
        return (
          <React.Fragment key={card.key}>
            {showUnconfHeader && (
              <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "10px 2px 8px" }}>
                Unconfigured stock at locations
              </div>
            )}
            <ProductCard
              photo={card.photo} name={card.name}
              badges={<>
                <Badge tone={card.isNew ? GREEN : card.noStandard ? AMBER : BLUE_L}>
                  {card.isNew ? "NEW PRODUCT" : card.noStandard ? "NO STANDARD RUN" : LOC_LABEL[card.loc]}
                </Badge>
                <Badge tone={GRAY}>{card.isNew ? `CENTRAL · ${card.units} UNITS` : card.noStandard ? "SIZES NEED QUANTITIES" : "AWAITING TARGET"}</Badge>
              </>}
              sub={card.network.filter((n) => n.units > 0).map((n) => `${LOC_LABEL[n.loc]} ${n.units}`).join(" · ")}
              right={
                <button onClick={() => { setOpenKey(open ? null : card.key); setAction((a) => ({ ...a, [card.key]: card.isNew ? "wizard" : null })); }}
                        style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.3)", color: BLUE_L, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT }}>
                  {open ? "Close" : card.isNew ? "Introduce" : "Decide"}
                </button>
              }
            >
              {open && (
                <>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                    {card.sizes.map((s) => <SizeFactChip key={s.size} size={s.size} value={`×${s.qty} at ${LOC_LABEL[card.loc]}`} tone={BLUE_L} />)}
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                    {card.isNew
                      ? <button onClick={() => setAction((a) => ({ ...a, [card.key]: "wizard" }))} style={pill(mode === "wizard")} disabled={!isAdmin} title={isAdmin ? "" : "Admin only"}>Targets & distribution{!isAdmin ? " 🔒" : ""}</button>
                      : <button onClick={() => setAction((a) => ({ ...a, [card.key]: "targets" }))} style={pill(mode === "targets")} disabled={!isAdmin} title={isAdmin ? "" : "Admin only"}>Set targets{!isAdmin ? " 🔒" : ""}</button>}
                    <button onClick={() => setAction((a) => ({ ...a, [card.key]: "transfer" }))} style={pill(mode === "transfer")} disabled={!canTransfer}>Transfer</button>
                    <button onClick={() => excludeHere(card)} style={pill(false)} disabled={!isAdmin || busyKey === card.key}
                            title={isAdmin ? "Deliberate business decision: target 0" : "Admin only"}>Exclude{!isAdmin ? " 🔒" : ""}</button>
                    <button onClick={() => setAction((a) => ({ ...a, [card.key]: "later" }))} style={pill(mode === "later")}>Later…</button>
                  </div>

                  {mode === "later" && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      {[30, 60, 90].map((d) => (
                        <button key={d} onClick={() => postpone(card, d)} style={pill(false)} disabled={busyKey === card.key}>Remind in {d} days</button>
                      ))}
                      <button onClick={() => postpone(card, 0)} style={pill(false)} disabled={busyKey === card.key}
                              title="Returns automatically when this product's stock changes anywhere">Ignore until stock moves</button>
                    </div>
                  )}

                  {(mode === "wizard" || mode === "targets") && (
                    <>
                      {card.isNew && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0 2px" }}>
                          {dests.map((l) => (
                            <button key={l} onClick={() => setLocsOn((o) => ({ ...o, [`${card.key}|${l}`]: !locEnabled(card, l) }))} style={pill(locEnabled(card, l))}>
                              {locEnabled(card, l) ? "✓ " : ""}{LOC_LABEL[l]}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{ color: GRAY, fontSize: 11, margin: "8px 0 4px" }}>
                        Target per size{card.isNew ? " (applied to every ticked shop — Hub 2 automatically gets its deeper buffer run)" : ` at ${LOC_LABEL[card.loc]}`} — prefilled with the standard run:
                      </div>
                      <div style={CHIP_GRID}>
                        {card.sizes.map((s) => (
                          <SizeStepperChip key={s.size}
                            size={s.size} qty={targetOf(card, s.size)} max={20}
                            onChange={(v) => setEdits((e) => ({ ...e, [`${card.key}|${s.size}`]: v }))}
                            hint={`${s.qty} at ${LOC_LABEL[card.loc]}`}
                            disabled={busyKey === card.key}
                          />
                        ))}
                      </div>

                      {card.isNew && dist && (
                        <div style={{ ...GLASS, padding: "10px 12px", marginTop: 10 }}>
                          <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>Suggested initial distribution</div>
                          {dist.perLoc.map(({ loc, lines }) => (
                            <div key={loc} style={{ fontSize: 12.5, padding: "3px 0" }}>
                              <span style={{ color: BLUE_L, fontWeight: 700 }}>{LOC_LABEL[loc]}: </span>
                              <span>{lines.map((l) => `${l.size}×${l.qty}`).join(" · ")}</span>
                            </div>
                          ))}
                          <div style={{ fontSize: 12.5, padding: "3px 0", color: GRAY }}>
                            <span style={{ fontWeight: 700 }}>Stays at Central: </span>
                            {card.sizes.map((s) => `${s.size}×${Math.max(dist.remaining[s.size], 0)}`).join(" · ")}
                          </div>
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button onClick={() => saveTargets(card, { distribute: false })} disabled={busyKey === card.key}
                                style={{ ...pill(false), flex: 1, padding: "12px", textAlign: "center" }}>Targets only</button>
                        {card.isNew && (
                          <button onClick={() => saveTargets(card, { distribute: true })} disabled={busyKey === card.key || !dist?.perLoc.length}
                                  style={{ ...bGreen, flex: 2, padding: "12px", opacity: busyKey === card.key ? 0.6 : 1 }}>
                            {busyKey === card.key ? "Working…" : "Save targets & distribute"}
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {mode === "transfer" && (
                    <>
                      <div style={{ ...CHIP_GRID, marginTop: 10 }}>
                        {card.sizes.map((s) => (
                          <SizeStepperChip key={s.size}
                            size={s.size}
                            qty={Math.max(0, Math.min(Number(edits[`${card.key}|t|${s.size}`] ?? s.qty) || 0, s.qty))}
                            max={s.qty}
                            onChange={(v) => setEdits((e) => ({ ...e, [`${card.key}|t|${s.size}`]: v }))}
                            hint={`${s.qty} here`}
                            disabled={busyKey === card.key}
                          />
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                        {ALL_LOCS.filter((l) => l !== card.loc).map((d) => (
                          <button key={d} onClick={() => setDestPick((p) => ({ ...p, [card.key]: d }))}
                                  style={pill((destPick[card.key] || (card.loc === "central" ? "hub2" : card.loc === "hub2" ? "central" : "hub2")) === d)}>→ {LOC_LABEL[d]}</button>
                        ))}
                      </div>
                      <button onClick={() => transfer(card)} disabled={busyKey === card.key}
                              style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: busyKey === card.key ? 0.6 : 1 }}>
                        {busyKey === card.key ? "Transferring…" : "Transfer"}
                      </button>
                    </>
                  )}
                </>
              )}
            </ProductCard>
          </React.Fragment>
        );
      })}
    </div>
  );
}
