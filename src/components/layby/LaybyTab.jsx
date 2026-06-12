// ─── LAYBY TAB (warehouse hub view) ──────────────────────────────────────────
// The warehouse half of the layby system, scoped to the hub the operator picked.
// A layby's identity everywhere here is its INVOICE NUMBER (invoiceNo); the
// stable laybyId is used only for matching/writes. Three sub-queues:
//   • Pull Requests — incoming /laybyPulls from the POS. Invoice number is shown
//     HUGE (that's how the parcel is found on the shelf). Customer-centric, not
//     product/size-centric. Actions: "Sent" → fulfil; "Reject" (reason required)
//     for expired laybys, flowing the reason back to the POS.
//   • Receiving — parcels still inTransitToStorage. "Scan layby" opens the camera
//     QR scanner (payload {v:1, laybyId, invoiceNo}); manual invoice entry is the
//     fallback. Either flips the parcel to storedAtHub (receivedAt/receivedBy).
//   • Exceptions — parcels inTransitToStorage past their scan deadline, i.e.
//     potentially missing. Surfaced loudly (also via the banner) so they get
//     found the same day.
//
// All data is read defensively (POS owns the writers; rules pending) — empty
// lists are the normal pre-integration state, not an error.

import { useMemo, useState } from "react";
import QrScanner from "./QrScanner";
import { receiveLayby, markPullSent, rejectPull } from "./useLayby";
import { labelFor } from "../stock/locations";
import {
  LAYBY_STATUS, PULL_STATUS, DEFAULT_STORAGE_HUB,
  formatLaybyMoney, isLaybyException, isPullExpired, ageLabel, parseLaybyScan, normalizeInvoiceNo,
} from "./contract";

// Palette — mirrors the warehouse view constants in App.jsx.
const CARD   = "rgba(4,5,10,1)";
const BLUE   = "#4A7FFF";
const RED    = "#FF6B6B";
const GREEN  = "#4ACA7A";
const MUTED  = "rgba(255,255,255,.4)";

const hubOf = (x) => x?.storageHub || DEFAULT_STORAGE_HUB;
const invOf = (x) => x?.invoiceNo || "—";

// ── Exceptions banner — rendered by WarehouseView above the tabs on every tab ──
export function LaybyExceptionsBanner({ laybys, selectedHub, nowMs, onOpen }) {
  const exceptions = useMemo(
    () => (laybys || []).filter(l => hubOf(l) === selectedHub && isLaybyException(l, nowMs)),
    [laybys, selectedHub, nowMs]
  );
  if (exceptions.length === 0) return null;
  return (
    <div onClick={onOpen}
         style={{ margin:"0 13px 12px", background:"rgba(150,20,20,.16)", border:"1px solid rgba(220,60,60,.5)", borderRadius:12, padding:"11px 13px", display:"flex", alignItems:"center", gap:11, cursor:"pointer" }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={RED} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontWeight:800, fontSize:13.5, color:"#FF9B9B" }}>
          {exceptions.length} layby parcel{exceptions.length > 1 ? "s" : ""} missing in transit
        </div>
        <div style={{ fontSize:11.5, color:"rgba(255,255,255,.55)", marginTop:1 }}>
          Never scanned in past the deadline — find {exceptions.length > 1 ? "them" : "it"} today. Tap to review.
        </div>
      </div>
      <div style={{ fontSize:12, color:"#FF9B9B", fontWeight:700 }}>Review →</div>
    </div>
  );
}

// ── Sub-pill nav ───────────────────────────────────────────────────────────────
function SubPill({ active, label, count, danger, onClick }) {
  return (
    <div onClick={onClick}
         style={{ padding:"6px 14px", borderRadius:20, fontSize:12, fontWeight:600, whiteSpace:"nowrap", cursor:"pointer", display:"flex", alignItems:"center", gap:6,
                  background: active ? "rgba(60,110,255,.12)" : "rgba(6,9,20,1)",
                  border:"1px solid " + (active ? "rgba(60,110,255,.4)" : "rgba(255,255,255,.07)"),
                  color: active ? BLUE : "rgba(255,255,255,.35)" }}>
      {label}
      {count > 0 && (
        <span style={{ background: danger ? RED : (active ? BLUE : "rgba(255,255,255,.15)"), color: danger ? "#000" : (active ? "#000" : "#fff"), fontSize:10, fontWeight:800, minWidth:18, height:18, borderRadius:"50%", padding:"0 5px", display:"inline-flex", alignItems:"center", justifyContent:"center" }}>{count}</span>
      )}
    </div>
  );
}

