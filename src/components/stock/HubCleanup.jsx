// ─── HUB STOCK CLEANUP — the combined Display Register + Hub Sneaker Count ────
// ONE card, one module, three passes over a hub's sneakers (owner spec
// 2026-08-06). Phone-first: this is used standing in a warehouse, at speed, by
// five people in parallel — so the size picker dominates, hit areas are big,
// and every flow is one decision per screen.
//
//   REGISTER (pass one)  Scan a display, confirm its size, and that unit is
//                        ADDED to the hub's existing quantity for that size —
//                        a `received` movement through applyMovement with a
//                        deterministic id (idempotent; see hubCleanupStore).
//   COUNT (pass two)     Scan-first stock count. Scan → confirm quantity →
//                        continue. A scan nothing owns is NOT an error — it is
//                        how we learn the item was never registered; it goes to
//                        its own calm list. Writes reuse the proven
//                        hubCountStore fences (confirm / adjust / flag).
//   LEFTOVERS            Everything holding stock at this hub that was never
//                        seen on the floor — one bold card per product, every
//                        location's quantity, and a Merge action.
//
// SCOPE: Hub 1 and Hub 2 ONLY (CLEANUP_HUBS). Pine — marathon-pine and its
// hub3 lane — is entirely out of scope and no path here can reach it.
//
// READ MODEL: one-shot get()s, frozen into state, same as HubSneakerCount. The
// catalogue arrives as a prop (already filtered of merged-away products at the
// useProducts chokepoint).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setUpdateBusy } from "../../update/updateChecker";
import { searchProducts } from "../../utils/productSearch";
import { SizeTag } from "../SizeTag.jsx";
import { FONT, BG, CARD, BORDER, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGray, bGhost, input, tabOn, tabOff } from "./ui";
import { Toast } from "./widgets";
import { labelFor } from "./locations";
import { installBarcodeListener, subscribeBarcode } from "./barcodeListener";
import { canAdjustHubCount } from "../../config/hubSneakerCount";
import {
  CLEANUP_HUBS, CLEANUP_HUB_LABELS, resolveCleanupScan, openDuplicateFor,
  buildLeftovers, locationsHolding, registrationProgress, realSizes,
} from "./hubCleanupCore";
import {
  loadRegister, loadUnresolved, registerDisplayUnit, addExtraDisplayUnit,
  recordUnresolvedScan, lookupBarcode, loadAllStock, loadDuplicateCandidates,
  fetchProductFollowingMerge,
} from "./hubCleanupStore";
import {
  loadHubStock, openOrResumeSession, loadCounted, publishSessionTotal,
  confirmCell, adjustCell, flagCell, useLocationRegistryOnce, rememberHub, rememberedHub,
} from "./hubCountStore";
import { isCountableSizeKey, cellKey, sizeLabelOf } from "./hubCountCore";
import { stockSizeKey } from "../../utils/sizeKey";
import CameraScanner from "./CameraScanner.jsx";
import MergeProducts from "./MergeProducts.jsx";
import HubSneakerCount from "./HubSneakerCount.jsx";

const qtyOf = (cell) => (cell && typeof cell.qty === "number" ? cell.qty : 0);

// ─── Shared bits ─────────────────────────────────────────────────────────────

function Photo({ url, size = 96, radius = 14 }) {
  if (!url) {
    return <div style={{ width: size, height: size, borderRadius: radius, background: "rgba(120,150,255,.08)",
                         display: "flex", alignItems: "center", justifyContent: "center", fontSize: size / 3, flexShrink: 0 }}>👟</div>;
  }
  return <img src={url} alt="" loading="lazy" decoding="async"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
              style={{ width: size, height: size, objectFit: "cover", borderRadius: radius, flexShrink: 0,
                       border: "1px solid rgba(255,255,255,.1)" }} />;
}

