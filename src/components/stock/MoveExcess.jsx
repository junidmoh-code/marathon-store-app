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
import { useStockCells, useStockTargets, useRefillRequests, useEngineConfig, useStockHeld } from "./useStock";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey, decodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { openPickList } from "../../print/pickList";
import { serverNowMs } from "../../utils/serverTime";
import { sizeRank } from "./hubSizeRank";

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
const SOURCES = ["hub2", "marathon-pe", "trophy"];
const STORE_EXCESS_MIN = 2;   // keep in sync with config.storeExcessMinUnits
// Numeric-aware ordering via hubSizeRank (imported at top): letters keep their
// historical ranks; shoe/waist sizes sort numerically after them instead of
// tying at 99 and rendering in arbitrary map order (12/13 would land anywhere).

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

// Shelf-order categories (owner request 2026-07-13): staff work one physical
// section at a time — all tracksuits together, all tees together — instead of
// hopping shelf-to-shelf product by product. Name-based, first match wins.
const GARMENT_TYPES = [
  ["Tracksuits", /track\s*suit|tracksuit/i],
  ["Hoodies & Sweats", /hoodie|sweatshirt|sweater|crewneck|fleece(?!.*track)/i],
  ["Jackets & Puffers", /jacket|puffer|windbreaker|coat|varsity/i],
  ["T-Shirts & Polos", /t[- ]?shirt|\btee\b|polo/i],
  ["Jerseys", /jersey|\bkit\b/i],
  ["Jeans & Pants", /jean|denim|cargo|pant|trouser|chino/i],
  ["Shorts", /short/i],
];
const garmentType = (name) => (GARMENT_TYPES.find(([, re]) => re.test(String(name || ""))) || ["Other"])[0];
const GARMENT_ORDER = [...GARMENT_TYPES.map(([g]) => g), "Other"];

