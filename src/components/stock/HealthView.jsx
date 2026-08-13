// ─── INVENTORY HEALTH — warehouse operations dashboard ────────────────────────
// The AI inventory engine's control centre, redesigned as a proper dashboard
// (owner spec 2026-07-12): a landing grid of visual stat cards, each drilling
// into a product-card workflow — never long lists or spreadsheet rows.
//
//   Landing    — Inventory Health score hero + stat cards (auto refill status,
//                hub2 excess, active/central refill requests, missing products/
//                sizes, policy warnings, negative counts, needs review)
//   Drill-ins  — every screen is product-first: photo, full name, badges, and
//                per-size chips in the Transfer-screen idiom. Actionable where
//                action exists (Auto Refills → transfer per size; Excess →
//                card-by-card cleanup; Central queue → per-size availability
//                transfer), read-only where it's intelligence.
//
// Data producers: functions/refill-scan.cjs (15-min scan) → /stock_exceptions,
// /refill_engine/shadow, /stock_confidence. All styling comes from ui.js tokens
// + healthWidgets.jsx — the existing design language, no new system.

import React, { useMemo, useState } from "react";
import { ref, update, set } from "firebase/database";
import { database } from "../../firebase";
import {
  useStockExceptions, useEngineShadow, useEngineOpen, useEngineRuns,
  useEngineConfig, useRefillRequests, useReceivingSession, useStockCells,
  useStockTargetsState,
  useStockTargets, useTransfers, useRetryState,
} from "./useStock";
import InTransit from "./InTransit";
import { STALE_TRANSIT_HOURS } from "./transitLanes";
import IntroduceExisting from "./IntroduceExisting";
import { computeUnintroduced, destsFrom } from "./introduceExistingCore";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { decodeSizeKey, encodeSizeKey } from "../../utils/sizeKey";
import { FONT, BG, GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen } from "./ui";
import { StatCard, DetailShell, ProductCard, Badge, SizeStepperChip, SizeFactChip, CHIP_GRID } from "./healthWidgets";
import RefillQueue from "./RefillQueue";
import MoveExcess from "./MoveExcess";
import NetworkTransfer from "./NetworkTransfer";
import MissingFootwear from "./MissingFootwear";
import { computeMissingFootwear } from "./missingFootwearCore";
import { computeMissingProducts, buildChips, pickActiveTab } from "./missingProductsCore";
import NoTargetQueue from "./NoTargetQueue";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { sizeRank } from "./hubSizeRank";

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
const locLabel = (l) => LOC_LABEL[l] || l || "—";
const MODE_COLOR = { off: GRAY, shadow: AMBER, live: GREEN };
// Numeric-aware ordering via hubSizeRank (imported at top): letters keep their
// historical ranks; shoe/waist sizes sort numerically after them instead of
// tying at 99 and rendering in arbitrary map order (12/13 would land anywhere).

function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date(serverNowMs()).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return today ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

