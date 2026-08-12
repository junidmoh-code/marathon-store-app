// ─── STOCK HOLD — THE RELEASE SCREEN ─────────────────────────────────────────
// (Owner spec 2026-08-12, count-integrity commit 5.) Lists PENDING SHIPMENTS,
// not products — at most two in normal running. Each row is one physical box:
// "14:00 shipment · 8 Aug · 23 lines · 41 units · Hub 2", one primary action.
// The owner can release WITHOUT ever opening the line list; expanding is only
// for marking a line NOT arrived, which carries it to the next shipment.
//
// Releasing writes one idempotent applyMovement per line (rel_{lineId}) plus
// one atomic bookkeeping update — a double tap credits nothing extra, a crash
// mid-way leaves released lines archived and the rest still held, and any
// already-counted cell the release changes is stamped stale so it resurfaces
// on the count card (the shelve-then-count race, commit 6).
//
// Owner-only surface (plus named delegates). Also carries the two owner
// controls: the KILL SWITCH (/settings/stockHold/config/enabled) and the
// delegate list — both config, no deploy.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ref, child, get } from "firebase/database";
import { database } from "../../firebase";
import { FONT, BG, CARD, BORDER, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGray, bGhost, tabOn, tabOff } from "./ui";
import { Toast } from "./widgets";
import { SizeTag } from "../SizeTag.jsx";
import { canReleaseStockHold, isStockHoldSuperAdmin } from "../../config/stockHold";
import { loadHoldConfig, loadHeld, releaseShipment, markLineNotArrived, setHoldEnabled, setHoldDelegate } from "./stockHoldStore";
import { groupShipments, shipmentTitle, nextShipmentAfter, oldestPendingMs } from "./stockHoldCore";
import { parseReleaseTimes } from "./releaseWindows";
import { serverNowMs } from "../../utils/serverTime";
import { formatDuration } from "../../utils/duration";

const HUB_LABELS = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3" };
const hubLabelOf = (d) => HUB_LABELS[d] || d;
const one = async (path) => (await get(child(ref(database), path))).val();