const emptyBox = (text) => (
  <div style={{ padding:"36px 16px", textAlign:"center", color:MUTED, fontSize:13 }}>{text}</div>
);

function Field({ label, value, strong, danger }) {
  return (
    <div style={{ minWidth:0 }}>
      <div style={{ fontSize:10, color:MUTED, letterSpacing:".06em", textTransform:"uppercase" }}>{label}</div>
      <div style={{ fontSize: strong ? 14 : 13, fontWeight: strong ? 700 : 600, color: danger ? RED : "#fff", marginTop:1 }}>{value}</div>
    </div>
  );
}

// ── Pull request card — invoice number dominant ────────────────────────────────
function PullCard({ pull, selectedHub, nowMs, onSent, onReject }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const expired = isPullExpired(pull.dueDate, nowMs);

  const doSent = async () => {
    setBusy(true);
    try { await markPullSent(pull, selectedHub); onSent?.(pull); }
    catch (e) { console.warn("markPullSent failed:", e); setBusy(false); }
  };
  const doReject = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try { await rejectPull(pull, reason, selectedHub); onReject?.(pull); }
    catch (e) { console.warn("rejectPull failed:", e); setBusy(false); }
  };

  return (
    <div style={{ borderRadius:14, overflow:"hidden", position:"relative", background:CARD,
                  border:"1px solid " + (expired ? "rgba(220,60,60,.4)" : "rgba(60,110,255,.2)") }}>
      <div style={{ position:"absolute", left:0, top:0, bottom:0, width:3, background: expired ? RED : BLUE }}/>
      <div style={{ padding:"14px 14px 12px 18px" }}>
        {/* INVOICE NUMBER — huge + unmistakable */}
        <div style={{ display:"flex", alignItems:"flex-start", gap:12 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:11, fontWeight:700, color:MUTED, letterSpacing:".12em", textTransform:"uppercase" }}>Layby invoice</div>
            <div style={{ fontSize:34, fontWeight:900, color:"#fff", lineHeight:1.05, letterSpacing:".02em", wordBreak:"break-all" }}>{invOf(pull)}</div>
          </div>
          <div style={{ textAlign:"right", flexShrink:0 }}>
            {expired && (
              <span style={{ background:"rgba(220,60,60,.18)", color:RED, border:"1px solid rgba(220,60,60,.4)", borderRadius:10, padding:"3px 9px", fontSize:10.5, fontWeight:800 }}>EXPIRED</span>
            )}
            <div style={{ fontSize:11, color:MUTED, marginTop:6 }}>{ageLabel(pull.requestedAt, nowMs)} ago</div>
          </div>
        </div>

        {/* Customer-centric detail */}
        <div style={{ marginTop:12, display:"flex", flexWrap:"wrap", gap:"8px 18px" }}>
          <Field label="Customer" value={pull.customerName || "—"} strong/>
          <Field label="Phone" value={pull.customerPhone || "—"}/>
          <Field label="Items" value={typeof pull.itemCount === "number" ? String(pull.itemCount) : "—"}/>
          <Field label="Balance" value={formatLaybyMoney(pull.balanceRemaining)}/>
          <Field label="Due" value={pull.dueDate || "—"} danger={expired}/>
          <Field label="For store" value={labelFor(pull.requestingStore)}/>
        </div>
      </div>

      {!rejecting ? (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, padding:"0 14px 12px 18px" }}>
          <button onClick={doSent} disabled={busy}
                  style={{ padding:"12px 8px", borderRadius:10, fontSize:13, fontWeight:800, cursor: busy ? "default" : "pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, background:"rgba(0,150,70,.2)", border:"1px solid rgba(0,180,80,.35)", color:GREEN, opacity: busy ? .6 : 1 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
            Sent
          </button>
          <button onClick={() => setRejecting(true)} disabled={busy}
                  style={{ padding:"12px 8px", borderRadius:10, fontSize:13, fontWeight:800, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, background:"rgba(150,20,20,.15)", border:"1px solid rgba(180,40,40,.3)", color:RED }}>
            <svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Reject
          </button>
        </div>
      ) : (
        <div style={{ padding:"0 14px 12px 18px" }}>
          <div style={{ background:"rgba(150,20,20,.08)", border:"1px solid rgba(180,40,40,.3)", borderRadius:10, padding:"10px" }}>
            <div style={{ fontSize:11.5, fontWeight:700, color:RED, marginBottom:7 }}>Reason for rejection (sent back to the store)</div>
            <input autoFocus value={reason} onChange={e => setReason(e.target.value)}
                   placeholder="e.g. Past due date — layby forfeited"
                   style={{ width:"100%", boxSizing:"border-box", background:"rgba(0,0,0,.4)", border:"1px solid rgba(255,255,255,.14)", borderRadius:8, color:"#fff", padding:"9px 10px", fontSize:13, marginBottom:8 }}/>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={doReject} disabled={!reason.trim() || busy}
                      style={{ flex:1, padding:"10px", borderRadius:8, fontSize:12.5, fontWeight:800, cursor: (!reason.trim() || busy) ? "not-allowed" : "pointer", background:"rgba(180,40,40,.25)", border:"1px solid rgba(220,60,60,.45)", color:RED, opacity: (!reason.trim() || busy) ? .5 : 1 }}>
                Confirm reject
              </button>
              <button onClick={() => { setRejecting(false); setReason(""); }} disabled={busy}
                      style={{ padding:"10px 14px", borderRadius:8, fontSize:12.5, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,.04)", border:"1px solid rgba(255,255,255,.1)", color:"rgba(255,255,255,.7)" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Receiving row — parcel awaiting scan-in ───────────────────────────────────
function ReceivingRow({ layby, nowMs, onReceive, busy }) {
  const exception = isLaybyException(layby, nowMs);
  return (
    <div style={{ borderRadius:12, background:CARD, border:"1px solid " + (exception ? "rgba(220,60,60,.35)" : "rgba(255,255,255,.07)"), padding:"12px 13px", display:"flex", alignItems:"center", gap:12 }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:18, fontWeight:900, color:"#fff" }}>{invOf(layby)}</span>
          {exception && <span style={{ background:"rgba(220,60,60,.18)", color:RED, border:"1px solid rgba(220,60,60,.4)", borderRadius:8, padding:"1px 7px", fontSize:9.5, fontWeight:800 }}>OVERDUE</span>}
        </div>
        <div style={{ fontSize:12, color:"rgba(255,255,255,.55)", marginTop:2 }}>
          {layby.customerName || "—"} · {typeof layby.itemCount === "number" ? `${layby.itemCount} item${layby.itemCount === 1 ? "" : "s"}` : "—"} · from {labelFor(layby.originStore)}
        </div>
      </div>
      <button onClick={() => onReceive(layby)} disabled={busy}
              style={{ padding:"9px 14px", borderRadius:9, fontSize:12, fontWeight:800, cursor: busy ? "default" : "pointer", background:"rgba(0,150,70,.18)", border:"1px solid rgba(0,180,80,.32)", color:GREEN, whiteSpace:"nowrap", opacity: busy ? .6 : 1 }}>
        Receive
      </button>
    </div>
  );
}

// ── Exception row ──────────────────────────────────────────────────────────────
function ExceptionRow({ layby, nowMs }) {
  return (
    <div style={{ borderRadius:12, background:"rgba(40,10,10,.4)", border:"1px solid rgba(220,60,60,.3)", padding:"12px 13px" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
        <span style={{ fontSize:18, fontWeight:900, color:"#fff" }}>{invOf(layby)}</span>
        <span style={{ fontSize:11.5, color:"#FF9B9B", fontWeight:700 }}>overdue {ageLabel(layby.scanDeadline, nowMs)}</span>
      </div>
      <div style={{ marginTop:8, display:"flex", flexWrap:"wrap", gap:"6px 18px" }}>
        <Field label="From store" value={labelFor(layby.originStore)}/>
        <Field label="Created by" value={layby.createdBy || "—"}/>
        <Field label="Customer" value={layby.customerName || "—"}/>
        <Field label="Dispatched" value={ageLabel(layby.createdAt, nowMs) ? `${ageLabel(layby.createdAt, nowMs)} ago` : "—"}/>
      </div>
    </div>
  );
}

// ── Main tab ───────────────────────────────────────────────────────────────────
export default function LaybyTab({ selectedHub, laybys = [], pulls = [], nowMs, initialSub }) {
  const [sub, setSub] = useState(initialSub || "pulls");
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const [flash, setFlash] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);

  const pendingPulls = useMemo(
    () => pulls.filter(p => hubOf(p) === selectedHub && (p.status || PULL_STATUS.PENDING) === PULL_STATUS.PENDING)
               .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || "")),
    [pulls, selectedHub]
  );
  const receiving = useMemo(
    () => laybys.filter(l => hubOf(l) === selectedHub && (l.status || LAYBY_STATUS.IN_TRANSIT) === LAYBY_STATUS.IN_TRANSIT)
                .sort((a, b) => Number(isLaybyException(b, nowMs)) - Number(isLaybyException(a, nowMs))),
    [laybys, selectedHub, nowMs]
  );
  const exceptions = useMemo(
    () => laybys.filter(l => hubOf(l) === selectedHub && isLaybyException(l, nowMs)),
    [laybys, selectedHub, nowMs]
  );

  // Resolve a scan ({laybyId, invoiceNo}) against ALL laybys (a parcel may be
  // misrouted yet physically arrive here) — laybyId first, then invoiceNo — and
  // receive it.
  const tryReceive = async (scan) => {
    const { laybyId, invoiceNo } = scan || {};
    if (!laybyId && !invoiceNo) { setFlash({ ok:false, text:"Nothing scanned." }); return; }
    const match = laybys.find(l =>
      (laybyId && (l.laybyId || l.key) === laybyId) ||
      (invoiceNo && normalizeInvoiceNo(l.invoiceNo) === invoiceNo)
    );
    const shown = invoiceNo || laybyId;
    if (!match) { setFlash({ ok:false, text:`${shown} — not an expected layby.` }); return; }
    const inv = match.invoiceNo || shown;
    if (match.status === LAYBY_STATUS.STORED) { setFlash({ ok:true, text:`${inv} already received.` }); return; }
    if (match.status === LAYBY_STATUS.SENT)   { setFlash({ ok:false, text:`${inv} already sent to a store.` }); return; }
    setBusy(true);
    try {
      await receiveLayby(match, selectedHub);
      setFlash({ ok:true, text:`${inv} received into ${selectedHub}.` });
    } catch (e) {
      console.warn("receiveLayby failed:", e);
      setFlash({ ok:false, text:`Could not receive ${inv}.` });
    } finally { setBusy(false); }
  };

  const onScan = (raw) => { setScanning(false); tryReceive(parseLaybyScan(raw)); };
  const onManual = () => { if (!manual.trim()) return; tryReceive(parseLaybyScan(manual)); setManual(""); };

  return (
    <div style={{ padding:"0 13px 16px" }}>
      {scanning && <QrScanner onScan={onScan} onClose={() => setScanning(false)} />}

      {/* Sub-queue nav */}
      <div style={{ display:"flex", gap:7, paddingBottom:12, overflowX:"auto", scrollbarWidth:"none" }}>
        <SubPill active={sub==="pulls"}      label="Pull Requests" count={pendingPulls.length} onClick={() => setSub("pulls")}/>
        <SubPill active={sub==="receiving"}  label="Receiving"     count={receiving.length}     onClick={() => setSub("receiving")}/>
        <SubPill active={sub==="exceptions"} label="Exceptions"    count={exceptions.length} danger onClick={() => setSub("exceptions")}/>
      </div>

      {flash && (
        <div style={{ marginBottom:10, borderRadius:10, padding:"9px 12px", fontSize:12.5, fontWeight:600,
                      background: flash.ok ? "rgba(0,150,70,.14)" : "rgba(150,20,20,.14)",
                      border: "1px solid " + (flash.ok ? "rgba(0,180,80,.3)" : "rgba(220,60,60,.35)"),
                      color: flash.ok ? GREEN : "#FF9B9B", display:"flex", justifyContent:"space-between", gap:10 }}>
          <span>{flash.text}</span>
          <span onClick={() => setFlash(null)} style={{ cursor:"pointer", opacity:.7 }}>✕</span>
        </div>
      )}

      {sub === "pulls" && (
        pendingPulls.length === 0
          ? emptyBox("No pull requests for this hub.")
          : <div style={{ display:"flex", flexDirection:"column", gap:11 }}>
              {pendingPulls.map(p => (
                <PullCard key={p.key} pull={p} selectedHub={selectedHub} nowMs={nowMs}
                          onSent={() => setFlash({ ok:true, text:`${invOf(p)} marked sent.` })}
                          onReject={() => setFlash({ ok:true, text:`${invOf(p)} rejected — store notified.` })}/>
              ))}
            </div>
      )}

      {sub === "receiving" && (
        <>
          {/* Scan + manual entry */}
          <div style={{ background:CARD, border:"1px solid rgba(60,110,255,.2)", borderRadius:12, padding:"12px 13px", marginBottom:12 }}>
            <button onClick={() => { setFlash(null); setScanning(true); }}
                    style={{ width:"100%", padding:"13px", borderRadius:10, fontSize:14, fontWeight:800, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8, background:"rgba(60,110,255,.16)", border:"1px solid rgba(60,110,255,.4)", color:BLUE }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>
              Scan layby
            </button>
            <div style={{ display:"flex", gap:8, marginTop:10 }}>
              <input value={manual} onChange={e => setManual(e.target.value)}
                     onKeyDown={e => { if (e.key === "Enter") onManual(); }}
                     placeholder="…or type invoice number (e.g. L-00045)"
                     style={{ flex:1, boxSizing:"border-box", background:"rgba(0,0,0,.4)", border:"1px solid rgba(255,255,255,.14)", borderRadius:9, color:"#fff", padding:"10px 11px", fontSize:13 }}/>
              <button onClick={onManual} disabled={!manual.trim() || busy}
                      style={{ padding:"10px 16px", borderRadius:9, fontSize:13, fontWeight:700, cursor: (!manual.trim() || busy) ? "not-allowed" : "pointer", background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.14)", color:"#fff", opacity:(!manual.trim() || busy) ? .5 : 1 }}>
                Receive
              </button>
            </div>
          </div>

          {receiving.length === 0
            ? emptyBox("No parcels awaiting receipt at this hub.")
            : <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                {receiving.map(l => (
                  <ReceivingRow key={l.key} layby={l} nowMs={nowMs} busy={busy}
                                onReceive={(lb) => tryReceive({ laybyId: lb.laybyId || lb.key, invoiceNo: normalizeInvoiceNo(lb.invoiceNo) })}/>
                ))}
              </div>}
        </>
      )}

      {sub === "exceptions" && (
        exceptions.length === 0
          ? emptyBox("No exceptions — every dispatched parcel is accounted for.")
          : <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
              <div style={{ fontSize:12, color:"#FF9B9B", marginBottom:2 }}>
                Dispatched but never scanned in past the deadline. Find {exceptions.length > 1 ? "these" : "this"} today.
              </div>
              {exceptions.map(l => <ExceptionRow key={l.key} layby={l} nowMs={nowMs}/>)}
            </div>
      )}
    </div>
  );
}
