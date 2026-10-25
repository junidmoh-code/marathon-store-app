// ─── DISPLAY CHECKS — "Website orders" strip ─────────────────────────────────
// Clothing (and perfume) a website order routed to THIS store's floor: pull it
// and hand it to the packer. The rows are the store's own display-check records
// of kind "online_pick" (written by the Mac mini's poller), so the same gate and
// the same server-side locks apply — the verdict goes through the same
// completeDisplayCheck callable the confirm sheet uses (stale-check,
// already-completed, wrong-kind are all refused there).
//
//   Handed over → the order line becomes "handed" (one tap)
//   Not found   → the line becomes "not_found", the order needs attention and
//                 Junid is emailed (two taps — it is not undone by the next tap)
//
//   Put back    → a RETURN row (kind "online_return"): the website customer
//                 swapped the item after it was handed over; it goes back on
//                 the floor. One tap closes it (the order's return record).
//
// NO STOCK MOVES HERE. PE or Trophy stock deducts once, at the POS Pack, from
// whichever store the line was routed to. Hidden when there is nothing waiting.
import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { getDatabase, ref, get } from "firebase/database";
import { functions } from "../../firebase";
import { FONT, MONO, INK, PANEL, META } from "./tokens";
import { ONLINE_ORDERS_CONFIG_PATH } from "../../utils/onlineOrders";
import { CheckProperlyBanner } from "./CheckCard";
import { isOnlineReturn } from "./feedModel";
import { PrimaryPhoto } from "../../components/shared/PrimaryPhoto.jsx";

export const DEFAULT_HANDOVER_TEXT = "Give to Till 2";
const RED = "#FF453A";
const GREEN = "#4ACA7A";
const completeDisplayCheck = httpsCallable(functions, "completeDisplayCheck");

/** The handover words, one exact-path read; the default when unset or unreadable. */
export function useHandoverText() {
  const [text, setText] = useState(DEFAULT_HANDOVER_TEXT);
  useEffect(() => {
    let live = true;
    get(ref(getDatabase(), `${ONLINE_ORDERS_CONFIG_PATH}/handoverText`))
      .then((s) => { const v = s.val(); if (live && typeof v === "string" && v.trim()) setText(v.trim()); })
      .catch(() => { /* the default stands */ });
    return () => { live = false; };
  }, []);
  return text;
}

function Row({ store, row, handover }) {
  const [busy, setBusy] = useState(false);
  const [confirmNotFound, setConfirmNotFound] = useState(false);
  const [error, setError] = useState(null);
  const size = row.size && row.size !== "_" ? String(row.size) : null;
  const isReturn = isOnlineReturn(row);

  async function complete(result) {
    setBusy(true); setError(null);
    try {
      await completeDisplayCheck({ store, key: row.key, checkId: row.checkId, result, override: false });
      // Committed — the live feed moves the row out on its own.
    } catch (err) {
      setError((err && (err.message || err.code)) || "Couldn't save. Try again.");
      setBusy(false);
    }
  }

  const btn = { fontFamily: FONT, fontWeight: 750, borderRadius: 12, cursor: busy ? "default" : "pointer", border: "none" };
  return (
    <div data-testid="web-row" style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      {row.photoUrl
        ? <PrimaryPhoto product={{ id: row.productId, photoUrl: row.photoUrl }} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 10, flex: "0 0 56px" }} />
        : <div style={{ width: 56, height: 56, borderRadius: 10, background: "rgba(255,255,255,.05)", flex: "0 0 56px" }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FONT, fontSize: 15, fontWeight: 700, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.productName || "Item"}</div>
        <div style={{ fontFamily: MONO, fontSize: 12, color: "rgba(233,238,255,.6)", marginTop: 2 }}>
          {size ? `SIZE ${size} · ` : ""}QTY {row.qty || 1} · <span style={{ color: GREEN, fontWeight: 700 }}>{row.orderNumber != null ? `#${row.orderNumber}` : (row.ref || "—")}</span>
        </div>
        {/* Escalation round 2: this shop answered Not found once already. */}
        {row.checkProperly === true && <div role="alert" data-testid="web-check-properly" style={{ marginTop: 6 }}><CheckProperlyBanner /></div>}
        <div style={{ fontFamily: FONT, fontSize: 13, color: isReturn ? GREEN : INK, fontWeight: isReturn ? 700 : 400, marginTop: 4 }} data-testid={isReturn ? "web-return-text" : undefined}>
          {isReturn ? "RETURN TO SHELF — the customer swapped it. Put it back on the floor." : `Pull and ${handover.charAt(0).toLowerCase()}${handover.slice(1)}`}
        </div>
        {error && <div style={{ fontFamily: FONT, fontSize: 12, color: RED, marginTop: 4 }}>{error}</div>}
      </div>
      {isReturn ? (
        <button type="button" disabled={busy} onClick={() => complete("put_back")} data-testid="web-put-back"
                style={{ ...btn, background: GREEN, color: "#04140a", fontSize: 15, padding: "12px 16px", minHeight: 44, flex: "0 0 auto" }}>
          Put back
        </button>
      ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch", flex: "0 0 auto" }}>
        <button type="button" disabled={busy} onClick={() => complete("handed")} data-testid="web-handed"
                style={{ ...btn, background: GREEN, color: "#04140a", fontSize: 15, padding: "12px 16px", minHeight: 44 }}>
          Handed over
        </button>
        <button type="button" disabled={busy} data-testid="web-notfound"
                onClick={() => (confirmNotFound ? complete("not_found") : setConfirmNotFound(true))}
                style={{ ...btn, background: "rgba(255,255,255,.06)", color: confirmNotFound ? RED : "rgba(233,238,255,.7)", fontSize: 12, padding: "6px 10px" }}>
          {confirmNotFound ? "Tap again: not found" : "Not found"}
        </button>
      </div>
      )}
    </div>
  );
}

export default function WebsiteOrdersStrip({ store, rows }) {
  const handover = useHandoverText();
  if (!store || !Array.isArray(rows) || rows.length === 0) return null;
  return (
    <div data-testid="web-strip" style={{ ...PANEL, padding: "12px 16px", marginBottom: 18, borderColor: "rgba(255,69,58,.35)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ ...META, fontSize: 12, color: INK }}>Website orders</div>
        <span data-testid="web-count" style={{ background: RED, color: "#fff", fontFamily: MONO, fontWeight: 800, fontSize: 12, borderRadius: 999, padding: "2px 8px" }}>{rows.length}</span>
      </div>
      {rows.map((r) => <Row key={r.key} store={store} row={r} handover={handover} />)}
    </div>
  );
}