// The DOMINANT size picker — the one control the operator must never miss.
function SizeGrid({ sizes, chosen, onPick, marks = {}, disabled }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))", gap: 10 }}>
      {sizes.map((s) => {
        const active = chosen === s;
        const mark = marks[s];
        return (
          <button key={s} type="button" disabled={disabled} onClick={() => onPick(s)}
            style={{ minHeight: 64, borderRadius: 14, cursor: "pointer", position: "relative",
                     fontSize: 22, fontWeight: 900, fontFamily: FONT, letterSpacing: "-0.01em",
                     background: active ? "rgba(74,222,128,.22)" : "rgba(74,127,255,.13)",
                     border: active ? "2px solid rgba(74,222,128,.9)" : "2px solid rgba(74,127,255,.45)",
                     color: active ? "#B7F0CC" : "#D7E3FF" }}>
            <SizeTag size={s} />
            {mark != null && (
              <span style={{ position: "absolute", top: 5, right: 7, fontSize: 10.5, fontWeight: 800, color: GREEN }}>{mark}</span>
            )}
          </button>
        );
      })}
      {sizes.length === 0 && (
        <div style={{ gridColumn: "1/-1", fontSize: 13, color: AMBER }}>This product has no sizes on record.</div>
      )}
    </div>
  );
}

function BigButton({ children, onClick, tone = "blue", disabled, style }) {
  const tones = {
    blue: { background: "rgba(74,127,255,.18)", border: "2px solid rgba(74,127,255,.55)", color: "#D7E3FF" },
    green: { background: "rgba(74,222,128,.18)", border: "2px solid rgba(74,222,128,.6)", color: "#B7F0CC" },
    ghost: { background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.16)", color: "rgba(233,238,255,.75)" },
    red: { background: "rgba(248,113,113,.14)", border: "2px solid rgba(248,113,113,.5)", color: "#FFC9C9" },
  };
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      style={{ width: "100%", minHeight: 58, borderRadius: 15, fontSize: 17, fontWeight: 800, fontFamily: FONT,
               cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
               ...tones[tone], ...style }}>
      {children}
    </button>
  );
}

// One overlay to rule the flow: everything for the tapped product happens HERE —
// scan result, size, quantity, photo — never as a separate step at the bottom
// of the screen (the defect this rebuild removes).
function Panel({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "#05070C", overflowY: "auto",
                  fontFamily: FONT, color: "#fff" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "14px 16px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0 14px" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: BLUE_L, letterSpacing: ".02em" }}>{title}</div>
          <button type="button" onClick={onClose}
            style={{ ...bGhost, padding: "10px 18px", fontSize: 14, borderRadius: 12 }}>✕ Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── The module ──────────────────────────────────────────────────────────────

