// ─── DISPLAY CHECKS — AVAILABILITY TAB ───────────────────────────────────────
// "Is it in stock, and where?" — three ways in, one result. Type a name, key a
// barcode, or scan with the camera / a handheld gun; get a live size table for
// the store in view, with an "Other stores" expander.
//
// COST MODEL (per §5/§6 of the design): name + barcode search run ENTIRELY
// client-side against the products list the app already holds in memory — zero
// added reads. Live quantities are the only reads: ONE get() on
// /stock/{store}/{productId} per lookup (and one more per store when "Other
// stores" is expanded). No listeners, no writes — Availability is pure read.
//
// Store keys are the long shop ids (marathon-pe | trophy | marathon-pine); size
// keys in the stock tree are encoded (decodeSizeKey) so "5.5" → "5_5", "_" =
// one-size.

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ref, get } from "firebase/database";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { database } from "../../firebase";
import { decodeSizeKey } from "../../utils/sizeKey";
import { SHOP_IDS, SHOP_LABELS } from "../../utils/stores";
import { installBarcodeListener, subscribeBarcode } from "../../components/stock/barcodeListener";
import { FONT, MONO, BLUE, BLUE_SOFT, INK, GLASS_BG, GLASS_BORDER, PANEL, META } from "./tokens";
import { dcSession } from "./session";

const ZERO_RED = "rgba(255,120,120,.85)"; // a zero is an answer too (§6) — muted red, never hidden
const CLOTHING_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "4XL", "5XL"];

// Clothing sizes sort in wearing order (S,M,L,XL…); numeric (waist/shoe) sort
// numerically; anything else falls back to alpha.
function sizeRank(sz) {
  const s = String(sz).toUpperCase().trim();
  const ci = CLOTHING_ORDER.indexOf(s);
  if (ci >= 0) return [0, ci, ""];
  const n = parseFloat(s);
  if (!Number.isNaN(n)) return [1, n, ""];
  return [2, 0, s];
}
function sortSizes(a, b) {
  const ra = sizeRank(a), rb = sizeRank(b);
  for (let i = 0; i < 3; i++) { if (ra[i] < rb[i]) return -1; if (ra[i] > rb[i]) return 1; }
  return 0;
}

const isClothing = (p) => p && (p.category === "Clothing" || p.productType === "clothing");
const nameTokens = (s) => String(s || "").toLowerCase().split(/\s+/).filter(Boolean);

// One store's live per-size counts — a single get(), size-decoded.
async function readStoreSizes(productId, storeId) {
  const snap = await get(ref(database, `stock/${storeId}/${productId}`));
  const val = snap.val() || {};
  const out = {};
  for (const k of Object.keys(val)) {
    out[decodeSizeKey(k)] = typeof val[k]?.qty === "number" ? val[k].qty : 0;
  }
  return out;
}