// ── Auto Refills drill-in: MONITORING ONLY (owner decision 2026-07-12 v4) ─────
// Health never processes daily work — the warehouse Clothing queue and the
// Source Hub 2 Refill queue are the execution surfaces (shadow copies included).
// This screen just summarises the engine's pipeline, with every route explicit:
//   Waiting for Hub 2   — store requests (Hub 2 → Marathon PE / Trophy)
//   Waiting for Central — hub2 requests (Central → Hub 2)
//   Rejected            — sizes the warehouse declined (48h window)
function AutoRefillSummary({ shadow, openIndex, failedRefills, byId }) {
  const [destFilter, setDestFilter] = useState("all");

  const rows = useMemo(() => {
    const byCard = new Map();
    const add = (dest, pid, sizeKey, qty, kind, extra) => {
      const key = `${dest}|${pid}|${kind}`;
      if (!byCard.has(key)) byCard.set(key, { key, dest, pid, kind, sizes: [], ...extra });
      byCard.get(key).sizes.push({ size: decodeSizeKey(sizeKey), qty });
    };
    for (const [dest, byPid] of Object.entries(shadow || {})) {
      for (const [pid, bySize] of Object.entries(byPid || {})) {
        for (const [sizeKey, s] of Object.entries(bySize || {})) add(dest, pid, sizeKey, s.qty, "shadow");
      }
    }
    for (const [dest, byPid] of Object.entries(openIndex || {})) {
      for (const [pid, bySize] of Object.entries(byPid || {})) {
        for (const [sizeKey, e] of Object.entries(bySize || {})) {
          if (e) add(dest, pid, sizeKey, e.qty || 1, "live", { orderId: e.orderId });
        }
      }
    }
    const out = [...byCard.values()];
    out.forEach((c) => c.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)));
    return out;
  }, [shadow, openIndex]);

  const dests = [...new Set(rows.map((r) => r.dest))].sort();
  const shown = destFilter === "all" ? rows : rows.filter((r) => r.dest === destFilter);
  const storeRows = shown.filter((r) => r.dest !== "hub2");
  const hubRows = shown.filter((r) => r.dest === "hub2");

  const pill = (on) => ({
    padding: "7px 14px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer",
    border: on ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
    background: on ? "rgba(60,110,255,.14)" : "rgba(255,255,255,.03)",
    color: on ? BLUE_L : "rgba(255,255,255,.45)",
  });

  const summaryCard = (c) => {
    const p = byId.get(c.pid);
    const route = c.dest === "hub2" ? "Central → Hub 2" : `Hub 2 → ${locLabel(c.dest)}`;
    const queue = c.dest === "hub2" ? "Source → Hub 2 Refill" : "Warehouse → Clothing";
    return (
      <ProductCard key={c.key}
        photo={p?.photoUrl} name={p?.name || c.pid}
        badges={<>
          <Badge tone={BLUE_L}>{route}</Badge>
          <Badge tone={c.kind === "shadow" ? AMBER : GREEN}>{c.kind === "shadow" ? "AUTO (SHADOW)" : "AUTO · LIVE"}</Badge>
        </>}
        sub={`${c.sizes.map((s) => `${s.size}×${s.qty}`).join(" · ")} — in ${queue}`}
      />
    );
  };

  return (
    <>
      <div style={{ ...GLASS, padding: "11px 14px", marginBottom: 12, color: GRAY, fontSize: 12 }}>
        Monitoring only — staff fulfil these in <b style={{ color: "#fff" }}>Warehouse → Clothing</b> (store refills)
        and <b style={{ color: "#fff" }}>Source → Hub 2 Refill</b> (hub restock). Shadow entries are read-only previews.
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        <button onClick={() => setDestFilter("all")} style={pill(destFilter === "all")}>All</button>
        {dests.map((d) => <button key={d} onClick={() => setDestFilter(d)} style={pill(destFilter === d)}>{locLabel(d)}</button>)}
      </div>
      {storeRows.length > 0 && <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "2px 2px 8px" }}>Waiting for Hub 2 ({storeRows.length})</div>}
      {storeRows.map(summaryCard)}
      {hubRows.length > 0 && <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "10px 2px 8px" }}>Waiting for Central ({hubRows.length})</div>}
      {hubRows.map(summaryCard)}
      {failedRefills.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "10px 2px 8px" }}>Rejected by warehouse (48h)</div>
          {failedRefills.map((r, i) => (
            <ProductCard key={i} photo={byId.get(r.pid)?.photoUrl} name={byId.get(r.pid)?.name || r.pid}
              badges={<Badge tone={RED}>REJECTED</Badge>}
              sub={`size ${r.size} · was for ${locLabel(r.dest)} · ${r.orderId || ""}`} />
          ))}
        </>
      )}
      {!rows.length && !failedRefills.length && (
        <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>Nothing planned or in flight — every managed size is at target.</div>
      )}
    </>
  );
}

// Negative-count chip with an admin-only one-tap fix: books a positive
// `adjustment` (admin-gated by the rules) bringing the cell back to exactly 0.
// LIVE-DRIVEN (bugfix 2026-07-12): the row comes from the live /stock
// subscription, NOT the scan snapshot — the earlier snapshot-driven version
// kept showing cells the user had already fixed (the writes always worked;
// the screen was up to 15 minutes stale, which read as "Fix does nothing").
// A fixed cell now vanishes the moment the adjustment lands, and both the
// amount and the idempotency key use the CURRENT quantity.
function NegativeFixChip({ row, actorRole }) {
  const [state, setState] = useState(null); // null | "busy" | "failed"
  const fix = async () => {
    if (state || actorRole !== "admin") return;
    setState("busy");
    let res;
    try {
      res = await applyMovement({
        type: "adjustment", productId: row.pid, size: row.size, qty: Math.abs(row.qty),
        to: row.loc, actorRole,
        reason: "health_negative_zero_fix",
        movementId: `negfix_${row.loc}_${row.pid}_${encodeSizeKey(row.size)}_${row.qty}`,
      });
    } catch (e) { res = { ok: false }; }
    // On success the live stock subscription removes this chip on its own.
    setState(res.ok ? null : "failed");
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, border: `1px solid ${RED}55`, background: "rgba(150,20,20,.1)", borderRadius: 10, padding: "5px 6px 5px 10px", fontSize: 12 }}>
      <span style={{ fontWeight: 800, color: "#fff" }}>{row.size}</span>
      <span style={{ fontWeight: 700, color: RED }}>{row.qty} · {LOC_LABEL[row.loc] || row.loc}</span>
      {actorRole === "admin" && (
        <button onClick={fix} disabled={state === "busy"}
          style={{ border: "1px solid rgba(60,110,255,.35)", background: "rgba(60,110,255,.1)", color: BLUE_L, borderRadius: 7, padding: "2px 8px", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
          {state === "busy" ? "…" : state === "failed" ? "Retry" : "Fix → 0"}
        </button>
      )}
    </span>
  );
}

