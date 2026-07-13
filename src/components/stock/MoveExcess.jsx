// ─── MOVE EXCESS — network-wide rebalance (card-by-card) ──────────────────────
// Owner spec v3 (2026-07-12): excess detection covers the WHOLE network, not
// just Hub 2. Any location holding more than its approved target surfaces here:
//   • Hub 2 — strict: every unit above target (it's a refill buffer, not storage)
//   • Marathon PE / Trophy — significant surplus only (≥2 above target; stores
//     legitimately sell down small overage on their own)
// The operator reviews ONE product card at a time — photo, name, per-size
// stepper chips (have → target → move) — picks a destination (stores may send
// back to Hub 2 or straight to Central; Hub 2 sends to Central) and transfers.
// Confirming advances to the next card until the cleanup is complete.
//
// Every write is applyMovement transfer_out (atomic, idempotent per movementId,
// one ledger batch id per confirm). Live stock retires cards instantly;
// re-opening recomputes, so double-moves are structurally impossible.

import React, { useMemo, useState } from "react";
import { ref, get } from "firebase/database";
import { database } from "../../firebase";
import { useStockCells, useStockTargets, useRefillRequests, useEngineConfig } from "./useStock";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey, decodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
const SOURCES = ["hub2", "marathon-pe", "trophy"];
const STORE_EXCESS_MIN = 2;   // keep in sync with config.storeExcessMinUnits
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