// ── Barcode-capable camera (extends the QR scanner with 1-D retail formats) ────
function ScanCamera({ onDetected, onClose }) {
  const [error, setError] = useState(null);
  const liveRef = useRef(false);
  const handledRef = useRef(false);
  const READER_ID = "dc-availability-reader";

  useEffect(() => {
    let cancelled = false;
    const instance = new Html5Qrcode(READER_ID, false);
    const stop = () => {
      if (!liveRef.current) return Promise.resolve();
      liveRef.current = false;
      return instance.stop().then(() => instance.clear()).catch(() => {});
    };
    instance.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 260, height: 170 },
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.QR_CODE,
        ],
      },
      (text) => {
        if (handledRef.current) return;
        handledRef.current = true;
        stop().finally(() => { if (!cancelled) onDetected(text); });
      },
      () => {}
    ).then(() => { if (cancelled) stop(); else liveRef.current = true; })
      .catch((err) => {
        if (!cancelled) setError(
          err?.name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access, or key the barcode instead."
            : "Could not start the camera. Key the barcode instead."
        );
      });
    return () => { cancelled = true; stop(); };
  }, [onDetected]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.93)", display: "flex", flexDirection: "column", fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", color: "#fff" }}>
        <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: ".04em" }}>Scan barcode</div>
        <button onClick={onClose} style={{ background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.18)", color: "#fff", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Close</button>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 16px" }}>
        {error ? (
          <div style={{ color: "#FF9B9B", textAlign: "center", maxWidth: 340, fontSize: 14, lineHeight: 1.5 }}>{error}</div>
        ) : (
          <>
            <div id={READER_ID} style={{ width: "100%", maxWidth: 380, borderRadius: 16, overflow: "hidden" }} />
            <div style={{ color: "rgba(255,255,255,.6)", fontSize: 13, marginTop: 16, textAlign: "center" }}>Line the barcode up inside the frame.</div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Live size table for one store ─────────────────────────────────────────────
function SizeTable({ product, sizes }) {
  // Union of the product's declared sizes and whatever the stock tree holds, so
  // a declared size with no cell still shows as 0 (an answer), and a stray cell
  // still shows up.
  const keys = useMemo(() => {
    const declared = (product.sizes || []).map(String).filter((s) => s && s !== "_");
    const stockKeys = (sizes && typeof sizes === "object") ? Object.keys(sizes) : [];
    const set = new Set([...declared, ...stockKeys]);
    return [...set].sort(sortSizes);
  }, [product, sizes]);

  if (sizes === "loading") return <div style={{ ...META, color: "rgba(233,238,255,.4)", padding: "10px 0" }}>READING STOCK…</div>;
  // A failed read must NOT masquerade as all-zeros — say so plainly (Kimi P1).
  if (sizes === "error") return <div style={{ ...META, color: ZERO_RED, padding: "10px 0" }}>COULDN'T READ STOCK — TRY AGAIN</div>;
  if (!keys.length) return <div style={{ ...META, color: "rgba(233,238,255,.4)", padding: "10px 0" }}>NO SIZES ON RECORD</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {keys.map((sz) => {
        const qty = typeof sizes?.[sz] === "number" ? sizes[sz] : 0;
        const zero = qty <= 0;
        return (
          <div key={sz} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 2px", borderBottom: "1px solid rgba(255,255,255,.05)" }}>
            <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: zero ? ZERO_RED : INK, letterSpacing: ".04em" }}>{sz === "_" ? "ONE SIZE" : sz}</span>
            <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: zero ? ZERO_RED : INK, fontVariantNumeric: "tabular-nums" }}>{qty}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Result card ───────────────────────────────────────────────────────────────
function ResultCard({ product, storeId, big }) {
  const [sizes, setSizes] = useState("loading");
  const [others, setOthers] = useState(null); // null | "loading" | { storeId: sizesMap }
  const otherStoreIds = useMemo(() => SHOP_IDS.filter((s) => s !== storeId), [storeId]);

  useEffect(() => {
    let alive = true;
    setSizes("loading");
    setOthers(null);
    readStoreSizes(product.id, storeId)
      .then((m) => { if (alive) setSizes(m); })
      .catch(() => { if (alive) setSizes("error"); });
    return () => { alive = false; };
  }, [product.id, storeId]);

  const loadOthers = useCallback(() => {
    setOthers("loading");
    Promise.all(otherStoreIds.map((s) => readStoreSizes(product.id, s).then((m) => [s, m]).catch(() => [s, "error"])))
      .then((pairs) => setOthers(Object.fromEntries(pairs)));
  }, [product.id, otherStoreIds]);

  const img = product.photoUrl || product.photo || null;
  return (
    <div style={{ ...PANEL, padding: big ? 22 : 16, display: "flex", flexDirection: big ? "row" : "column", gap: big ? 22 : 14 }}>
      <div style={{ width: big ? 300 : "100%", flexShrink: 0 }}>
        <div style={{ width: "100%", aspectRatio: "1 / 1", borderRadius: 14, overflow: "hidden", background: "rgba(255,255,255,.04)", border: GLASS_BORDER, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {img
            ? <img src={img} alt={product.name} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            : <span style={{ ...META, color: "rgba(233,238,255,.3)" }}>NO IMAGE</span>}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: big ? 20 : 17, fontWeight: 750, color: INK, letterSpacing: "-0.01em", lineHeight: 1.25 }}>{product.name}</div>
        <div style={{ ...META, color: BLUE_SOFT, marginTop: 6, marginBottom: 8 }}>{SHOP_LABELS[storeId]?.toUpperCase() || "—"} · FLOOR</div>
        <SizeTable product={product} sizes={sizes} />

        {others === null ? (
          <button onClick={loadOthers} style={{ ...META, marginTop: 14, cursor: "pointer", background: GLASS_BG, border: GLASS_BORDER, borderRadius: 10, padding: "8px 12px", color: "rgba(233,238,255,.7)", letterSpacing: ".08em" }}>▸ OTHER STORES</button>
        ) : others === "loading" ? (
          <div style={{ ...META, marginTop: 14, color: "rgba(233,238,255,.4)" }}>READING OTHER STORES…</div>
        ) : (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            {otherStoreIds.map((s) => (
              <div key={s}>
                <div style={{ ...META, color: "rgba(233,238,255,.55)", marginBottom: 4 }}>{SHOP_LABELS[s]?.toUpperCase() || s}</div>
                <SizeTable product={product} sizes={others[s]} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Segmented control ─────────────────────────────────────────────────────────
export default function AvailabilityView({ store, products, wide, active }) {
  const clothing = useMemo(() => (products || []).filter((p) => isClothing(p) && p.name), [products]);
  // Search text + selection live in the session singleton so they survive a tab
  // switch, a rotation, and leaving/re-entering the module (Bug 1).
  const [query, setQueryState] = useState(() => dcSession.search);
  const setQuery = useCallback((v) => { dcSession.search = v; setQueryState(v); }, []);
  const [selectedId, setSelectedIdState] = useState(() => dcSession.selectedId);
  const setSelectedId = useCallback((id) => { dcSession.selectedId = id; setSelectedIdState(id); }, []);
  const [scanning, setScanning] = useState(false);
  const [notFound, setNotFound] = useState(null);
  const [recent, setRecent] = useState([]);

  const selected = useMemo(() => (products || []).find((p) => p.id === selectedId) || null, [products, selectedId]);
  const trimmed = query.trim();
  const looksBarcode = /^\d+$/.test(trimmed); // all-digits → barcode; any letter → name

  // Name search — only when the text ISN'T a bare barcode. All tokens must match.
  const results = useMemo(() => {
    if (!trimmed || /^\d+$/.test(trimmed)) return [];
    const toks = nameTokens(trimmed);
    return clothing.filter((p) => { const n = p.name.toLowerCase(); return toks.every((t) => n.includes(t)); }).slice(0, 24);
  }, [trimmed, clothing]);

  const pick = useCallback((p) => {
    if (!p) return;
    setSelectedId(p.id);
    setNotFound(null);
    setRecent((r) => [p, ...r.filter((x) => x.id !== p.id)].slice(0, 6));
  }, [setSelectedId]);

  // Barcode / scan resolution: product-level match first (client, free), then the
  // /barcodes/{code} reverse index (one read) for per-size codes.
  const resolveCode = useCallback(async (raw) => {
    const c = String(raw || "").trim();
    if (!c) return;
    let p = (products || []).find((x) => x?.barcode && String(x.barcode) === c);
    if (!p) {
      try {
        const snap = await get(ref(database, `barcodes/${c}`));
        const hit = snap.val();
        if (hit?.productId) p = (products || []).find((x) => x.id === hit.productId);
      } catch { /* index miss — fall through to not-found */ }
    }
    if (p) pick(p);
    else { setSelectedId(null); setNotFound(c); }
  }, [products, pick, setSelectedId]);

  // AUTO-DETECT: an all-digit string long enough to be a real barcode auto-fires a
  // barcode lookup (debounced). Anything with letters is a name search (results
  // below), which needs no auto-fire. A too-short digit string waits.
  useEffect(() => {
    if (looksBarcode && trimmed.length >= 8) {
      const t = setTimeout(() => resolveCode(trimmed), 250);
      return () => clearTimeout(t);
    }
  }, [trimmed, looksBarcode, resolveCode]);

  // Hardware wedge (handheld gun) — only while THIS tab is active (the view stays
  // mounted when hidden, so an ungated listener would hijack scans elsewhere). The
  // wedge drops digits into the bar; auto-detect owns the single resolve.
  useEffect(() => {
    if (!active) return;
    installBarcodeListener();
    const off = subscribeBarcode((raw) => setQuery(String(raw || "").trim()));
    return off;
  }, [active, setQuery]);

  // Camera scan resolves directly (a scanned code may be shorter/alphanumeric than
  // the auto-detect threshold); no setQuery, so it never double-fires.
  const onScanDetected = useCallback((text) => { setScanning(false); resolveCode(text); }, [resolveCode]);

  // ── ONE unified search bar: type a name OR a barcode; camera icon to scan ──
  const inputPanel = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ position: "relative" }}>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setNotFound(null); }}
          placeholder="Search a name, or scan / key a barcode…"
          style={{ fontFamily: looksBarcode ? MONO : FONT, fontSize: 15, letterSpacing: looksBarcode ? ".04em" : "normal",
                   color: INK, background: GLASS_BG, border: GLASS_BORDER, borderRadius: 12,
                   padding: "13px 48px 13px 15px", outline: "none", width: "100%", boxSizing: "border-box" }}
        />
        <button type="button" onClick={() => setScanning(true)} title="Scan barcode" aria-label="Scan barcode"
                style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: BLUE_SOFT, display: "grid", placeItems: "center", padding: 5 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
        </button>
      </div>

      {results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: wide ? 520 : 320, overflow: "auto" }}>
          {results.map((p) => (
            <button key={p.id} onClick={() => pick(p)}
                    style={{ display: "flex", alignItems: "center", gap: 11, textAlign: "left", cursor: "pointer", background: selectedId === p.id ? "rgba(74,127,255,.12)" : "transparent", border: "1px solid " + (selectedId === p.id ? BLUE : "transparent"), borderRadius: 11, padding: "9px 10px", fontFamily: FONT }}>
              <span style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 9, overflow: "hidden", background: "rgba(255,255,255,.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {(p.photoUrl || p.photo) ? <img src={p.photoUrl || p.photo} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
            </button>
          ))}
        </div>
      )}
      {trimmed && !looksBarcode && results.length === 0 && (
        <div style={{ ...META, color: "rgba(233,238,255,.4)" }}>NO CLOTHING MATCHES "{trimmed.toUpperCase()}"</div>
      )}

      {recent.length > 0 && (
        <div>
          <div style={{ ...META, color: "rgba(233,238,255,.35)", marginBottom: 8 }}>RECENT</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {recent.map((p) => (
              <button key={p.id} onClick={() => pick(p)} style={{ ...META, cursor: "pointer", background: GLASS_BG, border: GLASS_BORDER, borderRadius: 999, padding: "6px 11px", color: "rgba(233,238,255,.7)", maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const resultPanel = notFound ? (
    <div style={{ ...PANEL, padding: "40px 24px", textAlign: "center" }}>
      <div style={{ ...META, color: ZERO_RED }}>NO MATCH</div>
      <div style={{ fontFamily: FONT, fontSize: 15, color: INK, marginTop: 10 }}>Nothing matched <b>{notFound}</b>.</div>
      <div style={{ fontFamily: FONT, fontSize: 13, color: "rgba(233,238,255,.5)", marginTop: 6 }}>Try the Name search, or check the code.</div>
    </div>
  ) : selected ? (
    <ResultCard product={selected} storeId={store} big={wide} />
  ) : (
    <div style={{ ...PANEL, padding: "48px 24px", textAlign: "center", color: "rgba(233,238,255,.4)" }}>
      <div style={{ ...META, color: BLUE_SOFT }}>READY</div>
      <div style={{ fontFamily: FONT, fontSize: 14.5, color: INK, marginTop: 10 }}>Search, key a barcode, or scan to see live stock.</div>
    </div>
  );

  return (
    <>
      {scanning && <ScanCamera onDetected={onScanDetected} onClose={() => setScanning(false)} />}
      {wide ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 380px) 1fr", gap: 22, alignItems: "start" }}>
          <div>{inputPanel}</div>
          <div>{resultPanel}</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {inputPanel}
          {resultPanel}
        </div>
      )}
    </>
  );
}
