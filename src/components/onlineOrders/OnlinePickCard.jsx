// ─── WEBSITE ORDERS — one hub pick in the Warehouse queue ────────────────────
// Rendered by WarehouseView for rows built by pickQueueRows (onlinePicks.js),
// in place of the order card, the way a layby pull renders as PullCard. It
// must not look like a shop order: a green WEB badge and the order's ref, then
// the photo, size, qty and title, then the instruction every pick carries. One
// big button, "Handed over" — no print, no transfer, no stock movement. On
// success the row leaves the queue by itself (the subscription's query is
// "{hub}|open" and the write moves it to "{hub}|handed").

import { useState } from "react";
import { handOverPick } from "./onlinePicks";
import { PACKER_INSTRUCTION } from "../../utils/onlineOrders";

const CARD = "rgba(4,5,10,1)";
const GREEN = "#4ACA7A";
const RED = "#FF6B6B";
const MUTED = "rgba(255,255,255,.4)";

export default function OnlinePickCard({ pick, hub, onHanded }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const size = pick.size && pick.size !== "_" ? String(pick.size) : null;
  const qty = Number(pick.qty) || 1;

  const doHand = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await handOverPick(pick, hub); onHanded?.(pick); }
    catch (e) { console.warn("handOverPick failed:", e); setErr("Didn't save — tap again."); setBusy(false); }
  };

  return (
    <div style={{ borderRadius:14, overflow:"hidden", position:"relative", background:CARD, border:"1px solid rgba(74,202,122,.35)" }}>
      <div style={{ position:"absolute", left:0, top:0, bottom:0, width:3, background:GREEN }}/>
      <div style={{ padding:"14px 14px 12px 18px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
          <span style={{ background:"rgba(74,202,122,.16)", color:GREEN, border:"1px solid rgba(74,202,122,.45)", borderRadius:8, padding:"2px 8px", fontSize:10, fontWeight:800, letterSpacing:".1em" }}>WEBSITE ORDER</span>
          <span style={{ fontSize:22, fontWeight:900, color:"#fff", letterSpacing:".02em" }}>{pick.ref || "—"}</span>
        </div>
        <div style={{ display:"flex", gap:12, marginTop:12, alignItems:"center" }}>
          <div style={{ width:84, height:84, flexShrink:0, borderRadius:12, overflow:"hidden", background:"rgba(255,255,255,.05)", display:"flex", alignItems:"center", justifyContent:"center" }}>
            {pick.photoUrl
              ? <img src={pick.photoUrl} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
              : <span style={{ fontSize:9, color:MUTED, letterSpacing:".1em" }}>NO IMAGE</span>}
          </div>
          <div style={{ minWidth:0, flex:1 }}>
            <div style={{ fontSize:15, fontWeight:700, color:"#fff", lineHeight:1.25 }}>{pick.title || pick.productId || "Unknown item"}</div>
            <div style={{ display:"flex", gap:14, marginTop:6, fontSize:13, color:"rgba(255,255,255,.75)" }}>
              {size && <span>Size <b style={{ color:"#fff", fontSize:16 }}>{size}</b></span>}
              <span>Qty <b style={{ color:"#fff", fontSize:16 }}>{qty}</b></span>
            </div>
          </div>
        </div>
        <div style={{ marginTop:12, padding:"10px 12px", borderRadius:10, background:"rgba(74,202,122,.08)", border:"1px solid rgba(74,202,122,.25)", color:"#fff", fontSize:14, fontWeight:700 }}>
          {PACKER_INSTRUCTION}
        </div>
        {err && <div style={{ marginTop:8, color:RED, fontSize:12, fontWeight:700 }}>{err}</div>}
      </div>
      <div style={{ padding:"0 14px 14px 18px" }}>
        <button type="button" onClick={doHand} disabled={busy}
          style={{ width:"100%", minHeight:56, borderRadius:12, border:"none", background:GREEN, color:"#04140a", fontSize:17, fontWeight:800, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Handed over"}
        </button>
      </div>
    </div>
  );
}
