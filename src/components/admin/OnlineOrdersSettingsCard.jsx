// ─── SETTINGS → ONLINE ORDERS (super admin) ──────────────────────────────────
// Contract: docs/ONLINE-ORDERS.md. Three things, nothing else:
//
//   1. THE SWITCH — /config/onlineOrders/enabled. Absent = off. While off,
//      orders still poll in and reserve stock (the poller does that from day
//      one); what the switch turns on is what STAFF see: hub picks in the
//      Warehouse queue, online entries in the shops' display-check feed, the
//      POS walk-in guard. Written as { enabled, updatedAt, updatedBy }, the
//      same shape as /config/transit's switch.
//   2. THE ORDER CODE — read-only: every order's ref is a three-letter code
//      (KQZ, no I or O), minted by the Mac mini when the order is pulled in.
//   3. NEEDS ATTENTION — every order with attentionOpen true, from ONE indexed
//      query (orderByChild("attentionOpen").equalTo(true); NEEDS ".indexOn":
//      ["attentionOpen"] on /online_orders). Normally empty, so it is
//      subscribed. Resolve writes the one update attention.js builds.
//
// GATE 3 of 3: the tile and the #admin/online-orders route are the others; the
// RTDB rules on /config/onlineOrders and /online_orders are what refuse.

import { useEffect, useState } from "react";
import { ref, onValue, update, query, orderByChild, equalTo } from "firebase/database";
import { database } from "../../firebase";
import { ADMIN_EMAIL } from "../PermissionsContext";
import { serverNowMs } from "../../utils/serverTime";
import { ONLINE_ORDERS_PATH, ONLINE_ORDERS_CONFIG_PATH } from "../../utils/onlineOrders";
import { attentionRows, resolveAttentionUpdates, resolveLabel, OPEN_STATUSES, openOrderRows, rungByHandUpdates } from "../onlineOrders/attention";

const page = { minHeight: "100vh", background: "#000", color: "#f2f2f7", padding: 16, maxWidth: 760, margin: "0 auto", fontFamily: "-apple-system, system-ui, sans-serif", boxSizing: "border-box" };
const box = { border: "1px solid #2c2c2e", borderRadius: 10, padding: 14, background: "#1c1c1e", marginTop: 16 };
const label = { fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 };
const btn = { background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" };
const row = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "12px 0", borderTop: "1px solid #2c2c2e" };

const KIND_WORDS = {
  unresolved: "Not in the Shopify sync",
  no_stock: "No stock anywhere",
  not_found: "Not found on the floor",
  walkin_override: "Sold to a walk-in",
  cancelled_after_pack: "Cancelled after packing",
  fulfil_failed: "Packed, Shopify not updated",
  courier_failed: "Packed, courier not booked",
};

// The switch's one write, the /config/transit shape.
export function switchUpdate(enabled, uid, nowMs) {
  return { [ONLINE_ORDERS_CONFIG_PATH]: { enabled: enabled === true, updatedAt: nowMs, updatedBy: uid || null } };
}

const defaultWrite = (updates) => update(ref(database), updates);

// "21 Oct 14:05", SA time — the device clock never enters.
function saWhen(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" });
}