export default function MoveExcess({ products = [], actorRole }) {
  const allStock = useStockCells();          // { loc: { pid: { rawSize: cell } } }
  const allTargets = useStockTargets();      // { loc: { pid: { encodedSize: {target} } } }
  // Open engine requests already bringing stock toward a deficit — WITHOUT
  // netting these, a store card would route excess to a Hub 2 need that a
  // Central fulfilment is about to cover (over-delivery → ping-pong hop back).
  const openRequests = useRefillRequests("open");
  // Held central→hub credits (count-integrity hold lane): a fulfilled-but-
  // unreleased box is inbound to its hub exactly like an open request — the
  // netting must not route store excess at a need a parked box already covers.
  const heldLines = useStockHeld();
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
    for (const [dest, byLine] of Object.entries(heldLines || {})) {
      for (const line of Object.values(byLine || {})) {
        if (!line?.productId || (line.sizeKey == null && line.size == null)) continue;
        const k = `${dest}|${line.productId}|${line.sizeKey != null ? String(line.sizeKey) : encodeSizeKey(line.size)}`;
        inbound.set(k, (inbound.get(k) || 0) + (Number(line.qty) || 1));
      }
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
  }, [allStock, allTargets, byId, openRequests, heldLines]);

  const [locFilter, setLocFilter] = useState("all");
  const [search, setSearch] = useState("");
  // DESTINATION-FIRST batching (owner UX 2026-07-13): the warehouse does ALL
  // Hub 2 transfers in one run, then ALL Central transfers — so the screen is
  // split by destination, not by product. Each view lists only the cards with
  // a recommendation for that destination.
  const [destView, setDestView] = useState("hub");   // "hub" | "central"
  const hubSum = (c) => c.sizes.reduce((t, s) => t + (s.toHub || 0), 0);
  const centralSum = (c) => c.sizes.reduce((t, s) => t + (s.toCentral || 0), 0);
  // ── PDF pick lists (owner spec 2026-07-14) ─────────────────────────────────
  // One printable job sheet per transfer route, so supervisors can hand each
  // to a different staff member and the work runs in parallel on paper.
  // Printing NEVER moves stock — staff confirm here afterwards, with all the
  // usual live validation.
  const routes = useMemo(() => {
    const defs = [];
    for (const from of sources.filter((l) => l !== "hub2")) {
      const hubD = routesCfg[from] || "hub2";
      defs.push({ from, to: hubD, pick: (s) => s.toHub || 0 });
      defs.push({ from, to: "central", pick: (s) => s.toCentral || 0 });
    }
    defs.push({ from: "hub2", to: "central", pick: (s) => s.toCentral || 0 });
    return defs.map((d) => {
      const groups = cards
        .filter((c) => c.loc === d.from)
        .map((c) => ({
          name: c.name, photoUrl: c.photo,
          lines: c.sizes.filter((s) => d.pick(s) > 0).map((s) => ({ label: s.size, qty: d.pick(s) })),
        }))
        .filter((g) => g.lines.length);
      return { ...d, groups, units: groups.reduce((t, g) => t + g.lines.reduce((u, l) => u + l.qty, 0), 0) };
    });
  }, [cards, sources, routesCfg]);

  const printRoute = (r) => {
    const ok = openPickList({
      title: "Move Excess Pick List",
      route: `${LOC_LABEL[r.from] || r.from} → ${LOC_LABEL[r.to] || r.to}`,
      generatedBy: actorRole || "warehouse",
      groups: r.groups,
    });
    if (!ok) setLastResult({ name: "Pick list", dest: r.to, moved: 0, failed: ["popup blocked — allow popups for this site and retry"] });
  };

  const destTotals = useMemo(() => ({
    hub: cards.reduce((t, c) => t + hubSum(c), 0),
    central: cards.reduce((t, c) => t + centralSum(c), 0),
  }), [cards]);
  const shown = (locFilter === "all" ? cards : cards.filter((c) => c.loc === locFilter))
    .filter((c) => (destView === "hub" ? c.loc !== "hub2" && hubSum(c) > 0 : centralSum(c) > 0))
    .filter((c) => !search.trim() || c.name.toLowerCase().includes(search.trim().toLowerCase()));
  const locCount = (loc) => cards.filter((c) => c.loc === loc &&
    (destView === "hub" ? c.loc !== "hub2" && hubSum(c) > 0 : centralSum(c) > 0)).length;
  // Shelf-order grouping: one category section at a time.
  const groups = useMemo(() => {
    const byType = new Map();
    for (const c of shown) {
      const g = garmentType(c.name);
      (byType.get(g) || byType.set(g, []).get(g)).push(c);
    }
    return GARMENT_ORDER.filter((g) => byType.has(g))
      .map((g) => ({ label: g, items: byType.get(g), units: byType.get(g).reduce((t, c) => t + (destView === "hub" ? hubSum(c) : centralSum(c)), 0) }));
  }, [shown, destView]);

  // ── MANUAL PER-DESTINATION EXECUTION (owner UX directive 2026-07-13) ────────
  // The engine CALCULATES and RECOMMENDS (the per-size split prefills the
  // steppers); the WAREHOUSE decides and executes — one Transfer button per
  // destination, quantities editable within valid limits, either destination
  // skippable. Nothing fires automatically. All tap-time validation (live
  // source clamp, live destination-need cap for the hub leg) is unchanged.
  //   hub-leg limit:     the destination's recommended need (pushing more
  //                      belongs to Central — that is what the second leg is for)
  //   central-leg limit: the full movable overage (the warehouse may override
  //                      the recommendation and send everything to Central;
  //                      hub2 cards stay capped at NET excess — Cortez holds)
  const hubQtyOf = (c, s) => {
    const v = edits[`${c.key}|${s.size}|hub`];
    return Math.max(0, Math.min(v == null ? (s.toHub || 0) : v, s.toHub || 0));
  };
  const centralQtyOf = (c, s) => {
    const v = edits[`${c.key}|${s.size}|central`];
    const ceil = c.loc === "hub2" ? s.excess : Math.max(s.have - s.target, 0);
    return Math.max(0, Math.min(v == null ? (s.toCentral || 0) : v, ceil));
  };

  const transferTo = async (c, which) => {   // which: "hub" | "central"
    if (busy) return;
    const hubDest = routesCfg[c.loc] || "hub2";
    const dest = which === "hub" ? hubDest : "central";
    if (dest === c.loc) return;
    const lines = c.sizes
      .map((s) => ({ s, qty: which === "hub" ? hubQtyOf(c, s) : centralQtyOf(c, s) }))
      .filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusy(c.key);
    const batchId = `exc_${serverNowMs().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { s, qty } of lines) {
      // TAP-TIME CLAMP: a sale between render and tap can shrink the true
      // overage — never move the shop below target.
      let q = qty;
      try {
        const live = (await get(ref(database, `stock/${c.loc}/${c.pid}/${encodeSizeKey(s.size)}/qty`))).val();
        if (typeof live === "number") q = Math.max(0, Math.min(q, live - s.target));
      } catch { /* offline read — proceed with entered qty */ }
      // DESTINATION-SIDE tap check (hub leg only): never dump on a buffer
      // another fulfilment just filled.
      if (which === "hub" && q > 0) {
        try {
          const hLive = (await get(ref(database, `stock/${dest}/${c.pid}/${encodeSizeKey(s.size)}/qty`))).val();
          const hTarget = Number(allTargets?.[dest]?.[c.pid]?.[encodeSizeKey(s.size)]?.target);
          if (typeof hLive === "number" && Number.isFinite(hTarget)) q = Math.max(0, Math.min(q, hTarget - Math.max(hLive, 0)));
        } catch { /* offline read — keep entered qty */ }
      }
      if (q <= 0) continue;
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: c.pid, size: s.size, qty: q,
          from: c.loc, to: dest, actorRole,
          reason: "excess_rebalance",
          movementId: `${batchId}_${c.pid}_${encodeSizeKey(s.size)}_${dest}`,
          link: { transferId: batchId },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += q; else failed.push(`${s.size}→${dest}: ${res.reason}`);
    }
    setMovedTotal((t) => t + moved);
    setLastResult({ name: c.name, dest, moved, failed });
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
      <div style={{ ...GLASS, padding: "10px 12px", marginBottom: 10 }}>
        <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 800, marginBottom: 8 }}>
          Print pick lists — hand each route to a different staff member (printing moves nothing; confirm here after)
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {routes.map((r) => (
            <button key={`${r.from}>${r.to}`} onClick={() => printRoute(r)} disabled={!r.units}
                    style={{ ...pill(false), opacity: r.units ? 1 : 0.4 }}>
              🖨 {LOC_LABEL[r.from] || r.from} → {LOC_LABEL[r.to] || r.to} ({r.units})
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button onClick={() => setDestView("hub")}
                style={{ ...pill(destView === "hub"), flex: 1, padding: "12px", textAlign: "center", fontSize: 13 }}>
          → Hub 2 · {destTotals.hub} units
        </button>
        <button onClick={() => setDestView("central")}
                style={{ ...pill(destView === "central"), flex: 1, padding: "12px", textAlign: "center", fontSize: 13 }}>
          → Central · {destTotals.central} units
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <button onClick={() => setLocFilter("all")} style={pill(locFilter === "all")}>All ({shown.length})</button>
        {sources.map((l) => (
          <button key={l} onClick={() => setLocFilter(l)} style={pill(locFilter === l)}>
            {LOC_LABEL[l]} ({locCount(l)})
          </button>
        ))}
      </div>
      <input
        value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products…"
        style={{ width: "100%", boxSizing: "border-box", marginBottom: 12, padding: "11px 14px", borderRadius: 12,
                 border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.04)", color: "#fff",
                 fontSize: 13.5, fontFamily: FONT, outline: "none" }}
      />

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

      {groups.map((g) => (
        <React.Fragment key={g.label}>
          <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".08em",
                        fontWeight: 800, margin: "16px 2px 8px", display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ color: "#fff" }}>{g.label}</span>
            <span>{g.items.length} product{g.items.length === 1 ? "" : "s"} · {g.units} units above target</span>
          </div>
          {g.items.map((c) => {
        // The engine RECOMMENDS (prefilled steppers); the warehouse DECIDES —
        // one Transfer button per destination, each independently editable and
        // skippable (owner UX directive 2026-07-13).
        const hubDest = routesCfg[c.loc] || "hub2";
        const hubTotal = c.sizes.reduce((t, s) => t + hubQtyOf(c, s), 0);
        const hubRecommended = c.sizes.reduce((t, s) => t + (s.toHub || 0), 0);
        const centralTotal = c.sizes.reduce((t, s) => t + centralQtyOf(c, s), 0);
        const centralRecommended = c.sizes.reduce((t, s) => t + (s.toCentral || 0), 0);
        const section = { border: "1px solid rgba(255,255,255,.09)", borderRadius: 12, padding: "10px 12px", marginTop: 10 };
        const sectionHead = { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, fontSize: 12.5 };
        return (
          <ProductCard key={c.key}
            photo={c.photo} name={c.name}
            badges={<>
              <Badge tone={BLUE_L}>{LOC_LABEL[c.loc]}</Badge>
              <Badge tone={AMBER}>{c.totalExcess} ABOVE TARGET</Badge>
            </>}
            sub={c.sizes.map((s) => `${s.size}: have ${s.have} / target ${s.target}`).join(" · ")}
          >
            {destView === "hub" && c.loc !== "hub2" && hubRecommended > 0 && (
              <div style={section}>
                <div style={sectionHead}>
                  <span style={{ fontWeight: 800, color: BLUE_L }}>→ {LOC_LABEL[hubDest] || hubDest}</span>
                  <span style={{ color: GRAY }}>engine recommends {hubRecommended} (covers its refill need)</span>
                </div>
                <div style={CHIP_GRID}>
                  {c.sizes.filter((s) => (s.toHub || 0) > 0).map((s) => (
                    <SizeStepperChip key={`h-${s.size}`}
                      size={s.size} qty={hubQtyOf(c, s)} max={s.toHub || 0}
                      onChange={(v) => setEdits((prev) => ({ ...prev, [`${c.key}|${s.size}|hub`]: v }))}
                      hint={`recommended ${s.toHub}`}
                      disabled={busy === c.key}
                    />
                  ))}
                </div>
                <button onClick={() => transferTo(c, "hub")} disabled={busy === c.key || hubTotal === 0}
                        style={{ ...bGreen, width: "100%", marginTop: 10, padding: "11px", opacity: busy === c.key || hubTotal === 0 ? 0.55 : 1 }}>
                  {busy === c.key ? "Transferring…" : `Transfer ${hubTotal} to ${LOC_LABEL[hubDest] || hubDest}`}
                </button>
              </div>
            )}
            {destView === "central" && (
            <div style={section}>
              <div style={sectionHead}>
                <span style={{ fontWeight: 800, color: AMBER }}>→ Central</span>
                <span style={{ color: GRAY }}>engine recommends {centralRecommended} (true surplus)</span>
              </div>
              <div style={CHIP_GRID}>
                {c.sizes.map((s) => (
                  <SizeStepperChip key={`c-${s.size}`}
                    size={s.size} qty={centralQtyOf(c, s)}
                    max={c.loc === "hub2" ? s.excess : Math.max(s.have - s.target, 0)}
                    onChange={(v) => setEdits((prev) => ({ ...prev, [`${c.key}|${s.size}|central`]: v }))}
                    hint={`recommended ${s.toCentral || 0}`}
                    disabled={busy === c.key}
                  />
                ))}
              </div>
              <button onClick={() => transferTo(c, "central")} disabled={busy === c.key || centralTotal === 0}
                      style={{ ...bGreen, width: "100%", marginTop: 10, padding: "11px", opacity: busy === c.key || centralTotal === 0 ? 0.55 : 1 }}>
                {busy === c.key ? "Transferring…" : `Transfer ${centralTotal} to Central`}
              </button>
            </div>
            )}
          </ProductCard>
        );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}