export default function MoveExcess({ products = [], actorRole }) {
  const allStock = useStockCells();          // { loc: { pid: { rawSize: cell } } }
  const allTargets = useStockTargets();      // { loc: { pid: { encodedSize: {target} } } }
  // Open engine requests already bringing stock toward a deficit — WITHOUT
  // netting these, a store card would route excess to a Hub 2 need that a
  // Central fulfilment is about to cover (over-delivery → ping-pong hop back).
  const openRequests = useRefillRequests("open");
  const engineConfig = useEngineConfig();
  const routesCfg = engineConfig?.routes || { "marathon-pe": "hub2", trophy: "hub2", hub2: "central" };
  // Same deterministic order as the engine (downstream stores before their
  // source) so per-card allocation attribution matches the scan's advisory
  // numbers — the greedy split is sum-invariant but not order-invariant.
  const sources = (Object.keys(routesCfg).length ? Object.keys(routesCfg) : SOURCES).slice().sort((a, b) => {
    if (routesCfg[a] === b) return -1;
    if (routesCfg[b] === a) return 1;
    return a.localeCompare(b);
  });
  const storeMin = Number(engineConfig?.storeExcessMinUnits) || STORE_EXCESS_MIN;
  const [edits, setEdits] = useState({});    // `${loc}|${pid}|${size}` → qty
  const [busy, setBusy] = useState(false);   // card key being transferred | false
  const [lastResult, setLastResult] = useState(null);
  const [movedTotal, setMovedTotal] = useState(0);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const cards = useMemo(() => {
    const out = [];
    // Network deficit per (pid,size): surplus that another location still NEEDS
    // is held for refills, never offered to Central (mirrors the engine's
    // "Cortez fix" netting; client-side we approximate without inbound data,
    // which only errs toward holding MORE back — the safe direction).
    const deficitBySize = new Map();
    // Inbound already on its way per (dest,pid,size) — open engine requests.
    const inbound = new Map();
    for (const r of openRequests || []) {
      if (!r?.productId || !r.requestingLocation || r.shadow) continue;
      const k = `${r.requestingLocation}|${r.productId}|${encodeSizeKey(r.size)}`;
      inbound.set(k, (inbound.get(k) || 0) + (Number(r.qty) || 1));
    }
    for (const loc of sources) {
      for (const [pid, bySize] of Object.entries(allTargets?.[loc] || {})) {
        for (const [sizeKey, t] of Object.entries(bySize || {})) {
          if (!t || typeof t.target !== "number") continue;
          const have = Math.max(Number(allStock?.[loc]?.[pid]?.[decodeSizeKey ? decodeSizeKey(sizeKey) : sizeKey]?.qty) || 0, 0);
          const deficit = t.target - have - (inbound.get(`${loc}|${pid}|${sizeKey}`) || 0);
          if (deficit > 0) {
            const k = `${pid}|${sizeKey}`;
            deficitBySize.set(k, (deficitBySize.get(k) || 0) + deficit);
          }
        }
      }
    }
    for (const loc of sources) {
      const minEx = loc === "hub2" ? 1 : storeMin;
      for (const [pid, bySize] of Object.entries(allStock?.[loc] || {})) {
        const p = byId.get(pid);
        if (!isClothing(p)) continue;
        const sizes = [];
        for (const [size, cell] of Object.entries(bySize || {})) {
          const qty = typeof cell?.qty === "number" ? cell.qty : 0;
          const t = allTargets?.[loc]?.[pid]?.[encodeSizeKey(size)];
          // Three states (v5): configured target → judged; explicit target 0 →
          // deliberately excluded, every unit is excess; NO target → not judged
          // here at all (it shows under "No Target Configured" in Health — the
          // engine never assumes unconfigured stock is misplaced).
          if (!t || typeof t.target !== "number") continue;
          const raw = qty - t.target;
          const dKey = `${pid}|${encodeSizeKey(size)}`;
          const lineMin = t.target === 0 ? 1 : minEx;
          if (loc === "hub2") {
            // Hub 2 stays NET-based: its held units flow onward automatically
            // via the engine's hub→store refill legs.
            const held = Math.min(Math.max(raw, 0), deficitBySize.get(dKey) || 0);
            const excessQty = raw - held;
            if (excessQty >= lineMin) sizes.push({ size, have: qty, target: t.target, excess: excessQty, toHub: 0, toCentral: excessQty });
          } else if (raw >= lineMin) {
            // TWO-LEG split (owner directive 2026-07-13): stores move their
            // WHOLE overage in one visit — deficit-covering units → Hub 2
            // (Cortez preserved: never to Central), remainder → Central. The
            // deficit is CONSUMED as cards allocate so two stores never both
            // fill the same Hub 2 need (lockstep with the engine).
            const need = deficitBySize.get(dKey) || 0;
            const toHub = Math.min(raw, need);
            deficitBySize.set(dKey, need - toHub);
            sizes.push({ size, have: qty, target: t.target, excess: raw, toHub, toCentral: raw - toHub });
          }
        }
        if (!sizes.length) continue;
        sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
        out.push({
          key: `${loc}|${pid}`, loc, pid, name: p?.name || pid, photo: p?.photoUrl,
          sizes, totalExcess: sizes.reduce((t, s) => t + s.excess, 0),
        });
      }
    }
    return out.sort((a, b) => b.totalExcess - a.totalExcess);
  }, [allStock, allTargets, byId]);

  const [locFilter, setLocFilter] = useState("all");
  const shown = locFilter === "all" ? cards : cards.filter((c) => c.loc === locFilter);
  const locCount = (loc) => cards.filter((c) => c.loc === loc).length;

  const qtyOf = (c, s) => {
    const v = edits[`${c.key}|${s.size}`];
    // Never above the movable ceiling — for hub2 that is the NET excess (its
    // held units belong to downstream refills: Cortez is not manually
    // overridable), for stores the raw overage. Stale edits clamp here; the
    // tap-time clamp is the hard backstop.
    const ceil = c.loc === "hub2" ? s.excess : Math.max(s.have - s.target, 0);
    return Math.max(0, Math.min(v == null ? s.excess : v, ceil));
  };

  const transfer = async (c) => {
    if (busy) return;
    const lines = c.sizes.map((s) => ({ s, qty: qtyOf(c, s) })).filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusy(c.key);
    const batchId = `exc_${Date.now().toString(36)}`;
    let moved = 0; const failed = []; const destsHit = new Set();
    for (const { s, qty } of lines) {
      // TAP-TIME CLAMP (design review 2026-07-13): a sale between render and
      // tap can shrink the true overage — never move the shop below target.
      let total = qty;
      try {
        const live = (await get(ref(database, `stock/${c.loc}/${c.pid}/${encodeSizeKey(s.size)}/qty`))).val();
        if (typeof live === "number") total = Math.max(0, Math.min(total, live - s.target));
      } catch { /* offline read — proceed with entered qty */ }
      if (total <= 0) continue;
      // DESTINATION-SIDE tap check (review 2026-07-13): Hub 2 may have been
      // filled meanwhile (a Central fulfilment, another operator). Cap the
      // hub leg by its LIVE remaining need; anything above goes to Central
      // instead — never dumped on a full buffer.
      const hubDest = routesCfg[c.loc] || "hub2";
      let hubLeg = Math.min(total, s.toHub || 0);
      if (hubLeg > 0) {
        try {
          const hLive = (await get(ref(database, `stock/${hubDest}/${c.pid}/${encodeSizeKey(s.size)}/qty`))).val();
          const hTarget = Number(allTargets?.[hubDest]?.[c.pid]?.[encodeSizeKey(s.size)]?.target);
          if (typeof hLive === "number" && Number.isFinite(hTarget)) hubLeg = Math.max(0, Math.min(hubLeg, hTarget - Math.max(hLive, 0)));
        } catch { /* offline read — keep planned split */ }
      }
      const legs = [
        { dest: hubDest, qty: hubLeg },
        { dest: "central", qty: total - hubLeg },
      ].filter((l) => l.qty > 0 && l.dest !== c.loc);
      for (const leg of legs) {
        let res;
        try {
          res = await applyMovement({
            type: "transfer_out", productId: c.pid, size: s.size, qty: leg.qty,
            from: c.loc, to: leg.dest, actorRole,
            reason: "excess_rebalance",
            movementId: `${batchId}_${c.pid}_${encodeSizeKey(s.size)}_${leg.dest}`,
            link: { transferId: batchId },
          });
        } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
        if (res.ok) { moved += leg.qty; destsHit.add(leg.dest); } else failed.push(`${s.size}→${leg.dest}: ${res.reason}`);
      }
    }
    setMovedTotal((t) => t + moved);
    setLastResult({ name: c.name, dest: [...destsHit].join(" + ") || "—", moved, failed });
    // Clear this card's edits: quantities must recompute from the moved-down
    // live stock, never linger from the pre-transfer render.
    setEdits((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) if (k.startsWith(`${c.key}|`)) delete next[k];
      return next;
    });
    setBusy(false);
  };

  const pill = (on) => ({
    padding: "7px 14px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
    border: on ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
    background: on ? "rgba(60,110,255,.14)" : "rgba(255,255,255,.03)",
    color: on ? BLUE_L : "rgba(255,255,255,.45)",
  });

  return (
    <div>
      {/* Summary strip */}
      <div style={{ ...GLASS, padding: "11px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800 }}>Excess rebalance</div>
          <div style={{ color: GRAY, fontSize: 11, marginTop: 2 }}>
            Above approved targets{movedTotal > 0 ? ` · ${movedTotal} units moved this session` : ""}
          </div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 800, color: BLUE_L, background: "rgba(60,110,255,.1)", border: "1px solid rgba(60,110,255,.3)", borderRadius: 999, padding: "5px 12px", whiteSpace: "nowrap" }}>
          {shown.length} product{shown.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Location sections — every excess product visible, per location */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        <button onClick={() => setLocFilter("all")} style={pill(locFilter === "all")}>All ({cards.length})</button>
        {sources.map((l) => (
          <button key={l} onClick={() => setLocFilter(l)} style={pill(locFilter === l)}>
            {LOC_LABEL[l]} ({locCount(l)})
          </button>
        ))}
      </div>

      {lastResult && (
        <div style={{ ...GLASS, padding: "10px 13px", marginBottom: 12, fontSize: 12.5 }}>
          <span style={{ color: GREEN, fontWeight: 700 }}>{lastResult.name}: {lastResult.moved} units → {String(lastResult.dest).split(" + ").map((d) => LOC_LABEL[d] || d).join(" + ")} ✓</span>
          {lastResult.failed.length > 0 && <div style={{ color: RED, marginTop: 4 }}>Failed: {lastResult.failed.join(" · ")}</div>}
        </div>
      )}

      {shown.length === 0 && (
        <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: GREEN }}>Nothing to rebalance 🎉</div>
          <div style={{ color: GRAY, fontSize: 12.5, marginTop: 6 }}>
            {locFilter === "all" ? "No location holds" : `${LOC_LABEL[locFilter]} holds nothing`} meaningfully above its approved targets.
          </div>
        </div>
      )}

      {shown.map((c) => {
        const total = c.sizes.reduce((t, s) => t + qtyOf(c, s), 0);
        // Auto-split, deficit-first: Hub 2 receives what the network needs of
        // each size (never Central — Cortez), the true remainder goes to
        // Central. One tap fires both legs; the shop lands exactly on target.
        const split = c.sizes.reduce((acc, s) => {
          const q = qtyOf(c, s);
          const hub = Math.min(q, s.toHub || 0);
          return { hub: acc.hub + hub, central: acc.central + (q - hub) };
        }, { hub: 0, central: 0 });
        const splitLabel = [split.hub > 0 && `${split.hub} → Hub 2`, split.central > 0 && `${split.central} → Central`].filter(Boolean).join(" · ");
        return (
          <ProductCard key={c.key}
            photo={c.photo} name={c.name}
            badges={<>
              <Badge tone={BLUE_L}>{LOC_LABEL[c.loc]}</Badge>
              <Badge tone={AMBER}>{c.totalExcess} ABOVE TARGET</Badge>
            </>}
          >
            <div style={CHIP_GRID}>
              {c.sizes.map((s) => (
                <SizeStepperChip key={s.size}
                  size={s.size} qty={qtyOf(c, s)}
                  max={c.loc === "hub2" ? s.excess : Math.max(s.have - s.target, 0)}
                  onChange={(v) => setEdits((prev) => ({ ...prev, [`${c.key}|${s.size}`]: v }))}
                  hint={`have ${s.have} · target ${s.target}${s.toHub ? ` · ${s.toHub} → Hub 2` : ""}${s.toCentral ? ` · ${s.toCentral} → Central` : ""}`}
                  disabled={busy === c.key}
                />
              ))}
            </div>
            <button onClick={() => transfer(c)} disabled={busy === c.key || total === 0}
                    style={{ ...bGreen, width: "100%", marginTop: 12, padding: "12px", opacity: busy === c.key ? 0.6 : 1 }}>
              {busy === c.key ? "Transferring…" : `Transfer ${total} units — ${splitLabel || "nothing to move"}`}
            </button>
          </ProductCard>
        );
      })}
    </div>
  );
}
