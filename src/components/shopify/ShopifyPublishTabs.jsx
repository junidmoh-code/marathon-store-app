// ─── SHOPIFY PUBLISHING: MARATHON | CONCRETE ─────────────────────────────────
// Two top tabs over the one publishing view. Marathon is exactly the page it
// always was (every product, /shopify_publish). Concrete shows ONLY products
// marked listOnConcrete and drives /shopify_publish_concrete with the same
// states, Publish confirmation, batch publish, On/Off switch and edit page.
//
// The store's node is chosen by setPublishTarget() BEFORE the view renders, and
// the view is KEYED by tab, so switching tabs remounts it with empty state —
// one store's loaded nodes can never be shown or written under the other.
import React, { useEffect, useMemo, useState } from "react";
import ShopifyPublishView from "./ShopifyPublishView";
import { setPublishTarget } from "./shopifyPublishStore";
import { isOnConcrete } from "../../utils/concreteListing";
import HouseStylePanel from "../concrete/HouseStylePanel";

const TAB_KEY = "marathon_shopify_tab";
const readTab = () => { try { return sessionStorage.getItem(TAB_KEY) === "concrete" ? "concrete" : "marathon"; } catch { return "marathon"; } };

export default function ShopifyPublishTabs({ products = [], onExit }) {
  const [tab, setTab] = useState(readTab);
  const concreteProducts = useMemo(() => products.filter(isOnConcrete), [products]);
  setPublishTarget(tab);
  // Leaving the page puts the store back on Marathon: the home screen's
  // awaiting badge (useShopifyAwaitingCount) reads through the same store.
  useEffect(() => () => setPublishTarget("marathon"), []);
  const choose = (t) => {
    if (t === tab) return;
    try { sessionStorage.setItem(TAB_KEY, t); } catch { /* storage off */ }
    if (typeof window !== "undefined" && /^#shopify\//.test(window.location.hash || "")) window.location.hash = "";
    setTab(t);
  };
  const btn = (t, label, count) => (
    <button key={t} type="button" onClick={() => choose(t)}
      style={{ flex: 1, padding: "10px 8px", borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: "pointer",
               background: tab === t ? (t === "concrete" ? "#E5E5E5" : "#4A7FFF") : "rgba(255,255,255,.05)",
               color: tab === t ? (t === "concrete" ? "#000" : "#fff") : "rgba(255,255,255,.6)",
               border: "1px solid " + (tab === t ? "transparent" : "rgba(255,255,255,.1)") }}>
      {label}{count != null ? ` · ${count}` : ""}
    </button>
  );
  const tabs = (
    <div>
      <div style={{ display: "flex", gap: 8, padding: "0 14px 10px" }}>
        {btn("marathon", "Marathon")}
        {btn("concrete", "Concrete", concreteProducts.length)}
      </div>
      {tab === "concrete" && <HouseStylePanel products={concreteProducts} />}
    </div>
  );
  return (
    <ShopifyPublishView
      key={tab}
      products={tab === "concrete" ? concreteProducts : products}
      onExit={onExit}
      topSlot={tabs}
      title={tab === "concrete" ? "CONCRETE PUBLISHING" : "SHOPIFY PUBLISHING"}
    />
  );
}