export default function HubCleanup({ products = [], actorRole, viewer, onExit }) {
  const registry = useLocationRegistryOnce();
  const [hub, setHubRaw] = useState(() => {
    const h = rememberedHub();
    return CLEANUP_HUBS.includes(h) ? h : "";
  });
  const setHub = useCallback((id) => { rememberHub(id); setHubRaw(id); }, []);

  const [tab, setTab] = useState("register");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const flash = useCallback((kind, text, ms = 4000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  // ── Frozen one-shot data for the chosen hub ────────────────────────────────
  const [hubStock, setHubStock] = useState(null);       // /stock/{hub}, raw encoded keys
  const [registered, setRegistered] = useState({});
  const [unresolved, setUnresolved] = useState({});
  const [duplicates, setDuplicates] = useState({});
  const [session, setSession] = useState(null);
  const [counted, setCounted] = useState({});
  const [allStock, setAllStock] = useState(null);       // lazy — Leftovers / Merge only
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!hub) return;
    let cancelled = false;
    // A hub switch is a fresh world: the count session, its records, the
    // all-location snapshot and any open panel all belong to the OLD hub and
    // must not leak — a stale sessionId here would file the new hub's counts
    // under the old hub's session.
    setSession(null);
    setCounted({});
    setAllStock(null);
    setPanel(null);
    setLoading(true);
    setLoadError("");
    setUpdateBusy(true);
    Promise.all([loadHubStock(hub), loadRegister(hub), loadUnresolved(hub), loadDuplicateCandidates()])
      .then(([stock, reg, unres, dups]) => {
        if (cancelled) return;
        setHubStock(stock);
        setRegistered(reg);
        setUnresolved(unres);
        setDuplicates(dups);
      })
      .catch((err) => { if (!cancelled) setLoadError(String(err?.message || err)); })
      .finally(() => { if (!cancelled) { setLoading(false); setUpdateBusy(false); } });
    return () => { cancelled = true; setUpdateBusy(false); };
  }, [hub]);

  // Count session opens the first time the Count tab is entered for this hub.
  useEffect(() => {
    if (!hub || tab !== "count" || session || !hubStock) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await openOrResumeSession(hub);
        if (cancelled) return;
        setSession(s);
        const c = await loadCounted(hub, s.sessionId);
        if (cancelled) return;
        setCounted(c || {});
        const total = Object.values(hubStock).reduce(
          (n, cells) => n + Object.keys(cells || {}).filter(isCountableSizeKey).length, 0);
        publishSessionTotal(hub, s.sessionId, total).catch(() => {});
      } catch (err) {
        if (!cancelled) flash("err", `Could not open the count session: ${err?.message || err}`);
      }
    })();
    return () => { cancelled = true; };
  }, [hub, tab, session, hubStock, flash]);

  // All-location stock loads once, when Leftovers (or Merge) first needs it.
  const ensureAllStock = useCallback(async () => {
    if (allStock) return allStock;
    const ids = Object.keys(registry || {});
    const fallback = ["central", "hub1", "hub2", "marathon-pe", "trophy", "in_transit"];
    const loaded = await loadAllStock(ids.length ? ids : fallback);
    setAllStock(loaded);
    return loaded;
  }, [allStock, registry]);

  useEffect(() => {
    if (tab === "leftovers" && !allStock && hub) ensureAllStock().catch(() => {});
  }, [tab, allStock, hub, ensureAllStock]);

  // ── Scanning (camera + hardware + typed) ───────────────────────────────────
  const [cameraOpen, setCameraOpen] = useState(false);
  const [manual, setManual] = useState("");
  const [panel, setPanel] = useState(null);   // { mode, product, size, code } | { mode:"duplicate", ... }
  const [merge, setMerge] = useState(null);   // { loser, other } — the merge overlay
  const [fullList, setFullList] = useState(false);

  const handleCode = useCallback(async (raw) => {
    const code = String(raw ?? "").trim();
    if (!code || !hub) return;
    setBusy(true);
    try {
      const barcodeRow = await lookupBarcode(code).catch(() => null);
      let out = resolveCleanupScan(code, { products, barcodeRow });
      if (out.kind === "unresolved" && barcodeRow && barcodeRow.productId) {
        // A barcode row whose product is not in this session's (filtered)
        // catalogue: it may have been merged away — before this catalogue
        // loaded, or on another device minutes ago. Ask /products directly and
        // follow the mergedInto chain to whoever answers for it today.
        const survivor = await fetchProductFollowingMerge(barcodeRow.productId).catch(() => null);
        if (survivor) out = { kind: "product", product: survivor, size: barcodeRow.size != null ? String(barcodeRow.size) : null };
      }
      if (out.kind === "product") {
        setPanel({ mode: tab === "count" ? "count" : "register", product: out.product, size: out.size, code });
      } else if (out.kind === "duplicate") {
        setPanel({ mode: "duplicate", code, claimants: out.products });
      } else {
        await recordUnresolvedScan({ hub, code, context: tab });
        setUnresolved((u) => ({ ...u, [code.replace(/[.#$/\[\]\s]/g, "_").slice(0, 64) || "_"]: { code, context: tab } }));
        flash("warn", tab === "count"
          ? `Nothing owns “${code}” — noted as never registered. Carry on.`
          : `“${code}” isn't in the system — noted. Carry on.`);
      }
    } finally { setBusy(false); }
  }, [hub, tab, products, flash]);

  useEffect(() => {
    const uninstall = installBarcodeListener();
    const unsub = subscribeBarcode((value) => { handleCode(value); });
    return () => { unsub(); uninstall(); };
  }, [handleCode]);

  // Secondary path: type a name/code. Scan stays primary.
  const [query, setQuery] = useState("");
  const searchHits = useMemo(
    () => (query.trim() ? searchProducts(products, query, { limit: 12 }) : []),
    [products, query],
  );

  // ── Derived views ──────────────────────────────────────────────────────────
  const progress = useMemo(
    () => registrationProgress({ products, hubStock: hubStock || {}, registered }),
    [products, hubStock, registered],
  );
  const countDone = Object.keys(counted).length;
  const countTotal = useMemo(() => {
    if (!hubStock) return 0;
    return Object.values(hubStock).reduce((n, cells) => n + Object.keys(cells || {}).filter(isCountableSizeKey).length, 0);
  }, [hubStock]);

  const leftovers = useMemo(() => {
    if (!hubStock) return [];
    return buildLeftovers({ hub, products, hubStock, registered, allStock });
  }, [hub, products, hubStock, registered, allStock]);

  const refreshAfterMerge = useCallback(async () => {
    setMerge(null);
    setPanel(null);
    setAllStock(null);
    if (hub) {
      const [stock, reg] = await Promise.all([loadHubStock(hub), loadRegister(hub)]);
      setHubStock(stock);
      setRegistered(reg);
    }
  }, [hub]);

  // ── Registration writes ────────────────────────────────────────────────────
  const doRegister = useCallback(async ({ product, size, qty }) => {
    setBusy(true);
    try {
      const res = await registerDisplayUnit({ hub, product, size, qty });
      if (!res.ok) { flash("err", res.message || "Could not register."); return; }
      setRegistered(await loadRegister(hub));
      setHubStock(await loadHubStock(hub));
      if (res.warning) flash("warn", res.warning, 9000);
      else if (res.already) flash("ok", `${product.name} — size ${size} was already registered.`);
      else flash("ok", `${product.name} — size ${size}: ${qty} added to ${CLEANUP_HUB_LABELS[hub]}.`);
      setPanel(null);
      setQuery("");
    } finally { setBusy(false); }
  }, [hub, flash]);

  const doExtra = useCallback(async ({ product, size }) => {
    setBusy(true);
    try {
      const res = await addExtraDisplayUnit({ hub, product, size });
      if (!res.ok) { flash("err", res.message || "Could not add."); return; }
      setRegistered(await loadRegister(hub));
      setHubStock(await loadHubStock(hub));
      flash("ok", `One more size ${size} added.`);
    } finally { setBusy(false); }
  }, [hub, flash]);

  // ── Count writes (the proven fences) ───────────────────────────────────────
  const canAdjust = canAdjustHubCount(viewer);
  const doCount = useCallback(async ({ product, sizeKey, expected, actual }) => {
    if (!session) return;
    setBusy(true);
    try {
      const args = { hub, sessionId: session.sessionId, productId: product.id, sizeKey, expected };
      const res = actual === expected
        ? await confirmCell(args)
        : canAdjust
          ? await adjustCell({ ...args, actual, actorRole })
          : await flagCell({ ...args, actual });
      if (!res.ok) { flash(res.stale ? "warn" : "err", res.message || "Could not record.", 6500); return; }
      setCounted((c) => ({ ...c, [cellKey(product.id, sizeKey)]: res.record }));
      if (res.warning) flash("warn", res.warning, 9000);
      else flash("ok", actual === expected ? "Confirmed." : canAdjust ? `Adjusted to ${actual}.` : `Flagged for an admin (${actual}).`);
    } finally { setBusy(false); }
  }, [hub, session, canAdjust, actorRole, flash]);

  // ── Screens ────────────────────────────────────────────────────────────────

  if (fullList) {
    return <HubSneakerCount products={products} actorRole={actorRole} viewer={viewer}
                            onExit={() => setFullList(false)} />;
  }

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "50px 16px 10px" }}>
      <div onClick={() => (hub ? setHub("") : onExit && onExit())}
           style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)",
                    borderRadius: 10, padding: "9px 15px", fontSize: 13, color: "rgba(255,255,255,.7)", cursor: "pointer" }}>
        ← {hub ? "Hubs" : "Back"}
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", letterSpacing: ".5px" }}>Hub Stock Cleanup</div>
        <div style={{ fontSize: 15, fontWeight: 800, color: BLUE_L }}>{hub ? CLEANUP_HUB_LABELS[hub] : "Choose hub"}</div>
      </div>
      <div style={{ width: 78 }} />
    </div>
  );

  // Hub choice — one decision, two giant targets.
  if (!hub) {
    return (
      <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT }}>
        {header}
        <div style={{ maxWidth: 560, margin: "0 auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          {CLEANUP_HUBS.map((h) => (
            <button key={h} type="button" onClick={() => setHub(h)}
              style={{ minHeight: 96, borderRadius: 18, fontSize: 26, fontWeight: 900, fontFamily: FONT, cursor: "pointer",
                       background: "rgba(74,127,255,.14)", border: "2px solid rgba(74,127,255,.5)", color: "#D7E3FF" }}>
              {CLEANUP_HUB_LABELS[h]}
            </button>
          ))}
          <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.55, padding: "4px 2px" }}>
            Displays on the shop floor ARE hub stock. Register them here, then count the hub —
            Pine is out of scope and is handled separately.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, paddingBottom: 50 }}>
      {header}
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 16px" }}>

        {/* Tabs + zone progress: scanned versus expected, always visible. */}
        <div style={{ display: "flex", gap: 8, margin: "8px 0 6px" }}>
          {[["register", "Register"], ["count", "Count"], ["leftovers", `Leftovers${hubStock ? ` · ${leftovers.length}` : ""}`]].map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              style={{ ...(tab === id ? tabOn : tabOff), flex: 1, minHeight: 46, fontSize: 14, borderRadius: 12 }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12.5, color: GRAY, margin: "0 2px 14px", fontVariantNumeric: "tabular-nums" }}>
          {tab === "register" && <>Scanned <strong style={{ color: progress.seen >= progress.expected && progress.expected > 0 ? GREEN : BLUE_L }}>{progress.seen}</strong> of {progress.expected} products holding stock here · {progress.units} display units added</>}
          {tab === "count" && <>Counted <strong style={{ color: countDone >= countTotal && countTotal > 0 ? GREEN : BLUE_L }}>{countDone}</strong> of {Math.max(countTotal, countDone)} size cells</>}
          {tab === "leftovers" && <>{leftovers.length} products hold stock here but were never seen on the floor</>}
        </div>

        {loading && <div style={{ color: GRAY, fontSize: 13, padding: "18px 2px" }}>Loading {CLEANUP_HUB_LABELS[hub]}…</div>}
        {loadError && <div style={{ color: RED, fontSize: 13, padding: "10px 2px" }}>Could not load: {loadError}</div>}

        {/* ── REGISTER + COUNT share the scan-first entry ─────────────────── */}
        {!loading && (tab === "register" || tab === "count") && (
          <>
            <BigButton tone="blue" disabled={busy} onClick={() => setCameraOpen(true)}
                       style={{ minHeight: 84, fontSize: 21 }}>
              📷 SCAN {tab === "register" ? "A DISPLAY" : "A SHOE"}
            </BigButton>
            <form onSubmit={(e) => { e.preventDefault(); const v = manual.trim(); setManual(""); if (v) handleCode(v); }}
                  style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input value={manual} onChange={(e) => setManual(e.target.value)}
                     placeholder="Type a barcode or style code…"
                     style={{ ...input, flex: 1, minHeight: 48, fontSize: 15 }} />
              <button type="submit" style={{ ...bGray, minHeight: 48, padding: "0 18px" }}>Go</button>
            </form>

            {/* Search by name — the SECONDARY path, small on purpose. */}
            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="…or search by name (secondary)"
                   style={{ ...input, width: "100%", boxSizing: "border-box", marginTop: 10, fontSize: 13.5, opacity: 0.85 }} />
            {searchHits.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {searchHits.map((p) => (
                  <button key={p.id} type="button"
                    onClick={() => { setPanel({ mode: tab, product: p, size: null, code: null }); setQuery(""); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", textAlign: "left", cursor: "pointer",
                             background: CARD, border: BORDER, borderRadius: 12 }}>
                    <Photo url={p.photoUrl} size={40} radius={9} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: GRAY }}>{realSizes(p).length} sizes</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {tab === "count" && (
              <button type="button" onClick={() => setFullList(true)}
                style={{ ...bGhost, width: "100%", marginTop: 14, minHeight: 46, borderRadius: 12, fontSize: 13 }}>
                Full list &amp; variance (browse every cell) →
              </button>
            )}

            {/* The calm "never registered" list — the point of pass two's misses. */}
            {Object.keys(unresolved).length > 0 && (
              <div style={{ marginTop: 22 }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "rgba(233,238,255,.5)", marginBottom: 8 }}>
                  Scans nothing owns — never registered
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {Object.entries(unresolved).map(([k, row]) => (
                    <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                                          background: "rgba(251,191,36,.06)", border: "1px solid rgba(251,191,36,.22)", borderRadius: 11 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#FDE9B0", flex: 1, overflowWrap: "anywhere" }}>{row?.code || k}</span>
                      <span style={{ fontSize: 10.5, color: GRAY }}>{row?.context || ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── LEFTOVERS ───────────────────────────────────────────────────── */}
        {!loading && tab === "leftovers" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!allStock && <div style={{ color: GRAY, fontSize: 13 }}>Loading every location…</div>}
            {allStock && leftovers.length === 0 && (
              <div style={{ textAlign: "center", padding: "40px 16px", color: "rgba(233,238,255,.5)" }}>
                <div style={{ fontSize: 30, marginBottom: 10 }}>✅</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Nothing left over.</div>
                <div style={{ fontSize: 13, marginTop: 6 }}>Every product holding stock at {CLEANUP_HUB_LABELS[hub]} was seen on the floor.</div>
              </div>
            )}
            {leftovers.map(({ product, hubQty, locations }) => (
              <div key={product.id}
                   style={{ background: "rgba(12,16,30,.75)", border: "1px solid rgba(120,150,255,.28)", borderRadius: 18, padding: 16 }}>
                <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                  <Photo url={product.photoUrl} size={92} radius={14} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 17, fontWeight: 800, color: "#fff", lineHeight: 1.25 }}>{product.name}</div>
                    <div style={{ fontSize: 12.5, color: GRAY, marginTop: 4 }}>
                      Holds <strong style={{ color: AMBER }}>{hubQty}</strong> at {CLEANUP_HUB_LABELS[hub]}, never seen on the floor
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7, margin: "12px 0" }}>
                  {(locations || locationsHolding(product.id, allStock || {})).map(({ loc, qty }) => (
                    <span key={loc} style={{ fontSize: 13, fontWeight: 800, padding: "7px 12px", borderRadius: 10,
                                             fontVariantNumeric: "tabular-nums",
                                             background: qty < 0 ? "rgba(248,113,113,.12)" : "rgba(74,127,255,.12)",
                                             border: qty < 0 ? "1px solid rgba(248,113,113,.4)" : "1px solid rgba(74,127,255,.35)",
                                             color: qty < 0 ? "#FFC9C9" : "#CFE0FF" }}>
                      {labelFor(loc, registry)} · {qty}
                    </span>
                  ))}
                </div>
                <BigButton tone="blue" disabled={busy}
                  onClick={async () => { await ensureAllStock().catch(() => {}); setMerge({ loser: product, other: null }); }}>
                  ⇄ Merge into another product…
                </BigButton>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── The one panel per product ───────────────────────────────────────── */}
      {/* Keyed by product+size so a NEW scan REMOUNTS the panel — the hardware
          listener stays live while a panel is open, and a carried-over size or
          quantity from the previous product is exactly the mis-registration
          this screen exists to prevent. */}
      {panel && panel.mode === "register" && (
        <RegisterPanel key={`reg_${panel.product.id}_${panel.size ?? ""}`}
                       panel={panel} hub={hub} registered={registered} duplicates={duplicates}
                       products={products} busy={busy}
                       onRegister={doRegister} onExtra={doExtra}
                       onMerge={(loser, other) => setMerge({ loser, other })}
                       onClose={() => setPanel(null)} />
      )}
      {panel && panel.mode === "count" && (
        <CountPanel key={`cnt_${panel.product.id}_${panel.size ?? ""}`}
                    panel={panel} hub={hub} hubStock={hubStock || {}} counted={counted}
                    busy={busy} canAdjust={canAdjust}
                    onRecord={doCount} onClose={() => setPanel(null)} />
      )}
      {panel && panel.mode === "duplicate" && (
        <Panel title="One code, two products" onClose={() => setPanel(null)}>
          <div style={{ fontSize: 14.5, color: "#FDE9B0", lineHeight: 1.5, marginBottom: 16 }}>
            “{panel.code}” is claimed by <strong>{panel.claimants.length}</strong> different products.
            One of them is a duplicate — merge them rather than guessing.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {panel.claimants.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12,
                                       background: CARD, border: BORDER, borderRadius: 14 }}>
                <Photo url={p.photoUrl} size={56} radius={10} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 700 }}>{p.name}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <BigButton tone="blue" onClick={async () => {
              await ensureAllStock().catch(() => {});
              setMerge({ loser: panel.claimants[0], other: panel.claimants[1] || null });
              setPanel(null);
            }}>⇄ Merge these…</BigButton>
          </div>
        </Panel>
      )}

      {merge && (
        <MergeProducts initialLoser={merge.loser} initialSurvivor={merge.other}
                       products={products} allStock={allStock} registry={registry}
                       onEnsureStock={ensureAllStock}
                       onScanLookup={lookupBarcode}
                       onClose={() => setMerge(null)}
                       onMerged={refreshAfterMerge} />
      )}

      {cameraOpen && (
        <CameraScanner title={tab === "register" ? "Scan the display" : "Scan the shoe"}
                       onScan={(code) => { setCameraOpen(false); handleCode(code); }}
                       onClose={() => setCameraOpen(false)} />
      )}

      <Toast msg={toast} />
    </div>
  );
}

// ─── REGISTER PANEL — scan → size (dominant) → quantity → done ───────────────
function RegisterPanel({ panel, hub, registered, duplicates, products, busy, onRegister, onExtra, onMerge, onClose }) {
  const { product } = panel;
  const sizes = realSizes(product);
  const [size, setSize] = useState(panel.size && sizes.includes(String(panel.size)) ? String(panel.size) : null);
  const [qty, setQty] = useState(1);

  const regFor = (s) => registered[`${product.id}__${stockSizeKey(s)}`] || null;
  const marks = {};
  for (const s of sizes) { const r = regFor(s); if (r) marks[s] = `✓${r.qty > 1 ? ` ${r.qty}` : ""}`; }

  const dup = openDuplicateFor(product.id, duplicates);
  const dupOther = dup ? products.find((p) => p && p.id === dup.otherId) : null;
  const existing = size ? regFor(size) : null;

  return (
    <Panel title="Register display" onClose={onClose}>
      {/* Photo visible but SECONDARY — the size picker below is the decision. */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18 }}>
        <Photo url={product.photoUrl} size={84} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.25 }}>{product.name}</div>
          <div style={{ fontSize: 12.5, color: GRAY, marginTop: 3 }}>Adds to {CLEANUP_HUB_LABELS[hub]} stock for the size you pick</div>
        </div>
      </div>

      {dup && (
        <div style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.35)", borderRadius: 13,
                      padding: "11px 13px", marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: AMBER }}>Possible duplicate</div>
          <div style={{ fontSize: 12.5, color: "rgba(253,233,176,.85)", margin: "4px 0 9px" }}>
            This product shares a style code with {dupOther ? <strong>{dupOther.name}</strong> : "another product"}.
          </div>
          <button type="button" onClick={() => onMerge(product, dupOther)}
            style={{ ...bGray, fontSize: 13, minHeight: 42 }}>⇄ Review &amp; merge…</button>
        </div>
      )}

      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".05em", color: "#fff", margin: "0 0 10px" }}>
        WHICH SIZE IS ON DISPLAY?
      </div>
      <SizeGrid sizes={sizes} chosen={size} onPick={setSize} marks={marks} disabled={busy} />

      {size && !existing && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "20px 0" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "rgba(233,238,255,.8)", flex: 1 }}>
              How many size <SizeTag size={size} /> on display?
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button type="button" disabled={busy || qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))}
                style={{ ...bGray, minWidth: 52, minHeight: 52, fontSize: 22, borderRadius: 13 }}>−</button>
              <span style={{ fontSize: 24, fontWeight: 900, minWidth: 34, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{qty}</span>
              <button type="button" disabled={busy} onClick={() => setQty((q) => q + 1)}
                style={{ ...bGray, minWidth: 52, minHeight: 52, fontSize: 22, borderRadius: 13 }}>+</button>
            </div>
          </div>
          <BigButton tone="green" disabled={busy} onClick={() => onRegister({ product, size, qty })}
                     style={{ minHeight: 68, fontSize: 19 }}>
            ✓ REGISTER — add {qty} to {CLEANUP_HUB_LABELS[hub]}
          </BigButton>
        </>
      )}

      {size && existing && (
        <div style={{ marginTop: 20 }}>
          <div style={{ background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.3)", borderRadius: 13,
                        padding: "12px 14px", marginBottom: 12, fontSize: 14, color: "#B7F0CC" }}>
            ✓ Already registered — {existing.qty} unit{existing.qty > 1 ? "s" : ""} of size <SizeTag size={size} />.
            Scanning it again adds nothing.
          </div>
          <BigButton tone="ghost" disabled={busy} onClick={() => onExtra({ product, size })}>
            This is a SECOND physical display — add one more
          </BigButton>
        </div>
      )}
    </Panel>
  );
}

