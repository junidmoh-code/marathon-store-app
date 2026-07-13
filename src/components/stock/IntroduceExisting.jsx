// ─── INTRODUCE EXISTING PRODUCTS TO ENGINE — one-tap migration screen ─────────
// (owner architecture 2026-07-13 v8) Deliberately NOT a decision queue: the
// decision (the standard run) was already made. This screen shows what the
// migration will do, then one admin tap applies the approved standard targets
// to every zero-target clothing product already circulating at PE/Trophy/Hub 2
// and the engine takes over permanently. Numeric-size products (no approved
// standard quantities) are listed separately — those remain genuine decisions
// in the Decision Queue.

import React, { useMemo, useState } from "react";
import { useStockCells, useStockTargets, useEngineConfig } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { computeUnintroduced, migrateToEngine, destsFrom, effectiveRun } from "./introduceExisting";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { ProductCard, Badge } from "./healthWidgets";

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };

export default function IntroduceExisting({ products = [] }) {
  const allStock = useStockCells();
  const allTargetsRaw = useStockTargets();   // null until the listener answers
  const allTargets = allTargetsRaw || {};
  const config = useEngineConfig();
  const { permRecord, isSuperAdmin } = usePermissions();
  const isAdmin = isSuperAdmin || permRecord?.stockRole === "admin";
  // Never classify against half-loaded data: with targets still null EVERY
  // product would look unintroduced (and with stock empty, none would).
  const loading = allTargetsRaw == null || !allStock || !Object.keys(allStock).length;

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const dests = useMemo(() => destsFrom(config), [config]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const items = useMemo(
    () => (loading ? [] : computeUnintroduced(allStock, allTargets, byId, dests)),
    [loading, allStock, allTargets, byId, dests],
  );
  const migratable = items.filter((i) => i.migratable);
  const numeric = items.filter((i) => !i.migratable);
  const cellEstimate = migratable.reduce((t, i) => t + i.standardSizes.length * dests.length, 0);
  // Preview EXACTLY the run the migration will apply (validated config or the
  // approved fallback) — never a raw config value the writer would reject.
  const run = effectiveRun(config, "marathon-pe");

  const apply = async () => {
    if (busy || !isAdmin || !migratable.length) return;
    setBusy(true);
    setResult(null);
    const res = await migrateToEngine(items, {
      config, approvedBy: "introduce-existing", onProgress: setProgress,
    });
    setResult(res);
    setBusy(false);
    setProgress(null);
  };

  if (result) {
    const ok = !result.failed.length;
    return (
      <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: ok ? GREEN : AMBER }}>
          {ok ? "Migration complete 🎉" : "Migration finished with errors"}
        </div>
        <div style={{ color: GRAY, fontSize: 12.5, marginTop: 8, lineHeight: 1.6 }}>
          {result.done} of {result.total} products introduced · {result.cells} target cells written (batch {result.batchId}).
          {result.skippedTaken > 0 && <> {result.skippedTaken} skipped — targets appeared since (another admin or the wizard); nothing was overwritten.</>}<br />
          The engine manages them from the next scan — refills and distribution requests appear automatically.
          {numeric.length > 0 && <><br />{numeric.length} numeric-size product{numeric.length === 1 ? "" : "s"} still need sizes decided in the Decision Queue.</>}
        </div>
        {!ok && <div style={{ color: RED, fontSize: 12, marginTop: 8 }}>{result.failed.join(" · ")} — safe to run again; already-written targets are untouched.</div>}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 13.5, color: GRAY }}>Loading live stock and targets…</div>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: GREEN }}>Nothing awaiting migration 🎉</div>
        <div style={{ color: GRAY, fontSize: 12.5, marginTop: 6 }}>
          Every circulating product is already under engine management. New supplier products go through the Decision Queue.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ ...GLASS, padding: "14px 16px", marginBottom: 12 }}>
        <div style={{ fontSize: 13.5, fontWeight: 800 }}>
          {migratable.length} existing product{migratable.length === 1 ? "" : "s"} ready to enter engine management
        </div>
        <div style={{ color: GRAY, fontSize: 12, marginTop: 6, lineHeight: 1.65 }}>
          These already circulate at {dests.map((l) => LOC_LABEL[l] || l).join(" / ")} but were never
          given targets — they are <b>not new products</b> and this is <b>not a decision</b>: your approved standard
          run ({Object.entries(run).map(([s, q]) => `${s}${q}`).join(" ")}, per-location config where set) is applied
          to each product's stocked sizes at all {dests.length} locations ({cellEstimate.toLocaleString()} target cells).
          From the next scan the engine creates the refill and distribution work — paced by the circuit breaker at{" "}
          {config?.maxIntentsPerRun ?? 200} requests per 15-minute scan — and the warehouse validates it; nothing
          moves without a human. <b>Expect busy warehouse queues while the backlog drains</b>; before
          tapping, set maxIntentsPerRun to the pace the warehouse can absorb per scan (e.g. 300 ≈ a 4-hour drain).
          {numeric.length > 0 && <> <span style={{ color: AMBER }}>{numeric.length} product{numeric.length === 1 ? "" : "s"} with numeric sizes</span> (no
          approved standard quantities) stay in the Decision Queue.</>}
        </div>
        {isAdmin ? (migratable.length > 0 && (
          <button onClick={apply} disabled={busy}
                  style={{ ...bGreen, width: "100%", marginTop: 12, padding: "13px", fontFamily: FONT, opacity: busy ? 0.6 : 1 }}>
            {busy
              ? `Introducing… ${progress ? `${progress.done}/${progress.total}` : ""}`
              : `Introduce ${migratable.length} products to the engine`}
          </button>
        )) : (
          <div style={{ color: GRAY, fontSize: 12, marginTop: 10 }}>Admin only — ask an admin to run the migration. 🔒</div>
        )}
      </div>

      {migratable.slice(0, 60).map((i) => (
        <ProductCard key={i.pid} photo={byId.get(i.pid)?.photoUrl} name={byId.get(i.pid)?.name || i.pid}
          badges={<Badge tone={BLUE_L}>AWAITING ENGINE</Badge>}
          sub={`${Object.entries(i.byLoc).filter(([, u]) => u > 0).map(([l, u]) => `${LOC_LABEL[l]} ${u}`).join(" · ")} — sizes ${i.standardSizes.join(", ")}`} />
      ))}
      {migratable.length > 60 && (
        <div style={{ color: GRAY, fontSize: 12, textAlign: "center", padding: 8 }}>…and {migratable.length - 60} more — all included in the one tap above.</div>
      )}
    </div>
  );
}