export default function StockHoldRelease({ viewer, actorRole, onExit }) {
  const [config, setConfig] = useState(null);
  const [held, setHeld] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState("");              // expanded shipment key
  const [notArrived, setNotArrived] = useState({});  // shipmentKey → Set(lineId)
  const [busyKey, setBusyKey] = useState("");        // shipment being released
  const [result, setResult] = useState(null);        // last release summary
  const [toast, setToast] = useState(null);
  const flash = (kind, text, ms = 5000) => { setToast({ kind, text }); setTimeout(() => setToast(null), ms); };

  const reload = useCallback(async () => {
    setLoading(true); setLoadError("");
    try {
      const [cfg, lines] = await Promise.all([loadHoldConfig(), loadHeld()]);
      setConfig(cfg);
      setHeld(lines);
    } catch (err) {
      setLoadError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const now = serverNowMs();
  const shipments = useMemo(() => groupShipments(held || {}, now), [held, now]);
  const oldestMs = oldestPendingMs(shipments, now);
  const allowed = canReleaseStockHold(viewer, config);
  const isOwner = isStockHoldSuperAdmin(viewer);

  // Release windows for the not-arrived carry target (same config the fulfil
  // side stamps shipments from).
  const [windows, setWindows] = useState(() => parseReleaseTimes(undefined));
  useEffect(() => {
    one("config/refillEngine/releaseWindows")
      .then((raw) => setWindows(parseReleaseTimes(raw)))
      .catch(() => { /* defaults already in place */ });
  }, []);

  const toggleNotArrived = (shipKey, lineId) => {
    setNotArrived((m) => {
      const cur = new Set(m[shipKey] || []);
      if (cur.has(lineId)) cur.delete(lineId); else cur.add(lineId);
      return { ...m, [shipKey]: cur };
    });
  };

  const doRelease = async (ship) => {
    if (busyKey) return;                         // double-tap guard #1 (the movement ids are #2)
    setBusyKey(ship.key);
    setResult(null);
    try {
      const skip = notArrived[ship.key] || new Set();
      // Carry the not-arrived lines FIRST: they leave this shipment for the
      // next window before the rest releases, so a crash between the two
      // steps can never release a line the owner just said was missing.
      const carryTo = nextShipmentAfter(ship, serverNowMs(), windows);
      let carried = 0;
      for (const lineId of skip) {
        const res = await markLineNotArrived({ dest: ship.dest, lineId, toShipment: carryTo });
        if (res.ok) carried++;
        else flash("err", `Could not carry a line forward (${res.message || "write failed"}) — it stays in this shipment, unreleased.`, 8000);
      }
      const out = await releaseShipment({ dest: ship.dest, shipment: ship, skipLineIds: skip, actorRole: actorRole || "admin" });
      setResult({ ship, ...out, carried, carryTo });
      setNotArrived((m) => ({ ...m, [ship.key]: new Set() }));
      await reload();
      if (out.failures.length === 0) {
        flash("ok", `${out.releasedUnits} unit${out.releasedUnits === 1 ? "" : "s"} landed at ${hubLabelOf(ship.dest)}${carried ? ` · ${carried} line${carried === 1 ? "" : "s"} carried to the next shipment` : ""}${out.staledCells ? ` · ${out.staledCells} counted cell${out.staledCells === 1 ? "" : "s"} flagged for re-count` : ""}.`, 7000);
      } else {
        flash("err", `${out.released} line${out.released === 1 ? "" : "s"} released; ${out.failures.length} failed and stay held — see the list below.`, 9000);
      }
    } finally {
      setBusyKey("");
    }
  };

  // ── Owner controls: the kill switch + delegates ────────────────────────────
  const [users, setUsers] = useState(null);
  const [busyCfg, setBusyCfg] = useState(false);
  useEffect(() => {
    if (!isOwner) return;
    one("users").then((u) => setUsers(u || {})).catch(() => setUsers({}));
  }, [isOwner]);

  const flipEnabled = async () => {
    setBusyCfg(true);
    const next = !(config?.enabled === true);
    const res = await setHoldEnabled(next);
    if (res.ok) { setConfig((c) => ({ ...(c || {}), enabled: next })); flash("ok", next ? "Holding ON — fulfils now wait for your release." : "Holding OFF — fulfils credit hubs instantly again."); }
    else flash("err", res.message || "Could not update the switch.");
    setBusyCfg(false);
  };
  const flipDelegate = async (uid, username, on) => {
    setBusyCfg(true);
    const res = await setHoldDelegate(uid, on ? (username || true) : null);
    if (res.ok) setConfig((c) => ({ ...(c || {}), delegates: { ...(c?.delegates || {}), [uid]: on ? (username || true) : undefined } }));
    else flash("err", res.message || "Could not update delegates.");
    setBusyCfg(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT, color: "#fff", padding: "14px 12px 60px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, paddingTop: 36 }}>
          <button onClick={onExit} style={{ ...bGray, padding: "8px 13px" }}>← Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15.5, fontWeight: 800 }}>Shipment Release</div>
            <div style={{ fontSize: 11, color: GRAY }}>The box arrived → one tap lands its stock at the hub</div>
          </div>
          <button onClick={reload} style={{ ...bGhost, padding: "8px 12px", fontSize: 12 }}>↻</button>
        </div>

        {loading && <div style={{ color: GRAY, fontSize: 13 }}>Loading…</div>}
        {loadError && <div style={{ color: RED, fontSize: 13 }}>Could not load: {loadError}</div>}

        {!loading && !allowed && (
          <div style={{ background: CARD, border: BORDER, borderRadius: 14, padding: 16, fontSize: 13.5, color: AMBER, lineHeight: 1.6 }}>
            Releasing shipments is the owner's action (or a named delegate's). This account is neither.
          </div>
        )}

        {!loading && allowed && (
          <>
            {/* THE AGE, LOUDLY. A pending shipment past its window means hub
                cells understate right now. */}
            {oldestMs > 0 && (
              <div style={{ background: oldestMs > 24 * 3600e3 ? "rgba(248,113,113,.1)" : "rgba(251,191,36,.08)",
                            border: `1px solid ${oldestMs > 24 * 3600e3 ? "rgba(248,113,113,.5)" : "rgba(251,191,36,.35)"}`,
                            borderRadius: 12, padding: "10px 13px", marginBottom: 12,
                            fontSize: 12.5, color: oldestMs > 24 * 3600e3 ? "#FFC9C9" : "#FDE9B0", lineHeight: 1.55 }}>
                The oldest pending shipment is <strong>{formatDuration(oldestMs)}</strong> past its window.
                While it waits, its hub's cells understate and sales there can run the books negative.
                If you are away, name a delegate below.
              </div>
            )}

            {shipments.length === 0 && (
              <div style={{ background: CARD, border: BORDER, borderRadius: 14, padding: 22, textAlign: "center", color: GRAY, fontSize: 13.5 }}>
                Nothing pending. Fulfilled boxes appear here grouped by their release window
                {config?.enabled !== true && <div style={{ color: AMBER, marginTop: 8, fontSize: 12 }}>Holding is OFF — fulfils are crediting hubs instantly.</div>}
              </div>
            )}

            {shipments.map((ship) => {
              const skip = notArrived[ship.key] || new Set();
              const isOpen = open === ship.key;
              const releasable = ship.lines.length - skip.size;
              return (
                <div key={ship.key} style={{ background: CARD, border: ship.overdueMs > 0 ? "1px solid rgba(251,191,36,.45)" : BORDER, borderRadius: 14, padding: 14, marginBottom: 12 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 3 }}>{shipmentTitle(ship, hubLabelOf)}</div>
                  <div style={{ fontSize: 11.5, color: ship.overdueMs > 0 ? AMBER : GRAY, marginBottom: 11 }}>
                    {ship.overdueMs > 0 ? `window passed ${formatDuration(ship.overdueMs)} ago` : "window not reached yet — release when the box is open"}
                    {ship.lines.some((l) => l.carriedFrom) && " · includes lines carried from an earlier shipment"}
                  </div>

                  {/* ONE action. Releasing never requires opening the list. */}
                  <button disabled={!!busyKey || releasable === 0} onClick={() => doRelease(ship)}
                    style={{ ...bGreen, width: "100%", minHeight: 54, borderRadius: 12, fontSize: 15.5, fontWeight: 800,
                             opacity: busyKey === ship.key ? 0.6 : releasable === 0 ? 0.4 : 1 }}>
                    {busyKey === ship.key ? "Releasing…" : `📦 Box arrived — release${skip.size ? ` ${releasable} of ${ship.lines.length} lines` : ""}`}
                  </button>

                  <button onClick={() => setOpen(isOpen ? "" : ship.key)}
                    style={{ ...bGhost, width: "100%", marginTop: 8, minHeight: 38, fontSize: 12, borderRadius: 10 }}>
                    {isOpen ? "Hide the lines" : `Check the lines (only if something is missing) ↓`}
                  </button>

                  {isOpen && (
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                      <div style={{ fontSize: 10.5, color: GRAY, lineHeight: 1.5 }}>
                        Tap “Not arrived” on anything missing from the box — it stays held and joins the next shipment.
                      </div>
                      {ship.lines.map((l) => {
                        const skipped = skip.has(l.lineId);
                        return (
                          <div key={l.lineId} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 9px",
                                                       borderRadius: 10, background: skipped ? "rgba(251,191,36,.08)" : "rgba(255,255,255,.025)",
                                                       border: skipped ? "1px solid rgba(251,191,36,.35)" : "1px solid transparent" }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.productName || l.productId}</div>
                              <div style={{ fontSize: 10.5, color: GRAY }}>
                                Size <SizeTag size={l.size} /> · {l.qty} unit{l.qty === 1 ? "" : "s"}
                                {l.uncounted && " · sent uncounted"}
                                {l.carriedFrom && <span style={{ color: AMBER }}> · missed the {String(l.carriedFrom).slice(11, 13)}:{String(l.carriedFrom).slice(13)} box on {String(l.carriedFrom).slice(0, 10)}</span>}
                              </div>
                            </div>
                            <button disabled={!!busyKey} onClick={() => toggleNotArrived(ship.key, l.lineId)}
                              style={{ ...(skipped ? tabOn : tabOff), fontSize: 11, padding: "6px 10px", borderRadius: 9, flexShrink: 0 }}>
                              {skipped ? "↩ It IS here" : "Not arrived"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {result && result.failures.length > 0 && (
              <div style={{ background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.4)", borderRadius: 12, padding: "11px 13px", marginBottom: 12, fontSize: 12, color: "#FFC9C9", lineHeight: 1.6 }}>
                <strong>{result.failures.length} line{result.failures.length === 1 ? "" : "s"} did not release and stay held:</strong>
                {result.failures.map((f) => (
                  <div key={f.lineId}>· {f.productName || f.lineId} — {f.reason}</div>
                ))}
                Release the shipment again to retry — nothing double-credits.
              </div>
            )}

            {/* ── Owner controls ──────────────────────────────────────────── */}
            {isOwner && (
              <div style={{ background: CARD, border: BORDER, borderRadius: 14, padding: 14, marginTop: 18 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 9, color: BLUE_L }}>Owner controls</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5 }}>
                    Holding is <strong style={{ color: config?.enabled === true ? GREEN : AMBER }}>{config?.enabled === true ? "ON" : "OFF"}</strong>
                    <div style={{ fontSize: 10.5, color: GRAY }}>
                      OFF = today's instant credit (the kill switch — key: settings/stockHold/config/enabled)
                    </div>
                  </div>
                  <button disabled={busyCfg} onClick={flipEnabled} style={{ ...bGray, padding: "8px 14px", fontSize: 12 }}>
                    Turn {config?.enabled === true ? "OFF" : "ON"}
                  </button>
                </div>
                <div style={{ borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 10, marginTop: 8 }}>
                  <div style={{ fontSize: 11.5, color: GRAY, marginBottom: 7, lineHeight: 1.5 }}>
                    Delegates may release shipments while you travel (they see this card too):
                  </div>
                  {users == null && <div style={{ fontSize: 11.5, color: GRAY }}>Loading accounts…</div>}
                  {users && Object.keys(users).length === 0 && <div style={{ fontSize: 11.5, color: AMBER }}>Could not read the accounts list.</div>}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {Object.entries(users || {}).map(([uid, u]) => {
                      const on = !!(config?.delegates && config.delegates[uid]);
                      const name = u?.username || uid.slice(0, 6);
                      return (
                        <button key={uid} disabled={busyCfg} onClick={() => flipDelegate(uid, name, !on)}
                          style={{ ...(on ? tabOn : tabOff), fontSize: 11.5, padding: "6px 11px", borderRadius: 9 }}>
                          {on ? "✓ " : ""}{name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <Toast msg={toast} />
    </div>
  );
}