// ─── COUNT PANEL — scan → size (dominant) → confirm quantity → continue ──────
function CountPanel({ panel, hub, hubStock, counted, busy, canAdjust, onRecord, onClose }) {
  const { product } = panel;
  const cells = hubStock[product.id] || {};
  const sizeKeys = useMemo(() => {
    const fromCells = Object.keys(cells).filter(isCountableSizeKey);
    const fromSizes = realSizes(product).map(stockSizeKey);
    return [...new Set([...fromCells, ...fromSizes])];
  }, [cells, product]);
  const scannedKey = panel.size ? stockSizeKey(String(panel.size)) : null;
  const [sizeKey, setSizeKey] = useState(scannedKey && sizeKeys.includes(scannedKey) ? scannedKey : null);
  const [actual, setActual] = useState("");

  const expected = sizeKey ? qtyOf(cells[sizeKey]) : 0;
  const record = sizeKey ? counted[cellKey(product.id, sizeKey)] : null;

  const marks = {};
  for (const k of sizeKeys) if (counted[cellKey(product.id, k)]) marks[sizeLabelOf(k)] = "✓";

  const labels = sizeKeys.map(sizeLabelOf);
  const keyByLabel = Object.fromEntries(sizeKeys.map((k) => [sizeLabelOf(k), k]));

  return (
    <Panel title="Count" onClose={onClose}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18 }}>
        <Photo url={product.photoUrl} size={84} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.25 }}>{product.name}</div>
          <div style={{ fontSize: 12.5, color: GRAY, marginTop: 3 }}>{CLEANUP_HUB_LABELS[hub]} · scan, confirm, continue</div>
        </div>
      </div>

      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".05em", margin: "0 0 10px" }}>WHICH SIZE ARE YOU COUNTING?</div>
      <SizeGrid sizes={labels} chosen={sizeKey ? sizeLabelOf(sizeKey) : null}
                onPick={(label) => { setSizeKey(keyByLabel[label]); setActual(""); }}
                marks={marks} disabled={busy} />

      {sizeKey && (
        <div style={{ marginTop: 22 }}>
          {record && (
            <div style={{ background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.3)", borderRadius: 13,
                          padding: "12px 14px", marginBottom: 12, fontSize: 14, color: "#B7F0CC" }}>
              ✓ Already counted this session ({record.action} · {record.actual}).
            </div>
          )}
          {!record && (
            <>
              <div style={{ textAlign: "center", margin: "6px 0 16px" }}>
                <div style={{ fontSize: 13, color: GRAY }}>System expects</div>
                <div style={{ fontSize: 44, fontWeight: 900, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{expected}</div>
                <div style={{ fontSize: 13, color: GRAY }}>pairs of size {sizeLabelOf(sizeKey)}</div>
              </div>
              <BigButton tone="green" disabled={busy} style={{ minHeight: 68, fontSize: 19 }}
                onClick={() => onRecord({ product, sizeKey, expected, actual: expected })}>
                ✓ SHELF MATCHES — {expected}
              </BigButton>
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <input inputMode="numeric" pattern="[0-9]*" value={actual} placeholder="Different? Enter the real count"
                       onChange={(e) => setActual(e.target.value.replace(/\D/g, ""))}
                       style={{ ...input, flex: 1, minHeight: 56, fontSize: 17, textAlign: "center" }} />
                <button type="button" disabled={busy || actual === ""}
                  onClick={() => onRecord({ product, sizeKey, expected, actual: Number(actual) })}
                  style={{ ...bGreen, minHeight: 56, padding: "0 20px", fontSize: 15, opacity: actual === "" ? 0.4 : 1 }}>
                  {canAdjust ? "Adjust" : "Flag"}
                </button>
              </div>
              {!canAdjust && (
                <div style={{ fontSize: 11.5, color: GRAY, marginTop: 8 }}>
                  Mismatches are flagged for an admin to apply — your count is never lost.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
