// ─── HUB STOCK CLEANUP — the combined Display Register + Hub Sneaker Count ────
// ONE card, one module, three passes over a hub's sneakers (owner spec
// 2026-08-06). Phone-first: this is used standing in a warehouse, at speed, by
// five people in parallel — so the size picker dominates, hit areas are big,
// and every flow is one decision per screen.
//
//   REGISTER (pass one)  FIND the shoe first — name search or the not-yet-
//                        registered list (a barcode scan is only an optional
//                        shortcut; nothing is created, every shoe already has
//                        a product record). One panel then captures TWO facts
//                        in ONE save: the style number off the label INSIDE
//                        the tongue (readStyleCodeLabel OCR or typed), and the
//                        size on display. The unit is ADDED to the hub's
//                        quantity — a `received` movement through
//                        applyMovement with a deterministic id (idempotent).
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
import { FONT, BG, CARD, BORDER, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bBlue, bGray, bGhost, input, tabOn, tabOff } from "./ui";
import { Toast } from "./widgets";
import { labelFor } from "./locations";
import { installBarcodeListener, subscribeBarcode } from "./barcodeListener";
import { canAdjustHubCount } from "../../config/hubSneakerCount";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { prepareLabelPhoto } from "../../utils/labelPhoto";
import { formatStyleCodeForDisplay, normaliseStyleCode } from "../../utils/styleCode";
import { isMergedAway } from "../../utils/mergedProducts";
import { interpretLabelScan } from "../../utils/labelScan";
import { mergeFrameTokens } from "../../utils/labelFrames";
import { Html5Qrcode } from "html5-qrcode";
import {
  CLEANUP_HUBS, CLEANUP_HUB_LABELS, resolveCleanupScan, openDuplicateFor,
  buildLeftovers, locationsHolding, registrationProgress, realSizes,
  registerPanelFor, styleStepSatisfied, chooseFromLabelRead, styleCodeOwners,
  STYLE_SKIP_REASONS, countPanelFor, resolveStyleNumber,
} from "./hubCleanupCore";
import {
  loadRegister, loadUnresolved, registerDisplayUnit, addExtraDisplayUnit,
  recordUnresolvedScan, lookupBarcode, loadAllStock, loadDuplicateCandidates,
  fetchProductFollowingMerge, lookupStyleClaim, matchLabelAlias, addLabelAlias,
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

// The tongue-label OCR — the SAME reader the style-code gate uses at intake.
const readStyleCodeLabelFn = httpsCallable(functions, "readStyleCodeLabel");
// Hidden mount node for the still-image QR/DataMatrix decode attempt — id is
// per-instance (a register panel can overlay a mounted count tab, so two
// readers can exist at once and must not collide on one DOM id).
let qrReaderSeq = 0;

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
        // Register mode builds its panel through registerPanelFor — the SAME
        // constructor the search results and the unregistered list use, so the
        // optional barcode shortcut lands on the identical screen.
        if (tab === "count") {
          setPanel(countPanelFor(out.product, out.size));
        } else {
          setPanel(registerPanelFor(out.product, out.size));
          // The panel shows stock by location — the shortcut must start that
          // load just like the search and list paths do.
          ensureAllStock().catch(() => {});
        }
      } else if (out.kind === "duplicate") {
        setPanel({ mode: "duplicate", code, claimants: out.products });
      } else if (tab === "count") {
        const noted = await recordUnresolvedScan({ hub, code, context: tab });
        if (noted.ok) {
          setUnresolved((u) => ({ ...u, [code.replace(/[.#$/\[\]\s]/g, "_").slice(0, 64) || "_"]: { code, context: tab } }));
          flash("warn", `Nothing owns “${code}” — noted as never registered. Carry on.`);
        } else {
          flash("err", `Nothing owns “${code}”, but the note could not be saved (${noted.message || "write failed"}) — try again.`);
        }
      } else {
        // The register shortcut missing is no event at all — the primary paths
        // (search, the unregistered list) are right there.
        flash("warn", `No product matches “${code}” — find the shoe by name instead.`);
      }
    } finally { setBusy(false); }
  }, [hub, tab, products, flash, ensureAllStock]);

  // ── The COUNT pass's primary entry: a STYLE NUMBER off the tongue label ──
  // (owner reversal 2026-08-06 — the count works exactly like registration
  // now). Resolution order: the /style_code_index claim (THE authority on who
  // owns a code, followed through any merge pointer), then the local catalogue
  // match. A number that reads cleanly but resolves to NOTHING is the
  // never-registered signal — recorded calmly in its own list, because that
  // detection is the point of this pass.
  const handleStyleNumber = useCallback(async (display) => {
    if (!hub) return;
    setBusy(true);
    try {
      const normalised = normaliseStyleCode(display);
      const claim = await lookupStyleClaim(normalised);
      const out = resolveStyleNumber(display, { products, claim });
      if (out.kind === "claim") {
        // The visible catalogue is pre-filtered of merged-away records, but the
        // guard costs nothing and this component must not depend on its caller
        // for that invariant.
        const local = products.find((x) => x && x.id === out.productId && !isMergedAway(x)) || null;
        let p = local;
        if (!p) {
          try {
            p = await fetchProductFollowingMerge(out.productId);
          } catch (err) {
            // A FAILED read is not a ghost — recording it as never-registered
            // would pollute the pass's primary signal with a false positive.
            flash("err", `Couldn't look that product up (${err?.message || err}) — try again.`);
            return;
          }
        }
        const cp = countPanelFor(p);
        if (cp) { setPanel(cp); return; }
        // A claim pointing at a ghost or id-less record falls through to
        // never-registered — with the toast, never a silent dead end.
      } else if (out.kind === "product") {
        setPanel(countPanelFor(out.product));
        return;
      } else if (out.kind === "duplicate") {
        setPanel({ mode: "duplicate", code: display, claimants: out.products });
        return;
      }
      const noted = await recordUnresolvedScan({ hub, code: display, context: "count" });
      if (noted.ok) {
        setUnresolved((u) => ({ ...u, [display.replace(/[.#$/\[\]\s]/g, "_").slice(0, 64) || "_"]: { code: display, context: "count" } }));
        flash("warn", `${display} reads cleanly but nothing owns it — noted as never registered. Carry on.`);
      } else {
        flash("err", `${display} isn't owned by anything, but the note could not be saved (${noted.message || "write failed"}) — try the scan again.`);
      }
    } finally { setBusy(false); }
  }, [hub, products, flash]);

  // ── The count's LABEL-READING path (owner design fix 2026-08-06) ──────────
  // A reading with no printed code is matched against the alias store by token
  // OVERLAP, never re-derived equality. Three bands: HIGH resolves silently;
  // MID shows the candidate LARGE and asks (a yes files the reading as another
  // alias, so the next scan of it is silent); LOW is the calm never-registered
  // path. A network failure is an error, never a false never-registered.
  const [aliasConfirm, setAliasConfirm] = useState(null);  // { tokens, candidates:[product], index }
  const handleAliasTokens = useCallback(async (tokens) => {
    if (!hub) return;
    setBusy(true);
    try {
      let match;
      try {
        match = await matchLabelAlias(tokens);
      } catch (err) {
        flash("err", `Couldn't check that reading (${err?.message || err}) — try again.`);
        return;
      }
      const resolveCandidate = async (pid) => {
        const local = products.find((x) => x && x.id === pid && !isMergedAway(x)) || null;
        return local || await fetchProductFollowingMerge(pid).catch(() => null);
      };
      if (match.band === "high" && match.candidates[0]) {
        const p = await resolveCandidate(match.candidates[0].productId);
        if (p) { setPanel(countPanelFor(p)); return; }
      }
      if (match.band === "high" || match.band === "mid") {
        const candidates = [];
        for (const c of match.candidates) {
          const p = await resolveCandidate(c.productId);
          if (p) candidates.push(p);
        }
        if (candidates.length) { setAliasConfirm({ tokens, candidates, index: 0 }); return; }
      }
      const preview = `reading: ${tokens.slice(0, 5).join(" ")}`;
      const noted = await recordUnresolvedScan({ hub, code: preview, context: "count" });
      if (noted.ok) {
        setUnresolved((u) => ({ ...u, [preview.replace(/[.#$/\[\]\s]/g, "_").slice(0, 64) || "_"]: { code: preview, context: "count" } }));
        flash("warn", "That label isn't registered to anything — noted as never registered. Carry on.");
      } else {
        flash("err", `That label isn't registered, but the note could not be saved (${noted.message || "write failed"}) — try again.`);
      }
    } finally { setBusy(false); }
  }, [hub, products, flash]);

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
  const doRegister = useCallback(async ({ product, size, qty, styleCode = null }) => {
    setBusy(true);
    try {
      // BOTH facts ride this one call — the size AND the style number.
      const res = await registerDisplayUnit({ hub, product, size, qty, styleCode });
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

        {/* ── REGISTER — find the shoe FIRST (owner correction 2026-08-06) ──
            Nothing is created here: every shoe already has a product record.
            The two equal ways in are the name search and the not-yet-registered
            list; both build their panel through registerPanelFor. A barcode
            scan survives only as a clearly-subordinate shortcut. ─────────── */}
        {!loading && tab === "register" && (
          <>
            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="Search the catalogue by name…"
                   autoFocus={false}
                   style={{ ...input, width: "100%", boxSizing: "border-box", minHeight: 58, fontSize: 17, fontWeight: 600 }} />
            {searchHits.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
                {searchHits.map((p) => (
                  <button key={p.id} type="button"
                    onClick={() => { setPanel(registerPanelFor(p)); setQuery(""); ensureAllStock().catch(() => {}); }}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", textAlign: "left", cursor: "pointer",
                             background: CARD, border: BORDER, borderRadius: 13 }}>
                    <Photo url={p.photoUrl} size={52} radius={10} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                      <div style={{ fontSize: 11.5, color: GRAY }}>
                        {p.styleCodeNormalised ? `style № on file · ` : ""}{realSizes(p).length} sizes
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* The other equal way in: what this hub holds that nobody has
                registered yet. Tap a shoe you are holding. */}
            {!query.trim() && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase",
                              color: "rgba(233,238,255,.55)", marginBottom: 8 }}>
                  Not yet registered — holds stock at {CLEANUP_HUB_LABELS[hub]}
                </div>
                {leftovers.length === 0 && (
                  <div style={{ fontSize: 13, color: GRAY, padding: "8px 2px" }}>
                    Everything holding stock here has been registered. Search above for anything else on the floor.
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {leftovers.map(({ product, hubQty }) => (
                    <button key={product.id} type="button"
                      onClick={() => { setPanel(registerPanelFor(product)); ensureAllStock().catch(() => {}); }}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", textAlign: "left", cursor: "pointer",
                               background: "rgba(12,16,30,.7)", border: "1px solid rgba(120,150,255,.22)", borderRadius: 13 }}>
                      <Photo url={product.photoUrl} size={52} radius={10} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{product.name}</div>
                        <div style={{ fontSize: 11.5, color: GRAY }}>{hubQty} in stock here · not seen on the floor yet</div>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 800, color: BLUE_L }}>Register →</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Optional shortcut only — never the default, never required. */}
            <div style={{ marginTop: 22, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,.07)" }}>
              <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.45)", marginBottom: 8 }}>
                Shortcut, if this shoe happens to carry one of our shop barcode stickers:
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={busy} onClick={() => setCameraOpen(true)}
                  style={{ ...bGhost, fontSize: 12.5, minHeight: 42, padding: "0 14px" }}>
                  Scan a shop barcode
                </button>
                <form onSubmit={(e) => { e.preventDefault(); const v = manual.trim(); setManual(""); if (v) handleCode(v); }}
                      style={{ display: "flex", gap: 6, flex: 1 }}>
                  <input value={manual} onChange={(e) => setManual(e.target.value)}
                         placeholder="…or type its digits"
                         style={{ ...input, flex: 1, minHeight: 42, fontSize: 12.5, opacity: 0.85 }} />
                  <button type="submit" style={{ ...bGhost, minHeight: 42, padding: "0 12px", fontSize: 12.5 }}>Go</button>
                </form>
              </div>
            </div>
          </>
        )}

        {/* ── COUNT — the TONGUE LABEL is the way in (owner reversal
            2026-08-06; this replaces barcode-scan-first). Same shared reader
            as registration: photo of the label inside the tongue, typed style
            number as the built-in fallback. Then name search, then the
            subordinate barcode shortcut. ───────────────────────────────────── */}
        {!loading && tab === "count" && (
          <>
            <div style={{ fontSize: 12, color: GRAY, margin: "0 2px 10px" }}>
              Pick up a shoe and photograph the label <u>inside the tongue</u> — the style number
              brings up its count. Not the shop barcode sticker, not the box.
            </div>
            <TongueLabelReader big busy={busy} onCode={(code) => handleStyleNumber(code)} onTokens={handleAliasTokens} />

            {/* Fallback 2 — search by name, small on purpose. */}
            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="…or search by name"
                   style={{ ...input, width: "100%", boxSizing: "border-box", marginTop: 10, fontSize: 13.5, opacity: 0.85 }} />
            {searchHits.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {searchHits.map((p) => (
                  <button key={p.id} type="button"
                    onClick={() => { setPanel(countPanelFor(p)); setQuery(""); }}
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

            {/* Fallback 3 — the shop-barcode shortcut. Optional, never the default. */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.07)" }}>
              <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.45)", marginBottom: 8 }}>
                Shortcut, if this shoe happens to carry one of our shop barcode stickers:
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={busy} onClick={() => setCameraOpen(true)}
                  style={{ ...bGhost, fontSize: 12.5, minHeight: 42, padding: "0 14px" }}>
                  Scan a shop barcode
                </button>
                <form onSubmit={(e) => { e.preventDefault(); const v = manual.trim(); setManual(""); if (v) handleCode(v); }}
                      style={{ display: "flex", gap: 6, flex: 1 }}>
                  <input value={manual} onChange={(e) => setManual(e.target.value)}
                         placeholder="…or type its digits"
                         style={{ ...input, flex: 1, minHeight: 42, fontSize: 12.5, opacity: 0.85 }} />
                  <button type="submit" style={{ ...bGhost, minHeight: 42, padding: "0 12px", fontSize: 12.5 }}>Go</button>
                </form>
              </div>
            </div>

            <button type="button" onClick={() => setFullList(true)}
              style={{ ...bGhost, width: "100%", marginTop: 14, minHeight: 46, borderRadius: 12, fontSize: 13 }}>
              Full list &amp; variance (browse every cell) →
            </button>

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
                       allStock={allStock} registry={registry}
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

      {/* MID-BAND CONFIRM — the candidate LARGE, one question, one tap. A yes
          files this reading as a further alias, so the next scan of it
          resolves silently; a no moves to the next candidate, then to search. */}
      {aliasConfirm && (() => {
        const cand = aliasConfirm.candidates[aliasConfirm.index];
        if (!cand) return null;
        return (
          <Panel title="Is this the shoe?" onClose={() => setAliasConfirm(null)}>
            <div style={{ textAlign: "center" }}>
              <Photo url={cand.photoUrl} size={220} radius={20} />
              <div style={{ fontSize: 22, fontWeight: 900, margin: "16px 0 6px", lineHeight: 1.3 }}>{cand.name}</div>
              <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 20 }}>
                Matched by this label's wording — confirm it and this reading files itself for next time.
              </div>
              <BigButton tone="green" disabled={busy} style={{ minHeight: 68, fontSize: 19 }}
                onClick={async () => {
                  const { tokens } = aliasConfirm;
                  setAliasConfirm(null);
                  addLabelAlias({ productId: cand.id, tokens }).catch(() => {});
                  setPanel(countPanelFor(cand));
                }}>
                ✓ YES — this is the shoe
              </BigButton>
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button type="button" disabled={busy}
                  onClick={() => {
                    const next = aliasConfirm.index + 1;
                    if (next < aliasConfirm.candidates.length) setAliasConfirm({ ...aliasConfirm, index: next });
                    else { setAliasConfirm(null); flash("warn", "None matched — find it by name below, or it was never registered."); }
                  }}
                  style={{ ...bGray, flex: 1, minHeight: 52, fontSize: 14 }}>
                  No — {aliasConfirm.index + 1 < aliasConfirm.candidates.length ? "show the next match" : "none of these"}
                </button>
                <button type="button" onClick={() => setAliasConfirm(null)}
                  style={{ ...bGhost, flex: 1, minHeight: 52, fontSize: 14 }}>Cancel</button>
              </div>
            </div>
          </Panel>
        );
      })()}

      {cameraOpen && (
        <CameraScanner title={tab === "register" ? "Scan the display" : "Scan the shoe"}
                       onScan={(code) => { setCameraOpen(false); handleCode(code); }}
                       onClose={() => setCameraOpen(false)} />
      )}

      <Toast msg={toast} />
    </div>
  );
}

// ─── LABEL CAMERA — three frames, not one ────────────────────────────────────
// Most OCR variance is single-frame noise, so the capture grabs THREE frames
// ~350ms apart in one press and the reader keeps only tokens seen in at least
// two (utils/labelFrames.js). Each frame is downscaled to ≤1024px before
// upload (same budget as prepareLabelPhoto) and the server caches per frame's
// image hash — so the three frames cost at most three vision calls ONCE, and
// a retake of any identical frame re-bills nothing.
function LabelCamera({ onFrames, onFallback, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState(null);
  const [shooting, setShooting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const grabFrame = () => new Promise((resolve) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) { resolve(null); return; }
    const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve({ base64: String(reader.result).split(",")[1] || "", blob });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }, "image/jpeg", 0.85);
  });

  const shoot = async () => {
    setShooting(true);
    const frames = [];
    for (let i = 0; i < 3; i++) {
      const f = await grabFrame();
      if (f) frames.push(f);
      if (i < 2) await new Promise((r) => setTimeout(r, 350));
    }
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    setShooting(false);
    if (frames.length) onFrames(frames);
    else onFallback();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.96)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", color: "#fff" }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>The label inside the tongue</div>
        <button onClick={onClose} style={{ ...bGhost, padding: "10px 16px", fontSize: 13 }}>Close</button>
      </div>
      {error ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ textAlign: "center", maxWidth: 320 }}>
            <div style={{ color: "#FF9B9B", fontSize: 14, lineHeight: 1.5, marginBottom: 14 }}>
              Camera stream unavailable — take a single photo instead.
            </div>
            <button onClick={onFallback} style={{ ...bBlue, minHeight: 50, padding: "0 20px", fontSize: 14 }}>📷 Take one photo</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            <video ref={videoRef} playsInline muted style={{ maxWidth: "100%", maxHeight: "100%" }} />
          </div>
          <div style={{ padding: "14px 18px 30px" }}>
            <div style={{ color: "rgba(255,255,255,.6)", fontSize: 12.5, textAlign: "center", marginBottom: 10 }}>
              Fold the tongue forward and fill the frame with the printed label. One press takes three quick frames.
            </div>
            <button onClick={shoot} disabled={shooting}
              style={{ width: "100%", minHeight: 62, borderRadius: 15, fontSize: 17, fontWeight: 800, fontFamily: FONT, cursor: "pointer",
                       background: "rgba(74,127,255,.2)", border: "2px solid rgba(74,127,255,.6)", color: "#D7E3FF",
                       opacity: shooting ? 0.6 : 1 }}>
              {shooting ? "Capturing 3 frames…" : "◉ Capture the label"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── TONGUE LABEL READER — the ONE style-number capture, shared by both passes ─
// Registration and the count bring a shoe's style number in identically: a
// photo of the label INSIDE the tongue goes through the same readStyleCodeLabel
// callable the intake gate uses (client-side downscale via prepareLabelPhoto;
// the server caches on the image-byte hash, so a retake of the same photo
// re-bills no vision call), with typed entry as the always-available fallback.
// Copy is explicit on purpose — the operator must never wonder whether this is
// the shop-barcode scan. It is not.
function TongueLabelReader({ busy, big = false, onCode, onTokens = null }) {
  const [qrId] = useState(() => `label-qr-still-reader-${++qrReaderSeq}`);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState(null);          // { text, options? }
  const [typed, setTyped] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileRef = useRef(null);

  // ── The shared frame pipeline (single photo OR three-frame burst) ─────────
  // Frames are OCR'd one by one; the FIRST format-valid code short-circuits
  // (that path is exact and confusable-guarded — unchanged). Only when NO
  // frame yields a code do the frames' token sets merge (≥2-of-3 agreement)
  // into a label READING for the alias store. Never a dead end.
  const processFrames = async (frames) => {
    setReading(true);
    setReadNote(null);
    try {
      // QR/DataMatrix on the first frame — deterministic beats OCR.
      try {
        const f = new File([frames[0].blob], "label.jpg", { type: "image/jpeg" });
        const scanner = new Html5Qrcode(qrId, false);
        const decoded = await scanner.scanFile(f, false);
        try { scanner.clear(); } catch { /* nothing mounted */ }
        const qr = interpretLabelScan(decoded);
        if (qr.kind === "code") {
          onCode(qr.code, { source: "label", labelPhoto: frames[0] });
          return;
        }
      } catch { /* no machine-readable code — OCR takes over */ }

      const frameTokens = [];
      let sawOptions = null;
      let frameError = null;
      for (const frame of frames) {
        // ONE frame failing (a transient request error) must not discard the
        // other frames' readings — a burst with two usable frames still
        // resolves; the error only surfaces when NOTHING usable remains.
        let data;
        try {
          ({ data } = await readStyleCodeLabelFn({ imageBase64: frame.base64, mimeType: "image/jpeg" }));
        } catch (err) {
          frameError = err;
          continue;
        }
        const out = chooseFromLabelRead(data);
        const formattedChosen = out.kind === "chosen" ? formatStyleCodeForDisplay(out.code) : "";
        if (out.kind === "chosen" && formattedChosen) {
          onCode(formattedChosen, { source: "label", labelPhoto: frame });
          return;
        }
        if (out.kind === "options" && !sawOptions) sawOptions = { out, frame };
        if (out.kind === "tokens") frameTokens.push(out.tokens);
      }
      if (sawOptions) {
        setReadNote({
          text: "The label shows more than one code-looking number — tap the style number:",
          options: sawOptions.out.options,
          labelPhoto: sawOptions.frame,
        });
        return;
      }
      const merged = mergeFrameTokens(frameTokens);
      if (merged.length >= 2 && onTokens) {
        onTokens(merged, { labelPhoto: frames[0] });
        return;
      }
      setReadNote({ text: frameError && frameTokens.length === 0
        ? `Could not read that label (${frameError?.message || frameError}) — try again, or type the style number.`
        : chooseFromLabelRead({ candidates: [] }).message });
    } catch (err) {
      setReadNote({ text: `Could not read that label (${err?.message || err}) — type the style number instead.` });
    } finally { setReading(false); }
  };

  const handleLabelPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setReading(true);
    try {
      const photo = await prepareLabelPhoto(file);
      await processFrames([photo]);
    } catch (err) {
      setReadNote({ text: `Could not read that photo (${err?.message || err}) — type the style number instead.` });
      setReading(false);
    }
  };

  const applyTyped = () => {
    const v = typed.trim();
    if (!v) return;
    const formatted = formatStyleCodeForDisplay(v);
    if (!formatted) {
      // Normalises to nothing (punctuation only, etc.) — say so instead of
      // silently arming a blank code that disables the save with no explanation.
      setReadNote({ text: `“${v}” doesn't look like a style number — check the label inside the tongue.` });
      return;
    }
    setTyped("");
    setReadNote(null);
    onCode(formatted, { source: "manual", labelPhoto: null });
  };

  return (
    <div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
             onChange={handleLabelPhoto} style={{ display: "none" }} />
      <BigButton tone="blue" disabled={busy || reading} onClick={() => setCameraOpen(true)}
                 style={big ? { minHeight: 84, fontSize: 20 } : { minHeight: 64, fontSize: 17 }}>
        {reading ? "Reading the tongue label…" : "📷 Photograph the tongue label"}
      </BigButton>
      {cameraOpen && (
        <LabelCamera
          onFrames={(frames) => { setCameraOpen(false); processFrames(frames); }}
          onFallback={() => { setCameraOpen(false); fileRef.current && fileRef.current.click(); }}
          onClose={() => setCameraOpen(false)} />
      )}
      <div id={qrId} style={{ display: "none" }} />
      {readNote && (
        <div style={{ marginTop: 10, background: "rgba(251,191,36,.07)", border: "1px solid rgba(251,191,36,.25)",
                      borderRadius: 11, padding: "9px 12px", fontSize: 12.5, color: "#FDE9B0" }}>
          {readNote.text}

          {readNote.options && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
              {readNote.options.map((c) => (
                <button key={c} type="button"
                  onClick={() => {
                    const f = formatStyleCodeForDisplay(c);
                    if (!f) { setReadNote({ text: "That one isn't a style number — type it from the label instead." }); return; }
                    setReadNote(null);
                    onCode(f, { source: "label", labelPhoto: readNote.labelPhoto || null });
                  }}
                  style={{ ...bBlue, fontSize: 13.5, minHeight: 42, fontVariantNumeric: "tabular-nums" }}>{c}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); applyTyped(); }}
            style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)}
               placeholder="…or type the style number, e.g. CT8527-016"
               style={{ ...input, flex: 1, minHeight: 48, fontSize: 15 }} />
        <button type="submit" disabled={!typed.trim()} style={{ ...bGray, minHeight: 48, padding: "0 16px" }}>Set</button>
      </form>
    </div>
  );
}

// ─── REGISTER PANEL — one screen, two facts, one save ────────────────────────
// The operator found the shoe already (search / the unregistered list / the
// optional barcode shortcut). This panel attaches BOTH facts to the existing
// product in a single action: the manufacturer STYLE NUMBER read off the label
// INSIDE the tongue, and the SIZE currently on display. The size grid stays
// visually dominant; nothing here creates a product.
function RegisterPanel({ panel, hub, registered, duplicates, products, busy, allStock, registry,
                         onRegister, onExtra, onMerge, onClose }) {
  const { product } = panel;
  const sizes = realSizes(product);
  const [size, setSize] = useState(panel.size && sizes.includes(String(panel.size)) ? String(panel.size) : null);
  const [qty, setQty] = useState(1);

  // ── The style-number step's state ──────────────────────────────────────────
  const codeOnFile = product.styleCodeNormalised || null;
  const [chosenCode, setChosenCode] = useState(null);      // display form, chosen or typed
  const [codeSource, setCodeSource] = useState(null);      // "label" | "manual"
  const [labelPhoto, setLabelPhoto] = useState(null);      // prepareLabelPhoto result, evidence
  const [skipReason, setSkipReason] = useState(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [aliasTokens, setAliasTokens] = useState(null);    // a label READING (no printed code)
  const [onFileReaderOpen, setOnFileReaderOpen] = useState(false); // optional alias capture for coded products

  // The shared tongue-label reader hands back the chosen code — one capture
  // path for BOTH passes (owner reversal 2026-08-06), never a second build.
  const takeCode = (code, { source, labelPhoto: photo }) => {
    setChosenCode(code);
    setCodeSource(source);
    setLabelPhoto(source === "label" ? photo : null);
    setAliasTokens(null);
    setSkipReason(null);
  };
  // A reading with no printed article number: filed as an ALIAS on save —
  // never into styleCodeNormalised, so a product that already carries a code
  // simply gains another way to be found (no immutability dead end, ever).
  const takeTokens = (tokens) => {
    setAliasTokens(tokens);
    setChosenCode(null);
    setCodeSource(null);
    setLabelPhoto(null);
    setSkipReason(null);
  };

  // The duplicate fence: a code some OTHER live product already carries means
  // one of the two records is a twin — route to Merge, never save into it.
  const conflictOwners = chosenCode ? styleCodeOwners(chosenCode, products, product.id) : [];
  // Order matters: a captured READING outranks the null default even when a
  // code is on file — the store files it as an alias alongside the code.
  const styleCodePayload = skipReason
    ? { skipped: skipReason }
    : chosenCode
      ? { code: chosenCode, source: codeSource || "manual", labelPhoto: codeSource === "label" ? labelPhoto : null }
      : aliasTokens
        ? { aliasTokens }
        : null;
  const styleReady = styleStepSatisfied(product, styleCodePayload) && conflictOwners.length === 0;

  const regFor = (s) => registered[`${product.id}__${stockSizeKey(s)}`] || null;
  const marks = {};
  for (const s of sizes) { const r = regFor(s); if (r) marks[s] = `✓${r.qty > 1 ? ` ${r.qty}` : ""}`; }

  const dup = openDuplicateFor(product.id, duplicates);
  const dupOther = dup ? products.find((p) => p && p.id === dup.otherId) : null;
  const existing = size ? regFor(size) : null;

  const stockLocs = allStock ? locationsHolding(product.id, allStock) : null;

  const SKIP_LABELS = {
    label_unreadable: "Label is there but unreadable",
    label_missing: "Tongue label is missing",
    no_code_exists: "This brand prints no style number",
  };

  return (
    <Panel title="Register display" onClose={onClose}>
      {/* The shoe the operator selected — photo, name, where its stock is. */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 10 }}>
        <Photo url={product.photoUrl} size={84} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.25 }}>{product.name}</div>
          <div style={{ fontSize: 12.5, color: GRAY, marginTop: 3 }}>Adds to {CLEANUP_HUB_LABELS[hub]} stock for the size you pick</div>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {stockLocs === null && <span style={{ fontSize: 11.5, color: GRAY }}>Loading stock by location…</span>}
        {stockLocs && stockLocs.length === 0 && <span style={{ fontSize: 11.5, color: GRAY }}>No stock recorded anywhere yet.</span>}
        {(stockLocs || []).map(({ loc, qty: q }) => (
          <span key={loc} style={{ fontSize: 12, fontWeight: 800, padding: "5px 10px", borderRadius: 9,
                                   fontVariantNumeric: "tabular-nums",
                                   background: q < 0 ? "rgba(248,113,113,.12)" : "rgba(74,127,255,.1)",
                                   border: q < 0 ? "1px solid rgba(248,113,113,.35)" : "1px solid rgba(74,127,255,.28)",
                                   color: q < 0 ? "#FFC9C9" : "#CFE0FF" }}>
            {labelFor(loc, registry)} · {q}
          </span>
        ))}
      </div>

      {dup && (
        <div style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.35)", borderRadius: 13,
                      padding: "11px 13px", marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: AMBER }}>Possible duplicate</div>
          <div style={{ fontSize: 12.5, color: "rgba(253,233,176,.85)", margin: "4px 0 9px" }}>
            This product shares a style number with {dupOther ? <strong>{dupOther.name}</strong> : "another product"}.
          </div>
          <button type="button" onClick={() => onMerge(product, dupOther)}
            style={{ ...bGray, fontSize: 13, minHeight: 42 }}>⇄ Review &amp; merge…</button>
        </div>
      )}

      {/* ── FACT 1 — THE STYLE NUMBER, off the label INSIDE the tongue ──────
          NOT a shop barcode sticker and NOT the box label. Copy stays explicit
          everywhere so the operator can never confuse the two scans. */}
      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".05em", margin: "0 0 4px" }}>
        1 · STYLE NUMBER — the label <u>inside the tongue</u>
      </div>
      <div style={{ fontSize: 12, color: GRAY, marginBottom: 10 }}>
        Fold the tongue forward: the small printed label with a code like CT8527-016.
        Not the shop barcode sticker, not the box.
      </div>

      {codeOnFile ? (
        <div style={{ marginBottom: 18 }}>
          <div style={{ background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.3)", borderRadius: 13,
                        padding: "12px 14px", fontSize: 14, color: "#B7F0CC" }}>
            ✓ Style number already on file: <strong>{product.styleCode || formatStyleCodeForDisplay(codeOnFile)}</strong>
            <div style={{ fontSize: 11.5, color: GRAY, marginTop: 4 }}>
              Nothing to capture — check it matches the tongue label of the shoe in your hand.
            </div>
          </div>
          {/* A coded product can STILL gain a label reading as a further way to
              be found — an alias, never a second code, so the immutability
              rule cannot object (owner mandate: never a dead end). */}
          {aliasTokens ? (
            <div style={{ marginTop: 10, fontSize: 12.5, color: "#B7F0CC" }}>
              ✓ Label wording captured too ({aliasTokens.slice(0, 4).join(" · ")}{aliasTokens.length > 4 ? " …" : ""}) —
              it files as an extra way to find this shoe.
              <button type="button" onClick={() => setAliasTokens(null)}
                style={{ ...bGhost, fontSize: 11.5, minHeight: 34, padding: "0 10px", marginLeft: 8 }}>✕</button>
            </div>
          ) : !onFileReaderOpen ? (
            <button type="button" onClick={() => setOnFileReaderOpen(true)}
              style={{ background: "none", border: "none", color: "rgba(233,238,255,.42)", textDecoration: "underline",
                       fontSize: 12, marginTop: 8, cursor: "pointer", fontFamily: FONT }}>
              Also capture the label wording (optional)
            </button>
          ) : (
            <div style={{ marginTop: 10 }}>
              <TongueLabelReader busy={busy} onCode={takeCode} onTokens={takeTokens} />
            </div>
          )}
        </div>
      ) : chosenCode && conflictOwners.length === 0 ? (
        <div style={{ background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.3)", borderRadius: 13,
                      padding: "12px 14px", marginBottom: 18, fontSize: 14, color: "#B7F0CC",
                      display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1 }}>✓ Style number: <strong>{chosenCode}</strong> <span style={{ color: GRAY, fontSize: 11.5 }}>({codeSource === "label" ? "read off the tongue label" : "typed"})</span></span>
          <button type="button" onClick={() => { setChosenCode(null); setCodeSource(null); }}
            style={{ ...bGhost, fontSize: 12, minHeight: 38, padding: "0 12px" }}>✎ Change</button>
        </div>
      ) : chosenCode && conflictOwners.length > 0 ? (
        <div style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.4)", borderRadius: 13,
                      padding: "12px 14px", marginBottom: 18 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: AMBER }}>
            {chosenCode} already belongs to {conflictOwners[0].name}
          </div>
          <div style={{ fontSize: 12.5, color: "rgba(253,233,176,.85)", margin: "5px 0 10px", lineHeight: 1.5 }}>
            Two records, one shoe — this is the duplicate case. Merge them (or go back and
            register under {conflictOwners[0].name} instead). Saving this code here is blocked.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => onMerge(product, conflictOwners[0])}
              style={{ ...bGray, fontSize: 13, minHeight: 44, flex: 1 }}>⇄ Review &amp; merge…</button>
            <button type="button" onClick={() => { setChosenCode(null); setCodeSource(null); }}
              style={{ ...bGhost, fontSize: 13, minHeight: 44 }}>Re-enter</button>
          </div>
        </div>
      ) : aliasTokens ? (
        <div style={{ background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.3)", borderRadius: 13,
                      padding: "12px 14px", marginBottom: 18, fontSize: 14, color: "#B7F0CC",
                      display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1 }}>✓ Label reading captured — no printed article number; the label's own wording
            ({aliasTokens.slice(0, 4).join(" · ")}{aliasTokens.length > 4 ? " …" : ""}) will identify this shoe.</span>
          <button type="button" onClick={() => setAliasTokens(null)}
            style={{ ...bGhost, fontSize: 12, minHeight: 38, padding: "0 12px" }}>✎ Retake</button>
        </div>
      ) : skipReason ? (
        <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 13,
                      padding: "12px 14px", marginBottom: 18, fontSize: 13, color: "rgba(233,238,255,.75)",
                      display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1 }}>No style number — {SKIP_LABELS[skipReason]}</span>
          <button type="button" onClick={() => setSkipReason(null)}
            style={{ ...bGhost, fontSize: 12, minHeight: 38, padding: "0 12px" }}>✎ Change</button>
        </div>
      ) : (
        <div style={{ marginBottom: 18 }}>
          <TongueLabelReader busy={busy} onCode={takeCode} onTokens={takeTokens} />
          {!skipOpen ? (
            <button type="button" onClick={() => setSkipOpen(true)}
              style={{ background: "none", border: "none", color: "rgba(233,238,255,.42)", textDecoration: "underline",
                       fontSize: 12, marginTop: 10, cursor: "pointer", fontFamily: FONT }}>
              This shoe has no readable style number
            </button>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10 }}>
              {STYLE_SKIP_REASONS.map((r) => (
                <button key={r} type="button" onClick={() => { setSkipReason(r); setSkipOpen(false); }}
                  style={{ ...bGhost, fontSize: 12.5, minHeight: 42 }}>{SKIP_LABELS[r]}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── FACT 2 — THE SIZE ON DISPLAY (the dominant control) ───────────── */}
      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".05em", margin: "0 0 10px" }}>
        2 · WHICH SIZE IS ON DISPLAY?
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
          {/* ONE action, BOTH facts. Disabled until the style-number step is
              satisfied (on file, captured, or deliberately skipped) AND a size
              is picked — never split into a second screen. */}
          <BigButton tone="green" disabled={busy || !styleReady}
                     onClick={() => onRegister({ product, size, qty, styleCode: styleCodePayload })}
                     style={{ minHeight: 68, fontSize: 19 }}>
            ✓ REGISTER — size {size}{codeOnFile || chosenCode ? " + style number" : aliasTokens ? " + label reading" : ""}
          </BigButton>
          {!styleReady && (
            <div style={{ fontSize: 12, color: AMBER, marginTop: 8 }}>
              {conflictOwners.length > 0
                ? "Resolve the duplicate above first."
                : "Capture the style number off the tongue label first (or mark it unreadable)."}
            </div>
          )}
        </>
      )}

      {size && existing && (
        <div style={{ marginTop: 20 }}>
          <div style={{ background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.3)", borderRadius: 13,
                        padding: "12px 14px", marginBottom: 12, fontSize: 14, color: "#B7F0CC" }}>
            ✓ Already registered — {existing.qty} unit{existing.qty > 1 ? "s" : ""} of size <SizeTag size={size} />.
            Registering it again adds nothing.
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
