// ─── MISSING SNEAKERS — network transfer workflow ─────────────────────────────
// The footwear sibling of NetworkTransfer.jsx, same idiom and same widgets:
//
//   photo · name · kind badge · units-at-Central badge
//   → per-size stepper chips (capped at Central's live stock)
//   → destination chips (Hub 1 / Hub 2)
//   → Transfer — immediate one-step applyMovement, straight from Health.
//
// Deliberately a SIBLING rather than a `variant` prop on NetworkTransfer. That
// component runs the live clothing workflow; threading a second product class
// through its solve/qualifying/standard-run logic would put the working queue at
// risk to save duplication that is mostly JSX. Detection lives in
// missingFootwear.js and is shared with the Health stat card, so the count and
// this list can never disagree — the one thing the clothing pair does get wrong.
//
// TWO KINDS, TWO ACTION SETS:
//   NEVER INTRODUCED — no cell at either hub. Transfer AND Solve.
//   SOLD OUT         — a hub cell exists but is empty. Transfer only where there
//                      is nothing absent left to seed; Solve is offered ONLY for
//                      the sizes genuinely missing a cell. Seeding is
//                      seed-if-absent, so a blanket Solve here would write
//                      nothing and still report success.
//
// Rows clear when real units arrive at a hub (the rule is unit-based), so
// Transfer retires a card and a pure Solve does not — which is why Solve's label
// says "start managing" rather than "solved".
import React, { useEffect, useMemo, useState } from "react";
import { ref, get, push, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { useStockCells } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, AMBER, BLUE_L, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, SizeFactChip, CHIP_GRID } from "./healthWidgets";
import { serverNowMs, serverNowIso } from "../../utils/serverTime";
import { computeMissingFootwear, footwearSolvePlan } from "./missingFootwearCore";
import { useRefillRequests } from "./useStock";

const HUBS = ["hub1", "hub2"];
// Solve raises work into the Source -> Hub 2 refill queue, which is hardcoded
// central -> hub2 (Hub2RefillQueue.jsx: SOURCE_LOC/DEST_LOC). There is no
// equivalent queue for hub1, so a hub1 request would be created and then be
// invisible with nowhere to work it. Solve therefore targets hub2 only; Move
// still transfers to either hub directly.
const SOLVE_HUB = "hub2";
const LOC_LABEL = { hub1: "Hub 1", hub2: "Hub 2", central: "Central" };
const KIND_LABEL = { never_introduced: "NEVER INTRODUCED", sold_out: "SOLD OUT AT HUB" };

const destChip = (on) => ({
  padding: "8px 13px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
  border: on ? "1px solid rgba(60,110,255,.55)" : "1px solid rgba(255,255,255,.1)",
  background: on ? "rgba(60,110,255,.15)" : "rgba(255,255,255,.03)",
  color: on ? BLUE_L : "rgba(255,255,255,.5)",
});