// ── Recount Needed chip — the reject-streak loop guard's output ───────────────
// A cell the warehouse rejected N times while its counted stock still claims
// units: the engine has STOPPED re-asking (recount, don't loop). The clear
// button is the human side of the loop: after physically recounting (and
// fixing the count via Adjust/Count if it was wrong), "Ask again" deletes the
// streak node (/refill_engine/rejectStreak — delete-only rules carve-out for
// warehouse|admin) and the next scan re-proposes if the deficit still stands.
function RecountChip({ row, actorRole }) {
  const [state, setState] = useState(null); // null | "busy" | "failed" | "cleared"
  const canClear = actorRole === "admin" || actorRole === "warehouse";
  const clear = async () => {
    if (state === "busy" || !canClear) return;
    setState("busy");
    try {
      await set(ref(database, `refill_engine/rejectStreak/${row.loc}/${row.pid}/${encodeSizeKey(row.size)}`), null);
      setState("cleared");   // exception list refreshes on the next scan (≤15 min)
    } catch { setState("failed"); }
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, border: `1px solid ${RED}55`, background: "rgba(150,20,20,.1)", borderRadius: 10, padding: "5px 6px 5px 10px", fontSize: 12 }}>
      <span style={{ fontWeight: 800, color: "#fff" }}>{row.size || "One size"}</span>
      <span style={{ fontWeight: 700, color: RED }}>
        for {locLabel(row.loc)} · {row.rejections != null ? `${row.rejections}× no` : "both levels"} · {locLabel(row.source)} shows {row.showing}
      </span>
      {/* confirmedOut rows (rejections == null) have no streak node to clear —
          their suppression is the 14-day both-levels window, which a recount
          lifts via the arrival movement it books, not via this button. */}
      {canClear && row.rejections != null && (
        <button onClick={clear} disabled={state === "busy" || state === "cleared"}
          style={{ border: "1px solid rgba(60,110,255,.35)", background: "rgba(60,110,255,.1)", color: BLUE_L, borderRadius: 7, padding: "2px 8px", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
          {state === "busy" ? "…" : state === "cleared" ? "Cleared ✓" : state === "failed" ? "Retry" : "Recounted — ask again"}
        </button>
      )}
    </span>
  );
}

// Group flat exception items into per-product cards.
function groupByProduct(items, keyFields) {
  const byPid = new Map();
  for (const it of items || []) {
    const pid = it.pid;
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push(it);
  }
  return [...byPid.entries()];
}

