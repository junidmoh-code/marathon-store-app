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
import { installZoomLock } from "../device/zoomLock.js";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import SkyHome from "../components/sky/SkyHome.jsx";
import AssistantPhone from "../components/sky/AssistantPhone.jsx";
import { SkySheet, SkySheetHead, SkyStepperRow } from "../components/sky/SkySheet.jsx";
import { brandOptions, filterByBrand, reconcileBrand } from "../components/assistant/brandFilter.js";

installZoomLock();
const q = new URLSearchParams(location.search);
const screen = q.get("screen") || "home";

function synthetic() {
  const brands = ["Nike", "Adidas", "Jordan", "New Balance", "Puma", "Nike", "Nike", "Adidas"];
  return ORDER.map((id, i) => ({ id, name: `Sample sneaker ${i + 1} Low Retro`, brand: brands[i % brands.length], retailPrice: 750, sizes: ["6", "7", "8", "9", "10"], photo: "👟" }));
}

async function loadFixture() {
  // ?fixture=named: products exactly as RTDB holds them now (their own
  // cut-out fields, real Storage URLs) — dev/fixture-named.local.json.
  // ?fixture=synthetic: the fixed sample products CI also gets — the phone
  // visual-regression baseline uses it so it never depends on local data.
  if (q.get("fixture") === "synthetic") return synthetic();
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
    return synthetic();
  }
}

const ORDER = ["p1789137553443", "p1777978132487", "p1790164209800", "p1778844810609", "p1781649460930", "p1781649251868", "p1793626901972", "p1793630287984",
  "p1778142478269", "p1784974252709", "p1777975301073", "p1777975466134", "p1778143509555", "p1778143617466", "p1778144146893", "p1777984362269"];

// The admin hub's live cards, drawn with the same inline colours the real
// cards use (components/stock/ui.js), so the theme layer maps them the same way.
function SampleLive({ title, body }) {
  return (
    <div style={{ background: "rgba(255,255,255,.024)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 14, padding: "12px 13px", marginBottom: 12 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff", marginBottom: 8 }}>{title}</div>
      {body && <div style={{ fontSize: 12, color: "#888", marginBottom: 10, lineHeight: 1.5 }}>{body}</div>}
      <button style={{ background: "rgba(74,127,255,.16)", border: "1px solid rgba(74,127,255,.45)", color: "#4A7FFF", borderRadius: 11, padding: "10px 12px", fontWeight: 700, width: "100%" }}>Open →</button>
    </div>
  );
}

// ?mock=1: the admin view with the 16 tools of Junid's 5 Nov mock-up, real icons.
const MOCK_TOOLS = [["source", "Source", 600], ["barcodes", "Barcodes"], ["label_print", "Print Labels"], ["stock_audit", "Stock Audit"],
  ["insights", "Internal Insights"], ["display", "TV Display"], ["customer", "Track Order"], ["customers_db", "Customers"],
  ["display_registration", "Display Registration"],
  ["admin", "Admin"], ["stock", "Stock"], ["health", "Inventory Health"], ["marketing", "Marketing"],
  ["new_arrivals", "New Arrivals"], ["shopify_publish", "Shopify Publish", 1022], ["social", "Social"], ["ai_studio", "AI Studio"]];
