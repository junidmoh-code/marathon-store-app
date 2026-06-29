import { useState, useEffect, useRef, useMemo } from "react";
import { ref, onValue, set, update, remove, push, runTransaction, get } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { signInAnonymously, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { database, storage, auth, googleProvider, functions, functionsUS } from "./firebase";
import Fuse from "fuse.js";
import { productMatchesQuery } from "./utils/productSearch";
import { uploadBroadcastMedia } from "./broadcastStorage";
import AuthGate from "./components/AuthGate";
import { usePermissions } from "./components/PermissionsContext";
import { toAuthPassword } from "./utils/auth-utils";
import { normalizeSAPhone, isValidLocalSAPhone, toLocalSA, saSignificantDigits } from "./utils/phone";
import UserManagement from "./components/UserManagement";
import TvDisplayMockup from "./components/TvDisplayMockup";
import StockView from "./components/stock/StockView";
import BarcodeCatalog from "./components/stock/BarcodeCatalog";
import { applyMovement } from "./components/stock/applyMovement";
import { sellableLocations, labelFor, transferTargets } from "./components/stock/locations";
import { useStockCells, useLocations } from "./components/stock/useStock";
import { shopUniverse } from "./utils/stores";
import { LocationPicker } from "./components/stock/widgets";
import BarcodePrint from "./components/stock/BarcodePrint";
import { ensureBarcodes } from "./components/stock/barcodeStore";
import { printDispatchLabel } from "./components/stock/printDispatch";
import LaybyTab, { LaybyExceptionsBanner } from "./components/layby/LaybyTab";
import { useLaybys, useLaybyPulls } from "./components/layby/useLayby";
import { DEFAULT_STORAGE_HUB, PULL_STATUS } from "./components/layby/contract";
import { inferProductType, dedupeByOrderNumber, excludeReturnedOrderNumbers, oosEventsForPeriod, readyEventsForPeriod, clothingRefillEventsForPeriod } from "./utils/insights";

// ─── WHATSAPP — via Firebase Cloud Function (europe-west1) ───────────────────
// The Meta API cannot be called directly from the browser (CORS). All sends
// are proxied through the sendWhatsApp Cloud Function which holds the token.
const WA_FUNCTION_URL = "https://sendwhatsapp-jp3ooc2lya-ew.a.run.app";

function sendWhatsAppTemplate(phone, templateName, params = []) {
  if (!phone) return;
  fetch(WA_FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateName, recipientPhone: phone, templateParams: params }),
  }).catch(err => console.warn("WhatsApp send failed:", err));
}

// Converts a base64 data-URL to a binary Blob for Firebase Storage upload.
function dataURLToBlob(dataUrl) {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(data);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Clean product placeholder icon — replaces 👟 emoji
function ProductIcon({ size = 28, color = "#4A7FFF", opacity = 0.6 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeOpacity={opacity} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
      <path d="M2 17h13a4 4 0 003-1.4l3-3.4a2 2 0 00-1.5-3.3l-5.4-.1a2 2 0 01-1.5-.7l-1.7-2A3 3 0 008.4 5H4a2 2 0 00-2 2v10z"/>
      <line x1="2" y1="14" x2="20" y2="14"/>
      <line x1="6" y1="9" x2="6" y2="14"/>
      <line x1="10" y1="9" x2="10" y2="14"/>
    </svg>
  );
}

// Renders a product photo thumbnail (img for URLs, clean SVG fallback otherwise).
// Returns "" for non-string inputs so downstream callers (e.g. InsightReorderTab)
// that occasionally pass a falsy productName don't crash on render.
const _normPhotoKey = s => typeof s === "string"
  ? s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\s*-\s*/g, '-')
  : "";

// photoMap shape: { [productName]: { photoUrl, photo } }
// Exact match first; falls back to normalized key (trim, collapse spaces, lowercase,
// remove spaces around hyphens) to handle old order names that drifted from catalog.
function ProductThumb({ name, photoMap, size = 40 }) {
  const normName = _normPhotoKey(name);
  const p   = photoMap?.[name] ?? (normName ? photoMap?.[normName] : undefined);
  if (!p) console.warn("[ProductThumb] no map entry for:", JSON.stringify(name));
  const url = p?.photoUrl;
  if (url && (url.startsWith("http") || url.startsWith("data:"))) {
    return (
      <img src={url} alt={name}
        style={{ width:size, height:size, objectFit:"cover", borderRadius:RADIUS, flexShrink:0, border:"1px solid rgba(60,110,255,.12)" }}
        onError={e => { console.warn("[ProductThumb] photoUrl load failed:", name, url); e.currentTarget.style.display = "none"; }} />
    );
  }
  const emoji = p?.photo;
  if (emoji && (emoji.startsWith("data:") || emoji.startsWith("http"))) {
    return (
      <img src={emoji} alt={name}
        style={{ width:size, height:size, objectFit:"cover", borderRadius:RADIUS, flexShrink:0, border:"1px solid rgba(60,110,255,.12)" }}
        onError={e => { console.warn("[ProductThumb] photo load failed:", name, emoji.slice(0, 80)); e.currentTarget.style.display = "none"; }} />
    );
  }
  if (p) console.warn("[ProductThumb] unusable photo fields for:", name, { photoUrl: url, photo: (p.photo || "").slice(0, 40) });
  return (
    <div style={{ width:size, height:size, borderRadius:8, background:"rgba(60,110,255,.08)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, border:"1px solid rgba(60,110,255,.12)" }}>
      <ProductIcon size={Math.round(size * 0.55)} />
    </div>
  );
}

// Helper to render product photo or icon — replaces inline `{p.photoUrl ? <img> : "👟"}` patterns
function ProductPhoto({ url, photo, size = 60, radius = 10, bg = "rgba(255,255,255,.08)" }) {
  const src = url || (photo && (photo.startsWith("data:") || photo.startsWith("http")) ? photo : null);
  return (
    <div style={{ width:size, height:size, borderRadius:radius, background:bg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, overflow:"hidden" }}>
      {src
        ? <img src={src} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e => { e.currentTarget.style.display = "none"; }}/>
        : <ProductIcon size={Math.round(size * 0.5)} />}
    </div>
  );
}

const ROLES = { ADMIN: "admin", ASSISTANT: "assistant", WAREHOUSE: "warehouse", CUSTOMER: "customer", DISPLAY: "display", INSIGHTS: "insights", SOURCE: "source", RETURNS: "returns", CUSTOMERS_DB: "customers_db", BROADCAST_GROUPS: "broadcast_groups", USER_MANAGEMENT: "user_management", STOCK: "stock", BARCODES: "barcodes" };

// Each role tile maps to a permission string. Tiles are hidden when the
// signed-in user lacks the permission. Super-admin (gunidmoh@gmail.com)
// bypasses every check via hasPermission's email shortcut.
// TV Display and Customer are auxiliary admin-only tiles — no dedicated perm
// in the spec, so they ride on product_admin (admin and super_admin only).
const ROLE_TO_PERMISSION = {
  [ROLES.ASSISTANT]:        "store_assistant",
  [ROLES.WAREHOUSE]:        "warehouse",
  [ROLES.SOURCE]:           "source",
  [ROLES.RETURNS]:          "place_orders",
  [ROLES.INSIGHTS]:         "insights",
  [ROLES.DISPLAY]:          "product_admin",
  [ROLES.CUSTOMER]:         "product_admin",
  [ROLES.CUSTOMERS_DB]:     "customer_data",
  [ROLES.ADMIN]:            "product_admin",
  [ROLES.BROADCAST_GROUPS]: "broadcast",
  [ROLES.USER_MANAGEMENT]:  "user_management",
  // NOTE: ROLES.STOCK is intentionally NOT permission-mapped here — opening the Stock
  // section is gated by /users/{uid}/stockRole (warehouse|admin), computed as
  // canAccessStock, NOT by an app permission, so the seed counters (stockRole
  // warehouse) keep access. ROLES.BARCODES is open to everyone (reprint is read-only).
};
const STATUS = { INCOMING: "incoming", READY: "ready", OUT_OF_STOCK: "out_of_stock", COLLECTED: "collected", COMING_TOMORROW: "coming_tomorrow" };

// ─── SIZE RANGE + SUBSTITUTE HELPERS ──────────────────────────────────────────
// Canonical numeric range used to decide whether a ±1 substitute is in bounds.
// Matches the spread of sizeOptions in AdminView ([3..11]); kept here so the
// Warehouse picker doesn't have to import it.
const SIZE_MIN = 3;
const SIZE_MAX = 11;

// Given a requested size string, returns { below, above } as size strings
// representing one FULL size down / up (delta ±1.0). Either side is null when
// out of [SIZE_MIN, SIZE_MAX] range. Half-size in → half-size out:
//   "5"   → { below: "4",   above: "6" }
//   "5.5" → { below: "4.5", above: "6.5" }
//   "3"   → { below: null,  above: "4" }
//   "11"  → { below: "10",  above: null }
function subSizeOptions(requestedSize) {
  const n = Number(requestedSize);
  if (!isFinite(n)) return { below: null, above: null };
  const fmt = v => (v % 1 === 0 ? String(v) : v.toFixed(1));
  const lo = n - 1;
  const hi = n + 1;
  return {
    below: lo >= SIZE_MIN ? fmt(lo) : null,
    above: hi <= SIZE_MAX ? fmt(hi) : null,
  };
}

// Source view displays sentSize when present, falling back to the requested
// size. Everywhere else still reads order.size directly so the audit/UX trail
// upstream remains unchanged.
function sourceDisplaySize(order) {
  return order.sentSize || order.size || null;
}

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
const FONT   = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const BG     = "#000000";
const CARD   = "rgba(4,5,10,1)";
const BLUE   = "#4A7FFF";
const BLUE_L = "#6A9FFF";
const BORDER = "1px solid rgba(60,110,255,.12)";
const BORDER_BRIGHT = "1px solid rgba(60,110,255,.6)";
const RADIUS = "14px";
const GLOW   = "0 0 12px rgba(60,110,255,.15)";

const STATUS_CONFIG = {
  incoming:         { label: "Incoming",             color: "#4A7FFF", bg: "rgba(60,110,255,.15)",   border: "rgba(60,110,255,.35)",  icon: "" },
  ready:            { label: "Ready for Collection", color: "#4ADE80", bg: "rgba(74,222,128,.15)",   border: "rgba(74,222,128,.35)",  icon: "" },
  out_of_stock:     { label: "Out of Stock",          color: "#F87171", bg: "rgba(248,113,113,.15)",  border: "rgba(248,113,113,.35)", icon: "" },
  collected:        { label: "Collected",             color: "#9CA3AF", bg: "rgba(156,163,175,.15)",  border: "rgba(156,163,175,.35)", icon: "" },
  coming_tomorrow:  { label: "Coming Tomorrow",       color: BLUE_L,    bg: "rgba(74,130,255,.15)",   border: "rgba(74,130,255,.35)",  icon: "" },
};

// Button style presets
const bGreen    = { background:"rgba(0,150,70,.2)",    border:"1px solid rgba(0,150,70,.5)",    color:"#4ADE80",  borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem" };
const bRed      = { background:"rgba(150,20,20,.15)",  border:"1px solid rgba(150,20,20,.4)",   color:"#F87171",  borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem" };
const bBlue     = { background:"rgba(60,110,255,.08)", border:"1px solid rgba(60,110,255,.25)", color:BLUE,       borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem" };
const bTomorrow = { background:"rgba(60,110,255,.12)", border:"1px solid rgba(60,110,255,.35)", color:BLUE_L,     borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem" };
const bGray     = { background:"rgba(100,100,100,.12)",border:"1px solid rgba(100,100,100,.25)",color:"#9CA3AF",  borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem" };
const bGhost    = { background:"transparent",          border:`1px solid rgba(60,110,255,.25)`, color:BLUE,       borderRadius:RADIUS, fontWeight:"600", cursor:"pointer", fontSize:"0.85rem" };
const bDanger   = { ...bRed };
const bPrimary  = { ...bGreen };

// Tab presets
const tabOn  = { background:"rgba(60,110,255,.12)", border:"2px solid rgba(60,110,255,.4)",  color:BLUE_L, borderRadius:"999px", fontWeight:"600", cursor:"pointer", padding:"0.45rem 1.1rem", fontSize:"0.85rem" };
const tabOff = { background:CARD,                   border:"2px solid rgba(60,110,255,.08)", color:"#555", borderRadius:"999px", fontWeight:"600", cursor:"pointer", padding:"0.45rem 1.1rem", fontSize:"0.85rem" };

// Underline tab presets (used in Insights, Customers, Source)
const ulTabOn  = { background:"transparent", border:"none", borderBottom:`2px solid ${BLUE}`, color:BLUE,  padding:"0.9rem 1.1rem", cursor:"pointer", fontWeight:"600", fontSize:"0.83rem" };
const ulTabOff = { background:"transparent", border:"none", borderBottom:"2px solid transparent", color:"#555", padding:"0.9rem 1.1rem", cursor:"pointer", fontWeight:"600", fontSize:"0.83rem" };

// ─── CIRCUIT LINE DECORATION ─────────────────────────────────────────────────
function CircuitLine() {
  return (
    <div style={{ width:"100%", height:12, overflow:"hidden" }}>
      <svg width="100%" height="12" viewBox="0 0 600 12" preserveAspectRatio="none" style={{ display:"block" }}>
        <line x1="0" y1="6" x2="600" y2="6" stroke={BLUE} strokeWidth="0.5" strokeOpacity="0.3"/>
        {[60,150,240,330,420,510].map(x => (
          <g key={x}>
            <line x1={x} y1="6" x2={x} y2={x%120===60?"0":"12"} stroke={BLUE} strokeWidth="0.5" strokeOpacity="0.3"/>
            <circle cx={x} cy="6" r="2" fill={BLUE} opacity="0.35"/>
          </g>
        ))}
      </svg>
    </div>
  );
}

const inputStyle = {
  background: CARD, border: "1px solid rgba(60,110,255,.2)", borderRadius: "10px",
  padding: "0.65rem 1rem", color: "#fff", fontSize: "0.95rem", outline: "none",
  width: "100%", boxSizing: "border-box",
};

// ─── PRODUCTS HOOK + DIRECT FIREBASE WRITES ──────────────────────────────────
// Products are stored at /products/{id} — one node per product, never a full
// array replacement. This prevents any race condition where two devices writing
// concurrently could clobber each other's data.
//
// Persist a view's active-tab selection across page refreshes. Stored under
// `tabState:<sectionKey>` so the keyspace is consistent and greppable. Falls
// back to defaultTab if localStorage is unavailable (private-mode Safari).
function usePersistedTab(sectionKey, defaultTab) {
  const storageKey = `tabState:${sectionKey}`;
  const [tab, setTabRaw] = useState(() => {
    try { return localStorage.getItem(storageKey) || defaultTab; }
    catch { return defaultTab; }
  });
  const setTab = (next) => {
    try { localStorage.setItem(storageKey, next); } catch { /* ignored */ }
    setTabRaw(next);
  };
  return [tab, setTab];
}

// Tracks Firebase anonymous-auth readiness for any data hook that needs it.
// Database rules require auth !== null; if onValue is called before sign-in
// completes, the read is rejected and the listener stays dead (it does not
// auto-retry on permission errors). Every data hook below gates its effect
// on this so the listener registers (or re-registers) once auth is live.
// Initial state reads auth.currentUser synchronously — covers the case where
// IndexedDB still has a cached anonymous credential (the regular Safari path).
function useAuthReady() {
  const [ready, setReady] = useState(() => !!auth.currentUser);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => setReady(!!user));
    return () => unsub();
  }, []);
  return ready;
}

// Legacy data: earlier versions stored products as { items: [...] } at /products.
// We migrate that on first read into per-id nodes so existing data isn't lost.
function useProducts() {
  const authReady = useAuthReady();
  const [products, setProducts] = useState([]);

  useEffect(() => {
    if (!authReady) return;
    const productsRef = ref(database, "products");
    const unsub = onValue(productsRef, (snap) => {
      const data = snap.val();
      if (!data) { setProducts([]); return; }

      // Legacy shape: { items: [...] } written by old useFirebaseState code.
      // Only migrate if items is a non-empty array AND contains valid products.
      // CRITICAL: never write to Firebase unless validItems.length > 0 — an
      // empty patch of just { items: null } would wipe the entire products node.
      if (data.items && Array.isArray(data.items) && data.items.length > 0) {
        const validItems = data.items.filter(p => p && p.id && p.name);
        if (validItems.length > 0) {
          const patch = { items: null };
          for (const p of validItems) patch[p.id] = p;
          update(productsRef, patch).catch(err => console.warn("Product migration failed:", err));
          setProducts(validItems);
        }
        // If validItems is empty, do NOT write anything — silently skip.
        return;
      }

      // Per-id shape: only include objects that look like real products.
      // filter(Boolean) alone is not enough — Firebase can deserialise a stored
      // array as a plain object {"0":{...},"1":{...}} which passes Boolean but
      // is not a product. Requiring id + name excludes all such artefacts.
      const arr = Object.values(data).filter(v => v && typeof v === "object" && v.id && v.name);
      setProducts(arr);
    }, (err) => {
      console.warn("Firebase read error on /products:", err);
    });
    return () => unsub();
  }, [authReady]);

  return products;
}

// ─── SKU + BARCODE AUTO-GENERATION (POS Phase 2) ─────────────────────────────
// Reserves the next sequential SKU + barcode for a new product. Both counters
// live at /products_meta and are advanced together inside a single
// runTransaction so two concurrent add-product calls can't collide on the
// same number. Today they march in lockstep (product 0001 → barcode 00000001).
// A future size-level barcode feature will advance the barcode counter per
// (product, size) while SKU continues advancing per product, so the two
// counters are tracked independently even though they currently increment
// together. See SCHEMA.md for the /products_meta layout.
//
// Atomicity caveat: the transaction reserves the number atomically, but the
// subsequent /products/{id} write is a separate operation. If that write
// fails (network drop after the transaction commits) the counter has already
// advanced and the SKU/barcode pair is "burned" — i.e. there'll be a gap in
// the sequence. Gaps are acceptable; the alternative (decrementing the
// counter on failure) is racy and worse. Burns are logged for visibility.
const SKU_MAX     =     9999; // 4-digit zero-padded ceiling
const BARCODE_MAX = 99999999; // 8-digit zero-padded ceiling

async function reserveNextSkuAndBarcode() {
  const metaRef = ref(database, "products_meta");
  let reserved = null;
  const tx = await runTransaction(metaRef, (current) => {
    const lastSku     = (current && typeof current.lastSku     === "number") ? current.lastSku     : 0;
    const lastBarcode = (current && typeof current.lastBarcode === "number") ? current.lastBarcode : 0;
    const nextSku     = lastSku     + 1;
    const nextBarcode = lastBarcode + 1;
    if (nextSku     > SKU_MAX)     { reserved = { error: "SKU counter exhausted (max 9999). Contact admin to expand width." };       return; /* abort */ }
    if (nextBarcode > BARCODE_MAX) { reserved = { error: "Barcode counter exhausted (max 99999999). Contact admin to expand width." }; return; /* abort */ }
    reserved = {
      sku:     String(nextSku).padStart(4, "0"),
      barcode: String(nextBarcode).padStart(8, "0"),
    };
    // Preserve any other fields someone has added to /products_meta in the
    // future — only overwrite the two counter keys we own.
    return { ...(current || {}), lastSku: nextSku, lastBarcode: nextBarcode };
  });
  if (!tx.committed) {
    // Transaction was aborted by `return;` (exhaustion) — surface the message.
    throw new Error(reserved?.error || "SKU/barcode reservation aborted.");
  }
  return reserved; // { sku, barcode }
}

function addProductToFirebase(product) {
  if (!product || !product.id || !product.name) {
    console.warn("addProductToFirebase: refusing to write invalid product", product);
    return Promise.reject(new Error("Invalid product payload"));
  }
  // Errors must propagate to the caller — addProduct relies on this rejecting
  // when the /products/{id} write fails so the catch block runs (otherwise
  // a failed write would silently burn the reserved sku/barcode pair AND
  // clear the form as if save succeeded).
  return set(ref(database, `products/${product.id}`), product)
    .catch(err => { console.warn("Add product failed:", err); throw err; });
}

function deleteProductFromFirebase(id) {
  return remove(ref(database, `products/${id}`))
    .catch(err => console.warn("Delete product failed:", err));
}

function updateProductName(id, newName) {
  if (!id || !newName.trim()) return Promise.resolve();
  return update(ref(database, `products/${id}`), { name: newName.trim() })
    .catch(err => console.warn("updateProductName failed:", err));
}

function updateProductSizes(id, sizes) {
  if (!id) return Promise.resolve();
  return update(ref(database, `products/${id}`), { sizes })
    .catch(err => console.warn("updateProductSizes failed:", err));
}

// Canonical clothing size order. Clothing products use the same `sizes`
// array shape as sneakers — letter sizes for tops, numeric WAIST sizes for bottoms.
const CLOTHING_SIZES = ["S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
// Bottoms/pants breakdown — numeric waist sizes. A SECOND clothing size set: bottoms
// are still productType "clothing" (same routing/hubs/no-shoebox), they just use this
// waist breakdown instead of letters. The two sets are DISJOINT, so a product's size
// family is inferable from its stored sizes (see clothingChoicesFor).
const BOTTOMS_SIZES = ["28", "30", "32", "34", "36", "38", "40"];
// True when every stored size is a waist size → this clothing product is bottoms.
const isWaistSizeSet = (sizes) =>
  Array.isArray(sizes) && sizes.length > 0 && sizes.every(s => BOTTOMS_SIZES.includes(String(s)));
// The size choices for a CLOTHING product: waist set for bottoms, letters otherwise.
const clothingChoicesFor = (sizes) => (isWaistSizeSet(sizes) ? BOTTOMS_SIZES : CLOTHING_SIZES);

// Phase 14A: products can belong to multiple hubs. New shape is `hubs: [...]`,
// values from { "hub1", "hub2", "hub3" }. Legacy products only have a single
// `hub` string; getProductHubs unifies both shapes so call sites stay agnostic
// (no data migration needed). Pine view (Hub 3) ships in Phase 14B.
// Trial: "hubC" (Hub C) is a warehouse destination for customer clothing
// orders. It is NOT a product-tagging hub — clothing customer orders route here
// regardless of the product's `hubs`, so hubC never appears in getProductHubs /
// the product editor. To retire the trial, drop hubC here and the few hubC
// branches in AssistantView.placeOrders + WarehouseView.
const HUB_LABELS = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", hubC: "Hub C" };
function getProductHubs(product) {
  return product?.hubs || (product?.hub ? [product.hub] : []);
}

// inferProductType, dedupeByOrderNumber, returnedOrderNumberSet,
// excludeReturnedOrderNumbers + oosEventsForPeriod now live in ./utils/insights
// (single definition, unit-testable). Imported at the top of this file.

function updateProductHubs(id, hubs) {
  if (!id) return Promise.resolve();
  return update(ref(database, `products/${id}`), { hubs })
    .catch(err => console.warn("updateProductHubs failed:", err));
}

// NOTE: product-level depletion *blocking* (Phase 15 — `depletedAt`/`depletedBy`
// flagging a product blurred + un-orderable, the Depleted Products view, and
// "Bring Live") was RETIRED. A "stock depleted" refill resolution now only
// resolves the order task and feeds Insights (insights_log action
// "stock_depleted" + the Insights → Stock Depleted tab). Products are always
// live & orderable. Any legacy `depletedAt` left on a product is inert.

// ─── ORDERS HOOK + DIRECT FIREBASE WRITES ────────────────────────────────────
// Orders are stored at /orders/{orderId} so each order is its own node — that
// way two devices mutating different orders (or the same one) never clobber
// each other. Each component does its own update() against the specific path
// instead of replacing the whole list.
//
// Legacy data: earlier versions stored orders as { items: [...] } at /orders.
// We migrate that on first read into per-id nodes so existing data isn't lost.
function useOrders() {
  const authReady = useAuthReady();
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    if (!authReady) return;
    const ordersRef = ref(database, "orders");
    const unsub = onValue(ordersRef, (snap) => {
      const data = snap.val();
      if (!data) {
        setOrders([]);
        return;
      }
      // Legacy shape detected — migrate.
      if (Array.isArray(data.items)) {
        // Use update() not set() so we don't clobber any per-id orders that
        // may have just been written by another device. items: null clears
        // the legacy array; each order gets a node at /orders/{id}.
        const patch = { items: null };
        for (const o of data.items) {
          if (o && o.id) patch[o.id] = o;
        }
        update(ordersRef, patch).catch((err) => {
          console.warn("Order migration write failed:", err);
        });
        const arr = data.items.slice().sort((a, b) =>
          (b?.createdAt || "").localeCompare(a?.createdAt || "")
        );
        setOrders(arr);
        return;
      }
      // Normal shape: map of id → order. Convert to sorted array.
      const arr = Object.values(data)
        .filter(Boolean)
        .sort((a, b) => (b?.createdAt || "").localeCompare(a?.createdAt || ""));
      setOrders(arr);
    }, (err) => {
      console.warn("Firebase read error on /orders:", err);
    });
    return () => unsub();
  }, [authReady]);

  return orders;
}

// Write a brand-new order. Used by AssistantView.
function writeOrder(order) {
  return set(ref(database, `orders/${order.id}`), order).catch((err) => {
    console.warn("Firebase writeOrder failed:", err);
  });
}

// Patch a single order. Used by WarehouseView and DisplayView.
// Writes only the changed fields directly to /orders/{id} — no array
// replacement, no race with concurrent writes to other orders.
function updateOrder(id, patch) {
  return update(ref(database, `orders/${id}`), patch).catch((err) => {
    console.warn(`Firebase updateOrder(${id}) failed:`, err);
  });
}

// ─── INSIGHTS LOG ────────────────────────────────────────────────────────────
// Permanently appended — never deleted. Each entry is pushed to /insights_log
// with a Firebase-generated chronological key.
function logInsight(entry) {
  push(ref(database, "insights_log"), entry)
    .catch(err => console.warn("logInsight failed:", err));
}

function useInsightsLog() {
  const authReady = useAuthReady();
  const [log, setLog] = useState([]);
  useEffect(() => {
    if (!authReady) return;
    const unsub = onValue(ref(database, "insights_log"), snap => {
      const data = snap.val();
      if (!data) { setLog([]); return; }
      setLog(
        Object.values(data)
          .filter(Boolean)
          .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
      );
    });
    return () => unsub();
  }, [authReady]);
  return log;
}

// ─── SOUTH AFRICA TIME HELPERS ────────────────────────────────────────────────
function getSADateString() {
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function getSAHour() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).getUTCHours();
}

// Parses "YYYY-MM-DD" as a local-time Date (avoids UTC-parse gotcha).
function dateStrToLocal(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toKey(str) {
  return (str || "").replace(/[.#$[\]/\s]/g, "_");
}

// ─── INSIGHTS AGGREGATION HELPERS (Phase 13A integrity pass) ─────────────────
// Two corrections applied uniformly across every "fulfilment-side" Insights
// tab (Overview · Net Sales / Out of Stock, Sales Summary, OOS Tracker) AND
// the AI Reorder Planner backend. Both helpers are pure and operate on
// whatever pre-window-filtered slice the caller passes — so a tab scopes to
// its date window first, then dedupes / excludes (cheap on a small slice).
//
// IMPORTANT: orderNumber is daily-scoped at Marathon — staff write a 3-digit
// number (001–999) on each product and the counter RESETS every morning.
// Two unrelated orders on different days can share orderNumber "001".
// Therefore every uniqueness key in this file is the composite
// `${SA-date}::${orderNumber}`, NOT orderNumber alone.
//
// 1. dedupeByOrderNumber — keep the EARLIEST event per (date, orderNumber).
//    An order whose ready / out_of_stock / placed transition was flipped
//    (Undo → re-do via the warehouse UI) writes multiple log entries with
//    the same orderNumber on the same day. Without dedupe, the live-order
//    count for today drifts away from the historical log count.
//
// 2. excludeReturnedOrderNumbers — drop every event whose (date, orderNumber)
//    composite matches a return for the same window. Returns carry their own
//    `date` field; that's used directly.
//
// Size Popularity intentionally does NOT call excludeReturnedOrderNumbers:
// it measures DEMAND at checkout time (action === "placed"), and a later
// return doesn't retroactively erase the customer's expressed intent. It
// still calls dedupeByOrderNumber so multi-fire placed events (rare but
// possible) don't inflate the histogram.

// saDateOf / composite-key / dedupeByOrderNumber / returnedOrderNumberSet /
// excludeReturnedOrderNumbers moved to ./utils/insights (imported above).

// ─── DAY-GROUPED COLLAPSIBLE (Phase 10) ───────────────────────────────────────
// Reusable across Warehouse queue / Display Refills / Returns. Buckets items
// into Today / Yesterday / 2 days ago (SA timezone), with an optional Older
// catch-all. Visual language mirrors the existing On Hold panel exactly —
// blue title, blue pill badge, blue chevron. Open state persists per
// sectionKey in sessionStorage; default: Today open, others closed.
//
// Props:
//   sectionKey   — string, used as the sessionStorage key for open state
//   items        — array of items to bucket
//   dateOf       — (item) => ISO timestamp string, used to compute the bucket
//   renderItem   — (item) => ReactNode for the row body
//   emptyMessage — string shown when all buckets are empty
//   includeOlder — when true, items older than 2-days-ago land in an "Older"
//                  bucket (default collapsed). When false, they're dropped.
function DayCollapsible({ sectionKey, items, dateOf, renderItem, emptyMessage, includeOlder = false }) {
  // Read initial open state from sessionStorage. Default: today open, rest closed.
  const STORAGE_KEY = `dayCollapsible:${sectionKey}`;
  const [openMap, setOpenMap] = useState(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through */ }
    return { today: true, yesterday: false, twoDays: false, older: false };
  });
  const toggle = (key) => setOpenMap(prev => {
    const next = { ...prev, [key]: !prev[key] };
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  // Bucket items. Date comparisons use SA-time YYYY-MM-DD slices.
  const today     = getSADateString();
  const yesterday = getSAPastDateString(1);
  const twoDays   = getSAPastDateString(2);
  const buckets = { today: [], yesterday: [], twoDays: [], older: [] };
  (items || []).forEach(item => {
    const iso = dateOf(item);
    if (!iso) return;
    // SA-time date string: shift by +2h before slicing — same convention as
    // orderSaleDate / orderOOSDate elsewhere in the file.
    const saDate = new Date(new Date(iso).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if      (saDate === today)     buckets.today.push(item);
    else if (saDate === yesterday) buckets.yesterday.push(item);
    else if (saDate === twoDays)   buckets.twoDays.push(item);
    else if (includeOlder)         buckets.older.push(item);
    // else: drop (>3 days old and includeOlder=false)
  });

  const sections = [
    { key:"today",     label:"Today",        items: buckets.today },
    { key:"yesterday", label:"Yesterday",    items: buckets.yesterday },
    { key:"twoDays",   label:"2 days ago",   items: buckets.twoDays },
  ];
  if (includeOlder) sections.push({ key:"older", label:"Older", items: buckets.older });

  const totalShown = sections.reduce((n, s) => n + s.items.length, 0);
  if (totalShown === 0) {
    return (
      <div style={{ textAlign:"center", color:"#444", padding:"3rem 1rem", fontSize:"0.95rem" }}>
        {emptyMessage || "Nothing to show."}
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {sections.map(s => {
        if (s.items.length === 0) return null;
        const open = !!openMap[s.key];
        return (
          <div key={s.key} style={{ background:"rgba(20,40,100,.3)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, overflow:"hidden" }}>
            <div onClick={() => toggle(s.key)}
                 style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 14px", cursor:"pointer" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#4A7FFF", letterSpacing:"0.3px" }}>{s.label}</div>
                <div style={{ background:"rgba(60,110,255,.15)", color:"#4A7FFF", border:"1px solid rgba(60,110,255,.3)", borderRadius:999, padding:"2px 10px", fontSize:11, fontWeight:700 }}>
                  {s.items.length}
                </div>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                   style={{ transition:"transform 150ms ease", transform: open ? "rotate(180deg)" : "rotate(0deg)", flexShrink:0 }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
            <div style={{ maxHeight: open ? 5000 : 0, overflow:"hidden", transition:"max-height 150ms ease" }}>
              <div style={{ borderTop:"1px solid rgba(60,110,255,.1)", padding:"10px 8px 12px", display:"flex", flexDirection:"column", gap:10 }}>
                {s.items.map((item, i) => (
                  <div key={dateOf(item) ? `${dateOf(item)}-${i}` : i}>
                    {renderItem(item)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── RESTOCK LOG + REQUESTS ───────────────────────────────────────────────────
// Every OOS event is permanently logged. Never deleted.
// Returns a Promise — callers await this before updating UI so the log write
// completes before the order status changes.
async function logRestock(entry) {
  return push(ref(database, `restock_log/${entry.date}`), entry);
}

// Normalizes a Source response leaf to { response, respondedOn } | null.
// Legacy entries are bare strings ("available"/"out_of_stock"); new entries
// are objects { response, respondedOn }. Always read via this shim.
function normalizeSourceResponse(v) {
  if (v == null) return null;
  if (typeof v === "string") return { response: v, respondedOn: null };
  if (typeof v === "object" && typeof v.response === "string") {
    return { response: v.response, respondedOn: v.respondedOn || null };
  }
  return null;
}

// Live listener for all Source responses.
// Shape on read: { "YYYY-MM-DD": { productKey: { size: { response, respondedOn } } } }
// Old compiled nodes (with createdAt/date/products keys) are filtered out gracefully.
function useAllSourceResponses() {
  const authReady = useAuthReady();
  const [responses, setResponses] = useState({});
  useEffect(() => {
    if (!authReady) return;
    const unsub = onValue(ref(database, "restock_requests"), snap => {
      const data = snap.val() || {};
      const result = {};
      Object.entries(data).forEach(([date, dateNode]) => {
        if (!dateNode || typeof dateNode !== "object") return;
        result[date] = {};
        Object.entries(dateNode).forEach(([key, val]) => {
          // Skip old compiled-format artifact keys
          if (key === "createdAt" || key === "date" || key === "products") return;
          if (typeof val !== "object" || val === null) return;
          const sizes = {};
          Object.entries(val).forEach(([size, raw]) => {
            const norm = normalizeSourceResponse(raw);
            if (norm) sizes[size] = norm;
          });
          if (Object.keys(sizes).length) result[date][key] = sizes;
        });
      });
      setResponses(result);
    });
    return () => unsub();
  }, [authReady]);
  return responses;
}

// Saves Source's Available / OOS response for a product size on a given date.
// Path: restock_requests/{date}/{productKey}/{size}
// `date` is the request's ORIGINAL day (today for Today's Request, day-N for
// History stragglers). `respondedOn` is always now — that field is the
// "stamp with today's date" the warehouse-response model needs.
function saveSourceResponse(date, productKey, size, response) {
  update(ref(database, `restock_requests/${date}/${productKey}`), {
    [size]: { response, respondedOn: new Date().toISOString() }
  }).catch(err => console.warn("saveSourceResponse failed:", err));
}

// Reverses a Source response — removes the single (size) leaf so the cell
// returns to the active pending list. Used by Undo on a completed card.
function clearSourceResponse(date, productKey, size) {
  return remove(ref(database, `restock_requests/${date}/${productKey}/${size}`))
    .catch(err => console.warn("clearSourceResponse failed:", err));
}

// Raw OOS log for today — real-time stream, no compilation needed.
function useRestockLogRaw(date) {
  const authReady = useAuthReady();
  const [entries, setEntries] = useState([]);
  useEffect(() => {
    if (!authReady || !date) return;
    const unsub = onValue(ref(database, `restock_log/${date}`), snap => {
      const data = snap.val();
      if (!data) { setEntries([]); return; }
      setEntries(Object.values(data).filter(Boolean));
    });
    return () => unsub();
  }, [authReady, date]);
  return entries;
}

// Compute { productKey: { productName, photo, sizes: { size: count } } } from raw OOS entries.
function computeRestockCounts(entries) {
  const result = {};
  (entries || []).forEach(entry => {
    const key = toKey(entry.productName);
    if (!result[key]) result[key] = { productName: entry.productName, photo: entry.photo || "", photoUrl: entry.photoUrl || null, sizes: {} };
    if (entry.photoUrl && !result[key].photoUrl) result[key].photoUrl = entry.photoUrl;
    if (entry.size) result[key].sizes[entry.size] = (result[key].sizes[entry.size] || 0) + 1;
  });
  return result;
}

// Tracks product-name collisions we've already warned about, so the warning
// fires once per distinct collision rather than every render.
const _seenKeyCollisions = new Set();

// Derive { productKey: { productName, photo, photoUrl, sizes: { size: count } } }
// directly from an array of COLLECTED order objects.
// This is the authoritative source for refill requests — no Firebase log needed.
//
// Source-only behavior: when an order has sentSize (warehouse substituted a size
// at fulfillment), bucket by sentSize, not order.size. Source's job is to
// restock the size physically pulled from inventory, not the requested one.
// The original order.size is preserved on the order for audit / dispute trail.
function computeCollectedCounts(collectedOrders) {
  const result = {};
  (collectedOrders || []).forEach(order => {
    const key = toKey(order.productName);
    if (!result[key]) {
      result[key] = { productName: order.productName, photo: order.productPhoto || "", photoUrl: order.productPhotoUrl || null, sizes: {} };
    } else if (result[key].productName !== order.productName) {
      // Two distinct product names collapsed to the same key (toKey strips spaces, ., #, $, [, ], /).
      // This breaks Source: their responses share the same restock_requests path and they
      // render with duplicate React keys. Rename one of the products to fix.
      const collisionId = `${key}::${result[key].productName}::${order.productName}`;
      if (!_seenKeyCollisions.has(collisionId)) {
        _seenKeyCollisions.add(collisionId);
        console.warn(`[Source] Product name collision: "${result[key].productName}" and "${order.productName}" both map to key "${key}". Rename one product to avoid lost Available/OOS responses.`);
      }
    }
    if (order.productPhotoUrl && !result[key].photoUrl) result[key].photoUrl = order.productPhotoUrl;
    const displaySize = sourceDisplaySize(order);
    if (displaySize) result[key].sizes[displaySize] = (result[key].sizes[displaySize] || 0) + 1;
  });
  return result;
}

// Returns the SA-timezone YYYY-MM-DD date for an order's collected/updated timestamp.
function orderCollectedDate(order) {
  const ts = order.collectedAt || order.updatedAt;
  if (!ts) return null;
  return new Date(new Date(ts).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Returns the SA-timezone YYYY-MM-DD date the warehouse marked the order READY.
// Source uses this so its "Today's Request" matches Net Sales exactly:
// both count items that hit READY on a specific day.
// STRICT: returns null if readyAt is missing. NO FALLBACK to collectedAt/updatedAt
// because that lets in orders edited today for unrelated reasons. Legacy orders
// without readyAt simply won't appear in today's Source — which is correct,
// since we can't prove they were marked Ready today.
function orderReadyDate(order) {
  if (!order.readyAt) return null;
  return new Date(new Date(order.readyAt).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Canonical "ready/collected on date X" — earliest of readyAt and collectedAt,
// returned as a SA-time YYYY-MM-DD string. Null if neither timestamp exists.
// Used by Source "Today's Request" and Insights Net Sales (day mode) so both
// derive from the same live-order field, not the append-only insights_log
// (which keeps phantom events when orders are flipped, edited, or deleted).
function orderSaleDate(order) {
  const r = order.readyAt     ? new Date(order.readyAt).getTime()     : null;
  const c = order.collectedAt ? new Date(order.collectedAt).getTime() : null;
  const ts = (r && c) ? Math.min(r, c) : (r || c);
  if (!ts) return null;
  return new Date(ts + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// (orderOOSDate removed — its only callers were the live-orders "today" OOS
// branches in the Overview card + OOS Tracker, now replaced by oosEventsForPeriod
// which counts from insights_log. orderSaleDate above stays — Net Sales uses it.)

// Set of orderNumbers returned on a specific SA day. Used by Source to net
// out returns from its restock pull list, mirroring the same-period
// returnedNums Set the Insights Net Sales card builds inline.
function returnedOrderIdsOnSADate(returnsLog, saDate) {
  const set = new Set();
  (returnsLog || []).forEach(r => {
    if (!r.orderNumber || !r.timestamp) return;
    const d = new Date(new Date(r.timestamp).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (d === saDate) set.add(r.orderNumber);
  });
  return set;
}

// Composite "this exact order was returned" lookup — `${SA-date}::${orderNumber}`.
// orderNumber is DAILY-SCOPED (it resets each day), so a bare all-time set of
// returned numbers wrongly flags today's freshly-SOLD #001 as returned just
// because some PAST day's #001 was returned. Keying by the return's own SA-date
// (same basis as returnedOrderIdsOnSADate above) and matching on the order side
// via orderSaleDate(o) confines each match to a single day. Returns intact —
// this only changes how the Returns view READS the log, never what it writes.
function returnedCompositeKeySet(returnsLog) {
  const set = new Set();
  (returnsLog || []).forEach(r => {
    if (!r.orderNumber || !r.timestamp) return;
    const d = new Date(new Date(r.timestamp).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
    set.add(`${d}::${r.orderNumber}`);
  });
  return set;
}

// Reads the entire restock_log across ALL dates.
// Returns { "YYYY-MM-DD": { pushKey: entry, ... }, ... }
function useRestockLogAll() {
  const authReady = useAuthReady();
  const [log, setLog] = useState({});
  useEffect(() => {
    if (!authReady) return;
    const unsub = onValue(ref(database, "restock_log"), snap => {
      setLog(snap.val() || {});
    });
    return () => unsub();
  }, [authReady]);
  return log;
}

// ─── RETURNS LOG ─────────────────────────────────────────────────────────────
function logReturn(entry) {
  push(ref(database, "returns_log"), entry)
    .catch(err => console.warn("logReturn failed:", err));
}

function useReturnsLog() {
  const authReady = useAuthReady();
  const [log, setLog] = useState([]);
  useEffect(() => {
    if (!authReady) return;
    const unsub = onValue(ref(database, "returns_log"), snap => {
      const data = snap.val();
      if (!data) { setLog([]); return; }
      setLog(Object.values(data).filter(Boolean)
        .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "")));
    });
    return () => unsub();
  }, [authReady]);
  return log;
}

// ─── CUSTOMER DATABASE ────────────────────────────────────────────────────────
// Customers keyed by normalised phone number (digits only).
function phoneToKey(phone) {
  return (phone || "").replace(/\D/g, "") || "unknown";
}

// Upsert a customer record when an order is placed.
// Only sets optedIn: true — never reverts an existing true back to false.
function upsertCustomer(phone, name, orderedAt, optedIn) {
  const key = phoneToKey(phone);
  if (key === "unknown") return;
  const cRef = ref(database, `customers/${key}`);
  get(cRef).then(snap => {
    const existing = snap.val() || {};
    const patch = {
      phone,
      name: name || existing.name || "",
      firstOrderAt: existing.firstOrderAt || orderedAt,
      lastOrderAt: orderedAt,
      orderCount: (existing.orderCount || 0) + 1,
    };
    if (optedIn) patch.optedIn = true;
    update(cRef, patch);
  }).catch(err => console.warn("upsertCustomer failed:", err));
}

function setCustomerOptIn(phone, optedIn) {
  const key = phoneToKey(phone);
  if (key === "unknown") return;
  update(ref(database, `customers/${key}`), { optedIn, phone })
    .catch(err => console.warn("setCustomerOptIn failed:", err));
}

function useCustomersDb() {
  const authReady = useAuthReady();
  const [customers, setCustomers] = useState({});
  useEffect(() => {
    if (!authReady) return;
    const unsub = onValue(ref(database, "customers"), snap => {
      setCustomers(snap.val() || {});
    });
    return () => unsub();
  }, [authReady]);
  return customers;
}

// Customer index for the Assistant order-entry autocomplete. Derived from
// insights_log (where past customer name + phone + timestamp actually live —
// `/customers` only stores opt-in flags). Returns one entry per distinct
// phone with the most-recent name, total order count (action="placed"), and
// the last-order ISO. Cheap O(N) once over the log.
function useCustomerIndex() {
  const log = useInsightsLog();
  return useMemo(() => {
    const byPhone = new Map();
    for (const e of log) {
      const phone = (e?.customerPhone || "").trim();
      if (!phone || !e.customerName) continue;
      let rec = byPhone.get(phone);
      if (!rec) {
        rec = { name: e.customerName, phone, orderCount: 0, lastOrderAt: "" };
        byPhone.set(phone, rec);
      }
      if (e.action === "placed") rec.orderCount += 1;
      // Keep the most recent name variant in case the customer's spelling
      // drifted over time.
      if ((e.timestamp || "") > (rec.lastOrderAt || "")) {
        rec.lastOrderAt = e.timestamp || "";
        if (e.customerName) rec.name = e.customerName;
      }
    }
    return Array.from(byPhone.values());
  }, [log]);
}

// Match against the customer index. `mode` picks the field to prefix-match.
// Returns up to 5 hits, newest first. Empty query → empty list.
function matchCustomers(customers, query, mode) {
  const q = (query || "").trim();
  if (!q) return [];
  const hits = [];
  if (mode === "phone") {
    // Match on national significant digits so a typed local "0…" query finds
    // customers stored in international "+27…" form (and vice-versa).
    const needle = saSignificantDigits(q);
    if (!needle) return [];
    for (const c of customers) {
      if (saSignificantDigits(c.phone).startsWith(needle)) hits.push(c);
    }
  } else {
    const needle = q.toLowerCase();
    for (const c of customers) {
      if ((c.name || "").toLowerCase().startsWith(needle)) hits.push(c);
    }
  }
  hits.sort((a, b) => (b.lastOrderAt || "").localeCompare(a.lastOrderAt || ""));
  return hits.slice(0, 5);
}

// Floating dropdown rendered absolutely under an input. `onPick` receives
// the chosen customer; `onAddNew` is the manual-entry escape hatch.
function CustomerSuggestionDropdown({ query, mode, customers, onPick, onAddNew }) {
  const matches = matchCustomers(customers, query, mode);
  if (!query || query.trim().length === 0) return null;
  return (
    <div style={{
      position:"absolute", left:0, right:0, top:"calc(100% + 4px)",
      background:"#11162A", border:"1px solid rgba(60,110,255,.25)",
      borderRadius:12, boxShadow:"0 6px 24px rgba(0,0,0,.45)",
      zIndex:1100, overflow:"hidden",
    }}>
      {matches.map((c, i) => (
        <div key={c.phone}
             onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
             style={{
               padding:"10px 14px", cursor:"pointer",
               borderBottom:"1px solid rgba(255,255,255,.05)",
               background: "transparent",
             }}>
          <div style={{ fontSize:14, fontWeight:500, color:"#fff" }}>{c.name}</div>
          <div style={{ fontSize:12, color:"rgba(255,255,255,.5)", marginTop:2 }}>
            {c.phone} · {c.orderCount} past order{c.orderCount === 1 ? "" : "s"}
          </div>
        </div>
      ))}
      <div onMouseDown={(e) => { e.preventDefault(); onAddNew(); }}
           style={{
             padding:"10px 14px", cursor:"pointer",
             fontSize:13, color:"#4A7FFF", fontWeight:500,
             background: matches.length > 0 ? "rgba(60,110,255,.04)" : "transparent",
           }}>
        + Add new customer "{query.trim()}"
      </div>
    </div>
  );
}

function useBroadcastHistory() {
  const authReady = useAuthReady();
  const [broadcasts, setBroadcasts] = useState([]);
  useEffect(() => {
    if (!authReady) return;
    const unsub = onValue(ref(database, "broadcasts"), snap => {
      const data = snap.val();
      if (!data) { setBroadcasts([]); return; }
      setBroadcasts(Object.values(data).filter(Boolean)
        .sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || "")));
    });
    return () => unsub();
  }, [authReady]);
  return broadcasts;
}

function saveBroadcast(record) {
  push(ref(database, "broadcasts"), record)
    .catch(err => console.warn("saveBroadcast failed:", err));
}

// Phase 3 (Group Broadcast). Distinct from useBroadcastHistory above, which
// tracks per-customer template sends. This one reads /broadcastHistory and
// powers the Recent Broadcasts list in BroadcastGroupsView. Returns up to 10
// most recent records sorted by timestamp desc.
function useGroupBroadcastHistory() {
  const authReady = useAuthReady();
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (!authReady) return;
    const unsub = onValue(ref(database, "broadcastHistory"), snap => {
      const data = snap.val();
      if (!data) { setItems([]); return; }
      setItems(Object.entries(data)
        .map(([id, v]) => ({ id, ...(v || {}) }))
        .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
        .slice(0, 10));
    });
    return () => unsub();
  }, [authReady]);
  return items;
}

// ─── ORDER NUMBER COUNTER ─────────────────────────────────────────────────────
// Cycles 001 → 999 → 001, resets at midnight. Uses a Firebase transaction so
// two devices placing orders at the same time get unique numbers.
function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

async function getNextOrderNumber() {
  const todayKey = getTodayKey();
  const counterRef = ref(database, "orderCounter");
  const txResult = await runTransaction(counterRef, (current) => {
    if (!current || current.day !== todayKey) {
      return { day: todayKey, counter: 1 };
    }
    const next = current.counter >= 999 ? 1 : current.counter + 1;
    return { day: todayKey, counter: next };
  });
  const counter = txResult.snapshot.val()?.counter ?? 1;
  return String(counter).padStart(3, "0");
}

// ─── CUSTOMERS VIEW ───────────────────────────────────────────────────────────
const CUSTOMERS_SESSION_KEY = "customersAuth";

function CustomersView({ onExit }) {
  // ── Auth gate (sessionStorage so refresh doesn't re-ask) ──
  const [authed, setAuthed] = useState(() => sessionStorage.getItem(CUSTOMERS_SESSION_KEY) === "true");
  const [cpw, setCpw]       = useState("");
  const [cpwError, setCpwError] = useState(false);

  const [tab, setTab] = usePersistedTab("customers", "list");
  const insightsLog  = useInsightsLog();
  const customersDb  = useCustomersDb();
  const broadcasts   = useBroadcastHistory();

  // ── Customer list: deduplicate by phone from insights_log ──
  const customerList = useMemo(() => {
    const byPhone = {};
    insightsLog.filter(e => e.action === "placed").forEach(e => {
      const phone = e.customerPhone || "";
      const key   = phoneToKey(phone) || "unknown";
      if (!byPhone[key]) {
        byPhone[key] = { phone, name: e.customerName || "Unknown", firstOrderAt: e.timestamp, lastOrderAt: e.timestamp, orderCount: 0 };
      } else {
        if (e.timestamp < byPhone[key].firstOrderAt) byPhone[key].firstOrderAt = e.timestamp;
        if (e.timestamp > byPhone[key].lastOrderAt)  byPhone[key].lastOrderAt  = e.timestamp;
      }
      byPhone[key].orderCount++;
    });
    // Merge Firebase opt-in status
    return Object.values(byPhone)
      .map(c => {
        const key = phoneToKey(c.phone);
        const fb  = customersDb[key] || {};
        return { ...c, optedIn: fb.optedIn || false };
      })
      .sort((a, b) => (b.lastOrderAt || "").localeCompare(a.lastOrderAt || ""));
  }, [insightsLog, customersDb]);

  const optedInList = useMemo(() => customerList.filter(c => c.optedIn), [customerList]);

  // ── Broadcast state ──
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [sending, setSending]           = useState(false);
  const [sendResult, setSendResult]     = useState(null);

  const sendBroadcast = async () => {
    if (!broadcastMsg.trim() || !optedInList.length || sending) return;
    setSending(true);
    setSendResult(null);
    let sent = 0;
    for (const c of optedInList) {
      if (!c.phone) continue;
      try {
        await fetch("https://sendwhatsapp-jp3ooc2lya-ew.a.run.app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateName: "marathon_broadcast",
            recipientPhone: c.phone,
            templateParams: [broadcastMsg.trim()],
          }),
        });
        sent++;
      } catch (e) {
        console.warn("Broadcast send failed for", c.phone, e);
      }
    }
    saveBroadcast({ message: broadcastMsg.trim(), sentAt: new Date().toISOString(), recipientCount: sent });
    setSendResult(`Sent to ${sent} customer${sent !== 1 ? "s" : ""}`);
    setBroadcastMsg("");
    setSending(false);
  };

  // ── Search ──
  const [search, setSearch] = useState("");
  const displayList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customerList;
    return customerList.filter(c =>
      (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q)
    );
  }, [customerList, search]);

  const fmt = iso => iso ? new Date(iso).toLocaleDateString([], { day:"numeric", month:"short", year:"numeric" }) : "—";

  const checkCpw = () => {
    if (cpw === "1551") { sessionStorage.setItem(CUSTOMERS_SESSION_KEY, "true"); setAuthed(true); }
    else { setCpwError(true); setTimeout(() => setCpwError(false), 1500); }
  };
  const handleExit = () => { sessionStorage.removeItem(CUSTOMERS_SESSION_KEY); onExit(); };

  if (!authed) return (
    <div style={{ minHeight:"100vh", background:BG, color:"#fff", fontFamily:FONT, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ marginBottom:"0.5rem" }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
      </div>
      <h1 style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"3rem", letterSpacing:"0.05em", margin:"0 0 0.5rem" }}>CUSTOMERS</h1>
      <p style={{ color:"#666", marginBottom:"2rem" }}>Enter password to continue</p>
      <div style={{ display:"flex", gap:"0.75rem", width:"100%", maxWidth:"360px" }}>
        <input type="password" placeholder="Password" value={cpw}
          onChange={e => setCpw(e.target.value)} onKeyDown={e => e.key === "Enter" && checkCpw()}
          style={{ ...inputStyle, flex:1, borderColor:cpwError ? "#F87171" : "rgba(60,110,255,.2)" }} />
        <button onClick={checkCpw} style={{ ...bBlue, padding:"0 1.25rem", fontSize:"1rem" }}>Enter</button>
      </div>
      {cpwError && <div style={{ color:"#F87171", marginTop:"0.75rem", fontSize:"0.9rem" }}>Incorrect password</div>}
      <button onClick={onExit} style={{ ...bGhost, marginTop:"2rem", padding:"0.4rem 1rem" }}>← Back</button>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 10px" }}>
        <div onClick={handleExit} style={{ color:"#4A7FFF", fontSize:13, fontWeight:500, cursor:"pointer" }}>← Exit</div>
        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          <div style={{ fontSize:13, fontWeight:600, color:"#fff" }}>CUSTOMERS</div>
        </div>
        <div style={{ fontSize:10, color:"rgba(255,255,255,.4)" }}>{customerList.length} · {optedInList.length} opt-in</div>
      </div>
      <div style={{ borderBottom:"1px solid rgba(60,110,255,.08)", padding:"0 1.5rem", display:"flex" }}>
        {[["list","Customer List"],["broadcast","Broadcast"]].map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...(tab===k ? ulTabOn : ulTabOff) }}>
            {l}
          </button>
        ))}
      </div>

      <div style={{ padding:"1.5rem" }}>

        {/* ── TAB 1: CUSTOMER LIST ── */}
        {tab === "list" && (
          <div>
            <input placeholder="Search by name or phone…" value={search} onChange={e => setSearch(e.target.value)}
              style={{ ...inputStyle, marginBottom:"1.25rem" }} />
            {displayList.length === 0 ? (
              <div style={{ textAlign:"center", color:"#444", padding:"4rem", fontSize:"0.9rem" }}>
                {customerList.length === 0 ? "No customers yet — orders will appear here." : "No customers match your search."}
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:"0.75rem" }}>
                {displayList.map((c, i) => (
                  <div key={i} style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.1rem 1.25rem", display:"flex", alignItems:"center", gap:"1rem" }}>
                    <div style={{ width:40, height:40, borderRadius:"50%", background:"rgba(60,110,255,.1)", border:BORDER, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"1.1rem", color:BLUE_L, flexShrink:0 }}>
                      {(c.name || "?")[0].toUpperCase()}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:"700", color:"#fff", fontSize:"0.95rem" }}>{c.name}</div>
                      <div style={{ color:"#555", fontSize:"0.78rem" }}>{c.phone || "No phone"}</div>
                      <div style={{ color:"#444", fontSize:"0.72rem", marginTop:"0.2rem" }}>
                        {c.orderCount} order{c.orderCount !== 1 ? "s" : ""} · First: {fmt(c.firstOrderAt)} · Last: {fmt(c.lastOrderAt)}
                      </div>
                    </div>
                    {/* Opt-in toggle */}
                    <label style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"0.25rem", cursor:"pointer", flexShrink:0 }}>
                      <div style={{
                        width:44, height:24, borderRadius:"999px", position:"relative", cursor:"pointer",
                        background: c.optedIn ? BLUE : "#333", transition:"background 0.2s",
                      }} onClick={() => setCustomerOptIn(c.phone, !c.optedIn)}>
                        <div style={{
                          width:18, height:18, borderRadius:"50%", background:"#fff",
                          position:"absolute", top:3, left: c.optedIn ? 23 : 3,
                          transition:"left 0.2s",
                        }} />
                      </div>
                      <span style={{ fontSize:"0.6rem", color: c.optedIn ? BLUE_L : "#444" }}>
                        {c.optedIn ? "Marketing on" : "No marketing"}
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 2: BROADCAST ── */}
        {tab === "broadcast" && (
          <div>
            {/* Opted-in count */}
            <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.25rem 1.5rem", marginBottom:"1.5rem", display:"flex", alignItems:"center", gap:"1rem" }}>
              <div style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"3rem", color:BLUE, lineHeight:1, letterSpacing:"0.05em" }}>{optedInList.length}</div>
              <div>
                <div style={{ fontWeight:"700", color:"#fff" }}>Opted-in customers</div>
                <div style={{ color:"#555", fontSize:"0.8rem" }}>These customers will receive your broadcast</div>
              </div>
            </div>

            {/* Note about template */}
            <div style={{ background:"rgba(60,110,255,.08)", border:"1px solid rgba(60,110,255,.3)", borderRadius:RADIUS, padding:"0.85rem 1rem", marginBottom:"1.25rem", color:"#4A7FFF", fontSize:"0.8rem" }}>
              ⚠️ Broadcasts use WhatsApp template <strong>marathon_broadcast</strong> with your message as the first variable. Create this template in Meta Business Manager to enable sending.
            </div>

            {/* Message compose */}
            <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.25rem", marginBottom:"1rem" }}>
              <div style={{ color:"#888", fontSize:"0.8rem", marginBottom:"0.5rem" }}>Message</div>
              <textarea
                placeholder="Type your broadcast message here…"
                value={broadcastMsg} onChange={e => setBroadcastMsg(e.target.value)}
                rows={4}
                style={{ ...inputStyle, resize:"vertical", fontFamily:"inherit" }}
              />
              <button
                onClick={sendBroadcast}
                disabled={!broadcastMsg.trim() || !optedInList.length || sending}
                style={{
                  marginTop:"0.85rem", width:"100%", padding:"0.85rem",
                  ...(broadcastMsg.trim() && optedInList.length && !sending ? bGreen : bGray),
                  fontSize:"1rem",
                }}>
                {sending ? "Sending…" : `Send to ${optedInList.length} customer${optedInList.length !== 1 ? "s" : ""} →`}
              </button>
              {sendResult && <div style={{ marginTop:"0.65rem", color:"#4ADE80", fontSize:"0.85rem", textAlign:"center" }}>{sendResult}</div>}
            </div>

            {/* Broadcast history */}
            <div style={{ fontWeight:"700", color:"#fff", marginBottom:"0.75rem" }}>Broadcast History</div>
            {broadcasts.length === 0 ? (
              <div style={{ color:"#444", textAlign:"center", padding:"2rem", fontSize:"0.85rem" }}>No broadcasts sent yet</div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:"0.65rem" }}>
                {broadcasts.map((b, i) => (
                  <div key={i} style={{ background:CARD, border:BORDER, borderRadius:"12px", padding:"1rem 1.25rem" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.4rem" }}>
                      <span style={{ color:"#888", fontSize:"0.75rem" }}>
                        {new Date(b.sentAt).toLocaleString([], { day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" })}
                      </span>
                      <span style={{ background:"rgba(60,110,255,.12)", color:BLUE_L, border:BORDER, borderRadius:"999px", padding:"1px 8px", fontSize:"0.72rem", fontWeight:"600" }}>
                        {b.recipientCount} sent
                      </span>
                    </div>
                    <div style={{ color:"#ccc", fontSize:"0.87rem" }}>{b.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ROLE SELECTOR ────────────────────────────────────────────────────────────
// ── Role icon SVGs (match HTML design exactly) ─────────────────────────────
const RoleIcons = {
  stock: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9h18M3 15h18"/><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>
    </svg>
  ),
  assistant: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/>
    </svg>
  ),
  warehouse: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>
  ),
  source: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>
    </svg>
  ),
  returns: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
    </svg>
  ),
  insights: (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="#4A7FFF" stroke="none">
      <rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="6" width="4" height="15" rx="1"/><rect x="17" y="9" width="4" height="12" rx="1"/>
    </svg>
  ),
  display: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="16" x2="12" y2="21"/>
    </svg>
  ),
  customer: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="7" r="4"/><path d="M5 21c0-3.866 3.134-7 7-7s7 3.134 7 7"/>
    </svg>
  ),
  customers_db: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
    </svg>
  ),
  admin: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
  broadcast_groups: (
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>
    </svg>
  ),
  user_management: (
    // lucide-style "user + cog": person silhouette with a small adjust-mark to
    // distinguish from the customers_db two-people icon. Same stroke/weight.
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="7" r="4"/>
      <path d="M3 21v-2a4 4 0 0 1 4-4h4"/>
      <circle cx="18" cy="17" r="3"/>
      <path d="m15.5 14.5-1-1"/>
      <path d="m21.5 19.5-1-1"/>
    </svg>
  ),
  ai_reorder: (
    // lucide-style "sparkles": one large four-point star + two small accents.
    // Reads as AI / magic / something-generated, distinct from the bar-chart
    // insights icon (this tile takes you INTO Insights but to a different tab).
    <svg viewBox="0 0 24 24" width="30" height="30" stroke="#4A7FFF" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/>
      <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z"/>
      <path d="M5 14l.6 1.9L7.5 16.5l-1.9.6L5 19l-.6-1.9L2.5 16.5l1.9-.6L5 14z"/>
    </svg>
  ),
};

// Section header svg icons
const GroupIcons = {
  Operations: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" style={{filter:"drop-shadow(0 0 4px rgba(60,110,255,.6))"}}>
      <rect x="2" y="3" width="9" height="9" rx="1"/><rect x="13" y="3" width="9" height="9" rx="1"/><rect x="2" y="13" width="9" height="9" rx="1"/><rect x="13" y="13" width="9" height="9" rx="1"/>
    </svg>
  ),
  "Insights & Display": (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" style={{filter:"drop-shadow(0 0 4px rgba(60,110,255,.6))"}}>
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  ),
  Administration: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" style={{filter:"drop-shadow(0 0 4px rgba(60,110,255,.6))"}}>
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
};

function RoleCard({ icon, name, desc, badge, onClick, last }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? "rgba(255,255,255,.055)" : "rgba(4,5,10,1)",
        padding:"12px 13px",
        display:"flex",
        alignItems:"center",
        gap:"11px",
        cursor:"pointer",
        transition:"all .15s",
        borderBottom: last ? "none" : "1px solid rgba(255,255,255,.04)",
      }}>
      <div style={{ width:52, height:52, borderRadius:14, background:"rgba(8,12,30,.98)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
        {icon}
      </div>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:15, fontWeight:500, color:"rgba(255,255,255,.9)" }}>{name}</div>
        <div style={{ fontSize:11, color:"rgba(255,255,255,.3)", marginTop:1 }}>{desc}</div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        {badge != null && badge !== 0 && (
          <div style={{
            width:28, height:28, borderRadius:"50%",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:11, fontWeight:600,
            background:"rgba(60,110,255,.18)", color:"#6A9FFF",
            boxShadow:"0 0 8px rgba(60,110,255,.3),inset 0 0 6px rgba(60,110,255,.15)",
          }}>{badge}</div>
        )}
        <span style={{ color:"rgba(255,255,255,.18)", fontSize:14 }}>›</span>
      </div>
    </div>
  );
}

function GroupSection({ label, children }) {
  return (
    <div style={{ marginBottom:22 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"0 2px 8px" }}>
        {GroupIcons[label]}
        <span style={{ fontSize:12, fontWeight:800, color:"#4A7FFF", letterSpacing:"2px", textTransform:"uppercase" }}>{label}</span>
        <div style={{ flex:1, height:1, background:"linear-gradient(90deg,rgba(60,110,255,.3),transparent)", marginLeft:4 }}/>
      </div>
      <div style={{ background:"rgba(6,9,20,1)", border:"1px solid rgba(60,110,255,.18)", borderRadius:16, overflow:"hidden", boxShadow:"0 0 24px rgba(60,110,255,.07),0 2px 12px rgba(0,0,0,.4)" }}>
        {children}
      </div>
    </div>
  );
}

function RoleSelector({ onSelect, orders, returnsLog, hasPermission, canAccessStock }) {
  const today = getSADateString();
  const incoming = orders ? orders.filter(o => o.status === STATUS.INCOMING).length : 0;
  // Source badge = today's restock requests + on-hold (Tomorrow), excluding OOS.
  // Today's request = orders marked READY/COLLECTED today (sold/sent items),
  // minus any of those orders that have been returned today (physically back
  // in the warehouse, no restock needed). On hold = COMING_TOMORROW.
  const returnedToday = returnedOrderIdsOnSADate(returnsLog, today);
  const sourceTodayCount = orders ? orders.filter(o =>
    o.status !== STATUS.OUT_OF_STOCK &&
    (o.status === STATUS.READY || o.status === STATUS.COLLECTED) &&
    orderSaleDate(o) === today &&
    !returnedToday.has(o.id)
  ).length : 0;
  const onHold = orders ? orders.filter(o =>
    o.status === STATUS.COMING_TOMORROW && o.status !== STATUS.OUT_OF_STOCK
  ).length : 0;
  const sourceBadge = sourceTodayCount + onHold;
  // assistant badge = today's placed orders
  const assistantBadge = orders ? orders.filter(o =>
    o.createdAt && o.createdAt.slice(0,10) === today
  ).length : 0;

  return (
    <div style={{ minHeight:"100vh", background:"#000", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden" }}>
      {/* MARATHON HERO */}
      <div style={{ position:"relative", height:260, overflow:"hidden" }}>
        <img src="/hero/marathon.jpg" alt="Marathon" style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", objectFit:"contain", objectPosition:"center", zIndex:0 }}/>
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:100, background:"linear-gradient(transparent,#000)", zIndex:1 }}/>
        <div style={{ position:"absolute", top:0, left:0, right:0, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 16px 0", zIndex:5 }}>
          <button style={{ width:34, height:34, borderRadius:"50%", background:"rgba(0,0,0,.5)", backdropFilter:"blur(10px)", border:"none", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="rgba(255,255,255,.65)" fill="none" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <div style={{ display:"flex", gap:7 }}>
            <button style={{ width:34, height:34, borderRadius:"50%", background:"rgba(0,0,0,.5)", backdropFilter:"blur(10px)", border:"none", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="rgba(255,255,255,.65)" fill="none" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </button>
            <button style={{ width:34, height:34, borderRadius:"50%", background:"rgba(0,0,0,.5)", backdropFilter:"blur(10px)", border:"none", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="rgba(255,255,255,.65)" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>
            </button>
          </div>
        </div>
      </div>

      {/* ROLE GROUPS — each tile gated by hasPermission. Empty groups are
          hidden so staff with limited permissions don't see empty headings. */}
      {(() => {
        const ops = [
          hasPermission(ROLE_TO_PERMISSION[ROLES.ASSISTANT]) && <RoleCard key="assistant" icon={RoleIcons.assistant} name="Store Assistant" desc="Place customer orders" badge={assistantBadge}  onClick={() => onSelect(ROLES.ASSISTANT)} />,
          hasPermission(ROLE_TO_PERMISSION[ROLES.WAREHOUSE]) && <RoleCard key="warehouse" icon={RoleIcons.warehouse} name="Warehouse"        desc="Manage order queue"   badge={incoming}        onClick={() => onSelect(ROLES.WAREHOUSE)} />,
          hasPermission(ROLE_TO_PERMISSION[ROLES.SOURCE])    && <RoleCard key="source"    icon={RoleIcons.source}    name="Source"           desc="Restock requests"     badge={sourceBadge}     onClick={() => onSelect(ROLES.SOURCE)} />,
          hasPermission(ROLE_TO_PERMISSION[ROLES.RETURNS])   && <RoleCard key="returns"   icon={RoleIcons.returns}   name="Returns"          desc="Log returned items"   onClick={() => onSelect(ROLES.RETURNS)} />,
          // Open to everyone — reprinting an existing barcode is read-only. Minting
          // a NEW code is gated by stockRole inside the screen.
          <RoleCard key="barcodes" icon={RoleIcons.stock} name="Barcodes" desc="Print product barcodes" onClick={() => onSelect(ROLES.BARCODES)} />,
        ].filter(Boolean);
        const insightsDisplay = [
          hasPermission(ROLE_TO_PERMISSION[ROLES.INSIGHTS]) && <RoleCard key="insights" icon={RoleIcons.insights} name="Internal Insights" desc="Business analytics"    onClick={() => onSelect(ROLES.INSIGHTS)} />,
          hasPermission(ROLE_TO_PERMISSION[ROLES.DISPLAY])  && <RoleCard key="display"  icon={RoleIcons.display}  name="TV Display"        desc="Customer queue screen" onClick={() => onSelect(ROLES.DISPLAY)} />,
          hasPermission(ROLE_TO_PERMISSION[ROLES.CUSTOMER]) && <RoleCard key="customer" icon={RoleIcons.customer} name="Customer"          desc="Check order status"    onClick={() => onSelect(ROLES.CUSTOMER)} />,
        ].filter(Boolean);
        const admin = [
          hasPermission(ROLE_TO_PERMISSION[ROLES.CUSTOMERS_DB])     && <RoleCard key="customers" icon={RoleIcons.customers_db}     name="Customers"       desc="Customer database"       onClick={() => onSelect(ROLES.CUSTOMERS_DB)} />,
          hasPermission(ROLE_TO_PERMISSION[ROLES.ADMIN])            && <RoleCard key="admin"     icon={RoleIcons.admin}            name="Admin"           desc="Manage products"         onClick={() => onSelect(ROLES.ADMIN)} />,
          canAccessStock                                           && <RoleCard key="stock"     icon={RoleIcons.stock}            name="Stock"           desc="Inventory & transfers"   onClick={() => onSelect(ROLES.STOCK)} />,
          hasPermission(ROLE_TO_PERMISSION[ROLES.BROADCAST_GROUPS]) && <RoleCard key="broadcast" icon={RoleIcons.broadcast_groups} name="Group Broadcast" desc="Send to WhatsApp groups" onClick={() => onSelect(ROLES.BROADCAST_GROUPS)} />,
          // User Management is hash-routed (not role-routed) — the screen mounts
          // on wantUserMgmt in the App view cascade. Tap → set hash → mount.
          hasPermission(ROLE_TO_PERMISSION[ROLES.USER_MANAGEMENT]) && <RoleCard key="user_mgmt" icon={RoleIcons.user_management} name="User Management" desc="Manage staff accounts" onClick={() => (window.location.hash = "#admin/users")} />,
          // AI Reorder shortcut: mounts the existing Insights view but pre-selects
          // the "reorder" tab by writing its persistence key first. Gated by the
          // "ai_reorder" permission string — no record grants it explicitly, so
          // only super-admin sees the tile via the usePermissions() bypass.
          // (The Cloud Function's assertAdmin is super-admin-only anyway.)
          hasPermission("ai_reorder") && <RoleCard key="ai_reorder" icon={RoleIcons.ai_reorder} name="AI Reorder" desc="Reorder plan + slow movers" onClick={() => {
            try { localStorage.setItem("tabState:insights", "reorder"); } catch { /* localStorage unavailable; tab will start on overview */ }
            onSelect(ROLES.INSIGHTS);
          }} />,
        ].filter(Boolean);
        // `last` on the final card in each group removes the trailing divider.
        const withLast = (cards) => cards.map((card, i) =>
          i === cards.length - 1 ? <card.type {...card.props} last /> : card
        );
        return (
          <div style={{ padding:"10px 14px 36px", background:"#000" }}>
            {ops.length > 0              && <GroupSection label="Operations">{withLast(ops)}</GroupSection>}
            {insightsDisplay.length > 0  && <GroupSection label="Insights & Display">{withLast(insightsDisplay)}</GroupSection>}
            {admin.length > 0            && <GroupSection label="Administration">{withLast(admin)}</GroupSection>}
            {ops.length + insightsDisplay.length + admin.length === 0 && (
              <div style={{ textAlign:"center", color:"#555", padding:"3rem 1rem", fontSize:14 }}>
                No tools assigned to your account yet. Ask an admin to update your permissions.
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ─── ADMIN VIEW ───────────────────────────────────────────────────────────────
// Sneaker size options (clothing uses CLOTHING_SIZES). Hoisted to module
// scope so both AdminView's Add Product form and AdminProductDetail's size
// editor share the same source of truth.
const SNEAKER_SIZES = ["3","4","5","5.5","6","7","8","9","10","11"];

// `#product/{id}` is the detail-page route. Returns null when the hash is
// anything else (empty, #admin, etc.).
function parseProductHash() {
  const m = (window.location.hash || "").match(/^#product\/(.+)$/);
  return m ? m[1] : null;
}

// ─── AI NAME CLEANUP — REVIEW & APPROVE ───────────────────────────────────────
// Live view of /aiAssistant/nameProposals (written by the cleanProductNames Cloud
// Function — a vision + typed-name merge). The catalogue name changes ONLY when an
// admin approves a row here; nothing auto-applies. Approve writes the (optionally
// edited) suggested name to /products/{id}.name and marks the proposal approved;
// Reject marks it rejected; both decisions stop the row reappearing on a re-run.
function useNameProposals() {
  const [proposals, setProposals] = useState({});
  useEffect(() => {
    const unsub = onValue(ref(database, "aiAssistant/nameProposals"), snap => setProposals(snap.val() || {}));
    return () => unsub();
  }, []);
  return proposals;
}

// ─── AI PHOTO CLEANUP — REVIEW & APPROVE ──────────────────────────────────────
// Side-by-side original vs AI white-background re-shoot (written by the
// generateProductPhotos function to /aiAssistant/photoProposals). Approve swaps the
// product's photoUrl to the white-bg version but KEEPS the original (stored in
// photoUrlOriginal; the original file at products/{id}/photo.jpg is never touched).
// Reject discards. Nothing auto-applies.
function usePhotoProposals() {
  const [proposals, setProposals] = useState({});
  useEffect(() => {
    const unsub = onValue(ref(database, "aiAssistant/photoProposals"), snap => setProposals(snap.val() || {}));
    return () => unsub();
  }, []);
  return proposals;
}

function AdminReviewPhotosTab({ products = [] }) {
  const proposals = usePhotoProposals();
  const [busyId, setBusyId]   = useState(null);
  const [regenIds, setRegenIds] = useState(() => new Set()); // ids currently re-generating (per-row lock)
  const [bulkBusy, setBulkBusy] = useState(false);
  const [runN, setRunN]       = useState(12);
  const [quality, setQuality] = useState("medium");
  const [runBusy, setRunBusy] = useState(false);
  const [runMsg, setRunMsg]   = useState(null);
  const [lightbox, setLightbox] = useState(null);
  // Product picker: choose specific products to generate (multi-select).
  const [picking, setPicking]   = useState(false);
  const [pickSearch, setPickSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  // Products already generated (pending/approved) are excluded so you don't re-pick
  // them; rejected ones stay available to retry.
  const handledIds = useMemo(() => new Set(
    Object.entries(proposals || {}).filter(([, v]) => v && v.status !== "rejected").map(([id]) => id)
  ), [proposals]);
  const pickList = useMemo(() => {
    const avail = (products || []).filter(p => p && p.id && p.name && p.photoUrl && !handledIds.has(p.id));
    const q = pickSearch.trim();
    return q ? avail.filter(p => productMatchesQuery(p, q))
             : avail.sort((a, b) => a.name.localeCompare(b.name));
  }, [products, pickSearch, handledIds]);
  const toggleSel = (id) => setSelectedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const generateSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setRunBusy(true); setRunMsg(`Generating ${ids.length} selected at ${quality}… (slow — image generation)`);
    try {
      const res = await httpsCallable(functions, "generateProductPhotos")({ productIds: ids, reprocess: true, quality });
      const d = res?.data || {};
      setRunMsg(`Done — ${d.processed} generated, ${d.failed} failed (≈ $${Number(d.estCostUSD || 0).toFixed(4)} est).`);
      setSelectedIds(new Set()); setPicking(false);
    } catch (e) {
      const m = String(e?.message || e);
      setRunMsg(`Couldn't run: ${m}${m.toLowerCase().includes("internal") || m.toLowerCase().includes("not-found") ? " — is generateProductPhotos deployed?" : ""}`);
    } finally { setRunBusy(false); }
  };

  const pending = useMemo(() => Object.entries(proposals || {})
    .filter(([, v]) => v && v.status !== "approved" && v.status !== "rejected")
    .map(([id, v]) => ({ id, ...v })), [proposals]);
  const decidedCount = useMemo(() => Object.values(proposals || {}).filter(v => v && (v.status === "approved" || v.status === "rejected")).length, [proposals]);

  const approve = async (row) => {
    setBusyId(row.id);
    try {
      await update(ref(database, `products/${row.id}`), { photoUrl: row.proposedUrl, photoUrlOriginal: row.originalUrl });
      await update(ref(database, `aiAssistant/photoProposals/${row.id}`), { status: "approved", decidedAt: Date.now() });
      return true;
    } catch (e) { setRunMsg(`Approve failed for “${row.name || row.id}”: ${e?.message || e}`); return false; }
    finally { setBusyId(null); }
  };
  const reject = async (row) => {
    setBusyId(row.id);
    try { await update(ref(database, `aiAssistant/photoProposals/${row.id}`), { status: "rejected", decidedAt: Date.now() }); }
    catch (e) { setRunMsg(`Reject failed for “${row.name || row.id}”: ${e?.message || e}`); }
    finally { setBusyId(null); }
  };
  const approveAll = async () => {
    if (!pending.length) return;
    if (!window.confirm(`Approve ALL ${pending.length} photos? This swaps those products to the white-bg version (originals are kept).`)) return;
    setBulkBusy(true);
    let okN = 0, failN = 0;
    try { for (const r of pending) { (await approve(r)) ? okN++ : failN++; } }
    finally { setBulkBusy(false); setRunMsg(`Approved ${okN}${failN ? `, ${failN} failed (see above)` : ""}.`); }
  };
  const runAI = async () => {
    setRunBusy(true); setRunMsg(`Generating ${runN} clothing photos… (slow — image generation)`);
    try {
      const res = await httpsCallable(functions, "generateProductPhotos")({ limit: Number(runN) || 12, category: "clothing", quality });
      const d = res?.data || {};
      setRunMsg(`Done — ${d.processed} generated, ${d.failed} failed (≈ $${Number(d.estCostUSD || 0).toFixed(4)} est).`);
    } catch (e) {
      const m = String(e?.message || e);
      setRunMsg(`Couldn't run: ${m}${m.toLowerCase().includes("internal") || m.toLowerCase().includes("not-found") ? " — is generateProductPhotos deployed?" : ""}`);
    } finally { setRunBusy(false); }
  };
  // Re-shoot THIS one product at the currently-selected quality (e.g. bump to high for
  // tricky branding). Overwrites its proposal in place; the row updates when it returns.
  const regenerate = async (row) => {
    setRegenIds(s => new Set(s).add(row.id));
    setRunMsg(`Regenerating “${row.name || row.id}” at ${quality}…`);
    try {
      const res = await httpsCallable(functions, "generateProductPhotos")({ productIds: [row.id], reprocess: true, quality });
      const d = res?.data || {};
      setRunMsg(d.processed ? `Regenerated “${row.name || row.id}” (${quality}, ≈ $${Number(d.estCostUSD || 0).toFixed(4)}).` : `Regenerate failed for “${row.name || row.id}”.`);
    } catch (e) { setRunMsg(`Regenerate failed for “${row.name || row.id}”: ${e?.message || e}`); }
    finally { setRegenIds(s => { const n = new Set(s); n.delete(row.id); return n; }); }
  };

  const imgBox = { width:"100%", aspectRatio:"1", objectFit:"contain", background:"rgba(255,255,255,.08)", borderRadius:10, border:"1px solid rgba(255,255,255,.1)", cursor:"zoom-in", display:"block" };

  return (
    <div style={{ padding:"0 14px 30px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 0 12px" }}>
        <span style={{ fontSize:18, fontWeight:700, color:"#fff" }}>AI Photo Cleanup</span>
        <span style={{ background:"rgba(74,202,122,.15)", border:"1px solid rgba(74,202,122,.35)", color:"#4ACA7A", fontSize:12, fontWeight:700, padding:"3px 10px", borderRadius:12 }}>{pending.length} to review</span>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:10 }}>
        <span style={{ fontSize:12, color:"rgba(255,255,255,.6)" }}>Generate</span>
        <input type="number" min={1} max={200} value={runN} onChange={e => setRunN(e.target.value)}
               style={{ width:60, background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.15)", borderRadius:8, color:"#fff", padding:"7px 9px", fontSize:13 }}/>
        <select value={quality} onChange={e => setQuality(e.target.value)} title="Image quality (cost rises with quality)"
                style={{ background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.15)", borderRadius:8, color:"#fff", padding:"7px 9px", fontSize:13 }}>
          <option value="low">low (~$0.01)</option>
          <option value="medium">medium (~$0.04)</option>
          <option value="high">high (~$0.17)</option>
        </select>
        <button onClick={selectedIds.size ? generateSelected : runAI} disabled={runBusy}
                title={selectedIds.size ? "Generate the products you picked" : "Auto-generate the next clothing items missing a photo"}
                style={{ background:"#4A7FFF", color:"#fff", border:"none", borderRadius:9, padding:"8px 14px", fontSize:12.5, fontWeight:700, cursor: runBusy ? "wait" : "pointer", opacity: runBusy ? .6 : 1 }}>
          {runBusy ? "Generating…" : selectedIds.size ? `Generate ${selectedIds.size} picked (${quality})` : "Generate next clothing"}
        </button>
        <button onClick={() => setPicking(v => !v)}
                style={{ background: picking ? "#4A7FFF" : "rgba(74,127,255,.14)", color: picking ? "#fff" : "#7AA7FF", border:"1px solid rgba(74,127,255,.4)", borderRadius:9, padding:"8px 14px", fontSize:12.5, fontWeight:700, cursor:"pointer" }}>
          {picking ? "Close picker" : "Choose products…"}
        </button>
        {pending.length > 0 && (
          <button onClick={approveAll} disabled={bulkBusy}
                  style={{ background:"rgba(0,150,70,.22)", color:"#4ACA7A", border:"1px solid rgba(0,180,80,.45)", borderRadius:9, padding:"8px 14px", fontSize:12.5, fontWeight:800, cursor: bulkBusy ? "wait" : "pointer", opacity: bulkBusy ? .6 : 1 }}>
            {bulkBusy ? "Approving…" : `Approve all (${pending.length})`}
          </button>
        )}
      </div>
      {runMsg && <div style={{ fontSize:11.5, color:"rgba(255,255,255,.6)", marginBottom:10 }}>{runMsg}</div>}
      {decidedCount > 0 && <div style={{ fontSize:11, color:"rgba(255,255,255,.35)", marginBottom:10 }}>{decidedCount} already decided (hidden).</div>}

      {/* PRODUCT PICKER — search, tap to select as many as you want, then generate exactly those. */}
      {picking && (
        <div style={{ background:"rgba(8,11,20,.95)", border:"1px solid rgba(74,127,255,.3)", borderRadius:12, padding:12, marginBottom:14 }}>
          <input value={pickSearch} onChange={e => setPickSearch(e.target.value)} placeholder="Search products by name or barcode…"
                 style={{ width:"100%", boxSizing:"border-box", background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.15)", borderRadius:8, color:"#fff", padding:"9px 11px", fontSize:13.5, marginBottom:10 }}/>
          <div style={{ fontSize:11, color:"rgba(255,255,255,.4)", marginBottom:8 }}>
            {pickList.length} product{pickList.length===1?"":"s"} not yet done{handledIds.size ? ` · ${handledIds.size} already generated (hidden)` : ""}{selectedIds.size ? ` · ${selectedIds.size} selected` : ""}
          </div>
          <div style={{ maxHeight:380, overflowY:"auto", display:"flex", flexDirection:"column", gap:6 }}>
            {pickList.map(p => {
              const on = selectedIds.has(p.id);
              return (
                <div key={p.id} onClick={() => toggleSel(p.id)}
                     style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 8px", borderRadius:9, cursor:"pointer",
                              background: on ? "rgba(74,202,122,.16)" : "rgba(255,255,255,.03)", border:"1px solid "+(on ? "rgba(74,202,122,.5)" : "rgba(255,255,255,.07)") }}>
                  <img src={p.photoUrl} alt="" loading="lazy"
                       style={{ width:38, height:38, borderRadius:7, objectFit:"cover", background:"rgba(255,255,255,.08)", flexShrink:0 }}/>
                  <span style={{ flex:1, minWidth:0, fontSize:12.5, color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</span>
                  <span style={{ fontSize:15, color: on ? "#4ACA7A" : "rgba(255,255,255,.25)" }}>{on ? "✓" : "+"}</span>
                </div>
              );
            })}
            {pickList.length === 0 && <div style={{ color:"#555", fontSize:12, padding:"12px 4px" }}>{pickSearch.trim() ? "No products match." : "All products already generated 🎉"}</div>}
          </div>
          <div style={{ fontSize:10.5, color:"rgba(255,255,255,.3)", marginTop:6 }}>Tip: each batch caps at 200; for a big run, select in groups.</div>
          <div style={{ display:"flex", gap:8, marginTop:10 }}>
            <button onClick={generateSelected} disabled={!selectedIds.size || runBusy}
                    style={{ flex:1, background:"#4A7FFF", color:"#fff", border:"none", borderRadius:9, padding:"10px 0", fontSize:12.5, fontWeight:800, cursor: (!selectedIds.size||runBusy) ? "not-allowed" : "pointer", opacity: (!selectedIds.size||runBusy) ? .5 : 1 }}>
              {runBusy ? "Generating…" : `Generate ${selectedIds.size || ""} selected (${quality})`}
            </button>
            {selectedIds.size > 0 && (
              <button onClick={() => setSelectedIds(new Set())}
                      style={{ background:"rgba(255,255,255,.06)", color:"rgba(255,255,255,.7)", border:"1px solid rgba(255,255,255,.15)", borderRadius:9, padding:"10px 14px", fontSize:12.5, fontWeight:700, cursor:"pointer" }}>Clear</button>
            )}
          </div>
        </div>
      )}

      {pending.length === 0 && !picking && (
        <div style={{ textAlign:"center", color:"#555", padding:"2.5rem 1rem", fontSize:"0.9rem" }}>
          No photo proposals to review. Use “Generate next clothing” or “Choose products…” to re-shoot on a white background.
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {pending.map(row => {
          const busy = busyId === row.id;
          const regen = regenIds.has(row.id);
          return (
            <div key={row.id} style={{ background:"rgba(8,11,20,.9)", border:"1px solid rgba(255,255,255,.08)", borderRadius:14, padding:12 }}>
              <div style={{ fontSize:13.5, fontWeight:600, color:"#fff", marginBottom:8 }}>{row.name || "(no name)"}</div>
              <div style={{ display:"flex", gap:10, marginBottom:10 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"rgba(255,255,255,.4)", marginBottom:4, letterSpacing:.5 }}>ORIGINAL</div>
                  <img src={row.originalUrl} alt="" onClick={() => setLightbox(row.originalUrl)} style={imgBox}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#4ACA7A", marginBottom:4, letterSpacing:.5 }}>WHITE BACKGROUND</div>
                  <img src={row.proposedUrl} alt="" onClick={() => setLightbox(row.proposedUrl)} style={imgBox}/>
                </div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => approve(row)} disabled={busy || regen}
                        style={{ flex:1, background:"rgba(0,150,70,.22)", border:"1px solid rgba(0,180,80,.4)", color:"#4ACA7A", borderRadius:9, padding:"10px 0", fontSize:12.5, fontWeight:700, cursor: (busy||regen) ? "wait" : "pointer", opacity: (busy||regen) ? .6 : 1 }}>
                  {busy ? "…" : "Approve"}
                </button>
                <button onClick={() => regenerate(row)} disabled={busy || regen}
                        title={`Re-shoot this one at ${quality}`}
                        style={{ flex:1, background:"rgba(74,127,255,.16)", border:"1px solid rgba(74,127,255,.4)", color:"#7AA7FF", borderRadius:9, padding:"10px 0", fontSize:12.5, fontWeight:700, cursor: (busy||regen) ? "wait" : "pointer", opacity: (busy||regen) ? .6 : 1 }}>
                  {regen ? "Regenerating…" : "Regenerate"}
                </button>
                <button onClick={() => reject(row)} disabled={busy || regen}
                        style={{ flex:1, background:"rgba(150,30,30,.18)", border:"1px solid rgba(200,60,60,.35)", color:"#FF6B6B", borderRadius:9, padding:"10px 0", fontSize:12.5, fontWeight:700, cursor: (busy||regen) ? "wait" : "pointer", opacity: (busy||regen) ? .6 : 1 }}>
                  Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.9)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <img src={lightbox} alt="" style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain", borderRadius:10 }}/>
        </div>
      )}
    </div>
  );
}

const NAME_HIGH_CONFIDENCE = 0.85;
const confColor = (c) => (c >= NAME_HIGH_CONFIDENCE ? "#4ACA7A" : c >= 0.6 ? "#F59E0B" : "#FF6B6B");

function AdminReviewNamesTab({ products }) {
  const proposals = useNameProposals();
  const [edits, setEdits]   = useState({});     // id → edited name (overrides the suggestion)
  const [busyId, setBusyId] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [runN, setRunN]     = useState(20);
  const [runBusy, setRunBusy] = useState(false);
  const [runMsg, setRunMsg] = useState(null);

  // Pending rows (undecided), highest-confidence first.
  const pending = useMemo(() => Object.entries(proposals || {})
    .filter(([, v]) => v && v.status !== "approved" && v.status !== "rejected")
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0)), [proposals]);
  const decidedCount = useMemo(() => Object.values(proposals || {}).filter(v => v && (v.status === "approved" || v.status === "rejected")).length, [proposals]);
  const highCount = pending.filter(r => (r.confidence || 0) >= NAME_HIGH_CONFIDENCE).length;

  const finalName = (row) => (edits[row.id] ?? row.suggested ?? "").trim();

  const approve = async (row) => {
    const name = finalName(row);
    if (!name) return false;
    setBusyId(row.id);
    try {
      await updateProductName(row.id, name);
      await update(ref(database, `aiAssistant/nameProposals/${row.id}`), { status: "approved", appliedName: name, decidedAt: Date.now() });
      return true;
    } catch (e) { setRunMsg(`Approve failed for “${row.current || row.id}”: ${e?.message || e}`); return false; }
    finally { setBusyId(null); }
  };
  const reject = async (row) => {
    setBusyId(row.id);
    try { await update(ref(database, `aiAssistant/nameProposals/${row.id}`), { status: "rejected", decidedAt: Date.now() }); }
    catch (e) { setRunMsg(`Reject failed for “${row.current || row.id}”: ${e?.message || e}`); }
    finally { setBusyId(null); }
  };
  const approveAllHigh = async () => {
    setBulkBusy(true);
    let okN = 0, failN = 0;
    try { for (const r of pending.filter(r => (r.confidence || 0) >= NAME_HIGH_CONFIDENCE)) { (await approve(r)) ? okN++ : failN++; } }
    finally { setBulkBusy(false); setRunMsg(`Approved ${okN}${failN ? `, ${failN} failed (see above)` : ""}.`); }
  };
  const approveAll = async () => {
    if (!pending.length) return;
    if (!window.confirm(`Approve ALL ${pending.length} suggestions? This renames those products to the suggested names.`)) return;
    setBulkBusy(true);
    let okN = 0, failN = 0;
    try { for (const r of pending) { (await approve(r)) ? okN++ : failN++; } }
    finally { setBulkBusy(false); setRunMsg(`Approved ${okN}${failN ? `, ${failN} failed (see above)` : ""}.`); }
  };
  const runAI = async () => {
    setRunBusy(true); setRunMsg(`Running AI on the next ${runN} products…`);
    try {
      const res = await httpsCallable(functions, "cleanProductNames")({ limit: Number(runN) || 20 });
      const d = res?.data || {};
      setRunMsg(`Done — ${d.processed} suggested, ${d.failed} failed (≈ $${Number(d.totalCostUSD || 0).toFixed(4)}).`);
    } catch (e) {
      const m = String(e?.message || e);
      setRunMsg(`Couldn't run: ${m}${m.toLowerCase().includes("not-found") || m.toLowerCase().includes("internal") ? " — is cleanProductNames deployed?" : ""}`);
    } finally { setRunBusy(false); }
  };

  return (
    <div style={{ padding:"0 14px 30px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 0 12px" }}>
        <span style={{ fontSize:18, fontWeight:700, color:"#fff" }}>AI Name Cleanup</span>
        <span style={{ background:"rgba(74,202,122,.15)", border:"1px solid rgba(74,202,122,.35)", color:"#4ACA7A", fontSize:12, fontWeight:700, padding:"3px 10px", borderRadius:12 }}>{pending.length} to review</span>
      </div>

      {/* Generate suggestions (calls the cleanProductNames function once deployed). */}
      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:10 }}>
        <span style={{ fontSize:12, color:"rgba(255,255,255,.6)" }}>Run AI on next</span>
        <input type="number" min={1} max={500} value={runN} onChange={e => setRunN(e.target.value)}
               style={{ width:64, background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.15)", borderRadius:8, color:"#fff", padding:"7px 9px", fontSize:13 }}/>
        <button onClick={runAI} disabled={runBusy}
                style={{ background:"#4A7FFF", color:"#fff", border:"none", borderRadius:9, padding:"8px 14px", fontSize:12.5, fontWeight:700, cursor: runBusy ? "wait" : "pointer", opacity: runBusy ? .6 : 1 }}>
          {runBusy ? "Running…" : "Generate suggestions"}
        </button>
        {highCount > 0 && (
          <button onClick={approveAllHigh} disabled={bulkBusy}
                  style={{ background:"rgba(74,202,122,.16)", color:"#4ACA7A", border:"1px solid rgba(74,202,122,.4)", borderRadius:9, padding:"8px 14px", fontSize:12.5, fontWeight:700, cursor: bulkBusy ? "wait" : "pointer", opacity: bulkBusy ? .6 : 1 }}>
            {bulkBusy ? "Approving…" : `Approve ${highCount} high-confidence (≥85%)`}
          </button>
        )}
        {pending.length > 0 && (
          <button onClick={approveAll} disabled={bulkBusy}
                  style={{ background:"rgba(0,150,70,.22)", color:"#4ACA7A", border:"1px solid rgba(0,180,80,.45)", borderRadius:9, padding:"8px 14px", fontSize:12.5, fontWeight:800, cursor: bulkBusy ? "wait" : "pointer", opacity: bulkBusy ? .6 : 1 }}>
            {bulkBusy ? "Approving…" : `Approve all (${pending.length})`}
          </button>
        )}
      </div>
      {runMsg && <div style={{ fontSize:11.5, color:"rgba(255,255,255,.6)", marginBottom:10 }}>{runMsg}</div>}
      {decidedCount > 0 && <div style={{ fontSize:11, color:"rgba(255,255,255,.35)", marginBottom:10 }}>{decidedCount} already decided (hidden).</div>}

      {pending.length === 0 && (
        <div style={{ textAlign:"center", color:"#555", padding:"2.5rem 1rem", fontSize:"0.9rem" }}>
          No name suggestions to review. Use “Generate suggestions” to run the AI over products that don’t have a proposal yet.
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {pending.map(row => {
          const busy = busyId === row.id;
          const pct = Math.round((row.confidence || 0) * 100);
          const changed = (row.suggested || "") !== (row.current || "");
          return (
            <div key={row.id} style={{ display:"flex", gap:11, background:"rgba(8,11,20,.9)", border:"1px solid rgba(255,255,255,.08)", borderRadius:14, padding:11 }}>
              <ProductPhoto url={row.photoUrl} size={64} radius={10}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <span style={{ fontSize:10, fontWeight:800, color: confColor(row.confidence || 0), background:"rgba(255,255,255,.05)", border:`1px solid ${confColor(row.confidence || 0)}55`, borderRadius:10, padding:"2px 8px" }}>{pct}% sure</span>
                  {!changed && <span style={{ fontSize:10, color:"rgba(255,255,255,.35)" }}>no change suggested</span>}
                </div>
                <div style={{ fontSize:11, color:"rgba(255,255,255,.4)", textDecoration: changed ? "line-through" : "none", marginBottom:4 }}>{row.current || "(no name)"}</div>
                <input
                  value={edits[row.id] ?? row.suggested ?? ""}
                  onChange={e => setEdits(s => ({ ...s, [row.id]: e.target.value }))}
                  style={{ width:"100%", boxSizing:"border-box", background:"rgba(255,255,255,.06)", border:"1px solid rgba(74,127,255,.35)", borderRadius:8, color:"#fff", padding:"8px 10px", fontSize:13.5, fontWeight:600, marginBottom:8 }}
                  aria-label="Suggested name (editable)"
                />
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => approve(row)} disabled={busy || !finalName(row)}
                          style={{ flex:1, background:"rgba(0,150,70,.22)", border:"1px solid rgba(0,180,80,.4)", color:"#4ACA7A", borderRadius:9, padding:"9px 0", fontSize:12.5, fontWeight:700, cursor: busy ? "wait" : "pointer", opacity: busy ? .6 : 1 }}>
                    {busy ? "…" : "Approve"}
                  </button>
                  <button onClick={() => reject(row)} disabled={busy}
                          style={{ flex:1, background:"rgba(150,30,30,.18)", border:"1px solid rgba(200,60,60,.35)", color:"#FF6B6B", borderRadius:9, padding:"9px 0", fontSize:12.5, fontWeight:700, cursor: busy ? "wait" : "pointer", opacity: busy ? .6 : 1 }}>
                    Reject
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdminView({ products, orders, onExit }) {
  // ── Add Product form state (collapsible at top of list) ─────────────────
  const [showAdd, setShowAdd] = useState(false);
  // Phase 12A: productType (sneaker default | clothing). Both types use a
  // shared `sizes` array — sneakers store "3".."11", clothing stores
  // "S".."XXXL". Phase 14A: `hubs` is a multi-select (Hub 1 / Hub 2 / Hub 3);
  // clothing cannot include Hub 1.
  // POS Phase 2: stockPrice / retailPrice / hasShoeBoxOption added. Prices
  // are raw <input type="number"> strings here and parsed on save — that way
  // an empty field round-trips to "not set" instead of 0. `shoeboxTouched`
  // tracks whether the user has manually toggled the shoebox checkbox; once
  // true we stop auto-syncing it from category/productType.
  // sku + barcode are NOT in form state — they auto-generate at save time via
  // reserveNextSkuAndBarcode() so the sequence stays tight and gap-free.
  // sizeStyle picks the size breakdown shown: "shoe" (sneaker), "letters" (clothing
  // tops S–4XL), or "waist" (bottoms 28–40). Bottoms still save as productType
  // "clothing"; sizeStyle only drives which size buttons appear.
  const [form, setForm] = useState({ name:"", category:"", photo:"", photoUrl:null, photoBlob:null, sizes:[], hubs:["hub1"], productType:"sneaker", sizeStyle:"shoe", stockPrice:"", retailPrice:"", hasShoeBoxOption:true });
  const [shoeboxTouched, setShoeboxTouched] = useState(false);
  // Optional opening-stock receiving (Stock rework). Collapsed by default — when
  // collapsed the form behaves EXACTLY as before. Quantities are NEVER required;
  // entered amounts write as `received` movements into the default receiving
  // warehouse on save (the Stock → Set Qty screen can receive at any location).
  const [recvOpen, setRecvOpen] = useState(false);
  const [recvQtys, setRecvQtys] = useState({}); // { size: "n" }
  const [recvLoc, setRecvLoc] = useState(""); // destination — NO default; admin must pick each save
  const [saving, setSaving] = useState(false);
  // After a save with opening stock, surface the inline Print-barcodes sheet for the
  // sizes just received (count defaults to units added). Lives at the view level so
  // it survives the New Product form unmounting on save.
  const [lastReceived, setLastReceived] = useState(null); // { productId, productName, items:[{size,added}] }
  const [printOpen, setPrintOpen] = useState(false);
  const recvRegistry = useLocations();
  const fileInputRef = useRef(null);
  // ── List search + type filter ───────────────────────────────────────────
  const [productSearch, setProductSearch] = useState("");
  // Admin product list is split by product type so sneakers and clothing are
  // managed separately. Defaults to sneakers (the bulk of the catalogue).
  const [typeFilter, setTypeFilter] = useState("sneaker"); // "sneaker" | "clothing"
  // Admin section: the product list vs the AI name-cleanup review screen.
  const [adminSection, setAdminSection] = useState("products"); // "products" | "review-names"
  const nameProposals = useNameProposals();
  const pendingNameCount = useMemo(() => Object.values(nameProposals || {}).filter(v => v && v.status !== "approved" && v.status !== "rejected").length, [nameProposals]);
  const photoProposals = usePhotoProposals();
  const pendingPhotoCount = useMemo(() => Object.values(photoProposals || {}).filter(v => v && v.status !== "approved" && v.status !== "rejected").length, [photoProposals]);
  // ── Detail routing (hash-driven) — #product/{id} opens the detail page,
  //    browser back clears it. Listener stays mounted for the whole view. ──
  const [detailId, setDetailId] = useState(() => parseProductHash());
  useEffect(() => {
    const onHashChange = () => setDetailId(parseProductHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  // Insights log → fuels the detail page's "Last sold X · N orders all-time"
  // context line. orders[] alone isn't enough — it's daily-counter-ephemeral
  // (see project-insights-past-days-pattern memory).
  const insightsLog = useInsightsLog();

  const addProduct = async () => {
    if (!form.name || form.sizes.length === 0) return;
    // Opening stock requires an explicitly-picked destination — no default location.
    const hasOpeningQty = (form.sizes || []).some(s => { const n = parseInt(recvQtys[s], 10); return Number.isFinite(n) && n > 0; });
    if (hasOpeningQty && !recvLoc) { alert("Pick a location for the opening stock (or clear the quantities) before saving."); return; }
    setSaving(true);
    try {
      const id = "p" + Date.now();
      let photoUrl = form.photoUrl; // may be null or a preview data-URL

      if (form.photoBlob) {
        // Upload compressed image to Firebase Storage; store only the HTTPS URL in RTDB.
        const sRef = storageRef(storage, `products/${id}/photo.jpg`);
        await uploadBytes(sRef, form.photoBlob, { contentType: "image/jpeg" });
        photoUrl = await getDownloadURL(sRef);
      }

      const isClothing = form.productType === "clothing";
      // Phase 14A: clothing cannot be in Hub 1. Strip defensively and fall
      // back to a sensible default if everything got unchecked.
      const cleanedHubs = (isClothing ? form.hubs.filter(h => h !== "hub1") : form.hubs)
        .filter(h => h === "hub1" || h === "hub2" || h === "hub3");
      const finalHubs = cleanedHubs.length ? cleanedHubs : (isClothing ? ["hub2"] : ["hub1"]);
      const newProduct = {
        name: form.name,
        category: form.category,
        photo: form.photo,
        photoUrl: photoUrl ?? null,
        hubs: finalHubs,
        productType: form.productType,
        sizes: form.sizes,
        id,
      };
      // POS Phase 2: parse the price strings. Empty / non-finite / non-positive
      // → omit the field entirely. We never want to write `0` and have the POS
      // treat the product as free.
      const stockNum  = Number(form.stockPrice);
      const retailNum = Number(form.retailPrice);
      if (Number.isFinite(stockNum)  && stockNum  > 0) newProduct.stockPrice  = stockNum;
      if (Number.isFinite(retailNum) && retailNum > 0) newProduct.retailPrice = retailNum;
      // Persist the shoebox flag explicitly so POS has a defined value for
      // newly-created products. Legacy products without it are treated as
      // false per the reader contract in SCHEMA.md. Clothing NEVER has a
      // shoebox — force false regardless of the form state.
      newProduct.hasShoeBoxOption = isClothing ? false : !!form.hasShoeBoxOption;
      // POS Phase 2: reserve the next sequential sku + barcode atomically
      // BEFORE the product write so two concurrent adds can't collide. If
      // reservation fails (counter exhausted or RTDB error), surface the
      // message and abort — no half-saved product, no advanced counter.
      const { sku, barcode } = await reserveNextSkuAndBarcode();
      newProduct.sku     = sku;
      newProduct.barcode = barcode;
      await addProductToFirebase(newProduct);

      // GUARANTEE ON SAVE: mint a barcode for every size now so the catalog never
      // has gaps (a sizeless/one-size product mints the "_" slot). Best-effort —
      // a creator without stockRole still saves the product; the index heals on
      // the next mint and the backfill covers anything missed.
      ensureBarcodes(id, (form.sizes && form.sizes.length) ? form.sizes : [null]).catch(() => {});

      // Optional opening stock: if quantities were entered, write them as
      // `received` movements into the default receiving warehouse via
      // applyMovement — ledger-paired, never raw. The product is already saved,
      // so this NEVER blocks the save; a denied/failed movement (e.g. the user
      // lacks stockRole) only soft-warns and can be entered later.
      try {
        const recvEntries = (form.sizes || [])
          .map(s => [s, parseInt(recvQtys[s], 10)])
          .filter(([, n]) => Number.isFinite(n) && n > 0);
        if (recvEntries.length) {
          const locLabel = labelFor(recvLoc, recvRegistry);
          let recOk = 0, recFail = 0; const savedItems = [];
          for (const [size, n] of recvEntries) {
            const res = await applyMovement({ type: "received", productId: id, size, qty: n, to: recvLoc });
            if (res.ok) { recOk++; savedItems.push({ size, added: n }); }
            else recFail++;
          }
          if (recFail) {
            alert(`Product saved. ${recOk} size(s) received into ${locLabel}; ${recFail} could not be received — you may not have stock permission (stockRole). You can add these quantities later from Stock.`);
          }
          // Surface the inline Print-barcodes sheet for the sizes that saved.
          if (savedItems.length) {
            setLastReceived({ productId: id, productName: newProduct.name, photoUrl: newProduct.photoUrl ?? null, items: savedItems });
            setPrintOpen(true);
          }
        }
      } catch (recErr) {
        console.warn("opening-stock receive failed:", recErr);
      }

      setForm({ name:"", category:"", photo:"", photoUrl:null, photoBlob:null, sizes:[], hubs:["hub1"], productType:"sneaker", sizeStyle:"shoe", stockPrice:"", retailPrice:"", hasShoeBoxOption:true });
      setShoeboxTouched(false);
      setRecvQtys({});
      setRecvOpen(false);
      setShowAdd(false);
    } catch (err) {
      console.error("addProduct failed:", err);
      // Surface counter-exhaustion + reservation errors with their actual
      // message so the admin knows what's wrong; everything else gets the
      // generic prompt.
      const msg = /counter exhausted|reservation/i.test(String(err?.message || ""))
        ? `Failed to save product:\n${err.message}`
        : "Failed to save product. Please try again.";
      alert(msg);
    } finally {
      setSaving(false);
    }
  };

  // Per-product edit handlers (name/sizes/hubs/photo/delete) used to live
  // here as inline-editor flows in the list. They've been moved into
  // AdminProductDetail — list rows are now navigation targets only.

  const toggleSize = s => setForm(f => ({ ...f, sizes: f.sizes.includes(s) ? f.sizes.filter(x=>x!==s) : [...f.sizes, s] }));
  const toggleHub  = h => setForm(f => ({ ...f, hubs:  f.hubs.includes(h)  ? f.hubs.filter(x=>x!==h)  : [...f.hubs,  h] }));
  // Switching to Clothing strips Hub 1 (and falls back to Hub 2 if everything
  // would go empty). Switching back to Sneaker leaves hubs alone. POS Phase 2:
  // also auto-sync the shoebox checkbox when productType changes — clothing
  // never has a shoebox, sneakers default to true — unless the user has
  // manually toggled it (shoeboxTouched).
  const setProductType = (nextType) => setForm(f => {
    if (nextType === "clothing") {
      // Clothing can't be in Hub 1 and never has a shoebox — force both,
      // overriding any manual shoebox toggle.
      const stripped = f.hubs.filter(h => h !== "hub1");
      return { ...f, productType: "clothing", hubs: stripped.length ? stripped : ["hub2"], hasShoeBoxOption: false };
    }
    // Switching to Sneaker defaults the shoebox on (matches prior behavior),
    // unless the user already toggled it manually.
    const shoeboxPatch = shoeboxTouched ? {} : { hasShoeBoxOption: true };
    return { ...f, productType: nextType, ...shoeboxPatch };
  });
  // The three selectable size breakdowns. "Bottoms" is a CLOTHING product (same
  // routing/hubs/no-shoebox) that uses the waist size set instead of letters — so it
  // maps to productType "clothing" with sizeStyle "waist".
  const SIZE_TYPE_OPTIONS = [
    { key: "shoe",    label: "Sneaker",  productType: "sneaker"  },
    { key: "letters", label: "Clothing", productType: "clothing" },
    { key: "waist",   label: "Bottoms",  productType: "clothing" },
  ];
  const selectSizeType = (opt) => {
    if (opt.key === form.sizeStyle) return;       // already active
    setProductType(opt.productType);              // applies clothing hub/shoebox rules
    // A different size family invalidates the currently-selected sizes + their qtys.
    setForm(f => ({ ...f, sizeStyle: opt.key, sizes: [] }));
    setRecvQtys({});
  };
  // Size buttons for the form, driven by the chosen breakdown.
  const formSizeChoices = form.sizeStyle === "shoe" ? SNEAKER_SIZES
    : form.sizeStyle === "waist" ? BOTTOMS_SIZES : CLOTHING_SIZES;
  // POS Phase 2: category onChange handler. Auto-sets the shoebox flag based
  // on category text (footwear / shoe / sneaker → true; everything else →
  // false), unless the user has manually toggled it. Clothing always stays
  // shoebox-off regardless of category text.
  const setCategory = (nextCategory) => setForm(f => {
    const patch = { category: nextCategory };
    if (!shoeboxTouched) {
      patch.hasShoeBoxOption = f.productType !== "clothing" &&
        (/foot|shoe/i.test(nextCategory) || f.productType === "sneaker");
    }
    return { ...f, ...patch };
  });
  const toggleShoebox = () => {
    setShoeboxTouched(true);
    setForm(f => ({ ...f, hasShoeBoxOption: !f.hasShoeBoxOption }));
  };

  // Products filtered by the active type tab (Sneakers / Clothing) + the search
  // bar (substring, case-insensitive). Products without productType are treated
  // as sneakers.
  const filteredProducts = useMemo(() => {
    const q = productSearch.trim();
    return products.filter(p => {
      if ((p.productType || "sneaker") !== typeFilter) return false;
      // Forgiving search: fuzzy name + barcode/sku/per-size codes (see productSearch.js).
      if (q && !productMatchesQuery(p, q)) return false;
      return true;
    });
  }, [products, productSearch, typeFilter]);

  const handleImageUpload = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const MAX_DIM = 800;
        const MAX_BYTES = 200 * 1024; // 200 KB target

        // Scale down if wider/taller than 800 px.
        const scale = Math.min(1, MAX_DIM / img.width, MAX_DIM / img.height);
        const canvas = document.createElement("canvas");
        canvas.width  = Math.round(img.width  * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);

        // Step quality from 0.85 down to 0.05 in 0.05 increments.
        // dataUrl length * 0.75 ≈ actual byte count (base64 overhead is 4/3).
        // Stop as soon as the image fits in MAX_BYTES.
        let dataUrl = canvas.toDataURL("image/jpeg", 0.05); // worst-case fallback
        for (let q = 0.85; q > 0.05; q = Math.round((q - 0.05) * 100) / 100) {
          const candidate = canvas.toDataURL("image/jpeg", q);
          if (candidate.length * 0.75 <= MAX_BYTES) {
            dataUrl = candidate;
            break;
          }
        }

        const blob = dataURLToBlob(dataUrl);
        setForm(f => ({ ...f, photoUrl: dataUrl, photoBlob: blob }));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };

  // Detail page: which product, and stale-hash guard. If the hash points
  // at a product that no longer exists (deleted in another tab), clear it.
  const detailProduct = detailId ? products.find(p => p.id === detailId) : null;
  useEffect(() => {
    if (detailId && products.length > 0 && !detailProduct) {
      window.history.back();
    }
  }, [detailId, products.length, detailProduct]);

  // When the detail page is mounted, render JUST the detail (no list chrome).
  if (detailProduct) {
    return (
      <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
        <AdminProductDetail
          product={detailProduct}
          insightsLog={insightsLog}
          onBack={() => window.history.back()}
        />
      </div>
    );
  }

  // Section toggle (Products ↔ Review Names), shown at the top of both sections.
  const sectionToggle = (
    <div style={{ display:"flex", gap:8, padding:"0 14px 4px" }}>
      {[["products","Products"],["review-names","Names"],["review-photos","Photos"]].map(([val, label]) => {
        const on = adminSection === val;
        const badge = val === "review-names" ? pendingNameCount : val === "review-photos" ? pendingPhotoCount : 0;
        return (
          <button key={val} onClick={() => setAdminSection(val)}
            style={{ flex:1, background: on ? "#4A7FFF" : "rgba(255,255,255,.05)", color: on ? "#fff" : "rgba(255,255,255,.6)", border:"1px solid "+(on ? "#4A7FFF" : "rgba(255,255,255,.1)"), borderRadius:10, padding:"9px 0", fontSize:13, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
            {label}{badge > 0 && <span style={{ background:"#4ACA7A", color:"#063", fontSize:11, fontWeight:800, borderRadius:9, padding:"0 7px" }}>{badge}</span>}
          </button>
        );
      })}
    </div>
  );

  if (adminSection === "review-names") {
    return (
      <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 12px" }}>
          <div onClick={onExit} style={{ background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.1)", borderRadius:10, padding:"8px 14px", fontSize:12, color:"rgba(255,255,255,.7)", cursor:"pointer" }}>← Switch View</div>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:10, color:"rgba(255,255,255,.4)", letterSpacing:"0.5px" }}>Viewing as:</div>
            <div style={{ fontSize:15, fontWeight:700, color:"#4A7FFF", letterSpacing:"0.5px" }}>ADMIN</div>
          </div>
          <div style={{ width:90 }}/>
        </div>
        <div style={{ height:6 }}/>
        {sectionToggle}
        <div style={{ height:10 }}/>
        <AdminReviewNamesTab products={products} />
      </div>
    );
  }

  if (adminSection === "review-photos") {
    return (
      <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 12px" }}>
          <div onClick={onExit} style={{ background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.1)", borderRadius:10, padding:"8px 14px", fontSize:12, color:"rgba(255,255,255,.7)", cursor:"pointer" }}>← Switch View</div>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:10, color:"rgba(255,255,255,.4)", letterSpacing:"0.5px" }}>Viewing as:</div>
            <div style={{ fontSize:15, fontWeight:700, color:"#4A7FFF", letterSpacing:"0.5px" }}>ADMIN</div>
          </div>
          <div style={{ width:90 }}/>
        </div>
        <div style={{ height:6 }}/>
        {sectionToggle}
        <div style={{ height:10 }}/>
        <AdminReviewPhotosTab products={products} />
      </div>
    );
  }

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
      {/* TOP BAR with Switch View */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 12px" }}>
        <div onClick={onExit} style={{ background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.1)", borderRadius:10, padding:"8px 14px", fontSize:12, color:"rgba(255,255,255,.7)", cursor:"pointer" }}>← Switch View</div>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.4)", letterSpacing:"0.5px" }}>Viewing as:</div>
          <div style={{ fontSize:15, fontWeight:700, color:"#4A7FFF", letterSpacing:"0.5px" }}>ADMIN</div>
        </div>
        <div style={{ width:90 }}/>
      </div>

      {/* ADMIN HERO IMAGE */}
      <div style={{ position:"relative", height:200, overflow:"hidden" }}>
        <img src="/hero/admin.jpg" alt="Admin Panel" style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", objectFit:"cover", objectPosition:"left center" }}/>
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:70, background:"linear-gradient(transparent,#000)" }}/>
      </div>

      <div style={{ height:12 }}/>
      {sectionToggle}

      <div>
        {/* PRODUCTS HEADER ROW */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 14px 12px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:20, fontWeight:700, color:"#fff" }}>Products</span>
            <span style={{ background:"rgba(60,110,255,.15)", border:"1px solid rgba(60,110,255,.3)", color:"#4A7FFF", fontSize:12, fontWeight:700, padding:"3px 10px", borderRadius:12 }}>{products.length}</span>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <button onClick={() => setShowAdd(!showAdd)} style={{ background:"#4A7FFF", color:"#fff", border:"none", borderRadius:10, padding:"10px 18px", fontSize:13, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", gap:6, boxShadow:"0 0 14px rgba(60,110,255,.3)" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add Product
            </button>
          </div>
        </div>


        <div style={{ padding:"0 14px" }}>

      {showAdd && (
        <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.5rem", marginBottom:"1.5rem", boxShadow:GLOW }}>
          <div style={{ fontWeight:"700", fontSize:"0.95rem", marginBottom:"1rem", color:"#ccc" }}>New Product</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"1rem", marginBottom:"1rem" }}>
            <input placeholder="Product name" value={form.name} onChange={e => setForm(f=>({...f,name:e.target.value}))} style={inputStyle} />
            <input placeholder="Category (e.g. Sneakers)" value={form.category} onChange={e => setCategory(e.target.value)} style={inputStyle} />
            <div style={{ gridColumn:"1 / -1" }}>
              <div style={{ color:"#888", fontSize:"0.8rem", marginBottom:"0.5rem" }}>Product Photo</div>
              <div>
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display:"none" }} />
                <button onClick={() => fileInputRef.current.click()} style={{ background:"rgba(60,110,255,.05)", border:"2px dashed rgba(60,110,255,.25)", borderRadius:"10px", padding:"0.75rem 1.25rem", color:"#888", cursor:"pointer", fontSize:"0.85rem", width:"100%", textAlign:"center" }}>
                  {form.photoUrl ? "Photo uploaded — click to change" : "Click to upload photo"}
                </button>
                {form.photoUrl && <img src={form.photoUrl} alt="preview" style={{ marginTop:"0.5rem", width:"64px", height:"64px", objectFit:"cover", borderRadius:RADIUS, border:BORDER }} />}
              </div>
            </div>
          </div>
          {/* Product type toggle (Phase 12A) */}
          <div style={{ color:"#888", fontSize:"0.8rem", marginBottom:"0.5rem" }}>Product Type</div>
          <div style={{ display:"flex", gap:"0.5rem", marginBottom:"1.25rem" }}>
            {SIZE_TYPE_OPTIONS.map(opt => {
              const on = form.sizeStyle === opt.key;
              return (
                <button key={opt.key} onClick={() => selectSizeType(opt)}
                  style={{ padding:"6px 20px", borderRadius:"8px", border:"2px solid", borderColor: on?BLUE:"rgba(60,110,255,.15)", background: on?"rgba(60,110,255,.12)":"transparent", color: on?BLUE_L:"#666", cursor:"pointer", fontWeight:"600", fontSize:"0.9rem" }}>
                  {opt.label}
                </button>
              );
            })}
          </div>

          {/* Size toggles — same toggle UX for every breakdown, different option lists. */}
          <div style={{ color:"#888", fontSize:"0.8rem", marginBottom:"0.5rem" }}>Available Sizes</div>
          <div style={{ display:"flex", gap:"0.5rem", flexWrap:"wrap", marginBottom:"1.25rem" }}>
            {formSizeChoices.map(s => (
              <button key={s} onClick={() => toggleSize(s)}
                style={{ padding:"6px 14px", borderRadius:"8px", border:"2px solid", borderColor: form.sizes.includes(s)?BLUE:"rgba(60,110,255,.15)", background: form.sizes.includes(s)?"rgba(60,110,255,.12)":"transparent", color: form.sizes.includes(s)?BLUE_L:"#666", cursor:"pointer", fontWeight:"600" }}>
                {s}
              </button>
            ))}
          </div>

          {/* Opening stock (Stock rework) — OPTIONAL, collapsed by default. When
              collapsed the form is unchanged. Expanded: a qty box arrow-linked
              under each selected size. Quantities are never required. */}
          <div style={{ marginBottom:"1.25rem" }}>
            <button type="button" onClick={() => setRecvOpen(o => !o)}
              style={{ display:"flex", alignItems:"center", gap:8, width:"100%", textAlign:"left", background:"rgba(60,110,255,.06)", border:"1px solid rgba(60,110,255,.2)", borderRadius:"10px", padding:"9px 12px", color:"#bbb", cursor:"pointer", fontSize:"0.85rem", fontWeight:600 }}>
              <span style={{ color:BLUE_L, transform: recvOpen ? "rotate(90deg)" : "none", transition:"transform .15s", display:"inline-block" }}>▸</span>
              Opening stock <span style={{ color:"#555", fontWeight:500, fontStyle:"italic" }}>· optional — leave blank if not counted yet</span>
            </button>
            {recvOpen && (
              <div style={{ marginTop:"0.75rem", background:"rgba(12,16,30,.55)", backdropFilter:"blur(14px)", WebkitBackdropFilter:"blur(14px)", border:"1px solid rgba(120,150,255,.16)", borderRadius:RADIUS, padding:"1rem", boxShadow:"inset 0 1px 0 rgba(255,255,255,.05)" }}>
                {/* Destination — required, no default. */}
                <div style={{ marginBottom:"0.85rem" }}>
                  <div style={{ fontSize:"0.7rem", color:"#888", textTransform:"uppercase", letterSpacing:".04em", marginBottom:4 }}>Receive into <span style={{ color:"#F87171" }}>*required</span></div>
                  <LocationPicker registry={recvRegistry} value={recvLoc} onChange={setRecvLoc} filter={transferTargets} />
                </div>
                {form.sizes.length === 0 ? (
                  <div style={{ color:"#666", fontSize:"0.82rem", textAlign:"center", padding:"0.5rem" }}>Select sizes above, then enter how many of each you're receiving.</div>
                ) : (
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(64px, 1fr))", gap:"0.6rem" }}>
                    {formSizeChoices.filter(s => form.sizes.includes(s)).map(s => (
                      <div key={s} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                        <div style={{ fontSize:"0.85rem", fontWeight:700, color:BLUE_L }}>{s}</div>
                        <div style={{ color:"rgba(120,150,255,.5)", fontSize:"0.9rem", lineHeight:1 }}>↓</div>
                        <input type="number" inputMode="numeric" min="0" placeholder="0"
                          value={recvQtys[s] ?? ""}
                          onChange={e => setRecvQtys(q => ({ ...q, [s]: e.target.value }))}
                          style={{ ...inputStyle, width:"100%", boxSizing:"border-box", textAlign:"center", padding:"8px 4px" }} />
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ fontSize:"0.75rem", color:"#666", marginTop:"0.75rem" }}>
                  Entered amounts are received into <span style={{ color:"#4ADE80" }}>{labelFor(recvLoc, recvRegistry)}</span> as ledger movements on save. Saving with no quantities works exactly as before.
                </div>
              </div>
            )}
          </div>

          <div style={{ color:"#888", fontSize:"0.8rem", marginBottom:"0.5rem" }}>Hubs (select at least one)</div>
          <div style={{ display:"flex", gap:"0.5rem", marginBottom:"0.5rem", flexWrap:"wrap" }}>
            {[["hub1","Hub 1"],["hub2","Hub 2"],["hub3","Hub 3"]].map(([val, label]) => {
              const disabled = form.productType === "clothing" && val === "hub1";
              const checked  = form.hubs.includes(val) && !disabled;
              return (
                <button key={val} disabled={disabled} onClick={() => toggleHub(val)}
                  style={{ padding:"6px 20px", borderRadius:"8px", border:"2px solid", borderColor: checked?BLUE:"rgba(60,110,255,.15)", background: checked?"rgba(60,110,255,.12)":"transparent", color: disabled?"#333":(checked?BLUE_L:"#666"), cursor: disabled?"not-allowed":"pointer", fontWeight:"600", fontSize:"0.9rem", opacity: disabled?0.5:1 }}>
                  {label}
                </button>
              );
            })}
          </div>
          {form.productType === "clothing"
            ? <div style={{ fontSize:"0.78rem", color:"#555", marginBottom:"1.25rem", fontStyle:"italic" }}>Clothing cannot be stocked at Hub 1.</div>
            : <div style={{ marginBottom:"0.75rem" }}/>}

          {/* POS Phase 2: pricing block. Two optional price inputs (ZAR) plus
              a shoebox checkbox. The shoebox checkbox auto-syncs from category
              / productType until the user manually toggles it. */}
          <div style={{ color:"#888", fontSize:"0.8rem", marginBottom:"0.5rem" }}>Pricing (ZAR, optional)</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"1rem", marginBottom:"1rem" }}>
            <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="Stock Price (R)" value={form.stockPrice}  onChange={e => setForm(f=>({...f, stockPrice:  e.target.value}))} style={inputStyle} />
            <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="Retail Price (R)" value={form.retailPrice} onChange={e => setForm(f=>({...f, retailPrice: e.target.value}))} style={inputStyle} />
          </div>
          {/* Shoebox option — sneakers only. Clothing never ships with a
              shoebox, so the toggle is hidden and the flag forced false. */}
          {form.productType !== "clothing" && (
          <label style={{ display:"flex", alignItems:"center", gap:10, marginBottom:"1.25rem", cursor:"pointer", color:"#ccc", fontSize:"0.9rem" }}>
            <input type="checkbox" checked={!!form.hasShoeBoxOption} onChange={toggleShoebox} style={{ width:18, height:18, accentColor:BLUE, cursor:"pointer" }} />
            Shoebox option
            <span style={{ color:"#555", fontSize:"0.78rem", fontStyle:"italic", marginLeft:4 }}>(auto-checked for footwear)</span>
          </label>
          )}

          {/* POS Phase 2 (scanner workflow): SKU + barcode are auto-assigned
              sequentially at save time via reserveNextSkuAndBarcode(). No
              manual entry — the values appear read-only in the product
              detail screen after creation. */}
          <div style={{ color:"#555", fontSize:"0.78rem", marginBottom:"1.25rem", fontStyle:"italic" }}>
            SKU + barcode will be auto-assigned on save.
          </div>

          <button onClick={addProduct}
                  disabled={saving || !form.name || form.sizes.length === 0 || form.hubs.length === 0}
                  style={{ ...bBlue, padding:"0.6rem 1.5rem", opacity: (!saving && form.name && form.sizes.length > 0 && form.hubs.length > 0) ? 1 : 0.4 }}>
            {saving ? "Uploading…" : "Save Product"}
          </button>
        </div>
      )}

      {/* TYPE TABS — manage Sneakers and Clothing separately. */}
      <div style={{ display:"flex", background:"rgba(255,255,255,.04)", border:"1px solid rgba(60,110,255,.25)", borderRadius:12, padding:3, gap:2, marginBottom:14 }}>
        {[["sneaker","Sneakers"],["clothing","Clothing"]].map(([val, label]) => {
          const on = typeFilter === val;
          const count = products.filter(p => (p.productType || "sneaker") === val).length;
          return (
            <button key={val} onClick={() => setTypeFilter(val)}
              style={{ flex:1, padding:"8px 6px", borderRadius:9, border:"none", cursor:"pointer", fontSize:13, fontWeight:700,
                       background: on ? "rgba(60,110,255,.25)" : "transparent",
                       color: on ? "#fff" : "rgba(255,255,255,.5)",
                       boxShadow: on ? "0 0 6px rgba(60,110,255,.35)" : "none" }}>
              {label} <span style={{ opacity:.7, fontWeight:600 }}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* PRODUCT SEARCH BAR (Phase 12A) */}
      <div style={{ marginBottom:14 }}>
        <input
          placeholder="Search products by name…"
          value={productSearch}
          onChange={e => setProductSearch(e.target.value)}
          style={{ ...inputStyle, fontSize:14, padding:"10px 14px" }}
        />
      </div>

      {/* CLEAN PRODUCT LIST — each row is a navigation target (taps push
          #product/{id} via AdminProductRow). All edit affordances moved to
          AdminProductDetail. */}
      <div>
        {filteredProducts.length === 0 && (
          <div style={{ textAlign:"center", color:"#555", padding:"2.5rem 1rem", fontSize:"0.9rem" }}>
            {productSearch.trim() ? "No products match your search." : `No ${typeFilter === "clothing" ? "clothing" : "sneaker"} products yet. Add one above.`}
          </div>
        )}
        {filteredProducts.map(p => <AdminProductRow key={p.id} product={p} />)}
      </div>
      <div style={{ height:20 }}/>
        </div>
      </div>

      {/* Inline Print-barcodes sheet (#73), surfaced after a save with opening
          stock. Lives here (not in the unmounting New Product form) so it persists. */}
      {printOpen && lastReceived && (
        <BarcodePrint
          product={{ id: lastReceived.productId, name: lastReceived.productName, photoUrl: lastReceived.photoUrl }}
          items={lastReceived.items}
          onClose={() => setPrintOpen(false)}
        />
      )}
    </div>
  );
}

// ─── ADMIN PRODUCT ROW ───────────────────────────────────────────────────────
// Compact tappable card in the admin list. Single-line metadata combines
// type, hubs, and size count. Tap anywhere on the row → hash navigates to
// #product/{id} which AdminView's hashchange listener catches.
function AdminProductRow({ product }) {
  const isClothing = (product.productType || "sneaker") === "clothing";
  const hubs       = getProductHubs(product);
  const hubLabel   = hubs.length ? hubs.map(h => HUB_LABELS[h] || h).join(", ") : "—";
  const sizes      = Array.isArray(product.sizes) ? product.sizes : [];
  const sizeCount  = sizes.length || (isClothing && product.stock ? Object.keys(product.stock).length : 0);
  const meta       = `${isClothing ? "Clothing" : "Sneaker"} · ${hubLabel} · ${sizeCount} size${sizeCount === 1 ? "" : "s"}`;

  return (
    <div onClick={() => { window.location.hash = "product/" + product.id; }}
         style={{
           display:"flex", alignItems:"center", gap:12,
           background:"rgba(255,255,255,.03)",
           border:"1px solid rgba(255,255,255,.07)",
           borderRadius:14, padding:"10px 14px", marginBottom:8, cursor:"pointer",
         }}>
      <ProductPhoto url={product.photoUrl} photo={product.photo} size={56} radius={10}/>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:16, fontWeight:600, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{product.name}</div>
        <div style={{ fontSize:12, color:"rgba(255,255,255,.5)", marginTop:4, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{meta}</div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>
  );
}

// ─── ADMIN PRODUCT DETAIL ────────────────────────────────────────────────────
// Full-page edit surface reached via #product/{id}. Every field auto-saves
// — name on blur, type/sizes/hubs on every toggle. Photo replace runs the
// existing compression pipeline and uploads immediately on file pick (no
// preview step; consistent with the auto-save theme). Delete prompts for
// confirmation then navigates back.
function AdminProductDetail({ product, insightsLog, onBack }) {
  const isClothing = (product.productType || "sneaker") === "clothing";
  const productSizes = Array.isArray(product.sizes) && product.sizes.length
    ? product.sizes
    : (isClothing && product.stock ? Object.keys(product.stock) : []);
  const productHubs = getProductHubs(product);
  // Clothing products may use letters (tops) or the waist set (bottoms) — infer which
  // from the product's own sizes so editing shows the right breakdown.
  const sizeChoices = isClothing ? clothingChoicesFor(productSizes) : SNEAKER_SIZES;

  // Name — local draft synced from RTDB, write on blur.
  const [nameDraft, setNameDraft] = useState(product.name);
  useEffect(() => { setNameDraft(product.name); }, [product.name]);
  const saveName = () => {
    const next = nameDraft.trim();
    if (next && next !== product.name) updateProductName(product.id, next);
    else if (!next) setNameDraft(product.name);
  };

  // Photo — pick file → compress in-browser → upload → set photoUrl. No
  // preview/confirm; the upload is the action. Compression pipeline is the
  // same one used by the Add Product form (800px max-dim, step quality down
  // until <200 KB).
  const fileRef = useRef(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const handlePhotoFile = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setPhotoUploading(true);
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = async () => {
        try {
          const MAX_DIM = 800;
          const MAX_BYTES = 200 * 1024;
          const scale = Math.min(1, MAX_DIM / img.width, MAX_DIM / img.height);
          const canvas = document.createElement("canvas");
          canvas.width  = Math.round(img.width  * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          let dataUrl = canvas.toDataURL("image/jpeg", 0.05);
          for (let q = 0.85; q > 0.05; q = Math.round((q - 0.05) * 100) / 100) {
            const candidate = canvas.toDataURL("image/jpeg", q);
            if (candidate.length * 0.75 <= MAX_BYTES) { dataUrl = candidate; break; }
          }
          const blob = dataURLToBlob(dataUrl);
          const sRef = storageRef(storage, `products/${product.id}/photo.jpg`);
          await uploadBytes(sRef, blob, { contentType: "image/jpeg" });
          const url = await getDownloadURL(sRef);
          await update(ref(database, `products/${product.id}`), { photoUrl: url });
        } catch (err) {
          console.error("photo upload failed:", err);
          alert("Failed to save photo. Please try again.");
        } finally {
          setPhotoUploading(false);
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  const removePhoto = async () => {
    if (!product.photoUrl) return;
    if (!window.confirm(`Remove the photo for "${product.name}"?`)) return;
    await update(ref(database, `products/${product.id}`), { photoUrl: null });
  };

  // Type — switching to Clothing strips Hub 1 (mirrors the Add Product
  // form's setProductType helper). Double-writes `hub` for back-compat per
  // the project-broadcast-api-async/14A double-write pattern.
  const setType = (nextType) => {
    if (nextType === (product.productType || "sneaker")) return;
    const patch = { productType: nextType };
    if (nextType === "clothing") {
      const stripped = productHubs.filter(h => h !== "hub1");
      patch.hubs = stripped.length ? stripped : ["hub2"];
      patch.hub  = patch.hubs[0];
      // Clothing never has a shoebox — clear the flag when converting.
      patch.hasShoeBoxOption = false;
    }
    update(ref(database, `products/${product.id}`), patch);
  };

  const toggleSize = (s) => {
    const next = productSizes.includes(s)
      ? productSizes.filter(x => x !== s)
      : [...productSizes, s];
    updateProductSizes(product.id, next);
    // GUARANTEE ON EDIT: mint barcodes for the (possibly new) size set so editing
    // a product never leaves a size without a code. Best-effort; idempotent
    // (ensureBarcode reuses any existing slot, only newly-added sizes get a code).
    ensureBarcodes(product.id, next.length ? next : [null]).catch(() => {});
  };

  const toggleHub = (h) => {
    if (isClothing && h === "hub1") return;
    const next = productHubs.includes(h)
      ? productHubs.filter(x => x !== h)
      : [...productHubs, h];
    if (next.length === 0) return; // require ≥1 hub
    updateProductHubs(product.id, next);
  };

  // POS Phase 2: local drafts for the two price fields so the input still
  // works while typing (decimals, partial values like "12."). Synced from
  // RTDB on mount and on external change, written back on blur. Empty input
  // → write null so the POS reader sees "not set" instead of 0.
  const [stockPriceDraft,  setStockPriceDraft]  = useState(typeof product.stockPrice  === "number" ? String(product.stockPrice)  : "");
  const [retailPriceDraft, setRetailPriceDraft] = useState(typeof product.retailPrice === "number" ? String(product.retailPrice) : "");
  useEffect(() => { setStockPriceDraft( typeof product.stockPrice  === "number" ? String(product.stockPrice)  : ""); }, [product.stockPrice]);
  useEffect(() => { setRetailPriceDraft(typeof product.retailPrice === "number" ? String(product.retailPrice) : ""); }, [product.retailPrice]);
  const savePrice = (field, draft) => {
    const trimmed = String(draft).trim();
    if (trimmed === "") {
      update(ref(database, `products/${product.id}`), { [field]: null })
        .catch(err => console.warn(`update ${field} failed:`, err));
      return;
    }
    const num = Number(trimmed);
    // Reject 0 (and negatives / NaN) — matching the create flow's `> 0` rule.
    // The POS contract is that prices are unset/null, never `0` (a free price
    // would mis-ring at checkout). Restore the previous value from RTDB.
    if (!Number.isFinite(num) || num <= 0) {
      if (field === "stockPrice")  setStockPriceDraft( typeof product.stockPrice  === "number" ? String(product.stockPrice)  : "");
      if (field === "retailPrice") setRetailPriceDraft(typeof product.retailPrice === "number" ? String(product.retailPrice) : "");
      return;
    }
    update(ref(database, `products/${product.id}`), { [field]: num })
      .catch(err => console.warn(`update ${field} failed:`, err));
  };
  const toggleShoebox = () => {
    if (isClothing) return; // clothing never has a shoebox
    const next = !(product.hasShoeBoxOption === true);
    update(ref(database, `products/${product.id}`), { hasShoeBoxOption: next })
      .catch(err => console.warn("update hasShoeBoxOption failed:", err));
  };

  // POS Phase 2 (scanner workflow): sku + barcode are auto-assigned at
  // create time (reserveNextSkuAndBarcode + addProduct) and are displayed
  // read-only here. Editing would break the sequential invariant the POS
  // scanner workflow depends on, so there are intentionally no setters.
  // Legacy / backfilled values appear here exactly as stored; products that
  // pre-date the backfill render as "—" until PR B's script runs.

  const handleDelete = () => {
    if (!window.confirm(`Delete "${product.name}"? This cannot be undone.`)) return;
    deleteProductFromFirebase(product.id);
    onBack();
  };

  // Activity line — "Last sold X days ago · N orders all-time" from
  // insights_log (orders/{id} is daily-counter-ephemeral so can't be trusted
  // for historical aggregates; see project-insights-past-days-pattern memory).
  const activity = useMemo(() => {
    const productLog = insightsLog.filter(e => e.productName === product.name);
    const placed     = productLog.filter(e => e.action === "placed");
    const sold       = productLog.filter(e => e.action === "collected" || e.action === "ready");
    let lastSoldLabel = "Never sold";
    if (sold.length > 0) {
      const ts = sold[0].timestamp; // log is sorted newest-first
      if (ts) {
        const daysAgo = Math.floor((Date.now() - new Date(ts).getTime()) / (24*60*60*1000));
        if (daysAgo <= 0)    lastSoldLabel = "Last sold today";
        else if (daysAgo === 1) lastSoldLabel = "Last sold yesterday";
        else                 lastSoldLabel = `Last sold ${daysAgo} days ago`;
      }
    }
    return `${lastSoldLabel} · ${placed.length} order${placed.length === 1 ? "" : "s"} all-time`;
  }, [insightsLog, product.name]);

  // Restock-existing (Stock rework): the same optional per-size receive as the
  // product-add form, for a product already in the system (re-orders arrive
  // constantly). Its own explicit action — independent of the edits above and
  // never required. Posts `received` movements into the default receiving
  // warehouse via applyMovement; soft-warns (no block) if the user lacks the
  // stockRole the rules require.
  const [recvOpen, setRecvOpen] = useState(false);
  const [recvQtys, setRecvQtys] = useState({});
  const [recvLoc, setRecvLoc] = useState(""); // destination — NO default; must be picked before receiving
  const [recvBusy, setRecvBusy] = useState(false);
  const [recvMsg,  setRecvMsg]  = useState(null);
  const [lastReceived, setLastReceived] = useState(null); // { productId, productName, items:[{size,added}] }
  const [printOpen, setPrintOpen] = useState(false);
  const recvRegistry = useLocations();
  const flashRecv = (ok, text) => { setRecvMsg({ ok, text }); setTimeout(() => setRecvMsg(null), 4000); };
  const doReceive = async () => {
    const entries = productSizes
      .map(s => [s, parseInt(recvQtys[s], 10)])
      .filter(([, n]) => Number.isFinite(n) && n > 0);
    if (!entries.length) return;
    if (!recvLoc) return flashRecv(false, "Choose a destination location to receive into first.");
    setRecvBusy(true);
    let ok = 0, fail = 0; const savedItems = [];
    for (const [size, n] of entries) {
      const res = await applyMovement({ type: "received", productId: product.id, size, qty: n, to: recvLoc });
      if (res.ok) { ok++; savedItems.push({ size, added: n }); }
      else fail++;
    }
    setRecvBusy(false);
    setRecvQtys({});
    const locLabel = labelFor(recvLoc, recvRegistry);
    if (fail) flashRecv(false, `${ok} received, ${fail} failed — you may not have stock permission (stockRole).`);
    else flashRecv(true, `Received ${ok} size${ok > 1 ? "s" : ""} into ${locLabel}.`);
    if (savedItems.length) { setLastReceived({ productId: product.id, productName: product.name, photoUrl: product.photoUrl ?? null, items: savedItems }); setPrintOpen(true); }
  };

  const sectionTitle = { fontSize:12, fontWeight:600, color:"rgba(255,255,255,.5)", textTransform:"uppercase", letterSpacing:"0.06em", padding:"24px 18px 8px" };
  const card         = { background:"rgba(255,255,255,.04)", border:"1px solid rgba(255,255,255,.07)", borderRadius:14, margin:"0 14px", overflow:"hidden" };
  const cardInner    = { padding:"14px 16px" };

  return (
    <div>
      {/* TOP BAR with back chevron */}
      <div style={{ padding:"44px 8px 8px", display:"flex", alignItems:"center" }}>
        <button onClick={onBack}
                style={{ display:"flex", alignItems:"center", gap:4, background:"transparent", border:"none", color:"#4A7FFF", fontSize:15, fontWeight:500, cursor:"pointer", padding:"6px 10px" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Products
        </button>
      </div>

      {/* HEADER */}
      <div style={{ padding:"4px 18px 8px" }}>
        <div style={{ fontSize:22, fontWeight:700, color:"#fff", lineHeight:1.2 }}>{product.name}</div>
        <div style={{ fontSize:13, color:"rgba(255,255,255,.45)", marginTop:6 }}>{activity}</div>
      </div>

      {/* PHOTO */}
      <div style={sectionTitle}>Photo</div>
      <div style={card}>
        <div style={{ ...cardInner, display:"flex", alignItems:"center", gap:14 }}>
          <ProductPhoto url={product.photoUrl} photo={product.photo} size={140} radius={12}/>
          <div style={{ flex:1, display:"flex", flexDirection:"column", gap:8 }}>
            <input ref={fileRef} type="file" accept="image/*" onChange={handlePhotoFile} style={{ display:"none" }} />
            <button onClick={() => fileRef.current?.click()} disabled={photoUploading}
                    style={{ background:"rgba(60,110,255,.12)", border:"1px solid rgba(60,110,255,.3)", color:"#4A7FFF", fontSize:14, fontWeight:600, padding:"10px 14px", borderRadius:10, cursor: photoUploading ? "not-allowed" : "pointer", textAlign:"center", opacity: photoUploading ? 0.5 : 1 }}>
              {photoUploading ? "Uploading…" : "Replace photo"}
            </button>
            {product.photoUrl && (
              <button onClick={removePhoto} disabled={photoUploading}
                      style={{ background:"rgba(180,40,40,.08)", border:"1px solid rgba(180,40,40,.25)", color:"#FF8888", fontSize:14, fontWeight:600, padding:"10px 14px", borderRadius:10, cursor: photoUploading ? "not-allowed" : "pointer", textAlign:"center", opacity: photoUploading ? 0.5 : 1 }}>
                Remove photo
              </button>
            )}
          </div>
        </div>
      </div>

      {/* NAME */}
      <div style={sectionTitle}>Name</div>
      <div style={card}>
        <div style={cardInner}>
          <input value={nameDraft}
                 onChange={e => setNameDraft(e.target.value)}
                 onBlur={saveName}
                 onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                 style={{ width:"100%", background:"transparent", border:"none", outline:"none", color:"#fff", fontSize:17, fontWeight:500, padding:0, fontFamily:"inherit" }}/>
        </div>
      </div>

      {/* TYPE */}
      <div style={sectionTitle}>Type</div>
      <div style={card}>
        <div style={{ display:"flex", padding:"6px" }}>
          {[["sneaker","Sneaker"],["clothing","Clothing"]].map(([val, label]) => {
            const on = (product.productType || "sneaker") === val;
            return (
              <button key={val} onClick={() => setType(val)}
                      style={{ flex:1, padding:"10px 0", borderRadius:10, border:"none", cursor:"pointer", fontSize:14, fontWeight:600,
                               background: on ? "rgba(60,110,255,.18)" : "transparent",
                               color: on ? "#4A7FFF" : "rgba(255,255,255,.55)" }}>
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* SIZES */}
      <div style={sectionTitle}>Available sizes</div>
      <div style={card}>
        <div style={{ ...cardInner, display:"flex", gap:6, flexWrap:"wrap" }}>
          {sizeChoices.map(s => {
            const on = productSizes.includes(s);
            return (
              <button key={s} onClick={() => toggleSize(s)}
                      style={{ padding:"7px 14px", borderRadius:8, border:`1px solid ${on ? "#4A7FFF" : "rgba(255,255,255,.1)"}`, background: on ? "rgba(60,110,255,.18)" : "rgba(255,255,255,.03)", color: on ? "#4A7FFF" : "rgba(255,255,255,.7)", cursor:"pointer", fontSize:13, fontWeight:600 }}>{s}</button>
            );
          })}
        </div>
      </div>

      {/* RECEIVE STOCK (restock existing) — Stock rework. Optional per-size
          receive into a chosen location for a re-order; independent of the edits
          above, never required. Mirrors the product-add opening-stock section. */}
      <div style={sectionTitle}>Receive stock</div>
      <div style={card}>
        <div style={cardInner}>
          <button onClick={() => setRecvOpen(o => !o)}
            style={{ display:"flex", alignItems:"center", gap:8, width:"100%", textAlign:"left", background:"transparent", border:"none", color:"#bbb", cursor:"pointer", fontSize:13, fontWeight:600, padding:0 }}>
            <span style={{ color:"#6A9FFF", transform: recvOpen ? "rotate(90deg)" : "none", transition:"transform .15s", display:"inline-block" }}>▸</span>
            Add re-order quantities <span style={{ color:"#555", fontWeight:500, fontStyle:"italic" }}>· optional</span>
          </button>
          {recvOpen && (
            <div style={{ marginTop:14 }}>
              {/* Destination — required, no default. Must be picked before receiving. */}
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:"#888", textTransform:"uppercase", letterSpacing:".04em", marginBottom:4 }}>Receive into <span style={{ color:"#F87171" }}>*required</span></div>
                <LocationPicker registry={recvRegistry} value={recvLoc} onChange={setRecvLoc} filter={transferTargets} />
              </div>
              {productSizes.length === 0 ? (
                <div style={{ color:"#666", fontSize:13 }}>Add sizes above first.</div>
              ) : (
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(64px, 1fr))", gap:10 }}>
                  {sizeChoices.filter(s => productSizes.includes(s)).map(s => (
                    <div key={s} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                      <div style={{ fontSize:13, fontWeight:700, color:"#6A9FFF" }}>{s}</div>
                      <div style={{ color:"rgba(120,150,255,.5)", fontSize:14, lineHeight:1 }}>↓</div>
                      <input type="number" inputMode="numeric" min="0" placeholder="0"
                        value={recvQtys[s] ?? ""}
                        onChange={e => setRecvQtys(q => ({ ...q, [s]: e.target.value }))}
                        style={{ ...inputStyle, width:"100%", boxSizing:"border-box", textAlign:"center", padding:"8px 4px" }} />
                    </div>
                  ))}
                </div>
              )}
              <button onClick={doReceive} disabled={recvBusy || !recvLoc}
                style={{ ...bBlue, padding:"0.55rem 1.25rem", marginTop:14, opacity: (recvBusy || !recvLoc) ? 0.5 : 1 }}>
                {recvBusy ? "Receiving…" : recvLoc ? `Receive into ${labelFor(recvLoc, recvRegistry)}` : "Pick a destination first"}
              </button>
              {recvMsg && <div style={{ marginTop:10, fontSize:12.5, fontWeight:600, color: recvMsg.ok ? "#4ADE80" : "#FF9B9B" }}>{recvMsg.text}</div>}
              <div style={{ fontSize:11, color:"#666", marginTop:8 }}>
                Posts <span style={{ color:"#4ADE80" }}>received</span> movements; changes nothing else on this product.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* PRICING — POS Phase 2. Two optional ZAR price inputs (saved on blur)
          plus a shoebox checkbox. Blank input is allowed and writes null. */}
      <div style={sectionTitle}>Pricing (ZAR)</div>
      <div style={card}>
        <div style={{ display:"flex", padding:"0", borderBottom:"1px solid rgba(255,255,255,.06)" }}>
          <div style={{ flex:1, padding:"14px 16px", borderRight:"1px solid rgba(255,255,255,.06)" }}>
            <div style={{ fontSize:11, color:"rgba(255,255,255,.45)", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Stock Price</div>
            <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="—"
                   value={stockPriceDraft}
                   onChange={e => setStockPriceDraft(e.target.value)}
                   onBlur={() => savePrice("stockPrice", stockPriceDraft)}
                   onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                   style={{ width:"100%", background:"transparent", border:"none", outline:"none", color:"#fff", fontSize:17, fontWeight:500, padding:0, fontFamily:"inherit" }}/>
          </div>
          <div style={{ flex:1, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:"rgba(255,255,255,.45)", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Retail Price</div>
            <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="—"
                   value={retailPriceDraft}
                   onChange={e => setRetailPriceDraft(e.target.value)}
                   onBlur={() => savePrice("retailPrice", retailPriceDraft)}
                   onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                   style={{ width:"100%", background:"transparent", border:"none", outline:"none", color:"#fff", fontSize:17, fontWeight:500, padding:0, fontFamily:"inherit" }}/>
          </div>
        </div>
        {/* Shoebox option — sneakers only; clothing never ships with one. */}
        {!isClothing && (
        <div onClick={toggleShoebox}
             style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px", cursor:"pointer" }}>
          <div style={{ fontSize:15, color:"#fff", fontWeight:500 }}>Shoebox option</div>
          <div style={{
            width:24, height:24, borderRadius:6,
            background: product.hasShoeBoxOption === true ? "#4A7FFF" : "rgba(255,255,255,.06)",
            border:     product.hasShoeBoxOption === true ? "none" : "1px solid rgba(255,255,255,.18)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            {product.hasShoeBoxOption === true && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            )}
          </div>
        </div>
        )}
      </div>

      {/* IDENTIFIERS — POS Phase 2 (scanner workflow). Read-only display of
          the sku + barcode auto-assigned at create time. Editing is
          intentionally not exposed: a manual change would break the
          sequential invariant the POS scanner workflow depends on. Legacy
          products that pre-date the backfill render "—" until PR B runs. */}
      <div style={sectionTitle}>Identifiers</div>
      <div style={card}>
        <div style={{ display:"flex", padding:"0" }}>
          <div style={{ flex:1, padding:"14px 16px", borderRight:"1px solid rgba(255,255,255,.06)" }}>
            <div style={{ fontSize:11, color:"rgba(255,255,255,.45)", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Barcode</div>
            <div style={{ color:"#fff", fontSize:17, fontWeight:500, fontFamily:"'SF Mono', Menlo, monospace" }}>
              {(typeof product.barcode === "string" && product.barcode.trim().length > 0) ? product.barcode : "—"}
            </div>
          </div>
          <div style={{ flex:1, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:"rgba(255,255,255,.45)", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>SKU</div>
            <div style={{ color:"#fff", fontSize:17, fontWeight:500, fontFamily:"'SF Mono', Menlo, monospace" }}>
              {(typeof product.sku === "string" && product.sku.trim().length > 0) ? product.sku : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* HUBS — iOS-style grouped list */}
      <div style={sectionTitle}>Hubs</div>
      <div style={card}>
        {[["hub1","Hub 1"],["hub2","Hub 2"],["hub3","Hub 3 — Pine"]].map(([val, label], i) => {
          const disabled = isClothing && val === "hub1";
          const on       = productHubs.includes(val) && !disabled;
          const isLast   = i === 2;
          return (
            <div key={val}>
              <div onClick={() => !disabled && toggleHub(val)}
                   style={{
                     display:"flex", alignItems:"center", justifyContent:"space-between",
                     padding:"14px 16px",
                     cursor: disabled ? "not-allowed" : "pointer",
                     opacity: disabled ? 0.4 : 1,
                   }}>
                <div style={{ fontSize:15, color:"#fff", fontWeight:500 }}>{label}</div>
                <div style={{
                  width:24, height:24, borderRadius:6,
                  background: on ? "#4A7FFF" : "rgba(255,255,255,.06)",
                  border: on ? "none" : "1px solid rgba(255,255,255,.18)",
                  display:"flex", alignItems:"center", justifyContent:"center",
                }}>
                  {on && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                </div>
              </div>
              {!isLast && <div style={{ height:1, background:"rgba(255,255,255,.06)", margin:"0 16px" }}/>}
            </div>
          );
        })}
      </div>
      {isClothing && (
        <div style={{ padding:"8px 18px 0", fontSize:12, color:"rgba(255,255,255,.4)", fontStyle:"italic" }}>
          Clothing cannot be stocked at Hub 1.
        </div>
      )}

      {/* DELETE */}
      <div style={{ height:1, background:"rgba(255,255,255,.08)", margin:"32px 14px 16px" }}/>
      <div style={{ padding:"0 14px 28px" }}>
        <button onClick={handleDelete}
                style={{ width:"100%", background:"rgba(220,38,38,.1)", border:"1px solid rgba(220,38,38,.35)", color:"#F87171", fontSize:15, fontWeight:600, padding:"14px", borderRadius:12, cursor:"pointer" }}>
          Delete product
        </button>
      </div>

      {/* Inline Print-barcodes sheet (#73), surfaced after a re-order receive. */}
      {printOpen && lastReceived && (
        <BarcodePrint
          product={{ id: lastReceived.productId, name: lastReceived.productName, photoUrl: lastReceived.photoUrl }}
          items={lastReceived.items}
          onClose={() => setPrintOpen(false)}
        />
      )}
    </div>
  );
}

// ─── ASSISTANT VIEW ───────────────────────────────────────────────────────────
// Multi-item cart flow:
//   1. Tap product → size picker sheet → "Add to Cart"
//   2. Repeat for more items, or tap "Checkout"
//   3. Checkout sheet: review cart, enter customer details once, Place Order
//   4. One Firebase order per cart item, own order number + WA message each.
// ─── ASSISTANT: CLOTHING PRODUCT CARD (Phase 12B) ─────────────────────────────
// Renders one clothing product with per-size qty steppers. Each card owns its
// own draft qty state. Tapping "Add to Cart" reports cart lines back to the
// parent (one per non-zero size) and resets the draft to zeros.
function ClothingCard({ product, onAdd, onViewPhoto }) {
  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  // Initial state: every available size starts at 0.
  const [qty, setQty] = useState(() => sizes.reduce((m, s) => (m[s] = 0, m), {}));
  // If the product's size list changes (admin edit), preserve any existing
  // counts for sizes that remain and zero out the rest.
  useEffect(() => {
    setQty(prev => sizes.reduce((m, s) => (m[s] = prev[s] || 0, m), {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizes.join("|")]);

  const total = Object.values(qty).reduce((n, v) => n + (v || 0), 0);
  const bump = (sz, delta) => setQty(prev => ({ ...prev, [sz]: Math.max(0, (prev[sz] || 0) + delta) }));
  const handleAdd = () => {
    const lines = Object.entries(qty)
      .filter(([, n]) => n > 0)
      .map(([size, n]) => ({ product, size, qty: n, productType: "clothing" }));
    if (lines.length === 0) return;
    onAdd(lines);
    setQty(sizes.reduce((m, s) => (m[s] = 0, m), {}));
  };

  return (
    <div style={{ background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.06)", borderRadius:12, overflow:"hidden" }}>
      <div style={{ display:"flex", gap:12, padding:"12px 13px 0" }}>
        <div onClick={product.photoUrl && onViewPhoto ? () => onViewPhoto(product.photoUrl) : undefined}
             title={product.photoUrl ? "View full photo" : undefined}
             style={{ width:96, height:96, flexShrink:0, background:"rgba(255,255,255,.05)", borderRadius:10, overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center", cursor: product.photoUrl && onViewPhoto ? "zoom-in" : "default" }}>
          {product.photoUrl
            ? <img src={product.photoUrl} alt={product.name} style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
            : <span style={{ fontSize:36 }}>{product.photo}</span>}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:15, fontWeight:700, color:"#fff", marginBottom:8 }}>{product.name}</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {sizes.map(sz => {
              const n = qty[sz] || 0;
              return (
                <div key={sz} style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ minWidth:42, padding:"3px 8px", borderRadius:7, background:"rgba(60,110,255,.1)", border:"1px solid rgba(60,110,255,.25)", color:BLUE_L, fontSize:12, fontWeight:700, textAlign:"center" }}>{sz}</div>
                  <button onClick={() => bump(sz, -1)} disabled={n === 0}
                    style={{ width:28, height:28, borderRadius:7, border:"1px solid rgba(255,255,255,.12)", background: n === 0 ? "rgba(255,255,255,.02)" : "rgba(60,110,255,.08)", color: n === 0 ? "rgba(255,255,255,.25)" : BLUE_L, fontSize:16, fontWeight:700, cursor: n === 0 ? "not-allowed" : "pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>
                    −
                  </button>
                  <div style={{ minWidth:24, textAlign:"center", fontSize:14, fontWeight:700, color: n > 0 ? "#fff" : "rgba(255,255,255,.4)" }}>{n}</div>
                  <button onClick={() => bump(sz, 1)}
                    style={{ width:28, height:28, borderRadius:7, border:"1px solid rgba(60,110,255,.35)", background:"rgba(60,110,255,.12)", color:BLUE_L, fontSize:16, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>
                    +
                  </button>
                </div>
              );
            })}
            {sizes.length === 0 && (
              <div style={{ color:"rgba(255,255,255,.4)", fontSize:12, fontStyle:"italic" }}>No sizes set up for this product yet.</div>
            )}
          </div>
        </div>
      </div>
      <div style={{ padding:"10px 13px 12px" }}>
        <button onClick={handleAdd} disabled={total === 0}
          style={{ width:"100%", padding:"9px 12px", borderRadius:10, fontSize:13, fontWeight:700, cursor: total === 0 ? "not-allowed" : "pointer",
                   background: total === 0 ? "rgba(255,255,255,.03)" : "rgba(0,150,70,.2)",
                   border: total === 0 ? "1px solid rgba(255,255,255,.06)" : "1px solid rgba(0,180,80,.4)",
                   color: total === 0 ? "rgba(255,255,255,.3)" : "#4ADE80",
                   display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          {total === 0 ? "Add quantities to add" : `Add ${total} item${total !== 1 ? "s" : ""} to cart`}
        </button>
      </div>
    </div>
  );
}

// ─── SHOP STOCK (read-only) ───────────────────────────────────────────────────
// Splits the old single shop view into the three physical shops — Marathon PE,
// Trophy, Pine — each reading its OWN /stock/{shopId} location (the sellable
// store locations from the registry: marathon-pe / trophy / marathon-pine). This
// is visibility ONLY: per-size on-hand per shop, no writes, no movement logic,
// and entirely separate from the Central/Pine order-routing toggle (which is
// unchanged). Reads the same /stock cells the Set Qty / Locator / POS use, so the
// numbers can't disagree.
function ShopStockList({ shopId, products, registry }) {
  const cells = useStockCells(shopId);   // /stock/{shopId} → { pid: { size: cell } }
  const rows = useMemo(() => {
    return [...(products || [])]
      .filter(p => p && p.id && p.name && cells?.[p.id])
      .map(p => {
        const bySize = cells[p.id] || {};
        const sizes = Object.keys(bySize)
          .map(sz => ({ sz, qty: typeof bySize[sz]?.qty === "number" ? bySize[sz].qty : 0 }))
          .sort((a, b) => String(a.sz).localeCompare(String(b.sz), undefined, { numeric: true }));
        return { id: p.id, name: p.name, sizes, total: sizes.reduce((s, x) => s + x.qty, 0) };
      })
      .filter(r => r.sizes.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [cells, products]);

  if (!rows.length) {
    return (
      <div style={{ color:"rgba(255,255,255,.4)", fontSize:12.5, textAlign:"center", padding:"16px 8px" }}>
        No stock recorded at {labelFor(shopId, registry)} yet.
      </div>
    );
  }
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      {rows.map(r => (
        <div key={r.id} style={{ background:"rgba(255,255,255,.03)", border:"1px solid rgba(60,110,255,.15)", borderRadius:10, padding:"9px 11px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:5 }}>
            <span style={{ color:"#fff", fontSize:13, fontWeight:600 }}>{r.name}</span>
            <span style={{ color:"rgba(255,255,255,.45)", fontSize:11 }}>{r.total} on hand</span>
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {r.sizes.map(({ sz, qty }) => (
              <span key={sz} style={{ fontSize:11, color: qty > 0 ? "#fff" : "rgba(255,255,255,.35)",
                background: qty > 0 ? "rgba(60,110,255,.12)" : "rgba(255,255,255,.03)",
                border:"1px solid rgba(60,110,255,.18)", borderRadius:7, padding:"2px 7px" }}>
                {sz}: {qty}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ShopStockPanel({ products }) {
  const [open, setOpen] = useState(false);
  const registry = useLocations();
  const shops = sellableLocations(registry);   // marathon-pe, trophy, marathon-pine
  const [shopId, setShopId] = useState(() => shops[0]?.id || "marathon-pe");
  useEffect(() => {
    if (shops.length && !shops.some(s => s.id === shopId)) setShopId(shops[0].id);
  }, [shops, shopId]);

  return (
    <div style={{ padding:"0 14px 8px" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
                 background:"rgba(255,255,255,.04)", border:"1px solid rgba(60,110,255,.25)", borderRadius:12,
                 padding:"10px 14px", color:"#fff", cursor:"pointer", fontSize:12.5, fontWeight:700 }}>
        <span>Shop stock <span style={{ color:"rgba(255,255,255,.4)", fontWeight:500 }}>· view only</span></span>
        <span style={{ color:"#6A9FFF", transform: open ? "rotate(90deg)" : "none", transition:"transform .15s" }}>▸</span>
      </button>
      {open && (
        <div style={{ marginTop:8 }}>
          {/* Three shops — the split of the old single combined view. Each reads
              its own /stock location below. */}
          <div style={{ display:"flex", justifyContent:"center", marginBottom:10 }}>
            <div style={{ display:"flex", background:"rgba(255,255,255,.04)", border:"1px solid rgba(60,110,255,.25)", borderRadius:12, padding:3, gap:2 }}>
              {shops.map(s => {
                const on = shopId === s.id;
                return (
                  <button key={s.id} onClick={() => setShopId(s.id)}
                    style={{ padding:"6px 16px", borderRadius:9, border:"none", cursor:"pointer", fontSize:11.5, fontWeight:700,
                             background: on ? "rgba(60,110,255,.25)" : "transparent",
                             color: on ? "#fff" : "rgba(255,255,255,.5)" }}>
                    {labelFor(s.id, registry)}
                  </button>
                );
              })}
            </div>
          </div>
          <ShopStockList shopId={shopId} products={products} registry={registry} />
        </div>
      )}
    </div>
  );
}

function AssistantView({ products, onExit, orders = [] }) {
  const [search, setSearch]                             = useState("");
  // Single 3-way mode selector (replaces the old Sneakers/Clothing toggle +
  // separate Refill/Customer toggle):
  //   "sneaker"  → sneakers, customer order (photo grid + size sheet)
  //   "clothing" → clothing FOR A CUSTOMER → Hub C (same photo grid + size
  //                 sheet UX as sneakers; full customer checkout + Order Queue)
  //   "cr"       → Clothing Refill (bulk multi-size qty list → hub2/hub3)
  // Helpers below derive product-type filtering, the card layout, and the
  // per-line intent from this one value.
  const [mode, setMode]                                 = useState("sneaker");
  const wantsClothing = mode === "clothing" || mode === "cr"; // product-type filter
  const isRefillMode  = mode === "cr";                        // bulk refill card UX
  // SHOP toggle (was the Central/Pine universe toggle). The assistant now picks a
  // physical SHOP — Marathon PE / Trophy / Pine — so each order records WHICH shop
  // it's for (order.destShop), which is what lets dispatch record a real
  // warehouse→shop stock transfer. The central/pine ROUTING universe is derived
  // from the chosen shop via shopUniverse(), so every downstream consumer (product
  // filter, computeHubForItem, placedHub/placedStore) is unchanged. Persists per
  // device so the Pine iPad stays Pine across reloads.
  const shopRegistry = useLocations();
  const allShops = sellableLocations(shopRegistry);  // marathon-pe, trophy, marathon-pine
  const [selectedShop, setSelectedShop] = useState(() => {
    const saved = localStorage.getItem("storeAssistantShop");
    if (saved) return saved;
    // One-time migration from the old central/pine universe key.
    return localStorage.getItem("storeAssistantMode") === "pine" ? "marathon-pine" : "marathon-pe";
  });
  const selectShop = (next) => {
    localStorage.setItem("storeAssistantShop", next);
    setSelectedShop(next);
  };
  // Phase 15: per-user store assignment stays at central/pine granularity
  // (STORE_IDS / storeIds / UserManagement / POS posAccess are untouched).
  // `availableShops` expands that assignment into the physical shops the user may
  // pick: a "central" user → Marathon PE + Trophy; "pine" → Pine. Drives the
  // toggle below: 0 → block screen, 1 → auto-select + hide toggle, ≥2 → show.
  const { storeIds: allowedStores, permRecord: stockPermRecord, isSuperAdmin: stockIsSuperAdmin, hasPermission: stockHasPermission } = usePermissions();
  // Shop-stock visibility: stock permission OR a stock-capable stockRole (mirrors the
  // Stock section gate).
  const canAccessStock = stockIsSuperAdmin || ["warehouse", "admin"].includes(stockPermRecord?.stockRole) || stockHasPermission("stock_management");
  const availableShops = allShops.filter(s => allowedStores.includes(shopUniverse(s.id)));
  const noStoreAccess = availableShops.length === 0;
  const singleShop    = availableShops.length === 1;
  useEffect(() => {
    if (availableShops.length === 0) return;        // block screen handles this
    if (!availableShops.some(s => s.id === selectedShop)) selectShop(availableShops[0].id);
  }, [availableShops, selectedShop]);
  // Clamp at RENDER too: the effect above persists the correction but only runs
  // after commit, so the first paint (and the product filtering / order routing it
  // drives) must use this derived value — never a stale per-device shop the user
  // isn't assigned to.
  const effectiveShop = availableShops.some(s => s.id === selectedShop)
    ? selectedShop
    : (availableShops[0]?.id || selectedShop);
  // Routing universe derived from the chosen shop. THIS keeps every downstream
  // consumer keyed on central/pine unchanged.
  const effectiveStoreMode = shopUniverse(effectiveShop);
  const [selected, setSelected]                         = useState(null);   // product in size picker
  // Tapping a product photo opens a full-screen lightbox so staff can see the
  // complete (uncropped) image. Holds the photo URL to show, or null.
  const [fullPhoto, setFullPhoto]                       = useState(null);
  // Scroll-to-top FAB: appears once the user has scrolled past the search box so
  // a single tap returns to the top (the search bar) after browsing the grid.
  const [showScrollTop, setShowScrollTop]               = useState(false);
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
  const [pendingSize, setPendingSize]                   = useState("");
  const [pendingQty,  setPendingQty]                    = useState(1);
  const [pendingDisplayRequest, setPendingDisplay]      = useState(false);
  const [pendingDisplayPartner, setPendingDisplayPartner] = useState(false);
  // Cart line shape:
  //   sneaker: { product, size, requestDisplay, requestDisplayPartner }
  //   clothing: { product, size, qty, productType:"clothing" }
  const [cart, setCart]                                 = useState([]);
  const [checkoutOpen, setCheckoutOpen]                 = useState(false);
  const [customerName, setCustomerName]                 = useState("");
  const [customerPhone, setCustomerPhone]               = useState("");
  const [marketingOptIn, setMarketingOptIn]             = useState(false);
  const [lastOrders, setLastOrders]                     = useState([]);
  const [submitting, setSubmitting]                     = useState(false);
  // Autocomplete dropdown open-state per input. Tap a suggestion or the
  // "+ Add new" row to dismiss; typing in the input reopens.
  const [nameDropdownOpen, setNameDropdownOpen]   = useState(false);
  const [phoneDropdownOpen, setPhoneDropdownOpen] = useState(false);
  const customerIndex = useCustomerIndex();
  const pickCustomer = (c) => {
    setCustomerName(c.name || "");
    // Existing customers are stored normalised (+27…); show the strict local
    // 0XXXXXXXXX form so the required-phone validation passes.
    setCustomerPhone(toLocalSA(c.phone || ""));
    setNameDropdownOpen(false);
    setPhoneDropdownOpen(false);
  };

  // Filter products by the active mode (sneaker vs clothing) + search box.
  // Existing products without productType are treated as sneakers.
  // SNEAKERS stay store-gated: Phase 14B Central shows hub1/hub2 products, Pine
  // shows hub3. CLOTHING (both customer + refill) is visible to ALL stores — no
  // hub gating — so every assistant can order/refill clothing regardless of
  // which store they're on.
  // Products matching the active mode (sneaker/clothing) + store universe,
  // BEFORE any text search. The fuzzy search runs over this candidate set so a
  // typo can never pull in products from the wrong mode/hub.
  const base = useMemo(() =>
    products.filter(p => {
      const isClothingProduct = (p.productType || "sneaker") === "clothing";
      if (isClothingProduct !== wantsClothing) return false;
      if (!wantsClothing) {
        const hubs = getProductHubs(p);
        if (effectiveStoreMode === "pine") {
          if (!hubs.includes("hub3")) return false;
        } else {
          if (hubs.length && !hubs.includes("hub1") && !hubs.includes("hub2")) return false;
        }
      }
      return true;
    }),
  [products, wantsClothing, effectiveStoreMode]);

  // Fuzzy search (Fuse.js): typo- and case-tolerant matching over name +
  // category. Rebuilt only when `base` changes (memoised — fine for ~1.2k
  // products). Tuned to surface close matches ("avryn"/"avrn"/"avryen" →
  // "Adidas Avryn") without going so loose it returns everything:
  //   threshold 0.4  → moderate fuzziness
  //   ignoreLocation → match anywhere in the string (partial matches)
  //   minMatchCharLength 2 → ignore 1-char noise (1-char queries handled below)
  const fuse = useMemo(() => new Fuse(base, {
    keys: [{ name: "name", weight: 0.85 }, { name: "category", weight: 0.15 }],
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 2,
  }), [base]);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return base;
    // BARCODE / SKU match — typing or SCANNING a product code finds the product
    // directly, not just its name. Matches the product-level barcode + sku and any
    // per-size code (products/{id}/barcodes/{sizeKey}, carried on the product). Exact
    // match for a full scan; 3+ digit substring for partial typing. Code hits come
    // first so a scan jumps straight to the product.
    const codeHits = /\d/.test(q) ? base.filter(p => {
      const codes = [];
      if (p.barcode != null) codes.push(String(p.barcode));
      if (p.sku != null) codes.push(String(p.sku));
      if (p.barcodes && typeof p.barcodes === "object")
        for (const c of Object.values(p.barcodes)) if (c != null) codes.push(String(c));
      return codes.some(c => c === q || (q.length >= 3 && c.includes(q)));
    }) : [];
    const merge = (rest) => {
      if (!codeHits.length) return rest;
      const seen = new Set(codeHits.map(p => p.id));
      return [...codeHits, ...rest.filter(p => !seen.has(p.id))];
    };
    // 1-char queries: Fuse's minMatchCharLength would return nothing, so fall
    // back to a plain case-insensitive substring match for the first letter.
    if (q.length < 2) {
      const lc = q.toLowerCase();
      return merge(base.filter(p =>
        p.name.toLowerCase().includes(lc) || (p.category || "").toLowerCase().includes(lc)));
    }
    return merge(fuse.search(q).map(r => r.item));
  }, [search, base, fuse]);

  // Compute the hub an order placed right now should land in. Single source
  // of truth used for both `hub` (legacy field) and `placedAtHub` (Phase 14B).
  const computeHubForItem = (item) => {
    if (effectiveStoreMode === "pine") return "hub3";
    // Display (partner) requests route to the hub where the PRODUCT actually
    // lives — not a forced global default. (Previously partner requests always
    // returned "hub1"; now they resolve to the product's own hub like every
    // other line, so a hub2 product's display request lands in hub2, etc.)
    return getProductHubs(item.product).find(h => h === "hub1" || h === "hub2") || "hub1";
  };

  const hasClothingInCart = cart.some(it => it.productType === "clothing");
  // Cart-driven submit decision: a line needs the customer Checkout
  // (name/phone/WhatsApp) when it's a sneaker OR a clothing line tagged
  // "customer" (trial). Any such line forces the Checkout flow; an all-refill
  // clothing cart skips the sheet and goes straight through placeRefillRequests.
  const isCustomerLine    = (it) => (it.productType || "sneaker") === "sneaker"
                                 || (it.productType === "clothing" && it.intent === "customer");
  const hasCustomerInCart = cart.some(isCustomerLine);
  // Counts for the action labels: a mixed cart (customer + refill, reachable by
  // switching modes mid-cart) is placed in two steps, so each label should show
  // only the lines its action will actually submit.
  const customerCount     = cart.filter(isCustomerLine).length;
  const refillCount       = cart.length - customerCount;

  const resetSheet = () => { setSelected(null); setPendingSize(""); setPendingQty(1); setPendingDisplay(false); setPendingDisplayPartner(false); };

  const addToCart = () => {
    if (!selected) return;
    // Clothing customer orders use the SAME size-sheet UX as sneakers, but a
    // size is mandatory (no Display Partner for clothing) and each line is
    // tagged clothing/customer so it routes to Hub C via Checkout.
    const isClothingCustomer = (selected.productType || "sneaker") === "clothing";
    if (isClothingCustomer) {
      if (!pendingSize) return;
      const reps = Math.max(1, Math.min(10, pendingQty));
      const line = { product: selected, size: pendingSize, productType: "clothing", intent: "customer" };
      setCart(c => [...c, ...Array.from({ length: reps }, () => ({ ...line }))]);
      resetSheet();
      return;
    }
    // Sneakers: size is optional when a Display Partner request is set.
    if (!pendingSize && !pendingDisplayPartner) return;
    // Quantity expansion: pendingQty > 1 → push N identical cart lines so the
    // warehouse fulfils one box per pair (no "qty" multiplier on a single
    // line). Display Partner rows ignore qty (one-off by nature).
    const reps = (pendingSize && !pendingDisplayPartner)
      ? Math.max(1, Math.min(10, pendingQty))
      : 1;
    const line = { product: selected, size: pendingSize || null, requestDisplay: false, requestDisplayPartner: pendingDisplayPartner };
    setCart(c => [...c, ...Array.from({ length: reps }, () => ({ ...line }))]);
    resetSheet();
  };

  // The bulk ClothingCard (CR / refill mode only) reports a batch of cart lines
  // at once (one per non-zero size). Each line is tagged intent:"refill" so the
  // submit decision sends them through placeRefillRequests (hub2/hub3), never
  // the customer Checkout.
  const addClothingLines = (lines) =>
    setCart(c => [...c, ...lines.map(l => ({ ...l, intent: "refill" }))]);

  const removeFromCart = idx => setCart(c => c.filter((_, i) => i !== idx));

  const openCheckout = () => { resetSheet(); setCheckoutOpen(true); };
  const closeCheckout = () => { setCheckoutOpen(false); setCustomerName(""); setCustomerPhone(""); setMarketingOptIn(false); };

  const placeOrders = async () => {
    if (!cart.length || !customerName || submitting) return;
    // Phone is required for customer orders and must be a valid 10-digit SA
    // number starting with 0 (the Place button enforces this too).
    if (!isValidLocalSAPhone(customerPhone)) return;
    if (noStoreAccess) { alert("No store assigned — contact admin."); return; }
    setSubmitting(true);
    try {
      const normalizedPhone = normalizeSAPhone(customerPhone);
      const now = new Date().toISOString();
      const placed = [];
      // The checkout flow handles every line that needs customer info: sneakers
      // (always) plus clothing tagged "customer" (trial). Clothing "refill"
      // lines stay in the cart and get placed via the floating Place Refill
      // Request bar (different shape, no customer info).
      const customerCart = cart.filter(isCustomerLine);
      for (const item of customerCart) {
        const orderNum = await getNextOrderNumber();
        // Trial: customer clothing orders route to Hub C regardless of the
        // product's hubs or the Central/Pine store mode; sneakers keep their
        // existing hub routing.
        const isClothingCustomer = item.productType === "clothing";
        const placedHub = isClothingCustomer ? "hubC" : computeHubForItem(item);
        const order = {
          id: orderNum,
          productId: item.product.id,
          productName: item.product.name,
          productPhoto: item.product.photo,
          productPhotoUrl: item.product.photoUrl ?? null,
          size: item.size,
          sentSize: null,
          // Explicit type so the warehouse/inference treats a clothing customer
          // order as clothing (size letters already imply it, but be explicit).
          productType: isClothingCustomer ? "clothing" : (item.product.productType || "sneaker"),
          customerName,
          customerPhone: normalizedPhone,
          // Phase 14B: hub mirrors placedAtHub (Central pine routing) — Display
          // Partner stays hub1 in Central; Pine always routes to hub3. Trial:
          // clothing customer orders land in hubC.
          hub: placedHub,
          placedAtHub: placedHub,
          // Record which operational store (central/pine) the order was placed
          // from. The hub usually implies it, but clothing customer orders all
          // route to Hub C, so persist the store explicitly for tracking.
          placedStore: effectiveStoreMode,
          // The physical shop the order is for (marathon-pe / trophy / marathon-pine).
          // Drives the warehouse→shop stock transfer recorded on dispatch.
          destShop: effectiveShop,
          requestDisplay: item.requestDisplay || false,
          requestDisplayPartner: item.requestDisplayPartner || false,
          status: STATUS.INCOMING,
          createdAt: now,
          updatedAt: now,
          readyAt: null,
          outOfStockAt: null,
          comingTomorrowAt: null,
          collectedAt: null,
          // Display partner refill tracking (Phase 9 / 9.5). Populated by Warehouse
          // updateStatus when a partner order transitions to READY; cleared on
          // any revert. Resolved from the product's stocking hub (which the order
          // is now also placed into — display requests route to the product's hub).
          // displayRefillStatus enum: null = active task, 'refilled' = display
          // replenished, 'stockDepleted' = no inventory left to refill (feeds
          // Phase 11 Insights via order filter, no separate log).
          displayRefillScheduledAt:    null,
          displayRefillHub:            null,
          displayRefillStatus:         null,
          displayRefilledAt:           null,
          displayRefillStockDepletedAt:null,
          displayRefilledBy:           null,
        };
        await writeOrder(order);
        logInsight({
          timestamp: now,
          // productId (p{timestamp}) is the durable product key. Logging it on
          // every event lets analytics join on id instead of name-matching,
          // which only resolves ~55-66% of historical events. Consumers still
          // fall back to productName for events written before this field.
          productId: item.product.id,
          productName: item.product.name,
          productCategory: item.product.category || "",
          productType: item.product.productType || "sneaker",
          size: item.size,
          customerName,
          customerPhone: normalizedPhone,
          orderNumber: orderNum,
          action: "placed",
          placedAtHub: placedHub,
        });
        sendWhatsAppTemplate(normalizedPhone, "order_placed", [customerName, orderNum, item.product.name, item.size]);
        placed.push(order);
      }
      if (normalizedPhone) upsertCustomer(normalizedPhone, customerName, now, marketingOptIn);
      setLastOrders(placed);
      // Keep clothing REFILL items in the cart so the user can place them next
      // via the floating Place Refill Request bar. Just-placed customer lines
      // (sneakers + clothing-customer) drop out.
      setCart(prev => prev.filter(it => !isCustomerLine(it)));
      closeCheckout();
    } catch (e) {
      console.error("Failed to place orders:", e);
      alert("Could not place order. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // Phase 12B: places one Firebase order per clothing cart line. No customer
  // info, no WhatsApp send, hub forced to hub2, qty stored on the order.
  // Clothing items are removed from the cart on success; any sneaker items
  // remain (rare — usually clothing-only cart triggers this path).
  const placeRefillRequests = async () => {
    // Refills are clothing lines NOT tagged "customer" (those go through
    // Checkout → Hub C). Call sites already gate on hasCustomerInCart, but
    // keep the filter intent-aware so it stays correct if that ever changes.
    const isRefillLine = (it) => it.productType === "clothing" && it.intent !== "customer";
    const clothingCart = cart.filter(isRefillLine);
    if (!clothingCart.length || submitting) return;
    if (noStoreAccess) { alert("No store assigned — contact admin."); return; }
    setSubmitting(true);
    try {
      const now = new Date().toISOString();
      const placed = [];
      for (const item of clothingCart) {
        const orderNum = await getNextOrderNumber();
        // Phase 14B: Pine clothing refills route to hub3; Central stays on hub2.
        const placedHub = effectiveStoreMode === "pine" ? "hub3" : "hub2";
        const order = {
          id: orderNum,
          productId: item.product.id,
          productName: item.product.name,
          productPhoto: item.product.photo,
          productPhotoUrl: item.product.photoUrl ?? null,
          size: item.size,
          sentSize: null,
          qty: item.qty || 1,
          customerName: "Shop Refill",
          customerPhone: null,
          hub: placedHub,
          placedAtHub: placedHub,
          placedStore: effectiveStoreMode,
          // Physical shop this refill is for — drives the warehouse→shop transfer
          // recorded on dispatch.
          destShop: effectiveShop,
          productType: "clothing",
          requestDisplay: false,
          requestDisplayPartner: false,
          status: STATUS.INCOMING,
          createdAt: now,
          updatedAt: now,
          readyAt: null,
          outOfStockAt: null,
          comingTomorrowAt: null,
          collectedAt: null,
          // Display refill fields kept null for shape consistency — clothing
          // never participates in the partner display flow.
          displayRefillScheduledAt:    null,
          displayRefillHub:            null,
          displayRefillStatus:         null,
          displayRefilledAt:           null,
          displayRefillStockDepletedAt:null,
          displayRefilledBy:           null,
          // Phase 12C: clothing-refill resolution fields. Set by Hub 2
          // Warehouse staff via the new Clothing tab.
          clothingRefillStatus:        null,
          clothingRefilledAt:          null,
          clothingOutOfStockAt:        null,
          clothingRefilledBy:          null,
        };
        await writeOrder(order);
        logInsight({
          timestamp: now,
          // productId joins analytics on the durable key; see the note at the
          // checkout logInsight site. Older events fall back to productName.
          productId: item.product.id,
          productName: item.product.name,
          productCategory: item.product.category || "",
          productType: "clothing",
          size: item.size,
          // qty on the event so the Clothing Refills tab can sum UNITS from the
          // log for past windows (a refill line is one event with qty>1, unlike
          // sneaker checkout which expands qty into one event per unit). Legacy
          // events predate this field — readers fall back to 1.
          qty: item.qty || 1,
          customerName: "Shop Refill",
          customerPhone: null,
          orderNumber: orderNum,
          action: "placed",
          placedAtHub: placedHub,
        });
        placed.push(order);
      }
      setLastOrders(placed);
      // Drop the placed refill lines; leave sneakers and any clothing-customer
      // lines in place (the latter still need to go through Checkout).
      setCart(prev => prev.filter(it => !(it.productType === "clothing" && it.intent !== "customer")));
    } catch (e) {
      console.error("Failed to place refill requests:", e);
      alert("Could not place refill request. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const sheetStyle = {
    background:CARD, border:BORDER,
    borderTopLeftRadius:RADIUS, borderTopRightRadius:RADIUS,
    padding:"2rem", width:"100%", maxWidth:"520px", maxHeight:"85vh", overflowY:"auto",
    boxShadow: "0 -4px 30px rgba(60,110,255,.12)",
  };

  // Phase 15: a user assigned to zero stores can't place orders anywhere. Block
  // the whole order surface with a clear message rather than showing an empty
  // store toggle + product grid that would route nowhere.
  if (noStoreAccess) {
    return (
      <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto",
                    display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:18, padding:"0 28px", textAlign:"center" }}>
        <div style={{ fontSize:40 }}>🔒</div>
        <div style={{ fontSize:18, fontWeight:700 }}>No store assigned</div>
        <div style={{ fontSize:14, color:"rgba(255,255,255,.5)", lineHeight:1.5, maxWidth:300 }}>
          Your account isn't assigned to any store yet, so you can't place orders. Contact an admin to get access.
        </div>
        <button onClick={onExit}
                style={{ marginTop:6, background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.15)",
                         borderRadius:10, padding:"10px 18px", color:"#fff", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:FONT }}>
          ← Switch View
        </button>
      </div>
    );
  }

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom: cart.length > 0 ? 90 : 40 }}>
      {/* TOP BAR */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 12px" }}>
        <div onClick={onExit}
             style={{ background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.1)", borderRadius:10, padding:"8px 14px", display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}>
          <span style={{ fontSize:12, color:"rgba(255,255,255,.7)" }}>← Switch View</span>
        </div>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.4)", letterSpacing:"0.5px" }}>Viewing as:</div>
          <div style={{ fontSize:15, fontWeight:700, color:"#4A7FFF", letterSpacing:"0.5px" }}>ASSISTANT</div>
        </div>
        {/* Spacer balances the ← Switch View button so "ASSISTANT" stays
            centred; the product mode selector now lives in its own row below. */}
        <div style={{ width:92 }} />
      </div>

      {/* Product mode — one segmented control replaces the old Sneakers/Clothing
          toggle PLUS the separate Refill/Customer toggle:
            Sneakers  → sneakers, customer order
            Clothing  → clothing for a customer → Hub C (same UX as sneakers)
            CR        → Clothing Refill (bulk multi-size, → hub2/hub3) */}
      <div style={{ display:"flex", justifyContent:"center", padding:"0 14px 8px" }}>
        <div style={{ display:"flex", width:"100%", maxWidth:360, background:"rgba(255,255,255,.04)", border:"1px solid rgba(60,110,255,.25)", borderRadius:12, padding:3, gap:2 }}>
          {[["sneaker","Sneakers"],["clothing","Clothing"],["cr","CR"]].map(([val, label]) => {
            const on = mode === val;
            return (
              <button key={val} onClick={() => { setMode(val); resetSheet(); }}
                style={{ flex:1, padding:"7px 6px", borderRadius:9, border:"none", cursor:"pointer", fontSize:12, fontWeight:700,
                         background: on ? "rgba(60,110,255,.25)" : "transparent",
                         color: on ? "#fff" : "rgba(255,255,255,.5)",
                         boxShadow: on ? "0 0 6px rgba(60,110,255,.35)" : "none" }}>
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* SHOP toggle — the assistant picks which physical shop (Marathon PE /
          Trophy / Pine) the order is for; this is recorded as order.destShop and
          drives the warehouse→shop transfer on dispatch. Per-device localStorage.
          Only renders shops this user is assigned to (expanded from their
          central/pine assignment); hidden entirely when they have exactly one
          (auto-selected by the clamp effect) so there's zero chance of mis-picking. */}
      {!singleShop && (
      <div style={{ display:"flex", justifyContent:"center", padding:"0 14px 8px" }}>
        <div style={{ display:"flex", background:"rgba(255,255,255,.04)", border:"1px solid rgba(60,110,255,.25)", borderRadius:12, padding:3, gap:2 }}>
          {availableShops.map((s) => {
            const on = effectiveShop === s.id;
            return (
              <button key={s.id} onClick={() => selectShop(s.id)}
                style={{ padding:"6px 22px", borderRadius:9, border:"none", cursor:"pointer", fontSize:11.5, fontWeight:700,
                         background: on ? "rgba(60,110,255,.25)" : "transparent",
                         color: on ? "#fff" : "rgba(255,255,255,.5)",
                         boxShadow: on ? "0 0 6px rgba(60,110,255,.35)" : "none" }}>
                {labelFor(s.id, shopRegistry)}
              </button>
            );
          })}
        </div>
      </div>
      )}

      {/* Mode hint line — clarifies where each clothing mode's orders go. */}
      {mode === "clothing" && (
        <div style={{ textAlign:"center", fontSize:10, color:"rgba(255,255,255,.4)", letterSpacing:"0.3px", padding:"0 14px 8px" }}>
          Customer clothing orders are sent to {HUB_LABELS.hubC}
        </div>
      )}
      {mode === "cr" && (
        <div style={{ textAlign:"center", fontSize:10, color:"rgba(255,255,255,.4)", letterSpacing:"0.3px", padding:"0 14px 8px" }}>
          Store refill — set quantities per size
        </div>
      )}

      {/* Read-only per-shop stock (Marathon PE / Trophy / Pine) — visibility only,
          separate from the Central/Pine order toggle above. Locked to stockRole. */}
      {canAccessStock && <ShopStockPanel products={products} />}

      {/* PLACE ORDER HERO */}
      <div style={{ position:"relative", width:"100%", height:160, overflow:"hidden", marginBottom:4 }}>
        <img src="/hero/place-order.jpg" alt="Place Order" style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", objectFit:"cover", objectPosition:"center" }}/>
        <div style={{ position:"absolute", inset:0, background:"linear-gradient(to right,rgba(0,0,0,.3),transparent 30%,transparent 60%,rgba(0,0,0,.3))" }}/>
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:50, background:"linear-gradient(transparent,#000)" }}/>
        <div style={{ position:"absolute", top:0, left:0, right:0, height:30, background:"linear-gradient(#000,transparent)" }}/>
      </div>
      <div style={{ fontSize:14, color:"rgba(255,255,255,.35)", padding:"2px 14px 14px" }}>Tap a product to add it to the cart</div>

      <div style={{ padding:"0 13px" }}>
      {/* ── Confirmation banner ── */}
      {lastOrders.length > 0 && (() => {
        // Clothing now appears in both flows, so key the headline off the
        // refill marker rather than productType (customer clothing → Hub C
        // reads as a normal customer order).
        const isRefill = lastOrders[0].customerName === "Shop Refill";
        const headline = isRefill
          ? `Refill request placed — ${lastOrders.length} line${lastOrders.length > 1 ? "s" : ""}`
          : `${lastOrders.length} order${lastOrders.length > 1 ? "s" : ""} placed for ${lastOrders[0].customerName}`;
        return (
          <div style={{ background:"rgba(0,150,70,.1)", border:"1px solid rgba(0,150,70,.3)", borderRadius:RADIUS, padding:"1.25rem", marginBottom:"1.5rem", display:"flex", alignItems:"flex-start", gap:"1rem" }}>
            <div style={{ flex:1 }}>
              <div style={{ color:"#4ADE80", fontWeight:"600", marginBottom:"0.3rem", fontSize:"0.9rem" }}>
                {headline}
              </div>
              {lastOrders.map(o => (
                <div key={o.id} style={{ color:"#888", fontSize:"0.82rem" }}>
                  <strong style={{ color:"#ccc" }}>#{o.id}</strong> — {o.productName}{o.size ? ` Sz ${o.size}` : ""}{o.qty && o.qty > 1 ? ` × ${o.qty}` : ""}
                </div>
              ))}
            </div>
            <button onClick={() => setLastOrders([])} style={{ background:"transparent", border:"none", color:"#555", cursor:"pointer", fontSize:"1rem" }}>✕</button>
          </div>
        );
      })()}

      {/* Inline cart summary removed (Phase 12B) — the floating bottom bar
          below the screen is now the single cart trigger. Sneaker users still
          see the cart review inside the Checkout sheet. */}

      {/* SEARCH BAR */}
      <div style={{ paddingBottom:14 }}>
        <div style={{ background:"rgba(255,255,255,.04)", border:"1px solid rgba(60,110,255,.3)", borderRadius:22, padding:"12px 16px", display:"flex", alignItems:"center", gap:10 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="rgba(255,255,255,.35)" fill="none" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." style={{ background:"transparent", border:"none", outline:"none", color:"#fff", fontSize:14, flex:1 }}/>
        </div>
      </div>

      {/* PRODUCT GRID — Sneakers AND clothing-for-customer use the 2-col
          tappable photo grid + size-picker sheet. CR (Clothing Refill) uses the
          1-col bulk list with inline qty steppers per size. */}
      {filtered.length === 0 ? (
        <div style={{ textAlign:"center", color:"#444", padding:"3rem 1rem", fontSize:14 }}>
          {wantsClothing
            ? "No clothing products yet. Add one from Admin."
            : "No products match your search."}
        </div>
      ) : isRefillMode ? (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {filtered.map(p => (
            <ClothingCard key={p.id} product={p} onAdd={addClothingLines} onViewPhoto={setFullPhoto} />
          ))}
        </div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          {filtered.map(p => {
            const isSel = selected && selected.id === p.id;
            return (
              <div key={p.id} onClick={() => { resetSheet(); setSelected(p); }}
                   style={{ background: isSel ? "rgba(20,40,100,.25)" : "rgba(255,255,255,.03)",
                            border: isSel ? "2px solid #4A7FFF" : "1px solid rgba(255,255,255,.06)",
                            borderRadius:12, overflow:"hidden", cursor:"pointer", position:"relative",
                            boxShadow: isSel ? "0 0 16px rgba(60,110,255,.2)" : "none" }}>
                <div style={{ width:"100%", height:140, position:"relative", background: isSel ? "rgba(60,110,255,.05)" : "rgba(255,255,255,.05)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:52 }}>
                  {p.photoUrl
                    ? <img src={p.photoUrl} alt={p.name} style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                    : <span>{p.photo}</span>}
                  {/* View full photo — opens an uncropped lightbox without
                      triggering the card's add-to-cart tap. */}
                  {p.photoUrl && (
                    <button onClick={(e) => { e.stopPropagation(); setFullPhoto(p.photoUrl); }}
                      title="View full photo"
                      style={{ position:"absolute", top:8, right:8, width:30, height:30, borderRadius:8, border:"none", cursor:"pointer",
                               background:"rgba(0,0,0,.55)", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", padding:0 }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
                    </button>
                  )}
                </div>
                <div style={{ padding:"12px 13px 14px" }}>
                  <div style={{ fontSize:15, fontWeight:700, color:"#fff", marginBottom:5 }}>{p.name}</div>
                  <div style={{ fontSize:13, fontWeight:500, color:"#4A7FFF" }}>Tap to add →</div>
                </div>
                <div style={{ position:"absolute", bottom:12, right:12, width:28, height:28,
                              background: isSel ? "rgba(60,110,255,.2)" : "rgba(60,110,255,.1)",
                              border: isSel ? "1px solid #4A7FFF" : "1px solid rgba(60,110,255,.3)",
                              borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", color:"#4A7FFF", fontSize:16, fontWeight:600 }}>+</div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ height:20 }}/>
      </div>

      {/* ── Size picker bottom sheet ── */}
      {selected && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:1000 }}>
          <div style={sheetStyle}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"1.5rem" }}>
              <div style={{ display:"flex", alignItems:"center", gap:"1rem" }}>
                {selected.photoUrl
                  ? <img src={selected.photoUrl} alt={selected.name} onClick={() => setFullPhoto(selected.photoUrl)}
                         title="View full photo"
                         style={{ width:"56px", height:"56px", objectFit:"cover", borderRadius:RADIUS, cursor:"zoom-in" }} />
                  : <div style={{ fontSize:"2.8rem" }}>{selected.photo}</div>}
                <div>
                  <div style={{ fontWeight:"700", fontSize:"1.05rem" }}>{selected.name}</div>
                  <div style={{ color:"#555", fontSize:"0.8rem" }}>{selected.category}</div>
                </div>
              </div>
              <button onClick={resetSheet}
                style={{ ...bGray, borderRadius:"50%", width:"32px", height:"32px", padding:0, display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
            </div>

            <div style={{ color:"#888", fontSize:"0.75rem", marginBottom:"0.5rem", textTransform:"uppercase", letterSpacing:"0.08em" }}>Select Size</div>
            <div style={{ display:"flex", gap:"0.5rem", flexWrap:"wrap", marginBottom:"1.25rem" }}>
              {selected.sizes.map(s => (
                <button key={s} onClick={() => setPendingSize(s)}
                  style={{ padding:"10px 18px", borderRadius:"10px", border:"2px solid", borderColor: pendingSize===s?BLUE:"rgba(60,110,255,.15)", background: pendingSize===s?"rgba(60,110,255,.15)":"transparent", color: pendingSize===s?BLUE_L:"#888", cursor:"pointer", fontWeight:"700", fontSize:"1rem" }}>
                  {s}
                </button>
              ))}
            </div>

            {/* Quantity stepper — same-size, multiple-pair shortcut. Pushes
                N identical cart lines on Add to Cart (one box per pair). */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"1.25rem", padding:"4px 0" }}>
              <div style={{ color:"#ccc", fontSize:"0.95rem", fontWeight:600 }}>Quantity</div>
              <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
                <button onClick={() => setPendingQty(q => Math.max(1, q - 1))} disabled={pendingQty <= 1}
                        style={{ width:36, height:36, borderRadius:10, border:"1px solid rgba(60,110,255,.25)", background:"rgba(60,110,255,.08)", color: pendingQty <= 1 ? "rgba(255,255,255,.25)" : "#4A7FFF", fontSize:18, fontWeight:700, cursor: pendingQty <= 1 ? "not-allowed" : "pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>−</button>
                <div style={{ minWidth:34, textAlign:"center", color:"#fff", fontSize:"1.05rem", fontWeight:700, fontVariantNumeric:"tabular-nums" }}>{pendingQty}</div>
                <button onClick={() => setPendingQty(q => Math.min(10, q + 1))} disabled={pendingQty >= 10}
                        style={{ width:36, height:36, borderRadius:10, border:"1px solid rgba(60,110,255,.35)", background:"rgba(60,110,255,.12)", color: pendingQty >= 10 ? "rgba(255,255,255,.25)" : "#4A7FFF", fontSize:18, fontWeight:700, cursor: pendingQty >= 10 ? "not-allowed" : "pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>+</button>
              </div>
            </div>

            {/* Display Partner request — sneakers only (it routes to Hub 1, which
                clothing can't use). Hidden for clothing customer orders. */}
            {(selected.productType || "sneaker") !== "clothing" && (
            <div style={{ marginBottom:"1.25rem" }}>
              <div style={{ color:"#555", fontSize:"0.72rem", marginBottom:"0.5rem", textTransform:"uppercase", letterSpacing:"0.08em" }}>Display Partner (optional)</div>
              <div style={{ display:"flex", gap:"0.5rem", flexWrap:"wrap" }}>
                <button onClick={() => setPendingDisplayPartner(v => !v)}
                  style={{ padding:"8px 16px", borderRadius:"10px", border:`2px solid ${pendingDisplayPartner?BLUE_L:"rgba(60,110,255,.15)"}`, background:pendingDisplayPartner?"rgba(60,110,255,.12)":"transparent", color:pendingDisplayPartner?BLUE_L:"#666", cursor:"pointer", fontWeight:"600", fontSize:"0.85rem" }}>
                  Request Display Partner
                </button>
              </div>
            </div>
            )}

            {(() => {
              const canAdd = !!(pendingSize || pendingDisplayPartner);
              const qtyOnly = pendingSize && !pendingDisplayPartner;
              // Display Partner adds exactly one cart line regardless of pendingQty
              // (addToCart forces reps=1 — one-off by nature). Drop the "N ×"
              // prefix so the CTA doesn't promise a quantity the cart will ignore.
              const btnLabel = pendingDisplayPartner
                ? (pendingSize
                    ? `Add Size ${pendingSize} + Display Partner to Cart`
                    : "Add Display Partner Request to Cart")
                : pendingSize
                  ? (qtyOnly && pendingQty > 1
                      ? `Add ${pendingQty} × Size ${pendingSize} to Cart`
                      : `Add Size ${pendingSize} to Cart`)
                  : ((selected.productType || "sneaker") === "clothing" ? "Select a size" : "Select a size or display option");
              return (
                <button onClick={addToCart} disabled={!canAdd}
                  style={{ width:"100%", ...bBlue, borderRadius:"10px", padding:"0.9rem", fontSize:"1rem", marginBottom:"0.65rem", opacity:canAdd?1:0.4, cursor:canAdd?"pointer":"not-allowed" }}>
                  {btnLabel}
                </button>
              );
            })()}

            {cart.length > 0 && (
              <button onClick={() => { resetSheet(); (hasCustomerInCart ? openCheckout() : placeRefillRequests()); }}
                style={{ width:"100%", ...bGhost, borderRadius:"10px", padding:"0.75rem", fontSize:"0.95rem" }}>
                {hasCustomerInCart
                  ? `Checkout (${customerCount} item${customerCount > 1 ? "s" : ""}) →`
                  : `Place Refill Request (${refillCount} item${refillCount > 1 ? "s" : ""}) →`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Checkout bottom sheet ── */}
      {checkoutOpen && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:1000 }}>
          <div style={sheetStyle}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"1.25rem" }}>
              <span style={{ fontWeight:"800", fontSize:"1.2rem" }}>Checkout</span>
              <button onClick={closeCheckout} style={{ ...bGray, borderRadius:"50%", width:"32px", height:"32px", padding:0, display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
            </div>

            {/* Cart review */}
            <div style={{ background:"rgba(60,110,255,.04)", borderRadius:"12px", padding:"0.85rem 1rem", marginBottom:"1.25rem", border:BORDER }}>
              <div style={{ color:"#555", fontSize:"0.72rem", marginBottom:"0.5rem", textTransform:"uppercase", letterSpacing:"0.08em" }}>Order Summary</div>
              {/* Only the lines this Checkout will place (sneakers + clothing
                  customer). Clothing refill lines stay in the cart for the
                  Place Refill Request bar, so they're not listed here. Remove
                  by index against the full cart to delete the right line. */}
              {cart.map((item, idx) => ({ item, idx })).filter(({ item }) => isCustomerLine(item)).map(({ item, idx }, i, arr) => (
                <div key={idx} style={{ display:"flex", alignItems:"center", gap:"0.75rem", padding:"0.45rem 0", borderBottom: i < arr.length-1 ? "1px solid rgba(60,110,255,.06)" : "none" }}>
                  {item.product.photoUrl
                    ? <img src={item.product.photoUrl} alt="" style={{ width:34, height:34, objectFit:"cover", borderRadius:6, flexShrink:0 }} />
                    : <span style={{ fontSize:"1.3rem", flexShrink:0 }}>{item.product.photo}</span>}
                  <span style={{ flex:1, color:"#ccc", fontSize:"0.87rem" }}>{item.product.name}</span>
                  <span style={{ color:BLUE_L, fontWeight:"700", fontSize:"0.87rem", flexShrink:0 }}>{item.size ? `Sz ${item.size}` : "Display"}{item.qty > 1 ? ` × ${item.qty}` : ""}</span>
                  <button onClick={() => removeFromCart(idx)} style={{ background:"transparent", border:"none", color:"#444", cursor:"pointer", fontSize:"0.9rem", flexShrink:0 }}>✕</button>
                </div>
              ))}
            </div>

            <div style={{ marginBottom:"1rem", position:"relative" }}>
              <div style={{ color:"#888", fontSize:"0.78rem", marginBottom:"0.4rem" }}>Customer Name *</div>
              <input placeholder="e.g. Ahmed" value={customerName}
                     onChange={e => { setCustomerName(e.target.value); setNameDropdownOpen(true); }}
                     onFocus={() => setNameDropdownOpen(true)}
                     onBlur={() => setTimeout(() => setNameDropdownOpen(false), 150)}
                     style={inputStyle} />
              {nameDropdownOpen && (
                <CustomerSuggestionDropdown
                  query={customerName} mode="name" customers={customerIndex}
                  onPick={pickCustomer}
                  onAddNew={() => setNameDropdownOpen(false)}
                />
              )}
            </div>
            <div style={{ marginBottom:"1rem", position:"relative" }}>
              <div style={{ color:"#888", fontSize:"0.78rem", marginBottom:"0.4rem" }}>Phone *</div>
              {/* Required for customer orders. Input is restricted to digits and
                  capped at 10 so a short/overlong number can't be entered; it
                  must be the standard 10-digit SA mobile starting with 0. */}
              <input placeholder="0712345678" inputMode="numeric" maxLength={10} value={customerPhone}
                     onChange={e => { setCustomerPhone(e.target.value.replace(/\D/g, "").slice(0, 10)); setPhoneDropdownOpen(true); }}
                     onFocus={() => setPhoneDropdownOpen(true)}
                     onBlur={() => setTimeout(() => setPhoneDropdownOpen(false), 150)}
                     style={inputStyle} />
              {phoneDropdownOpen && (
                <CustomerSuggestionDropdown
                  query={customerPhone} mode="phone" customers={customerIndex}
                  onPick={pickCustomer}
                  onAddNew={() => setPhoneDropdownOpen(false)}
                />
              )}
              {customerPhone && !isValidLocalSAPhone(customerPhone) && (
                <div style={{ color:"#FF6B6B", fontSize:"0.72rem", marginTop:"0.35rem" }}>
                  Enter a 10-digit number starting with 0 (e.g. 0712345678).
                </div>
              )}
            </div>
            <label style={{ display:"flex", alignItems:"center", gap:"0.6rem", marginBottom:"1.5rem", cursor:"pointer", padding:"0.75rem", background:"rgba(60,110,255,.04)", borderRadius:"10px", border:BORDER }}>
              <input type="checkbox" checked={marketingOptIn} onChange={e => setMarketingOptIn(e.target.checked)}
                style={{ width:18, height:18, accentColor:BLUE, cursor:"pointer" }} />
              <span style={{ color:"#ccc", fontSize:"0.88rem" }}>Customer wants to receive Marathon Club deals?</span>
            </label>

            {(() => {
              // Button label reflects the qty shortcut: if every cart line
              // is the same product + size (the "3 pairs of size 8" case),
              // show "Place order — size 8 × 3". Mixed carts fall back to
              // the count.
              // Count only the lines this Checkout places (sneakers + clothing
              // customer); clothing refill lines are placed separately.
              const customerLines = cart.filter(isCustomerLine);
              const sample = customerLines[0];
              const singleSku = sample && customerLines.every(it =>
                it.product?.id === sample.product?.id &&
                it.size === sample.size &&
                !it.requestDisplay && !it.requestDisplayPartner
              );
              const n = customerLines.length;
              const phoneOk = isValidLocalSAPhone(customerPhone);
              const canPlace = customerName && phoneOk && customerLines.length && !submitting;
              const placeLabel = !customerName
                ? "Enter customer name"
                : !phoneOk
                  ? "Enter a valid phone number"
                  : singleSku && sample.size
                    ? (n > 1 ? `Place order — size ${sample.size} × ${n}` : `Place order — size ${sample.size}`)
                    : `Place ${n} Order${n > 1 ? "s" : ""} →`;
              return (
                <button onClick={placeOrders} disabled={!canPlace}
                  style={{ ...bBlue, borderRadius:"10px", padding:"0.9rem 2rem", fontSize:"1rem", width:"100%", opacity:canPlace?1:0.4, cursor:canPlace?"pointer":"not-allowed" }}>
                  {submitting ? "Placing orders…" : placeLabel}
                </button>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Full-photo lightbox ── tap a product photo to see the complete,
          uncropped image; tap anywhere (or ✕) to dismiss. */}
      {fullPhoto && (
        <div onClick={() => setFullPhoto(null)}
             style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.92)", zIndex:2000, display:"flex", alignItems:"center", justifyContent:"center", padding:"24px" }}>
          <img src={fullPhoto} alt="" style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain", borderRadius:8 }} />
          <button onClick={(e) => { e.stopPropagation(); setFullPhoto(null); }}
            style={{ position:"absolute", top:"max(16px, env(safe-area-inset-top))", right:16, width:40, height:40, borderRadius:"50%", border:"none", cursor:"pointer",
                     background:"rgba(255,255,255,.12)", color:"#fff", fontSize:20, display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
        </div>
      )}

      {/* ── Phase 12B: Floating cart trigger ── */}
      {cart.length > 0 && !checkoutOpen && !selected && (
        <div style={{ position:"fixed", bottom:0, left:0, right:0, padding:"12px 14px 14px", background:"linear-gradient(transparent, rgba(0,0,0,.92) 30%)", zIndex:50, pointerEvents:"none" }}>
          <div style={{ maxWidth:430, margin:"0 auto", pointerEvents:"auto" }}>
            <button
              onClick={hasCustomerInCart ? openCheckout : placeRefillRequests}
              disabled={submitting}
              style={{ width:"100%", padding:"13px 16px", borderRadius:12, border:"1px solid rgba(60,110,255,.55)",
                       background:"#4A7FFF", color:"#fff",
                       fontSize:14, fontWeight:700, cursor:"pointer",
                       display:"flex", alignItems:"center", justifyContent:"center", gap:8,
                       boxShadow:"0 4px 20px rgba(60,110,255,.45)",
                       opacity: submitting ? 0.7 : 1 }}>
              <span>
                {submitting
                  ? (hasCustomerInCart ? "Placing orders…" : "Placing refill…")
                  : (hasCustomerInCart ? `Checkout (${customerCount})` : `Place Refill Request (${refillCount})`)
                }
              </span>
              <span style={{ fontSize:16 }}>→</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Scroll-to-top FAB ── appears after scrolling down; one tap returns
          to the search box. Sits above the floating cart bar when it's shown. */}
      {showScrollTop && (
        <button onClick={scrollToTop} aria-label="Scroll to top"
          style={{ position:"fixed", right:16, bottom: cart.length > 0 && !checkoutOpen && !selected ? 92 : 24, zIndex:60,
                   width:46, height:46, borderRadius:"50%", cursor:"pointer",
                   background:"#4A7FFF", border:"1px solid rgba(60,110,255,.55)", color:"#fff",
                   boxShadow:"0 4px 16px rgba(0,0,0,.45)", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
      )}
    </div>
  );
}

// ─── WAREHOUSE VIEW ───────────────────────────────────────────────────────────
function WarehouseView({ products = [], orders, onExit }) {
  const [mainTab, setMainTab] = usePersistedTab("warehouse", "queue");
  const [filter, setFilter] = useState("incoming");
  const [onHoldExpanded, setOnHoldExpanded] = useState(false);
  const [selectedHub, setSelectedHub] = useState(() => localStorage.getItem("warehouseHub") || null);
  // Phase 12C/14B: clamp mainTab when the user switches hubs and the previously
  // selected tab no longer exists for the new hub (Restock on hub1/hub3 vs
  // Clothing on hub2). Fall back to Order Queue. NOTE: must come AFTER
  // selectedHub's declaration — placing this useEffect before it triggers a
  // TDZ ReferenceError on the dependency array evaluation at render time.
  useEffect(() => {
    if (selectedHub === "hub2" && mainTab === "restock")  setMainTab("queue");
    if ((selectedHub === "hub1" || selectedHub === "hub3") && mainTab === "clothing") setMainTab("queue");
    // Trial: hubC has only the Order Queue tab — clamp anything else back.
    if (selectedHub === "hubC" && mainTab !== "queue") setMainTab("queue");
    // Phase 15: the Depleted tab was removed from the warehouse (moved to the
    // home-page tile). Clamp any persisted "depleted" selection back to the
    // queue so returning users don't land on a now-nonexistent blank tab.
    if (mainTab === "depleted") setMainTab("queue");
  }, [selectedHub, mainTab]);
  // Phase 14B: hub3 filters by placedAtHub (the source of truth for the Pine
  // universe); hub1/hub2 still use the legacy order.hub field for back-compat.
  // Trial: hubC (customer clothing) also filters by placedAtHub.
  const orderInHub = (o, h) => (h === "hub3" || h === "hubC")
    ? o.placedAtHub === h
    : (o.hub || "hub1") === h;
  const todayDate    = getSADateString();
  // Restock tab: derive counts from COLLECTED orders only — no Firebase log needed.
  // Hooks must stay above every conditional return (React rules).
  const rawCounts    = useMemo(() => {
    const todayCollected = orders.filter(o =>
      o.status === STATUS.COLLECTED &&
      (selectedHub ? orderInHub(o, selectedHub) : true) &&
      orderCollectedDate(o) === todayDate
    );
    return computeCollectedCounts(todayCollected);
  }, [orders, selectedHub, todayDate]);
  const allResponses = useAllSourceResponses();

  const selectHub = (hub) => {
    localStorage.setItem("warehouseHub", hub);
    setSelectedHub(hub);
  };

  // ── Hooks hoisted before the conditional return ────────────────────────
  // Every useState/useMemo/useEffect must run in the same order on every
  // render. With these declared after the (!selectedHub) early return,
  // toggling between the landing screen and a hub-active view misaligns
  // React's internal hook indices — post-return state (refills, clothing
  // batches, 30s ticker, pickerOpenId) leaked between hubs and a hard
  // refresh was the only way to realign them. dueRefills short-circuits
  // when selectedHub is null so the landing-screen pass is harmless.
  const [pickerOpenId, setPickerOpenId] = useState(null);
  // Which Ready-tab row's ⋮ action menu is open (one at a time). A dispatched
  // order lives in the Ready tab — there is no separate "Sent" tab.
  const [menuOpenId, setMenuOpenId] = useState(null);
  // Dispatch-label print toast (non-blocking — Send never waits on the printer).
  const [printToast, setPrintToast] = useState(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  // ── Layby (warehouse side) ───────────────────────────────────────────────
  // Live subscriptions to the shared /laybys + /laybyPulls nodes. Hoisted above
  // the hub-selector early return like every other hook here (Rules of Hooks).
  // Read-only until a hub is picked; LaybyTab/banner filter by selectedHub.
  const laybys = useLaybys();
  const laybyPulls = useLaybyPulls();
  // Which layby sub-queue to open on next mount. The exceptions banner flips this
  // to "exceptions" so a tap jumps straight there; keyed remount applies it.
  const [laybySub, setLaybySub] = useState("pulls");
  const DISPLAY_REFILL_DELAY_MS = 15 * 60 * 1000;
  const RESOLVED_VISIBLE_MS     = 24 * 60 * 60 * 1000;
  const { dueRefills, completedRefills } = useMemo(() => {
    if (!selectedHub) return { dueRefills: [], completedRefills: [] };
    const due = [];
    const completed = [];
    const resolvedAtMs = (o) => {
      const iso = o.displayRefilledAt || o.displayRefillStockDepletedAt;
      return iso ? new Date(iso).getTime() : 0;
    };
    (orders || []).forEach(o => {
      if (!o.requestDisplayPartner) return;
      if (!o.displayRefillScheduledAt) return;
      if (o.displayRefillHub !== selectedHub) return;
      if (o.displayRefillStatus) {
        const rAt = resolvedAtMs(o);
        if (rAt && nowTick - rAt < RESOLVED_VISIBLE_MS) completed.push(o);
      } else {
        const scheduledAt = new Date(o.displayRefillScheduledAt).getTime();
        if (nowTick - scheduledAt >= DISPLAY_REFILL_DELAY_MS) due.push(o);
      }
    });
    due.sort((a, b) =>
      new Date(a.displayRefillScheduledAt).getTime() -
      new Date(b.displayRefillScheduledAt).getTime()
    );
    completed.sort((a, b) => resolvedAtMs(b) - resolvedAtMs(a));
    return { dueRefills: due, completedRefills: completed };
  }, [orders, selectedHub, nowTick]);
  const [showRefilledCompleted, setShowRefilledCompleted] = useState(false);
  const CANONICAL_SIZE_ORDER = ["3","4","5","5.5","6","7","8","9","10","11","S","M","L","XL","XXL","XXXL","4XL","28","30","32","34","36","38","40"];
  const sizeRank = (s) => {
    const i = CANONICAL_SIZE_ORDER.indexOf(s);
    return i === -1 ? 999 : i;
  };
  const { clothingActiveBatches, clothingCompletedBatches } = useMemo(() => {
    const byKey = new Map();
    (orders || []).forEach(o => {
      if (o.productType !== "clothing") return;
      if ((o.hub || "hub2") !== "hub2") return;
      const key = `${o.productId}__${o.createdAt}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          batchKey: key,
          productId: o.productId,
          productName: o.productName,
          productPhoto: o.productPhoto,
          productPhotoUrl: o.productPhotoUrl,
          createdAt: o.createdAt,
          items: [],
        });
      }
      byKey.get(key).items.push({
        orderId: o.id,
        size: o.size,
        qty: o.qty || 1,
        status: o.clothingRefillStatus || null,
        refilledAt: o.clothingRefilledAt || null,
        outOfStockAt: o.clothingOutOfStockAt || null,
        placedAtHub: o.placedAtHub || o.hub || "hub2",
      });
    });
    const active = [];
    const completed = [];
    byKey.forEach(batch => {
      batch.items.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      const allResolved = batch.items.length > 0 && batch.items.every(it => it.status);
      if (allResolved) {
        // Mixed batches (some available, some OOS) shouldn't happen in
        // practice — we resolve all items together. If they ever do (admin
        // edit), treat the batch as the majority status.
        const oosCount = batch.items.filter(it => it.status === "outOfStock").length;
        batch.status = oosCount > batch.items.length / 2 ? "outOfStock" : "available";
        // Pick the most recent resolution timestamp as the batch's resolvedAt.
        const stamps = batch.items.map(it => it.refilledAt || it.outOfStockAt).filter(Boolean);
        batch.resolvedAt = stamps.sort().pop() || batch.createdAt;
        const resolvedMs = new Date(batch.resolvedAt).getTime();
        if (nowTick - resolvedMs < RESOLVED_VISIBLE_MS) completed.push(batch);
      } else {
        batch.status = null;
        active.push(batch);
      }
    });
    // Active: newest first (within DayCollapsible's bucket logic).
    active.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    completed.sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""));
    return { clothingActiveBatches: active, clothingCompletedBatches: completed };
  }, [orders, nowTick]);
  const [showClothingCompleted, setShowClothingCompleted] = useState(false);

  // Hub selector screen — shown until staff pick a hub
  if (!selectedHub) {
    return (
      <div style={{ minHeight:"100vh", background:BG, color:"#fff", fontFamily:FONT, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
        <div style={{ fontWeight:"800", fontSize:"1.5rem", letterSpacing:"0.06em", marginBottom:"0.5rem", color:"#fff" }}>WAREHOUSE</div>
        <p style={{ color:"#555", marginBottom:"2.5rem", fontSize:"0.9rem" }}>Select your hub to continue</p>
        <div style={{ display:"flex", gap:"1rem", width:"100%", maxWidth:"520px" }}>
          {[["hub1","Hub 1"],["hub2","Hub 2"],["hub3","Hub 3"],["hubC","Hub C"]].map(([val, label]) => (
            <button key={val} onClick={() => selectHub(val)}
              style={{ flex:1, background:CARD, border:BORDER, borderRadius:RADIUS, padding:"2.2rem 0.75rem", cursor:"pointer", color:"#fff", textAlign:"center", boxShadow:GLOW, transition:"border-color 0.15s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor=`rgba(60,110,255,.5)`; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor=`rgba(60,110,255,.12)`; }}>
              <div style={{ fontWeight:"800", fontSize:"2rem", color:BLUE, marginBottom:"0.3rem" }}>{label}</div>
              <div style={{ color:"#555", fontSize:"0.85rem" }}>Tap to select</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Filter orders to only this hub. hub1/hub2: legacy order.hub field.
  // hub3 (Phase 14B): placedAtHub field — orders flow in here based on which
  // Store Assistant universe they were placed in.
  const hubOrders = orders.filter(o => orderInHub(o, selectedHub));

  // extraPatch is merged into the Firebase update — used to stamp sentSize when
  // the warehouse picks a substitute size. Insights/restock logs continue to
  // log order.size (the customer-requested value); only Source view surfaces
  // sentSize, by design.
  const updateStatus = async (order, status, extraPatch = {}) => {
    const now = new Date().toISOString();
    // When an item is COLLECTED (sold/given to customer), log a refill request so
    // Source knows what needs restocking. OOS items are NOT logged — they're
    // completely unavailable and can't be refilled.
    if (status === STATUS.COLLECTED) {
      await logRestock({
        timestamp: now,
        date: getSADateString(),
        productName: order.productName,
        photoUrl: order.productPhotoUrl || null,
        photo: order.productPhoto || "",
        size: order.size,
        orderNumber: order.id,
        hub: order.hub || selectedHub,
        placedAtHub: order.placedAtHub || order.hub || selectedHub,
      }).catch(err => console.warn("logRestock failed:", err));
    }
    const patch = { status, updatedAt: now, ...extraPatch };
    if (status === STATUS.READY)           patch.readyAt = now;
    if (status === STATUS.OUT_OF_STOCK)    patch.outOfStockAt = now;
    if (status === STATUS.COMING_TOMORROW) patch.comingTomorrowAt = now;
    if (status === STATUS.COLLECTED)       patch.collectedAt = now;

    // ── Display Partner refill scheduling (Phase 9) ────────────────────────
    // When a Display Partner order is marked READY, schedule a refill task on
    // the hub where it was placed (display requests now route to the product's
    // own hub, so placedAtHub == the product's stocking hub). Resets refilled
    // state so a re-sent order starts a fresh 15-min window. When the order
    // leaves READY for anything other than COLLECTED, cancel the scheduled refill.
    if (order.requestDisplayPartner) {
      if (status === STATUS.READY) {
        const product = products.find(p => p.id === order.productId);
        patch.displayRefillScheduledAt     = now;
        // Phase 14B: refill task routes by where the order was placed —
        // Pine-placed orders go to Hub 3's refill section. Falls back to the
        // product's stocking hub for legacy orders without placedAtHub.
        patch.displayRefillHub             = order.placedAtHub || getProductHubs(product)[0] || "hub1";
        patch.displayRefillStatus          = null;
        patch.displayRefilledAt            = null;
        patch.displayRefillStockDepletedAt = null;
        patch.displayRefilledBy            = null;
      } else if (status !== STATUS.COLLECTED) {
        patch.displayRefillScheduledAt = null;
        patch.displayRefillHub         = null;
      }
    }

    updateOrder(order.id, patch);
    const insightAction = { [STATUS.READY]:"ready", [STATUS.OUT_OF_STOCK]:"out_of_stock", [STATUS.COMING_TOMORROW]:"tomorrow", [STATUS.COLLECTED]:"collected" }[status];
    if (insightAction) logInsight({
      timestamp: now,
      // productId joins analytics on the durable key; see the note at the
      // checkout logInsight site. Older events fall back to productName.
      // ?? null keeps the key present for legacy orders lacking productId —
      // RTDB drops undefined fields, which would break the "always present"
      // contract and force consumers to guess.
      productId: order.productId ?? null,
      productName: order.productName,
      productCategory: order.productCategory || "",
      productType: order.productType || "sneaker",
      size: order.size,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      orderNumber: order.id,
      action: insightAction,
      placedAtHub: order.placedAtHub || order.hub || "hub1",
    });
    // ── WhatsApp notifications ───────────────────────────────────────────────
    // order_ready template: pass customer_name and order_number ONLY.
    // No timer/minutes — the customer should not feel time pressure.
    // Template body suggested: "Hi {{1}}, your order #{{2}} is ready to collect
    // at Marathon Club. See you soon!"
    if (status === STATUS.READY)
      sendWhatsAppTemplate(order.customerPhone, "order_ready", [order.customerName || "there", order.id]);
    if (status === STATUS.OUT_OF_STOCK)
      sendWhatsAppTemplate(order.customerPhone, "rder_out_of_stock", [order.id]);
    if (status === STATUS.COMING_TOMORROW)
      sendWhatsAppTemplate(order.customerPhone, "order_tomorrow", [order.id]);
  };

  // Mark an order Sent AND auto-print its dispatch label — but ONLY when the hub→shop
  // transfer actually moves stock. The label is the physical signal that the transfer
  // succeeded (the item is counted & in-system): if no stock moved (uncounted hub /
  // insufficient stock / not recordable) there is NO label, so the picker knows to
  // route the item through Lightspeed instead. The order is still marked Sent either
  // way — only the label is gated.
  // GESTURE NOTE: connectTransport (inside printDispatchLabel) only needs the click's
  // user-gesture for the FIRST device pairing; reconnects need none. We await the
  // (sub-second) transfer before printing, so the first pairing's chooser still opens
  // well within the browser's ~5s transient-activation window.
  // extraPatch.sentSize carries a warehouse size substitution → the label barcodes
  // the size physically shipping.
  const markSentAndPrint = async (order, extraPatch = {}) => {
    const sentSize = extraPatch.sentSize ?? order.sentSize ?? order.size ?? null;
    updateStatus(order, STATUS.READY, extraPatch);
    // Gate the label on the transfer: print ONLY if stock genuinely moved.
    const moved = await recordDispatchTransfer(order, sentSize);
    if (!moved) return;  // recordDispatchTransfer already raised the explaining toast
    printDispatchLabel({ ...order, sentSize })
      .then((res) => {
        const diag = res?.diag ? ` [${res.diag}]` : "";
        if (res?.ok) setPrintToast({ kind: "ok", text: `Dispatch label printed for #${order.id}.${diag}` });
        else setPrintToast({ kind: "err", text: `Label didn't print (${res?.error || "unknown"}). Order sent — retry print.${diag}` });
        setTimeout(() => setPrintToast(null), 7000);
      })
      .catch(() => {
        setPrintToast({ kind: "err", text: "Label didn't print. Order sent — retry print." });
        setTimeout(() => setPrintToast(null), 4200);
      });
  };

  // Reprint a dispatched order's label on demand — these sit in the Ready tab — for when
  // the original auto-print (the Mark-as-Sent gate, #109) was lost to a printer trip.
  // PRINT-ONLY: it reuses the exact same printDispatchLabel path/transport/layout,
  // barcoding the SENT size from the order's saved data, but deliberately does NOT call
  // recordDispatchTransfer — the stock already moved on the original send, so a reprint
  // must never write the ledger or double-deduct. Fired straight from the ⋮ menu click
  // (no await before connect) so the BLE chooser keeps its user-gesture, like the original.
  const reprintDispatchLabel = (order) => {
    setMenuOpenId(null);
    const sentSize = order.sentSize ?? order.size ?? null;
    printDispatchLabel({ ...order, sentSize })
      .then((res) => {
        const diag = res?.diag ? ` [${res.diag}]` : "";
        if (res?.ok) setPrintToast({ kind: "ok", text: `Label reprinted for #${order.id}.${diag}` });
        else setPrintToast({ kind: "err", text: `Reprint failed (${res?.error || "unknown"}). Try again.${diag}` });
        setTimeout(() => setPrintToast(null), 7000);
      })
      .catch(() => {
        setPrintToast({ kind: "err", text: "Reprint failed. Try again." });
        setTimeout(() => setPrintToast(null), 4200);
      });
  };

  // Record the physical move of stock OUT of the source warehouse hub and INTO the
  // destination shop, so each shop's on-hand is the running total of its own
  // recorded transfers (reuses the existing ledger — applyMovement writes the
  // /stock_movements audit row + both balance cells atomically). The transfer call
  // itself is UNCHANGED; this now RETURNS whether stock actually moved so the caller
  // can gate the dispatch label on it. Returns true only when stock moved (incl. an
  // idempotent re-send); returns false — with a non-blocking toast telling the picker
  // to route via Lightspeed — when the move isn't recordable or the hub is short.
  const recordDispatchTransfer = async (order, sentSize) => {
    // New orders carry destShop; legacy pine orders infer marathon-pine; legacy
    // central orders can't be disambiguated (Marathon PE vs Trophy) → not recordable.
    const toShop = order.destShop || (order.placedStore === "pine" ? "marathon-pine" : null);
    // Prefer placedAtHub, but fall back to order.hub — legacy orders in this component
    // are routed by order.hub, and (now that the label is gated on the transfer) an
    // unrecognised hub would wrongly suppress the label. VALID_HUBS still filters it.
    const fromHub = order.placedAtHub || order.hub;
    // hubC (clothing-customer trials) isn't a stock location — only real hub→shop
    // sends are recorded.
    const VALID_HUBS = ["hub1", "hub2", "hub3"];
    if (!toShop || !VALID_HUBS.includes(fromHub)) {
      // No recordable hub→shop transfer → no stock moved → no label.
      setPrintToast({ kind: "err", text: `Sent — no hub→shop transfer recorded for #${order.id}. No label — route via Lightspeed.` });
      setTimeout(() => setPrintToast(null), 7000);
      return false;
    }
    // Idempotent + date-unique movementId: order.id is the DAILY counter (reused
    // across days), so scope by createdAt — a re-tap is a no-op, but #042 on two
    // different days stay distinct movements. Strip RTDB-illegal key chars.
    const movementId = `disp_${order.id}_${order.createdAt || ""}`.replace(/[.#$[\]/\s:]/g, "_");
    try {
      const res = await applyMovement({
        type: "transfer_out",            // ledger's from→to type (−from, +to)
        productId: order.productId,
        size: sentSize ?? order.size ?? null,  // applyMovement encodes via stockCellPath
        qty: order.qty || 1,
        from: fromHub,
        to: toShop,
        actorRole: "warehouse",
        link: { orderId: order.id },
        ts: new Date().toISOString(),
        movementId,
      });
      // A repeat send returns ok:true (idempotent). Only a genuine failure
      // (insufficient hub stock) is a no-move → no label.
      if (res && res.ok === false) {
        setPrintToast({ kind: "err", text: `Sent — but stock not deducted (${res.reason || "hub count low"}). No label — route via Lightspeed.` });
        setTimeout(() => setPrintToast(null), 7000);
        return false;
      }
      return true;
    } catch {
      // Ledger write error — we can't confirm stock moved, so withhold the label.
      setPrintToast({ kind: "err", text: `Sent — but stock not deducted (write error). No label — route via Lightspeed.` });
      setTimeout(() => setPrintToast(null), 7000);
      return false;
    }
  };

  // ── Display refill helpers (Phase 9 / 9.5) ───────────────────────────────
  // Resolve a partner-order refill task to one of two terminal states:
  // 'refilled' (display replenished) or 'stockDepleted' (no inventory left,
  // feeds Phase 11 Insights). displayRefilledBy stores the hub label
  // (anonymous auth has no email; selectedHub is the meaningful signal).
  const setDisplayRefillStatus = (order, status) => {
    const now = new Date().toISOString();
    const patch = {
      displayRefillStatus: status,
      displayRefilledBy:   selectedHub,
      updatedAt:           now,
    };
    if (status === "refilled") {
      patch.displayRefilledAt            = now;
      patch.displayRefillStockDepletedAt = null;
    } else if (status === "stockDepleted") {
      patch.displayRefillStockDepletedAt = now;
      patch.displayRefilledAt            = null;
    }

    // Resolve the refill task on the order. (Product-level depletion blocking
    // was retired — a "stock depleted" resolution no longer flags the product
    // un-orderable; it only resolves this task and feeds Insights below. So this
    // is now a plain per-order write for both outcomes.)
    updateOrder(order.id, patch);

    // Stock-deplete: append an insights_log entry so the Stock Depleted tab
    // can show past-day counts. Without this, the tab only ever sees today's
    // events because orders/{id} gets overwritten when the daily orderNumber
    // counter wraps. Mirrors the action="out_of_stock" pattern used by OOS
    // Tracker. dedupeByOrderNumber + composite key handle re-fires. This stays a
    // separate best-effort append (a push, not part of the atomic update above);
    // a lost insight entry never affects whether a product is orderable.
    if (status === "stockDepleted") {
      logInsight({
        timestamp:        now,
        // productId joins analytics on the durable key; see the note at the
        // checkout logInsight site. Older events fall back to productName.
        // ?? null keeps the key present for legacy orders (RTDB drops undefined).
        productId:        order.productId ?? null,
        productName:      order.productName,
        productCategory:  order.productCategory || "",
        productType:      order.productType || "sneaker",
        size:             order.size,
        customerName:     order.customerName,
        customerPhone:    order.customerPhone,
        orderNumber:      order.id,
        action:           "stock_depleted",
        placedAtHub:      order.placedAtHub || order.hub || "hub1",
        displayRefilledBy: selectedHub,
      });
    }
  };
  // Reverse a refill resolution — clears status + both timestamps + by-hub so
  // the task reappears in the active list. Leaves displayRefillScheduledAt
  // alone so the original 15-min window resumes from where it was.
  const undoDisplayRefill = (order) => {
    updateOrder(order.id, {
      displayRefillStatus:          null,
      displayRefilledAt:            null,
      displayRefillStockDepletedAt: null,
      displayRefilledBy:            null,
      updatedAt:                    new Date().toISOString(),
    });
  };

  // ── Display Refills data (Phase 9 / 9.5) ─────────────────────────────────
  // Hooks for refills (nowTick, dueRefills) live at the top of this function
  // alongside the other hoisted hooks — see the Rules-of-Hooks note above.
  const refillsBadge = dueRefills.length;

  // ── Clothing refill batches (Phase 12C, hub2 only) ────────────────────────
  // Hook + helpers (clothingActiveBatches/Completed, CANONICAL_SIZE_ORDER,
  // sizeRank) live at the top of this function alongside the other hoisted
  // hooks — see the Rules-of-Hooks note above.
  const clothingBadge = clothingActiveBatches.length;

  // ── Layby badges (warehouse side) ────────────────────────────────────────
  // Tab badge = pending pull requests for this hub (the actionable queue).
  // Missing-in-transit exceptions get the louder banner above the tabs.
  const laybyHubOf = (x) => x?.storageHub || DEFAULT_STORAGE_HUB;
  const laybyBadge = laybyPulls.filter(p =>
    laybyHubOf(p) === selectedHub && (p.status || PULL_STATUS.PENDING) === PULL_STATUS.PENDING
  ).length;

  // Resolve a batch — patch every item with the same status + timestamp.
  // Phase 12D: also writes one insights_log entry per item so historical
  // Insights (week/month/year/All Time) see the event in the immutable log.
  // Reuses action="ready" for Available and action="out_of_stock" for OOS so
  // clothing events flow into the existing OOS Tracker tab's historical path
  // automatically (distinguished by productType:"clothing").
  const setClothingRefillStatus = (batch, status) => {
    const now = new Date().toISOString();
    const patch = {
      clothingRefillStatus: status,
      clothingRefilledBy:   selectedHub,
      updatedAt:            now,
    };
    if (status === "available") {
      patch.clothingRefilledAt   = now;
      patch.clothingOutOfStockAt = null;
    } else if (status === "outOfStock") {
      patch.clothingOutOfStockAt = now;
      patch.clothingRefilledAt   = null;
    }
    const insightAction = status === "available" ? "ready" : status === "outOfStock" ? "out_of_stock" : null;
    batch.items.forEach(it => {
      updateOrder(it.orderId, patch);
      if (insightAction) logInsight({
        timestamp: now,
        // productId joins analytics on the durable key; see the note at the
        // checkout logInsight site. Older events fall back to productName.
        // ?? null keeps the key present for legacy batches (RTDB drops undefined).
        productId: batch.productId ?? null,
        productName: batch.productName,
        productCategory: "",
        productType: "clothing",
        size: it.size,
        customerName: "Shop Refill",
        customerPhone: null,
        orderNumber: it.orderId,
        action: insightAction,
        placedAtHub: it.placedAtHub || "hub2",
      });
    });
  };
  // Reverse — clear status + both timestamps + by. Item returns to active.
  const undoClothingRefill = (batch) => {
    const now = new Date().toISOString();
    batch.items.forEach(it => updateOrder(it.orderId, {
      clothingRefillStatus: null,
      clothingRefilledAt:   null,
      clothingOutOfStockAt: null,
      clothingRefilledBy:   null,
      updatedAt:            now,
    }));
  };

  const onHoldOrders = hubOrders.filter(o => o.status === STATUS.COMING_TOMORROW);

  const queueFilters = [
    { key:"incoming",     label:"Incoming",     count: hubOrders.filter(o=>o.status===STATUS.INCOMING).length },
    { key:"ready",        label:"Ready",        count: hubOrders.filter(o=>o.status===STATUS.READY).length },
    { key:"out_of_stock", label:"Out of Stock", count: hubOrders.filter(o=>o.status===STATUS.OUT_OF_STOCK).length },
    { key:"all",          label:"All",          count: hubOrders.filter(o=>o.status!==STATUS.COMING_TOMORROW).length },
  ];

  // Queue date-of resolver — adapts to the active filter so each section
  // groups by its most meaningful date.
  const queueDateOf = (o) => {
    if (filter === "ready")        return o.readyAt;
    if (filter === "out_of_stock") return o.outOfStockAt;
    return o.createdAt; // incoming + all
  };

  const filtered = hubOrders
    .filter(o => filter === "all" ? o.status !== STATUS.COMING_TOMORROW : o.status === filter)
    .sort((a, b) => (queueDateOf(b) || "").localeCompare(queueDateOf(a) || ""));

  // Tally for the incoming pill at top right
  const incomingCount = hubOrders.filter(o => o.status === STATUS.INCOMING).length;

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
      {/* Dispatch-label print toast — auto-print result on "Mark as Sent" (non-blocking). */}
      {printToast && (
        <div style={{ position:"fixed", left:"50%", transform:"translateX(-50%)", bottom:24, zIndex:9999, maxWidth:400, width:"90%",
                      padding:"11px 14px", borderRadius:10, fontSize:12, fontWeight:600, textAlign:"center",
                      background: printToast.kind === "ok" ? "rgba(0,150,70,.92)" : "rgba(150,30,30,.94)",
                      color:"#fff", border:"1px solid rgba(255,255,255,.18)", boxShadow:"0 6px 24px rgba(0,0,0,.4)" }}>
          {printToast.text}
        </div>
      )}
      {/* TOP BAR */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 10px" }}>
        <div onClick={onExit}
             style={{ background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.1)", borderRadius:10, padding:"8px 14px", fontSize:12, color:"rgba(255,255,255,.7)", cursor:"pointer" }}>
          ← Switch View
        </div>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.4)", letterSpacing:"0.5px" }}>Viewing as:</div>
          <div style={{ fontSize:15, fontWeight:700, color:"#fff", letterSpacing:"0.5px" }}>WAREHOUSE</div>
        </div>
        <div style={{ background:"rgba(20,40,100,.6)", border:"1px solid rgba(60,110,255,.35)", borderRadius:12, padding:"7px 12px", display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}>
          <div style={{ width:7, height:7, background:"#4A7FFF", borderRadius:"50%", boxShadow:"0 0 6px rgba(60,110,255,.8)" }}/>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:"#fff", lineHeight:1 }}>{incomingCount}</div>
            <div style={{ fontSize:9, color:"rgba(255,255,255,.5)" }}>incoming</div>
          </div>
          <span style={{ color:"#4A7FFF", fontSize:13 }}>›</span>
        </div>
      </div>

      {/* CIRCUIT LINE */}
      <div style={{ height:20, padding:"0 14px", margin:"4px 0 2px", overflow:"hidden" }}>
        <svg width="100%" height="100%" viewBox="0 0 400 20" preserveAspectRatio="none">
          <path d="M0,10 L60,10 L80,3 L140,3 L160,10 L220,10 L240,17 L300,17 L320,10 L400,10" stroke="rgba(60,110,255,.4)" strokeWidth="1" fill="none" strokeLinecap="round"/>
          <circle cx="80" cy="3" r="2.5" fill="rgba(74,127,255,.7)"/>
          <circle cx="160" cy="10" r="2.5" fill="rgba(74,127,255,.7)"/>
          <circle cx="240" cy="17" r="2.5" fill="rgba(74,127,255,.7)"/>
          <circle cx="320" cy="10" r="2.5" fill="rgba(74,127,255,.7)"/>
        </svg>
      </div>

      {/* WAREHOUSE QUEUE HERO IMAGE */}
      <div style={{ position:"relative", width:"100%", height:130, overflow:"hidden", margin:"4px 0 0" }}>
        <img src="/hero/warehouse.jpg" alt="Warehouse Queue" style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", objectFit:"cover", objectPosition:"center" }}/>
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:50, background:"linear-gradient(transparent,#000)" }}/>
        <div style={{ position:"absolute", top:0, left:0, right:0, height:20, background:"linear-gradient(#000,transparent)" }}/>
      </div>

      {/* HUB ROW */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 14px 10px" }}>
        <div style={{ background:"rgba(20,40,120,.5)", border:"1px solid rgba(60,110,255,.5)", borderRadius:10, padding:"7px 16px", color:"#4A7FFF", fontSize:13, fontWeight:700 }}>
          {HUB_LABELS[selectedHub] || selectedHub}
        </div>
        <div onClick={() => { localStorage.removeItem("warehouseHub"); setSelectedHub(null); }}
             style={{ background:"rgba(255,255,255,.05)", border:"1px solid rgba(255,255,255,.1)", borderRadius:10, padding:"7px 16px", color:"rgba(255,255,255,.7)", fontSize:12, fontWeight:500, cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2">
            <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
          </svg>
          Switch Hub
        </div>
      </div>

      <div style={{ fontSize:12, color:"rgba(255,255,255,.3)", padding:"2px 14px 10px" }}>Update order status in real time.</div>

      {/* ON HOLD CARD */}
      {onHoldOrders.length > 0 && (
        <div style={{ margin:"0 13px 10px", background:"rgba(20,40,100,.3)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:"13px 14px" }}>
          <div onClick={() => setOnHoldExpanded(e => !e)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 4px rgba(60,110,255,.5))" }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <div style={{ fontSize:14, fontWeight:700, color:"#4A7FFF", letterSpacing:"0.3px" }}>ON HOLD</div>
              <div style={{ width:28, height:28, borderRadius:"50%", background:"rgba(60,110,255,.25)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#6A9FFF", boxShadow:"0 0 8px rgba(60,110,255,.4)" }}>{onHoldOrders.length}</div>
              <div style={{ fontSize:11, color:"rgba(255,255,255,.4)", lineHeight:1.4 }}>Next-day<br/>follow-up</div>
            </div>
            <div style={{ fontSize:12, color:"#4A7FFF", fontWeight:600 }}>{onHoldExpanded ? "Hide ∧" : "Show all ∨"}</div>
          </div>
          {!onHoldExpanded && onHoldOrders[0] && (
            <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:10, paddingTop:10, borderTop:"1px solid rgba(255,255,255,.06)" }}>
              <ProductPhoto url={onHoldOrders[0].productPhotoUrl} photo={onHoldOrders[0].productPhoto} size={44} radius={8}/>
              <div style={{ fontSize:13, fontWeight:700, color:"#4A7FFF" }}>#{onHoldOrders[0].id}</div>
              <div style={{ fontSize:13, color:"rgba(255,255,255,.8)", flex:1 }}>{onHoldOrders[0].productName}{onHoldOrders[0].size ? ` — Size ${onHoldOrders[0].size}` : ""}</div>
              {onHoldOrders.length > 1 && <div style={{ fontSize:12, color:"#4A7FFF", fontWeight:600 }}>+{onHoldOrders.length - 1} more</div>}
            </div>
          )}
          {onHoldExpanded && (
            <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid rgba(255,255,255,.06)", display:"flex", flexDirection:"column", gap:10 }}>
              {onHoldOrders.map(order => (
                <div key={order.id} style={{ background:"rgba(60,110,255,.05)", border:"1px solid rgba(60,110,255,.15)", borderRadius:12, padding:12, display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <ProductPhoto url={order.productPhotoUrl} photo={order.productPhoto} size={40} radius={8}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:800, color:"#6A9FFF", fontSize:14 }}>#{order.id}</div>
                    <div style={{ fontWeight:600, fontSize:13 }}>{order.productName}{order.size ? ` — Sz ${order.size}` : ""}</div>
                    <div style={{ color:"#555", fontSize:11 }}>{order.customerName}</div>
                  </div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    <button onClick={() => updateStatus(order, STATUS.READY)} style={{ background:"rgba(0,150,70,.2)", border:"1px solid rgba(0,180,80,.3)", color:"#4ACA7A", borderRadius:8, padding:"6px 10px", fontSize:11, fontWeight:700, cursor:"pointer" }}>Available</button>
                    <button onClick={() => updateStatus(order, STATUS.OUT_OF_STOCK)} style={{ background:"rgba(150,20,20,.15)", border:"1px solid rgba(180,40,40,.25)", color:"#FF6B6B", borderRadius:8, padding:"6px 10px", fontSize:11, fontWeight:700, cursor:"pointer" }}>Still OOS</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* LAYBY EXCEPTIONS — loud banner above the tabs on every tab. Self-hides
          when there are no missing-in-transit parcels. Tap → Layby tab,
          Exceptions sub-queue. (hubC never stores laybys, so skip it there.) */}
      {selectedHub !== "hubC" && (
        <LaybyExceptionsBanner laybys={laybys} selectedHub={selectedHub} nowMs={nowTick}
          onOpen={() => { setLaybySub("exceptions"); setMainTab("layby"); }} />
      )}

      {/* TABS — middle slot is Restock Status on hub1/hub3, Clothing on hub2
          (Phase 12C / 14B). hub3 mirrors hub1's tab set; if a clothing tab is
          needed for Pine later, add it here. */}
      <div style={{ display:"flex", gap:6, padding:"0 13px 10px" }}>
        {(selectedHub === "hubC"
          ? [
              // Trial: Hub C only fulfils customer clothing orders, so it gets
              // the Order Queue and nothing else.
              ["queue",    "Order Queue",     null],
            ]
          : selectedHub === "hub2"
          ? [
              ["queue",    "Order Queue",     null],
              ["clothing", "Clothing",        clothingBadge],
              ["refills",  "Display Refills", refillsBadge],
              ["layby",    "Layby",           laybyBadge],
            ]
          : [
              ["queue",   "Order Queue",     null],
              ["restock", "Restock Status",  null],
              ["refills", "Display Refills", refillsBadge],
              ["layby",   "Layby",           laybyBadge],
            ]
        ).map(([key, label, badge]) => (
          <div key={key} onClick={() => setMainTab(key)}
               style={{ flex:1, padding:"10px 6px", borderRadius:10, fontSize:11.5, fontWeight:600, textAlign:"center", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:5,
                        background: mainTab===key ? "rgba(60,110,255,.12)" : "rgba(6,9,20,1)",
                        border: mainTab===key ? "1px solid rgba(60,110,255,.4)" : "1px solid rgba(255,255,255,.07)",
                        color: mainTab===key ? "#4A7FFF" : "rgba(255,255,255,.3)" }}>
            {key === "queue"    && <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
            {key === "restock"  && <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>}
            {key === "clothing" && <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4l-4 4-4-4M3 7l5-3h8l5 3M3 7v13a1 1 0 001 1h16a1 1 0 001-1V7M3 7l4 4M21 7l-4 4"/></svg>}
            {key === "refills"  && <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>}
            {key === "layby"    && <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-14L4 7m8 4v10m0-10L4 7v10l8 4"/></svg>}
            <span>{label}</span>
            {badge != null && badge > 0 && (
              <span style={{ background: mainTab===key ? "#F59E0B" : "rgba(245,158,11,.85)", color:"#000", fontSize:10, fontWeight:800, minWidth:18, height:18, borderRadius:"50%", padding:"0 5px", display:"inline-flex", alignItems:"center", justifyContent:"center" }}>{badge}</span>
            )}
          </div>
        ))}
      </div>

      {mainTab === "queue" && (
        <>
          {/* PILLS */}
          <div style={{ display:"flex", gap:7, padding:"0 13px 12px", overflowX:"auto", scrollbarWidth:"none" }}>
            {queueFilters.map(t => {
              const on = filter === t.key;
              return (
                <div key={t.key} onClick={() => setFilter(t.key)}
                     style={{ padding:"6px 14px", borderRadius:20, fontSize:12, fontWeight:600, whiteSpace:"nowrap", cursor:"pointer", display:"flex", alignItems:"center", gap:5,
                              background: on ? "rgba(60,110,255,.12)" : "rgba(6,9,20,1)",
                              border:"1px solid " + (on ? "rgba(60,110,255,.4)" : "rgba(255,255,255,.07)"),
                              color: on ? "#4A7FFF" : "rgba(255,255,255,.35)" }}>
                  {t.label}
                  {t.count > 0 && (
                    <span style={{ background: on ? "#4A7FFF" : "rgba(255,255,255,.15)", color: on ? "#000" : "#fff", fontSize:10, fontWeight:on?800:700, width:18, height:18, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center" }}>{t.count}</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* ORDER CARDS — grouped by day, last 3 days only (Phase 10) */}
          <div style={{ padding:"0 13px" }}>
            <DayCollapsible
              sectionKey={`wh-${filter}`}
              items={filtered}
              dateOf={queueDateOf}
              emptyMessage="No orders in the last 3 days."
              renderItem={(order) => {
            const status = order.status;
            const incoming = status === STATUS.INCOMING;
            const ready    = status === STATUS.READY;
            const oos      = status === STATUS.OUT_OF_STOCK;
            // Card backgrounds + bar by status
            const cardBg = incoming ? "rgba(15,25,60,.5)"
                          : ready   ? "rgba(0,30,15,.4)"
                          : oos     ? "rgba(40,10,10,.4)"
                                    : "rgba(6,9,20,1)";
            const cardBorder = incoming ? "1px solid rgba(60,110,255,.2)"
                              : ready   ? "1px solid rgba(0,180,80,.15)"
                              : oos     ? "1px solid rgba(200,40,40,.15)"
                                        : "1px solid rgba(255,255,255,.07)";
            const barColor = incoming ? "rgba(60,110,255,.8)"
                            : ready   ? "rgba(0,180,80,.8)"
                            : oos     ? "rgba(200,40,40,.8)"
                                      : "rgba(200,140,0,.8)";
            const chipBg = incoming ? "rgba(60,110,255,.15)" : ready ? "rgba(0,180,80,.12)" : oos ? "rgba(200,40,40,.12)" : "rgba(255,255,255,.05)";
            const chipColor = incoming ? "#6A9FFF" : ready ? "#4ACA7A" : oos ? "#FF6B6B" : "#888";
            const chipLabel = incoming ? "Incoming" : ready ? "Ready" : oos ? "Out of Stock" : (STATUS_CONFIG[status]?.label || status);
            return (
              <div style={{ borderRadius:14, overflow:"hidden", position:"relative", background:cardBg, border:cardBorder }}>
                {/* color bar */}
                <div style={{ position:"absolute", left:0, top:0, bottom:0, width:3, background:`linear-gradient(180deg,transparent,${barColor},transparent)` }}/>
                <div style={{ padding:"12px 12px 12px 16px", display:"flex", alignItems:"flex-start", gap:11 }}>
                  <ProductPhoto url={order.productPhotoUrl} photo={order.productPhoto} size={60} radius={10}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                      <div style={{ fontSize:13, fontWeight:800, color:"#4A7FFF", letterSpacing:"0.5px" }}>#{order.id}</div>
                      <div style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:10, display:"flex", alignItems:"center", gap:4, background:chipBg, color:chipColor }}>
                        {incoming && <span style={{ width:5, height:5, borderRadius:"50%", background:"#4A7FFF", boxShadow:"0 0 3px #4A7FFF", display:"inline-block" }}/>}
                        {chipLabel}
                      </div>
                      {ready ? (
                        // Ready-tab ⋮ menu — reprint the dispatch label if the original
                        // auto-print was lost to a printer trip (print-only; no re-deduct).
                        // Styled as a clearly tappable bordered control, not a faint dot.
                        <div style={{ marginLeft:"auto", position:"relative" }}>
                          <button onClick={() => setMenuOpenId(menuOpenId === order.id ? null : order.id)}
                                  aria-label="Order actions"
                                  style={{ display:"flex", alignItems:"center", justifyContent:"center", minWidth:34, height:28, background:"rgba(74,202,128,.14)", border:"1px solid rgba(74,202,128,.45)", borderRadius:8, color:"#4ACA7A", fontSize:18, fontWeight:800, lineHeight:1, cursor:"pointer", padding:"0 8px" }}>⋮</button>
                          {menuOpenId === order.id && (
                            <>
                              {/* click-away backdrop */}
                              <div onClick={() => setMenuOpenId(null)} style={{ position:"fixed", inset:0, zIndex:40 }}/>
                              <div style={{ position:"absolute", right:0, top:32, zIndex:50, minWidth:160, background:"#0d1322", border:"1px solid rgba(255,255,255,.14)", borderRadius:10, boxShadow:"0 8px 24px rgba(0,0,0,.5)", overflow:"hidden" }}>
                                <button onClick={() => reprintDispatchLabel(order)}
                                        style={{ display:"flex", alignItems:"center", gap:8, width:"100%", padding:"11px 13px", background:"none", border:"none", color:"#fff", fontSize:12.5, fontWeight:600, textAlign:"left", cursor:"pointer" }}>
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                                  Reprint label
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ) : (
                        <div style={{ marginLeft:"auto", color:"rgba(255,255,255,.2)", fontSize:16 }}>···</div>
                      )}
                    </div>
                    <div style={{ fontSize:15, fontWeight:600, color:"#fff" }}>{order.productName}{order.size ? ` — Size ${order.size}` : ""}{order.qty > 1 ? ` × ${order.qty}` : ""}</div>
                    <div style={{ fontSize:11, color:"rgba(255,255,255,.4)", marginTop:3, display:"flex", alignItems:"center", gap:4 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      {order.customerName}{order.customerPhone ? ` · ${order.customerPhone}` : ""}
                    </div>
                    {(order.requestDisplay || order.requestDisplayPartner) && (
                      <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginTop:3 }}>
                        {order.requestDisplay && <span style={{ background:"rgba(60,110,255,.1)", color:"#4A7FFF", border:"1px solid rgba(60,110,255,.25)", borderRadius:10, padding:"1px 7px", fontSize:9, fontWeight:600 }}>Display</span>}
                        {order.requestDisplayPartner && <span style={{ background:"rgba(60,110,255,.12)", color:"#4A7FFF", border:"1px solid rgba(60,110,255,.3)", borderRadius:10, padding:"1px 7px", fontSize:9, fontWeight:600 }}>Partner</span>}
                      </div>
                    )}
                    <div style={{ fontSize:10, color:"rgba(255,255,255,.25)", marginTop:1 }}>{new Date(order.createdAt).toLocaleTimeString()}</div>
                  </div>
                </div>

                {incoming && (() => {
                  const { below, above } = subSizeOptions(order.size);
                  const subAvailable = !!(below || above);
                  const pickerOpen = pickerOpenId === order.id;
                  const commitSub = (chosen) => {
                    setPickerOpenId(null);
                    markSentAndPrint(order, { sentSize: chosen });
                  };
                  return (
                    <div style={{ padding:"0 12px 10px 16px" }}>
                      {!pickerOpen ? (
                        // 2×2 action grid — Sent / OOS on top row, Tomorrow / Substitute on bottom.
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                          <button onClick={() => markSentAndPrint(order)}
                                  style={{ padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:5, background:"rgba(0,150,70,.2)", border:"1px solid rgba(0,180,80,.3)", color:"#4ACA7A" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                            Mark as Sent
                          </button>
                          <button onClick={() => updateStatus(order, STATUS.OUT_OF_STOCK)}
                                  style={{ padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:5, background:"rgba(150,20,20,.15)", border:"1px solid rgba(180,40,40,.25)", color:"#FF6B6B" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            Mark as Out of Stock
                          </button>
                          <button onClick={() => updateStatus(order, STATUS.COMING_TOMORROW)}
                                  style={{ padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:5, background:"rgba(60,110,255,.08)", border:"1px solid rgba(60,110,255,.2)", color:"#4A7FFF" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            Schedule for Tomorrow
                          </button>
                          <button onClick={() => subAvailable && setPickerOpenId(order.id)}
                                  disabled={!subAvailable}
                                  title={subAvailable ? "" : "No valid substitute size in range"}
                                  style={{ padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor: subAvailable ? "pointer" : "not-allowed", display:"flex", alignItems:"center", justifyContent:"center", gap:5,
                                           background: subAvailable ? "rgba(245,158,11,.12)" : "rgba(255,255,255,.03)",
                                           border:"1px solid " + (subAvailable ? "rgba(245,158,11,.35)" : "rgba(255,255,255,.06)"),
                                           color: subAvailable ? "#F59E0B" : "rgba(255,255,255,.25)",
                                           opacity: subAvailable ? 1 : 0.6 }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                            </svg>
                            Substitute Size
                          </button>
                        </div>
                      ) : (
                        // Inline picker — pick a size below/above the requested, or cancel.
                        <div style={{ background:"rgba(245,158,11,.06)", border:"1px solid rgba(245,158,11,.25)", borderRadius:10, padding:"10px 10px 8px" }}>
                          <div style={{ fontSize:11, fontWeight:600, color:"#F59E0B", marginBottom:8, display:"flex", alignItems:"center", gap:6 }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                            Pick a substitute for Size {order.size}
                          </div>
                          <div style={{ display:"flex", gap:8 }}>
                            {below && (
                              <button onClick={() => commitSub(below)}
                                      style={{ flex:1, padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:5, background:"rgba(245,158,11,.15)", border:"1px solid rgba(245,158,11,.4)", color:"#F59E0B" }}>
                                <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="19 12 12 19 5 12"/><line x1="12" y1="5" x2="12" y2="19"/></svg>
                                Size {below}
                              </button>
                            )}
                            {above && (
                              <button onClick={() => commitSub(above)}
                                      style={{ flex:1, padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:5, background:"rgba(245,158,11,.15)", border:"1px solid rgba(245,158,11,.4)", color:"#F59E0B" }}>
                                <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="5 12 12 5 19 12"/><line x1="12" y1="19" x2="12" y2="5"/></svg>
                                Size {above}
                              </button>
                            )}
                            <button onClick={() => setPickerOpenId(null)}
                                    style={{ padding:"11px 12px", borderRadius:10, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,.04)", border:"1px solid rgba(255,255,255,.1)", color:"rgba(255,255,255,.7)" }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {ready && (
                  <div style={{ padding:"0 12px 10px 16px" }}>
                    <button onClick={() => updateStatus(order, STATUS.COLLECTED)}
                            style={{ width:"100%", padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:5, background:"rgba(100,100,100,.12)", border:"1px solid rgba(100,100,100,.25)", color:"#9CA3AF" }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                      Mark as Collected
                    </button>
                  </div>
                )}
              </div>
            );
              }}
            />
          </div>
        </>
      )}

      {mainTab === "restock" && (
        <div style={{ padding:"0 13px" }}>
          <WarehouseRestockTab rawCounts={rawCounts} responses={allResponses[todayDate] || {}} />
        </div>
      )}

      {mainTab === "clothing" && (
        <div style={{ padding:"0 13px" }}>
          <ClothingRefillsTab
            activeBatches={clothingActiveBatches}
            completedBatches={clothingCompletedBatches}
            showCompleted={showClothingCompleted}
            setShowCompleted={setShowClothingCompleted}
            onSetStatus={setClothingRefillStatus}
            onUndo={undoClothingRefill}
          />
        </div>
      )}

      {mainTab === "refills" && (
        <div style={{ padding:"0 13px" }}>
          <DisplayRefillsTab
            dueRefills={dueRefills}
            completedRefills={completedRefills}
            showCompleted={showRefilledCompleted}
            setShowCompleted={setShowRefilledCompleted}
            onSetStatus={setDisplayRefillStatus}
            onUndo={undoDisplayRefill}
            nowTick={nowTick}
            selectedHub={selectedHub}
          />
        </div>
      )}

      {mainTab === "layby" && (
        // Keyed on laybySub so the exceptions-banner tap remounts straight to the
        // Exceptions sub-queue. nowTick (30s) drives age/exception recomputation.
        <LaybyTab
          key={`layby-${laybySub}`}
          selectedHub={selectedHub}
          laybys={laybys}
          pulls={laybyPulls}
          nowMs={nowTick}
          initialSub={laybySub}
        />
      )}
    </div>
  );
}

// ─── DISPLAY REFILLS TAB (Phase 9 / 9.5) ──────────────────────────────────────
// Hub-scoped list of partner-order refill tasks that have crossed the 15-min
// post-send threshold. Each due task resolves to one of two terminal states:
// 'refilled' (display replenished) or 'stockDepleted' (no inventory left to
// refill — feeds Phase 11 Insights by filtering orders). Show Completed
// toggle reveals both kinds with status-colored borders and a per-row Undo.
// nowTick is the parent's 30s ticker — used for "waiting Xm" chips so they
// update live without a render storm.
function DisplayRefillsTab({ dueRefills, completedRefills, showCompleted, setShowCompleted, onSetStatus, onUndo, nowTick, selectedHub }) {
  const fmtWaiting = (iso) => {
    const ms = nowTick - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  if (!dueRefills.length && !completedRefills.length) return (
    <div style={{ textAlign:"center", color:"#444", padding:"4rem" }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeOpacity="0.4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      <div style={{ fontSize:"1rem", marginTop:"0.75rem", color:"rgba(255,255,255,.55)" }}>No display refills pending.</div>
      <div style={{ fontSize:"0.85rem", color:"#333", marginTop:"0.5rem" }}>Partner orders sent from {HUB_LABELS[selectedHub] || selectedHub} appear here 15 minutes after they're marked sent.</div>
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {/* Header: count + instruction */}
      {dueRefills.length > 0 && (
        <div style={{ background:"rgba(245,158,11,.06)", border:"1px solid rgba(245,158,11,.3)", borderRadius:14, padding:"12px 14px", display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ fontWeight:800, fontSize:30, color:"#F59E0B", lineHeight:1, letterSpacing:"-1px" }}>{dueRefills.length}</div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, color:"#fff", fontSize:13 }}>Display Refill{dueRefills.length !== 1 ? "s" : ""} Due</div>
            <div style={{ color:"rgba(255,255,255,.5)", fontSize:11, marginTop:2 }}>Put each item back on the display shelf, then tap Refilled.</div>
          </div>
        </div>
      )}

      {/* Show / Hide Completed toggle */}
      {completedRefills.length > 0 && (
        <button onClick={() => setShowCompleted(v => !v)}
                style={{ alignSelf:"flex-start", display:"flex", alignItems:"center", gap:6, padding:"7px 11px", borderRadius:999,
                         border: showCompleted ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
                         background: showCompleted ? "rgba(60,110,255,.12)" : "rgba(255,255,255,.03)",
                         color: showCompleted ? BLUE_L : "rgba(255,255,255,.55)",
                         fontWeight:600, fontSize:12, cursor:"pointer" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {showCompleted
              ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>
              : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>}
          </svg>
          {showCompleted ? "Hide" : "Show"} Completed ({completedRefills.length})
        </button>
      )}

      {/* All-caught-up state */}
      {dueRefills.length === 0 && completedRefills.length > 0 && !showCompleted && (
        <div style={{ background:CARD, border:"1px solid rgba(74,222,128,.4)", borderRadius:14, padding:"22px 18px", textAlign:"center", boxShadow:"0 0 12px rgba(74,222,128,.12)" }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 6px rgba(74,222,128,.35))" }}>
            <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
          </svg>
          <div style={{ color:"#fff", fontSize:14, fontWeight:700, marginTop:10 }}>All caught up</div>
          <div style={{ color:"rgba(255,255,255,.55)", fontSize:12, marginTop:4 }}>{completedRefills.length} task{completedRefills.length !== 1 ? "s" : ""} resolved.</div>
        </div>
      )}

      {/* Due cards — grouped by day, oldest-first within each bucket.
          includeOlder=true preserves the Phase 9.5 "never lose a due refill"
          semantic by collapsing >3-day-old tasks into a separate Older bucket. */}
      {dueRefills.length > 0 && (
        <DayCollapsible
          sectionKey="refills-due"
          items={dueRefills}
          dateOf={(o) => o.displayRefillScheduledAt}
          includeOlder={true}
          emptyMessage="No display refills due."
          renderItem={(order) => (
            <div style={{ background:CARD, border:"1px solid rgba(245,158,11,.4)", borderLeft:"3px solid #F59E0B", borderRadius:RADIUS, padding:14, boxShadow:"0 0 12px rgba(245,158,11,.1)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
                <ProductPhoto url={order.productPhotoUrl} photo={order.productPhoto} size={48} radius={10}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                    <span style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:800, fontSize:"1.1rem", color:BLUE_L, lineHeight:1 }}>#{order.id}</span>
                    <span style={{ background:"rgba(245,158,11,.15)", color:"#F59E0B", border:"1px solid rgba(245,158,11,.35)", borderRadius:999, padding:"1px 8px", fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px" }}>Partner</span>
                    <span style={{ marginLeft:"auto", background:"rgba(255,255,255,.04)", color:"rgba(255,255,255,.55)", border:"1px solid rgba(255,255,255,.08)", borderRadius:999, padding:"1px 8px", fontSize:10, fontWeight:600 }}>
                      waiting {fmtWaiting(order.displayRefillScheduledAt)}
                    </span>
                  </div>
                  <div style={{ fontWeight:700, color:"#fff", fontSize:13 }}>{order.productName}{order.size || order.sentSize ? ` — Size ${sourceDisplaySize(order)}` : ""}</div>
                </div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => onSetStatus(order, "refilled")}
                        style={{ flex:1, padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, background:"rgba(0,150,70,.2)", border:"1px solid rgba(0,180,80,.4)", color:"#4ADE80" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Refilled
                </button>
                <button onClick={() => onSetStatus(order, "stockDepleted")}
                        style={{ flex:1, padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, background:"rgba(150,20,20,.15)", border:"1px solid rgba(180,40,40,.4)", color:"#F87171" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  Stock Depleted
                </button>
              </div>
            </div>
          )}
        />
      )}

      {/* Completed cards — revealed by toggle. Day-grouped (24h cap upstream
          means at most today + yesterday will ever have items). */}
      {showCompleted && completedRefills.length > 0 && (
        <>
          <div style={{ marginTop:10, marginBottom:2, display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ height:1, flex:1, background:"rgba(255,255,255,.06)" }} />
            <div style={{ fontSize:10, fontWeight:700, color:"rgba(255,255,255,.4)", letterSpacing:"1.2px" }}>COMPLETED</div>
            <div style={{ height:1, flex:1, background:"rgba(255,255,255,.06)" }} />
          </div>
          <DayCollapsible
            sectionKey="refills-done"
            items={completedRefills}
            dateOf={(o) => o.displayRefilledAt || o.displayRefillStockDepletedAt}
            emptyMessage="No completed refills."
            renderItem={(order) => {
              const isDepleted = order.displayRefillStatus === "stockDepleted";
              const accent = isDepleted ? "rgba(248,113,113,.5)"  : "rgba(74,222,128,.5)";
              const tint   = isDepleted ? "rgba(248,113,113,.1)"  : "rgba(74,222,128,.1)";
              const text   = isDepleted ? "#F87171"               : "#4ADE80";
              return (
                <div style={{ background:CARD, border:`1px solid ${accent}`, borderLeft:`3px solid ${accent}`, borderRadius:RADIUS, padding:14, opacity:0.85 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
                    <ProductPhoto url={order.productPhotoUrl} photo={order.productPhoto} size={44} radius={10}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                        <span style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:800, fontSize:"1rem", color:"rgba(255,255,255,.85)", lineHeight:1 }}>#{order.id}</span>
                        <span style={{ display:"inline-flex", alignItems:"center", gap:4, background:tint, color:text, border:`1px solid ${accent}`, borderRadius:999, padding:"1px 7px", fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px" }}>
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                            {isDepleted
                              ? <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>
                              : <polyline points="20 6 9 17 4 12"/>}
                          </svg>
                          {isDepleted ? "Stock Depleted" : "Refilled"}
                        </span>
                      </div>
                      <div style={{ fontWeight:600, color:"rgba(255,255,255,.85)", fontSize:12 }}>{order.productName}{order.size || order.sentSize ? ` — Size ${sourceDisplaySize(order)}` : ""}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex", justifyContent:"flex-end" }}>
                    <button onClick={() => onUndo(order)}
                            style={{ padding:"7px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.12)", background:"rgba(255,255,255,.04)", color:"rgba(255,255,255,.7)", fontWeight:600, fontSize:11, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                      </svg>
                      Undo
                    </button>
                  </div>
                </div>
              );
            }}
          />
        </>
      )}
    </div>
  );
}

// ─── CLOTHING REFILLS TAB (Phase 12C, hub2 only) ──────────────────────────────
// Each card represents one refill batch — clothing orders that share a
// (productId, createdAt) pair. The Phase 12B writer puts all sizes from one
// "Place Refill Request" tap into a single loop with one shared timestamp,
// so this groups by batch cleanly. The two card actions (Available / Out of
// Stock) resolve every order in the batch atomically.
//
// Active list: last 3 days (strict, no Older bucket — clothing requests don't
// stay due indefinitely like display refills do).
// Completed list: 24h window after resolution (mirrors Phase 9.5 cleanup),
// applied upstream in the parent memo. Undo clears the status fields and
// returns the batch to the active list.
function ClothingRefillsTab({ activeBatches, completedBatches, showCompleted, setShowCompleted, onSetStatus, onUndo }) {
  const fmtTime = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
  };

  if (!activeBatches.length && !completedBatches.length) return (
    <div style={{ textAlign:"center", color:"#444", padding:"4rem" }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeOpacity="0.4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4l-4 4-4-4M3 7l5-3h8l5 3M3 7v13a1 1 0 001 1h16a1 1 0 001-1V7M3 7l4 4M21 7l-4 4"/></svg>
      <div style={{ fontSize:"1rem", marginTop:"0.75rem", color:"rgba(255,255,255,.55)" }}>No clothing refills pending.</div>
      <div style={{ fontSize:"0.85rem", color:"#333", marginTop:"0.5rem" }}>Internal refill requests placed by the shop appear here.</div>
    </div>
  );

  // Renders the sizes-with-qty chips line, e.g. "M ×5 · L ×3 · XL ×2".
  const renderItemsLine = (items) => (
    <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:6 }}>
      {items.map(it => (
        <span key={it.orderId} style={{ display:"inline-flex", alignItems:"center", gap:4, background:"rgba(60,110,255,.08)", border:"1px solid rgba(60,110,255,.25)", borderRadius:7, padding:"3px 8px", fontSize:11, fontWeight:600, color:"#fff" }}>
          <span>{it.size}</span>
          <span style={{ background:"rgba(60,110,255,.25)", color:BLUE_L, borderRadius:999, padding:"0 6px", fontSize:10, fontWeight:700 }}>×{it.qty}</span>
        </span>
      ))}
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {/* Header summary */}
      {activeBatches.length > 0 && (
        <div style={{ background:"rgba(20,40,100,.3)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:"12px 14px", display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ fontWeight:800, fontSize:30, color:"#4A7FFF", lineHeight:1, letterSpacing:"-1px" }}>{activeBatches.length}</div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, color:"#fff", fontSize:13 }}>Clothing Refill{activeBatches.length !== 1 ? "s" : ""} Pending</div>
            <div style={{ color:"rgba(255,255,255,.5)", fontSize:11, marginTop:2 }}>Internal shop requests waiting for Hub 2 fulfillment.</div>
          </div>
        </div>
      )}

      {/* Active list — day-grouped, last 3 days only. */}
      {activeBatches.length > 0 && (
        <DayCollapsible
          sectionKey="clothing-due"
          items={activeBatches}
          dateOf={(b) => b.createdAt}
          emptyMessage="No clothing refills pending."
          renderItem={(batch) => (
            <div style={{ background:CARD, border:"1px solid rgba(60,110,255,.45)", borderLeft:"3px solid #4A7FFF", borderRadius:RADIUS, padding:14, boxShadow:"0 0 12px rgba(60,110,255,.12)" }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:10 }}>
                <ProductPhoto url={batch.productPhotoUrl} photo={batch.productPhoto} size={56} radius={10}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>{batch.productName}</div>
                  <div style={{ color:"rgba(255,255,255,.45)", fontSize:10, marginTop:2 }}>Submitted {fmtTime(batch.createdAt)}</div>
                  {renderItemsLine(batch.items)}
                </div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => onSetStatus(batch, "available")}
                        style={{ flex:1, padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, background:"rgba(0,150,70,.2)", border:"1px solid rgba(0,180,80,.4)", color:"#4ADE80" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Available
                </button>
                <button onClick={() => onSetStatus(batch, "outOfStock")}
                        style={{ flex:1, padding:"11px 8px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6, background:"rgba(150,20,20,.15)", border:"1px solid rgba(180,40,40,.4)", color:"#F87171" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  Out of Stock
                </button>
              </div>
            </div>
          )}
        />
      )}

      {/* Show / Hide Completed toggle pill (single useState — Hub 2 only). */}
      {completedBatches.length > 0 && (
        <button onClick={() => setShowCompleted(v => !v)}
                style={{ alignSelf:"flex-start", display:"flex", alignItems:"center", gap:6, padding:"7px 11px", borderRadius:999,
                         border: showCompleted ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
                         background: showCompleted ? "rgba(60,110,255,.12)" : "rgba(255,255,255,.03)",
                         color: showCompleted ? BLUE_L : "rgba(255,255,255,.55)",
                         fontWeight:600, fontSize:12, cursor:"pointer" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {showCompleted
              ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>
              : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>}
          </svg>
          {showCompleted ? "Hide" : "Show"} Completed ({completedBatches.length})
        </button>
      )}

      {/* All-caught-up state when active is empty but completed has items. */}
      {activeBatches.length === 0 && completedBatches.length > 0 && !showCompleted && (
        <div style={{ background:CARD, border:"1px solid rgba(74,222,128,.4)", borderRadius:14, padding:"22px 18px", textAlign:"center", boxShadow:"0 0 12px rgba(74,222,128,.12)" }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 6px rgba(74,222,128,.35))" }}>
            <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
          </svg>
          <div style={{ color:"#fff", fontSize:14, fontWeight:700, marginTop:10 }}>All caught up</div>
          <div style={{ color:"rgba(255,255,255,.55)", fontSize:12, marginTop:4 }}>{completedBatches.length} batch{completedBatches.length !== 1 ? "es" : ""} resolved.</div>
        </div>
      )}

      {/* Completed list — day-grouped, 24h cap upstream. */}
      {showCompleted && completedBatches.length > 0 && (
        <DayCollapsible
          sectionKey="clothing-done"
          items={completedBatches}
          dateOf={(b) => b.resolvedAt || b.createdAt}
          emptyMessage="No completed clothing refills."
          renderItem={(batch) => {
            const isOOS = batch.status === "outOfStock";
            const accent = isOOS ? "rgba(248,113,113,.5)"  : "rgba(74,222,128,.5)";
            const tint   = isOOS ? "rgba(248,113,113,.1)"  : "rgba(74,222,128,.1)";
            const text   = isOOS ? "#F87171"               : "#4ADE80";
            return (
              <div style={{ background:CARD, border:`1px solid ${accent}`, borderLeft:`3px solid ${accent}`, borderRadius:RADIUS, padding:14, opacity:0.85 }}>
                <div style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:8 }}>
                  <ProductPhoto url={batch.productPhotoUrl} photo={batch.productPhoto} size={48} radius={10}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                      <span style={{ fontWeight:700, color:"rgba(255,255,255,.85)", fontSize:13 }}>{batch.productName}</span>
                      <span style={{ display:"inline-flex", alignItems:"center", gap:4, background:tint, color:text, border:`1px solid ${accent}`, borderRadius:999, padding:"1px 7px", fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px" }}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                          {isOOS
                            ? <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>
                            : <polyline points="20 6 9 17 4 12"/>}
                        </svg>
                        {isOOS ? "Out of Stock" : "Available"}
                      </span>
                    </div>
                    <div style={{ color:"rgba(255,255,255,.4)", fontSize:10 }}>Submitted {fmtTime(batch.createdAt)}</div>
                    {renderItemsLine(batch.items)}
                  </div>
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end" }}>
                  <button onClick={() => onUndo(batch)}
                          style={{ padding:"7px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.12)", background:"rgba(255,255,255,.04)", color:"rgba(255,255,255,.7)", fontWeight:600, fontSize:11, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                    Undo
                  </button>
                </div>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

// ─── WAREHOUSE RESTOCK TAB (live OOS log for today) ──────────────────────────
// Read-only view of today's OOS events and Source's responses to them.
function WarehouseRestockTab({ rawCounts, responses }) {
  const products = Object.entries(rawCounts);

  if (!products.length) return (
    <div style={{ textAlign:"center", color:"#444", padding:"4rem" }}>
      <ProductIcon size={32} opacity={0.4}/>
      <div style={{ fontSize:"1rem", marginTop:"0.75rem" }}>No out-of-stock events today yet.</div>
      <div style={{ fontSize:"0.85rem", color:"#333", marginTop:"0.5rem" }}>Items marked OOS appear here in real time.</div>
    </div>
  );

  const totalUnits = products.reduce((n, [, p]) => n + Object.values(p.sizes).reduce((s,c)=>s+(typeof c==="number"?c:1),0), 0);

  return (
    <div>
      <div style={{ color:"#555", fontSize:"0.85rem", marginBottom:"1.25rem" }}>
        Live OOS log · {totalUnits} item{totalUnits !== 1 ? "s" : ""} logged today
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:"1rem" }}>
        {products.map(([key, product]) => {
          const sizes = Object.keys(product.sizes).sort((a,b)=>Number(a)-Number(b));
          const productResponses = responses[key] || {};
          return (
            <div key={key} style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.25rem" }}>
              <div style={{ display:"flex", alignItems:"center", gap:"0.75rem", marginBottom:"0.75rem" }}>
                <ProductPhoto url={product.photoUrl} photo={product.photo} size={40} radius={8}/>
                <div style={{ fontWeight:"700", fontSize:"1rem" }}>{product.productName}</div>
              </div>
              <div style={{ display:"flex", gap:"0.5rem", flexWrap:"wrap" }}>
                {sizes.map(size => {
                  const count = typeof product.sizes[size] === "number" ? product.sizes[size] : 1;
                  const resp = productResponses[size]?.response;
                  return (
                    <div key={size} style={{
                      background: resp==="available"?"rgba(0,150,70,.15)":resp==="out_of_stock"?"rgba(150,20,20,.15)":CARD,
                      border:`2px solid ${resp==="available"?"rgba(0,150,70,.5)":resp==="out_of_stock"?"rgba(150,20,20,.4)":"rgba(60,110,255,.15)"}`,
                      borderRadius:"10px", padding:"0.5rem 0.75rem", textAlign:"center", minWidth:"64px",
                    }}>
                      <div style={{ fontWeight:"700", fontSize:"0.9rem", color:"#fff" }}>Sz {size}</div>
                      {count > 1 && <div style={{ color:"#4A7FFF", fontSize:"0.68rem", fontWeight:"700" }}>×{count}</div>}
                      {resp==="available"    && <div style={{ color:"#4ADE80", fontSize:"0.7rem", fontWeight:"600" }}>Avail</div>}
                      {resp==="out_of_stock" && <div style={{ color:"#F87171", fontSize:"0.7rem", fontWeight:"600" }}>OOS</div>}
                      {!resp                 && <div style={{ color:"#555", fontSize:"0.7rem" }}>Pending</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── CUSTOMER VIEW ────────────────────────────────────────────────────────────
function CustomerView({ orders, onExit }) {
  const [orderId, setOrderId] = useState("");
  const [found, setFound] = useState(null);
  const [searched, setSearched] = useState(false);

  const doSearch = () => {
    const clean = orderId.trim().replace(/^#/, "");
    const o = orders.find(o => o.id === clean.padStart(3,"0") || o.id === clean);
    setFound(o || null);
    setSearched(true);
  };

  const cfg = found ? STATUS_CONFIG[found.status] : null;

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 20px" }}>
      <div style={{ marginBottom:14, filter:"drop-shadow(0 0 14px rgba(60,110,255,.4))" }}>
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      </div>
      <h1 style={{ fontSize:22, fontWeight:600, marginBottom:6, color:"#fff" }}>Track Your Order</h1>
      <div style={{ fontSize:12, color:"rgba(255,255,255,.3)", marginBottom:36, textAlign:"center" }}>Enter your 3-digit order number</div>

      <input placeholder="000" value={orderId} onChange={e => setOrderId(e.target.value)}
             onKeyDown={e => e.key==="Enter" && doSearch()} maxLength={3}
             style={{ width:"100%", maxWidth:360, background:"rgba(6,9,20,1)", border:"1px solid rgba(60,110,255,.2)", borderRadius:12, padding:18, color:"#fff", fontSize:32, fontWeight:700, textAlign:"center", letterSpacing:"10px", outline:"none", marginBottom:10 }}/>
      <button onClick={doSearch} style={{ width:"100%", maxWidth:360, background:"rgba(60,110,255,.85)", color:"#fff", border:"none", borderRadius:9, padding:14, fontSize:14, fontWeight:600, cursor:"pointer" }}>Check Status →</button>
      {onExit && <div onClick={onExit} style={{ marginTop:18, color:"rgba(255,255,255,.25)", fontSize:12, cursor:"pointer" }}>← Back</div>}
      <div style={{ height:20 }}/>

      {searched && !found && <div style={{ color:"#F87171", background:"rgba(150,20,20,.15)", border:"1px solid rgba(150,20,20,.4)", borderRadius:RADIUS, padding:"1rem 2rem" }}>Order not found. Check your number.</div>}

      {found && cfg && (
        <div style={{ background:CARD, border:`2px solid ${cfg.color}33`, borderRadius:RADIUS, padding:"2rem", maxWidth:"420px", width:"100%", textAlign:"center", boxShadow:GLOW }}>
          <div style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"5rem", color:BLUE, lineHeight:1, marginBottom:"0.25rem", letterSpacing:"0.05em" }}>#{found.id}</div>
          <div style={{ background:cfg.bg, color:cfg.color, border:`1px solid ${cfg.border}`, borderRadius:"999px", padding:"0.5rem 1.5rem", display:"inline-block", fontWeight:"700", fontSize:"1.1rem", marginBottom:"1rem" }}>{cfg.icon} {cfg.label}</div>
          <div style={{ fontWeight:"600", fontSize:"1.1rem", marginBottom:"0.25rem" }}>{found.productName} · Size {found.size}</div>
          <div style={{ color:"#666", fontSize:"0.85rem" }}>For {found.customerName}</div>
          {found.status===STATUS.INCOMING        && <div style={{ marginTop:"1.5rem", color:"#4A7FFF", fontSize:"0.9rem", background:"rgba(60,110,255,.1)", borderRadius:"10px", padding:"0.75rem" }}>Your order is being prepared. We'll have it ready soon.</div>}
          {found.status===STATUS.READY           && <div style={{ marginTop:"1.5rem", color:"#4ADE80", fontSize:"0.9rem", background:"rgba(74,222,128,.1)", borderRadius:"10px", padding:"0.75rem" }}>Your order is ready. Please collect it at the store.</div>}
          {found.status===STATUS.OUT_OF_STOCK    && <div style={{ marginTop:"1.5rem", color:"#F87171", fontSize:"0.9rem", background:"rgba(248,113,113,.1)", borderRadius:"10px", padding:"0.75rem" }}>Sorry, this item is out of stock. Please speak to an assistant.</div>}
          {found.status===STATUS.COLLECTED       && <div style={{ marginTop:"1.5rem", color:"#9CA3AF", fontSize:"0.9rem", background:"rgba(156,163,175,.1)", borderRadius:"10px", padding:"0.75rem" }}>This order has been collected. Thank you.</div>}
          {found.status===STATUS.COMING_TOMORROW && <div style={{ marginTop:"1.5rem", color:BLUE_L, fontSize:"0.9rem", background:"rgba(74,130,255,.1)", borderRadius:"10px", padding:"0.75rem" }}>Your item will be available tomorrow. Please come back then.</div>}
        </div>
      )}

      {!searched && orders.length > 0 && (
        <div style={{ maxWidth:"420px", width:"100%", marginTop:"1.5rem" }}>
          <div style={{ color:"#444", fontSize:"0.8rem", textAlign:"center", marginBottom:"0.75rem" }}>Recent orders</div>
          {orders.slice(0,4).map(o => (
            <button key={o.id} onClick={() => setOrderId(o.id)} style={{ width:"100%", background:CARD, border:BORDER, borderRadius:"10px", padding:"0.75rem 1rem", marginBottom:"0.5rem", color:"#888", fontSize:"0.85rem", cursor:"pointer", textAlign:"left", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"1.3rem", color:BLUE, letterSpacing:"0.05em" }}>#{o.id}</span>
              <span>{o.customerName} · {o.productName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TV DISPLAY VIEW ──────────────────────────────────────────────────────────
// Customer-centric layout for a 1920×1080 TV. The single thing a waiting
// customer cares about is "is my order ready to collect?" — so READY gets a
// hero card occupying ~60% of the screen with very large numbers, while the
// other three statuses share a 3-up row of compact cards below.
//
// Layout (top → bottom, all flex with min-height:0 plumbing so nothing
// overflows 100vh):
//   - Header (70px): Marathon wordmark + shoe icon, time + date
//   - Hero READY card (flex 1.6) with checkmark icon, "Ready to Collect"
//     title, total count, and a number area whose layout adapts to count:
//        0       → "No orders ready right now"
//        1 or 2  → giant centered numbers (~180px)
//        3–8     → 8-column 1-row grid (larger numbers)
//        9–36    → 12-column grid with rows depending on count
//        > 36    → paginated 36 at a time, calm fade between pages
//   - Three-up secondary row (flex 1): Incoming, Out of Stock, Coming
//     Tomorrow each in a small card with icon + title + total + 6-column
//     number grid (paginated at 18 per page).
//
// Pagination: each section rotates pages every TV_PAGE_ROTATE_MS with a
// TV_PAGE_FADE_MS opacity fade. Sections cycle independently from a shared
// pageTick.
//
// Side effects: only IN-STOCK READY orders past TV_EXPIRY_MS are auto-moved to
// COLLECTED (with restock log). OUT-OF-STOCK orders are NEVER auto-collected and
// write no restock (we only restock what we have) — they stay OOS as kept demand
// and are merely display-hidden from the customer screen past TV_EXPIRY_MS, like
// Coming Tomorrow rows past TV_COMING_TOMORROW_VISIBLE_MS (no RTDB mutation).
// Ref-Sets dedupe across multiple TV screens and prune entries on daily reset.
const TV_HERO_PAGE_SIZE             = 36;
const TV_SECONDARY_PAGE_SIZE        = 18;
const TV_PAGE_ROTATE_MS             = 120 * 1000;
const TV_PAGE_FADE_MS               = 250;
const TV_EXPIRY_MS                  = 8 * 60 * 1000;
const TV_EXPIRY_CHECK_MS            = 10 * 1000;
const TV_COMING_TOMORROW_VISIBLE_MS = 10 * 60 * 1000;
const TV_COLORS = {
  incoming:       "#6FA8FF",
  ready:          "#4ADE80",
  outOfStock:     "#F87171",
  comingTomorrow: "#FBBF24",
};
const TV_DAY_NAMES   = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const TV_MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function DisplayView({ orders }) {
  // 1s tick — keeps the clock fresh and re-evaluates derived filters
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Page-rotation tick — each paginated section computes its page from this
  const [pageTick, setPageTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPageTick(n => n + 1), TV_PAGE_ROTATE_MS);
    return () => clearInterval(t);
  }, []);

  const now     = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const dateStr = `${TV_DAY_NAMES[now.getDay()]} ${now.getDate()} ${TV_MONTH_NAMES[now.getMonth()]}`;

  // Background sweep. IN-STOCK READY past 8 min → auto-collect + restock (the real
  // "order done" event — mutates RTDB). OUT-OF-STOCK is EXCLUDED from auto-collect:
  // we only restock what we HAVE, so an OOS order gets no restock and is never
  // collected — it stays OOS (unfulfilled-demand data, already logged to insights_log
  // at mark-OOS time) and remains in the warehouse OOS tab. OOS + Coming Tomorrow are
  // only DISPLAY-hidden from the customer TV after their windows (no RTDB write).
  // Ref-Sets dedupe across multiple TV screens; stale entries pruned on daily reset.
  const expiredRef           = useRef(new Set());  // READY orders already auto-collected
  const hiddenOos            = useRef(new Set());  // OOS hidden from the TV (display-only)
  const hiddenComingTomorrow = useRef(new Set());
  useEffect(() => {
    const check = () => {
      const nowMs = Date.now();
      const liveIds = new Set(orders.map(o => o.id));
      // Prune refs of orders no longer present (daily counter reset, etc.)
      for (const id of expiredRef.current)           if (!liveIds.has(id)) expiredRef.current.delete(id);
      for (const id of hiddenOos.current)            if (!liveIds.has(id)) hiddenOos.current.delete(id);
      for (const id of hiddenComingTomorrow.current) if (!liveIds.has(id)) hiddenComingTomorrow.current.delete(id);

      orders.forEach(o => {
        // NOTE: DisplayView is LEGACY/unused — the DISPLAY role renders
        // <TvWithAutoCollect> (above), not this. Auto-collect was removed here too
        // so this dead path can never flip READY→COLLECTED if it's ever re-mounted.
        // Collection is confirmed only by a real POS sale; the timer is display-only.
        if (o.status === STATUS.READY && !expiredRef.current.has(o.id)) {
          const ts = o.readyAt || o.updatedAt;
          if (ts && nowMs - new Date(ts).getTime() >= TV_EXPIRY_MS) {
            expiredRef.current.add(o.id);   // display-only marker; no RTDB write
          }
        }
        // OUT-OF-STOCK → display-only hide from the customer TV (NO RTDB write; the
        // order stays OOS as kept demand). Same expiry window as Ready.
        if (o.status === STATUS.OUT_OF_STOCK && !hiddenOos.current.has(o.id)) {
          const ts = o.outOfStockAt || o.updatedAt;
          if (ts && nowMs - new Date(ts).getTime() >= TV_EXPIRY_MS) {
            hiddenOos.current.add(o.id);
          }
        }
        // Coming Tomorrow → display-only hide
        if (o.status === STATUS.COMING_TOMORROW && !hiddenComingTomorrow.current.has(o.id)) {
          const ts = o.comingTomorrowAt || o.updatedAt;
          if (ts && nowMs - new Date(ts).getTime() >= TV_COMING_TOMORROW_VISIBLE_MS) {
            hiddenComingTomorrow.current.add(o.id);
          }
        }
      });
    };
    check();
    const id = setInterval(check, TV_EXPIRY_CHECK_MS);
    return () => clearInterval(id);
  }, [orders]);

  const incoming       = orders.filter(o => o.status === STATUS.INCOMING);
  const ready          = orders.filter(o => o.status === STATUS.READY);
  const outOfStock     = orders.filter(o => o.status === STATUS.OUT_OF_STOCK && !hiddenOos.current.has(o.id));
  const comingTomorrow = orders.filter(o =>
    o.status === STATUS.COMING_TOMORROW && !hiddenComingTomorrow.current.has(o.id)
  );

  return (
    <div style={{
      height:"100vh", width:"100vw",
      background:"#0B0F1A", color:"#fff", fontFamily:FONT,
      padding:"24px", boxSizing:"border-box",
      display:"flex", flexDirection:"column", overflow:"hidden",
    }}>
      <style>{`@keyframes tvFade { from { opacity: 0 } to { opacity: 1 } }`}</style>

      {/* HEADER */}
      <div style={{ height:"70px", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"14px" }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 17h13a4 4 0 003-1.4l3-3.4a2 2 0 00-1.5-3.3l-5.4-.1a2 2 0 01-1.5-.7l-1.7-2A3 3 0 008.4 5H4a2 2 0 00-2 2v10z"/>
            <line x1="2" y1="14" x2="20" y2="14"/>
          </svg>
          <span style={{ fontSize:"40px", fontWeight:700, color:"#fff", lineHeight:1 }}>Marathon</span>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:"44px", fontWeight:700, color:"#fff", lineHeight:1, fontVariantNumeric:"tabular-nums" }}>{timeStr}</div>
          <div style={{ fontSize:"18px", fontWeight:400, color:"#9CA3AF", marginTop:"6px" }}>{dateStr}</div>
        </div>
      </div>

      {/* HERO READY — ~60% of remaining height */}
      <div style={{ flex:"1.6 1 0", minHeight:0, marginTop:"16px" }}>
        <HeroReadyCard orders={ready} pageTick={pageTick} />
      </div>

      {/* SECONDARY ROW — three compact cards sharing ~40% */}
      <div style={{ flex:"1 1 0", minHeight:0, marginTop:"16px", display:"flex", gap:"16px" }}>
        <SecondaryCard label="Incoming"        color={TV_COLORS.incoming}       orders={incoming}       Icon={IconShoppingBag} pageTick={pageTick} />
        <SecondaryCard label="Out of Stock"    color={TV_COLORS.outOfStock}     orders={outOfStock}     Icon={IconX}           pageTick={pageTick} />
        <SecondaryCard label="Coming Tomorrow" color={TV_COLORS.comingTomorrow} orders={comingTomorrow} Icon={IconClock}       pageTick={pageTick} />
      </div>
    </div>
  );
}

// ─── HERO READY CARD ─────────────────────────────────────────────────────────
// The dominant focal point. Title row at top; below it, a number area that
// switches layout by count to keep digits as large as possible:
//   0       → "no orders ready" muted text
//   1 or 2  → giant centered numbers (~180px)
//   3–8     → 8-column 1-row grid (very large numbers)
//   9–36    → 12-column grid (rows scale with count)
//   > 36    → paginated 36 at a time
function HeroReadyCard({ orders, pageTick }) {
  const color    = TV_COLORS.ready;
  const total    = orders.length;
  const numPages = Math.max(1, Math.ceil(total / TV_HERO_PAGE_SIZE));
  const page     = numPages === 1 ? 0 : pageTick % numPages;
  const visible  = orders.slice(page * TV_HERO_PAGE_SIZE, (page + 1) * TV_HERO_PAGE_SIZE);
  const count    = visible.length;
  // For 3–8 use a tighter 8-col grid so each number stays huge.
  const cols     = count <= 8 ? Math.min(8, count) : 12;

  const gridRef = useRef(null);
  const [cellFontSize, setCellFontSize] = useState(60);
  useEffect(() => {
    if (count <= 2) return;
    const el = gridRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      const gap  = 16;
      const rows = Math.max(1, Math.ceil(count / cols));
      const cellW = (w - (cols - 1) * gap) / cols;
      const cellH = rows === 1 ? h : (h - (rows - 1) * gap) / rows;
      const size  = Math.max(20, Math.min(220, Math.round(Math.min(cellW * 0.5, cellH * 0.85))));
      setCellFontSize(size);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count, cols]);

  return (
    <div style={{
      width:"100%", height:"100%",
      background:"#141A2A", borderRadius:"24px",
      padding:"32px 40px", boxSizing:"border-box",
      display:"flex", flexDirection:"column", overflow:"hidden",
      position:"relative",
    }}>
      {/* Title bar */}
      <div style={{ flexShrink:0, display:"flex", alignItems:"center", gap:"16px", marginBottom:"16px" }}>
        <div style={{ color, display:"flex" }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div style={{ fontSize:"34px", fontWeight:700, color, lineHeight:1 }}>Ready to Collect</div>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"baseline", gap:"10px" }}>
          <div style={{ fontSize:"14px", color:"#9CA3AF", textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:600 }}>Total</div>
          <div style={{ fontSize:"44px", fontWeight:800, color, lineHeight:1, fontVariantNumeric:"tabular-nums" }}>{total}</div>
        </div>
        {numPages > 1 && (
          <div style={{ fontSize:"14px", color:"rgba(255,255,255,.4)", fontVariantNumeric:"tabular-nums", marginLeft:"12px" }}>
            {page + 1}/{numPages}
          </div>
        )}
      </div>

      {/* Number area */}
      <div style={{ flex:"1 1 0", minHeight:0 }}>
        {count === 0 ? (
          <div style={{
            height:"100%", display:"flex", alignItems:"center", justifyContent:"center",
            color:"rgba(255,255,255,.22)", fontSize:"28px", fontWeight:400,
          }}>
            No orders ready right now
          </div>
        ) : count <= 2 ? (
          <div key={page} style={{
            height:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:"80px",
            animation:`tvFade ${TV_PAGE_FADE_MS}ms ease`,
          }}>
            {visible.map(o => (
              <div key={o.id} style={{
                fontSize:"180px", fontWeight:800, color, lineHeight:1,
                fontVariantNumeric:"tabular-nums",
              }}>{o.id}</div>
            ))}
          </div>
        ) : (
          <div key={page} ref={gridRef} style={{
            width:"100%", height:"100%",
            display:"grid",
            gridTemplateColumns:`repeat(${cols}, minmax(0, 1fr))`,
            gridAutoRows:"minmax(0, 1fr)",
            gap:"16px", overflow:"hidden",
            animation:`tvFade ${TV_PAGE_FADE_MS}ms ease`,
          }}>
            {visible.map(o => (
              <div key={o.id} style={{
                minWidth:0, minHeight:0,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:`${cellFontSize}px`, fontWeight:800, color, lineHeight:1,
                fontVariantNumeric:"tabular-nums", overflow:"hidden",
              }}>{o.id}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SECONDARY STATUS CARD ───────────────────────────────────────────────────
// Compact card for Incoming / Out of Stock / Coming Tomorrow. Title bar with
// icon + label + total, then a 6-column number grid below. Pages at 18.
function SecondaryCard({ label, color, orders, Icon, pageTick }) {
  const total    = orders.length;
  const numPages = Math.max(1, Math.ceil(total / TV_SECONDARY_PAGE_SIZE));
  const page     = numPages === 1 ? 0 : pageTick % numPages;
  const visible  = orders.slice(page * TV_SECONDARY_PAGE_SIZE, (page + 1) * TV_SECONDARY_PAGE_SIZE);
  const count    = visible.length;

  const gridRef = useRef(null);
  const [cellFontSize, setCellFontSize] = useState(28);
  useEffect(() => {
    if (count === 0) return;
    const el = gridRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      const cols = 6, gap = 10;
      const rows = Math.max(1, Math.ceil(count / cols));
      const cellW = (w - (cols - 1) * gap) / cols;
      const cellH = rows === 1 ? h : (h - (rows - 1) * gap) / rows;
      const size  = Math.max(14, Math.min(96, Math.round(Math.min(cellW * 0.45, cellH * 0.8))));
      setCellFontSize(size);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);

  return (
    <div style={{
      flex:"1 1 0", minWidth:0,
      background:"#141A2A", borderRadius:"24px",
      padding:"22px 26px", boxSizing:"border-box",
      display:"flex", flexDirection:"column", overflow:"hidden",
      position:"relative",
    }}>
      {/* Title row */}
      <div style={{ flexShrink:0, display:"flex", alignItems:"center", gap:"12px", marginBottom:"14px" }}>
        <div style={{ color, display:"flex" }}>
          <Icon size={28} strokeWidth={2.6} />
        </div>
        <div style={{ fontSize:"22px", fontWeight:600, color, lineHeight:1 }}>{label}</div>
        <div style={{ marginLeft:"auto", fontSize:"32px", fontWeight:800, color, lineHeight:1, fontVariantNumeric:"tabular-nums" }}>{total}</div>
      </div>

      {/* Number grid */}
      <div style={{ flex:"1 1 0", minHeight:0 }}>
        {count === 0 ? (
          <div style={{
            height:"100%", display:"flex", alignItems:"center", justifyContent:"center",
            color:"rgba(255,255,255,.2)", fontSize:"15px", fontWeight:400, fontStyle:"italic",
          }}>
            none
          </div>
        ) : (
          <div key={page} ref={gridRef} style={{
            width:"100%", height:"100%",
            display:"grid",
            gridTemplateColumns:"repeat(6, minmax(0, 1fr))",
            gridAutoRows:"minmax(0, 1fr)",
            gap:"10px", overflow:"hidden",
            animation:`tvFade ${TV_PAGE_FADE_MS}ms ease`,
          }}>
            {visible.map(o => (
              <div key={o.id} style={{
                minWidth:0, minHeight:0,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:`${cellFontSize}px`, fontWeight:700, color, lineHeight:1,
                fontVariantNumeric:"tabular-nums", overflow:"hidden",
              }}>{o.id}</div>
            ))}
          </div>
        )}
      </div>

      {/* Page indicator */}
      {numPages > 1 && (
        <div style={{
          position:"absolute", bottom:"10px", right:"18px",
          fontSize:"11px", color:"rgba(255,255,255,.3)",
          fontVariantNumeric:"tabular-nums", letterSpacing:"0.04em",
        }}>
          {page + 1}/{numPages}
        </div>
      )}
    </div>
  );
}

// ── TV display icons. Configurable size + strokeWidth; inherit accent via
//    currentColor on the parent. Used by both the hero (inline 40px check)
//    and the secondary cards (28px stroke 2.6) ──────────────────────────────
function IconShoppingBag({ size = 28, strokeWidth = 2.6 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
    <line x1="3" y1="6" x2="21" y2="6"/>
    <path d="M16 10a4 4 0 01-8 0"/>
  </svg>;
}
function IconCheck({ size = 28, strokeWidth = 2.6 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>;
}
function IconX({ size = 28, strokeWidth = 2.6 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>;
}
function IconClock({ size = 28, strokeWidth = 2.6 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </svg>;
}

// ─── SOURCE VIEW + COMPONENTS ────────────────────────────────────────────────
//
// HUB-SCOPED SOURCE FLOW
// ----------------------
// SourceView owns the active hub (hub1/hub2). It pre-filters orders by hub
// before computing rawCounts, so each tab component renders only its hub's
// items and never sees the other hub's data. React keys include the hub
// prefix to keep DOM nodes from colliding even when SourceView re-renders
// at a moment React reconciles tabs in the wrong order. Product-name
// collisions (e.g. "Air Max 90" vs "Air.Max.90" → "Air_Max_90") are
// detected in computeCollectedCounts and warned to console once each.
//
// "Available" and "Out of Stock" responses live at:
//   restock_requests/{date}/{productKey}/{size} = { response, respondedOn }
// Today's active list filters those cells OUT. The Completed toggle reveals
// them with green/red indicators and an Undo button (clearSourceResponse).

// Inline pill toggle used by Today / On Hold to reveal completed items.
function CompletedTogglePill({ on, count, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display:"flex", alignItems:"center", gap:6,
        padding:"7px 11px",
        borderRadius:999,
        border: on ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
        background: on ? "rgba(60,110,255,.12)" : "rgba(255,255,255,.03)",
        color: on ? BLUE_L : "rgba(255,255,255,.55)",
        fontWeight:600, fontSize:12, cursor:"pointer",
        marginBottom:12,
      }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {on
          ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>
          : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>}
      </svg>
      {on ? "Hide" : "Show"} Completed ({count})
    </button>
  );
}

// rawCounts  = { productKey: { productName, photo, photoUrl, sizes: { size: count } } }
// responses  = { productKey: { size: { response, respondedOn } } }  — live from Firebase
// hub        = "hub1" | "hub2"  — used only for keying/labels; data is already filtered upstream.
function SourceTodayTab({ rawCounts, responses, date, hub, onResponse, onUndo }) {
  // Per-hub toggle — each hub remembers whether its completed list is open.
  const [showCompletedByHub, setShowCompletedByHub] = useState({ hub1: false, hub2: false });
  const showCompleted = !!showCompletedByHub[hub];
  const setShowCompleted = (next) => setShowCompletedByHub(prev => ({
    ...prev,
    [hub]: typeof next === "function" ? next(!!prev[hub]) : next,
  }));

  // Build flat cell lists. Sort by product name then numeric size for stable
  // ordering — keeps cards from jumping when responses flow in.
  const { pending, completed, totalUnits, totalProducts } = useMemo(() => {
    const pending = [];
    const completed = [];
    let totalUnits = 0;
    const productsSeen = new Set();
    Object.entries(rawCounts)
      .sort(([, a], [, b]) => a.productName.localeCompare(b.productName))
      .forEach(([key, product]) => {
        const sizes = Object.keys(product.sizes || {}).sort((a, b) => Number(a) - Number(b));
        sizes.forEach(size => {
          const count = typeof product.sizes[size] === "number" ? product.sizes[size] : 1;
          totalUnits += count;
          productsSeen.add(key);
          const resp = responses[key]?.[size]?.response;
          const cell = { key, product, size, count };
          if (resp) completed.push({ ...cell, response: resp });
          else pending.push(cell);
        });
      });
    return { pending, completed, totalUnits, totalProducts: productsSeen.size };
  }, [rawCounts, responses]);

  // True empty state — nothing came in today at all.
  if (!pending.length && !completed.length) return (
    <div style={{ textAlign:"center", color:"#444", padding:"4rem" }}>
      <ProductIcon size={32} opacity={0.5}/>
      <div style={{ fontSize:"1rem", marginTop:"0.75rem" }}>No restock requests for this hub yet.</div>
      <div style={{ fontSize:"0.85rem", color:"#333", marginTop:"0.5rem" }}>Items collected by customers appear here for restocking.</div>
    </div>
  );

  const pendingUnits = pending.reduce((n, c) => n + c.count, 0);

  return (
    <div>
      {/* Summary headline — pending units, falls to "all done" tone when zero */}
      <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.6)", borderRadius:14, padding:"14px 16px", marginBottom:14, display:"flex", alignItems:"center", gap:14, boxShadow:"0 0 16px rgba(60,110,255,.2)" }}>
        <div style={{ fontWeight:800, fontSize:36, color:"#4A7FFF", lineHeight:1, letterSpacing:"-1px" }}>{pendingUnits}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>Refill Pending</div>
          <div style={{ color:"rgba(255,255,255,.5)", fontSize:11, marginTop:3, lineHeight:1.4 }}>
            {totalUnits} item{totalUnits !== 1 ? "s" : ""} sold today · {totalProducts} product{totalProducts !== 1 ? "s" : ""} · {date}
          </div>
        </div>
      </div>

      {/* Show / Hide Completed toggle (per hub, session state) */}
      {completed.length > 0 && (
        <CompletedTogglePill on={showCompleted} count={completed.length} onClick={() => setShowCompleted(v => !v)} />
      )}

      {/* Empty-active-but-completed state */}
      {pending.length === 0 && completed.length > 0 && !showCompleted && (
        <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(74,222,128,.4)", borderRadius:14, padding:"22px 18px", textAlign:"center", boxShadow:"0 0 12px rgba(74,222,128,.12)" }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 6px rgba(74,222,128,.35))" }}>
            <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
          </svg>
          <div style={{ color:"#fff", fontSize:14, fontWeight:700, marginTop:10 }}>All caught up</div>
          <div style={{ color:"rgba(255,255,255,.55)", fontSize:12, marginTop:4 }}>{completed.length} item{completed.length !== 1 ? "s" : ""} completed in this hub.</div>
          <button onClick={() => setShowCompleted(true)}
                  style={{ marginTop:14, padding:"8px 16px", borderRadius:10, border:"1px solid rgba(60,110,255,.5)", background:"rgba(60,110,255,.12)", color:BLUE_L, fontWeight:600, fontSize:12, cursor:"pointer" }}>
            Show Completed
          </button>
        </div>
      )}

      {/* Active list — pending cells only. Cards vanish on response. */}
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {pending.map(cell => (
          <PendingCard
            key={`${hub}-${cell.key}-${cell.size}`}
            product={cell.product}
            size={cell.size}
            count={cell.count}
            onAvailable={() => onResponse(cell.key, cell.size, "available")}
            onOutOfStock={() => onResponse(cell.key, cell.size, "out_of_stock")}
          />
        ))}
      </div>

      {/* Completed list — revealed by toggle */}
      {showCompleted && completed.length > 0 && (
        <>
          <div style={{ marginTop:18, marginBottom:10, display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ height:1, flex:1, background:"rgba(255,255,255,.06)" }} />
            <div style={{ fontSize:10, fontWeight:700, color:"rgba(255,255,255,.4)", letterSpacing:"1.2px" }}>COMPLETED</div>
            <div style={{ height:1, flex:1, background:"rgba(255,255,255,.06)" }} />
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {completed.map(cell => (
              <CompletedCard
                key={`${hub}-done-${cell.key}-${cell.size}`}
                product={cell.product}
                size={cell.size}
                count={cell.count}
                response={cell.response}
                onUndo={() => onUndo(cell.key, cell.size)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Single pending (product, size) cell — Available / Out of Stock buttons.
// Local pending state suppresses double-taps while Firebase echoes the write back.
function PendingCard({ product, size, count, onAvailable, onOutOfStock }) {
  const [busy, setBusy] = useState(false);
  const tap = (fn) => {
    if (busy) return;
    setBusy(true);
    fn();
    // Card will unmount when responses echo back; this is the belt-and-braces
    // guard for the tiny window between tap and Firebase round-trip.
    setTimeout(() => setBusy(false), 1500);
  };
  return (
    <div style={{
      background:"rgba(4,5,10,1)",
      border:"1px solid rgba(60,110,255,.6)",
      borderRadius:14,
      padding:14,
      boxShadow:"0 0 10px rgba(60,110,255,.15)",
      opacity: busy ? 0.7 : 1,
      transition:"opacity 120ms ease",
    }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
        <ProductPhoto url={product.photoUrl} photo={product.photo} size={48} radius={10}/>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>{product.productName}</div>
        </div>
      </div>
      <div style={{ display:"inline-flex", alignItems:"center", gap:8, background:"rgba(60,110,255,.1)", border:"1px solid rgba(60,110,255,.25)", borderRadius:8, padding:"6px 10px", marginBottom:10 }}>
        <span style={{ fontSize:13, fontWeight:700, color:"#fff" }}>Size {size}</span>
        {count > 1 && <span style={{ fontSize:10, color:"#4A7FFF", fontWeight:600 }}>×{count}</span>}
      </div>
      <div style={{ display:"flex", gap:8 }}>
        <button disabled={busy} onClick={() => tap(onAvailable)}
                style={{ flex:1, padding:"10px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.1)", background:"rgba(255,255,255,.03)", color:"rgba(255,255,255,.7)", cursor: busy ? "default" : "pointer", fontWeight:600, fontSize:12, display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          Available
        </button>
        <button disabled={busy} onClick={() => tap(onOutOfStock)}
                style={{ flex:1, padding:"10px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.1)", background:"rgba(255,255,255,.03)", color:"rgba(255,255,255,.7)", cursor: busy ? "default" : "pointer", fontWeight:600, fontSize:12, display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Out of Stock
        </button>
      </div>
    </div>
  );
}

// Single completed cell — colored indicator + Undo.
function CompletedCard({ product, size, count, response, onUndo }) {
  const isAvail = response === "available";
  const accent  = isAvail ? "rgba(74,222,128,.5)"  : "rgba(248,113,113,.5)";
  const tint    = isAvail ? "rgba(74,222,128,.08)" : "rgba(248,113,113,.08)";
  const text    = isAvail ? "#4ADE80"              : "#F87171";
  return (
    <div style={{
      background:"rgba(4,5,10,1)",
      border:`1px solid ${accent}`,
      borderLeft:`3px solid ${accent}`,
      borderRadius:14, padding:14,
      opacity:0.85,
    }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
        <ProductPhoto url={product.photoUrl} photo={product.photo} size={48} radius={10}/>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>{product.productName}</div>
          <div style={{ display:"inline-flex", alignItems:"center", gap:5, marginTop:4, padding:"2px 8px", borderRadius:999, background:tint, border:`1px solid ${accent}`, color:text, fontSize:10, fontWeight:700, letterSpacing:".5px", textTransform:"uppercase" }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              {isAvail ? <polyline points="20 6 9 17 4 12"/> : <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>}
            </svg>
            {isAvail ? "Available" : "Out of Stock"}
          </div>
        </div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <div style={{ display:"inline-flex", alignItems:"center", gap:8, background:"rgba(60,110,255,.08)", border:"1px solid rgba(60,110,255,.2)", borderRadius:8, padding:"5px 10px" }}>
          <span style={{ fontSize:12, fontWeight:700, color:"rgba(255,255,255,.7)" }}>Size {size}</span>
          {count > 1 && <span style={{ fontSize:10, color:BLUE, fontWeight:600 }}>×{count}</span>}
        </div>
        <div style={{ flex:1 }} />
        <button onClick={onUndo}
                style={{ padding:"7px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.12)", background:"rgba(255,255,255,.04)", color:"rgba(255,255,255,.7)", fontWeight:600, fontSize:11, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
          Undo
        </button>
      </div>
    </div>
  );
}

// Returns YYYY-MM-DD for `daysAgo` days before today in SA time.
function getSAPastDateString(daysAgo) {
  const t = Date.now() + 2 * 60 * 60 * 1000 - daysAgo * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

const HISTORY_DAY_LABELS = { 1: "YESTERDAY", 2: "2 DAYS AGO", 3: "3 DAYS AGO", 4: "4 DAYS AGO", 5: "5 DAYS AGO" };
const HISTORY_RETENTION_DAYS = 5;

// History tab shows pending stragglers from the past 1–5 days (excluding today,
// which is shown on Today's Request). A "straggler" = a (productKey, size) cell
// whose order was ready/collected on day-N, not OOS, not returned-on-day-N, and
// for which restock_requests/{day-N}/{key}/{size} has no response yet.
//
// Reactions write to restock_requests/{day-N}/{key}/{size} = { response, respondedOn:NOW }
// — see saveSourceResponse. The original-day path is what makes resolution
// stick across page loads; respondedOn carries "today's stamp" for the audit.
function SourceHistoryTab({ orders, returnsLog, allResponses, hub, onResponse }) {
  // Default expand: yesterday open, older closed. Stored by daysAgo number.
  const [openDays, setOpenDays] = useState(() => new Set([1]));
  const toggle = (d) => setOpenDays(prev => {
    const next = new Set(prev);
    next.has(d) ? next.delete(d) : next.add(d);
    return next;
  });

  // Per past day: build the same rawCounts shape SourceTodayTab uses, then
  // strip out (key, size) cells that already have a response on that date.
  // Orders are filtered to the active hub upstream of computeCollectedCounts.
  const groups = useMemo(() => {
    return Array.from({ length: HISTORY_RETENTION_DAYS }, (_, i) => i + 1).map(daysAgo => {
      const dateStr   = getSAPastDateString(daysAgo);
      const returned  = returnedOrderIdsOnSADate(returnsLog, dateStr);
      const dayOrders = (orders || []).filter(o =>
        o.status !== STATUS.OUT_OF_STOCK &&
        (o.status === STATUS.READY || o.status === STATUS.COLLECTED) &&
        orderSaleDate(o) === dateStr &&
        !returned.has(o.id) &&
        (o.hub || "hub1") === hub
      );
      const rawCounts = computeCollectedCounts(dayOrders);
      const dayResponses = allResponses[dateStr] || {};
      // Drop responded (key, size) cells; drop products that end up with no pending sizes.
      const pending = {};
      let pendingUnits = 0;
      Object.entries(rawCounts).forEach(([key, product]) => {
        const sizes = {};
        Object.entries(product.sizes || {}).forEach(([size, count]) => {
          if (dayResponses[key]?.[size]) return;
          sizes[size] = count;
          pendingUnits += (typeof count === "number" ? count : 1);
        });
        if (Object.keys(sizes).length) {
          pending[key] = { ...product, sizes };
        }
      });
      return { daysAgo, dateStr, label: HISTORY_DAY_LABELS[daysAgo], pending, pendingUnits };
    }).filter(g => g.pendingUnits > 0);
  }, [orders, returnsLog, allResponses, hub]);

  if (!groups.length) return (
    <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:"3rem 1.5rem", textAlign:"center", boxShadow:"0 0 16px rgba(60,110,255,.08)" }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 8px rgba(74,222,128,.4))" }}>
        <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
      </svg>
      <div style={{ color:"#fff", fontSize:14, fontWeight:600, marginTop:12 }}>Nothing pending for this hub. You're caught up.</div>
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {groups.map(g => {
        const isOpen = openDays.has(g.daysAgo);
        return (
          <div key={g.daysAgo} style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, overflow:"hidden" }}>
            {/* Header bar */}
            <div onClick={() => toggle(g.daysAgo)}
                 style={{ display:"flex", alignItems:"center", padding:"14px 16px", cursor:"pointer", gap:12 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <div style={{ flex:1, fontWeight:700, fontSize:12, letterSpacing:"1.2px", color:"#fff" }}>{g.label}</div>
              <div style={{ background:"rgba(60,110,255,.15)", color:"#4A7FFF", border:"1px solid rgba(60,110,255,.3)", borderRadius:999, padding:"3px 10px", fontSize:11, fontWeight:700 }}>
                {g.pendingUnits} pending
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                   style={{ transition:"transform 150ms ease", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", flexShrink:0 }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
            {/* Animated body */}
            <div style={{ maxHeight: isOpen ? 5000 : 0, overflow:"hidden", transition:"max-height 150ms ease" }}>
              <div style={{ borderTop:"1px solid rgba(60,110,255,.1)", padding:"12px 14px", display:"flex", flexDirection:"column", gap:10 }}>
                {Object.entries(g.pending).flatMap(([key, product]) => {
                  const sizes = Object.keys(product.sizes).sort((a, b) => Number(a) - Number(b));
                  return sizes.map(size => {
                    const count = typeof product.sizes[size] === "number" ? product.sizes[size] : 1;
                    return (
                      <div key={`${hub}-${g.daysAgo}-${key}-${size}`} style={{
                        background:"rgba(4,5,10,1)",
                        border:"1px solid rgba(60,110,255,.6)",
                        borderRadius:14, padding:14,
                        boxShadow:"0 0 10px rgba(60,110,255,.12)",
                      }}>
                        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
                          <ProductPhoto url={product.photoUrl} photo={product.photo} size={48} radius={10}/>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>{product.productName}</div>
                            <div style={{ color:"rgba(255,255,255,.4)", fontSize:10, marginTop:2 }}>
                              Requested {g.daysAgo === 1 ? "yesterday" : `${g.daysAgo} days ago`}
                            </div>
                          </div>
                        </div>
                        <div style={{ display:"inline-flex", alignItems:"center", gap:8, background:"rgba(60,110,255,.1)", border:"1px solid rgba(60,110,255,.25)", borderRadius:8, padding:"6px 10px", marginBottom:10 }}>
                          <span style={{ fontSize:13, fontWeight:700, color:"#fff" }}>Size {size}</span>
                          {count > 1 && <span style={{ fontSize:10, color:"#4A7FFF", fontWeight:600 }}>×{count}</span>}
                        </div>
                        <div style={{ display:"flex", gap:8 }}>
                          <button onClick={() => onResponse(g.dateStr, key, size, "available")}
                                  style={{ flex:1, padding:"10px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.1)", background:"rgba(255,255,255,.03)", color:"rgba(255,255,255,.7)", cursor:"pointer", fontWeight:600, fontSize:12, display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                            Available
                          </button>
                          <button onClick={() => onResponse(g.dateStr, key, size, "out_of_stock")}
                                  style={{ flex:1, padding:"10px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.1)", background:"rgba(255,255,255,.03)", color:"rgba(255,255,255,.7)", cursor:"pointer", fontWeight:600, fontSize:12, display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            Out of Stock
                          </button>
                        </div>
                      </div>
                    );
                  });
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── SOURCE: ON HOLD TAB ─────────────────────────────────────────────────────
// Tracks per-order responses at source_onhold_responses/{key}. Cards vanish
// when responded; the Completed toggle reveals them with green/red indicators
// and Undo removes the response so the order returns to the active list.
function SourceOnHoldTab({ orders, hub, onHoldResponses }) {
  // Per-hub toggle — each hub remembers whether its completed list is open.
  const [showCompletedByHub, setShowCompletedByHub] = useState({ hub1: false, hub2: false });
  const showCompleted = !!showCompletedByHub[hub];
  const setShowCompleted = (next) => setShowCompletedByHub(prev => ({
    ...prev,
    [hub]: typeof next === "function" ? next(!!prev[hub]) : next,
  }));
  const orderResponseKey = (orderId) => String(orderId).replace(/[.#$[\]/\s]/g, "_");

  // Hub-filtered, in-status orders sorted newest-first. Then split by whether
  // they have a response in source_onhold_responses.
  const { pending, completed } = useMemo(() => {
    const candidates = (orders || [])
      .filter(o => o.status === STATUS.COMING_TOMORROW && o.status !== STATUS.OUT_OF_STOCK)
      .filter(o => (o.hub || "hub1") === hub)
      .sort((a, b) => (b.comingTomorrowAt || b.updatedAt || "").localeCompare(a.comingTomorrowAt || a.updatedAt || ""));
    const pending = [];
    const completed = [];
    candidates.forEach(o => {
      const r = onHoldResponses[orderResponseKey(o.id)];
      if (r && r.response) completed.push({ order: o, response: r.response, timestamp: r.timestamp });
      else pending.push({ order: o });
    });
    return { pending, completed };
  }, [orders, onHoldResponses, hub]);

  const handleRespond = (order, response) => {
    const key = orderResponseKey(order.id);
    set(ref(database, `source_onhold_responses/${key}`), {
      orderNumber: order.id,
      productName: order.productName,
      size: order.size,
      customerName: order.customerName,
      response,
      timestamp: new Date().toISOString(),
    }).catch(err => console.warn("saveOnHoldResponse failed:", err));
  };

  const handleUndo = (order) => {
    const key = orderResponseKey(order.id);
    remove(ref(database, `source_onhold_responses/${key}`))
      .catch(err => console.warn("clearOnHoldResponse failed:", err));
  };

  const fmt = iso => iso ? new Date(iso).toLocaleString([], { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }) : "—";

  // True empty — nothing on hold for this hub, completed or otherwise.
  if (!pending.length && !completed.length) return (
    <div style={{ textAlign:"center", color:"#444", padding:"4rem" }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeOpacity="0.4" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <div style={{ fontSize:"1rem", marginTop:"0.75rem" }}>No orders on hold for this hub.</div>
      <div style={{ fontSize:"0.85rem", color:"#333", marginTop:"0.5rem" }}>Orders marked "Coming Tomorrow" appear here in real time.</div>
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"0.85rem" }}>
      {/* Instruction note */}
      <div style={{ background:CARD, border:BORDER_BRIGHT, borderRadius:RADIUS, padding:"0.75rem 1rem", color:BLUE_L, fontSize:"0.82rem", boxShadow:"0 0 12px rgba(60,110,255,.12)" }}>
        Tap <strong>Sent</strong> or <strong>Out of Stock</strong> to confirm each order
      </div>
      <div style={{ color:"#555", fontSize:"0.82rem" }}>
        {pending.length} order{pending.length !== 1 ? "s" : ""} waiting for next-day stock
      </div>

      {/* Show / Hide Completed toggle (per hub, session state) */}
      {completed.length > 0 && (
        <CompletedTogglePill on={showCompleted} count={completed.length} onClick={() => setShowCompleted(v => !v)} />
      )}

      {/* Empty-active-but-completed state */}
      {pending.length === 0 && completed.length > 0 && !showCompleted && (
        <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(74,222,128,.4)", borderRadius:14, padding:"22px 18px", textAlign:"center", boxShadow:"0 0 12px rgba(74,222,128,.12)" }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 6px rgba(74,222,128,.35))" }}>
            <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
          </svg>
          <div style={{ color:"#fff", fontSize:14, fontWeight:700, marginTop:10 }}>All caught up</div>
          <div style={{ color:"rgba(255,255,255,.55)", fontSize:12, marginTop:4 }}>{completed.length} order{completed.length !== 1 ? "s" : ""} completed in this hub.</div>
          <button onClick={() => setShowCompleted(true)}
                  style={{ marginTop:14, padding:"8px 16px", borderRadius:10, border:"1px solid rgba(60,110,255,.5)", background:"rgba(60,110,255,.12)", color:BLUE_L, fontWeight:600, fontSize:12, cursor:"pointer" }}>
            Show Completed
          </button>
        </div>
      )}

      {/* Active list */}
      {pending.map(({ order }) => (
        <div key={`${hub}-onhold-${order.id}`} style={{ background:CARD, border:BORDER_BRIGHT, borderRadius:RADIUS, padding:"1.1rem 1.25rem", boxShadow:"0 0 16px rgba(60,110,255,.15)", borderLeft:`3px solid ${BLUE}` }}>
          <div style={{ display:"flex", alignItems:"center", gap:"1rem", marginBottom:"0.85rem" }}>
            <ProductPhoto url={order.productPhotoUrl} photo={order.productPhoto} size={48} radius={8}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:"0.6rem", marginBottom:"0.2rem" }}>
                <span style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"1.4rem", color:BLUE_L, lineHeight:1, letterSpacing:"0.05em" }}>#{order.id}</span>
                <span style={{ background:"rgba(60,110,255,.12)", color:BLUE_L, border:BORDER, borderRadius:"999px", padding:"1px 8px", fontSize:"0.7rem", fontWeight:"600" }}>On Hold</span>
              </div>
              <div style={{ fontWeight:"600", fontSize:"0.92rem", color:"#fff" }}>{order.productName} — Size {sourceDisplaySize(order)}</div>
              <div style={{ color:"#888", fontSize:"0.8rem" }}>{order.customerName}</div>
              <div style={{ color:"#444", fontSize:"0.72rem", marginTop:"0.2rem" }}>Put on hold: {fmt(order.comingTomorrowAt || order.updatedAt)}</div>
            </div>
          </div>
          <div style={{ display:"flex", gap:"0.6rem" }}>
            <button
              onClick={() => handleRespond(order, "sent")}
              style={{ ...bGreen, flex:1, padding:"0.55rem", display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              Sent
            </button>
            <button
              onClick={() => handleRespond(order, "out_of_stock")}
              style={{ ...bRed, flex:1, padding:"0.55rem", display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Out of Stock
            </button>
          </div>
        </div>
      ))}

      {/* Completed list — revealed by toggle */}
      {showCompleted && completed.length > 0 && (
        <>
          <div style={{ marginTop:8, marginBottom:2, display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ height:1, flex:1, background:"rgba(255,255,255,.06)" }} />
            <div style={{ fontSize:10, fontWeight:700, color:"rgba(255,255,255,.4)", letterSpacing:"1.2px" }}>COMPLETED</div>
            <div style={{ height:1, flex:1, background:"rgba(255,255,255,.06)" }} />
          </div>
          {completed.map(({ order, response }) => {
            const isSent = response === "sent";
            const accent = isSent ? "rgba(74,222,128,.5)"  : "rgba(248,113,113,.5)";
            const tint   = isSent ? "rgba(74,222,128,.08)" : "rgba(248,113,113,.08)";
            const text   = isSent ? "#4ADE80"              : "#F87171";
            return (
              <div key={`${hub}-onhold-done-${order.id}`} style={{ background:CARD, border:`1px solid ${accent}`, borderLeft:`3px solid ${accent}`, borderRadius:RADIUS, padding:"1.1rem 1.25rem", opacity:0.85 }}>
                <div style={{ display:"flex", alignItems:"center", gap:"1rem", marginBottom:"0.6rem" }}>
                  <ProductPhoto url={order.productPhotoUrl} photo={order.productPhoto} size={48} radius={8}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:"0.6rem", marginBottom:"0.2rem" }}>
                      <span style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"1.2rem", color:"rgba(255,255,255,.85)", lineHeight:1, letterSpacing:"0.05em" }}>#{order.id}</span>
                      <span style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"2px 8px", borderRadius:999, background:tint, border:`1px solid ${accent}`, color:text, fontSize:10, fontWeight:700, letterSpacing:".5px", textTransform:"uppercase" }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                          {isSent ? <polyline points="20 6 9 17 4 12"/> : <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>}
                        </svg>
                        {isSent ? "Sent" : "Out of Stock"}
                      </span>
                    </div>
                    <div style={{ fontWeight:"600", fontSize:"0.9rem", color:"rgba(255,255,255,.85)" }}>{order.productName} — Size {sourceDisplaySize(order)}</div>
                    <div style={{ color:"#888", fontSize:"0.78rem" }}>{order.customerName}</div>
                  </div>
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end" }}>
                  <button onClick={() => handleUndo(order)}
                          style={{ padding:"7px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,.12)", background:"rgba(255,255,255,.04)", color:"rgba(255,255,255,.7)", fontWeight:600, fontSize:11, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                    Undo
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// Returns "YYYY-MM-DD" for yesterday in SA time.
function getSAYesterdayString() {
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

function SourceView({ onExit, orders, returnsLog }) {
  const [tab, setTab] = usePersistedTab("source", "today");
  // Active hub — shared across all three top tabs. Defaults to Hub 1.
  const [hub, setHub] = useState("hub1");
  const todayDate   = getSADateString();

  // On Hold response state — read once here so badges and the On Hold tab
  // share the same source of truth (no duplicate Firebase listeners).
  const [onHoldResponses, setOnHoldResponses] = useState({});
  useEffect(() => {
    const unsub = onValue(ref(database, "source_onhold_responses"), snap => {
      setOnHoldResponses(snap.val() || {});
    });
    return () => unsub();
  }, []);

  // Returned-today orderIds: same-period subtraction the Insights Net Sales
  // card applies. Returned items are physically back in the warehouse, so
  // they generate no restock work — drop them from the pull list and the
  // headline / per-product / X-products counts that derive from it.
  const returnedTodayIds = useMemo(
    () => returnedOrderIdsOnSADate(returnsLog, todayDate),
    [returnsLog, todayDate]
  );

  // ── Restock data filter rules ─────────────────────────────────────────────
  // Source has 3 tabs, each with a strict status filter.
  // Today's Request: READY + COLLECTED today           (sold/sent today)
  // On Hold:         COMING_TOMORROW                   (committed for tomorrow)
  // History:         READY + COLLECTED past dates      (historical sales)
  // EVERY tab + the home-page badge MUST exclude OUT_OF_STOCK.
  // OOS items have been confirmed gone by the warehouse — they generate
  // zero restock work for Source.
  // All three tabs are then sliced by the active hub (hub1/hub2). Orders
  // without an explicit hub field default to "hub1", matching the rest of
  // the app.

  // All-hub today list — keep one shared filter, then slice per-hub for counts
  // and the active tab. Cheap enough that we don't memo separately per hub.
  const todayRestockOrdersAll = useMemo(() =>
    orders.filter(o =>
      o.status !== STATUS.OUT_OF_STOCK &&
      (o.status === STATUS.READY || o.status === STATUS.COLLECTED) &&
      orderSaleDate(o) === todayDate &&
      !returnedTodayIds.has(o.id)
    ),
    [orders, todayDate, returnedTodayIds]
  );
  const todayRestockOrders = useMemo(
    () => todayRestockOrdersAll.filter(o => (o.hub || "hub1") === hub),
    [todayRestockOrdersAll, hub]
  );
  const rawCounts = useMemo(() => computeCollectedCounts(todayRestockOrders), [todayRestockOrders]);

  // All Source responses: { date: { productKey: { size: { response, respondedOn } } } }
  // History tab derives its straggler list from this + live orders (5-day window).
  const allResponses = useAllSourceResponses();

  // Per-hub pending counts for the Hub 1 / Hub 2 sub-tab badges. Mirrors the
  // exact same pending logic each tab uses (Today excludes responded cells,
  // History sums per-day stragglers, On Hold subtracts source_onhold_responses).
  const hubBadges = useMemo(() => {
    const counts = { hub1: 0, hub2: 0 };
    const todayResponses = allResponses[todayDate] || {};

    // -- Today: pending = unresponded cells from today's collected orders.
    ["hub1", "hub2"].forEach(h => {
      const hubOrders = todayRestockOrdersAll.filter(o => (o.hub || "hub1") === h);
      const counts2 = computeCollectedCounts(hubOrders);
      Object.entries(counts2).forEach(([key, product]) => {
        Object.entries(product.sizes || {}).forEach(([size, count]) => {
          if (todayResponses[key]?.[size]) return;
          counts[h] += (typeof count === "number" ? count : 1);
        });
      });
    });

    // -- History: pending = unresponded cells from each of past 1..N days.
    for (let daysAgo = 1; daysAgo <= HISTORY_RETENTION_DAYS; daysAgo++) {
      const dateStr  = getSAPastDateString(daysAgo);
      const returned = returnedOrderIdsOnSADate(returnsLog, dateStr);
      const dayResponses = allResponses[dateStr] || {};
      const dayOrdersBase = (orders || []).filter(o =>
        o.status !== STATUS.OUT_OF_STOCK &&
        (o.status === STATUS.READY || o.status === STATUS.COLLECTED) &&
        orderSaleDate(o) === dateStr &&
        !returned.has(o.id)
      );
      ["hub1", "hub2"].forEach(h => {
        const dayOrders = dayOrdersBase.filter(o => (o.hub || "hub1") === h);
        const counts2 = computeCollectedCounts(dayOrders);
        Object.entries(counts2).forEach(([key, product]) => {
          Object.entries(product.sizes || {}).forEach(([size, count]) => {
            if (dayResponses[key]?.[size]) return;
            counts[h] += (typeof count === "number" ? count : 1);
          });
        });
      });
    }

    // -- On Hold: pending = COMING_TOMORROW orders without source_onhold_responses entry.
    const respondedKeys = new Set(Object.keys(onHoldResponses));
    (orders || []).forEach(o => {
      if (o.status !== STATUS.COMING_TOMORROW) return;
      const h = (o.hub || "hub1");
      const key = String(o.id).replace(/[.#$[\]/\s]/g, "_");
      if (respondedKeys.has(key)) return;
      counts[h] += 1;
    });

    return counts;
  }, [todayRestockOrdersAll, allResponses, todayDate, orders, returnsLog, onHoldResponses]);

  // Top-tab On Hold badge — total pending across both hubs (matches old behavior).
  const onHoldCount = useMemo(() => {
    const respondedKeys = new Set(Object.keys(onHoldResponses));
    return (orders || []).filter(o =>
      o.status === STATUS.COMING_TOMORROW &&
      !respondedKeys.has(String(o.id).replace(/[.#$[\]/\s]/g, "_"))
    ).length;
  }, [orders, onHoldResponses]);

  // DEBUG — paste in browser console to inspect counted vs leaked orders.
  // Removed once you've verified the math is right. Lives in useEffect so it
  // doesn't get reassigned every render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__sourceDebug = () => {
      const candidates = orders.filter(o =>
        (o.status === STATUS.READY || o.status === STATUS.COLLECTED) &&
        o.status !== STATUS.OUT_OF_STOCK
      );
      const today = todayDate;
      const counted = candidates.filter(o => orderSaleDate(o) === today && !returnedTodayIds.has(o.id));
      const noReadyAt = candidates.filter(o => !o.readyAt && !o.collectedAt);
      const otherDays = candidates.filter(o => orderSaleDate(o) && orderSaleDate(o) !== today);
      const returnedOut = candidates.filter(o => orderSaleDate(o) === today && returnedTodayIds.has(o.id));
      const onHold = orders.filter(o => o.status === STATUS.COMING_TOMORROW);
      console.log("=== SOURCE DEBUG ===");
      console.log("Today:", today, "Active hub:", hub);
      console.log("Counted in TODAY's request (all hubs):", counted.length, counted.map(o => ({id:o.id, hub:o.hub || "hub1", status:o.status, readyAt:o.readyAt, collectedAt:o.collectedAt})));
      console.log("Hub badges (pending):", hubBadges);
      console.log("Excluded — no readyAt:", noReadyAt.length);
      console.log("Excluded — readyAt on other day:", otherDays.length);
      console.log("Excluded — returned today:", returnedOut.length);
      console.log("On Hold (Tomorrow, all hubs):", onHold.length);
      console.log("By status:", {
        READY:     candidates.filter(o => o.status === STATUS.READY).length,
        COLLECTED: candidates.filter(o => o.status === STATUS.COLLECTED).length,
        OOS:       orders.filter(o => o.status === STATUS.OUT_OF_STOCK).length,
        TOMORROW:  onHold.length,
        INCOMING:  orders.filter(o => o.status === STATUS.INCOMING).length,
      });
    };
  }, [orders, todayDate, returnedTodayIds, hub, hubBadges]);

  const handleResponse = (date, productKey, size, response) => {
    saveSourceResponse(date, productKey, size, response);
  };
  const handleUndo = (date, productKey, size) => {
    clearSourceResponse(date, productKey, size);
  };

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
      {/* TOP BAR */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 10px", position:"relative" }}>
        <div onClick={onExit} style={{ color:"#4A7FFF", fontSize:13, fontWeight:500, cursor:"pointer" }}>← Exit</div>
        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="1.6" strokeLinecap="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
          <div style={{ fontSize:13, fontWeight:600, color:"#fff" }}>SOURCE</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:5, background:"rgba(60,110,255,.08)", borderRadius:14, padding:"4px 8px" }}>
          <span style={{ fontSize:10, color:"rgba(255,255,255,.4)" }}>On Hold</span>
          <span style={{ background:"rgba(60,110,255,.15)", color:"#4A7FFF", fontSize:10, fontWeight:600, width:20, height:20, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 0 6px rgba(60,110,255,.25)" }}>{onHoldCount}</span>
        </div>
      </div>
      <div style={{ height:1, background:"linear-gradient(90deg,transparent,rgba(60,110,255,.25),transparent)", margin:"0 14px" }}/>
      {/* TOP TABS — Today / History / On Hold */}
      <div style={{ display:"flex", gap:0, padding:"0 13px 10px", borderBottom:"1px solid rgba(255,255,255,.05)", marginBottom:4, marginTop:8 }}>
        {[["today","Today's Request"],["history","History"],["onhold","On Hold"]].map(([key, label]) => (
          <div key={key} onClick={() => setTab(key)}
               style={{ flex:1, padding:"10px 6px", fontSize:12, fontWeight:600, textAlign:"center", cursor:"pointer", borderBottom:"2px solid " + (tab===key ? "#4A7FFF" : "transparent"), color: tab===key ? "#4A7FFF" : "rgba(255,255,255,.35)" }}>
            {label}{key === "onhold" && onHoldCount > 0 && ` ${onHoldCount}`}
          </div>
        ))}
      </div>
      {/* HUB SUB-TABS — segmented pill, shared across all three top tabs */}
      <div style={{ padding:"10px 13px 0", display:"flex", gap:8 }}>
        {[["hub1","Hub 1"],["hub2","Hub 2"]].map(([val, label]) => {
          const active = hub === val;
          const badge = hubBadges[val] || 0;
          return (
            <button key={val} onClick={() => setHub(val)}
                    style={{
                      flex:1,
                      padding:"10px 12px",
                      borderRadius:14,
                      border: active ? "1px solid rgba(60,110,255,.6)" : "1px solid rgba(255,255,255,.08)",
                      background: active ? "rgba(60,110,255,.14)" : "rgba(255,255,255,.02)",
                      color: active ? BLUE_L : "rgba(255,255,255,.55)",
                      fontWeight:700, fontSize:13, cursor:"pointer",
                      display:"flex", alignItems:"center", justifyContent:"center", gap:8,
                      boxShadow: active ? "0 0 12px rgba(60,110,255,.18)" : "none",
                      transition:"background 120ms ease, border-color 120ms ease",
                    }}>
              <span>{label}</span>
              <span style={{
                background: active ? "rgba(60,110,255,.25)" : "rgba(255,255,255,.06)",
                color: active ? "#fff" : "rgba(255,255,255,.5)",
                borderRadius:999,
                padding:"1px 8px",
                fontSize:11,
                fontWeight:700,
                minWidth:22,
                textAlign:"center",
              }}>{badge}</span>
            </button>
          );
        })}
      </div>
      <div style={{ padding:"1.5rem" }}>
        {tab==="today"   && <SourceTodayTab
                              rawCounts={rawCounts}
                              responses={allResponses[todayDate] || {}}
                              date={todayDate}
                              hub={hub}
                              onResponse={(key, size, resp) => handleResponse(todayDate, key, size, resp)}
                              onUndo={(key, size) => handleUndo(todayDate, key, size)} />}
        {tab==="history" && <SourceHistoryTab
                              orders={orders}
                              returnsLog={returnsLog}
                              allResponses={allResponses}
                              hub={hub}
                              onResponse={handleResponse} />}
        {tab==="onhold"  && <SourceOnHoldTab orders={orders} hub={hub} onHoldResponses={onHoldResponses} />}
      </div>
    </div>
  );
}

// ─── RETURNS VIEW ────────────────────────────────────────────────────────────
const RETURN_REASONS = ["Too Small", "Too Big", "Wrong Item", "Other"];

function ReturnsView({ orders, onExit }) {
  const [search,      setSearch]      = useState("");
  const [expandedId,  setExpandedId]  = useState(null);
  const returnsLog = useReturnsLog();
  const todayDate  = getSADateString();

  // Ready/Collected orders from the last 3 days (Phase 10). DayCollapsible
  // buckets these into Today / Yesterday / 2 days ago. SA-time slices match
  // the convention used elsewhere in the file (+2h shift before slicing).
  const last3DaysOrders = useMemo(() => {
    const allowed = new Set([todayDate, getSAPastDateString(1), getSAPastDateString(2)]);
    return orders
      .filter(o => {
        if (o.status !== STATUS.READY && o.status !== STATUS.COLLECTED) return false;
        const ts = o.readyAt || o.updatedAt;
        if (!ts) return false;
        const saDate = new Date(new Date(ts).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
        return allowed.has(saDate);
      })
      .sort((a, b) => (b.readyAt || b.updatedAt || "").localeCompare(a.readyAt || a.updatedAt || ""));
  }, [orders, todayDate]);

  // Composite `${SA-date}::${orderNumber}` set of already-returned orders. NOT a
  // bare orderNumber set: numbers reset daily, so a bare set flags every later
  // day's same-numbered SALE as "Returned" (the false-positive bug). Matched
  // per-order below via orderSaleDate(order).
  const returnedKeys = useMemo(() => returnedCompositeKeySet(returnsLog), [returnsLog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return last3DaysOrders;
    return last3DaysOrders.filter(o =>
      o.id.toLowerCase().includes(q) || (o.customerName || "").toLowerCase().includes(q)
    );
  }, [last3DaysOrders, search]);

  const submitReturn = (order) => {
    logReturn({
      timestamp:   new Date().toISOString(),
      date:        todayDate,
      orderNumber: order.id,
      productName: order.productName,
      size:        order.size,
      customerName:order.customerName,
      reason:      null,
      placedAtHub: order.placedAtHub || order.hub || "hub1",
    });
    setExpandedId(null);
  };

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
      {/* TOP BAR */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 10px" }}>
        <div onClick={onExit} style={{ color:"#4A7FFF", fontSize:13, fontWeight:500, cursor:"pointer" }}>← Exit</div>
        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
          <div style={{ fontSize:13, fontWeight:600, color:"#fff" }}>RETURNS</div>
        </div>
        <div style={{ fontSize:10, color:"rgba(255,255,255,.4)" }}>{last3DaysOrders.length} done</div>
      </div>

      <div style={{ padding:"1.5rem" }}>
        <input
          placeholder="Search by order number or customer name…"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, marginBottom:"1.25rem" }}
        />

        <DayCollapsible
          sectionKey="returns"
          items={filtered}
          dateOf={(o) => o.readyAt || o.updatedAt}
          emptyMessage={
            last3DaysOrders.length === 0
              ? "No orders marked Ready or Collected in the last 3 days."
              : "No orders match your search."
          }
          renderItem={(order) => {
            // Match by the order's OWN sale day + number, so a past day's return
            // of the same number can't mark today's sale as returned.
            const isReturned = returnedKeys.has(`${orderSaleDate(order)}::${order.id}`);
            const isExpanded = expandedId === order.id;
            return (
              <div style={{ background:CARD, border: isReturned ? "1px solid rgba(74,222,128,.25)" : isExpanded ? BORDER_BRIGHT : BORDER, borderRadius:RADIUS, padding:"1.25rem", transition:"border-color 0.2s", boxShadow: isExpanded ? "0 0 12px rgba(60,110,255,.12)" : "none" }}>
                <div style={{ display:"flex", alignItems:"center", gap:"1rem", flexWrap:"wrap" }}>
                  <div style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"1.9rem", color:BLUE_L, lineHeight:1, minWidth:"60px", letterSpacing:"0.05em" }}>#{order.id}</div>
                  <div style={{ flex:1, minWidth:"140px" }}>
                    <div style={{ fontWeight:"600", fontSize:"0.95rem" }}>{order.productName} · Size {order.size}</div>
                    <div style={{ color:"#666", fontSize:"0.82rem", marginTop:"2px" }}>{order.customerName}</div>
                  </div>
                  {isReturned ? (
                    <span style={{ color:"#4ADE80", fontSize:"0.82rem", fontWeight:"600", background:"rgba(74,222,128,.12)", border:"1px solid rgba(74,222,128,.3)", borderRadius:"999px", padding:"4px 14px" }}>
                      Returned
                    </span>
                  ) : (
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : order.id)}
                      style={ isExpanded ? { ...bGray, padding:"0.5rem 1.1rem" } : { ...bBlue, padding:"0.5rem 1.1rem" } }>
                      {isExpanded ? "Cancel" : "Log Return"}
                    </button>
                  )}
                </div>

                {isExpanded && !isReturned && (
                  <div style={{ marginTop:"1rem", paddingTop:"1rem", borderTop:"1px solid rgba(60,110,255,.08)" }}>
                    <div style={{ color:"rgba(255,255,255,.6)", fontSize:"0.82rem", marginBottom:"0.75rem" }}>Confirm this order is being returned:</div>
                    <div style={{ display:"flex", gap:"0.5rem", flexWrap:"wrap" }}>
                      <button onClick={() => submitReturn(order)}
                              style={{ ...bBlue, padding:"0.6rem 1.5rem", flex:1 }}>
                        Confirm Return
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}

// ─── INSIGHTS: HELPERS ───────────────────────────────────────────────────────
function periodStart(p) {
  const d = new Date();
  if (p === "today") { d.setHours(0,0,0,0); }
  if (p === "week")  { d.setDate(d.getDate() - ((d.getDay()+6)%7)); d.setHours(0,0,0,0); }
  if (p === "month") { d.setDate(1); d.setHours(0,0,0,0); }
  if (p === "year")  { d.setMonth(0,1); d.setHours(0,0,0,0); }
  return d.toISOString();
}

function groupCount(arr, keyFn) {
  const map = {};
  arr.forEach(item => { const k = keyFn(item); map[k] = (map[k]||0)+1; });
  return Object.entries(map).map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value);
}

const INSIGHT_ACTION = {
  placed:       { label:"Placed",       color:"#4ADE80", bg:"rgba(74,222,128,.15)" },
  ready:        { label:"Ready",        color:"#4A7FFF", bg:"rgba(60,110,255,.15)" },
  out_of_stock: { label:"Out of Stock", color:"#F87171", bg:"rgba(248,113,113,.15)" },
  tomorrow:     { label:"Tomorrow",     color:BLUE_L,   bg:"rgba(74,130,255,.15)" },
};

function InsightStatCard({ icon, label, value, color=BLUE, sub, photoEl }) {
  return (
    <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.25rem", boxShadow:GLOW }}>
      <div style={{ fontSize:"1.5rem", marginBottom:"0.25rem" }}>{photoEl || icon}</div>
      <div style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"2.2rem", color, lineHeight:1, letterSpacing:"0.02em" }}>{value}</div>
      {sub && <div style={{ color:"#888", fontSize:"0.75rem", marginTop:"0.2rem" }}>{sub}</div>}
      <div style={{ color:"#555", fontSize:"0.72rem", marginTop:"0.3rem", textTransform:"uppercase", letterSpacing:"0.05em" }}>{label}</div>
    </div>
  );
}

function InsightBarChart({ items, color=BLUE, emptyMsg="No data yet", photoMap }) {
  if (!items.length) return <div style={{ color:"#444", textAlign:"center", padding:"2rem", fontSize:"0.9rem" }}>{emptyMsg}</div>;
  const max = Math.max(...items.map(i=>i.value), 1);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"0.7rem" }}>
      {items.map(({ label, value }) => {
        // Support both exact product-name labels and "Product — Size X" labels
        const lookupName = label.includes(" — Size ") ? label.split(" — Size ")[0] : label;
        return (
          <div key={label}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.25rem", gap:"0.5rem" }}>
              <div style={{ display:"flex", alignItems:"center", gap:"0.45rem", flex:1, minWidth:0 }}>
                {photoMap && <ProductThumb name={lookupName} photoMap={photoMap} size={28} />}
                <span style={{ color:"#ccc", fontSize:"0.82rem", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{label}</span>
              </div>
              <span style={{ fontWeight:"700", color, fontSize:"0.82rem", flexShrink:0 }}>{value}</span>
            </div>
            <div style={{ background:"rgba(60,110,255,.08)", borderRadius:"4px", height:"9px" }}>
              <div style={{ background:color, borderRadius:"4px", height:"9px", width:`${Math.max(2,(value/max)*100)}%`, transition:"width 0.4s" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── GLOBAL INSIGHTS DATE PICKER ─────────────────────────────────────────────
// ─── INSIGHTS: GLOBAL DATE PICKER ────────────────────────────────────────────
// Three modes: Day (date input + arrows), Week (Mon–Sun + arrows), Month (+ arrows).
// Sits between the tab bar and tab content; state lives in InsightsView.
const _MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function InsightsDatePicker({ mode, setMode, dateStr, setDateStr }) {
  const navigate = (delta) => {
    const base = dateStrToLocal(dateStr);
    if (mode === "day")   base.setDate(base.getDate() + delta);
    if (mode === "week")  base.setDate(base.getDate() + delta * 7);
    if (mode === "month") base.setMonth(base.getMonth() + delta);
    if (mode === "year")  base.setFullYear(base.getFullYear() + delta);
    const y  = base.getFullYear();
    const mo = String(base.getMonth() + 1).padStart(2, "0");
    const d  = String(base.getDate()).padStart(2, "0");
    setDateStr(`${y}-${mo}-${d}`);
  };

  const base = dateStrToLocal(dateStr);
  let displayLabel = "";
  if (mode === "week") {
    const dow    = (base.getDay() + 6) % 7;
    const monday = new Date(base); monday.setDate(base.getDate() - dow);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const fmt    = (d) => `${d.getDate()} ${_MONTHS[d.getMonth()].slice(0,3)}`;
    displayLabel = `${fmt(monday)} – ${fmt(sunday)} ${sunday.getFullYear()}`;
  } else if (mode === "month") {
    displayLabel = `${_MONTHS[base.getMonth()]} ${base.getFullYear()}`;
  } else if (mode === "year") {
    displayLabel = `${base.getFullYear()}`;
  }

  const modeBtn = (key) => ({
    ...(mode===key ? tabOn : tabOff),
    padding:"0.45rem 1rem", minHeight:"44px",
  });
  const navBtn = {
    background:CARD, border:BORDER, borderRadius:"8px",
    color:"#888", cursor:"pointer", fontSize:"1rem",
    padding:"0.4rem 0.75rem", minHeight:"44px", minWidth:"44px",
    display:"flex", alignItems:"center", justifyContent:"center",
  };

  return (
    <div style={{ background:BG, borderBottom:"1px solid rgba(60,110,255,.08)", padding:"0.75rem 1.5rem" }}>
      {/* Mode toggle */}
      <div style={{ display:"flex", gap:"0.4rem", marginBottom:"0.65rem", flexWrap:"wrap" }}>
        {[["day","Day"],["week","Week"],["month","Month"],["year","Year"],["all","All Time"]].map(([k, label]) => (
          <button key={k} onClick={() => setMode(k)} style={modeBtn(k)}>
            {label}
          </button>
        ))}
      </div>
      {/* Navigator — hidden in All Time mode (no period to advance/anchor). */}
      {mode === "all" ? (
        <div style={{ textAlign:"center", color:"#fff", fontWeight:"600", fontSize:"0.95rem", padding:"0.5rem 0", letterSpacing:"0.04em" }}>
          All Time
        </div>
      ) : (
        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <button onClick={() => navigate(-1)} style={navBtn}>◀</button>
          {mode === "day" ? (
            <input
              type="date"
              value={dateStr}
              onChange={e => e.target.value && setDateStr(e.target.value)}
              style={{
                flex:1, background:"#1a1a1a", border:"1px solid #333", borderRadius:"8px",
                color:"#fff", fontSize:"0.95rem", padding:"0.5rem 0.75rem",
                minHeight:"44px", outline:"none", colorScheme:"dark",
              }}
            />
          ) : (
            <div style={{ flex:1, textAlign:"center", color:"#fff", fontWeight:"600", fontSize:"0.95rem", padding:"0.5rem 0" }}>
              {displayLabel}
            </div>
          )}
          <button onClick={() => navigate(1)} style={navBtn}>▶</button>
        </div>
      )}
    </div>
  );
}

// ─── INSIGHTS: OVERVIEW TAB ───────────────────────────────────────────────────
function InsightOverviewTab({ log, returnsLog, productPhotoMap, filterStart, filterEnd, filterLabel, orders, filterMode, filterDate, category = "both" }) {
  // Phase 12D: every reads-from-log path also filters by category. Live-order
  // paths (today's day-mode branch) filter by category at point-of-use below.
  const catMatch = (entry) => category === "both" || inferProductType(entry) === category;
  const periodLog = useMemo(
    () => log.filter(e => e.timestamp >= filterStart && e.timestamp < filterEnd && catMatch(e)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, filterStart, filterEnd, category]
  );
  const filteredReturns = useMemo(
    () => returnsLog.filter(r => (r.timestamp||"") >= filterStart && (r.timestamp||"") < filterEnd && catMatch(r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [returnsLog, filterStart, filterEnd, category]
  );
  const isToday = filterMode === "day" && filterDate === getSADateString();

  // Net Sales + OOS both read insights_log for EVERY period (incl. today) via the
  // shared helpers, so today reconciles with the historical days. The former
  // live-orders "today" paths drifted: OOS undercounted (auto-collect drained
  // status===OUT_OF_STOCK) and Net Sales OVER-counted (an auto-collected OOS
  // order flips to COLLECTED and was wrongly counted as a sale). "ready" /
  // "out_of_stock" log events are immutable and never cross over.
  const netSales = useMemo(
    () => readyEventsForPeriod({ log, returnsLog, filterStart, filterEnd, category }),
    [log, returnsLog, filterStart, filterEnd, category]
  );
  const oosLog = useMemo(
    () => oosEventsForPeriod({ log, returnsLog, filterStart, filterEnd, category }),
    [log, returnsLog, filterStart, filterEnd, category]
  );
  const topProd  = useMemo(() => groupCount(netSales, e => e.productName)[0], [netSales]);
  const hourData = useMemo(() => {
    const counts = {};
    netSales.forEach(e => { const h=new Date(e.timestamp).getHours(); counts[h]=(counts[h]||0)+1; });
    return Array.from({length:24},(_,h)=>({ label:`${h%12||12}${h<12?"am":"pm"}`, value:counts[h]||0 })).filter(c=>c.value>0);
  }, [netSales]);
  const topHour = hourData.reduce((b,c)=>c.value>(b?.value||0)?c:b, null);

  return (
    <div>
      {/* OVERVIEW LEGEND CARD with circuit decoration */}
      <div style={{ margin:"0 0 10px", background:"rgba(15,25,60,.6)", border:"1px solid rgba(60,110,255,.25)", borderRadius:14, padding:16, position:"relative", overflow:"hidden" }}>
        <svg style={{ position:"absolute", top:0, right:0, opacity:0.3 }} width="80" height="60" viewBox="0 0 80 60">
          <path d="M80,10 L60,10 L50,20 L40,20 L30,30" stroke="rgba(60,110,255,.8)" strokeWidth="1" fill="none"/>
          <circle cx="60" cy="10" r="2" fill="rgba(60,110,255,.8)"/>
          <circle cx="40" cy="20" r="2" fill="rgba(60,110,255,.8)"/>
          <path d="M80,35 L65,35 L55,25" stroke="rgba(60,110,255,.5)" strokeWidth="1" fill="none"/>
        </svg>
        <div style={{ fontSize:10, fontWeight:700, color:"rgba(255,255,255,.3)", textTransform:"uppercase", letterSpacing:"1.5px", textAlign:"center", marginBottom:14 }}>OVERVIEW LEGEND</div>
        <div style={{ display:"flex", gap:6 }}>
          <div style={{ flex:1, textAlign:"center" }}>
            <div style={{ marginBottom:8, display:"flex", justifyContent:"center" }}>
              <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#4ACA7A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 7px rgba(0,200,80,.6))" }}>
                <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/>
              </svg>
            </div>
            <div style={{ fontSize:12, fontWeight:600, color:"#fff", marginBottom:4 }}>Net Sales</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,.35)", lineHeight:1.4 }}>Orders marked <span style={{ color:"#4ACA7A", fontWeight:600 }}>Ready</span> minus returns</div>
          </div>
          <div style={{ flex:1, textAlign:"center" }}>
            <div style={{ marginBottom:8, display:"flex", justifyContent:"center" }}>
              <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#F87171" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 9px rgba(248,113,113,.5))" }}>
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
            </div>
            <div style={{ fontSize:12, fontWeight:600, color:"#fff", marginBottom:4 }}>Out of Stock</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,.35)", lineHeight:1.4 }}>Orders marked <span style={{ color:"#FF6B6B", fontWeight:600 }}>Out of Stock</span> by Floor</div>
          </div>
          <div style={{ flex:1, textAlign:"center" }}>
            <div style={{ marginBottom:8, display:"flex", justifyContent:"center" }}>
              <div style={{ width:40, height:40, background:"rgba(60,110,255,.15)", border:"1.5px solid rgba(60,110,255,.5)", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 0 12px rgba(60,110,255,.3)" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 5px rgba(60,110,255,.7))" }}>
                  <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
                </svg>
              </div>
            </div>
            <div style={{ fontSize:12, fontWeight:600, color:"#fff", marginBottom:4 }}>Returns</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,.35)", lineHeight:1.4 }}>Logged via <span style={{ color:"#4A7FFF", fontWeight:600 }}>Returns</span> view</div>
          </div>
        </div>
      </div>

      {/* STAT CARDS 2x2 — clean SVG icons, no emojis */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, marginBottom:10 }}>
        <div style={{ background:"rgba(10,20,50,.7)", border:"1px solid rgba(60,110,255,.15)", borderRadius:14, padding:"16px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
            <div style={{ width:44, height:44, background:"rgba(74,222,128,.15)", border:"1.5px solid rgba(74,222,128,.4)", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
            </div>
            <div style={{ fontSize:38, fontWeight:800, color:"#fff", letterSpacing:"-1.5px", lineHeight:1 }}>{netSales.length}</div>
          </div>
          <div style={{ fontSize:13, fontWeight:600, color:"#fff" }}>Net Sales</div>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.5)", marginTop:3, lineHeight:1.4 }}>Ready orders − Returns ({filterLabel}). Matches Sales Summary total.</div>
        </div>

        <div style={{ background:"rgba(10,20,50,.7)", border:"1px solid rgba(60,110,255,.15)", borderRadius:14, padding:"16px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
            <div style={{ width:44, height:44, background:"rgba(248,113,113,.15)", border:"1.5px solid rgba(248,113,113,.4)", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
            </div>
            <div style={{ fontSize:38, fontWeight:800, color:"#fff", letterSpacing:"-1.5px", lineHeight:1 }}>{oosLog.length}</div>
          </div>
          <div style={{ fontSize:13, fontWeight:600, color:"#fff" }}>Out of Stock</div>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.5)", marginTop:3, lineHeight:1.4 }}>Orders marked OOS by Warehouse ({filterLabel})</div>
        </div>

        <div style={{ background:"rgba(10,20,50,.7)", border:"1px solid rgba(60,110,255,.15)", borderRadius:14, padding:"16px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
            <div style={{ width:44, height:44, background:"rgba(60,110,255,.18)", border:"1.5px solid rgba(60,110,255,.5)", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
            </div>
            <div style={{ fontSize:38, fontWeight:800, color:"#fff", letterSpacing:"-1.5px", lineHeight:1 }}>{filteredReturns.length}</div>
          </div>
          <div style={{ fontSize:13, fontWeight:600, color:"#fff" }}>Returns</div>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.5)", marginTop:3, lineHeight:1.4 }}>Items logged in Returns view ({filterLabel})</div>
        </div>

        <div style={{ background:"rgba(10,20,50,.7)", border:"1px solid rgba(60,110,255,.15)", borderRadius:14, padding:"16px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
            <div style={{ width:44, height:44, borderRadius:10, background:"rgba(255,255,255,.08)", border:"1.5px solid rgba(60,110,255,.3)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, overflow:"hidden" }}>
              {topProd ? <ProductThumb name={topProd.label} photoMap={productPhotoMap} size={44}/> : <ProductIcon size={22}/>}
            </div>
            <div style={{ fontSize:38, fontWeight:800, color:"#fff", letterSpacing:"-1.5px", lineHeight:1 }}>{topProd?.value || "—"}</div>
          </div>
          <div style={{ fontSize:13, fontWeight:600, color:"#fff" }}>Top Product</div>
          <div style={{ fontSize:10, color:"rgba(255,255,255,.5)", marginTop:3, lineHeight:1.4, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{topProd?.label || "No orders yet"}</div>
        </div>
      </div>

      {/* BUSIEST HOUR CARD */}
      <div style={{ margin:"0 0 16px", background:"rgba(10,20,55,.7)", border:"1px solid rgba(60,110,255,.2)", borderRadius:14, padding:16, position:"relative", overflow:"hidden" }}>
        <svg style={{ position:"absolute", bottom:0, right:0, opacity:0.2 }} width="100" height="60" viewBox="0 0 100 60">
          <path d="M100,20 L80,20 L70,30 L50,30 L40,40 L20,40" stroke="rgba(60,110,255,1)" strokeWidth="1" fill="none"/>
          <circle cx="80" cy="20" r="2" fill="rgba(60,110,255,1)"/>
          <circle cx="50" cy="30" r="2" fill="rgba(60,110,255,1)"/>
          <circle cx="20" cy="40" r="2" fill="rgba(60,110,255,1)"/>
        </svg>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 4px rgba(60,110,255,.5))" }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span style={{ fontSize:14, fontWeight:700, color:"#fff" }}>Busiest Hour</span>
        </div>
        <div style={{ fontSize:48, fontWeight:800, color:"#4A7FFF", letterSpacing:"-2px", lineHeight:1 }}>{topHour?.label?.toUpperCase() || "—"}</div>
        <div style={{ fontSize:12, color:"rgba(255,255,255,.4)", marginTop:4, marginBottom:12 }}>{topHour ? `${topHour.value} orders` : ""}</div>
        <svg width="100%" height="70" viewBox="0 0 300 70" preserveAspectRatio="none">
          <defs>
            <linearGradient id="wg2" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(60,110,255,.3)"/>
              <stop offset="100%" stopColor="rgba(60,110,255,0)"/>
            </linearGradient>
          </defs>
          <path d="M0,65 L20,62 L40,55 L60,45 L80,30 L100,18 L120,10 L140,15 L160,28 L180,42 L200,52 L220,48 L240,55 L260,60 L280,63 L300,65 L300,70 L0,70 Z" fill="url(#wg2)"/>
          <path d="M0,65 L20,62 L40,55 L60,45 L80,30 L100,18 L120,10 L140,15 L160,28 L180,42 L200,52 L220,48 L240,55 L260,60 L280,63 L300,65" fill="none" stroke="rgba(74,127,255,.7)" strokeWidth="1.5"/>
          <circle cx="120" cy="10" r="5" fill="#4A7FFF"/>
          <circle cx="120" cy="10" r="9" fill="rgba(60,110,255,.25)"/>
        </svg>
      </div>
      <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.5rem" }}>
        <div style={{ fontWeight:"700", marginBottom:"1rem", color:"#fff" }}>Recent Activity · {filterLabel}</div>
        {periodLog.length === 0
          ? <div style={{ color:"#444", textAlign:"center", padding:"1.5rem", fontSize:"0.9rem" }}>No activity in this period</div>
          : periodLog.slice(0,30).map((e,i) => {
              const ac = INSIGHT_ACTION[e.action]||{color:"#666",bg:"#333",label:e.action};
              return (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.5rem 0", borderBottom:"1px solid rgba(60,110,255,.08)" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
                    <ProductThumb name={e.productName} photoMap={productPhotoMap} size={36} />
                    <div>
                      <span style={{ fontWeight:"600", color:"#fff", fontSize:"0.88rem" }}>{e.productName}</span>
                      <span style={{ color:"#555", marginLeft:"0.4rem", fontSize:"0.78rem" }}>Sz {e.size}</span>
                      <span style={{ marginLeft:"0.4rem", background:ac.bg, color:ac.color, borderRadius:"999px", padding:"1px 8px", fontSize:"0.7rem", fontWeight:"600" }}>{ac.label}</span>
                    </div>
                  </div>
                  <div style={{ color:"#555", fontSize:"0.72rem", whiteSpace:"nowrap" }}>
                    #{e.orderNumber} · {new Date(e.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
                  </div>
                </div>
              );
            })}
      </div>
    </div>
  );
}

// ─── INSIGHTS: PRODUCT SEARCH TAB ────────────────────────────────────────────
function InsightProductSearchTab({ log, productPhotoMap, filterStart, filterEnd, category = "both" }) {
  const [query,  setQuery]  = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const catMatch = (e) => category === "both" || inferProductType(e) === category;
    return log.filter(e =>
      e.timestamp >= filterStart && e.timestamp < filterEnd &&
      catMatch(e) &&
      (q==="" || (e.productName||"").toLowerCase().includes(q))
    );
  }, [log, query, filterStart, filterEnd, category]);

  const placedFiltered  = useMemo(() => filtered.filter(e=>e.action==="placed"), [filtered]);
  const productCounts   = useMemo(() => groupCount(placedFiltered, e=>e.productName), [placedFiltered]);
  const sizeCounts      = useMemo(() => groupCount(placedFiltered, e=>`Size ${e.size}`), [placedFiltered]);

  return (
    <div>
      <div style={{ display:"flex", gap:"0.75rem", marginBottom:"1rem", flexWrap:"wrap" }}>
        <input placeholder="Search product name…" value={query} onChange={e=>setQuery(e.target.value)}
          style={{ ...inputStyle, flex:1, minWidth:"180px" }} />
      </div>
      {query.trim() && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"1rem", marginBottom:"1rem" }}>
          <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.25rem" }}>
            <div style={{ fontWeight:"700", marginBottom:"0.75rem", color:"#fff", fontSize:"0.9rem" }}>Orders by Product</div>
            <InsightBarChart items={productCounts} color={BLUE} emptyMsg="No orders found" photoMap={productPhotoMap} />
          </div>
          <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.25rem" }}>
            <div style={{ fontWeight:"700", marginBottom:"0.75rem", color:"#fff", fontSize:"0.9rem" }}>Size Breakdown</div>
            <InsightBarChart items={sizeCounts} color="#4A7FFF" emptyMsg="No orders found" />
          </div>
        </div>
      )}
      <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.25rem" }}>
        <div style={{ fontWeight:"700", marginBottom:"0.75rem", color:"#fff", fontSize:"0.9rem" }}>
          Order History {query?`· "${query}"`:""}
          <span style={{ color:"#555", marginLeft:"0.5rem", fontWeight:"400", fontSize:"0.8rem" }}>{filtered.length} entries</span>
        </div>
        {filtered.length===0
          ? <div style={{ color:"#444", textAlign:"center", padding:"2rem", fontSize:"0.9rem" }}>No orders found</div>
          : <div style={{ maxHeight:"420px", overflowY:"auto" }}>
              {filtered.map((e,i)=>{
                const ac=INSIGHT_ACTION[e.action]||{color:"#666",bg:"#333",label:e.action};
                return (
                  <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.5rem 0", borderBottom:"1px solid rgba(60,110,255,.08)" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:"0.45rem" }}>
                      <ProductThumb name={e.productName} photoMap={productPhotoMap} size={32} />
                      <div>
                        <span style={{ fontWeight:"600", color:"#fff", fontSize:"0.85rem" }}>{e.productName}</span>
                        <span style={{ color:"#555", fontSize:"0.78rem", marginLeft:"0.4rem" }}>Sz {e.size}</span>
                        <span style={{ marginLeft:"0.4rem", background:ac.bg, color:ac.color, borderRadius:"999px", padding:"1px 7px", fontSize:"0.7rem", fontWeight:"600" }}>{ac.label}</span>
                      </div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ color:"#888", fontSize:"0.75rem" }}>{e.customerName}</div>
                      <div style={{ color:"#555", fontSize:"0.7rem" }}>{new Date(e.timestamp).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div>
                    </div>
                  </div>
                );
              })}
            </div>
        }
      </div>
    </div>
  );
}

// ─── INSIGHTS: OOS TRACKER TAB ────────────────────────────────────────────────
function InsightOOSTrackerTab({ log, returnsLog, productPhotoMap, filterStart, filterEnd, filterLabel, category = "both" }) {
  // OOS count for EVERY period (incl. today) reads the immutable insights_log
  // (action==="out_of_stock") within [filterStart, filterEnd).
  //
  // This replaces a former today-only branch that derived from LIVE orders
  // filtered by *current* status===OUT_OF_STOCK. That undercounted today: the
  // 8-min TV auto-collect sweep flips OOS→collected, so most of the day's OOS
  // orders had already left OUT_OF_STOCK and dropped out of the count (e.g. 60
  // events → 1 shown). insights_log records every OOS transition (sneaker AND
  // clothing — clothing OOS is logged with action "out_of_stock" by
  // setClothingRefillStatus), so today now matches the historical days exactly.
  // dedupe-by-orderNumber (a flapped order counts once) + exclude returned
  // orderNumbers (if ultimately returned, its OOS transitions don't count —
  // same rule as Net Sales).
  const oosLog = useMemo(
    () => oosEventsForPeriod({ log, returnsLog, filterStart, filterEnd, category }),
    [log, returnsLog, filterStart, filterEnd, category]
  );
  const [openProduct, setOpenProduct] = useState(null);

  // Group OOS events by product, then by size
  const byProductData = useMemo(() => {
    const map = {};
    oosLog.forEach(e => {
      const name = e.productName || "Unknown";
      if (!map[name]) map[name] = { name, total: 0, sizes: {} };
      map[name].total += 1;
      const sz = e.size || "—";
      map[name].sizes[sz] = (map[name].sizes[sz] || 0) + 1;
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [oosLog]);

  const totalOOS = oosLog.length;

  if (oosLog.length === 0) {
    return (
      <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:"3rem", textAlign:"center", color:"rgba(255,255,255,.4)", fontSize:14 }}>
        <ProductIcon size={32} opacity={0.4}/>
        <div style={{ marginTop:12 }}>No out-of-stock events in this period</div>
      </div>
    );
  }

  return (
    <div>
      {/* SUMMARY BOX */}
      <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.6)", borderRadius:14, padding:"16px 18px", marginBottom:12, display:"flex", alignItems:"center", gap:14, boxShadow:"0 0 16px rgba(60,110,255,.18)" }}>
        <div style={{ fontWeight:800, fontSize:42, color:"#4A7FFF", lineHeight:1, letterSpacing:"-1.5px" }}>{totalOOS}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>Total Out of Stock</div>
          <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>{byProductData.length} product{byProductData.length !== 1 ? "s" : ""} affected · {filterLabel}</div>
        </div>
      </div>

      {/* PRODUCT LIST — collapsible rows */}
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {byProductData.map(p => {
          const isOpen = openProduct === p.name;
          const sizes = Object.entries(p.sizes).sort((a, b) => b[1] - a[1]);
          return (
            <div key={p.name} style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.25)", borderRadius:12, overflow:"hidden", transition:"all 0.2s" }}>
              <div onClick={() => setOpenProduct(isOpen ? null : p.name)}
                   style={{ display:"flex", alignItems:"center", padding:"12px 14px", cursor:"pointer", gap:12 }}>
                <ProductThumb name={p.name} photoMap={productPhotoMap} size={36}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:700, fontSize:14, color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</div>
                  <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>{Object.keys(p.sizes).length} size{Object.keys(p.sizes).length !== 1 ? "s" : ""} affected</div>
                </div>
                <div style={{ background:"rgba(60,110,255,.15)", color:"#4A7FFF", border:"1px solid rgba(60,110,255,.3)", borderRadius:999, padding:"4px 12px", fontSize:13, fontWeight:700 }}>{p.total}</div>
                <span style={{ color:"#4A7FFF", fontSize:14, transition:"transform 0.2s", display:"inline-block", transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}>›</span>
              </div>
              {isOpen && (
                <div style={{ borderTop:"1px solid rgba(60,110,255,.1)", padding:"10px 14px 14px", display:"flex", flexWrap:"wrap", gap:6 }}>
                  {sizes.map(([size, count]) => (
                    <div key={size} style={{ background:"rgba(60,110,255,.08)", border:"1px solid rgba(60,110,255,.25)", borderRadius:8, padding:"6px 10px", display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:12, fontWeight:700, color:"#fff" }}>Size {size}</span>
                      <span style={{ background:"rgba(60,110,255,.2)", color:"#4A7FFF", borderRadius:999, padding:"2px 7px", fontSize:10, fontWeight:700 }}>×{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── INSIGHTS: SIZE POPULARITY TAB ───────────────────────────────────────────
// Phase 12D correction: respects the global Sneaker/Clothing/Both toggle and
// drops entries with no size (Display / Display Partner orders are
// legitimately size-less but used to show up as a "Size undefined" bucket).
// In "Both" mode, sneaker and clothing sizes render as two separate charts
// with their own normalization — the two size systems (numeric 3..11 and
// letters S..XXXL) don't share a meaningful axis.
function InsightSizePopularityTab({ log, filterStart, filterEnd, filterLabel, category = "both" }) {
  const [catFilter, setCat] = useState("all");
  const catMatch = (e) => category === "both" || inferProductType(e) === category;

  // Demand histogram, NOT fulfilment. Counts `action === "placed"` events
  // (one per cart line at checkout). A subsequent return doesn't erase the
  // customer's expressed intent, so we deliberately do not exclude returned
  // orderNumbers here — but we DO dedupe by orderNumber so a duplicate
  // `placed` write (rare but possible) doesn't inflate the histogram.
  const placed = useMemo(
    () => {
      const raw = log.filter(e => e.action === "placed" && e.timestamp >= filterStart && e.timestamp < filterEnd && e.size && catMatch(e));
      return dedupeByOrderNumber(raw);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, filterStart, filterEnd, category]
  );
  const cats   = useMemo(() => ["all", ...new Set(placed.map(e => e.productCategory).filter(Boolean))], [placed]);
  const subset = useMemo(() => catFilter === "all" ? placed : placed.filter(e => e.productCategory === catFilter), [placed, catFilter]);

  // Split by productType so each chart bucketizes only its own size system.
  const sneakerSizes = useMemo(() => {
    const grouped = groupCount(subset.filter(e => inferProductType(e) === "sneaker"), e => e.size);
    return grouped.sort((a, b) => parseFloat(a.label) - parseFloat(b.label));
  }, [subset]);
  const clothingSizes = useMemo(() => {
    const grouped = groupCount(subset.filter(e => inferProductType(e) === "clothing"), e => e.size);
    return grouped.sort((a, b) => CLOTHING_SIZES.indexOf(a.label) - CLOTHING_SIZES.indexOf(b.label));
  }, [subset]);

  const showSneaker  = (category === "sneaker"  || category === "both") && sneakerSizes.length > 0;
  const showClothing = (category === "clothing" || category === "both") && clothingSizes.length > 0;

  // One bar chart panel — shared by both sneaker and clothing renders. Each
  // panel normalizes to its own max so a small clothing group doesn't appear
  // dwarfed by a busy sneaker group when both are shown side-by-side.
  const Panel = ({ heading, sizes }) => {
    const max = sizes.length ? Math.max(...sizes.map(s => s.value)) : 1;
    return (
      <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:18 }}>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>{heading}</div>
          <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>{catFilter === "all" ? "All categories" : catFilter} · {sizes.reduce((n, s) => n + s.value, 0)} order{sizes.reduce((n, s) => n + s.value, 0) !== 1 ? "s" : ""} placed</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {sizes.map(({ label, value }) => {
            const isPeak = value === max;
            const pct = (value / max) * 100;
            return (
              <div key={label} style={{ display:"flex", alignItems:"center", gap:12 }}>
                <div style={{ width:64, color: isPeak ? "#fff" : "rgba(255,255,255,.7)", fontSize:13, fontWeight: isPeak ? 700 : 500 }}>
                  Size {label}
                </div>
                <div style={{ flex:1, position:"relative", height:24, background:"rgba(60,110,255,.05)", borderRadius:6, overflow:"hidden" }}>
                  <div style={{
                    width:`${Math.max(2, pct)}%`,
                    height:"100%",
                    background: isPeak
                      ? "linear-gradient(90deg, rgba(60,110,255,.85), rgba(60,110,255,.3))"
                      : "linear-gradient(90deg, rgba(60,110,255,.6), rgba(60,110,255,.2))",
                    boxShadow: isPeak ? "0 0 10px rgba(60,110,255,.5)" : "none",
                    borderRadius:6,
                    transition:"width 0.4s",
                  }}/>
                </div>
                <div style={{ width:36, textAlign:"right", color: isPeak ? "#4A7FFF" : "rgba(255,255,255,.7)", fontSize:14, fontWeight: isPeak ? 800 : 600 }}>{value}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* productCategory free-text pills (existing) — orthogonal to the
          global productType toggle and cascade after it. */}
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>
        {cats.map(cat => {
          const on = catFilter === cat;
          return (
            <button key={cat} onClick={() => setCat(cat)}
                    style={{ padding:"6px 14px", borderRadius:999, border: on ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)", background: on ? "rgba(60,110,255,.15)" : "rgba(255,255,255,.04)", color: on ? "#4A7FFF" : "rgba(255,255,255,.5)", cursor:"pointer", fontWeight:600, fontSize:12, textTransform:"capitalize" }}>
              {cat}
            </button>
          );
        })}
      </div>

      {/* No data in either group → single empty state. */}
      {!showSneaker && !showClothing && (
        <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:"3rem", textAlign:"center", color:"rgba(255,255,255,.4)", fontSize:14 }}>
          No orders in this period
        </div>
      )}

      {/* Demand-vs-fulfilment clarification — this tab counts cart checkouts
          (action === "placed"), NOT ready / collected sales. The label makes
          the distinction explicit so the totals here aren't mis-read against
          the Sales Summary / Overview · Net Sales totals. */}
      <div style={{ background:"rgba(60,110,255,.05)", border:"1px solid rgba(60,110,255,.18)", borderRadius:10, padding:"8px 12px", marginBottom:12, color:"rgba(255,255,255,.55)", fontSize:11, lineHeight:1.45 }}>
        Counts orders <strong style={{ color:"#fff" }}>placed at checkout</strong> (demand) — not ready / collected sales. A return doesn't erase the original demand, so totals here will differ from Net Sales.
      </div>

      {/* Two panels in Both mode; one panel in single-category mode. Heading
          carries the "(by demand)" suffix so the metric is unambiguous even
          when the user lands on this tab without reading the intro card. */}
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {showSneaker && (
          <Panel heading={category === "both" ? "Sneaker Sizes (by demand)" : "Size Popularity (by demand)"} sizes={sneakerSizes} />
        )}
        {showClothing && (
          <Panel heading={category === "both" ? "Clothing Sizes (by demand)" : "Size Popularity (by demand)"} sizes={clothingSizes} />
        )}
      </div>
    </div>
  );
}

// ─── INSIGHTS: BUSIEST TIMES TAB ─────────────────────────────────────────────
function InsightBusiestTimesTab({ log, filterStart, filterEnd, filterLabel, category = "both" }) {
  // Same dedupe rule as Size Popularity — one placed event per orderNumber,
  // so a double-fire checkout doesn't bias the hour/day histograms.
  const placed = useMemo(() => {
    const catMatch = (e) => category === "both" || inferProductType(e) === category;
    const raw = log.filter(e => e.action === "placed" && e.timestamp >= filterStart && e.timestamp < filterEnd && catMatch(e));
    return dedupeByOrderNumber(raw);
  }, [log, filterStart, filterEnd, category]);

  // Build all 24 hours (8am-8pm shown), use full hour granularity
  const hourData = useMemo(() => {
    const counts = {};
    placed.forEach(e => { const h=new Date(e.timestamp).getHours(); counts[h]=(counts[h]||0)+1; });
    return Array.from({length:24},(_,h)=>({
      hour: h,
      label: `${h%12||12}${h<12?"a":"p"}`,
      value: counts[h] || 0,
    }));
  }, [placed]);
  const hourMax = Math.max(...hourData.map(d => d.value), 1);
  const peakHour = hourData.reduce((b, c) => c.value > (b?.value || 0) ? c : b, null);

  const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dayData = useMemo(() =>
    DAYS.map((label,d)=>({ label, value:placed.filter(e=>new Date(e.timestamp).getDay()===d).length })),
  [placed]);
  const dayMax = Math.max(...dayData.map(d => d.value), 1);
  const peakDay = dayData.reduce((b, c) => c.value > (b?.value || 0) ? c : b, null);

  return (
    <div>
      {/* BUSIEST HOURS — vertical bar chart */}
      <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:18, marginBottom:12 }}>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>Busiest Hours</div>
          <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>
            {placed.length === 0
              ? "No orders in this period"
              : <>Peak hour: <span style={{ color:"#4A7FFF", fontWeight:700 }}>{peakHour ? `${peakHour.hour % 12 || 12}${peakHour.hour < 12 ? "AM" : "PM"}` : "—"}</span> · {placed.length} order{placed.length !== 1 ? "s" : ""} total</>}
          </div>
        </div>
        {placed.length > 0 && (
          <div>
            <div style={{ display:"flex", alignItems:"flex-end", gap:3, height:140, padding:"0 4px" }}>
              {hourData.map(d => {
                const isPeak = d.value === hourMax && d.value > 0;
                const pct = d.value === 0 ? 0 : Math.max(6, (d.value / hourMax) * 100);
                return (
                  <div key={d.hour} title={`${d.label} — ${d.value} order${d.value !== 1 ? "s" : ""}`}
                       style={{ flex:1, height:"100%", display:"flex", flexDirection:"column", justifyContent:"flex-end", alignItems:"center" }}>
                    <div style={{
                      width:"100%",
                      height:`${pct}%`,
                      background: d.value === 0 ? "rgba(60,110,255,.04)" : isPeak ? "linear-gradient(180deg, rgba(60,110,255,1), rgba(60,110,255,.4))" : "linear-gradient(180deg, rgba(60,110,255,.55), rgba(60,110,255,.15))",
                      borderRadius:"4px 4px 0 0",
                      boxShadow: isPeak ? "0 0 12px rgba(60,110,255,.6)" : "none",
                      transition:"height 0.4s",
                    }}/>
                  </div>
                );
              })}
            </div>
            <div style={{ display:"flex", gap:3, marginTop:6, padding:"0 4px" }}>
              {hourData.map(d => (
                <div key={d.hour} style={{ flex:1, textAlign:"center", color: d.value === hourMax && d.value > 0 ? "#4A7FFF" : "rgba(255,255,255,.3)", fontSize:9, fontWeight: d.value === hourMax && d.value > 0 ? 700 : 500 }}>
                  {d.hour % 3 === 0 ? d.label : ""}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* BUSIEST DAYS */}
      <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:18 }}>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>Busiest Days</div>
          <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>
            {placed.length === 0
              ? "No orders in this period"
              : <>Peak day: <span style={{ color:"#4A7FFF", fontWeight:700 }}>{peakDay?.value > 0 ? peakDay.label : "—"}</span></>}
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:8, height:120 }}>
          {dayData.map(d => {
            const isPeak = d.value === dayMax && d.value > 0;
            const pct = d.value === 0 ? 0 : Math.max(8, (d.value / dayMax) * 100);
            return (
              <div key={d.label} style={{ flex:1, height:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-end" }}>
                <div style={{ color: isPeak ? "#4A7FFF" : "rgba(255,255,255,.5)", fontSize:11, fontWeight: isPeak ? 700 : 500, marginBottom:4 }}>{d.value}</div>
                <div style={{
                  width:"100%",
                  height:`${pct}%`,
                  background: d.value === 0 ? "rgba(60,110,255,.04)" : isPeak ? "linear-gradient(180deg, rgba(60,110,255,1), rgba(60,110,255,.4))" : "linear-gradient(180deg, rgba(60,110,255,.55), rgba(60,110,255,.15))",
                  borderRadius:"6px 6px 0 0",
                  boxShadow: isPeak ? "0 0 12px rgba(60,110,255,.6)" : "none",
                  transition:"height 0.4s",
                }}/>
                <div style={{ color: isPeak ? "#4A7FFF" : "rgba(255,255,255,.4)", fontSize:11, fontWeight: isPeak ? 700 : 500, marginTop:6 }}>{d.label}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── INSIGHTS: RETURNS TAB ───────────────────────────────────────────────────
function InsightReturnsTab({ returnsLog, productPhotoMap, filterStart, filterEnd, filterLabel, category = "both" }) {
  const filtered = useMemo(() => {
    const catMatch = (r) => category === "both" || inferProductType(r) === category;
    return returnsLog.filter(r => (r.timestamp||"") >= filterStart && (r.timestamp||"") < filterEnd && catMatch(r));
  }, [returnsLog, filterStart, filterEnd, category]);
  const byProduct = useMemo(() => groupCount(filtered, r => r.productName || "Unknown"),  [filtered]);

  return (
    <div>
      {filtered.length === 0 ? (
        <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:"3rem", textAlign:"center", color:"rgba(255,255,255,.4)", fontSize:14 }}>
          <ProductIcon size={32} opacity={0.4}/>
          <div style={{ marginTop:12 }}>No returns in this period</div>
        </div>
      ) : (
        <>
          {/* Summary card */}
          <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.6)", borderRadius:14, padding:"16px 18px", marginBottom:12, display:"flex", alignItems:"center", gap:14, boxShadow:"0 0 16px rgba(60,110,255,.18)" }}>
            <div style={{ fontWeight:800, fontSize:42, color:"#4A7FFF", lineHeight:1, letterSpacing:"-1.5px" }}>{filtered.length}</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>Total Returns</div>
              <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>Items logged via Returns view · {filterLabel}</div>
            </div>
          </div>

          {/* Most returned products bar chart */}
          <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:16, marginBottom:12 }}>
            <div style={{ fontWeight:700, marginBottom:12, color:"#fff", fontSize:13 }}>Most Returned Products</div>
            <InsightBarChart items={byProduct} color={BLUE} photoMap={productPhotoMap} />
          </div>

          {/* Return Log */}
          <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.2)", borderRadius:14, padding:16 }}>
            <div style={{ fontWeight:700, marginBottom:10, color:"#fff", fontSize:13 }}>Return Log <span style={{ color:"rgba(255,255,255,.4)", fontWeight:400, fontSize:11 }}>· {filtered.length} entries</span></div>
            <div style={{ maxHeight:"380px", overflowY:"auto" }}>
              {filtered.slice(0, 50).map((r, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid rgba(60,110,255,.08)" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <ProductThumb name={r.productName} photoMap={productPhotoMap} size={32} />
                    <div>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <span style={{ fontWeight:800, fontSize:14, color:"#6A9FFF", letterSpacing:"0.5px" }}>#{r.orderNumber}</span>
                        <span style={{ color:"#ccc", fontWeight:600, fontSize:13 }}>{r.productName}</span>
                      </div>
                      <span style={{ color:"rgba(255,255,255,.4)", fontSize:11 }}>Size {r.size}</span>
                    </div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <div style={{ color:"rgba(255,255,255,.5)", fontSize:11 }}>{r.customerName}</div>
                    <div style={{ color:"rgba(255,255,255,.3)", fontSize:10 }}>{new Date(r.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── INSIGHTS: CLOTHING REFILLS TAB (Phase 12D) ───────────────────────────────
// Demand-signal view of every clothing refill request placed in the active
// date window. Filters orders by productType==="clothing" and createdAt
// inside [filterStart, filterEnd). Read-only. Filters by createdAt only —
// immutable — so historical periods aren't affected by later resolutions or
// undos. Aggregates by (productId, productName); each row shows total units
// requested, per-size breakdown, and last-requested timestamp.
function InsightClothingRefillsTab({ orders, log, productPhotoMap, filterStart, filterEnd, filterLabel, filterMode, filterDate }) {
  // TODAY reads live /orders (real-time, qty present); past windows read
  // insights_log "placed" clothing events — /orders rolls over daily, so the old
  // all-live-orders path undercounted closed windows. Both branches normalise to
  // { productName, size, qty, timestamp } via the shared helper.
  const isToday = filterMode === "day" && filterDate === getSADateString();
  const refillEvents = useMemo(
    () => clothingRefillEventsForPeriod({ isToday, orders, log, filterStart, filterEnd }),
    [isToday, orders, log, filterStart, filterEnd]
  );

  const rows = useMemo(() => {
    const map = {};
    refillEvents.forEach(e => {
      const key = e.productName || "Unknown";
      if (!map[key]) map[key] = { productName: key, total: 0, sizes: {}, lastAt: "" };
      map[key].total += e.qty;
      const sz = e.size || "—";
      map[key].sizes[sz] = (map[key].sizes[sz] || 0) + e.qty;
      if ((e.timestamp || "") > map[key].lastAt) map[key].lastAt = e.timestamp || "";
    });
    return Object.values(map).sort((a, b) => b.total - a.total || b.lastAt.localeCompare(a.lastAt));
  }, [refillEvents]);

  const totalUnits     = rows.reduce((n, r) => n + r.total, 0);
  const totalRequests  = refillEvents.length;
  const distinctProducts = rows.length;

  const fmtAgo = (iso) => {
    if (!iso) return "—";
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1)    return "just now";
    if (mins < 60)   return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)    return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30)   return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  };

  return (
    <div>
      {/* SUMMARY CARD — mirrors OOS Tracker visual */}
      <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.6)", borderRadius:14, padding:"16px 18px", marginBottom:12, display:"flex", alignItems:"center", gap:14, boxShadow:"0 0 16px rgba(60,110,255,.18)" }}>
        <div style={{ fontWeight:800, fontSize:42, color:"#4A7FFF", lineHeight:1, letterSpacing:"-1.5px" }}>{totalUnits}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>Clothing Units Requested</div>
          <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>{totalRequests} request{totalRequests !== 1 ? "s" : ""} · {distinctProducts} product{distinctProducts !== 1 ? "s" : ""} · {filterLabel}</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:"3rem", textAlign:"center", color:"rgba(255,255,255,.4)", fontSize:14 }}>
          <ProductIcon size={32} opacity={0.4}/>
          <div style={{ marginTop:12 }}>No clothing refill requests in this period</div>
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {rows.map(r => {
            const sizeEntries = Object.entries(r.sizes).sort((a, b) => b[1] - a[1]);
            return (
              <div key={r.productName} style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.25)", borderLeft:"3px solid rgba(60,110,255,.55)", borderRadius:12, padding:"12px 14px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <ProductThumb name={r.productName} photoMap={productPhotoMap} size={40}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:700, fontSize:13, color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.productName}</div>
                    <div style={{ color:"rgba(255,255,255,.4)", fontSize:10, marginTop:2 }}>last {fmtAgo(r.lastAt)}</div>
                  </div>
                  <div style={{ background:"rgba(60,110,255,.15)", color:"#4A7FFF", border:"1px solid rgba(60,110,255,.35)", borderRadius:999, padding:"4px 12px", fontSize:13, fontWeight:700 }}>×{r.total}</div>
                </div>
                {sizeEntries.length > 0 && (
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:10 }}>
                    {sizeEntries.map(([sz, count]) => (
                      <span key={sz} style={{ display:"inline-flex", alignItems:"center", gap:5, background:"rgba(60,110,255,.08)", border:"1px solid rgba(60,110,255,.22)", borderRadius:7, padding:"3px 9px", fontSize:11, fontWeight:600, color:"#fff" }}>
                        <span>{sz}</span>
                        <span style={{ background:"rgba(60,110,255,.2)", color:BLUE_L, borderRadius:999, padding:"0 6px", fontSize:10, fontWeight:700 }}>{count}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── INSIGHTS: STOCK DEPLETED TAB (Phase 11) ──────────────────────────────────
// Reads partner-order refill tasks resolved as 'stockDepleted' from live orders
// (no separate Firebase log — Phase 9.5 wrote the depletion event onto the
// order itself, so Undo is a single field clear and there's nothing to keep in
// sync). Aggregates by (productName, size) so restock planning sees the most
// frequently depleted SKUs at the top. Sort: count desc, tiebreak by most
// recent depletion desc. Local filters: hub pills + product-name search.
function InsightStockDepletedTab({ orders, log, productPhotoMap, filterStart, filterEnd, filterLabel, filterMode, filterDate }) {
  const [hubFilter, setHubFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  // Day-mode + today uses live orders (no log lag); every other window pulls
  // from insights_log filtered to action="stock_depleted" so past days survive
  // the daily orderNumber reset that overwrites /orders/{id}. Same pattern as
  // InsightOOSTrackerTab. dedupeByOrderNumber handles re-fires from undo-redo.
  const events = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    let raw;
    if (filterMode === "day" && filterDate === getSADateString()) {
      raw = (orders || [])
        .filter(o => o.displayRefillStatus === "stockDepleted")
        .filter(o => {
          const ts = o.displayRefillStockDepletedAt;
          return ts && ts >= filterStart && ts < filterEnd;
        })
        .map(o => ({
          orderNumber:  o.id,
          productName:  o.productName || "Unknown",
          size:         sourceDisplaySize(o) || "—",
          hub:          o.displayRefilledBy || o.displayRefillHub || "—",
          timestamp:    o.displayRefillStockDepletedAt,
        }));
    } else {
      raw = (log || [])
        .filter(e => e.action === "stock_depleted" && e.timestamp >= filterStart && e.timestamp < filterEnd)
        .map(e => ({
          orderNumber:  e.orderNumber,
          productName:  e.productName || "Unknown",
          size:         e.size || "—",
          hub:          e.displayRefilledBy || e.placedAtHub || "—",
          timestamp:    e.timestamp,
        }));
    }
    return dedupeByOrderNumber(raw)
      .filter(e => hubFilter === "all" || e.hub === hubFilter)
      .filter(e => !q || (e.productName || "").toLowerCase().includes(q));
  }, [orders, log, filterStart, filterEnd, filterMode, filterDate, hubFilter, searchTerm]);

  // Group by (product, size), keep total + lastTimestamp + hub set.
  const rows = useMemo(() => {
    const map = {};
    events.forEach(e => {
      const k = `${e.productName}__${e.size}`;
      if (!map[k]) map[k] = { productName: e.productName, size: e.size, count: 0, lastAt: "", hubs: new Set() };
      map[k].count += 1;
      if (e.timestamp > map[k].lastAt) map[k].lastAt = e.timestamp;
      if (e.hub && e.hub !== "—") map[k].hubs.add(e.hub);
    });
    return Object.values(map)
      .map(r => ({ ...r, hubs: [...r.hubs] }))
      .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  }, [events]);

  // "X ago" using the same nowTick-free approach as the other Insights tabs —
  // good-enough relative time, recomputed on each render (parent re-renders on
  // filter changes; absolute precision isn't needed).
  const fmtAgo = (iso) => {
    if (!iso) return "—";
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1)    return "just now";
    if (mins < 60)   return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)    return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30)   return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  };

  const hubLabel = (h) => h === "hub1" ? "Hub 1" : h === "hub2" ? "Hub 2" : h;
  const totalEvents = events.length;
  const distinctSkus = rows.length;

  return (
    <div>
      {/* SUMMARY BOX — mirrors InsightOOSTrackerTab layout */}
      <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(248,113,113,.6)", borderRadius:14, padding:"16px 18px", marginBottom:12, display:"flex", alignItems:"center", gap:14, boxShadow:"0 0 16px rgba(248,113,113,.15)" }}>
        <div style={{ fontWeight:800, fontSize:42, color:"#F87171", lineHeight:1, letterSpacing:"-1.5px" }}>{totalEvents}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>Stock Depleted Events</div>
          <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>{distinctSkus} product–size combo{distinctSkus !== 1 ? "s" : ""} · {filterLabel}</div>
        </div>
      </div>

      {/* HUB FILTER + SEARCH */}
      <div style={{ display:"flex", gap:6, marginBottom:10, flexWrap:"wrap" }}>
        {[["all","All"],["hub1","Hub 1"],["hub2","Hub 2"]].map(([val, label]) => {
          const on = hubFilter === val;
          return (
            <button key={val} onClick={() => setHubFilter(val)}
                    style={{ padding:"7px 14px", borderRadius:999, fontSize:12, fontWeight:600, cursor:"pointer",
                             background: on ? "rgba(60,110,255,.14)" : "rgba(255,255,255,.03)",
                             border: "1px solid " + (on ? "rgba(60,110,255,.5)" : "rgba(255,255,255,.08)"),
                             color: on ? BLUE_L : "rgba(255,255,255,.55)" }}>
              {label}
            </button>
          );
        })}
      </div>
      <div style={{ marginBottom:12 }}>
        <input type="search" placeholder="Search product name…"
               value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
               style={{ width:"100%", boxSizing:"border-box", padding:"9px 12px", borderRadius:10, fontSize:13,
                        background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.1)", color:"#fff",
                        outline:"none" }}/>
      </div>

      {/* EMPTY STATE / LIST */}
      {rows.length === 0 ? (
        <div style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.3)", borderRadius:14, padding:"3rem", textAlign:"center", color:"rgba(255,255,255,.4)", fontSize:14 }}>
          <ProductIcon size={32} opacity={0.4}/>
          <div style={{ marginTop:12 }}>No display stock depletions in this period{searchTerm || hubFilter !== "all" ? " for the current filters" : ""}.</div>
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {rows.map((r, i) => (
            <div key={`${r.productName}__${r.size}`} style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(248,113,113,.3)", borderLeft:"3px solid rgba(248,113,113,.6)", borderRadius:12, padding:"12px 14px", display:"flex", alignItems:"center", gap:12 }}>
              <ProductThumb name={r.productName} photoMap={productPhotoMap} size={36}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:13, color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.productName}</div>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:4, flexWrap:"wrap" }}>
                  <span style={{ background:"rgba(60,110,255,.1)", border:"1px solid rgba(60,110,255,.25)", color:"#fff", borderRadius:8, padding:"2px 8px", fontSize:11, fontWeight:600 }}>Size {r.size}</span>
                  {r.hubs.map(h => (
                    <span key={h} style={{ background:"rgba(255,255,255,.04)", border:"1px solid rgba(255,255,255,.1)", color:"rgba(255,255,255,.6)", borderRadius:8, padding:"2px 8px", fontSize:10, fontWeight:600 }}>{hubLabel(h)}</span>
                  ))}
                  <span style={{ color:"rgba(255,255,255,.4)", fontSize:10 }}>· last {fmtAgo(r.lastAt)}</span>
                </div>
              </div>
              <div style={{ background:"rgba(248,113,113,.15)", color:"#F87171", border:"1px solid rgba(248,113,113,.4)", borderRadius:999, padding:"4px 12px", fontSize:13, fontWeight:700 }}>×{r.count}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── INSIGHTS: SALES SUMMARY TAB ─────────────────────────────────────────────
// Counts orders marked "ready" (not placed), deducts returns for the same
// period, then ranks products by net units sold. Cards are tappable to reveal
// a size breakdown for that product.
function InsightSalesSummaryTab({ log, returnsLog, productPhotoMap, filterStart, filterEnd, filterLabel, orders, filterMode, filterDate, category = "both" }) {
  const [expanded, setExpanded] = useState(new Set());

  // Today (day mode anchored on today's date): derive from live orders so the
  // headline matches Source's "Today's Request" in real time. Historical
  // days + week/month/year/all-time read from insights_log (immutable). Both
  // branches → dedupe by orderNumber + exclude returned orderNumbers so this
  // tab's totals reconcile exactly with Overview · Net Sales.
  // Net entries = "ready" log events for the period (incl. today), deduped by
  // orderNumber with returns excluded — shared with Overview · Net Sales via
  // readyEventsForPeriod, so the two reconcile exactly. The former live-orders
  // "today" path over-counted auto-collected OOS orders (OUT_OF_STOCK→COLLECTED)
  // as sales; "ready" log events never include those.
  const readyLog = useMemo(
    () => readyEventsForPeriod({ log, returnsLog, filterStart, filterEnd, category }),
    [log, returnsLog, filterStart, filterEnd, category]
  );

  const netByProduct = useMemo(() => {
    const map = {};
    readyLog.forEach(e => {
      const name = e.productName || "Unknown";
      map[name] = (map[name] || 0) + 1;
    });
    return map;
  }, [readyLog]);

  const sizesByProduct = useMemo(() => {
    const map = {};
    readyLog.forEach(e => {
      const name = e.productName || "Unknown";
      const sz   = String(e.size || "?");
      if (!map[name]) map[name] = {};
      map[name][sz] = (map[name][sz] || 0) + 1;
    });
    return map;
  }, [readyLog]);

  const ranked = useMemo(() =>
    Object.entries(netByProduct)
      .map(([name, net]) => ({ name, net }))
      .filter(p => p.net > 0)
      .sort((a, b) => b.net - a.net),
    [netByProduct]
  );

  const totalNet   = useMemo(() => ranked.reduce((s, p) => s + p.net, 0), [ranked]);
  const maxNet     = ranked[0]?.net || 1;

  const toggleCard = (name) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  return (
    <div>
      {/* ── Headline ── */}
      <div style={{ background:CARD, border:BORDER_BRIGHT, borderRadius:14, padding:"16px 18px", marginBottom:14, display:"flex", alignItems:"center", gap:14, boxShadow:"0 0 16px rgba(60,110,255,.18)" }}>
        <div style={{ fontWeight:800, fontSize:42, color:BLUE, lineHeight:1, flexShrink:0, letterSpacing:"-1.5px" }}>{totalNet}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontWeight:700, color:"#fff", fontSize:14 }}>Net Sales · {filterLabel}</div>
          <div style={{ color:"rgba(255,255,255,.5)", fontSize:11, marginTop:3, lineHeight:1.4 }}>Same as Net Sales total above, broken down by product. Ready orders minus returns. {ranked.length} product{ranked.length!==1?"s":""}.</div>
        </div>
      </div>

      {/* ── Ranked product list ── */}
      {ranked.length === 0 ? (
        <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"3rem", textAlign:"center", color:"#444", fontSize:"0.9rem" }}>
          No sales recorded in this period
        </div>
      ) : (
        <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"1.5rem", display:"flex", flexDirection:"column", gap:"0" }}>
          {ranked.map(({ name, net }, idx) => {
            const isOpen  = expanded.has(name);
            const sizes   = sizesByProduct[name] || {};
            const sizeRows = Object.entries(sizes)
              .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
            const isLast  = idx === ranked.length - 1;

            return (
              <div key={name}
                style={{ borderBottom: isLast ? "none" : "1px solid #1e1e1e", paddingTop: idx===0?"0":"0.85rem", paddingBottom:"0.85rem", cursor:"pointer" }}
                onClick={() => toggleCard(name)}>

                {/* ── Card header row ── */}
                <div style={{ display:"flex", alignItems:"center", gap:"0.75rem" }}>
                  {/* Rank */}
                  <span style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", letterSpacing:"0.04em", fontSize:"1rem", color:"#444", width:"1.4rem", textAlign:"right", flexShrink:0 }}>
                    {idx + 1}
                  </span>
                  {/* Thumbnail */}
                  <ProductThumb name={name} photoMap={productPhotoMap} size={44} />
                  {/* Name + count + arrow */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.35rem" }}>
                      <span style={{ fontWeight:"600", color:"#fff", fontSize:"0.9rem", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{name}</span>
                      <div style={{ display:"flex", alignItems:"center", gap:"0.45rem", flexShrink:0, marginLeft:"0.5rem" }}>
                        <span style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"1.15rem", color: idx===0 ? BLUE : "#ccc", letterSpacing:"0.03em" }}>
                          {net} sold
                        </span>
                        <span style={{ fontSize:"0.65rem", color:"#555", transition:"transform 0.2s", display:"inline-block", transform: isOpen?"rotate(90deg)":"rotate(0deg)" }}>▶</span>
                      </div>
                    </div>
                    <div style={{ background:"rgba(60,110,255,.08)", borderRadius:"4px", height:"8px" }}>
                      <div style={{
                        background: idx === 0 ? BLUE : "rgba(60,110,255,.4)",
                        borderRadius:"4px",
                        height:"8px",
                        width:`${Math.max(2, (net / maxNet) * 100)}%`,
                        transition:"width 0.4s",
                      }} />
                    </div>
                  </div>
                </div>

                {/* ── Expanded size breakdown ── */}
                {isOpen && (
                  <div style={{ marginTop:"0.75rem", marginLeft:"calc(1.4rem + 44px + 1.5rem)", background:"#0f0f0f", borderRadius:"10px", padding:"0.6rem 0.9rem" }}>
                    {sizeRows.length === 0 ? (
                      <div style={{ color:"#444", fontSize:"0.82rem" }}>No size data</div>
                    ) : sizeRows.map(([sz, count]) => (
                      <div key={sz} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.25rem 0", borderBottom:"1px solid rgba(60,110,255,.08)" }}>
                        <span style={{ color:"#888", fontSize:"0.82rem" }}>Size {sz}</span>
                        <span style={{ color:BLUE_L, fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"1rem", letterSpacing:"0.03em" }}>{count} sold</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── AI REORDER TAB ───────────────────────────────────────────────────────────
// Subscribes to /insights/reorderPlan/status and /insights/reorderPlan/latest
// (both written by the analyzeReorderNeeds Cloud Function in functions/index.js).
// A real run takes ~5 min — well past the 70 s httpsCallable client timeout —
// so the UI fires the call but does NOT await: status writes from the function
// drive the display via the onValue subscription.
//
// Status state machine (idle → running → idle | error) is the source of truth.
// Three steady displays:
//   • idle  + plan exists → render the cached plan + "Run Again"
//   • idle  + no plan     → empty state with first-run CTA
//   • running             → progress card; cached plan (if any) stays visible muted
//   • error               → error card with retry; cached plan stays visible muted
//
// Triggering: callable runs analyzeReorderNeeds (region europe-west1). The
// expected happy path returns deadline-exceeded after ~70 s while the function
// keeps running server-side; status subscription will flip to "running" on its
// own. Synchronous rejections (rate limit, concurrent run, permission) surface
// as triggerError. The Run buttons are super-admin-only because the function's
// assertAdmin only accepts ADMIN_EMAIL.
function InsightReorderTab({ productPhotoMap }) {
  const { isSuperAdmin } = usePermissions();
  const [status, setStatus]   = useState(null);
  const [latest, setLatest]   = useState(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [latestLoaded, setLatestLoaded] = useState(false);
  const [triggering,   setTriggering]   = useState(false);
  const [triggerError, setTriggerError] = useState(null);

  // ── Subscribe to both RTDB nodes for the duration of the tab's mount.
  // Cancel callbacks (third arg to onValue) ensure statusLoaded/latestLoaded
  // flip even when Firebase denies the read, so the tab never hangs on
  // "Loading…" forever. CR finding #1.
  useEffect(() => {
    const u1 = onValue(
      ref(database, "insights/reorderPlan/status"),
      snap => { setStatus(snap.val()); setStatusLoaded(true); },
      err  => { console.warn("reorderPlan/status read error:", err.message); setStatusLoaded(true); }
    );
    const u2 = onValue(
      ref(database, "insights/reorderPlan/latest"),
      snap => { setLatest(snap.val()); setLatestLoaded(true); },
      err  => { console.warn("reorderPlan/latest read error:", err.message);  setLatestLoaded(true); }
    );
    return () => { u1(); u2(); };
  }, []);

  const runAnalysis = (force = false) => {
    setTriggering(true);
    setTriggerError(null);
    const callable = httpsCallable(functions, "analyzeReorderNeeds");
    callable(force ? { force: true } : {}).catch(err => {
      const code = err.code || "";
      // deadline-exceeded ≈ "still working" — expected for real runs.
      if (code === "deadline-exceeded" || code === "functions/deadline-exceeded") return;
      setTriggerError(err.message || "Failed to start analysis.");
    });
    // Re-enable the button after ~2 s. By then the function has either rejected
    // at the gate (catch above fires) or written state:"running" (subscription
    // updates the UI). Re-clicking after the lock is held just gets rejected.
    setTimeout(() => setTriggering(false), 2000);
  };

  // ── Display helpers (scoped to this component to keep them grep-near the JSX).
  const fmtDate = ms => {
    if (!ms) return "—";
    const d = new Date(ms);
    return d.toLocaleDateString("en-ZA", { year:"numeric", month:"short", day:"numeric" })
         + " · " + d.toLocaleTimeString("en-ZA", { hour:"2-digit", minute:"2-digit" });
  };
  const fmtDuration = ms => {
    if (!ms || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const allLoaded = statusLoaded && latestLoaded;
  const state     = status?.state ?? null;
  const running   = state === "running";
  const errored   = state === "error";
  const hasPlan   = !!(latest && latest.plan);
  const canRun    = isSuperAdmin && !triggering && !running;

  // ── Action / priority styling. Kept inline so the badge meaning is visible
  // when reading the JSX below.
  const ACTION_STYLE = {
    reorder:    { label: "Reorder",    bg: "rgba(34,197,94,.12)",  border: "rgba(34,197,94,.5)",  color: "#86EFAC" },
    review:     { label: "Review",     bg: "rgba(245,158,11,.12)", border: "rgba(245,158,11,.5)", color: "#FCD34D" },
    slow_mover: { label: "Slow mover", bg: "rgba(251,146,60,.12)", border: "rgba(251,146,60,.5)", color: "#FDBA74" },
    skip:       { label: "Skip",       bg: "rgba(255,255,255,.04)", border: "rgba(255,255,255,.18)", color: "rgba(255,255,255,.5)" },
  };
  const PRIORITY_COLOR = { high: "#F87171", medium: "#F59E0B", low: "rgba(255,255,255,.45)" };
  const ACTION_ORDER   = ["reorder", "review", "slow_mover", "skip"];
  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

  // ── Group + sort recommendations once per plan change.
  const groupedRecs = useMemo(() => {
    if (!hasPlan || !Array.isArray(latest.plan.recommendations)) return {};
    const groups = { reorder: [], review: [], slow_mover: [], skip: [] };
    for (const r of latest.plan.recommendations) {
      const action = ACTION_STYLE[r.action] ? r.action : "skip";
      groups[action].push(r);
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => {
        const ap = PRIORITY_ORDER[a.priority] ?? 9;
        const bp = PRIORITY_ORDER[b.priority] ?? 9;
        if (ap !== bp) return ap - bp;
        return (b.totalSuggested || 0) - (a.totalSuggested || 0);
      });
    }
    return groups;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest && latest.generatedAt]);

  // ── Style fragments reused inside the render below.
  const cardBase = { background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.25)", borderRadius:14, padding:"14px 16px", marginBottom:10 };
  const sectionLabel = { fontSize:10, fontWeight:700, color:"rgba(255,255,255,.35)", textTransform:"uppercase", letterSpacing:"1.5px", marginBottom:8 };
  const runBtnStyle = (disabled) => ({
    background: disabled ? "rgba(60,110,255,.15)" : "rgba(60,110,255,.22)",
    color: disabled ? "rgba(255,255,255,.4)" : "#fff",
    border: "1px solid " + (disabled ? "rgba(60,110,255,.3)" : "rgba(60,110,255,.55)"),
    borderRadius: 10, padding: "9px 18px", fontSize: 13, fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: disabled ? "none" : "0 0 8px rgba(60,110,255,.3)",
  });

  // ── Loading skeleton: first paint before either subscription has fired.
  if (!allLoaded) {
    return (
      <div style={{ ...cardBase, borderColor:"rgba(60,110,255,.15)", padding:"3rem", textAlign:"center", color:"rgba(255,255,255,.4)", fontSize:13 }}>
        Loading…
      </div>
    );
  }

  // ── Trigger error banner (renders above everything when present).
  const TriggerErrorBanner = () => triggerError ? (
    <div style={{ background:"rgba(248,113,113,.1)", border:"1px solid rgba(248,113,113,.45)", borderRadius:12, padding:"10px 14px", marginBottom:10, display:"flex", alignItems:"center", gap:10 }}>
      <div style={{ fontSize:12, color:"#F87171", flex:1 }}>{triggerError}</div>
      <button onClick={() => setTriggerError(null)} style={{ background:"transparent", border:"none", color:"#F87171", cursor:"pointer", fontSize:18, lineHeight:1, padding:0 }}>×</button>
    </div>
  ) : null;

  // ── Empty state — first-ever load, nothing cached, nothing running.
  if (!hasPlan && !running && !errored) {
    return (
      <div>
        <TriggerErrorBanner />
        <div style={{ ...cardBase, borderColor:"rgba(60,110,255,.3)", padding:"2.5rem 1.5rem", textAlign:"center" }}>
          <div style={{ marginBottom:14, display:"flex", justifyContent:"center" }}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ filter:"drop-shadow(0 0 8px rgba(60,110,255,.45))" }}>
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
          <div style={{ fontWeight:700, color:"#fff", fontSize:15, marginBottom:6 }}>No reorder analysis yet</div>
          <div style={{ color:"rgba(255,255,255,.45)", fontSize:12, marginBottom:22, maxWidth:300, marginLeft:"auto", marginRight:"auto", lineHeight:1.5 }}>
            Run a fresh analysis to surface what to reorder for the next cycle and which products have gone quiet.
          </div>
          {isSuperAdmin ? (
            <button onClick={() => runAnalysis(false)} disabled={!canRun} style={runBtnStyle(!canRun)}>
              {triggering ? "Starting…" : "Run Analysis"}
            </button>
          ) : (
            <div style={{ color:"rgba(255,255,255,.35)", fontSize:11 }}>Only the super-admin can trigger a fresh analysis.</div>
          )}
        </div>
      </div>
    );
  }

  // ── Main render: status banner (if any) + cached plan body.
  const plan      = latest?.plan;
  const meta      = latest?.meta;
  const summary   = plan?.summary;
  const topSellers = Array.isArray(plan?.topSellers) ? plan.topSellers : [];
  const sleepers   = Array.isArray(plan?.sleepers)   ? plan.sleepers   : [];
  const qualityNotes = Array.isArray(plan?.dataQualityNotes) ? plan.dataQualityNotes : [];

  return (
    <div>
      <TriggerErrorBanner />

      {/* RUNNING BANNER */}
      {running && (
        <div style={{ background:"rgba(60,110,255,.1)", border:"1px solid rgba(60,110,255,.55)", borderRadius:14, padding:"14px 16px", marginBottom:10, display:"flex", alignItems:"center", gap:12, boxShadow:"0 0 12px rgba(60,110,255,.2)" }}>
          <div style={{ width:14, height:14, borderRadius:"50%", border:"2px solid rgba(60,110,255,.3)", borderTopColor:"#4A7FFF", animation:"spin 0.9s linear infinite", flexShrink:0 }} />
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontWeight:700, color:"#fff", fontSize:13 }}>Analysis in progress…</div>
            <div style={{ color:"rgba(255,255,255,.55)", fontSize:11, marginTop:2 }}>
              Started {fmtDate(status?.startedAt)} · typically 4–5 minutes
            </div>
          </div>
          {/* Inline keyframes (no global stylesheet to extend). */}
          <style>{"@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}"}</style>
        </div>
      )}

      {/* ERROR BANNER */}
      {errored && (
        <div style={{ background:"rgba(248,113,113,.1)", border:"1px solid rgba(248,113,113,.5)", borderRadius:14, padding:"14px 16px", marginBottom:10 }}>
          <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
            <div style={{ fontSize:18, lineHeight:1 }}>⚠</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:700, color:"#F87171", fontSize:13 }}>Last analysis failed</div>
              <div style={{ color:"rgba(255,255,255,.6)", fontSize:11, marginTop:4, lineHeight:1.5, wordBreak:"break-word" }}>
                {status?.errorMessage || "Unknown error."}
              </div>
              <div style={{ color:"rgba(255,255,255,.35)", fontSize:10, marginTop:6 }}>
                Failed {fmtDate(status?.erroredAt)}
              </div>
              {isSuperAdmin && (
                <button onClick={() => runAnalysis(true)} disabled={!canRun}
                  style={{ ...runBtnStyle(!canRun), marginTop:12, padding:"7px 14px", fontSize:12 }}>
                  {triggering ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {hasPlan && (
        // Dim the cached plan while a run or error is active so it's obvious
        // the visible recommendations may be stale. CR finding #3.
        <div style={{ opacity: running || errored ? 0.55 : 1, transition:"opacity 150ms ease" }}>
          {/* HEADER: summary text + run-again button */}
          <div style={{ ...cardBase, borderColor:"rgba(60,110,255,.55)", boxShadow:"0 0 14px rgba(60,110,255,.15)" }}>
            <div style={sectionLabel}>Plan Summary</div>
            <div style={{ color:"#fff", fontSize:13, lineHeight:1.55, marginBottom:12 }}>
              {summary || "No summary provided."}
            </div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12 }}>
              <div style={{ color:"rgba(255,255,255,.4)", fontSize:11 }}>
                Generated {fmtDate(latest.generatedAt)}
              </div>
              {isSuperAdmin && !running && (
                <button onClick={() => runAnalysis(false)} disabled={!canRun}
                  style={{ ...runBtnStyle(!canRun), padding:"7px 14px", fontSize:12 }}>
                  {triggering ? "Starting…" : "Run Again"}
                </button>
              )}
            </div>
          </div>

          {/* META STRIP */}
          {meta && (
            <div style={{ ...cardBase, padding:"12px 14px" }}>
              <div style={sectionLabel}>Run Details</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:8, fontSize:11 }}>
                <MetaRow label="Cycle" value={`${meta.cycleDays ?? "?"} days`} />
                <MetaRow label="Active products" value={`${meta.activeProductsTotal ?? 0}${meta.paginatedActive ? " (top 200)" : ""}`} />
                <MetaRow label="Dormant products" value={`${meta.dormantProductsTotal ?? 0}${meta.paginatedDormant ? " (top 200)" : ""}`} />
                <MetaRow label="Analysed" value={`${meta.productsAnalyzed ?? 0} / ${meta.catalogTotal ?? 0}`} />
                <MetaRow label="Duration" value={fmtDuration(latest.durationMs ?? meta.durationMs)} />
                <MetaRow label="Cost (USD)" value={meta.estimatedCostUSD != null ? `$${meta.estimatedCostUSD.toFixed(4)}` : "—"} />
              </div>
            </div>
          )}

          {/* DATA QUALITY NOTES (model-emitted) */}
          {qualityNotes.length > 0 && (
            <div style={{ ...cardBase, borderColor:"rgba(245,158,11,.35)", background:"rgba(245,158,11,.05)" }}>
              <div style={{ ...sectionLabel, color:"#F59E0B" }}>Data Quality Notes</div>
              <ul style={{ margin:0, padding:"0 0 0 18px", color:"rgba(255,255,255,.7)", fontSize:11, lineHeight:1.6 }}>
                {qualityNotes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}

          {/* RECOMMENDATIONS — grouped by action, ordered reorder → review → slow_mover → skip */}
          {ACTION_ORDER.map(action => {
            const list = groupedRecs[action] || [];
            if (!list.length) return null;
            const style = ACTION_STYLE[action];
            return (
              <div key={action} style={{ marginBottom:14 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 2px 8px" }}>
                  <span style={{ background:style.bg, border:`1px solid ${style.border}`, color:style.color, padding:"3px 10px", borderRadius:999, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.5px" }}>
                    {style.label}
                  </span>
                  <span style={{ color:"rgba(255,255,255,.45)", fontSize:11, fontWeight:600 }}>{list.length}</span>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {list.map(rec => {
                    const sizes = rec.suggestedQuantity && typeof rec.suggestedQuantity === "object"
                      ? Object.entries(rec.suggestedQuantity).filter(([, q]) => q > 0)
                      : [];
                    return (
                      <div key={rec.productId || rec.productName} style={{ background:"rgba(4,5,10,1)", border:"1px solid rgba(60,110,255,.22)", borderLeft:`3px solid ${style.border}`, borderRadius:12, padding:"12px 14px" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                          <ProductThumb name={rec.productName} photoMap={productPhotoMap} size={40}/>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontWeight:700, fontSize:13, color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{rec.productName || "(no name)"}</div>
                            <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:3 }}>
                              {rec.priority && (
                                <span style={{ fontSize:10, fontWeight:700, color:PRIORITY_COLOR[rec.priority] || PRIORITY_COLOR.low, textTransform:"uppercase", letterSpacing:"0.5px" }}>
                                  {rec.priority}
                                </span>
                              )}
                              {action === "reorder" && rec.totalSuggested != null && (
                                <span style={{ color:"rgba(255,255,255,.55)", fontSize:10 }}>· {rec.totalSuggested} units</span>
                              )}
                            </div>
                          </div>
                          {action === "reorder" && rec.totalSuggested != null && (
                            <div style={{ background:style.bg, color:style.color, border:`1px solid ${style.border}`, borderRadius:999, padding:"4px 12px", fontSize:13, fontWeight:700, flexShrink:0 }}>
                              ×{rec.totalSuggested}
                            </div>
                          )}
                        </div>

                        {sizes.length > 0 && (
                          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:10 }}>
                            {sizes.map(([sz, count]) => (
                              <span key={sz} style={{ display:"inline-flex", alignItems:"center", gap:5, background:"rgba(60,110,255,.08)", border:"1px solid rgba(60,110,255,.22)", borderRadius:7, padding:"3px 9px", fontSize:11, fontWeight:600, color:"#fff" }}>
                                <span>{sz}</span>
                                <span style={{ background:"rgba(60,110,255,.2)", color:BLUE_L, borderRadius:999, padding:"0 6px", fontSize:10, fontWeight:700 }}>{count}</span>
                              </span>
                            ))}
                          </div>
                        )}

                        {rec.reasoning && (
                          <div style={{ color:"rgba(255,255,255,.62)", fontSize:11, lineHeight:1.55, marginTop:sizes.length > 0 ? 10 : 8 }}>
                            {rec.reasoning}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* TOP SELLERS */}
          {topSellers.length > 0 && (
            <div style={{ ...cardBase }}>
              <div style={sectionLabel}>Top Sellers</div>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {topSellers.map((t, i) => (
                  <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom: i < topSellers.length - 1 ? "1px solid rgba(255,255,255,.05)" : "none" }}>
                    <span style={{ color:"#fff", fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1, marginRight:8 }}>{t.productName}</span>
                    <span style={{ color:BLUE_L, fontSize:12, fontWeight:700, flexShrink:0 }}>{t.totalSales}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SLEEPERS */}
          {sleepers.length > 0 && (
            <div style={{ ...cardBase }}>
              <div style={sectionLabel}>Sleepers</div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {sleepers.map((s, i) => (
                  <div key={i} style={{ padding:"6px 0", borderBottom: i < sleepers.length - 1 ? "1px solid rgba(255,255,255,.05)" : "none" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8 }}>
                      <span style={{ color:"#fff", fontSize:12, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{s.productName}</span>
                      <span style={{ color:"rgba(255,255,255,.45)", fontSize:10, flexShrink:0 }}>
                        last {s.lastSaleDate || "—"} · {s.totalSales ?? 0} sales
                      </span>
                    </div>
                    {s.note && <div style={{ color:"rgba(255,255,255,.55)", fontSize:11, marginTop:3, lineHeight:1.5 }}>{s.note}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Small label/value row used inside the AI Reorder meta strip.
function MetaRow({ label, value }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", gap:6, alignItems:"baseline" }}>
      <span style={{ color:"rgba(255,255,255,.4)" }}>{label}</span>
      <span style={{ color:"#fff", fontWeight:600 }}>{value}</span>
    </div>
  );
}

// Insights auth persists for the session via sessionStorage.
// Cleared when the user taps Exit so the next visit re-asks for the password.
const INSIGHTS_SESSION_KEY = "insightsAuth";

// ─── INSIGHTS VIEW ────────────────────────────────────────────────────────────
function InsightsView({ onExit }) {
  const [authed,     setAuthed]     = useState(() => sessionStorage.getItem(INSIGHTS_SESSION_KEY) === "true");
  const [pw,         setPw]         = useState("");
  const [pwError,    setPwError]    = useState(false);
  const [tab,        setTab]        = usePersistedTab("insights", "overview");
  const [filterMode, setFilterMode] = useState("day");
  const [filterDate, setFilterDate] = useState(() => getSADateString());
  // Phase 12D: product-type filter ("sneaker" | "clothing" | "both"). Applied
  // in 6 of 9 tabs; hidden on tabs where it doesn't make sense (sizes,
  // depleted, clothing-refills).
  const [category,   setCategory]   = useState("both");
  // Phase 14C: top-level store filter — slices every Insights tab to a
  // subset of events tagged with placedAtHub. "all" is current behavior,
  // "central" keeps hub1/hub2 events, "pine" keeps hub3 events. Events
  // missing placedAtHub (pre-14B history) are excluded by Central/Pine
  // until the backfill stamps them.
  const [storeFilter, setStoreFilter] = useState("all");
  const [auditOpen,  setAuditOpen]  = useState(false);
  const touchStartX = useRef(null);
  const log        = useInsightsLog();
  const returnsLog = useReturnsLog();
  const products   = useProducts();
  const orders     = useOrders();

  // Pre-filter the three event streams by storeFilter so every downstream
  // tab/audit consumes an already-narrowed slice. dedupeByOrderNumber and
  // excludeReturnedOrderNumbers continue to operate on whatever passes through.
  // Central treats missing placedAtHub as Central — historical events
  // pre-date Phase 14B and were all placed in the central universe, so the
  // filter is self-healing without a backfill. Pine stays strict.
  const matchesStore = useMemo(() => {
    if (storeFilter === "all") return () => true;
    if (storeFilter === "pine") return (e) => e && e.placedAtHub === "hub3";
    return (e) => e && (!e.placedAtHub || e.placedAtHub === "hub1" || e.placedAtHub === "hub2");
  }, [storeFilter]);
  const filteredLog        = useMemo(() => log.filter(matchesStore),         [log, matchesStore]);
  const filteredReturnsLog = useMemo(() => returnsLog.filter(matchesStore),  [returnsLog, matchesStore]);
  const filteredOrders     = useMemo(() => orders.filter(matchesStore),      [orders, matchesStore]);

  // ── ORDER AUDIT — runs in-memory, renders to a modal ─────────────────────
  // Phase 14C: respects the storeFilter via filteredOrders / filteredReturnsLog,
  // so the audit reflects the same slice the user is viewing.
  const audit = useMemo(() => {
    const today = getSADateString();
    const KNOWN = new Set(["ready","collected","out_of_stock","tomorrow","on_hold","incoming","coming_tomorrow"]);
    const onTodayCreated = filteredOrders.filter(o => o.createdAt && o.createdAt.slice(0,10) === today);

    // Status distributions
    const byStatusAll = {};
    const byStatusToday = {};
    filteredOrders.forEach(o => {
      const s = o.status === undefined ? "(undefined)" : (o.status || "(empty)");
      byStatusAll[s] = (byStatusAll[s] || 0) + 1;
    });
    onTodayCreated.forEach(o => {
      const s = o.status === undefined ? "(undefined)" : (o.status || "(empty)");
      byStatusToday[s] = (byStatusToday[s] || 0) + 1;
    });

    // Order number gaps + duplicates
    const todayNums = onTodayCreated
      .map(o => parseInt(String(o.id).replace(/[^0-9]/g, ""), 10))
      .filter(n => !isNaN(n));
    const minNum = todayNums.length ? Math.min(...todayNums) : null;
    const maxNum = todayNums.length ? Math.max(...todayNums) : null;
    const present = new Set(todayNums);
    const gaps = [];
    if (minNum !== null && maxNum !== null) {
      for (let i = minNum; i <= maxNum; i++) if (!present.has(i)) gaps.push(i);
    }
    const dupCount = {};
    todayNums.forEach(n => { dupCount[n] = (dupCount[n] || 0) + 1; });
    const dups = Object.entries(dupCount).filter(([, c]) => c > 1).map(([n, c]) => ({ orderNumber: n, count: c }));

    const ordersNoStatus = onTodayCreated.filter(o => !o.status || String(o.status).trim() === "");
    const ordersUnknownStatus = onTodayCreated.filter(o => o.status && !KNOWN.has(o.status));
    const softDeleted = onTodayCreated.filter(o => o.deleted === true || o.removed === true || o.archived === true);
    const multiStamp = onTodayCreated.filter(o => {
      const stamps = [o.readyAt, o.outOfStockAt, o.comingTomorrowAt].filter(Boolean);
      return stamps.length > 1;
    });

    const ready     = onTodayCreated.filter(o => o.status === STATUS.READY).length;
    const collected = onTodayCreated.filter(o => o.status === STATUS.COLLECTED).length;
    const oos       = onTodayCreated.filter(o => o.status === STATUS.OUT_OF_STOCK).length;
    const tomorrow  = onTodayCreated.filter(o => o.status === STATUS.COMING_TOMORROW).length;
    const incoming  = onTodayCreated.filter(o => o.status === STATUS.INCOMING).length;
    const sumByStatus = ready + collected + oos + tomorrow + incoming;

    const accounted = new Set([STATUS.READY, STATUS.COLLECTED, STATUS.OUT_OF_STOCK, STATUS.COMING_TOMORROW, STATUS.INCOMING]);
    const unaccounted = onTodayCreated.filter(o => !accounted.has(o.status));

    const returnsToday = filteredReturnsLog.filter(r => (r.timestamp||"").slice(0,10) === today).length;

    return {
      today,
      totalAll: filteredOrders.length,
      totalToday: onTodayCreated.length,
      byStatusAll, byStatusToday,
      minNum, maxNum, gaps, dups,
      ordersNoStatus, ordersUnknownStatus, softDeleted, multiStamp, unaccounted,
      ready, collected, oos, tomorrow, incoming, sumByStatus,
      diff: onTodayCreated.length - sumByStatus,
      returnsToday,
      netSales: (ready + collected) - returnsToday,
    };
  }, [filteredOrders, filteredReturnsLog]);

  // Compute filterStart / filterEnd (exclusive) / filterLabel from mode + anchor date.
  const { filterStart, filterEnd, filterLabel } = useMemo(() => {
    // All Time short-circuit — sentinel ISO strings that pass every
    // existing `iso >= filterStart && iso < filterEnd` comparison in tabs.
    // Day-mode special branches naturally skip because filterMode !== "day".
    if (filterMode === "all") {
      return {
        filterStart: "0000-01-01T00:00:00.000Z",
        filterEnd:   "9999-12-31T23:59:59.999Z",
        filterLabel: "All Time",
      };
    }
    const base = dateStrToLocal(filterDate);
    let start, end, label;
    if (filterMode === "day") {
      start = new Date(base); start.setHours(0,0,0,0);
      end   = new Date(base); end.setDate(end.getDate()+1); end.setHours(0,0,0,0);
      label = filterDate === getSADateString() ? "today"
        : base.toLocaleDateString([], { day:"numeric", month:"short", year:"numeric" });
    } else if (filterMode === "week") {
      const dow = (base.getDay()+6)%7;
      start = new Date(base); start.setDate(base.getDate()-dow); start.setHours(0,0,0,0);
      end   = new Date(start); end.setDate(start.getDate()+7);
      const sunday = new Date(end.getTime()-1);
      const fmt = d => `${d.getDate()} ${_MONTHS[d.getMonth()].slice(0,3)}`;
      label = `${fmt(start)} – ${fmt(sunday)}`;
    } else if (filterMode === "month") {
      start = new Date(base.getFullYear(), base.getMonth(), 1);
      end   = new Date(base.getFullYear(), base.getMonth()+1, 1);
      label = `${_MONTHS[base.getMonth()]} ${base.getFullYear()}`;
    } else {
      // year
      start = new Date(base.getFullYear(), 0, 1);
      end   = new Date(base.getFullYear()+1, 0, 1);
      label = `${base.getFullYear()}`;
    }
    return { filterStart: start.toISOString(), filterEnd: end.toISOString(), filterLabel: label };
  }, [filterMode, filterDate]);

  // Build name → { photoUrl, photo } lookup for thumbnail display in every tab.
  // Also indexes by normalized name (lowercase, collapsed spaces, no spaces around
  // hyphens) so old order names that drifted from the catalog still resolve.
  const productPhotoMap = useMemo(() => {
    const normKey = s => s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\s*-\s*/g, '-');
    const map = {};
    products.forEach(p => {
      if (!p.name) return;
      const entry = { photoUrl: p.photoUrl || null, photo: p.photo || "" };
      map[p.name] = entry;
      map[normKey(p.name)] = entry;
    });
    return map;
  }, [products]);

  const checkPw = () => {
    if (pw === "1551") { sessionStorage.setItem(INSIGHTS_SESSION_KEY, "true"); setAuthed(true); }
    else { setPwError(true); setTimeout(()=>setPwError(false), 1500); }
  };

  const handleExit = () => {
    sessionStorage.removeItem(INSIGHTS_SESSION_KEY);
    onExit();
  };

  const TABS = [
    { key:"overview",         label:"Overview" },
    { key:"sales",            label:"Sales Summary" },
    { key:"search",           label:"Product Search" },
    { key:"oos",              label:"Out of Stock" },
    { key:"sizes",            label:"Size Popularity" },
    { key:"times",            label:"Busiest Times" },
    { key:"returns",          label:"Returns" },
    { key:"clothing-refills", label:"Clothing Refills" },
    { key:"depleted",         label:"Stock Depleted" },
    { key:"reorder",          label:"AI Reorder" },
  ];
  // Tabs where the Sneaker/Clothing/Both toggle is NOT applicable.
  // "reorder" is AI-driven across the whole catalog — the toggle doesn't bind.
  const CATEGORY_HIDDEN_TABS = new Set(["depleted", "clothing-refills", "reorder"]);
  const tabKeys = TABS.map(t => t.key);

  const handleSwipe = (e) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 50) return;
    const idx = tabKeys.indexOf(tab);
    if (dx < 0 && idx < tabKeys.length - 1) setTab(tabKeys[idx + 1]); // left → next
    if (dx > 0 && idx > 0)                  setTab(tabKeys[idx - 1]); // right → prev
  };

  if (!authed) return (
    <div style={{ minHeight:"100vh", background:BG, color:"#fff", fontFamily:FONT, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"2rem" }}>
      <div style={{ marginBottom:"0.5rem" }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="1.6" strokeLinecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
      </div>
      <h1 style={{ fontFamily:"'SF Pro Display',-apple-system,sans-serif", fontWeight:"800", fontSize:"3rem", letterSpacing:"0.05em", margin:"0 0 0.5rem" }}>INTERNAL INSIGHTS</h1>
      <p style={{ color:"#666", marginBottom:"2rem" }}>Enter password to continue</p>
      <div style={{ display:"flex", gap:"0.75rem", width:"100%", maxWidth:"360px" }}>
        <input type="password" placeholder="Password" value={pw}
          onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&checkPw()}
          style={{ ...inputStyle, flex:1, borderColor:pwError?"#F87171":"rgba(60,110,255,.2)" }} />
        <button onClick={checkPw} style={{ ...bBlue, padding:"0 1.25rem", fontSize:"1rem" }}>Enter</button>
      </div>
      {pwError && <div style={{ color:"#F87171", marginTop:"0.75rem", fontSize:"0.9rem" }}>Incorrect password</div>}
      <button onClick={handleExit} style={{ ...bGhost, marginTop:"2rem", padding:"0.4rem 1rem" }}>← Back</button>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:"#000", color:"#fff", fontFamily:FONT, maxWidth:430, margin:"0 auto", overflowX:"hidden", paddingBottom:40 }}>
      {/* TOP BAR */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"50px 14px 0" }}>
        <div onClick={handleExit} style={{ color:"#4A7FFF", fontSize:13, fontWeight:500, cursor:"pointer" }}>← Exit</div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" style={{ filter:"drop-shadow(0 0 4px rgba(60,110,255,.5))" }}>
            <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <div style={{ fontSize:12, fontWeight:700, color:"#fff", letterSpacing:"0.5px" }}>INTERNAL INSIGHTS</div>
        </div>
        <div style={{ fontSize:10, color:"#4A7FFF", fontWeight:500 }}>{filteredLog.length} entries</div>
      </div>
      {/* Phase 14C: Store filter — All / Central / Pine. Hidden on the AI
          Reorder tab: that data is a global analysis, not store-sliced, so
          showing the pill there would be misleading. CR finding #2. */}
      <div style={{ padding:"10px 14px 0", display:"flex", gap:6, visibility: tab === "reorder" ? "hidden" : "visible" }}>
        {[["all","All"],["central","Central"],["pine","Pine"]].map(([val, label]) => {
          const on = storeFilter === val;
          return (
            <button key={val} onClick={() => setStoreFilter(val)}
              style={{ flex:1, padding:"7px 10px", borderRadius:10, fontSize:11.5, fontWeight:700, cursor:"pointer",
                       background: on ? "rgba(60,110,255,.22)" : "rgba(255,255,255,.03)",
                       border: "1px solid " + (on ? "rgba(60,110,255,.55)" : "rgba(255,255,255,.08)"),
                       color: on ? "#fff" : "rgba(255,255,255,.5)",
                       boxShadow: on ? "0 0 6px rgba(60,110,255,.35)" : "none" }}>
              {label}
            </button>
          );
        })}
      </div>
      {/* TAB BAR */}
      <div style={{ display:"flex", overflowX:"auto", scrollbarWidth:"none", padding:"10px 14px 0", gap:0, borderBottom:"1px solid rgba(255,255,255,.06)", marginBottom:12 }}>
        {TABS.map(t => {
          const on = tab === t.key;
          return (
            <div key={t.key} onClick={() => setTab(t.key)}
                 style={{ padding:"8px 14px", fontSize:12, fontWeight: on ? 600 : 500, color: on ? "#4A7FFF" : "rgba(255,255,255,.3)", borderBottom: on ? "2px solid #4A7FFF" : "2px solid transparent", whiteSpace:"nowrap", cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
              {t.icon ? <span style={{ fontSize:13 }}>{t.icon}</span> : null} {t.label}
            </div>
          );
        })}
      </div>
      {/* Phase 12D: category toggle. Hidden on tabs where it doesn't apply
          (size popularity, stock depleted, clothing refills). */}
      {!CATEGORY_HIDDEN_TABS.has(tab) && (
        <div style={{ padding:"0 14px 10px", display:"flex", gap:6 }}>
          {[["both","Both"],["sneaker","Sneakers"],["clothing","Clothing"]].map(([val, label]) => {
            const on = category === val;
            return (
              <button key={val} onClick={() => setCategory(val)}
                style={{ flex:1, padding:"7px 10px", borderRadius:10, fontSize:11.5, fontWeight:700, cursor:"pointer",
                         background: on ? "rgba(60,110,255,.18)" : "rgba(255,255,255,.03)",
                         border: "1px solid " + (on ? "rgba(60,110,255,.5)" : "rgba(255,255,255,.08)"),
                         color: on ? "#fff" : "rgba(255,255,255,.5)" }}>
                {label}
              </button>
            );
          })}
        </div>
      )}
      {/* Date picker is hidden on the reorder tab — InsightReorderTab does not
          consume filterMode/filterDate, so showing it would imply a filter that
          is actually a no-op. CR finding (outside-diff). */}
      {tab !== "reorder" && (
        <InsightsDatePicker mode={filterMode} setMode={setFilterMode} dateStr={filterDate} setDateStr={setFilterDate} />
      )}

      {/* Order Audit button — admin-protected (Insights password gate already passed) */}
      <div style={{ padding:"0 14px 12px" }}>
        <button onClick={() => setAuditOpen(true)}
                style={{
                  width:"100%",
                  background: audit.diff !== 0 ? "rgba(248,113,113,.12)" : "rgba(60,110,255,.08)",
                  border: audit.diff !== 0 ? "1px solid rgba(248,113,113,.4)" : "1px solid rgba(60,110,255,.3)",
                  color: audit.diff !== 0 ? "#F87171" : "#4A7FFF",
                  borderRadius:10, padding:"10px 14px", fontSize:13, fontWeight:600, cursor:"pointer",
                  display:"flex", alignItems:"center", justifyContent:"center", gap:8,
                }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v2m0 4h.01M5 19h14a2 2 0 002-2v-1a8 8 0 10-16 0v1a2 2 0 002 2z"/></svg>
          Run Order Audit
          {audit.diff !== 0 && <span style={{ marginLeft:4, fontSize:11, fontWeight:700 }}>· {audit.diff} unaccounted</span>}
        </button>
      </div>

      <div style={{ padding:"0 14px 16px" }}
        onTouchStart={e => { touchStartX.current = e.touches[0].clientX; }}
        onTouchEnd={handleSwipe}>
        {tab==="overview"         && <InsightOverviewTab        log={filteredLog} returnsLog={filteredReturnsLog} productPhotoMap={productPhotoMap} filterStart={filterStart} filterEnd={filterEnd} filterLabel={filterLabel} orders={filteredOrders} filterMode={filterMode} filterDate={filterDate} category={category} />}
        {tab==="sales"            && <InsightSalesSummaryTab    log={filteredLog} returnsLog={filteredReturnsLog} productPhotoMap={productPhotoMap} filterStart={filterStart} filterEnd={filterEnd} filterLabel={filterLabel} orders={filteredOrders} filterMode={filterMode} filterDate={filterDate} category={category} />}
        {tab==="search"           && <InsightProductSearchTab   log={filteredLog} productPhotoMap={productPhotoMap} filterStart={filterStart} filterEnd={filterEnd} category={category} />}
        {tab==="oos"              && <InsightOOSTrackerTab      log={filteredLog} returnsLog={filteredReturnsLog} productPhotoMap={productPhotoMap} filterStart={filterStart} filterEnd={filterEnd} filterLabel={filterLabel} category={category} />}
        {tab==="sizes"            && <InsightSizePopularityTab  log={filteredLog} filterStart={filterStart} filterEnd={filterEnd} filterLabel={filterLabel} category={category} />}
        {tab==="times"            && <InsightBusiestTimesTab    log={filteredLog} filterStart={filterStart} filterEnd={filterEnd} filterLabel={filterLabel} category={category} />}
        {tab==="returns"          && <InsightReturnsTab         returnsLog={filteredReturnsLog} productPhotoMap={productPhotoMap} filterStart={filterStart} filterEnd={filterEnd} filterLabel={filterLabel} category={category} />}
        {tab==="clothing-refills" && <InsightClothingRefillsTab orders={filteredOrders} log={filteredLog} productPhotoMap={productPhotoMap} filterStart={filterStart} filterEnd={filterEnd} filterLabel={filterLabel} filterMode={filterMode} filterDate={filterDate} />}
        {tab==="depleted"         && <InsightStockDepletedTab   orders={filteredOrders} log={filteredLog} productPhotoMap={productPhotoMap} filterStart={filterStart} filterEnd={filterEnd} filterLabel={filterLabel} filterMode={filterMode} filterDate={filterDate} />}
        {tab==="reorder"          && <InsightReorderTab          productPhotoMap={productPhotoMap} />}
      </div>

      {/* AUDIT MODAL */}
      {auditOpen && <AuditModal audit={audit} onClose={() => setAuditOpen(false)} />}
    </div>
  );
}

// ─── AUDIT MODAL ──────────────────────────────────────────────────────────────
function AuditModal({ audit, onClose }) {
  const Section = ({ title, children, count, danger }) => (
    <div style={{ marginBottom:16, background:"rgba(4,5,10,1)", border: danger ? "1px solid rgba(248,113,113,.4)" : "1px solid rgba(60,110,255,.2)", borderRadius:10, padding:14 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <div style={{ fontSize:12, fontWeight:700, color: danger ? "#F87171" : "#4A7FFF", textTransform:"uppercase", letterSpacing:"0.8px" }}>{title}</div>
        {count != null && <div style={{ fontSize:11, fontWeight:700, color:"#fff", background: danger ? "rgba(248,113,113,.2)" : "rgba(60,110,255,.2)", padding:"2px 9px", borderRadius:999 }}>{count}</div>}
      </div>
      {children}
    </div>
  );
  const Row = ({ label, value, highlight }) => (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"4px 0", borderBottom:"1px solid rgba(255,255,255,.05)" }}>
      <span style={{ color:"rgba(255,255,255,.6)", fontSize:12 }}>{label}</span>
      <span style={{ color: highlight ? "#F87171" : "#fff", fontSize:12, fontWeight:600 }}>{value}</span>
    </div>
  );
  const fmt = (s) => s ? String(s).slice(0, 19).replace("T", " ") : "—";

  const OrderTable = ({ orders }) => {
    if (!orders.length) return <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, padding:"4px 0" }}>None.</div>;
    return (
      <div style={{ overflowX:"auto", marginTop:6 }}>
        <table style={{ width:"100%", fontSize:10, borderCollapse:"collapse", color:"#ddd" }}>
          <thead>
            <tr style={{ color:"rgba(255,255,255,.5)" }}>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>#</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>status</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>customer</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>product</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>created</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>readyAt</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>collectedAt</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>oosAt</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>tomorrowAt</th>
              <th style={{ textAlign:"left", padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.1)" }}>flags</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.id}>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)", color:"#6A9FFF", fontWeight:700 }}>{o.id}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)", color: o.status ? "#fff" : "#F87171" }}>{o.status === undefined ? "(undefined)" : (o.status || "(empty)")}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)" }}>{o.customerName || "—"}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)" }}>{(o.productName || "—") + (o.size ? ` Sz${o.size}` : "")}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)" }}>{fmt(o.createdAt)}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)" }}>{fmt(o.readyAt)}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)" }}>{fmt(o.collectedAt)}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)" }}>{fmt(o.outOfStockAt)}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)" }}>{fmt(o.comingTomorrowAt)}</td>
                <td style={{ padding:"4px 6px", borderBottom:"1px solid rgba(255,255,255,.04)", fontSize:9, color:"#F87171" }}>
                  {[o.deleted&&"deleted", o.removed&&"removed", o.archived&&"archived"].filter(Boolean).join(",") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.85)", zIndex:9999, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"20px 8px", overflowY:"auto" }}
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           style={{ width:"100%", maxWidth:560, background:"#000", border:"1px solid rgba(60,110,255,.4)", borderRadius:14, padding:16, color:"#fff", fontFamily:FONT, boxShadow:"0 0 32px rgba(60,110,255,.2)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, paddingBottom:10, borderBottom:"1px solid rgba(60,110,255,.2)" }}>
          <div>
            <div style={{ fontSize:14, fontWeight:800, color:"#fff" }}>Order Audit</div>
            <div style={{ fontSize:11, color:"rgba(255,255,255,.4)", marginTop:2 }}>{audit.today} · live snapshot</div>
          </div>
          <button onClick={onClose} style={{ background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.15)", color:"#fff", borderRadius:8, padding:"6px 12px", fontSize:12, cursor:"pointer" }}>Close</button>
        </div>

        {/* Reconciliation */}
        <Section title="Reconciliation (today)" danger={audit.diff !== 0} count={audit.diff !== 0 ? `Δ ${audit.diff}` : "OK"}>
          <Row label="Total orders in Firebase (all dates)" value={audit.totalAll} />
          <Row label="Orders created today (createdAt)" value={audit.totalToday} />
          <Row label="READY" value={audit.ready} />
          <Row label="COLLECTED" value={audit.collected} />
          <Row label="OUT_OF_STOCK" value={audit.oos} />
          <Row label="COMING_TOMORROW" value={audit.tomorrow} />
          <Row label="INCOMING" value={audit.incoming} />
          <Row label="Sum of all 5 statuses" value={audit.sumByStatus} />
          <Row label="Diff (unaccounted)" value={audit.diff} highlight={audit.diff !== 0} />
          <Row label="Returns logged today" value={audit.returnsToday} />
          <Row label="Net Sales (READY+COLLECTED − returns)" value={audit.netSales} />
        </Section>

        {/* Status distribution */}
        <Section title="Status distribution — today" count={audit.totalToday}>
          {Object.entries(audit.byStatusToday).sort((a,b) => b[1] - a[1]).map(([s, c]) => (
            <Row key={s} label={s} value={c} />
          ))}
        </Section>

        <Section title="Status distribution — all orders" count={audit.totalAll}>
          {Object.entries(audit.byStatusAll).sort((a,b) => b[1] - a[1]).map(([s, c]) => (
            <Row key={s} label={s} value={c} />
          ))}
        </Section>

        {/* Order number gaps + dups */}
        <Section title="Order number gaps (today)" count={audit.gaps.length} danger={audit.gaps.length > 0}>
          <Row label="Range" value={audit.minNum != null ? `#${audit.minNum} → #${audit.maxNum}` : "—"} />
          <Row label="Span" value={audit.minNum != null ? (audit.maxNum - audit.minNum + 1) : 0} />
          <Row label="Found" value={audit.totalToday} />
          <Row label="Missing" value={audit.gaps.length} highlight={audit.gaps.length > 0} />
          {audit.gaps.length > 0 && (
            <div style={{ marginTop:8, padding:8, background:"rgba(248,113,113,.06)", border:"1px solid rgba(248,113,113,.2)", borderRadius:6, color:"#F87171", fontSize:11, wordBreak:"break-all" }}>
              {audit.gaps.map(n => `#${n.toString().padStart(3,"0")}`).join("  ")}
            </div>
          )}
        </Section>

        <Section title="Duplicate order numbers" count={audit.dups.length} danger={audit.dups.length > 0}>
          {audit.dups.length === 0 ? <div style={{ color:"rgba(255,255,255,.4)", fontSize:11 }}>None.</div> :
            audit.dups.map(d => <Row key={d.orderNumber} label={`#${d.orderNumber}`} value={`${d.count}×`} highlight />)}
        </Section>

        {/* Anomaly tables */}
        <Section title="Orders with NO status" count={audit.ordersNoStatus.length} danger={audit.ordersNoStatus.length > 0}>
          <OrderTable orders={audit.ordersNoStatus} />
        </Section>

        <Section title="Orders with UNKNOWN/legacy status" count={audit.ordersUnknownStatus.length} danger={audit.ordersUnknownStatus.length > 0}>
          <OrderTable orders={audit.ordersUnknownStatus} />
        </Section>

        <Section title="Soft-deleted orders" count={audit.softDeleted.length} danger={audit.softDeleted.length > 0}>
          <OrderTable orders={audit.softDeleted} />
        </Section>

        <Section title="Multi-timestamp orders (changed mind)" count={audit.multiStamp.length}>
          <OrderTable orders={audit.multiStamp} />
        </Section>

        <Section title="UNACCOUNTED orders (the ghosts)" count={audit.unaccounted.length} danger={audit.unaccounted.length > 0}>
          {audit.unaccounted.length === 0
            ? <div style={{ color:"rgba(74,222,128,.7)", fontSize:11 }}>All today's orders fall into a known status. ✓</div>
            : <OrderTable orders={audit.unaccounted} />}
        </Section>

        <div style={{ textAlign:"center", paddingTop:8, color:"rgba(255,255,255,.3)", fontSize:10 }}>
          Tap outside or Close to dismiss · screenshot to share
        </div>
      </div>
    </div>
  );
}

// ─── PRIVACY POLICY PAGE ─────────────────────────────────────────────────────
function PrivacyPage() {
  const section = (num, title, children) => (
    <div style={{ marginBottom: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: "700", color: "#111", marginBottom: "0.5rem" }}>
        {num}. {title}
      </h2>
      <p style={{ color: "#444", lineHeight: "1.75", margin: 0 }}>{children}</p>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#fff", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif", color: "#111" }}>
      <style>{`/* SF Pro Display — system font, no import needed */`}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #e5e7eb", padding: "1.25rem 1.5rem", display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <span style={{ fontFamily: "'Bebas Neue', system-ui", fontSize: "1.4rem", letterSpacing: "0.05em", color: "#111" }}>MARATHON CLUB</span>
      </div>

      {/* Content */}
      <div style={{ maxWidth: "680px", margin: "0 auto", padding: "2.5rem 1.5rem" }}>
        <h1 style={{ fontFamily: "'Bebas Neue'", fontSize: "2.2rem", letterSpacing: "0.04em", color: "#111", marginBottom: "0.4rem" }}>
          Privacy Policy
        </h1>
        <p style={{ color: "#9ca3af", fontSize: "0.88rem", marginBottom: "2.5rem" }}>Last updated: May 2026</p>

        {section(1, "Introduction",
          `Marathon Club ("we", "our", "us") is committed to protecting your privacy. This policy explains how we collect and use your information.`)}
        {section(2, "Information We Collect",
          "We collect your name and phone number when you place an order at our store. This information is provided by our store staff on your behalf.")}
        {section(3, "How We Use Your Information",
          "We use your phone number to send you WhatsApp notifications about your order status, including when your order is placed, ready for collection, out of stock, or available the next day.")}
        {section(4, "Data Storage",
          "Your order information is stored securely in Google Firebase. We retain order data for operational and business analytics purposes.")}
        {section(5, "WhatsApp Messages",
          "By placing an order at Marathon Club, you consent to receiving WhatsApp notifications about your order. Messages are sent via the Meta WhatsApp Business API.")}
        {section(6, "Your Rights",
          <>You may contact us at any time to request removal of your data by contacting us at{" "}
            <a href="mailto:distreda@gmail.com" style={{ color: "#FF3D00", textDecoration: "none" }}>distreda@gmail.com</a>.
          </>)}
        {section(7, "Contact",
          <>For any privacy-related questions, contact us at{" "}
            <a href="mailto:distreda@gmail.com" style={{ color: "#FF3D00", textDecoration: "none" }}>distreda@gmail.com</a>
            {" "}or visit us at Marathon Club, Durban, South Africa.
          </>)}
      </div>

      {/* Footer */}
      <div style={{ borderTop: "1px solid #e5e7eb", padding: "1.25rem 1.5rem", textAlign: "center" }}>
        <span style={{ color: "#9ca3af", fontSize: "0.8rem" }}>© {new Date().getFullYear()} Marathon Club. All rights reserved.</span>
      </div>
    </div>
  );
}

// ─── PWA: update banner + install prompts ────────────────────────────────────
// Listens for the custom events main.jsx dispatches on SW updates and the
// Android beforeinstallprompt capture. iOS prompt is detection-based.
function PWAUpdateBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onUpdate = () => setShow(true);
    window.addEventListener("pwa-update-available", onUpdate);
    return () => window.removeEventListener("pwa-update-available", onUpdate);
  }, []);
  if (!show) return null;
  const reload = () => {
    const w = window.__pwaWaiting;
    if (w) w.postMessage("skipWaiting"); // controllerchange in main.jsx triggers reload
    else window.location.reload();
  };
  return (
    <div onClick={reload} role="button"
         style={{ position:"fixed", top:0, left:0, right:0, zIndex:10000, background:"#4A7FFF", color:"#fff",
                  fontFamily:"-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif", fontSize:13, fontWeight:600,
                  padding:"10px 14px", display:"flex", alignItems:"center", justifyContent:"center", gap:8,
                  cursor:"pointer", boxShadow:"0 2px 12px rgba(0,0,0,.4)" }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
      </svg>
      <span style={{ flex:1, textAlign:"center" }}>Update available — tap to refresh.</span>
      <span onClick={(e) => { e.stopPropagation(); setShow(false); }}
            style={{ padding:"0 6px", fontSize:18, lineHeight:1, opacity:0.85 }}>×</span>
    </div>
  );
}

function AndroidInstallChip() {
  const DISMISS_KEY = "pwa.installPrompt.dismissed";
  const [available, setAvailable] = useState(!!window.__pwaInstallPrompt);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  useEffect(() => {
    const on = () => setAvailable(true);
    window.addEventListener("pwa-install-available", on);
    return () => window.removeEventListener("pwa-install-available", on);
  }, []);
  if (!available || dismissed) return null;
  const install = async () => {
    const e = window.__pwaInstallPrompt;
    if (!e) return;
    e.prompt();
    await e.userChoice.catch(() => {});
    window.__pwaInstallPrompt = null;
    setAvailable(false);
  };
  const dismiss = () => { localStorage.setItem(DISMISS_KEY, "1"); setDismissed(true); };
  return (
    <div style={{ position:"fixed", top:10, right:10, zIndex:9999, display:"flex", alignItems:"center", gap:6,
                  background:"rgba(60,110,255,.15)", border:"1px solid rgba(60,110,255,.5)", borderRadius:999,
                  padding:"6px 10px", backdropFilter:"blur(8px)" }}>
      <button onClick={install}
              style={{ background:"none", border:"none", color:"#4A7FFF", fontSize:12, fontWeight:700, cursor:"pointer", padding:0, display:"flex", alignItems:"center", gap:5 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Install Marathon
      </button>
      <span onClick={dismiss} style={{ color:"rgba(255,255,255,.5)", fontSize:14, cursor:"pointer", lineHeight:1, padding:"0 2px" }}>×</span>
    </div>
  );
}

function IOSInstallTooltip() {
  const DISMISS_KEY = "pwa.iosTooltip.dismissed";
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === "1") return;
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
    const isStandalone = window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (isIOS && isSafari && !isStandalone) setShow(true);
  }, []);
  if (!show) return null;
  const dismiss = () => { localStorage.setItem(DISMISS_KEY, "1"); setShow(false); };
  return (
    <div style={{ position:"fixed", left:10, right:10, bottom:14, zIndex:9999,
                  background:"rgba(4,5,10,.95)", border:"1px solid rgba(60,110,255,.5)", borderRadius:14,
                  padding:"12px 14px", display:"flex", alignItems:"center", gap:10,
                  boxShadow:"0 4px 24px rgba(0,0,0,.6)", backdropFilter:"blur(8px)",
                  fontFamily:"-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4A7FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
        <path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
      </svg>
      <div style={{ flex:1, color:"#fff", fontSize:12, lineHeight:1.4 }}>
        Tap the share icon, then <strong style={{ color:"#4A7FFF" }}>Add to Home Screen</strong> to install Marathon.
      </div>
      <span onClick={dismiss} style={{ color:"rgba(255,255,255,.5)", fontSize:18, cursor:"pointer", lineHeight:1, padding:"0 4px" }}>×</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Group Broadcast (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────
// Admin-only screen for sending caption + media broadcasts to selected
// WhatsApp groups via the broadcast service VM. Access is gated in
// RoleSelector (the card only renders when isAdmin === true) and in the
// App view cascade (BROADCAST_GROUPS branch checks isAdmin).
//
// Flow:
//   1. Fetch groups on mount via getBroadcastGroups Cloud Function (us-central1).
//   2. Multi-select groups, write caption, optionally attach up to 5 media
//      (uploaded in parallel via uploadBroadcastMedia → Firebase Storage).
//   3. Send button opens a confirmation modal showing recipient count.
//   4. On confirm, calls sendBroadcast Cloud Function → on success, pushes
//      history record to /broadcastHistory and resets the form.
//   5. Recent Broadcasts section reads /broadcastHistory (top 10).

const MAX_PHOTOS = 50;
const MAX_VIDEOS = 50;

function BroadcastGroupsView({ authUser, onExit }) {
  const [groups,      setGroups]      = useState(null);     // null = loading
  const [loadError,   setLoadError]   = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [caption,     setCaption]     = useState("");
  const [media,       setMedia]       = useState([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [sending,     setSending]     = useState(false);
  const [sendError,   setSendError]   = useState(null);
  const [sendSuccess, setSendSuccess] = useState(null);
  const fileInputRef = useRef(null);
  const history      = useGroupBroadcastHistory();

  async function fetchGroups() {
    setGroups(null);
    setLoadError(null);
    try {
      const callable = httpsCallable(functionsUS, "getBroadcastGroups");
      const result   = await callable({});
      const list     = result.data?.groups || [];
      list.sort((a, b) => {
        if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
      setGroups(list);
    } catch (err) {
      console.error("getBroadcastGroups failed:", err);
      setLoadError(err.message || "Failed to load groups.");
      setGroups([]);
    }
  }
  useEffect(() => { fetchGroups(); }, []);

  const selectedGroups = useMemo(
    () => (groups || []).filter(g => selectedIds.has(g.id)),
    [groups, selectedIds]
  );
  const totalRecipients = useMemo(
    () => selectedGroups.reduce((sum, g) => sum + (g.participantCount || 0), 0),
    [selectedGroups]
  );

  const photoCount = media.filter(m => m.kind === "image").length;
  const videoCount = media.filter(m => m.kind === "video").length;

  const hasGroups       = selectedIds.size > 0;
  const hasCaption      = caption.trim().length > 0;
  const hasDoneMedia    = media.some(m => m.status === "done");
  const anyMediaPending = media.some(m => m.status === "uploading");
  const canSend         = hasGroups && (hasCaption || hasDoneMedia) && !anyMediaPending && !sending;

  function toggleGroup(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleAddMedia(e) {
    const files = Array.from(e.target.files || []);
    if (e.target) e.target.value = "";
    let photosRoom = MAX_PHOTOS - photoCount;
    let videosRoom = MAX_VIDEOS - videoCount;
    const items = [];
    for (const file of files) {
      const kind = file.type.startsWith("video") ? "video" : "image";
      if (kind === "image" && photosRoom > 0) {
        items.push({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), kind, name: file.name, status: "uploading" });
        photosRoom--;
      } else if (kind === "video" && videosRoom > 0) {
        items.push({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), kind, name: file.name, status: "uploading" });
        videosRoom--;
      }
      // Files past their per-type limit are silently dropped — counts are visible in the UI so the user can see why.
    }
    if (items.length === 0) return;
    setMedia(prev => [...prev, ...items]);
    items.forEach(item => {
      uploadBroadcastMedia(item.file)
        .then(({ url, path }) => {
          setMedia(prev => prev.map(m => m.id === item.id ? { ...m, status:"done", url, path } : m));
        })
        .catch(err => {
          console.error("Broadcast media upload failed:", item.file?.name, "| type:", item.file?.type || "(empty)", "| size:", item.file?.size, "| err:", err);
          setMedia(prev => prev.map(m => m.id === item.id ? { ...m, status:"error", error: err.message || String(err) } : m));
        });
    });
  }

  function removeMedia(id) {
    setMedia(prev => {
      const item = prev.find(m => m.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter(m => m.id !== id);
    });
  }

  async function handleConfirmSend() {
    setSending(true);
    setSendError(null);
    setSendSuccess(null);
    const t0 = performance.now();
    try {
      const mediaUrls = media.filter(m => m.status === "done").map(m => m.url);
      const groupIds  = [...selectedIds];
      const callable  = httpsCallable(functionsUS, "sendBroadcast");
      const result    = await callable({ groupIds, caption: caption.trim(), mediaUrls });
      const durationMs  = Math.round(performance.now() - t0);
      const broadcastId = result.data?.broadcastId ?? null;

      push(ref(database, "broadcastHistory"), {
        timestamp:       new Date().toISOString(),
        userEmail:       authUser?.email || null,
        groupCount:      groupIds.length,
        totalRecipients,
        captionPreview:  caption.trim().slice(0, 80),
        mediaCount:      mediaUrls.length,
        status:          "ok",
        broadcastId,
        durationMs,
      }).catch(err => console.warn("Failed to save broadcast history:", err));

      setSendSuccess({ broadcastId, durationMs });
      media.forEach(m => m.previewUrl && URL.revokeObjectURL(m.previewUrl));
      setSelectedIds(new Set());
      setCaption("");
      setMedia([]);
    } catch (err) {
      console.error("sendBroadcast failed:", err);
      setSendError(err.message || "Send failed.");
    } finally {
      setSending(false);
    }
  }

  function closeModal() {
    if (sending) return;
    setShowConfirm(false);
    setSendError(null);
    setSendSuccess(null);
  }

  return (
    <div style={{ minHeight:"100vh", background:BG, color:"#fff", fontFamily:FONT, paddingBottom:"3rem" }}>
      <BroadcastTopBar onExit={onExit} onRefresh={fetchGroups} refreshing={groups === null} />

      <div style={{ maxWidth:430, margin:"0 auto", padding:"1rem", display:"flex", flexDirection:"column", gap:"1rem" }}>

        <BroadcastSection title="Groups" trailing={hasGroups ? `${selectedIds.size} selected` : null}>
          {groups === null && !loadError && <div style={{ color:"#555", fontSize:"0.85rem", padding:"0.5rem 0" }}>Loading groups…</div>}
          {loadError && <BroadcastErrorBlock onRetry={fetchGroups}>{loadError}</BroadcastErrorBlock>}
          {groups && groups.length === 0 && !loadError && (
            <div style={{ color:"#666", fontSize:"0.85rem", padding:"0.5rem 0" }}>No groups returned by the broadcast service.</div>
          )}
          {groups && groups.map(g => (
            <BroadcastGroupRow key={g.id} group={g} selected={selectedIds.has(g.id)} onToggle={() => toggleGroup(g.id)} />
          ))}
        </BroadcastSection>

        <BroadcastSection title="Caption" trailing={`${caption.length}/1024`}>
          <textarea
            value={caption}
            onChange={e => setCaption(e.target.value.slice(0, 1024))}
            placeholder="Write your broadcast message…"
            rows={4}
            style={{ width:"100%", background:"transparent", color:"#fff", border:"none", outline:"none", padding:"0.25rem 0", fontSize:"0.95rem", fontFamily:FONT, resize:"vertical" }}
          />
        </BroadcastSection>

        <BroadcastSection
          title="Media"
          trailing={(photoCount < MAX_PHOTOS || videoCount < MAX_VIDEOS) ? (
            <button onClick={() => fileInputRef.current?.click()} style={{ ...bBlue, padding:"0.35rem 0.75rem" }}>+ Add</button>
          ) : null}
        >
          <input ref={fileInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/3gpp,video/webm,.jpg,.jpeg,.png,.webp,.mp4,.mov,.3gp,.webm" onChange={handleAddMedia} style={{ display:"none" }} />
          <div style={{ fontSize:"0.75rem", color:"#9CA3AF", marginBottom: media.length > 0 ? "0.55rem" : "0.4rem" }}>
            Photos: <span style={{ color: photoCount >= MAX_PHOTOS ? "#F87171" : "#fff", fontWeight:600 }}>{photoCount}/{MAX_PHOTOS}</span>
            <span style={{ color:"#444", padding:"0 8px" }}>·</span>
            Videos: <span style={{ color: videoCount >= MAX_VIDEOS ? "#F87171" : "#fff", fontWeight:600 }}>{videoCount}/{MAX_VIDEOS}</span>
          </div>
          {media.length === 0 && (
            <div style={{ color:"#666", fontSize:"0.85rem" }}>Optional. Up to {MAX_PHOTOS} photos (JPG/PNG/WEBP, 16 MB each) and {MAX_VIDEOS} videos (MP4/MOV, 200 MB each).</div>
          )}
          {media.length > 0 && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:"0.5rem" }}>
              {media.map(m => <BroadcastMediaThumb key={m.id} item={m} onRemove={() => removeMedia(m.id)} />)}
            </div>
          )}
        </BroadcastSection>

        {(hasGroups || hasCaption || hasDoneMedia) && (
          <BroadcastSection>
            <div style={{ color:"#9CA3AF", fontSize:"0.85rem", marginBottom:"0.75rem", lineHeight:1.4 }}>
              {hasGroups
                ? <>Sending to <span style={{ color:BLUE_L, fontWeight:600 }}>{selectedIds.size}</span> group{selectedIds.size === 1 ? "" : "s"} · ~<span style={{ color:BLUE_L, fontWeight:600 }}>{totalRecipients.toLocaleString()}</span> recipient{totalRecipients === 1 ? "" : "s"}</>
                : "Select at least one group to send."}
            </div>
            <button
              onClick={() => setShowConfirm(true)}
              disabled={!canSend}
              style={{
                width:"100%", padding:"0.9rem",
                background: canSend ? BLUE : "rgba(60,110,255,.15)",
                color: canSend ? "#fff" : "rgba(255,255,255,.4)",
                border:"none", borderRadius:RADIUS, fontSize:"1rem", fontWeight:600,
                cursor: canSend ? "pointer" : "default",
              }}>
              {anyMediaPending ? "Uploading media…" : "Send Broadcast"}
            </button>
          </BroadcastSection>
        )}

        <BroadcastSection title="Recent Broadcasts">
          {history.length === 0 && <div style={{ color:"#666", fontSize:"0.85rem" }}>No broadcasts yet.</div>}
          {history.map(item => <BroadcastHistoryRow key={item.id} item={item} />)}
        </BroadcastSection>
      </div>

      {showConfirm && (
        <BroadcastConfirmModal
          selectedGroups={selectedGroups}
          totalRecipients={totalRecipients}
          caption={caption.trim()}
          donePhotoCount={media.filter(m => m.status === "done" && m.kind === "image").length}
          doneVideoCount={media.filter(m => m.status === "done" && m.kind === "video").length}
          sending={sending}
          sendError={sendError}
          sendSuccess={sendSuccess}
          onCancel={closeModal}
          onConfirm={handleConfirmSend}
        />
      )}
    </div>
  );
}

function BroadcastTopBar({ onExit, onRefresh, refreshing }) {
  return (
    <div style={{ position:"sticky", top:0, zIndex:10, background:"rgba(0,0,0,.85)", backdropFilter:"blur(10px)", borderBottom:BORDER, padding:"0.75rem 1rem", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
      <button onClick={onExit} style={{ background:"transparent", border:"none", color:BLUE, cursor:"pointer", fontSize:"0.9rem", fontWeight:600, padding:"4px 8px", display:"flex", alignItems:"center", gap:6 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Exit
      </button>
      <div style={{ fontSize:"0.95rem", fontWeight:600, color:"#fff" }}>Group Broadcast</div>
      <button onClick={onRefresh} disabled={refreshing} style={{ background:"transparent", border:"none", color:BLUE, cursor: refreshing ? "default" : "pointer", padding:"4px 8px", opacity: refreshing ? 0.4 : 1 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: refreshing ? "bcastSpin 1s linear infinite" : "none" }}>
          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
        </svg>
      </button>
    </div>
  );
}

function BroadcastSection({ title, trailing, children }) {
  return (
    <div style={{ background:CARD, border:BORDER, borderRadius:RADIUS, padding:"0.9rem", boxShadow:GLOW }}>
      {title && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"0.6rem", gap:8 }}>
          <div style={{ fontSize:"0.7rem", fontWeight:800, color:BLUE, letterSpacing:"2px", textTransform:"uppercase" }}>{title}</div>
          {trailing != null && <div style={{ fontSize:"0.75rem", color:"#666" }}>{trailing}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

function BroadcastErrorBlock({ children, onRetry }) {
  return (
    <div style={{ background:"rgba(248,113,113,.08)", border:"1px solid rgba(248,113,113,.3)", borderRadius:10, padding:"0.7rem", color:"#F87171", fontSize:"0.85rem", display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
      <div>{children}</div>
      {onRetry && (
        <button onClick={onRetry} style={{ background:"transparent", border:"1px solid rgba(248,113,113,.3)", color:"#F87171", borderRadius:10, padding:"0.35rem 0.75rem", fontWeight:600, fontSize:"0.8rem", cursor:"pointer" }}>Retry</button>
      )}
    </div>
  );
}

function BroadcastGroupRow({ group, selected, onToggle }) {
  return (
    <div onClick={onToggle} style={{ display:"flex", alignItems:"center", gap:10, padding:"0.6rem 0", borderBottom:"1px solid rgba(255,255,255,.04)", cursor:"pointer" }}>
      <div style={{ width:22, height:22, borderRadius:6, background: selected ? BLUE : "transparent", border: selected ? `1px solid ${BLUE}` : "1px solid rgba(255,255,255,.18)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
        {selected && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:"0.9rem", color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{group.name || group.id}</div>
        <div style={{ fontSize:"0.75rem", color:"#666", display:"flex", alignItems:"center", gap:6, marginTop:2 }}>
          <span>{(group.participantCount || 0).toLocaleString()} {group.participantCount === 1 ? "person" : "people"}</span>
          {group.isAdmin && <span style={{ background:"rgba(60,110,255,.15)", color:BLUE_L, padding:"1px 7px", borderRadius:999, fontSize:"0.7rem", fontWeight:600 }}>admin</span>}
        </div>
      </div>
    </div>
  );
}

function BroadcastMediaThumb({ item, onRemove }) {
  return (
    <div style={{ position:"relative", width:72, height:72, borderRadius:10, overflow:"hidden", background:"rgba(255,255,255,.05)", border:BORDER, flexShrink:0 }}>
      {item.kind === "image"
        ? <img src={item.previewUrl} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} />
        : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          </div>}
      {item.status === "uploading" && (
        <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,.55)", display:"flex", alignItems:"center", justifyContent:"center", color:BLUE_L, fontSize:"0.7rem", fontWeight:600 }}>Uploading…</div>
      )}
      {item.status === "error" && (
        <div
          onClick={() => item.error && alert(item.error)}
          title={item.error || ""}
          style={{ position:"absolute", inset:0, background:"rgba(150,20,20,.7)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#fff", textAlign:"center", padding:4, cursor: item.error ? "pointer" : "default" }}>
          <div style={{ fontSize:"0.7rem", fontWeight:600 }}>Failed</div>
          {item.error && (
            <div style={{ fontSize:"0.55rem", marginTop:2, opacity:0.9, lineHeight:1.15, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden", padding:"0 2px" }}>
              {item.error}
            </div>
          )}
        </div>
      )}
      <button onClick={onRemove} style={{ position:"absolute", top:3, right:3, width:20, height:20, borderRadius:999, background:"rgba(0,0,0,.7)", border:"none", color:"#fff", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", padding:0 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  );
}

function BroadcastHistoryRow({ item }) {
  const when = item.timestamp ? new Date(item.timestamp) : null;
  const rel  = when ? bcastRelTime(when) : "";
  const errored = item.status && item.status !== "ok";
  return (
    <div style={{ padding:"0.6rem 0", borderBottom:"1px solid rgba(255,255,255,.04)" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
        <div style={{ fontSize:"0.8rem", color:"#888" }}>{rel}</div>
        {errored && <span style={{ color:"#F87171", fontSize:"0.7rem", fontWeight:600 }}>FAILED</span>}
      </div>
      <div style={{ fontSize:"0.78rem", color:"#9CA3AF", marginTop:2 }}>
        {(item.groupCount || 0)} group{item.groupCount === 1 ? "" : "s"} · ~{(item.totalRecipients || 0).toLocaleString()} recipient{item.totalRecipients === 1 ? "" : "s"} · {(item.mediaCount || 0)} media
      </div>
      {item.captionPreview && (
        <div style={{ fontSize:"0.82rem", color:"#fff", marginTop:4, fontStyle:"italic" }}>"{item.captionPreview}"</div>
      )}
    </div>
  );
}

function bcastRelTime(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)     return "just now";
  if (diff < 3600)   { const m = Math.floor(diff / 60);    return `${m} min${m === 1 ? "" : "s"} ago`; }
  if (diff < 86400)  { const h = Math.floor(diff / 3600);  return `${h} hr${h === 1 ? "" : "s"} ago`; }
  if (diff < 604800) { const d = Math.floor(diff / 86400); return `${d} day${d === 1 ? "" : "s"} ago`; }
  return date.toLocaleDateString();
}

function BroadcastConfirmModal({ selectedGroups, totalRecipients, caption, donePhotoCount, doneVideoCount, sending, sendError, sendSuccess, onCancel, onConfirm }) {
  const success = !!sendSuccess;
  return (
    <div style={{ position:"fixed", inset:0, zIndex:10000, background:"rgba(0,0,0,.7)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", padding:"1rem" }}>
      <div style={{ width:"100%", maxWidth:400, background:CARD, border:BORDER_BRIGHT, borderRadius:RADIUS, padding:"1.25rem", boxShadow:GLOW, fontFamily:FONT }}>
        <h2 style={{ margin:0, fontSize:"1.1rem", color:"#fff", fontWeight:600 }}>
          {success ? "Broadcast sent" : "Confirm broadcast"}
        </h2>

        {!success && (
          <>
            <div style={{ marginTop:"0.85rem", fontSize:"0.85rem", color:"#9CA3AF", lineHeight:1.4 }}>
              Sending to <span style={{ color:BLUE_L, fontWeight:600 }}>{selectedGroups.length}</span> group{selectedGroups.length === 1 ? "" : "s"}, ~<span style={{ color:BLUE_L, fontWeight:600 }}>{totalRecipients.toLocaleString()}</span> recipient{totalRecipients === 1 ? "" : "s"}:
            </div>
            <ul style={{ margin:"0.5rem 0 0", padding:"0 0 0 1rem", color:"#bbb", fontSize:"0.82rem", maxHeight:150, overflowY:"auto" }}>
              {selectedGroups.map(g => (
                <li key={g.id}>{g.name || g.id} ({(g.participantCount || 0).toLocaleString()})</li>
              ))}
            </ul>

            {caption && (
              <div style={{ marginTop:"0.85rem" }}>
                <div style={{ fontSize:"0.7rem", color:"#666", letterSpacing:"1.5px", textTransform:"uppercase", fontWeight:600 }}>Caption</div>
                <div style={{ marginTop:4, fontSize:"0.85rem", color:"#ddd", lineHeight:1.4, maxHeight:120, overflow:"auto", whiteSpace:"pre-wrap" }}>{caption}</div>
              </div>
            )}

            {(donePhotoCount > 0 || doneVideoCount > 0) && (
              <div style={{ marginTop:"0.6rem", fontSize:"0.8rem", color:"#9CA3AF" }}>
                Media: {donePhotoCount} photo{donePhotoCount === 1 ? "" : "s"}, {doneVideoCount} video{doneVideoCount === 1 ? "" : "s"}
              </div>
            )}

            {sendError && (
              <div style={{ marginTop:"0.85rem", color:"#F87171", fontSize:"0.85rem", background:"rgba(248,113,113,.08)", border:"1px solid rgba(248,113,113,.3)", borderRadius:10, padding:"0.6rem" }}>
                {sendError}
              </div>
            )}

            <div style={{ marginTop:"1rem", display:"flex", gap:"0.6rem" }}>
              <button onClick={onCancel} disabled={sending} style={{ flex:1, padding:"0.7rem", background:"transparent", border:"1px solid rgba(255,255,255,.18)", color:"#9CA3AF", borderRadius:RADIUS, fontSize:"0.9rem", fontWeight:600, cursor: sending ? "default" : "pointer", opacity: sending ? 0.5 : 1 }}>
                Cancel
              </button>
              <button onClick={onConfirm} disabled={sending} style={{ flex:1.4, padding:"0.7rem", background: sending ? "rgba(60,110,255,.4)" : BLUE, border:"none", color:"#fff", borderRadius:RADIUS, fontSize:"0.9rem", fontWeight:600, cursor: sending ? "default" : "pointer" }}>
                {sending ? "Sending…" : (sendError ? "Retry" : "Confirm & Send")}
              </button>
            </div>
          </>
        )}

        {success && (
          <>
            <div style={{ marginTop:"0.85rem", color:"#4ADE80", fontSize:"0.9rem" }}>
              Broadcast queued successfully.
            </div>
            <div style={{ marginTop:"0.6rem", fontSize:"0.78rem", color:"#666", lineHeight:1.5 }}>
              {sendSuccess.broadcastId && <div>Broadcast ID: <code style={{ color:"#9CA3AF" }}>{sendSuccess.broadcastId}</code></div>}
              {sendSuccess.durationMs != null && <div>Took {(sendSuccess.durationMs / 1000).toFixed(1)} s</div>}
            </div>
            <button onClick={onCancel} style={{ marginTop:"1rem", width:"100%", padding:"0.7rem", background:BLUE, border:"none", color:"#fff", borderRadius:RADIUS, fontSize:"0.9rem", fontWeight:600, cursor:"pointer" }}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// One-time global keyframe for the refresh-icon spin animation.
if (typeof document !== "undefined" && !document.getElementById("__bcast_spin")) {
  const s = document.createElement("style");
  s.id = "__bcast_spin";
  s.textContent = "@keyframes bcastSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}";
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Google Sign-In (Phase 1.5)
// ─────────────────────────────────────────────────────────────────────────────
// Triggered by visiting the site with #admin in the URL, e.g.
//   https://marathon-club.web.app/#admin
// Sign-in opens a Google popup. Only ADMIN_EMAIL is allowed; any other Google
// account is signed out immediately and an error is shown.
//
// While admin is signed in:
//   • A small pill (top-right) shows "Signed in: gunid · Sign Out".
//   • All other views render normally.
//   • request.auth.token.email === ADMIN_EMAIL → broadcast Cloud Functions
//     and broadcast-media writes are allowed.
//
// Sign-out drops back to anonymous (not fully out) so the database keeps
// working for the next visitor on the device.

const ADMIN_EMAIL = "gunidmoh@gmail.com";

function AdminSignInScreen({ onCancel }) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState(null);

  async function handleSignIn() {
    setBusy(true); setError(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (result.user.email !== ADMIN_EMAIL) {
        const wrong = result.user.email;
        await signOut(auth); // existing onAuthStateChanged effect re-signs anonymously
        setError(`Wrong account: ${wrong}. Sign in with ${ADMIN_EMAIL}.`);
        return;
      }
      window.location.hash = ""; // success → parent unmounts this screen
    } catch (err) {
      if (err.code === "auth/popup-closed-by-user") return;
      if (err.code === "auth/operation-not-allowed") {
        setError("Google Sign-In is not enabled in Firebase Console.");
        return;
      }
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight:"100vh", background:BG, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:FONT, padding:"1rem" }}>
      <div style={{ width:"100%", maxWidth:380, background:CARD, border:BORDER, borderRadius:RADIUS, padding:"2rem 1.5rem", boxShadow:GLOW }}>
        <h1 style={{ margin:0, fontSize:"1.5rem", color:"#fff", fontWeight:600 }}>Admin Sign In</h1>
        <p style={{ marginTop:"0.5rem", marginBottom:"1.5rem", color:"#888", fontSize:"0.875rem", lineHeight:1.5 }}>
          Use the <span style={{ color:BLUE_L }}>{ADMIN_EMAIL}</span> Google account.
        </p>
        <button
          onClick={handleSignIn}
          disabled={busy}
          style={{ width:"100%", padding:"0.875rem", background:BLUE, color:"#fff", border:"none", borderRadius:"10px", fontSize:"1rem", fontWeight:600, cursor:busy ? "default" : "pointer", opacity:busy ? 0.6 : 1 }}>
          {busy ? "Signing in…" : "Sign in with Google"}
        </button>
        {error && (
          <div style={{ marginTop:"1rem", color:"#F87171", fontSize:"0.875rem", lineHeight:1.4 }}>{error}</div>
        )}
        <div style={{ marginTop:"1.5rem", textAlign:"center" }}>
          <span onClick={onCancel} style={{ color:"#666", fontSize:"0.85rem", cursor:"pointer" }}>Cancel</span>
        </div>
      </div>
    </div>
  );
}

// Top-right pill shown for any signed-in non-anonymous user (super-admin via
// Google OR a staff PIN account). Tap "Sign Out" to return to the Login screen.
function UserIndicator({ label, onSignOut }) {
  return (
    <div style={{ position:"fixed", top:10, right:10, zIndex:9998, background:CARD, border:BORDER_BRIGHT, borderRadius:999, padding:"6px 12px", display:"flex", alignItems:"center", gap:8, fontFamily:FONT, fontSize:"0.75rem", boxShadow:GLOW, backdropFilter:"blur(8px)" }}>
      <span style={{ color:"#9CA3AF" }}>Signed in: <span style={{ color:BLUE_L, fontWeight:600 }}>{label}</span></span>
      <span style={{ color:"#444" }}>·</span>
      <span onClick={onSignOut} style={{ color:BLUE, cursor:"pointer", fontWeight:600 }}>Sign Out</span>
    </div>
  );
}

// ─── APP INNER ────────────────────────────────────────────────────────────────
// The post-AuthGate shell. Auth state + permissions arrive via the
// PermissionsContext provided by <AuthGate>; we no longer manage anon sign-in
// here (AuthGate handles the #tv anon path; everything else requires real
// login). Junid's #admin Google popup path still works for super-admin —
// the wantAdmin/AdminSignInScreen render happens when an unauthenticated
// session navigates to #admin, *before* AuthGate has provided context
// (which means this branch only ever fires when isSuperAdmin === false from
// AuthGate's perspective, e.g. signed out from the Google session).
function AppInner() {
  const { user: authUser, permRecord, isSuperAdmin, hasPermission, signOut: doSignOut } = usePermissions();
  // Stock access is gated by stockRole, NOT an app permission, so warehouse seed
  // counters keep it. canMint = may create NEW barcodes (writes /barcodes — any
  // stockRole); everyone else can still reprint EXISTING codes (read-only).
  const stockRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  // UI access = a stock PERMISSION (granted in User Management) OR a stock-capable
  // stockRole (so seed counters with stockRole=warehouse keep access without a
  // permission). Actual WRITES are still gated by stockRole in the RTDB rules.
  const canAccessStock = stockRole === "admin" || stockRole === "warehouse" || hasPermission("stock_management");
  const canMint = isSuperAdmin || !!permRecord?.stockRole || hasPermission("barcode");

  // hash tracks the URL fragment for the #admin sign-in trigger and any
  // future client-side routing.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const wantAdmin = hash === "#admin";
  // /#admin/users (list) and /#admin/users/<uid> (detail) both mount the
  // UserManagement view. The component itself gates non-super-admin viewers
  // with a NotAuthorized screen — see src/components/UserManagement.jsx.
  const wantUserMgmt = hash === "#admin/users" || hash === "#admin/users/" || hash.startsWith("#admin/users/");
  // Legacy isAdmin alias — true for super-admin only. Some downstream views
  // (e.g. BroadcastGroupsView role check) still read this; the right gate is
  // hasPermission("broadcast"), but we keep isAdmin for back-compat.
  const isAdmin = isSuperAdmin;

  async function handleAdminSignOut() {
    await doSignOut();
    if (window.location.hash === "#admin") window.location.hash = "";
  }

  const [role, setRole] = useState(() => localStorage.getItem("marathon_role") || null);
  useEffect(() => {
    if (role) localStorage.setItem("marathon_role", role);
    else localStorage.removeItem("marathon_role");
  }, [role]);

  // Safety: if the persisted role isn't available to this user's permission
  // set (signed out, switched account, permissions revoked), drop them back
  // to RoleSelector. Prevents a blank screen and avoids exposing a view the
  // user shouldn't see.
  useEffect(() => {
    if (!role) return;
    // Stock is stockRole-gated (not permission-mapped) — drop non-stock users back home.
    if (role === ROLES.STOCK && !canAccessStock) { setRole(null); return; }
    const required = ROLE_TO_PERMISSION[role];
    if (required && !hasPermission(required)) setRole(null);
  }, [role, hasPermission, canAccessStock]);

  const products = useProducts();
  // Orders use the per-id map; mutations bypass setOrders entirely and write
  // straight to /orders/{id} via writeOrder() / updateOrder().
  const orders = useOrders();
  const returnsLog = useReturnsLog();

  // ── ORDER AUDIT — runs on every render; logs only when numbers mismatch ────
  // Run window.__orderAudit() in the console for the full report.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const today = getSADateString();
    const KNOWN = new Set(["ready","collected","out_of_stock","tomorrow","on_hold","incoming","coming_tomorrow"]);

    const onTodayCreated  = orders.filter(o => o.createdAt && o.createdAt.slice(0,10) === today);
    const onTodayTouched  = orders.filter(o => {
      const ts = o.createdAt || o.updatedAt || o.readyAt || o.collectedAt;
      return ts && ts.slice(0,10) === today;
    });

    window.__orderAudit = () => {
      console.log("══════════════════════════════════════════════════════════════════");
      console.log("ORDER AUDIT — today =", today);
      console.log("══════════════════════════════════════════════════════════════════");

      console.log("Total orders in Firebase:", orders.length);
      console.log("Created today (createdAt):", onTodayCreated.length);
      console.log("Touched today (any timestamp):", onTodayTouched.length);

      // Status distribution across ALL orders + today only
      const byStatusAll = {};
      const byStatusToday = {};
      orders.forEach(o => {
        const s = o.status === undefined ? "(undefined)" : (o.status || "(empty)");
        byStatusAll[s] = (byStatusAll[s] || 0) + 1;
      });
      onTodayCreated.forEach(o => {
        const s = o.status === undefined ? "(undefined)" : (o.status || "(empty)");
        byStatusToday[s] = (byStatusToday[s] || 0) + 1;
      });
      console.log("Status distribution (all orders):", byStatusAll);
      console.log("Status distribution (today only):", byStatusToday);

      // Order number gaps
      const todayNums = onTodayCreated
        .map(o => parseInt(String(o.id).replace(/[^0-9]/g, ""), 10))
        .filter(n => !isNaN(n));
      const minNum = todayNums.length ? Math.min(...todayNums) : null;
      const maxNum = todayNums.length ? Math.max(...todayNums) : null;
      const present = new Set(todayNums);
      const gaps = [];
      if (minNum !== null && maxNum !== null) {
        for (let i = minNum; i <= maxNum; i++) {
          if (!present.has(i)) gaps.push(i);
        }
      }
      console.log("Order number range today:", minNum, "→", maxNum, "(span:", maxNum - minNum + 1, ")");
      console.log("MISSING order numbers in range:", gaps.length, gaps);
      // Duplicates
      const dupCount = {};
      todayNums.forEach(n => dupCount[n] = (dupCount[n] || 0) + 1);
      const dups = Object.entries(dupCount).filter(([, c]) => c > 1);
      console.log("DUPLICATE order numbers today:", dups.length, dups);

      // Orders with no/empty/unknown status
      const ordersNoStatus = onTodayCreated.filter(o => !o.status || String(o.status).trim() === "");
      const ordersUnknownStatus = onTodayCreated.filter(o => o.status && !KNOWN.has(o.status));
      console.log("Orders today with NO status:", ordersNoStatus.length, ordersNoStatus.map(o => ({id:o.id, createdAt:o.createdAt, status:o.status})));
      console.log("Orders today with UNKNOWN/legacy status:", ordersUnknownStatus.length, ordersUnknownStatus.map(o => ({id:o.id, status:o.status, createdAt:o.createdAt})));

      // Soft-delete flags
      const softDeleted = onTodayCreated.filter(o => o.deleted === true || o.removed === true || o.archived === true);
      console.log("Orders flagged deleted/removed/archived:", softDeleted.length, softDeleted.map(o => ({id:o.id, deleted:o.deleted, removed:o.removed, archived:o.archived})));

      // Multi-timestamp anomalies
      const multiStamp = onTodayCreated.filter(o => {
        const stamps = [o.readyAt, o.outOfStockAt, o.comingTomorrowAt].filter(Boolean);
        return stamps.length > 1;
      });
      console.log("Orders with MULTIPLE status timestamps (changed mind):", multiStamp.length, multiStamp.map(o => ({id:o.id, status:o.status, readyAt:o.readyAt, outOfStockAt:o.outOfStockAt, comingTomorrowAt:o.comingTomorrowAt})));

      // Reconciliation math
      const ready     = onTodayCreated.filter(o => o.status === STATUS.READY).length;
      const collected = onTodayCreated.filter(o => o.status === STATUS.COLLECTED).length;
      const oos       = onTodayCreated.filter(o => o.status === STATUS.OUT_OF_STOCK).length;
      const tomorrow  = onTodayCreated.filter(o => o.status === STATUS.COMING_TOMORROW).length;
      const incoming  = onTodayCreated.filter(o => o.status === STATUS.INCOMING).length;
      const sum       = ready + collected + oos + tomorrow + incoming;
      const returnsToday = returnsLog.filter(r => (r.timestamp||"").slice(0,10) === today).length;
      console.log("══════════════════════════════════════════════════════════════════");
      console.log("RECONCILIATION (today, by status):");
      console.log("  READY            :", ready);
      console.log("  COLLECTED        :", collected);
      console.log("  OUT_OF_STOCK     :", oos);
      console.log("  COMING_TOMORROW  :", tomorrow);
      console.log("  INCOMING         :", incoming);
      console.log("  ─────────────────────");
      console.log("  Sum              :", sum);
      console.log("  Total today      :", onTodayCreated.length);
      console.log("  Diff (unaccounted):", onTodayCreated.length - sum);
      console.log("  Returns today    :", returnsToday);
      console.log("  Net Sales        : (ready+collected) − returns =", (ready + collected) - returnsToday);
      console.log("══════════════════════════════════════════════════════════════════");

      // Show every unaccounted-for order
      const accounted = new Set([STATUS.READY, STATUS.COLLECTED, STATUS.OUT_OF_STOCK, STATUS.COMING_TOMORROW, STATUS.INCOMING]);
      const unaccounted = onTodayCreated.filter(o => !accounted.has(o.status));
      if (unaccounted.length) {
        console.log("UNACCOUNTED-FOR ORDERS:", unaccounted.length);
        console.table(unaccounted.map(o => ({
          id: o.id,
          status: o.status === undefined ? "(undefined)" : (o.status || "(empty)"),
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
          readyAt: o.readyAt,
          collectedAt: o.collectedAt,
          outOfStockAt: o.outOfStockAt,
          comingTomorrowAt: o.comingTomorrowAt,
          deleted: o.deleted,
          customerName: o.customerName,
          productName: o.productName,
        })));
      }
      console.log("Tip: full data available as window.__orderAudit.data");
      window.__orderAudit.data = { today, orders, onTodayCreated, byStatusAll, byStatusToday, gaps, dups, ordersNoStatus, ordersUnknownStatus, softDeleted, multiStamp, unaccounted, returnsToday };
    };

    // Auto-run silent reconciliation on every render — only logs if numbers don't add up
    if (onTodayCreated.length > 0) {
      const ready     = onTodayCreated.filter(o => o.status === STATUS.READY).length;
      const collected = onTodayCreated.filter(o => o.status === STATUS.COLLECTED).length;
      const oos       = onTodayCreated.filter(o => o.status === STATUS.OUT_OF_STOCK).length;
      const tomorrow  = onTodayCreated.filter(o => o.status === STATUS.COMING_TOMORROW).length;
      const incoming  = onTodayCreated.filter(o => o.status === STATUS.INCOMING).length;
      const sum = ready + collected + oos + tomorrow + incoming;
      if (sum !== onTodayCreated.length) {
        console.warn("🚨 ORDER COUNT MISMATCH — run window.__orderAudit() for details", {
          total: onTodayCreated.length,
          sum,
          diff: onTodayCreated.length - sum,
        });
      }
    }
  }, [orders, returnsLog]);
  // ── END ORDER AUDIT ────────────────────────────────────────────────────────

  // ── Global edge-swipe-back gesture ──────────────────────────────────────────
  // Swipe right starting within 30px of the left edge → go back to role selector.
  // Attached at document level so it covers every view without modifying each one.
  const edgeSwipeStartX = useRef(null);
  useEffect(() => {
    if (!role) return; // only active when a view is showing

    const onTouchStart = (e) => {
      const x = e.touches[0].clientX;
      edgeSwipeStartX.current = x <= 30 ? x : null;
    };

    const onTouchEnd = (e) => {
      if (edgeSwipeStartX.current === null) return;
      const dx = e.changedTouches[0].clientX - edgeSwipeStartX.current;
      edgeSwipeStartX.current = null;
      if (dx > 80) {
        // Clear Insights/Customers auth so the password is required next time
        if (role === ROLES.INSIGHTS)     sessionStorage.removeItem(INSIGHTS_SESSION_KEY);
        if (role === ROLES.CUSTOMERS_DB) sessionStorage.removeItem(CUSTOMERS_SESSION_KEY);
        setRole(null);
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend",   onTouchEnd,   { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend",   onTouchEnd);
    };
  }, [role]);
  // ────────────────────────────────────────────────────────────────────────────

  // ── ALL CONDITIONAL RETURNS AFTER ALL HOOKS ─────────────────────────────────
  // (Privacy page handled by the outer App wrapper before AuthGate mounts.)

  // Helper: enforce permission on each role-keyed view. If user lacks the
  // permission (e.g. via direct hash navigation that bypassed the tile list),
  // render nothing so the role-reset effect above can drop them to the
  // selector. The UI alone is bypassable; server-side Rules (Phase 2) are
  // the real enforcement.
  const guard = (roleKey, node) => hasPermission(ROLE_TO_PERMISSION[roleKey]) ? node : null;

  let view = null;
  if (wantUserMgmt) {
    // UserManagement handles its own super-admin gate + renders NotAuthorized
    // for non-super-admin viewers. Hash-routed sub-paths (e.g. /#admin/users/<uid>)
    // are parsed inside the component, so we just mount it and let it handle the rest.
    view = <UserManagement authUser={authUser} onExit={() => (window.location.hash = "")} />;
  } else if (wantAdmin && !isSuperAdmin) {
    view = <AdminSignInScreen onCancel={() => (window.location.hash = "")} />;
  } else if (!role) {
    view = <RoleSelector onSelect={setRole} orders={orders} returnsLog={returnsLog} hasPermission={hasPermission} canAccessStock={canAccessStock} />;
  } else if (role === ROLES.INSIGHTS)     view = guard(ROLES.INSIGHTS,     <InsightsView   onExit={() => setRole(null)} />);
  else if (role === ROLES.SOURCE)         view = guard(ROLES.SOURCE,       <SourceView     orders={orders} returnsLog={returnsLog} onExit={() => setRole(null)} />);
  else if (role === ROLES.RETURNS)        view = guard(ROLES.RETURNS,      <ReturnsView    orders={orders} onExit={() => setRole(null)} />);
  else if (role === ROLES.CUSTOMERS_DB)   view = guard(ROLES.CUSTOMERS_DB, <CustomersView  onExit={() => setRole(null)} />);
  else if (role === ROLES.DISPLAY) {
    // TV mode is chrome-free, but a hidden top-right DOUBLE-tap exits back to
    // the view picker (TvDisplayMockup renders the invisible zone from onExit).
    view = guard(ROLES.DISPLAY, <TvWithAutoCollect orders={orders} onExit={() => setRole(null)} />);
  }
  else if (role === ROLES.ADMIN)     view = guard(ROLES.ADMIN,            <AdminView     products={products} orders={orders} onExit={() => setRole(null)} />);
  else if (role === ROLES.STOCK)     view = canAccessStock ? <StockView products={products} onExit={() => setRole(null)} /> : null;
  else if (role === ROLES.BARCODES)  view = <BarcodeCatalog products={products} canMint={canMint} onExit={() => setRole(null)} />;
  else if (role === ROLES.ASSISTANT) view = guard(ROLES.ASSISTANT,        <AssistantView products={products} orders={orders} onExit={() => setRole(null)} />);
  else if (role === ROLES.WAREHOUSE) view = guard(ROLES.WAREHOUSE,        <WarehouseView products={products} orders={orders} onExit={() => setRole(null)} />);
  else if (role === ROLES.CUSTOMER)  view = guard(ROLES.CUSTOMER,         <CustomerView  orders={orders} onExit={() => setRole(null)} />);
  else if (role === ROLES.BROADCAST_GROUPS) view = guard(ROLES.BROADCAST_GROUPS, <BroadcastGroupsView authUser={authUser} onExit={() => setRole(null)} />);

  // The user-indicator pill shows for any signed-in real user (PIN account
  // OR super-admin). Suppressed on the TV display so it's truly chrome-free.
  const indicatorLabel = isSuperAdmin
    ? (authUser?.email?.split("@")[0] || "Admin")
    : (permRecord?.displayName || permRecord?.username || authUser?.email?.split("@")[0] || "Staff");
  const showIndicator = authUser && !authUser.isAnonymous && role !== ROLES.DISPLAY;

  return (
    <>
      <PWAUpdateBanner />
      {!role && <AndroidInstallChip />}
      {!role && <IOSInstallTooltip />}
      {view}
      {showIndicator && <UserIndicator label={indicatorLabel} onSignOut={handleAdminSignOut} />}
    </>
  );
}

// ─── TV DISPLAY-TIDY WRAPPER ──────────────────────────────────────────────────
// Side-effects layer around <TvDisplayMockup>. This is now DISPLAY-ONLY — it
// never writes order state to RTDB. Collection is confirmed solely by a real POS
// sale (marathon-pos-app sell-by-order-number), so an order stays live in /orders
// until it's actually sold. Watches the live orders list purely to tidy the board:
// • IN-STOCK READY → display-hidden after TV_EXPIRY_MS = 8 min (NO DB write; the
//   order stays READY/live so a still-browsing customer can pay later). This used
//   to auto-flip READY→COLLECTED, which retired orders mid-visit and broke the POS
//   lookup — removed.
// • OUT-OF-STOCK → display-hidden after TV_EXPIRY_MS (stays OOS as kept demand).
// • COMING_TOMORROW → display-hidden after TV_TOMORROW_HIDE_MS = 15 min.
// All three are display-only; Ref-Sets dedupe across multiple TV screens and prune
// entries on order removal. Manual warehouse "Collected" (changeStatus) is separate
// and unchanged — a deliberate human action still collects + logs restock.
const TV_TOMORROW_HIDE_MS = 15 * 60 * 1000;

function TvWithAutoCollect({ orders, onExit }) {
  // Dedupe markers are keyed by a composite of order.id + createdAt rather
  // than id alone. order.id is daily-scoped (it's the orderNumber, which
  // resets each day — see project memory project_order_number_daily_reset),
  // so without the createdAt suffix yesterday's "001" marker would silently
  // carry over to today's brand-new "001" and either auto-collect it the
  // instant it appears or hide it forever from COMING_TOMORROW.
  const orderKey = (o) => `${o.id}:${o.createdAt || ""}`;
  const hiddenReadyRef    = useRef(new Set());  // READY rows hidden from the TV after 8 min (display-only — NO collect)
  const hiddenOosRef      = useRef(new Set());  // OOS hidden from the TV (display-only)
  const hiddenTomorrowRef = useRef(new Set());
  const [tick, setTick]   = useState(0);
  // Layby pulls for the discreet TV awareness strip (invoice numbers). Read-only.
  const laybyPulls = useLaybyPulls();

  useEffect(() => {
    const check = () => {
      const nowMs    = Date.now();
      const liveKeys = new Set(orders.map(orderKey));
      for (const k of hiddenReadyRef.current)    if (!liveKeys.has(k)) hiddenReadyRef.current.delete(k);
      for (const k of hiddenOosRef.current)      if (!liveKeys.has(k)) hiddenOosRef.current.delete(k);
      for (const k of hiddenTomorrowRef.current) if (!liveKeys.has(k)) hiddenTomorrowRef.current.delete(k);

      let changed = false;
      orders.forEach(o => {
        const key = orderKey(o);
        // IN-STOCK READY → DISPLAY-ONLY hide after 8 min (NO RTDB write). The
        // order stays READY/live in /orders so a customer who's still in-store can
        // pay later: it is now ONLY a real POS sale that marks an order collected
        // (marathon-pos-app sell-by-order-number). This used to auto-flip
        // READY→COLLECTED on the timer, which retired the order while the customer
        // was still browsing — they'd then fail the POS lookup ("no live order").
        // The timer now just tidies the board; collection = a confirmed sale.
        if (o.status === STATUS.READY && !hiddenReadyRef.current.has(key)) {
          const ts = o.readyAt || o.updatedAt;
          if (ts && nowMs - new Date(ts).getTime() >= TV_EXPIRY_MS) {
            hiddenReadyRef.current.add(key);
            changed = true;
          }
        }
        // OUT-OF-STOCK → display-only hide from the customer TV after 8 min (NO RTDB
        // write; the order stays OOS in /orders as unfulfilled-demand data).
        if (o.status === STATUS.OUT_OF_STOCK && !hiddenOosRef.current.has(key)) {
          const ts = o.outOfStockAt || o.updatedAt;
          if (ts && nowMs - new Date(ts).getTime() >= TV_EXPIRY_MS) {
            hiddenOosRef.current.add(key);
            changed = true;
          }
        }
        // Hide COMING_TOMORROW after 15 min (display-only)
        if (o.status === STATUS.COMING_TOMORROW && !hiddenTomorrowRef.current.has(key)) {
          const ts = o.comingTomorrowAt || o.updatedAt;
          if (ts && nowMs - new Date(ts).getTime() >= TV_TOMORROW_HIDE_MS) {
            hiddenTomorrowRef.current.add(key);
            changed = true;
          }
        }
      });
      if (changed) setTick(n => n + 1);
    };
    check();
    const id = setInterval(check, TV_EXPIRY_CHECK_MS);
    return () => clearInterval(id);
  }, [orders]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filteredOrders = useMemo(
    () => orders.filter(o =>
      (o.status !== STATUS.COMING_TOMORROW || !hiddenTomorrowRef.current.has(orderKey(o))) &&
      (o.status !== STATUS.OUT_OF_STOCK    || !hiddenOosRef.current.has(orderKey(o))) &&
      (o.status !== STATUS.READY           || !hiddenReadyRef.current.has(orderKey(o)))
    ),
    [orders, tick]
  );

  return <TvDisplayMockup orders={filteredOrders} laybyPulls={laybyPulls} onExit={onExit} />;
}

// ─── TV ONLY SHELL ────────────────────────────────────────────────────────────
// Mounted by AuthGate when hash === "#tv". Pulls orders via the anonymous
// auth that AuthGate kicks off; renders the bare TV display with no admin
// chrome, no role selector, no login screen.
function TvOnlyShell() {
  const orders = useOrders();
  // Hidden top-right double-tap leaves the #tv kiosk URL → back to the normal app.
  return <TvWithAutoCollect orders={orders} onExit={() => { window.location.hash = ""; }} />;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
// Default export wraps AppInner in AuthGate. The renderTv callback returns
// the TV-only shell so it never mounts on non-TV routes. Privacy page is
// the only path that bypasses both AuthGate and the rest of the shell.
export default function App() {
  if (typeof window !== "undefined" && window.location.pathname === "/privacy") {
    return <PrivacyPage />;
  }
  return (
    <AuthGate renderTv={() => <TvOnlyShell />}>
      <AppInner />
    </AuthGate>
  );
}