export default function HealthView({ products = [], onExit }) {
  const [screen, setScreen] = useState(null);
  // Missing Products chip. null = nothing chosen yet, so pickActiveTab opens on
  // the first chip — Clothing. The row is two FIXED chips (Clothing, Sneakers;
  // owner directive 2026-08-05), and a stale per-type selection persisted from
  // the old per-subcategory row ("bags", "watches", …) falls back the same way.
  const [missingTab, setMissingTab] = useState(null);
  const exceptions = useStockExceptions();
  const shadow = useEngineShadow();
  const openEngine = useEngineOpen();
  const runs = useEngineRuns(8);
  const config = useEngineConfig();
  const openRequests = useRefillRequests("open");
  const session = useReceivingSession();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const allStock = useStockCells();   // live — drives Negative Inventory truthfully
  // Value AND load/error state: NetworkTransfer gates Solve on the targets read,
  // so it needs to tell "not answered yet" from "answered with nothing" from
  // "could not read" — three states a bare null conflates. `allTargetsRaw` keeps
  // its exact previous meaning for everything below.
  const targetsState = useStockTargetsState();
  const allTargetsRaw = targetsState.value;   // null until the listener answers
  const allTargets = allTargetsRaw || {};
  // Live count of existing products awaiting the one-tap engine migration
  // (v8) — live like Negative Inventory, so the card clears the moment the
  // migration lands instead of lagging a scan cycle. Until stock AND targets
  // have both loaded, fall back to the scan snapshot count (never classify
  // against half-loaded data — with targets null EVERYTHING looks unintroduced).
  const stockReady = allTargetsRaw != null && allStock && Object.keys(allStock).length > 0;
  const migratableLive = useMemo(
    () => (stockReady ? computeUnintroduced(allStock, allTargets, byId, destsFrom(config), config?.categoryPolicy).filter((i) => i.migratable).length : null),
    [stockReady, allStock, allTargets, byId, config],
  );

  // Live negative clothing cells across the whole network (never the snapshot:
  // the scan exceptions lag up to 15 min, which made fixed cells look unfixed).
  const liveNegatives = useMemo(() => {
    if (!allStock || !Object.keys(allStock).length) return null; // still loading
    const isClothingP = (p) => p?.productType === "clothing" ||
      (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));
    const out = [];
    for (const [loc, byPid] of Object.entries(allStock)) {
      for (const [pid, bySize] of Object.entries(byPid || {})) {
        if (!isClothingP(byId.get(pid))) continue;
        for (const [size, cell] of Object.entries(bySize || {})) {
          const qty = Number(cell?.qty) || 0;
          if (qty < 0) out.push({ loc, pid, size, qty });
        }
      }
    }
    return out;
  }, [allStock, byId]);
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canRunSession = ["store", "warehouse", "admin"].includes(actorRole);

  const toggleSession = async () => {
    if (!canRunSession) return;
    const now = serverNowIso();
    await update(ref(database), {
      receiving_session: session?.active
        ? { active: false, openedAt: session.openedAt || null, closedAt: now }
        : { active: true, openedAt: now, closedAt: null },
    }).catch(() => {});
  };

  const nameOf = (pid) => byId.get(pid)?.name || pid || "—";

  const ex = exceptions || {};
  const items = (k) => ex[k]?.items || [];
  const count = (k) => ex[k]?.count || 0;
  const lastRun = runs[0];

  const managed = ex.stats?.managedCells || 0;
  const score = managed ? Math.max(0, Math.round(100 * (1 - count("belowTarget") / managed))) : null;
  const scoreTone = score == null ? GRAY : score >= 80 ? GREEN : score >= 50 ? AMBER : RED;

  const shadowCards = useMemo(() => {
    let n = 0;
    for (const byPid of Object.values(shadow || {})) for (const bySize of Object.values(byPid || {})) n += Object.keys(bySize || {}).length;
    return n;
  }, [shadow]);
  const openCount = useMemo(() => {
    let n = 0;
    for (const byPid of Object.values(openEngine || {})) for (const bySize of Object.values(byPid || {})) n += Object.keys(bySize || {}).length;
    return n;
  }, [openEngine]);
  // Store-leg pipeline (shadow previews + live open intents, hub2 excluded) —
  // these are the requests sitting in Warehouse → Clothing.
  const storeWaiting = useMemo(() => {
    let n = 0;
    for (const node of [shadow, openEngine]) {
      for (const [dest, byPid] of Object.entries(node || {})) {
        if (dest === "hub2") continue;
        for (const bySize of Object.values(byPid || {})) n += Object.keys(bySize || {}).length;
      }
    }
    return n;
  }, [shadow, openEngine]);
  const centralQueue = openRequests.filter((r) => r.requestingLocation === "hub2").length;
  // Transit lanes (2026-07-19): cross-building sends parked in the in_transit
  // holding. Stale = unreceived past the threshold, or short-received awaiting
  // an admin resolution — either way someone should chase a physical box.
  const allTransfers = useTransfers();
  const retryState = useRetryState();
  const transitOpen = useMemo(() => allTransfers.filter((t) => t.status && t.status !== "received"), [allTransfers]);
  const transitStale = useMemo(() => transitOpen.filter((t) => {
    if (t.status === "discrepancy") return true;
    const at = Date.parse(t.createdAt || "");
    return Number.isFinite(at) && serverNowMs() - at > STALE_TRANSIT_HOURS * 3600e3;
  }).length, [transitOpen]);
  // Stranded non-footwear, computed CLIENT-SIDE from live /stock — the same
  // function that builds the list inside the tab (missingProductsCore). It used
  // to be the scan's unit-based buckets (onlyInCentral + onlyInHub2), which
  // counted a different thing from what the list showed: 391 vs 380 measured
  // 2026-08-03. Harmless while it was one number over one list; not harmless
  // once the tab splits into category chips, because chips summing to 380 under
  // a 391 headline reads as a broken screen. Sneakers already work this way and
  // the note below says why that was the right call.
  //
  // null until /stock answers. The old count came from the scan snapshot and was
  // there immediately; a client-side count is 0 until the listener fires, and a
  // GREEN 0 on the dashboard states "nothing is stranded" at the exact moment we
  // know nothing at all. Same gate this file already applies to migratableLive
  // and liveNegatives above. (CodeRabbit, PR #308.)
  const missingProductCards = useMemo(
    () => (allStock && Object.keys(allStock).length ? computeMissingProducts({ allStock, products }) : null),
    [allStock, products],
  );
  // Clothing AND perfume cards (2026-08-13) — everything the NetworkTransfer
  // list renders. Named for what it is NOT (sneakers), because the headline sum
  // below adds the sneaker list on top and must count every card exactly once.
  const missingNonSneaker = missingProductCards?.length ?? null;
  // SNEAKERS are computed CLIENT-SIDE from live /stock, deliberately, not from the
  // scan's exception buckets: the engine's Health loop is clothing-only
  // (`if (!isClothing(...)) continue` — "sneakers never appear in Health"), so a
  // server-side count would need an engine change and a functions deploy for what
  // is a read. It also means this count and the list inside the tab come from ONE
  // function, so they cannot drift apart. The clothing pair above now follows the
  // same rule — it used to be the scan's buckets over a carriage-based list, and
  // that is the drift this comment used to describe as live. (PR #308.)
  const missingSneakerCards = useMemo(
    () => computeMissingFootwear({ allStock, products }),
    [allStock, products],
  );
  // null while stock loads — see missingProductCards. Sneakers alone would be a
  // half-answer, so the whole figure waits rather than under-reporting.
  const missingProducts = missingNonSneaker == null ? null : missingNonSneaker + missingSneakerCards.length;
  // ("Needs Review" was removed 2026-07-12 v3 — the confidence signal still
  // feeds /stock_confidence for future use, but every dashboard card must lead
  // to an action, and a score without a workflow didn't.)

  const modeSummary = (() => {
    const modes = Object.values(config?.mode || {});
    if (!config) return "…";
    if (!config.enabled) return "OFF";
    if (modes.every((m) => m === "live")) return "LIVE";
    if (modes.some((m) => m === "live")) return "PARTIAL";
    if (modes.some((m) => m === "shadow")) return "SHADOW";
    return "OFF";
  })();
  const modeTone = modeSummary === "LIVE" ? GREEN : modeSummary === "OFF" ? RED : AMBER;

  // ── drill-in screens ─────────────────────────────────────────────────────────
  const detail = (() => {
    if (!screen) return null;
    const back = () => setScreen(null);
    switch (screen) {
      case "autorefills":
        return (
          <DetailShell title="Auto Refills" sub="Monitoring — fulfilment happens in the Warehouse and Source queues" count={openCount + shadowCards} onBack={back}>
            <AutoRefillSummary shadow={shadow} openIndex={openEngine} failedRefills={items("failedRefills")} byId={byId} />
          </DetailShell>
        );
      case "central":
        return (
          <DetailShell title="Central → Hub 2 Refills" sub="Also available on the Source card" count={centralQueue} onBack={back}>
            <RefillQueue products={products} dest="hub2" />
          </DetailShell>
        );
      case "excess":
        return (
          <DetailShell title="Excess Rebalance" sub="Above target — one tap auto-splits: network needs → Hub 2, true surplus → Central" count={count("excess")} onBack={back}>
            <MoveExcess products={products} actorRole={actorRole} />
          </DetailShell>
        );
      case "intransit":
        return (
          <DetailShell title="In Transit" sub={`Cross-building sends awaiting receive — flagged stale after ${STALE_TRANSIT_HOURS}h`} count={transitOpen.length} onBack={back}>
            <InTransit products={products} />
          </DetailShell>
        );
      // TWO TABS, TWO RULES — they are not the same question.
      //   Clothing — Central/Hub 2 stock the SHOPS don't carry. Shops hold
      //              clothing buffer, so they are the right downstream to test.
      //   Sneakers — Central stock NEITHER HUB holds. Shoes pass through
      //              shop → customer and hold no shop buffer by design (267 shop
      //              shoe cells were zeroed for this reason; PE holds 16 footwear
      //              units across 2,454 cells), so testing the shops would flag
      //              nearly the whole catalogue and mean nothing. Hub 1 and Hub 2
      //              are where sneaker buffer lives.
      case "missingProducts": {
        // Three fixed chips — Clothing (owner directive 2026-08-05), Perfume
        // (2026-08-13) and Sneakers (its own list). All always render, even at
        // 0, so the row never reshuffles under the operator.
        const chips = buildChips(missingProductCards || [], missingSneakerCards.length);
        const activeTab = pickActiveTab(chips, missingTab);
        return (
          <DetailShell title="Missing Products" sub="Stranded upstream — pick sizes, pick a destination, transfer" count={missingProducts ?? "—"} onBack={back}>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              {chips.map(([key, label, n]) => (
                <button key={key} onClick={() => setMissingTab(key)}
                  style={{
                    padding: "7px 14px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
                    border: activeTab === key ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
                    background: activeTab === key ? "rgba(60,110,255,.14)" : "rgba(255,255,255,.03)",
                    color: activeTab === key ? BLUE_L : "rgba(255,255,255,.45)",
                  }}>
                  {label} ({n})
                </button>
              ))}
            </div>
            {activeTab === "sneakers"
              ? <MissingFootwear products={products} />
              : <NetworkTransfer products={products} category={activeTab} allStock={allStock} cards={missingProductCards || []} targets={allTargetsRaw} targetsSettled={targetsState.settled} targetsError={targetsState.error} />}
          </DetailShell>
        );
      }
      case "missingSizes":
        return (
          <DetailShell title="Missing Sizes" sub="Real demand, zero stock anywhere — reorder candidates" count={count("missingSizes")} onBack={back}>
            {groupByProduct(items("missingSizes")).map(([pid, rows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={RED}>REORDER</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {rows.map((r, i) => <SizeFactChip key={i} size={r.size} value={`need ${r.wanted} · ${locLabel(r.loc)}`} tone={RED} />)}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
      // Demand parked behind a warehouse rejection. The engine holds the ask
      // (cooldown) but keeps watching the ledger: the moment stock ARRIVES at
      // the rejecting source, the request reopens on the next scan — nothing
      // here needs action, it exists so parked demand is never invisible.
      case "waitingForStock":
        return (
          <DetailShell title="Waiting for Stock" sub="Rejected by the warehouse — reopens automatically the moment stock arrives at the source" count={count("waitingForStock")} onBack={back}>
            {groupByProduct(items("waitingForStock")).map(([pid, rows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={AMBER}>WAITING</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {rows.map((r) => <SizeFactChip key={`${r.loc}|${r.size}`} size={r.size} value={`need ${r.deficit} · ${locLabel(r.loc)} ← ${locLabel(r.source)}`} tone={AMBER} />)}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
      case "retryQueue": {
        const rows = [];
        for (const [dest, byPid] of Object.entries(retryState || {})) {
          for (const [pid, bySize] of Object.entries(byPid || {})) {
            for (const [sizeKey, r] of Object.entries(bySize || {})) {
              rows.push({ dest, pid, sizeKey, ...r });
            }
          }
        }
        const grouped = groupByProduct(rows);
        return (
          <DetailShell title="Rejected / Waiting Retry" sub="Refill requests rejected by the warehouse — the engine retries automatically every 24h while stock exists upstream" count={rows.length} onBack={back}>
            {grouped.map(([pid, prows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={AMBER}>RETRY</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {prows.map((r) => (
                    <SizeFactChip key={`${r.dest}|${r.sizeKey}`}
                      size={decodeSizeKey(r.sizeKey)}
                      value={`${r.retryCount || 0}× · next ${fmtTs(r.nextRetryAt)} · ${locLabel(r.dest)} ← ${locLabel(r.source)}`}
                      tone={AMBER} />
                  ))}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
      }
      // Migration, deliberately NOT a decision (owner v8): existing products
      // that never entered engine management get the approved standard run in
      // one tap; the engine takes over on the next scan.
      case "introduceExisting":
        return (
          <DetailShell title="Introduce Existing Products" sub="Already circulating, never onboarded — one tap applies your approved standard targets" count={migratableLive ?? count("unintroduced")} onBack={back}>
            <IntroduceExisting products={products} />
          </DetailShell>
        );
      // v9 passive categories — visibility, never work. These cells re-enter
      // the working queues automatically the moment the upstream stock allows.
      case "awaitingUpstream":
        return (
          <DetailShell title="Awaiting Previous Transfer" sub="The chain is flowing — these legs auto-create the scan after their source receives stock" count={count("awaitingUpstream")} onBack={back}>
            {groupByProduct(items("awaitingUpstream")).map(([pid, rows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={BLUE_L}>IN TRANSIT CHAIN</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {rows.map((r) => <SizeFactChip key={`${r.loc}|${r.size}`} size={r.size} value={`need ${r.deficit} · ${locLabel(r.loc)} ← ${locLabel(r.source)}`} tone={BLUE_L} />)}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
      case "awaitingSupplier":
        return (
          <DetailShell title="Waiting for Supplier" sub="Nothing upstream can fill these — reorder from the supplier or return stranded store stock via Move Excess" count={count("awaitingSupplier")} onBack={back}>
            {groupByProduct(items("awaitingSupplier")).map(([pid, rows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={AMBER}>UPSTREAM EMPTY</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {rows.map((r) => <SizeFactChip key={`${r.loc}|${r.size}`} size={r.size} value={`need ${r.deficit} · ${locLabel(r.loc)}`} tone={AMBER} />)}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
      case "recountNeeded":
        return (
          <DetailShell title="Recount Needed" sub="Rejected repeatedly while the count claims stock — the count is the suspect. Recount the location, fix it via Count/Adjust, then tap Recounted." count={count("recountNeeded")} onBack={back}>
            {groupByProduct(items("recountNeeded")).map(([pid, rows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={RED}>COUNT MISMATCH</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {rows.map((r) => (
                    <RecountChip key={`${r.loc}|${r.size}`} row={r} actorRole={actorRole} />
                  ))}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
      case "noTarget":
        return (
          <DetailShell title="Decision Queue" sub="Genuinely new supplier products · numeric-size quantities · assortment leftovers — real decisions only" count={count("noTarget")} onBack={back}>
            <NoTargetQueue products={products} />
          </DetailShell>
        );
      case "negative": {
        // LIVE data (bugfix): fixed cells disappear instantly instead of
        // lingering in the up-to-15-min-old scan snapshot.
        const rows = liveNegatives || [];
        const grouped = groupByProduct(rows);
        return (
          <DetailShell title="Negative Inventory"
            sub={liveNegatives == null ? "Loading live stock…" : actorRole === "admin" ? "Live — Fix books a correcting adjustment to 0; the chip disappears when it lands" : "Live — an admin can zero these"}
            count={liveNegatives == null ? count("negativeCells") : rows.length} onBack={back}>
            {liveNegatives != null && rows.length === 0 && (
              <div style={{ ...GLASS, padding: 20, textAlign: "center", color: GREEN, fontWeight: 700, fontSize: 14 }}>
                No negative counts anywhere 🎉
              </div>
            )}
            {grouped.map(([pid, prows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={RED}>NEGATIVE</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {prows.map((r) => (
                    <NegativeFixChip key={`${r.loc}|${r.size}`} row={r} actorRole={actorRole} />
                  ))}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
      }
      case "activity":
        return (
          <DetailShell title="Engine Activity" sub="Recent scans" count={runs.length} onBack={back}>
            {runs.map((r) => (
              <div key={r.id} style={{ ...GLASS, padding: "11px 13px", marginBottom: 8, display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5 }}>
                <span style={{ fontWeight: 700 }}>{fmtTs(r.finishedAt || r.startedAt)}</span>
                <span style={{ color: r.error ? RED : GRAY }}>
                  {r.error ? String(r.error).slice(0, 60)
                    : r.skipped ? r.skipped
                    : `${r.counts?.intents || 0} created · ${r.counts?.shadow || 0} planned · ${r.counts?.closes || 0} closed`}
                </span>
              </div>
            ))}
          </DetailShell>
        );
      default: return null;
    }
  })();

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
      <div style={{ padding: "14px 16px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={screen ? () => setScreen(null) : onExit}
                style={{ background: "none", border: "none", padding: 0, color: BLUE_L, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: FONT }}>
          {screen ? "← Dashboard" : "← Exit"}
        </button>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Inventory Health</div>
        <div style={{ minWidth: 40 }} />
      </div>

      <div style={{ padding: "4px 12px 40px" }}>
        {detail || (
          <>
            {/* Receiving session — inventory SETUP mode: engine fully paused */}
            <div style={{ ...GLASS, padding: "11px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, border: session?.active ? "1px solid rgba(251,191,36,.45)" : undefined }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: session?.active ? AMBER : "#fff" }}>
                  Receiving session {session?.active ? "OPEN — engine paused" : "closed"}
                </div>
                <div style={{ color: GRAY, fontSize: 11, marginTop: 2 }}>
                  {session?.active
                    ? `Since ${fmtTs(session.openedAt)} — receive · count · QC · distribute, then close to resume automation`
                    : "Open when a supplier shipment arrives at Central — pauses all automatic requests and balancing"}
                </div>
              </div>
              {canRunSession && (
                <button onClick={toggleSession}
                        style={{ flexShrink: 0, padding: "9px 14px", borderRadius: 10, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT,
                                 border: session?.active ? "1px solid rgba(0,150,70,.5)" : "1px solid rgba(251,191,36,.45)",
                                 background: session?.active ? "rgba(0,150,70,.15)" : "rgba(251,191,36,.1)",
                                 color: session?.active ? GREEN : AMBER }}>
                  {session?.active ? "Close session — resume engine" : "Open session"}
                </button>
              )}
            </div>

            {/* Hero: score + engine state */}
            <div style={{ ...GLASS, padding: "16px 16px", marginBottom: 12, display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 40, fontWeight: 800, color: scoreTone, lineHeight: 1 }}>{score == null ? "—" : `${score}%`}</div>
                <div style={{ fontSize: 9.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".07em", marginTop: 4 }}>Inventory Health</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                  {Object.entries(config?.mode || {}).map(([loc, mode]) => (
                    <span key={loc} style={{ fontSize: 10.5, padding: "3px 8px", borderRadius: 8, border: `1px solid ${MODE_COLOR[mode] || GRAY}`, color: MODE_COLOR[mode] || GRAY }}>
                      {locLabel(loc)} · {mode}
                    </span>
                  ))}
                </div>
                <div style={{ color: GRAY, fontSize: 11 }}>
                  {lastRun ? `Last scan ${fmtTs(lastRun.finishedAt || lastRun.startedAt)}` : "No scans yet"}
                  {managed ? ` · ${managed.toLocaleString()} managed sizes` : ""}
                </div>
              </div>
            </div>

            {/* Stat card grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))", gap: 10 }}>
              <StatCard label="Auto Refill Status" value={modeSummary} tone={modeTone}
                        sub={lastRun?.counts ? `${lastRun.counts.intents || 0} created · ${lastRun.counts.shadow || 0} planned last scan` : undefined}
                        onClick={() => setScreen("activity")} />
              <StatCard label="Waiting for Hub 2" value={storeWaiting} tone={storeWaiting ? BLUE_L : GREEN}
                        sub="Store refills · in Warehouse → Clothing" onClick={() => setScreen("autorefills")} />
              <StatCard label="Waiting for Central" value={centralQueue} tone={centralQueue ? BLUE_L : GREEN}
                        sub="Hub 2 restock · in Source → Hub 2 Refill" onClick={() => setScreen("central")} />
              <StatCard label="Rejected / Failed" value={count("failedRefills")} tone={count("failedRefills") ? RED : GREEN}
                        sub="Declined by warehouse (48h)" onClick={() => setScreen("autorefills")} />
              <StatCard label="Retry Queue" value={Object.values(retryState || {}).reduce((t, byPid) => t + Object.values(byPid || {}).reduce((t2, bySize) => t2 + Object.keys(bySize || {}).length, 0), 0)} tone={Object.keys(retryState || {}).length ? AMBER : GREEN}
                        sub="Rejected — auto-retry every 24h" onClick={() => setScreen("retryQueue")} />
              <StatCard label="Waiting for Stock" value={count("waitingForStock")} tone={count("waitingForStock") ? AMBER : GREEN}
                        sub="Rejected demand — auto-reopens on arrival" onClick={() => setScreen("waitingForStock")} />
              <StatCard label="Awaiting Transfer" value={count("awaitingUpstream")} tone={count("awaitingUpstream") ? BLUE_L : GREEN}
                        sub="Chain flowing — auto-creates when stock lands" onClick={() => setScreen("awaitingUpstream")} />
              <StatCard label="Waiting for Supplier" value={count("awaitingSupplier")} tone={count("awaitingSupplier") ? AMBER : GREEN}
                        sub="Upstream empty — reorder or return excess" onClick={() => setScreen("awaitingSupplier")} />
              <StatCard label="In Transit" value={transitOpen.length} tone={transitStale ? AMBER : transitOpen.length ? BLUE_L : GREEN}
                        sub={transitStale ? `${transitStale} stale or short — chase the box` : "Cross-building sends awaiting receive"}
                        onClick={() => setScreen("intransit")} />
              <StatCard label="Excess Inventory" value={count("excess")} tone={count("excess") ? AMBER : GREEN}
                        sub="Hub 2 + shops above target → rebalance" onClick={() => setScreen("excess")} />
              <StatCard label="Missing Products" value={missingProducts == null ? "—" : missingProducts}
                        tone={missingProducts == null ? GRAY : missingProducts ? AMBER : GREEN}
                        sub={missingProducts == null ? "Loading live stock…" : "Stranded upstream — transfer from here"}
                        onClick={() => setScreen("missingProducts")} />
              <StatCard label="Missing Sizes" value={count("missingSizes")} tone={count("missingSizes") ? RED : GREEN}
                        sub="Zero stock anywhere — your reorder list" onClick={() => setScreen("missingSizes")} />
              <StatCard label="Recount Needed" value={count("recountNeeded")} tone={count("recountNeeded") ? RED : GREEN}
                        sub="Rejected repeatedly while the count claims stock" onClick={() => setScreen("recountNeeded")} />
              <StatCard label="Decision Queue" value={count("noTarget")} tone={count("noTarget") ? BLUE_L : GREEN}
                        sub="New supplier products & real decisions only" onClick={() => setScreen("noTarget")} />
              <StatCard label="Introduce Existing" value={migratableLive ?? count("unintroduced")} tone={(migratableLive ?? count("unintroduced")) ? AMBER : GREEN}
                        sub="Existing stock → engine management, one tap" onClick={() => setScreen("introduceExisting")} />
              <StatCard label="Negative Inventory"
                        value={liveNegatives == null ? count("negativeCells") : liveNegatives.length}
                        tone={(liveNegatives == null ? count("negativeCells") : liveNegatives.length) ? RED : GREEN}
                        sub="Live count — one-tap fix" onClick={() => setScreen("negative")} />
              <StatCard label="Stuck Refills" value={count("stuckRefills")} tone={count("stuckRefills") ? RED : GREEN}
                        sub={`Waiting > ${config?.staleIntentHours || 48}h`} onClick={() => setScreen("activity")} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