export default function MissingFootwear({ products = [] }) {
  const allStock = useStockCells();                 // live — a transfer retires its card
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canAct = ["store", "warehouse", "admin"].includes(actorRole);

  const [openPid, setOpenPid] = useState(null);
  const [dests, setDests] = useState({});
  const [edits, setEdits] = useState({});
  const [busyPid, setBusyPid] = useState(null);
  const [done, setDone] = useState({});
  const [solvePid, setSolvePid] = useState(null);
  const [solveBusy, setSolveBusy] = useState(null);
  const [solved, setSolved] = useState({});

  // The footwear standard, read ONCE. Absent until footwear targeting is
  // configured — Solve stays disabled until then rather than seeding cells the
  // engine would never refill.
  const [footwearRun, setFootwearRun] = useState(null);
  const allRequests = useRefillRequests();
  useEffect(() => {
    let alive = true;
    get(ref(database, "config/refillEngine/footwearRunByLocation"))
      .then((s) => { if (alive) setFootwearRun(s.val() || null); })
      .catch(() => { /* leave null — Solve disabled, Transfer unaffected */ });
    return () => { alive = false; };
  }, []);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const cards = useMemo(
    () => computeMissingFootwear({ allStock, products, hubs: HUBS }),
    [allStock, products],
  );

  const catalogSizes = (pid) => (byId.get(pid)?.sizes || []).map(String).filter((s) => s && s !== "_");

  const qtyOf = (card, s) => {
    const v = edits[`${card.pid}|${s.size}`];
    return Math.max(0, Math.min(v == null ? Math.min(2, s.avail) : v, s.avail));
  };

  const transfer = async (card) => {
    const dest = dests[card.pid] || HUBS[0];
    if (busyPid || !canAct || !dest) return;
    const lines = card.sizes.map((s) => ({ s, qty: qtyOf(card, s) })).filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusyPid(card.pid);
    const batch = `fw_${serverNowMs().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { s, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: card.pid, size: s.size, qty,
          from: "central", to: dest, actorRole,
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

  // Sizes already queued for this product at Hub 2 — the queue groups open
  // requests per product, so a duplicate would show one size twice on a card and
  // could be picked twice.
  const openSizesFor = (pid) => (allRequests || [])
    .filter((r) => r && r.status === "open" && r.requestingLocation === SOLVE_HUB && r.productId === pid)
    .map((r) => r.size);

  const planFor = (card) => footwearSolvePlan({
    catalogSizes: catalogSizes(card.pid),
    policy: footwearRun?.[SOLVE_HUB] || {},
    centralCells: allStock?.central?.[card.pid] || {},
    openSizes: openSizesFor(card.pid),
  });

  // SOLVE = raise the day's work, not a silent ledger move. One /refill_requests
  // row per size, in the shape the engine writes, so the lines land in the
  // existing Source -> Hub 2 queue and close through its normal fulfil path.
  // Stock does NOT move here — Central staff pick it size by size from that queue.
  const solve = async (card) => {
    const lines = planFor(card);
    if (solveBusy || !canAct || !lines.length) return;   // guarded by the disabled button
    setSolveBusy(card.pid);
    const now = serverNowIso();
    try {
      // Re-read live so a size queued by someone else between render and click is
      // not raised twice; the plan is recomputed against it rather than trusted.
      const liveOpen = Object.values((await get(ref(database, "refill_requests"))).val() || {})
        .filter((r) => r && r.status === "open" && r.requestingLocation === SOLVE_HUB && r.productId === card.pid)
        .map((r) => r.size);
      const fresh = footwearSolvePlan({
        catalogSizes: catalogSizes(card.pid),
        policy: footwearRun?.[SOLVE_HUB] || {},
        centralCells: allStock?.central?.[card.pid] || {},
        openSizes: liveOpen,
      });
      if (!fresh.length) {
        setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: "Already queued at Hub 2 — nothing new to raise." } }));
      } else {
        // ONE atomic multi-path write: a partial failure would leave some sizes
        // queued and no way to tell which, so all lines land together or none do.
        const updates = {};
        for (const l of fresh) {
          const id = push(ref(database, "refill_requests")).key;
          updates[`refill_requests/${id}`] = {
            productId: card.pid,
            size: l.size,
            qty: l.qty,
            requestingLocation: SOLVE_HUB,
            status: "open",
            createdAt: now,
            createdFrom: { manual: true, source: "central", via: "missing_sneakers" },
          };
        }
        await update(ref(database), updates);
        const short = fresh.filter((l) => l.qty < l.want);
        setSolved((d) => ({
          ...d,
          [card.pid]: {
            ok: true,
            msg: `Raised ${fresh.length} size${fresh.length === 1 ? "" : "s"} (${fresh.map((l) => `${l.size}\u00d7${l.qty}`).join(" · ")}) into Hub 2's refill list`
              + (short.length ? ` — ${short.map((l) => `${l.size} short (${l.avail} at Central, wanted ${l.want})`).join(", ")}` : "")
              + ". Central picks it as part of today's work.",
          },
        }));
      }
    } catch (e) {
      setSolved((d) => ({ ...d, [card.pid]: { ok: false, msg: `Couldn't raise the request — nothing changed, retry. (${e?.message || "error"})` } }));
    }
    setSolveBusy(null);
  };

  if (!cards.length) {
    return <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>No stranded sneakers — everything at Central is also held by a hub.</div>;
  }

  return (
    <>
      {!canAct && <div style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>You need a stock role to transfer — viewing only.</div>}
      {cards.map((card) => {
        const open = openPid === card.pid;
        const result = done[card.pid];
        const dest = dests[card.pid] || HUBS[0];
        const total = card.sizes.reduce((t, s) => t + qtyOf(card, s), 0);
        const sOpen = solvePid === card.pid;
        const sResult = solved[card.pid];
        const solveLines = planFor(card);
        const solvable = solveLines.length > 0;
        const solveTitle = !footwearRun
          ? "Footwear targeting isn't configured yet — use Move instead"
          : !solvable ? "Nothing to raise — every size is either already queued at Hub 2 or out of stock at Central" : undefined;
        return (
          <ProductCard key={card.pid}
            photo={card.photo} name={card.name}
            badges={<>
              <Badge tone={card.kind === "never_introduced" ? AMBER : BLUE_L}>{KIND_LABEL[card.kind]}</Badge>
              <Badge tone={BLUE_L}>{card.centralUnits} units at Central</Badge>
              {card.duplicateOf && <Badge tone={AMBER}>SAME NAME ELSEWHERE</Badge>}
            </>}
            sub={[
              // Carriage and stock are different statements, so say the true one.
              // A shoe carried at BOTH hubs but empty has missingFrom === [], and
              // the old `|| "both hubs"` fallback then contradicted its own SOLD
              // OUT badge. (CodeRabbit #290.)
              card.missingFrom.length
                ? `Not carried at ${card.missingFrom.map((h) => LOC_LABEL[h]).join(" + ")}`
                : "Carried at both hubs, but both are empty",
              card.duplicateOf ? "Another record shares this name — confirm it is a different shoe before transferring." : null,
            ].filter(Boolean).join(" · ")}
            right={
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { setSolvePid(sOpen ? null : card.pid); setOpenPid(null); setSolved((d) => { const n = { ...d }; delete n[card.pid]; return n; }); }}
                        disabled={!canAct || !solvable} title={solveTitle}
                        style={{ background: sOpen ? "rgba(74,222,128,.15)" : "rgba(74,222,128,.1)", border: "1px solid rgba(74,222,128,.4)", color: GREEN, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: (canAct && solvable) ? "pointer" : "default", opacity: (canAct && solvable) ? 1 : 0.4, fontFamily: FONT }}>
                  {sOpen ? "Close" : "Solve"}
                </button>
                <button onClick={() => { setOpenPid(open ? null : card.pid); setSolvePid(null); }}
                        disabled={!canAct}
                        style={{ background: "rgba(60,110,255,.1)", border: "1px solid rgba(60,110,255,.35)", color: BLUE_L, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: canAct ? "pointer" : "default", opacity: canAct ? 1 : 0.4, fontFamily: FONT }}>
                  {open ? "Close" : "Move"}
                </button>
              </div>
            }>
            {result && (
              <div style={{ fontSize: 12, color: result.failed.length ? AMBER : GREEN, marginTop: 6 }}>
                Moved {result.moved} to {LOC_LABEL[result.dest]}{result.failed.length ? ` — failed: ${result.failed.join(", ")}` : ""}
              </div>
            )}
            {sResult && <div style={{ fontSize: 12, color: sResult.ok ? GREEN : AMBER, marginTop: 6 }}>{sResult.msg}</div>}

            {sOpen && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: GRAY, marginBottom: 8 }}>
                  Raises this into <b style={{ color: "#fff" }}>Source → Hub 2 refill list</b> as today's work.
                  Central picks it size by size; stock does not move yet.
                </div>
                {solveLines.length ? (
                  <>
                    <div style={CHIP_GRID}>
                      {solveLines.map((l) => (
                        <SizeFactChip key={l.size} size={l.size}
                          value={l.qty < l.want ? `${l.qty} of ${l.want} · only ${l.avail} at Central` : `${l.qty}`}
                          tone={l.qty < l.want ? AMBER : GREEN} />
                      ))}
                    </div>
                    <div style={{ fontSize: 12, color: GRAY, margin: "8px 0" }}>
                      {solveLines.reduce((t, l) => t + l.qty, 0)} pieces across {solveLines.length} size{solveLines.length === 1 ? "" : "s"}
                      {solveLines.some((l) => l.qty < l.want) ? " — short sizes are capped by Central stock, not policy." : "."}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: GRAY, marginBottom: 8 }}>
                    Nothing to raise — every size is already queued at Hub 2 or Central has none.
                  </div>
                )}
                <button onClick={() => solve(card)} disabled={!!solveBusy || !solveLines.length}
                        style={{ background: "rgba(74,222,128,.14)", border: "1px solid rgba(74,222,128,.45)", color: GREEN, borderRadius: 10, padding: "9px 14px", fontWeight: 800, fontSize: 12.5, cursor: solveLines.length ? "pointer" : "default", opacity: solveLines.length ? 1 : 0.4, fontFamily: FONT }}>
                  {solveBusy === card.pid ? "Raising…" : "Confirm"}
                </button>
              </div>
            )}

            {open && (
              <div style={{ marginTop: 10 }}>
                <div style={CHIP_GRID}>
                  {card.sizes.map((s) => (
                    <SizeStepperChip key={s.sizeKey} size={s.size} qty={qtyOf(card, s)} max={s.avail}
                      hint={`${s.avail} at Central`}
                      onChange={(v) => setEdits((e) => ({ ...e, [`${card.pid}|${s.size}`]: v }))} />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 8px" }}>
                  {HUBS.map((h) => (
                    <button key={h} onClick={() => setDests((d) => ({ ...d, [card.pid]: h }))} style={destChip(dest === h)}>
                      {LOC_LABEL[h]}
                    </button>
                  ))}
                </div>
                <button onClick={() => transfer(card)} disabled={!!busyPid || total === 0}
                        style={{ background: "rgba(60,110,255,.15)", border: "1px solid rgba(60,110,255,.5)", color: BLUE_L, borderRadius: 10, padding: "9px 14px", fontWeight: 800, fontSize: 12.5, cursor: total ? "pointer" : "default", opacity: total ? 1 : 0.4, fontFamily: FONT }}>
                  {busyPid === card.pid ? "Moving…" : `Transfer ${total} to ${LOC_LABEL[dest]}`}
                </button>
              </div>
            )}
          </ProductCard>
        );
      })}
    </>
  );
}
