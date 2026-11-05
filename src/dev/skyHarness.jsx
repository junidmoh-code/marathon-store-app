// ─── SKY HARNESS (dev only) ──────────────────────────────────────────────────
// Mounts the REAL sky screens — SkyHome, AssistantDesktop, AssistantPhone —
// with local fixtures, so the redesign can be screenshotted and overlaid on
// design/*.png without a signed-in session. Never built, never deployed:
// vite's build input is index.html alone. Fixtures come from
// dev/fixture.local.json (gitignored — real Storage URLs, public repo).
//
//   /dev/sky-harness.html?screen=home | desktop | phone   [&popup=1] [&cart=N] [&fixture=named]

import "../styles/sky.css";
import "../styles/sky-theme.css";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import SkyHome from "../components/sky/SkyHome.jsx";
import AssistantPhone from "../components/sky/AssistantPhone.jsx";
import { brandOptions, filterByBrand, reconcileBrand } from "../components/assistant/brandFilter.js";

const q = new URLSearchParams(location.search);
const screen = q.get("screen") || "home";

async function loadFixture() {
  // ?fixture=named: products exactly as RTDB holds them now (their own
  // cut-out fields, real Storage URLs) — dev/fixture-named.local.json.
  if (q.get("fixture")) {
    try { return await (await fetch(`/dev/fixture-${q.get("fixture")}.local.json`)).json(); } catch { /* fall through */ }
  }
  try {
    const r = await fetch("/dev/fixture.local.json");
    const list = await r.json();
    let cut = {};
    try { cut = await (await fetch("/dev/cutouts/index.local.json")).json(); } catch { /* none yet */ }
    return list.map((p) => (cut[p.id] && q.get("cutouts") !== "0"
      ? { ...p, photoCutoutUrl: `/dev/cutouts/${p.id}.png`, photoCutoutFor: p.photoUrl, photoCutoutQuality: cut[p.id] } : p));
  } catch {
    // CI / no local fixture: synthetic products (no photos, no Storage URLs).
    const brands = ["Nike", "Adidas", "Jordan", "New Balance", "Puma", "Nike", "Nike", "Adidas"];
    return ORDER.map((id, i) => ({ id, name: `Sample sneaker ${i + 1} Low Retro`, brand: brands[i % brands.length], retailPrice: 750, sizes: ["6", "7", "8", "9", "10"], photo: "👟" }));
  }
}

const ORDER = ["p1789137553443", "p1777978132487", "p1790164209800", "p1778844810609", "p1781649460930", "p1781649251868", "p1793626901972", "p1793630287984",
  "p1778142478269", "p1784974252709", "p1777975301073", "p1777975466134", "p1778143509555", "p1778143617466", "p1778144146893", "p1777984362269"];

function Home() {
  const noop = () => {};
  const icon = <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#4A7FFF" strokeWidth="2"><circle cx="12" cy="12" r="8" /></svg>;
  return (
    <SkyHome
      tag="2POS"
      initialPanel={q.get("panel")}
      liveCards={[]}
      tiles={[
        { key: "assistant", name: "Store Assistant", badge: 415, onClick: noop },
        { key: "warehouse", name: "Warehouse", badge: 2625, onClick: noop },
        { key: "display_checks", name: "Display Check", onClick: noop },
        { key: "admin", name: "Admin" },
      ]}
      groups={[
        { label: "Operations", cards: [{ key: "source", icon, name: "Source", desc: "Restock requests", badge: 12, onClick: noop }, { key: "barcodes", icon, name: "Barcodes", desc: "Print product barcodes", onClick: noop }, { key: "stock_audit", icon, name: "Stock Audit", desc: "Out of stock checks & audit", onClick: noop }] },
        { label: "Administration", cards: [{ key: "admin", icon, name: "Admin", desc: "Manage products", onClick: noop }, { key: "stock", icon, name: "Stock", desc: "Inventory & transfers", onClick: noop }, { key: "health", icon, name: "Inventory Health", desc: "Refill engine & exceptions", onClick: noop }] },
      ]}
      account={{ name: "Junid", initial: "J", rows: <div style={{ padding: 10 }}>notification + sign-out rows</div> }} />
  );
}

const REF_FILL = ["Puma", "Lacoste", "Boss", "Armani", "Diesel", "Gucci", "Prada", "Reebok", "Fila", "Under Armour"];

