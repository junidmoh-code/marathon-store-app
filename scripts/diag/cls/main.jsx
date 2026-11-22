import React from "react";
import { createRoot } from "react-dom/client";
import { seed } from "./fakeDb.js";
import MissingProductsScreen from "../../../src/components/stock/MissingProductsScreen.jsx";

const decodeless = (x) => x;
(async () => {
  const s = await (await fetch("/__snap")).json();
  seed({
    stock: s.stock, stock_targets: s.targets, refill_requests: s.recentRequests, network: s.network || undefined,
    config: { refillEngine: s.config },
    settings: { stockHold: { held: s.held || {} }, missingProductsHidden: s.hidden || undefined },
  });
  const products = Object.entries(s.products).map(([id, p]) => ({ id, ...p }));
  window.__ready = true;
  createRoot(document.getElementById("root")).render(<MissingProductsScreen products={products} onExit={() => {}} />);
})();
void decodeless;
