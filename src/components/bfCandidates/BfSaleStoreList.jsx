// ─── BLACK FRIDAY SALE — the staff re-tag list (Junid, 23 Nov 2026) ──────────
// What is on sale at each location that holds it now, with the ONE sale price
// to put on the tag and the day the sale ends. Any signed-in staff member; the
// store alert ("Black Friday sale: <product> now R<price>, re-tag") opens it at
// their store (#bf-sale-list/<location>). Under it, for two days after a sale
// ends: "Back to normal price" — the tags to change back (what the END alert opens).
// Read only.
import React, { useEffect, useState } from "react";
import { FONT, BG, GLASS, GRAY, AMBER, RED, bGray, tabOn, tabOff } from "../stock/ui";

const price = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);

export default function BfSaleStoreList({ api, store = null, onExit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [at, setAt] = useState(store);
  // An alert for another store, tapped while this list is open, moves the list to that store.
  useEffect(() => { setAt(store); }, [store]);
  useEffect(() => {
    let live = true;
    api.storeList().then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(String((e && e.message) || e)); });
    return () => { live = false; };
  }, [api]);
  const stores = (data && data.stores) || [];
  const shown = stores.find((s) => s.loc === at) || stores[0] || null;
  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: "12px 14px 40px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, maxWidth: 760, margin: "0 auto" }}>
        <button type="button" style={{ ...bGray, padding: "8px 12px" }} onClick={onExit}>Back</button>
        <div>
          <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>🔥 Black Friday sale: re-tag list</div>
          <div style={{ color: GRAY, fontSize: "0.76rem" }}>One sale price for every customer. In-store only.</div>
        </div>
      </div>
      <div style={{ maxWidth: 760, margin: "12px auto 0" }}>
        {error && <div role="alert" style={{ color: RED }}>{error}</div>}
        {!data && !error && <div style={{ color: GRAY }}>Loading…</div>}
        {data && !stores.length && <div style={{ color: GRAY }}>Nothing is on sale right now, and no sale ended in the last two days.</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {stores.map((s) => <button key={s.loc} type="button" style={shown && shown.loc === s.loc ? tabOn : tabOff} onClick={() => setAt(s.loc)}>{s.name} ({s.items.length}{(s.back || []).length ? ` + ${s.back.length} back` : ""})</button>)}
        </div>
        {shown && shown.items.map((it) => (
          <div key={it.pid} style={{ ...GLASS, borderRadius: 14, padding: 12, marginBottom: 8, display: "flex", gap: 12, alignItems: "center" }}>
            {it.photo && <img src={api.thumb(it.photo)} alt="" loading="lazy" style={{ width: 56, height: 56, borderRadius: 10, objectFit: "cover", flex: "0 0 auto" }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: "0.9rem", overflowWrap: "anywhere" }}>{it.name}</div>
              <div style={{ color: GRAY, fontSize: "0.78rem" }}>{it.arriving ? `On its way to you (${it.arriving}): tag on arrival` : `${it.qty} here`} · ends {it.until}</div>
            </div>
            <div style={{ color: AMBER, fontWeight: 800, fontSize: "1.05rem" }}>{price(it.price)}</div>
          </div>
        ))}
        {shown && (shown.back || []).length > 0 && (
          <>
            <div style={{ fontWeight: 800, fontSize: "0.92rem", margin: "16px 0 8px" }}>Back to normal price: change these tags back</div>
            {shown.back.map((it) => (
              <div key={it.pid} style={{ ...GLASS, borderRadius: 14, padding: 12, marginBottom: 8, display: "flex", gap: 12, alignItems: "center" }}>
                {it.photo && <img src={api.thumb(it.photo)} alt="" loading="lazy" style={{ width: 56, height: 56, borderRadius: 10, objectFit: "cover", flex: "0 0 auto" }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: "0.9rem", overflowWrap: "anywhere" }}>{it.name}</div>
                  <div style={{ color: GRAY, fontSize: "0.78rem" }}>{it.qty} here · sale ended{it.was ? ` (was ${price(it.was)})` : ""}</div>
                </div>
                <div style={{ color: GRAY, fontWeight: 700, fontSize: "0.8rem" }}>Normal price</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