function Phone({ products }) {
  const [shop, setShop] = useState("trophy");
  const [mode, setMode] = useState("sneaker");
  const [search, setSearch] = useState("");
  const cart = Number(q.get("cart") || 0);
  // The brand strip, wired as AssistantView wires it (?brand=Nike preselects;
  // ?chips=ref adds the reference's fashion brands so the strip scrolls).
  const extra = q.get("chips") === "ref" ? REF_FILL.map((b, i) => ({ id: `x${i}`, name: `${b} sample`, brand: b, retailPrice: 900, sizes: ["8"] })) : [];
  const pool = [...products, ...extra];
  const [brand, setBrand] = useState(q.get("brand") || "All");
  const opts = useMemo(() => brandOptions(pool), [pool.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const n = reconcileBrand(brand, opts); if (n !== brand) setBrand(n); }, [opts]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = filterByBrand(pool.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase())), brand);
  return (
    <AssistantPhone mode={mode} onMode={setMode} brands={opts} brand={brand} onBrand={setBrand}
      shops={[{ id: "concrete" }, { id: "marathon-pe" }, { id: "pine" }, { id: "trophy" }]} effectiveShop={shop}
      shopLabel={(id) => ({ concrete: "Concrete", "marathon-pe": "Marathon PE", pine: "Pine", trophy: "Trophy" }[id])} onShop={setShop}
      search={search} onSearch={setSearch} onScan={() => {}}
      products={list} onOpen={() => {}} onViewPhotos={() => {}} photoCount={() => 1}
      cartCount={cart} onCart={() => {}} cartDisabled={!cart} onExit={() => {}} who="2pos" />
  );
}

function Desktop({ products, AssistantDesktop }) {
  const [mode, setMode] = useState("sneaker");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState([]);
  const list = products.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => {
    if (q.get("popup")) setTimeout(() => document.querySelector(".ad-card")?.click(), 400);
    if (q.get("brands")) setTimeout(() => document.querySelector(".ad-more-chip")?.click(), 400);
  }, []);
  // Brands for the chip row as the reference draws them.
  const fill = ["Puma", "Lacoste", "Boss", "Armani", "Diesel", "Gucci", "Prada"];
  const extra = fill.map((b, i) => ({ id: `x${i}`, name: `${b} sample`, brand: b, retailPrice: 900, sizes: ["8"], hidden: true }));
  const counts = q.get("chips") === "ref";
  return (
    <AssistantDesktop
      products={counts ? [...products, ...extra, ...extra] : products} searchResults={list}
      effectiveShop="trophy" availableShops={[{ id: "marathon-pe" }, { id: "trophy" }, { id: "concrete" }]}
      onSelectShop={() => {}} shopRegistry={null}
      search={search} setSearch={setSearch} onLabelFind={() => {}}
      cart={cart} onQuickAdd={(p, s, n) => { setCart((c) => [...c, ...Array.from({ length: n }, () => ({ product: p, size: s, productType: "sneaker", customerName: "x" }))]); return n; }}
      onRemoveOne={() => {}} onAddDisplayPartner={() => {}} onViewPhoto={() => {}} onSwitchView={() => {}}
      userEmail="gunidmoh@gmail.com" mode={mode} setMode={setMode}
      customerName="" setCustomerName={() => {}} customerPhone="" setCustomerPhone={() => {}}
      marketingOptIn setMarketingOptIn={() => {}} submitting={false} onPlaceOrder={() => {}}
      customerIndex={[]} onPickCustomer={() => {}} onAddClothing={() => {}} onPlaceRefill={() => {}}
      onOpenTracking={() => {}} trackingPending={0}
      hubQty={() => 3} servingHubLabel="Hub 2" sneakerOut={(p, s) => s === "4" || s === "10"} sneakerOutWhy={() => ({})} sneakerDisplayInfo={() => null}
      sizeOnHand={(p, s) => (s === "4" || s === "10" ? 0 : (Number(String(s).replace(/\D/g, "")) % 4) + 1)}
      hubLabelForSize={() => "Hub 1"}
      alternativesFor={() => null} />
  );
}

(async () => {
  const all = await loadFixture();
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const order = q.get("fixture") ? all.map((p) => p.id) : ORDER;
  const products = order.map((id) => byId[id]).filter(Boolean).map((p) => ({ ...p, retailPrice: p.retailPrice || 750 }));
  let el;
  if (screen === "desktop") {
    const { AssistantDesktop } = await import("../App.jsx");
    el = <Desktop products={products} AssistantDesktop={AssistantDesktop} />;
  } else if (screen === "admin") {
    const { AdminView } = await import("../App.jsx");
    el = <AdminView products={products} orders={[]} onExit={() => {}} />;
  } else if (screen === "phone") {
    el = <Phone products={products.slice(0, Number(q.get("n") || 16))} />;
  } else {
    el = <Home />;
  }
  createRoot(document.getElementById("root")).render(el);
})();