function Home({ icons = null }) {
  const noop = () => {};
  const icon = <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#4A7FFF" strokeWidth="2"><circle cx="12" cy="12" r="8" /></svg>;
  return (
    <SkyHome
      tag="2POS"
      initialPanel={q.get("panel")}
      liveCards={q.get("live") ? [["a", <SampleLive key="a" title="Hub Count & Displays" body="574 display units registered · 1750 of 2618 cells counted" />],
                                  ["b", <SampleLive key="b" title="Shipment Release" body="Nothing pending — every fulfilled box has been released." />],
                                  ["c", <SampleLive key="c" title="Display Registration" />]] : []}
      tiles={[
        { key: "assistant", name: "Store Assistant", badge: 415, onClick: noop },
        { key: "warehouse", name: "Warehouse", badge: 2625, onClick: noop },
        { key: "display_checks", name: "Display Check", onClick: noop },
        { key: "admin", name: "Admin" },
      ]}
      groups={icons && q.get("mock") ? [{ label: "All", cards: MOCK_TOOLS.map(([key, name, badge]) => ({ key, icon: icons[key], name, desc: name, badge, onClick: noop })) }] : [
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
  const [picked, setPicked] = useState(null);   // a card tap selects it, as in AssistantView
  const cart = Number(q.get("cart") || 0);
  // The brand strip, wired as AssistantView wires it (?brand=Nike preselects;
  // ?chips=ref adds the reference's fashion brands so the strip scrolls).
  const extra = q.get("chips") === "ref" ? REF_FILL.map((b, i) => ({ id: `x${i}`, name: `${b} sample`, brand: b, retailPrice: 900, sizes: ["8"] })) : [];
  const pool = [...products, ...extra];
  const [brand, setBrand] = useState(q.get("brand") || "All");
  const opts = useMemo(() => brandOptions(pool), [pool.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const n = reconcileBrand(brand, opts); if (n !== brand) setBrand(n); }, [opts]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = filterByBrand(pool.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase())), brand);
  // The size sheet (SkySheet) opens on a card tap, as AssistantView's does;
  // ?sheet=1 opens it on the first card at load.
  const [sheet, setSheet] = useState(q.get("sheet") ? list[0] || null : null);
  return (
    <>
      <AssistantPhone mode={mode} onMode={setMode} brands={opts} brand={brand} onBrand={setBrand}
        shops={[{ id: "concrete" }, { id: "marathon-pe" }, { id: "pine" }, { id: "trophy" }]} effectiveShop={shop}
        shopLabel={(id) => ({ concrete: "Concrete", "marathon-pe": "Marathon PE", pine: "Pine", trophy: "Trophy" }[id])} onShop={setShop}
        search={search} onSearch={setSearch} onScan={() => {}}
        products={list} selectedId={picked} onOpen={(p) => { setPicked(p.id); setSheet(p); }} onViewPhotos={() => {}} photoCount={() => 1}
        cartCount={cart} onCart={() => {}} cartDisabled={!cart} onExit={() => {}} who="2pos" />
      {sheet && <HarnessSheet p={sheet} onClose={() => setSheet(null)} />}
    </>
  );
}

// The phone size sheet with the REAL SkySheet / SkySheetHead / SkyStepperRow
// and the same size-pill markup AssistantView renders (its size logic needs
// live stock, which the harness never reads): 10 is unavailable.
function HarnessSheet({ p, onClose }) {
  const [size, setSize] = useState("");
  const [qty, setQty] = useState(1);
  const [dp, setDp] = useState(false);
  const [peek, setPeek] = useState(null);
  const t = useMemo(() => ({ id: null, fired: false }), []);
  const sizes = p.sizes || ["6", "7", "8", "9", "10"];
  const onHand = (s) => (s === "10" ? 0 : (Number(String(s).replace(/\D/g, "")) % 4) + 1);
  return (
    <SkySheet onClose={onClose} label={p.name} testId="phone-popup">
      <SkySheetHead p={p} onClose={onClose} chips={[p.styleCode || "W2401", "Hub 1"]} price={`R${p.retailPrice || 750}`} />
      <div className="sky-sheet__lab">Size</div>
      {peek && <div className="sky-sheet__peek" role="status" data-testid="size-peek">Size {peek} · {onHand(peek)} on hand</div>}
      <div className="sky-szgrid">
        {sizes.map((s) => {
          const out = onHand(s) === 0;
          return (
            <button key={s} className="sky-szq" aria-pressed={size === s} aria-disabled={out && size !== s}
              onPointerDown={() => { clearTimeout(t.id); t.fired = false; t.id = setTimeout(() => { t.fired = true; setPeek(s); }, 450); }}
              onPointerUp={() => clearTimeout(t.id)} onPointerLeave={() => clearTimeout(t.id)} onContextMenu={(e) => e.preventDefault()}
              onClick={() => { if (t.fired) { t.fired = false; return; } if (!out) setSize(size === s ? "" : s); }}>
              {s}<span className="sky-szq__n">{onHand(s)}</span>
            </button>
          );
        })}
      </div>
      <SkyStepperRow value={qty} onDec={() => setQty((v) => Math.max(1, v - 1))} decDisabled={qty <= 1} onInc={() => setQty((v) => Math.min(10, v + 1))} incDisabled={qty >= 10} />
      <button type="button" className="sky-sheet__dp" aria-pressed={dp} data-contrast-exempt="" onClick={() => setDp((v) => !v)}>
        <span className="sky-sheet__dpt">Display Partner <em>(Optional)</em><small>{dp ? "Requested — tap to cancel" : "Request a display partner"}</small></span>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
      </button>
      <button className="sky-primary sky-sheet__add" disabled={!size && !dp} style={{ width: "100%", opacity: size || dp ? 1 : 0.4 }}>
        {size ? `Add Size ${size} to Cart` : "Select a size or display option"}
      </button>
    </SkySheet>
  );
}

function Desktop({ products, AssistantDesktop }) {
  const [mode, setMode] = useState("sneaker");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState([]);
  const list = products.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => {
    if (q.get("popup")) setTimeout(() => document.querySelector(".ad-card")?.click(), 400);
    // &out=1: then tap the quick view's first unavailable size (why-note + alternatives).
    if (q.get("popup") && q.get("out")) setTimeout(() => document.querySelector('.ad-svsz button[aria-disabled="true"]')?.click(), 900);
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
      hubQty={() => 3} servingHubLabel="Hub 2" sneakerOut={(p, s) => s === "4" || s === "10"} sneakerOutWhy={() => ({ booked: 0, available: 0, checkedBoth: true })} sneakerDisplayInfo={() => null}
      sizeOnHand={(p, s) => (s === "4" || s === "10" ? 0 : (Number(String(s).replace(/\D/g, "")) % 4) + 1)}
      hubLabelForSize={() => "Hub 1"}
      alternativesFor={(p, size) => ({ rows: products.filter((x) => x.id !== p.id).slice(0, 4).map((x) => ({
        product: x, hasRequestedSize: true, matchedSize: size, sizes: (x.sizes || []).slice(0, 5),
        why: "Same model — Air Force 1", hubLabel: "Hub 1" })) })} />
  );
}

function Warehouse({ products, Top, css }) {
  const [tab, setTab] = useState("queue");
  const [f, setF] = useState("incoming");
  const ids = ["FQV", "LCD", "RCA"];
  const btn = (cls, label) => <button className={cls} style={{ padding: "11px 8px", borderRadius: 10, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>{label}</button>;
  return (
    <div className="wh-sky" style={{ minHeight: "100vh", maxWidth: 430, margin: "0 auto", paddingBottom: 40 }}>
      <style>{css}</style>
      <Top hubLabel="Hub 1" incomingCount={10} tabs={[["queue", "Order Queue", null], ["refills", "Display Refills", 4], ["layby", "Layby", null]]}
           tab={tab} onTab={setTab} onExit={() => {}} onSwitchHub={() => {}} />
      <div className="wh-chips">
        {[["incoming", "Incoming", 10], ["ready", "Ready", 663], ["out_of_stock", "Out of Stock", 80], ["all", "All", 927]].map(([k, l, n]) => (
          <div key={k} className="wh-chip" data-on={f === k ? "" : undefined} onClick={() => setF(k)} style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            {l}<span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: "0 13px" }}>
        <div data-day-section="" style={{ overflow: "hidden" }}>
          <div data-day-head="" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div>Today</div><div style={{ border: "1px solid", borderRadius: 999, padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>7</div></div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 10px" }}>
            {products.slice(0, 3).map((p, i) => (
              <div key={p.id} data-order-card={ids[i]} style={{ position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3 }} />
                <div style={{ padding: "12px 12px 12px 16px", display: "flex", gap: 11 }}>
                  <img src={p.photoUrl} alt="" style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 10 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <div style={{ fontSize: 13, fontWeight: 800 }}>#{ids[i]}</div>
                      <div style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: "#fff", color: "#1d3fb8" }}>● Incoming</div>
                      <div style={{ marginLeft: "auto" }}>···</div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{p.name} — Size {8 + i}</div>
                    <div style={{ fontSize: 11, marginTop: 3 }}>Shopify · 6:31:20 AM</div>
                  </div>
                </div>
                <div style={{ padding: "0 12px 10px 16px" }}>
                  <div className="wh-actgrid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {btn("wh-act--sent", "✓ Mark as Sent")}{btn("wh-act--oos", "✕ Mark as Out of Stock")}{btn("", "Coming tomorrow")}{btn("", "⇄ Substitute Size")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Barcodes({ products, BcsCard, css, Studio, SkyHeader }) {
  const cats = ["Sneakers", "Sneakers", "Clothing"];
  // ?many=1: the catalogue repeated to 60 cards, so the list really scrolls.
  const base = q.get("many") ? Array.from({ length: 60 }, (_, i) => ({ ...products[i % products.length], id: `${products[i % products.length].id}-${i}` })) : products.slice(0, 12);
  const list = base.map((p, i) => ({ ...p, category: cats[i % 3],
    sizes: (p.sizes && p.sizes.length ? p.sizes : ["7", "8", "9"]).slice(0, 7) }));
  const [openId, setOpenId] = useState(q.get("open") ? list[0]?.id : null);
  const [sel, setSel] = useState(q.get("open") ? { [`${list[0]?.id}|${list[0]?.sizes[1]}`]: { productId: list[0]?.id, productName: list[0]?.name, size: list[0]?.sizes[1], count: "2" } } : {});
  const [lastKey, setLastKey] = useState(q.get("open") ? `${list[0]?.id}|${list[0]?.sizes[1]}` : null);
  const [search, setSearch] = useState("");
  const [loc, setLoc] = useState("all"); const [cat, setCat] = useState("all"); const [transport, setTransport] = useState("phomemo");
  const onHand = (pid, s) => (String(s).length % 2 ? 0 : 3) + (s === list[0]?.sizes[2] ? -3 : 0) + 1;
  const toggle = (p, s) => setSel((x) => { const k = `${p.id}|${s}`; const n = { ...x }; if (n[k]) delete n[k]; else n[k] = { productId: p.id, productName: list.find((y) => y.id === p.id)?.name, size: s, count: "1" }; return n; });
  const wide = innerWidth >= 1024;
  if (wide) {
    const selList = Object.entries(sel);
    const lastItem = lastKey ? sel[lastKey] : null;
    const shown = list.filter((p) => (cat === "all" || p.category === cat) && p.name.toLowerCase().includes(search.toLowerCase()));
    return (
      <>
        <SkyHeader tag="BARCODES" gridLabel="Home" onGrid={() => {}} />
        <Studio onExit={() => {}} loc={loc} setLoc={setLoc} locOptions={[{ id: "all", label: "All locations" }, { id: "hub1", label: "Hub 1" }]}
          categories={["Clothing", "Sneakers"]} cat={cat} setCat={setCat} transport={transport} setTransport={setTransport}
          diagText={null} setDiagText={() => {}} totalCopies={selList.reduce((n, [, it]) => n + (parseInt(it.count, 10) || 0), 0)} canMint
          search={search} setSearch={setSearch} filtered={shown} openId={openId} setOpenId={setOpenId} sel={sel} onHand={onHand}
          toggle={toggle} setCount={(k, v) => setSel((x) => ({ ...x, [k]: { ...x[k], count: v } }))} lastKey={lastKey} setLastKey={setLastKey}
          lastItem={lastItem} lastP={lastItem ? list.find((p) => p.id === lastItem.productId) : null} previewCode={null}
          selList={selList} clearSel={() => { setSel({}); setLastKey(null); }} busy={false} doPrint={() => {}} onPhoto={() => {}} />
      </>
    );
  }
  return (
    <div style={{ padding: "14px" }}>
      <style>{css}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {list.map((p) => (
          <BcsCard key={p.id} p={p} expanded={openId === p.id} sel={sel} onHand={onHand}
                   onToggleOpen={() => setOpenId(openId === p.id ? null : p.id)}
                   onPick={(s) => toggle(p, s)} onCount={(k, v) => setSel((x) => ({ ...x, [k]: { ...x[k], count: v } }))} />
        ))}
      </div>
    </div>
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
  } else if (screen === "barcodes") {
    // The Barcode Studio page (desktop: the real BarcodeStudioDesktop with
    // fixture state; phone: the cards). The screen itself streams stock
    // cells, which the harness never reads. ?open=1 opens + picks the first.
    const { BcsCard, BCS_CSS, BarcodeStudioDesktop } = await import("../components/stock/BarcodeCatalog.jsx");
    const { SkyHeader } = await import("../components/sky/Sky.jsx");
    el = <div id="root-inner"><Barcodes products={products} BcsCard={BcsCard} css={BCS_CSS} Studio={BarcodeStudioDesktop} SkyHeader={SkyHeader} /></div>;
  } else if (screen === "viewer") {
    // The product photo viewer on its own (zoom test): an inline photo, so CI
    // needs no Storage URL.
    const { GalleryLightbox } = await import("../App.jsx");
    const svg = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#e8eef7"/><circle cx="300" cy="300" r="180" fill="#0026c2"/></svg>');
    el = <GalleryLightbox photos={[svg]} onClose={() => {}} />;
  } else if (screen === "warehouse") {
    // The warehouse phone top band (the real WarehouseTop) over sample queue
    // markup drawn with the same classes the real queue carries; the real
    // WarehouseView streams /orders, which the harness never reads.
    const { default: WarehouseTop, WAREHOUSE_SKY_CSS } = await import("../components/sky/WarehouseTop.jsx");
    el = <Warehouse products={products} Top={WarehouseTop} css={WAREHOUSE_SKY_CSS} />;
  } else if (screen === "phone") {
    el = <Phone products={products.slice(0, Number(q.get("n") || 16))} />;
  } else {
    const { RoleIcons } = q.get("mock") ? await import("../App.jsx") : {};
    el = <Home icons={RoleIcons || null} />;
  }
  createRoot(document.getElementById("root")).render(el);
})();
