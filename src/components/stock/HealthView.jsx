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
import {
  useStockExceptions, useEngineShadow, useEngineRuns,
  useEngineConfig, useRefillRequests, useStockCells,
} from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { decodeSizeKey, encodeSizeKey } from "../../utils/sizeKey";
import { FONT, BG, GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen } from "./ui";
import { StatCard, DetailShell, ProductCard, Badge, SizeStepperChip, SizeFactChip, CHIP_GRID } from "./healthWidgets";
import Hub2RefillQueue from "./Hub2RefillQueue";
import MoveExcess from "./MoveExcess";
import NetworkTransfer from "./NetworkTransfer";

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
const locLabel = (l) => LOC_LABEL[l] || l || "—";
const MODE_COLOR = { off: GRAY, shadow: AMBER, live: GREEN };
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return today ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

// ── Auto Refills drill-in: the engine's current plan as actionable cards ──────
// Shadow entries grouped per (store, product). Staff review size by size —
// reject what isn't physically findable — and Transfer executes real hub2→store
// movements immediately (same applyMovement path as every transfer). The next
// scan reconciles whatever remains.
function AutoRefillCards({ shadow, byId, actorRole, hubCells }) {
  const [edits, setEdits] = useState({});     // `${dest}|${pid}|${sizeKey}` → qty
  const [rejects, setRejects] = useState({});
  const [busyKey, setBusyKey] = useState(null);
  const [done, setDone] = useState({});       // cardKey → {moved, failed[]}

  const canAct = ["store", "warehouse", "admin"].includes(actorRole);
  const cards = useMemo(() => {
    const byCard = new Map();
    for (const [dest, byPid] of Object.entries(shadow || {})) {
      for (const [pid, bySize] of Object.entries(byPid || {})) {
        const key = `${dest}|${pid}`;
        if (!byCard.has(key)) byCard.set(key, { key, dest, pid, sizes: [] });
        for (const [sizeKey, s] of Object.entries(bySize || {})) {
          byCard.get(key).sizes.push({ sizeKey, size: decodeSizeKey(sizeKey), qty: s.qty, priority: s.priority });
        }
      }
    }
    const out = [...byCard.values()];
    out.forEach((c) => c.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)));
    return out.sort((a, b) => a.dest.localeCompare(b.dest) ||
      (b.sizes.some((s) => s.priority === "high") ? 1 : 0) - (a.sizes.some((s) => s.priority === "high") ? 1 : 0));
  }, [shadow]);

  const availOf = (pid, size) => Math.max(Number(hubCells?.[pid]?.[String(size)]?.qty) || 0, 0);
  const qtyOf = (c, s) => {
    const v = edits[`${c.key}|${s.sizeKey}`];
    const cap = Math.min(s.qty, availOf(c.pid, s.size));
    return Math.max(0, Math.min(v == null ? cap : v, cap));
  };

  const transfer = async (c) => {
    if (busyKey || !canAct) return;
    const lines = c.sizes.filter((s) => !rejects[`${c.key}|${s.sizeKey}`]).map((s) => ({ s, qty: qtyOf(c, s) })).filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusyKey(c.key);
    const batch = `har_${Date.now().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { s, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: c.pid, size: s.size, qty,
          from: "hub2", to: c.dest, actorRole,
          reason: "clothing_refill",
          movementId: `${batch}_${c.pid}_${s.sizeKey}`,
          link: { transferId: batch },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += qty; else failed.push(`${s.size}: ${res.reason}`);
    }
    setDone((d) => ({ ...d, [c.key]: { moved, failed } }));
    setBusyKey(null);
  };

  if (!cards.length) {
    return <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>Nothing planned right now — every managed size is at target or already inbound.</div>;
  }
  return (
    <>
      {!canAct && <div style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>You need a stock role to transfer — viewing only.</div>}
      {cards.map((c) => {
        const p = byId.get(c.pid);
        const result = done[c.key];
        const total = c.sizes.filter((s) => !rejects[`${c.key}|${s.sizeKey}`]).reduce((t, s) => t + qtyOf(c, s), 0);
        return (
          <ProductCard key={c.key}
            photo={p?.photoUrl} name={p?.name || c.pid}
            badges={<>
              <Badge tone={BLUE_L}>{locLabel(c.dest)}</Badge>
              <Badge tone={AMBER}>AUTO</Badge>
              {c.sizes.some((s) => s.priority === "high") && <Badge tone={RED}>URGENT</Badge>}
            </>}
          >
            {result ? (
              <div style={{ fontSize: 12.5 }}>
                <span style={{ color: GREEN, fontWeight: 700 }}>{result.moved} units → {locLabel(c.dest)} ✓</span>
                {result.failed.length > 0 && <div style={{ color: RED, marginTop: 4 }}>Failed: {result.failed.join(" · ")}</div>}
              </div>
            ) : (
              <>
                <div style={CHIP_GRID}>
                  {c.sizes.map((s) => (
                    <SizeStepperChip key={s.sizeKey}
                      size={s.size}
                      qty={qtyOf(c, s)}
                      max={Math.min(s.qty, availOf(c.pid, s.size))}
                      onChange={(v) => setEdits((e) => ({ ...e, [`${c.key}|${s.sizeKey}`]: v }))}
                      rejected={!!rejects[`${c.key}|${s.sizeKey}`]}
                      onReject={() => setRejects((r) => ({ ...r, [`${c.key}|${s.sizeKey}`]: !r[`${c.key}|${s.sizeKey}`] }))}
                      hint={`asked ×${s.qty} · ${availOf(c.pid, s.size)} here`}
                      disabled={!canAct}
                    />
                  ))}
                </div>
                <button onClick={() => transfer(c)} disabled={busyKey === c.key || total === 0 || !canAct}
                        style={{ ...bGreen, width: "100%", marginTop: 12, padding: "12px", opacity: busyKey === c.key || total === 0 || !canAct ? 0.5 : 1 }}>
                  {busyKey === c.key ? "Transferring…" : `Transfer ${total} unit${total === 1 ? "" : "s"} to ${locLabel(c.dest)}`}
                </button>
              </>
            )}
          </ProductCard>
        );
      })}
    </>
  );
}

// Negative-count chip with an admin-only one-tap fix: books a positive
// `adjustment` (admin-gated by the rules) bringing the cell back to exactly 0 —
// the same correction the recon scripts perform, but from the dashboard.
function NegativeFixChip({ row, pid, actorRole }) {
  const [state, setState] = useState(null); // null | "busy" | "done" | "failed"
  const size = decodeSizeKey(row.sizeKey);
  const fix = async () => {
    if (state || actorRole !== "admin") return;
    setState("busy");
    let res;
    try {
      res = await applyMovement({
        type: "adjustment", productId: pid, size, qty: Math.abs(row.qty),
        to: row.loc, actorRole,
        reason: "health_negative_zero_fix",
        movementId: `negfix_${row.loc}_${pid}_${row.sizeKey}_${row.qty}`,
      });
    } catch (e) { res = { ok: false }; }
    setState(res.ok ? "done" : "failed");
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, border: `1px solid ${state === "done" ? GREEN : RED}55`, background: state === "done" ? "rgba(0,150,70,.1)" : "rgba(150,20,20,.1)", borderRadius: 10, padding: "5px 6px 5px 10px", fontSize: 12 }}>
      <span style={{ fontWeight: 800, color: "#fff" }}>{size}</span>
      <span style={{ fontWeight: 700, color: state === "done" ? GREEN : RED }}>{state === "done" ? "0 ✓" : `${row.qty} · ${LOC_LABEL[row.loc] || row.loc}`}</span>
      {actorRole === "admin" && state !== "done" && (
        <button onClick={fix} disabled={state === "busy"}
          style={{ border: "1px solid rgba(60,110,255,.35)", background: "rgba(60,110,255,.1)", color: BLUE_L, borderRadius: 7, padding: "2px 8px", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
          {state === "busy" ? "…" : state === "failed" ? "Retry" : "Fix → 0"}
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
  const exceptions = useStockExceptions();
  const shadow = useEngineShadow();
  const runs = useEngineRuns(8);
  const config = useEngineConfig();
  const openRequests = useRefillRequests("open");
  const hubCells = useStockCells("hub2");
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
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
  const centralQueue = openRequests.filter((r) => r.requestingLocation === "hub2").length;
  const missingProducts = count("onlyInCentral") + count("onlyInHub2");
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

  const WARNING_LABEL = {
    size_not_carried: "size not carried",
    inactive_product: "inactive product",
    unknown_product: "product missing",
    not_clothing: "not clothing",
  };

  // ── drill-in screens ─────────────────────────────────────────────────────────
  const detail = (() => {
    if (!screen) return null;
    const back = () => setScreen(null);
    switch (screen) {
      case "autorefills":
        return (
          <DetailShell title="Auto Refills" sub="The engine's current plan — reject what you can't find, transfer the rest" count={shadowCards} onBack={back}>
            <AutoRefillCards shadow={shadow} byId={byId} actorRole={actorRole} hubCells={hubCells} />
          </DetailShell>
        );
      case "central":
        return (
          <DetailShell title="Central → Hub 2 Refills" sub="Also available on the Source card" count={centralQueue} onBack={back}>
            <Hub2RefillQueue products={products} />
          </DetailShell>
        );
      case "excess":
        return (
          <DetailShell title="Excess Rebalance" sub="Hub 2 + shops above target — send back to Hub 2 or Central" count={count("excess")} onBack={back}>
            <MoveExcess products={products} actorRole={actorRole} />
          </DetailShell>
        );
      case "missingProducts":
        return (
          <DetailShell title="Missing Products" sub="Stranded upstream — pick sizes, pick a destination, transfer" count={missingProducts} onBack={back}>
            <NetworkTransfer products={products} />
          </DetailShell>
        );
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
      case "policy":
        return (
          <DetailShell title="Policy Warnings" sub="Review these before trusting live refills" count={count("policyWarnings")} onBack={back}>
            {groupByProduct(items("policyWarnings")).map(([pid, rows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={AMBER}>POLICY</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {rows.map((w, i) => (
                    <SizeFactChip key={i} size={w.sizeKey ? decodeSizeKey(w.sizeKey) : locLabel(w.loc)} value={WARNING_LABEL[w.kind] || w.kind} tone={AMBER} />
                  ))}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
      case "negative":
        return (
          <DetailShell title="Negative Inventory" sub={actorRole === "admin" ? "Oversell / count holes — Fix books a correcting adjustment to 0" : "Oversell / count holes — an admin can zero these"} count={count("negativeCells")} onBack={back}>
            {groupByProduct(items("negativeCells")).map(([pid, rows]) => (
              <ProductCard key={pid} photo={byId.get(pid)?.photoUrl} name={nameOf(pid)}
                badges={<Badge tone={RED}>NEGATIVE</Badge>}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {rows.map((r, i) => (
                    <NegativeFixChip key={i} row={r} pid={pid} actorRole={actorRole} />
                  ))}
                </div>
              </ProductCard>
            ))}
          </DetailShell>
        );
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
              <StatCard label="Active Refill Requests" value={shadowCards} tone={shadowCards ? BLUE_L : GREEN}
                        sub="Engine plan — review & transfer" onClick={() => setScreen("autorefills")} />
              <StatCard label="Central Refill Requests" value={centralQueue} tone={centralQueue ? BLUE_L : GREEN}
                        sub="Hub 2 restock queue" onClick={() => setScreen("central")} />
              <StatCard label="Excess Inventory" value={count("excess")} tone={count("excess") ? AMBER : GREEN}
                        sub="Hub 2 + shops above target → rebalance" onClick={() => setScreen("excess")} />
              <StatCard label="Missing Products" value={missingProducts} tone={missingProducts ? AMBER : GREEN}
                        sub="Stranded upstream — transfer from here" onClick={() => setScreen("missingProducts")} />
              <StatCard label="Missing Sizes" value={count("missingSizes")} tone={count("missingSizes") ? RED : GREEN}
                        sub="Zero stock anywhere — your reorder list" onClick={() => setScreen("missingSizes")} />
              <StatCard label="Policy Warnings" value={count("policyWarnings")} tone={count("policyWarnings") ? AMBER : GREEN}
                        sub="Data problems in the targets" onClick={() => setScreen("policy")} />
              <StatCard label="Negative Inventory" value={count("negativeCells")} tone={count("negativeCells") ? RED : GREEN}
                        sub="Oversell / count holes — one-tap fix" onClick={() => setScreen("negative")} />
              <StatCard label="Stuck Refills" value={count("stuckRefills")} tone={count("stuckRefills") ? RED : GREEN}
                        sub={`Waiting > ${config?.staleIntentHours || 48}h`} onClick={() => setScreen("activity")} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
