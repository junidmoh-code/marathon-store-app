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
import { ref, get, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { useStockCells } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey, stockCellPath } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { serverNowMs, serverNowIso } from "../../utils/serverTime";
import { seedLocations, solvePlan as computeSolvePlan, qualifyingSizes as computeQualifyingSizes } from "./solvePlan";

const STORES = ["marathon-pe", "trophy"];
const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };
// Fallback size-standard if config/refillEngine can't be read — mirrors the live
// defaultRunByStore (2026-07). Only used for the confirm ESTIMATE; the engine
// computes the real numbers from its own config regardless.
const STD_FALLBACK = {
  hub2: { L: 3, M: 3, S: 2, XL: 2, XXL: 2, XXXL: 1 },
  "marathon-pe": { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
  trophy: { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
};

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

const destChip = (on) => ({
  padding: "8px 13px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
  border: on ? "1px solid rgba(60,110,255,.55)" : "1px solid rgba(255,255,255,.1)",
  background: on ? "rgba(60,110,255,.15)" : "rgba(255,255,255,.03)",
  color: on ? BLUE_L : "rgba(255,255,255,.5)",
});

export default function NetworkTransfer({ products = [] }) {
  const allStock = useStockCells();   // { loc: { pid: { rawSize: cell } } } — live
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

  // The size-standard, read ONCE (get, not a listener) for the confirm estimate.
  const [std, setStd] = useState(STD_FALLBACK);
  useEffect(() => {
    let alive = true;
    get(ref(database, "config/refillEngine/defaultRunByStore"))
      .then((s) => { const v = s.val(); if (alive && v) setStd(v); })
      .catch(() => { /* keep fallback — estimate only */ });
    return () => { alive = false; };
  }, []);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const qtyAt = (loc, pid, size) => Math.max(Number(allStock?.[loc]?.[pid]?.[String(size)]?.qty) || 0, 0);
  const sumAt = (loc, pid) => Object.values(allStock?.[loc]?.[pid] || {}).reduce((t, c) => t + Math.max(Number(c?.qty) || 0, 0), 0);
  // "Carries" = has a stock NODE (even a zeroed cell) — the engine's own gate
  // (storeCarries). A Solve seeds a qty-0 cell, so keying the downstream check on
  // carriage (not qty) makes a solved row leave the list immediately and never
  // re-flag a product the engine is already managing.
  const carries = (loc, pid) => !!allStock?.[loc]?.[pid] && Object.keys(allStock[loc][pid]).length > 0;

  // Stranded clothing: real upstream stock, NOT carried anywhere downstream.
  const cards = useMemo(() => {
    const out = [];
    const pids = new Set([...Object.keys(allStock?.central || {}), ...Object.keys(allStock?.hub2 || {})]);
    for (const pid of pids) {
      const p = byId.get(pid);
      if (!isClothing(p)) continue;
      const ce = sumAt("central", pid), h2 = sumAt("hub2", pid);
      const carriedDownstream = carries("marathon-pe", pid) || carries("trophy", pid);
      let source = null, kind = null;
      if (ce > 0 && !carries("hub2", pid) && !carriedDownstream) { source = "central"; kind = "Only in Central"; }
      else if (h2 > 0 && !carriedDownstream) { source = "hub2"; kind = "Only in Hub 2"; }
      if (!source) continue;
      const sizes = Object.entries(allStock[source]?.[pid] || {})
        .map(([size, c]) => ({ size, avail: Math.max(Number(c?.qty) || 0, 0) }))
        .filter((s) => s.avail > 0)
        .sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      if (!sizes.length) continue;
      const missing = source === "central" ? ["hub2", ...STORES].filter((l) => !carries(l, pid)) : STORES;
      out.push({ pid, name: p?.name || pid, photo: p?.photoUrl, source, kind, sizes, missing, units: sizes.reduce((t, s) => t + s.avail, 0) });
    }
    return out.sort((a, b) => b.units - a.units);
  }, [allStock, byId]);

  // Catalog sizes to seed (real sizes only, drop the one-size "_" sentinel).
  const catalogSizes = (pid) => (byId.get(pid)?.sizes || []).map(String).filter((s) => s && s !== "_");
  const stdRun = useMemo(() => ({ ...STD_FALLBACK, ...std }), [std]);
  // Sizes safe to seed — a positive standard at every seed location (solvePlan.js).
  // A size with no standard would seed a cell the engine never refills, then vanish
  // with a false "solved", so it's excluded. (Codex fix a.)
  const qualifyingSizes = (card, store) => computeQualifyingSizes(catalogSizes(card.pid), card.source, store, stdRun);

  // Confirm estimate via the pure helper (solvePlan.js), over the QUALIFYING sizes
  // only — availability closes over live /stock; std falls back if config is slow.
  const solvePlan = (card, store) => computeSolvePlan({
    std: stdRun,
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
        const sStore = solveDest[card.pid] || STORES[0];
        const plan = sOpen ? solvePlan(card, sStore) : null;
        // Solvable only if the engine has a standard for at least one of its sizes
        // (store standards are identical PE/Trophy, so one store is representative).
        const solvable = qualifyingSizes(card, STORES[0]).length > 0;
        return (
          <ProductCard key={card.pid}
            photo={card.photo} name={card.name}
            badges={<>
              <Badge tone={AMBER}>{card.kind.toUpperCase()}</Badge>
              <Badge tone={BLUE_L}>{card.units} units at {LOC_LABEL[card.source]}</Badge>
            </>}
            right={
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { setSolvePid(sOpen ? null : card.pid); setOpenPid(null); }} disabled={!canAct || !solvable}
                        title={!solvable ? "No standard sizes for this product — use Move manually" : undefined}
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
                  <b style={{ color: "#fff" }}>{plan.sizes.length} size{plan.sizes.length === 1 ? "" : "s"}</b> ({plan.sizes.join(" · ")}) → seeds {card.source === "central" ? <b>Hub 2 + {LOC_LABEL[sStore]}</b> : <b>{LOC_LABEL[sStore]}</b>} at qty 0.
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