export default function OnlineOrdersSettingsCard({ authUser, onExit, write = defaultWrite, now = serverNowMs }) {
  const isOwner = !!authUser && authUser.email === ADMIN_EMAIL;
  const [cfg, setCfg] = useState({ settled: false, enabled: false, error: false });
  const [att, setAtt] = useState({ settled: false, rows: [], error: false });
  const [open, setOpen] = useState({});
  const [releasing, setReleasing] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!isOwner) return undefined;
    return onValue(ref(database, `${ONLINE_ORDERS_CONFIG_PATH}/enabled`),
      (s) => setCfg({ settled: true, enabled: s.val() === true, error: false }),
      () => setCfg({ settled: true, enabled: false, error: true }));
  }, [isOwner]);
  useEffect(() => {
    if (!isOwner) return undefined;
    const q = query(ref(database, ONLINE_ORDERS_PATH), orderByChild("attentionOpen"), equalTo(true));
    return onValue(q,
      (s) => setAtt({ settled: true, rows: attentionRows(s.val()), error: false }),
      () => setAtt({ settled: true, rows: [], error: true }));
  }, [isOwner]);

  // Every open order — one indexed query per open status.
  useEffect(() => {
    if (!isOwner) return undefined;
    const offs = OPEN_STATUSES.map((st) => onValue(
      query(ref(database, ONLINE_ORDERS_PATH), orderByChild("status"), equalTo(st)),
      (s) => setOpen((prev) => ({ ...prev, [st]: s.val() })),
      () => setOpen((prev) => ({ ...prev, [st]: null })),
    ));
    return () => offs.forEach((off) => off());
  }, [isOwner]);

  if (!isOwner) {
    return (
      <div style={page}>
        <p>This screen is for Junid only.</p>
        <button type="button" style={btn} onClick={onExit}>Back</button>
      </div>
    );
  }

  const flip = async () => {
    setBusy("switch"); setMsg(null);
    const to = !cfg.enabled;
    try {
      await write(switchUpdate(to, authUser.uid, now()));
      setMsg({ text: to ? "Online orders ON — hubs and shops now see website picks." : "Online orders OFF — orders still come in and hold stock; staff see nothing." });
    } catch (e) {
      setMsg({ bad: true, text: `Not saved: ${String(e?.message || e)}` });
    }
    setConfirming(false); setBusy(null);
  };

  const resolve = async (r) => {
    const updates = resolveAttentionUpdates(r.orderId, r.order);
    if (!updates) { setMsg({ bad: true, text: `${r.ref}: "${r.kind}" has no resolve here.` }); return; }
    setBusy(r.orderId); setMsg(null);
    try { await write(updates); setMsg({ text: `${r.ref} resolved.` }); }
    catch (e) { setMsg({ bad: true, text: `${r.ref} not saved: ${String(e?.message || e)}` }); }
    setBusy(null);
  };

  const release = async (r) => {
    const updates = rungByHandUpdates(r.orderId, { by: authUser.uid, at: now() });
    if (!updates) return;
    setBusy(r.orderId); setMsg(null);
    try { await write(updates); setMsg({ text: `${r.ref} released — the Mac mini closes its picks and holds on its next run.` }); }
    catch (e) { setMsg({ bad: true, text: `${r.ref} not saved: ${String(e?.message || e)}` }); }
    setReleasing(null); setBusy(null);
  };
  const openRows = openOrderRows(open);

  return (
    <div style={page}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Online orders</h2>
        <button type="button" style={btn} onClick={onExit}>Done</button>
      </div>
      {msg && <p role="status" style={{ color: msg.bad ? "#ff6961" : "#30d158" }}>{msg.text}</p>}

      <div style={box}>
        <div style={label}>Staff feeds</div>
        <div style={{ ...row, borderTop: "none", alignItems: "center" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{!cfg.settled ? "Reading…" : cfg.enabled ? "On" : "Off"}</div>
            <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 4 }}>
              Hub picks, shop floor entries and the walk-in guard. Website orders come in and hold stock either way.
            </div>
            {cfg.error && <div style={{ fontSize: 13, color: "#ff6961", marginTop: 4 }}>The switch could not be read — the rule for /config/onlineOrders may be missing.</div>}
          </div>
          {!confirming ? (
            <button type="button" aria-label="Toggle online orders" disabled={!cfg.settled || busy === "switch"}
              onClick={() => setConfirming(true)}
              style={{ width: 52, height: 30, borderRadius: 999, border: "none", cursor: "pointer", flexShrink: 0, position: "relative",
                       background: cfg.enabled ? "#30d158" : "rgba(255,255,255,.18)", opacity: !cfg.settled ? 0.5 : 1 }}>
              <span style={{ position: "absolute", top: 4, left: cfg.enabled ? 26 : 4, width: 22, height: 22, borderRadius: "50%", background: "#fff" }} />
            </button>
          ) : (
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button type="button" style={{ ...btn, background: cfg.enabled ? "#3a1212" : "#123a1e", color: cfg.enabled ? "#ff6961" : "#30d158" }}
                disabled={busy === "switch"} onClick={flip}>{cfg.enabled ? "Turn off" : "Turn on"}</button>
              <button type="button" style={btn} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      <div style={box}>
        <div style={label}>Order code</div>
        <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 18, marginTop: 8 }}>KQZ</div>
        <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 4 }}>Three letters (never I or O), unique for 180 days. The Shopify number stays on the order.</div>
      </div>

      <div style={box}>
        <div style={label}>Needs attention{att.settled && !att.error ? ` (${att.rows.length})` : ""}</div>
        {!att.settled && <p style={{ color: "#8e8e93" }}>Reading…</p>}
        {att.error && <p style={{ color: "#ff6961" }}>The list could not be read — the rule (and ".indexOn": ["attentionOpen"]) for /online_orders may be missing.</p>}
        {att.settled && !att.error && att.rows.length === 0 && <p style={{ color: "#8e8e93" }}>Nothing needs you.</p>}
        {att.rows.map((r) => {
          const act = resolveLabel(r.kind);
          return (
            <div key={r.orderId} style={row}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{r.ref} <span style={{ fontWeight: 400, color: "#8e8e93" }}>· {r.customer}</span></div>
                <div style={{ fontSize: 13, color: "#ff9f0a", marginTop: 3 }}>{KIND_WORDS[r.kind] || r.kind}</div>
                {r.reason && <div style={{ fontSize: 13, marginTop: 3, wordBreak: "break-word" }}>{r.reason}</div>}
                {r.at && <div style={{ fontSize: 12, color: "#8e8e93", marginTop: 3 }}>{saWhen(r.at)}</div>}
              </div>
              {act && (
                <button type="button" style={{ ...btn, flexShrink: 0 }} disabled={busy === r.orderId} onClick={() => resolve(r)}>
                  {busy === r.orderId ? "Saving…" : act}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div style={box}>
        <div style={label}>Open orders ({openRows.length})</div>
        <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 4 }}>
          An order already rung at a till by hand must not be packed as well. Release it here and its picks and holds go.
        </div>
        {openRows.map((r) => (
          <div key={r.orderId} style={row}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{r.ref} <span style={{ fontWeight: 400, color: "#8e8e93" }}>· {r.customer} · {r.lines} line{r.lines === 1 ? "" : "s"}</span></div>
              <div style={{ fontSize: 12, color: "#8e8e93", marginTop: 3 }}>{r.status}{r.createdAt ? ` · ${saWhen(r.createdAt)}` : ""}</div>
            </div>
            {releasing !== r.orderId ? (
              <button type="button" style={{ ...btn, flexShrink: 0 }} disabled={busy === r.orderId} onClick={() => setReleasing(r.orderId)}>Rung by hand at a till</button>
            ) : (
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button type="button" style={{ ...btn, background: "#3a1212", color: "#ff6961" }} disabled={busy === r.orderId} onClick={() => release(r)}>{busy === r.orderId ? "Saving…" : "Release it"}</button>
                <button type="button" style={btn} onClick={() => setReleasing(null)}>Cancel</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
