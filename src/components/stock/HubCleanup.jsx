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
import { formatStyleCodeForDisplay, normaliseStyleCode } from "../../utils/styleCode";
import { perSizeAutoCandidate } from "../../utils/perSizeStyleCode";
import { buildLinkSuggestions } from "../../utils/linkSuggestions";
import { isMergedAway } from "../../utils/mergedProducts";
import {
  CLEANUP_HUBS, CLEANUP_HUB_LABELS, resolveCleanupScan, openDuplicateFor,
  buildLeftovers, locationsHolding, registrationProgress, realSizes,
  registerPanelFor, styleStepSatisfied, styleCodeOwners, collisionQuestion,
  STYLE_SKIP_REASONS, countPanelFor, resolveStyleNumber, registerSearchPool,
  DISPLAY_STORES, DISPLAY_STORE_LABELS,
} from "./hubCleanupCore";
import {
  loadRegister, loadUnresolved, registerDisplayUnit, addExtraDisplayUnit,
  recordUnresolvedScan, lookupBarcode, loadAllStock, loadDuplicateCandidates,
  fetchProductFollowingMerge, lookupStyleClaim, matchLabelAlias, addLabelAlias,
  answerStyleCodeSibling, lookupCodeAlias, recordLabelCodes, unresolvedScanKey,
  fetchColourwayAnswers, recordColourwayAnswer,
} from "./hubCleanupStore";
import { allRegisteredSiblings, claimOwnerIds } from "../../utils/styleCodeSiblings";
import {
  extractDominantColours, orderByColourAffinity, selectByColourAffinity, matchColourwayAnswers,
} from "../../utils/dominantColours";
import {
  loadHubStock, openOrResumeSession, loadCounted, publishSessionTotal,
  confirmCell, adjustCell, flagCell, useLocationRegistryOnce, rememberHub, rememberedHub,
} from "./hubCountStore";
import { isCountableSizeKey, cellKey, sizeLabelOf, recordIsCurrent } from "./hubCountCore";
import { loadOffShelfSources, offShelfForCell, expectedOnShelf } from "./offShelf";
import { loadDisplaySlots } from "./displaySlots";
import { stockSizeKey } from "../../utils/sizeKey";
import CameraScanner from "./CameraScanner.jsx";
import { TongueLabelReader } from "./TongueLabelReader.jsx";
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
  // Off-shelf sources (offShelf.js): display slots, legacy register rows, ready
  // orders, the layby blind-spot count. Loaded when the count session opens and
  // frozen like the stock snapshot; the SLOT half is re-read per cell inside
  // CountPanel so a display changing size mid-count is read at its CURRENT size.
  // A FAILED load blocks counting (never a silent booked-totals fallback) and
  // the panel offers this retry.
  const [offSources, setOffSources] = useState(null);
  const [offError, setOffError] = useState("");
  const loadOffShelf = useCallback((forHub) => {
    setOffError("");
    loadOffShelfSources(forHub, new Map((products || []).map((p) => [p?.id, p])))
      .then((src) => setOffSources(src))
      .catch((err) => setOffError(String(err?.message || err)));
    // products identity churns with the live catalogue; the map is rebuilt per call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);
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
    setOffSources(null);
    setOffError("");
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
        // The off-shelf picture loads WITH the session: without it the panel
        // would show booked totals and the count would destroy display units —
        // the exact bug this rework removes. A failed load BLOCKS counting
        // (the panel offers a retry); partial data is never presented as
        // complete (CodeRabbit, PR #347).
        loadOffShelf(hub);
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
  }, [hub, tab, session, hubStock, flash, loadOffShelf]);

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
        // 2+ products answer to this code. NEVER resolve silently — the picker
        // shows them side by side. The index says whether they are registered
        // colourway SIBLINGS (legitimate, no merge banner) or an unexplained
        // collision (merge stays on offer).
        const claim = await lookupStyleClaim(normaliseStyleCode(code)).catch(() => null);
        // Index owners this device has not loaded must be SURFACED, exactly as
        // the style-number path surfaces them — otherwise this entry point
        // presents a partial list as a complete one.
        const loadedIds = new Set(out.products.map((p) => p.id));
        const unloadedIds = claimOwnerIds(claim).filter((id) =>
          !loadedIds.has(id) && !(products || []).some((x) => x && x.id === id));
        setPanel({
          mode: "choose", code, claimants: out.products,
          siblings: allRegisteredSiblings(claim, out.products.map((p) => p.id)) && !unloadedIds.length,
          unloadedIds,
        });
      } else if (tab === "count") {
        const noted = await recordUnresolvedScan({ hub, code, context: tab });
        if (noted.ok) {
          setUnresolved((u) => ({ ...u, [unresolvedScanKey(code)]: { code, context: tab } }));
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
  const handleStyleNumber = useCallback(async (display, meta = null) => {
    if (!hub) return;
    setBusy(true);
    try {
      const normalised = normaliseStyleCode(display);
      // The label printed MORE than one code-shaped token (tapped or
      // auto-picked). Once the shoe resolves, EVERY token files as an identity
      // of that product — a conflict (a token another product owns) surfaces
      // through the duplicate flow, never silently (owner spec 2026-08-08).
      const fileAllCodes = async (productId) => {
        const all = meta && Array.isArray(meta.allCodes) && meta.allCodes.length > 1 ? meta.allCodes : null;
        if (!all || !productId) return;
        try {
          const res = await recordLabelCodes({
            productId, chosenCode: normalised,
            otherCodes: all.filter((c) => normaliseStyleCode(c) !== normalised),
          });
          if (res && res.conflicts && res.conflicts.length) {
            const codes = res.conflicts.map((c) => formatStyleCodeForDisplay(c.code) || c.code).join(", ");
            flash("warn", `${codes} on this label already belongs to another product — flagged as a possible duplicate for review.`, 9000);
          }
        } catch { /* best-effort — the count itself must never block on this */ }
      };
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
        if (cp) { fileAllCodes(p.id); setPanel(cp); return; }
        // A claim pointing at a ghost or id-less record falls through to
        // never-registered — with the toast, never a silent dead end.
      } else if (out.kind === "product") {
        fileAllCodes(out.product.id);
        setPanel(countPanelFor(out.product));
        return;
      } else if (out.kind === "choose") {
        // 2+ owners — colourway siblings or a genuine collision, the picker
        // shows them LARGE and the operator picks. Never silent (owner spec
        // 2026-08-07): a wrong silent pick is count corruption.
        setPanel({
          mode: "choose", code: display, claimants: out.products,
          siblings: out.siblings, unloadedIds: out.unloadedIds || [],
          allCodes: meta && Array.isArray(meta.allCodes) ? meta.allCodes : null,
        });
        return;
      }
      // Nothing claims or carries this code — but it may be the OTHER token of
      // a multi-token label someone already resolved: the exact code-alias
      // store answers (owner spec 2026-08-08 — whichever token a colleague
      // tapped, this one lands on the same product).
      // A FAILED lookup is not "no alias" — swallowing it would write a false
      // never-registered note for a code the alias store may well know
      // (CodeRabbit, PR #334).
      let aliasOwner = null;
      try {
        aliasOwner = await lookupCodeAlias(normalised);
      } catch (err) {
        flash("err", `Couldn't check ${display} against the label-code index (${err?.message || err}) — try again.`);
        return;
      }
      if (aliasOwner) {
        let p = products.find((x) => x && x.id === aliasOwner && !isMergedAway(x)) || null;
        if (!p) {
          try {
            p = await fetchProductFollowingMerge(aliasOwner);
          } catch (err) {
            // A FAILED read is not a ghost — a KNOWN identity must never land
            // on the never-registered list because the network blinked (Kimi
            // review, PR #334; same rule as the claim branch above).
            flash("err", `${display} is a known label code, but its product couldn't be loaded (${err?.message || err}) — try again.`);
            return;
          }
        }
        const cp = p ? countPanelFor(p) : null;
        if (cp) { fileAllCodes(p.id); setPanel(cp); return; }
        // p is genuinely gone (alias points at nothing live) — fall through
        // to the link offer; the operator decides what this code is.
      }
      // THE PER-SIZE RULE (owner spec 2026-08-12, utils/perSizeStyleCode.js):
      // Lacoste prints a different article reference per SIZE — same prefix,
      // same colourway suffix, one article digit moved. When exactly ONE
      // registered product is a per-size sibling of this code, that IS the
      // shoe: file the alias without asking and count it. Two candidates, or
      // a conflict the server can see that this client cannot, drop to the
      // link panel — never a guess. A DIFFERENT colourway suffix never gets
      // here (the rule refuses it), because same fit in another colour is a
      // different product.
      const openLink = () => setPanel({
        mode: "link", kind: "code", display, normalised,
        allCodes: meta && Array.isArray(meta.allCodes) ? meta.allCodes : null,
        // The label's printed model line, when the OCR carried one — the
        // panel's second-strongest suggestion source (linkSuggestions.js).
        modelName: meta && typeof meta.modelName === "string" ? meta.modelName : null,
      });
      const p = perSizeAutoCandidate(normalised, products);
      if (p) {
        try {
          const res = await recordLabelCodes({
            productId: p.id, chosenCode: normalised,
            otherCodes: (meta && Array.isArray(meta.allCodes) ? meta.allCodes : [])
              .filter((c) => normaliseStyleCode(c) !== normalised),
          });
          if (res && res.conflicts && res.conflicts.some((c) => c.code === normalised)) {
            // The server knows an owner this client could not see — flagged
            // for review over there; over here the human decides, never the rule.
            flash("warn", `${display} already belongs to another product — flagged for review. Pick the shoe yourself.`, 8000);
            openLink();
            return;
          }
          const otherClashes = (res && res.conflicts ? res.conflicts : []).filter((c) => c.code !== normalised);
          if (otherClashes.length) {
            const codes = otherClashes.map((c) => formatStyleCodeForDisplay(c.code) || c.code).join(", ");
            flash("warn", `${codes} on this label already belongs to another product — flagged as a possible duplicate for review.`, 9000);
          } else {
            flash("ok", `${display} is “${p.name}” — this brand prints a different code per size. Linked; the next scan resolves by itself.`, 6500);
          }
        } catch (err) {
          flash("warn", `${display} matched “${p.name}” (per-size label), but the link could not be saved (${err?.message || err}) — the next scan will match again.`, 8000);
        }
        setPanel(countPanelFor(p));
        return;
      }
      // A clean read nothing owns NEVER dead-ends (the Lacoste labels blocked
      // a live count exactly here). The operator is holding a real shoe —
      // offer "this is the same shoe as…" with a product search; the pick
      // files a code alias through the existing labelAlias door, so the next
      // scan of this size resolves silently. "Note as never registered"
      // survives inside the panel as the deliberate answer, not the automatic
      // one.
      openLink();
    } finally { setBusy(false); }
  }, [hub, products, flash]);

  // ── The count's LABEL-READING path (owner design fix 2026-08-06) ──────────
  // A reading with no printed code is matched against the alias store by token
  // OVERLAP, never re-derived equality. Three bands: HIGH resolves silently;
  // MID shows the candidate LARGE and asks (a yes files the reading as another
  // alias, so the next scan of it is silent); LOW is the calm never-registered
  // path. A network failure is an error, never a false never-registered.
  const [aliasConfirm, setAliasConfirm] = useState(null);  // { tokens, candidates:[product], index, modelName }
  const handleAliasTokens = useCallback(async (tokens, meta = null) => {
    if (!hub) return;
    // A code-less read still often prints the MODEL NAME — it rides the meta
    // and feeds the link panel's name tier (CodeRabbit, PR #349).
    const modelName = meta && typeof meta.modelName === "string" ? meta.modelName : null;
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
        if (candidates.length) { setAliasConfirm({ tokens, candidates, index: 0, modelName }); return; }
      }
      // A reading nothing matches NEVER dead-ends (same rule as the
      // style-number path): offer the link panel — the pick files this reading
      // as a token alias, so the next read of this label resolves. The match
      // call's own candidates ride along: below-band scores were previously
      // DISCARDED here, which is how the panel opened blank on the floor —
      // now they seed the suggestion list (linkSuggestions.js, alias tier).
      const preview = `reading (${tokens.length} tokens): ${tokens.slice(0, 5).join(" ")}`;
      setPanel({ mode: "link", kind: "tokens", tokens, preview, modelName,
                 aliasCandidates: match && Array.isArray(match.candidates) ? match.candidates : null });
    } finally { setBusy(false); }
  }, [hub, products, flash]);

  useEffect(() => {
    const uninstall = installBarcodeListener();
    const unsub = subscribeBarcode((value) => { handleCode(value); });
    return () => { unsub(); uninstall(); };
  }, [handleCode]);

  // Secondary path: type a name/code. Scan stays primary.
  const [query, setQuery] = useState("");
  // UNCAPPED (owner fix: the old { limit: 12 } silently truncated name
  // searches — the full set only ever appeared via a barcode hit). Every match
  // is reachable; RENDERING is paged (SEARCH_PAGE at a time) so a broad query
  // cannot stall the phone.
  const SEARCH_PAGE = 60;
  const [searchShown, setSearchShown] = useState(SEARCH_PAGE);
  useEffect(() => { setSearchShown(SEARCH_PAGE); }, [query, tab]);
  const searchHits = useMemo(() => {
    if (!query.trim()) return [];
    // The REGISTER search lists footwear ONLY — sneakers, soccer boots and the
    // rest of the footwear group — through the ONE cross-app classifier
    // (productIsFootwear, src/utils/footwearLine.js; soccer-boots is already a
    // FOOTWEAR_CATEGORY_KEYS member). Clothing, perfume, bags and accessories
    // can never appear. The classifier is preferred over the raw category
    // field, and it is deliberately NOT widened here: it is mirrored byte-for-
    // byte in marathon-pos-app, where it decides hub-vs-shop deduction.
    const pool = tab === "register" ? registerSearchPool(products) : products;
    return searchProducts(pool, query, { limit: Infinity });
  }, [products, query, tab]);

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
  const doRegister = useCallback(async ({ product, size, qty, styleCode = null, store = null }) => {
    setBusy(true);
    try {
      // ALL the facts ride this one call — size, style number AND the shop
      // the display stands at (the slot the count reads).
      const res = await registerDisplayUnit({ hub, product, size, qty, styleCode, store });
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

  const doExtra = useCallback(async ({ product, size, store = null }) => {
    setBusy(true);
    try {
      const res = await addExtraDisplayUnit({ hub, product, size, store });
      if (!res.ok) { flash("err", res.message || "Could not add."); return; }
      setRegistered(await loadRegister(hub));
      setHubStock(await loadHubStock(hub));
      if (res.warning) flash("warn", res.warning, 8000);
      else flash("ok", `One more size ${size} added.`);
    } finally { setBusy(false); }
  }, [hub, flash]);

  // ── Count writes (the proven fences) ───────────────────────────────────────
  const canAdjust = canAdjustHubCount(viewer);
  // `actual` is the SHELF count; `offShelf` the units the system knows stand
  // elsewhere (displays at shops, ready orders). The stores compute every
  // delta as shelf + offShelf − booked, so an honest count never destroys an
  // off-shelf unit (owner spec 2026-08-12).
  const doCount = useCallback(async ({ product, sizeKey, expected, actual, offShelf = 0, offShelfNote = null }) => {
    if (!session) return;
    setBusy(true);
    try {
      const args = { hub, sessionId: session.sessionId, productId: product.id, sizeKey, expected, offShelf, offShelfNote };
      const shelfExpected = expected - offShelf;
      const res = actual === shelfExpected
        ? await confirmCell(args)
        : canAdjust
          ? await adjustCell({ ...args, actual, actorRole })
          : await flagCell({ ...args, actual });
      if (!res.ok) {
        flash(res.stale ? "warn" : "err", res.message || "Could not record.", 6500);
        // The fence rejected because the cell moved (a POS sale, a released
        // shipment). Pull that ONE cell back into the frozen snapshot so the
        // panel's next attempt is against the number the fence will accept —
        // without this a released-then-recounted cell loops on the same toast.
        if (res.stale && typeof res.live === "number") {
          setHubStock((s) => {
            if (!s) return s;
            const node = { ...(s[product.id] || {}) };
            node[sizeKey] = { ...(node[sizeKey] || {}), qty: res.live };
            return { ...s, [product.id]: node };
          });
        }
        return;
      }
      setCounted((c) => ({ ...c, [cellKey(product.id, sizeKey)]: res.record }));
      if (res.warning) flash("warn", res.warning, 9000);
      else flash("ok", actual === shelfExpected ? "Confirmed." : canAdjust ? `Shelf adjusted to ${actual}${offShelf ? ` (+${offShelf} off-shelf stays booked)` : ""}.` : `Flagged for an admin (${actual}).`);
    } finally { setBusy(false); }
  }, [hub, session, canAdjust, actorRole, flash]);

  // ── The LINK panel's two exits (owner spec 2026-08-12) ─────────────────────
  // A pick files the reading through the EXISTING labelAlias door — a code
  // files as an exact code alias (recordLabelCodes), a token reading as a
  // token alias (addLabelAlias) — then counting continues on the picked
  // product. Filing is best-effort: a failed write warns and still opens the
  // count (the human vouched for the identity; blocking the count on a network
  // blink is the exact dead-end this panel removes). Note-as-never-registered
  // is the deliberate second exit, with the same failed-write honesty as ever.
  const doLinkPick = useCallback(async (p) => {
    if (!panel || panel.mode !== "link" || !p) return;
    setBusy(true);
    try {
      if (panel.kind === "code") {
        const shown = formatStyleCodeForDisplay(panel.normalised) || panel.display;
        try {
          const res = await recordLabelCodes({
            productId: p.id, chosenCode: panel.normalised,
            otherCodes: (panel.allCodes || []).filter((c) => normaliseStyleCode(c) !== panel.normalised),
          });
          const clash = res && res.conflicts && res.conflicts.find((c) => c.code === panel.normalised);
          if (clash) {
            flash("warn", `${shown} already belongs to another product — flagged as a possible duplicate for review. Counting “${p.name}” anyway.`, 9000);
          } else {
            flash("ok", `${shown} linked to “${p.name}” — the next scan of this label resolves by itself.`);
          }
        } catch (err) {
          flash("warn", `Counting “${p.name}”, but the link could not be saved (${err?.message || err}) — the next scan of ${shown} will ask again.`, 8000);
        }
      } else {
        try {
          await addLabelAlias({ productId: p.id, tokens: panel.tokens });
          flash("ok", `Label linked to “${p.name}” — the next read of it resolves by itself.`);
        } catch (err) {
          flash("warn", `Counting “${p.name}”, but the link could not be saved (${err?.message || err}) — the next read will ask again.`, 8000);
        }
      }
      setPanel(countPanelFor(p));
      setQuery("");
    } finally { setBusy(false); }
  }, [panel, flash]);

  const doLinkNote = useCallback(async () => {
    if (!panel || panel.mode !== "link") return;
    const label = panel.kind === "code" ? panel.display : panel.preview;
    setBusy(true);
    try {
      const noted = await recordUnresolvedScan({ hub, code: label, context: "count" })
        .catch((e) => ({ ok: false, message: String(e?.message || e) }));
      if (noted.ok) {
        setUnresolved((u) => ({ ...u, [unresolvedScanKey(label)]: { code: label, context: "count" } }));
        setPanel(null);
        flash("warn", `${label} noted as never registered. Carry on.`);
      } else {
        flash("err", `The note could not be saved (${noted.message || "write failed"}) — try again.`);
      }
    } finally { setBusy(false); }
  }, [panel, hub, flash]);

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
                {searchHits.slice(0, searchShown).map((p) => (
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
                {searchHits.length > searchShown && (
                  <button type="button" onClick={() => setSearchShown((n) => n + SEARCH_PAGE)}
                    style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.14)", color: "rgba(233,238,255,.75)",
                             borderRadius: 12, minHeight: 46, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
                    Show more — {searchHits.length - searchShown} of {searchHits.length} matches below
                  </button>
                )}
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
            {/* The layby blind spot, said plainly rather than hidden: those
                pulls carry no product or size, so no cell's shelf number can
                ever include them (offShelf.js header). */}
            {offSources && offSources.laybyItems > 0 && (
              <div style={{ fontSize: 11.5, color: AMBER, margin: "0 2px 10px", lineHeight: 1.5,
                            background: "rgba(251,191,36,.06)", border: "1px solid rgba(251,191,36,.22)",
                            borderRadius: 10, padding: "8px 11px" }}>
                {offSources.laybyItems} layby unit{offSources.laybyItems === 1 ? "" : "s"} pulled to shops are
                still booked at this hub, and the layby records carry no product or size — a shelf here can be
                short by units this screen cannot name. If a shortfall looks layby-shaped, flag it rather than
                adjusting.
              </div>
            )}
            <TongueLabelReader big busy={busy} onCode={(code, meta) => handleStyleNumber(code, meta)} onTokens={handleAliasTokens} />

            {/* Fallback 2 — search by name, small on purpose. */}
            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="…or search by name"
                   style={{ ...input, width: "100%", boxSizing: "border-box", marginTop: 10, fontSize: 13.5, opacity: 0.85 }} />
            {searchHits.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {searchHits.slice(0, searchShown).map((p) => (
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
                {searchHits.length > searchShown && (
                  <button type="button" onClick={() => setSearchShown((n) => n + SEARCH_PAGE)}
                    style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.14)", color: "rgba(233,238,255,.75)",
                             borderRadius: 12, minHeight: 46, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
                    Show more — {searchHits.length - searchShown} of {searchHits.length} matches below
                  </button>
                )}
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
                    offSources={offSources} offError={offError} onRetryOffShelf={() => loadOffShelf(hub)}
                    registry={registry}
                    onRecord={doCount} onClose={() => setPanel(null)} />
      )}
      {/* ── THE PICKER — one code, several products, the HUMAN decides ──────
          (Owner spec 2026-08-07.) A code owning 2+ products NEVER resolves
          silently: every candidate is shown LARGE with its photo, side by
          side, and the operator taps the shoe in their hand or says "none of
          these". When the index vouches for all of them (registered colourway
          siblings) this is routine, not an error, and no merge banner appears;
          an UNexplained collision keeps the merge route available — but
          subordinate, because counting the shoe is the job at hand. */}
      {panel && panel.mode === "choose" && (
        <ChoosePanel panel={panel} tab={tab} busy={busy}
                     onPick={(p) => {
                       // Whichever way the pick landed (tap, photo auto-select,
                       // remembered answer), a multi-token label's OTHER codes
                       // file as identities of the picked product too.
                       if (panel.allCodes && panel.allCodes.length > 1 && panel.code) {
                         const chosen = normaliseStyleCode(panel.code);
                         recordLabelCodes({
                           productId: p.id, chosenCode: chosen,
                           otherCodes: panel.allCodes.filter((c) => normaliseStyleCode(c) !== chosen),
                         }).catch(() => {});
                       }
                       if (tab === "count") { setPanel(countPanelFor(p)); }
                       else { setPanel(registerPanelFor(p)); ensureAllStock().catch(() => {}); }
                     }}
                     onNone={async () => {
                       // "None of these — new colourway." Creating products
                       // happens in Add Sneaker (admin), not here — record the
                       // sighting so the pass's ledger knows, and say what to do.
                       // A FAILED write must not be confirmed as "Noted": the
                       // panel stays open and says so, because a sighting that
                       // silently vanished is a hole in the pass's ledger.
                       const label = `${panel.code} (new colourway)`;
                       const noted = await recordUnresolvedScan({ hub, code: label, context: tab }).catch((e) => ({ ok: false, message: String(e?.message || e) }));
                       if (!noted?.ok) {
                         flash("err", `Couldn't save the new-colourway sighting (${noted?.message || "write failed"}) — try again.`);
                         return;
                       }
                       setUnresolved((u) => ({
                         ...u,
                         [unresolvedScanKey(label)]: { code: label, context: tab },
                       }));
                       setPanel(null);
                       flash("warn", `Noted — “${panel.code}” on a colourway we don't have. Register it in Admin → Add Sneaker; the code will attach as a sibling.`);
                     }}
                     onMerge={async () => {
                       await ensureAllStock().catch(() => {});
                       setMerge({ loser: panel.claimants[0], other: panel.claimants[1] || null });
                       setPanel(null);
                     }}
                     onClose={() => setPanel(null)} />
      )}

      {/* ── THE LINK PANEL — a scan must NEVER dead-end (owner spec
          2026-08-12) ── a clean label read nothing owns offers "this is the
          same shoe as…" with a product search. The pick files the reading
          through the existing labelAlias mechanism so the next scan resolves
          silently; "never registered" survives as the deliberate answer. */}
      {panel && panel.mode === "link" && (
        <LinkPanel key={`lnk_${panel.kind === "code" ? panel.normalised : (panel.tokens || []).join("_")}`}
                   panel={panel} products={products} busy={busy}
                   onPick={doLinkPick} onNote={doLinkNote} onClose={() => setPanel(null)} />
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
                    else {
                      // Every candidate said no — same rule as everywhere else:
                      // never a dead end. The link panel takes over. The
                      // rejected candidates must NOT resurface as suggestions:
                      // the operator just said, one by one, that none of them
                      // is this shoe.
                      const { tokens, candidates, modelName } = aliasConfirm;
                      setAliasConfirm(null);
                      setPanel({ mode: "link", kind: "tokens", tokens, modelName: modelName || null,
                                 preview: `reading (${tokens.length} tokens): ${tokens.slice(0, 5).join(" ")}`,
                                 excludeIds: candidates.map((p) => p.id) });
                    }
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

// ─── LINK PANEL — a scan must NEVER dead-end (owner spec 2026-08-12) ─────────
// The Lacoste incident: the brand prints a DIFFERENT article reference per
// size (745SMA004-21G is the UK 6.5, 745SMA006-21G the UK 9.5 of ONE shoe), so
// a product registered off one size's label rejected every other size during
// the live hub count. This panel is the generic unblocking move for every
// brand that does this, known or not: a clean read nothing owns offers "this
// is the same shoe as…" with a product search. The pick files the reading
// through the EXISTING label-alias mechanism (PR #329/#334 — recordLabelCodes
// for a printed code, addLabelAlias for a token reading), so the next scan of
// this label resolves silently. No product record is created, merged or
// modified here — an alias row is the ONLY write. "Never registered" stays
// available as the deliberate second exit.
function LinkPanel({ panel, products, busy, onPick, onNote, onClose }) {
  const [q, setQ] = useState("");
  // UNCAPPED, like every other search in this file (the { limit: 12 } cap
  // silently truncated name searches once already — see the count search's
  // comment). Rendering is paged so a broad query cannot stall the phone.
  const LINK_PAGE = 12;
  const [linkShown, setLinkShown] = useState(LINK_PAGE);
  useEffect(() => { setLinkShown(LINK_PAGE); }, [q]);
  const hits = useMemo(() => (q.trim() ? searchProducts(products, q, { limit: Infinity }) : []), [products, q]);
  const shown = panel.kind === "code" ? (formatStyleCodeForDisplay(panel.normalised) || panel.display) : null;

  // ── RANKED SUGGESTIONS — the panel must never open BLANK (owner spec
  // 2026-08-13) ── an empty search box sent the operator hunting BY NAME,
  // the exact duplicate-creating behaviour the style-code system removes.
  // buildLinkSuggestions ranks the in-memory catalogue against everything
  // this label gave us — code family, near-miss codes, the printed model
  // name, the alias store's own candidates — with zero extra reads. Tapping
  // one goes through the SAME onPick as a search hit: the operator decides,
  // nothing auto-links.
  const suggestions = useMemo(() => buildLinkSuggestions({
    kind: panel.kind, normalised: panel.normalised, modelName: panel.modelName,
    tokens: panel.tokens, aliasCandidates: panel.aliasCandidates,
    excludeIds: panel.excludeIds, products,
  }), [panel, products]);
  const SUGGEST_PAGE = 4;
  const [suggestShown, setSuggestShown] = useState(SUGGEST_PAGE);

  return (
    <Panel title="Nothing owns this label — link it" onClose={onClose}>
      <div style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.5, marginBottom: 6 }}>
        {shown ? <>“{shown}” reads cleanly but isn't registered to any product.</>
               : <>This label's wording doesn't match anything registered.</>}
      </div>
      <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.55, marginBottom: 14 }}>
        Some brands print a different code on every size of the same shoe. If this is a shoe
        we already have, link it — the next scan of this label will resolve by itself.
      </div>

      {suggestions.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase",
                        color: "rgba(233,238,255,.55)", marginBottom: 8 }}>
            Is it one of these? Compare the shoe in your hand to the photo.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {suggestions.slice(0, suggestShown).map((s) => (
              <button key={s.product.id} type="button" disabled={busy} onClick={() => onPick(s.product)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 12px", textAlign: "left",
                         cursor: "pointer", background: "rgba(74,127,255,.08)",
                         border: "1px solid rgba(120,150,255,.35)", borderRadius: 13 }}>
                <Photo url={s.product.photoUrl} size={72} radius={12} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.product.name}</div>
                  {s.code && (
                    <div style={{ fontSize: 11.5, color: GRAY, fontVariantNumeric: "tabular-nums" }}>
                      {formatStyleCodeForDisplay(s.code)}{s.field === "pending" ? " (pending)" : ""}
                    </div>
                  )}
                  <div style={{ fontSize: 11.5, color: "#AFC6FF", lineHeight: 1.45, marginTop: 3 }}>
                    {s.reasons.join(" · ")}
                  </div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 800, color: BLUE_L, flexShrink: 0 }}>Link →</span>
              </button>
            ))}
          </div>
          {suggestions.length > suggestShown && (
            <button type="button" onClick={() => setSuggestShown((n) => n + SUGGEST_PAGE)}
              style={{ width: "100%", marginTop: 8, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.14)",
                       color: "rgba(233,238,255,.75)", borderRadius: 12, minHeight: 44, fontSize: 13, fontWeight: 700,
                       cursor: "pointer", fontFamily: FONT }}>
              Show {suggestions.length - suggestShown} more suggestion{suggestions.length - suggestShown === 1 ? "" : "s"}
            </button>
          )}
        </div>
      ) : (
        // NOTHING scored — say so plainly (never dress a weak match up as a
        // suggestion) and hand over to search as the honest fallback.
        <div style={{ fontSize: 12.5, color: AMBER, lineHeight: 1.5, marginBottom: 14,
                      background: "rgba(251,191,36,.06)", border: "1px solid rgba(251,191,36,.22)",
                      borderRadius: 10, padding: "8px 11px" }}>
          No registered code or label reading is close to this one — no suggestions to offer.
          If the shoe is in the catalogue, find it by name below.
        </div>
      )}

      <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.45)", margin: "0 0 6px" }}>
        {suggestions.length > 0 ? "Not one of these? Search by name — the last resort:" : "Search by name:"}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus={suggestions.length === 0}
             placeholder="This is the same shoe as…"
             style={{ ...input, width: "100%", boxSizing: "border-box", minHeight: 54, fontSize: 16, fontWeight: 600 }} />
      {hits.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
          {hits.slice(0, linkShown).map((p) => (
            <button key={p.id} type="button" disabled={busy} onClick={() => onPick(p)}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", textAlign: "left",
                       cursor: "pointer", background: CARD, border: BORDER, borderRadius: 13 }}>
              <Photo url={p.photoUrl} size={52} radius={10} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div style={{ fontSize: 11.5, color: GRAY }}>
                  {p.styleCodeNormalised ? `${formatStyleCodeForDisplay(p.styleCodeNormalised)} · ` : ""}{realSizes(p).length} sizes
                </div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 800, color: BLUE_L }}>Link →</span>
            </button>
          ))}
          {hits.length > linkShown && (
            <button type="button" onClick={() => setLinkShown((n) => n + LINK_PAGE)}
              style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.14)", color: "rgba(233,238,255,.75)",
                       borderRadius: 12, minHeight: 46, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
              Show more — {hits.length - linkShown} of {hits.length} matches below
            </button>
          )}
        </div>
      )}
      {q.trim() && hits.length === 0 && (
        <div style={{ fontSize: 13, color: GRAY, padding: "10px 2px" }}>No product matches “{q}”.</div>
      )}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,.07)" }}>
        <BigButton tone="ghost" disabled={busy} onClick={onNote} style={{ minHeight: 52, fontSize: 14 }}>
          It's genuinely not in the catalogue — note as never registered
        </BigButton>
      </div>
    </Panel>
  );
}

// ─── CHOOSE PANEL — one code, several products: let the MACHINE look first ───
// (Owner spec 2026-08-08, superseding the 2026-08-07 ordering-only rule for
// REGISTERED SIBLING sets.) The code alone can never say which colourway the
// operator is holding — an automatic choice from the code would be wrong half
// the time, silently. So the decision comes from the SHOE:
//
//   1. quick photo → dominant colours (the existing capture + extraction path);
//   2. a previously ANSWERED question for this code whose stored palette
//      matches this photo resolves SILENTLY — the same physical shoe is never
//      asked twice (matchColourwayAnswers, fail-closed on any disagreement);
//   3. else the photo auto-selects ONLY when one candidate wins by a clear
//      margin over the runner-up (selectByColourAffinity — any missing stored
//      palette, washed-out photo or near tie refuses);
//   4. else the side-by-side picker asks, ordered likeliest-first — and the
//      human's tap (with its palette) is STORED so step 2 answers next time.
//
// UNexplained collisions (siblings=false) keep the human-only flow: those
// candidates may be the same shoe twice, and the merge question is not one a
// photo can answer. "None of these" is always present — a colourway we have
// no record for is a real answer, not a failure.
function ChoosePanel({ panel, tab, busy, onPick, onNone, onMerge, onClose }) {
  const [photoColours, setPhotoColours] = useState(null);
  const [shooting, setShooting] = useState(false);
  const [autoNote, setAutoNote] = useState(null);
  const fileRef = useRef(null);
  const siblings = !!panel.siblings;

  // Candidates enriched with palettes. Most existing products carry no stored
  // dominantColours (the field only lands when a shoe photo was taken at
  // registration) — without this, the margin decision would fail closed on
  // every legacy product forever. The palette is computed once from the
  // product's own stored photo (CORS-enabled bucket) and kept in-session;
  // nothing is written back. A photo that cannot be read stays palette-less,
  // and selectByColourAffinity then refuses to auto-pick — fail closed.
  const paletteCache = useRef({});
  const [enriched, setEnriched] = useState(null);
  const enrichCandidates = async () => {
    const list = await Promise.all(panel.claimants.map(async (p) => {
      if (!p) return p;
      if (Array.isArray(p.dominantColours) && p.dominantColours.length) return p;
      if (!(p.id in paletteCache.current)) {
        paletteCache.current[p.id] = p.photoUrl ? await extractDominantColours(p.photoUrl).catch(() => []) : [];
      }
      const dc = paletteCache.current[p.id];
      return dc && dc.length ? { ...p, dominantColours: dc } : p;
    }));
    setEnriched(list);
    return list;
  };
  const candidates = enriched || panel.claimants;
  const ordered = photoColours ? orderByColourAffinity(candidates, photoColours) : candidates;

  // Earlier answers for this code — fetched once; a failed fetch degrades to
  // asking (never to a broken picker). Only sibling sets use them.
  const [answers, setAnswers] = useState(null);
  useEffect(() => {
    if (!siblings || !panel.code) return;
    let cancelled = false;
    fetchColourwayAnswers(normaliseStyleCode(panel.code))
      .then((rows) => { if (!cancelled) setAnswers(rows); })
      .catch(() => { if (!cancelled) setAnswers([]); });
    return () => { cancelled = true; };
  }, [siblings, panel.code]);

  // The pick IS the answer — store it against the shoe's signature (code +
  // the palette of the photo that DROVE this pick) so the question is never
  // asked twice for this physical shoe. The palette is passed EXPLICITLY by
  // the photo handler: the auto path decides before setPhotoColours commits,
  // so reading the state here would record the PREVIOUS photo's palette (or
  // none) against this answer — a stale signature that could silently
  // resolve a different shoe to the wrong colourway later (Kimi review,
  // PR #334). Best-effort: a failed store just means one more ask.
  const pick = (p, { remember = true, palette = photoColours } = {}) => {
    if (remember && siblings && panel.code && palette) {
      recordColourwayAnswer({
        code: normaliseStyleCode(panel.code), productId: p.id, palette,
      }).catch(() => {});
    }
    onPick(p);
  };

  async function handleShoePhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setShooting(true);
    try {
      const colours = await extractDominantColours(file);
      if (!colours.length) { setPhotoColours(null); return; }
      if (siblings) {
        // Step 2 — the remembered answer. Already human-vouched, so it needs
        // no re-remembering; fail-closed matching inside.
        const remembered = matchColourwayAnswers(answers || [], colours);
        const rememberedProduct = remembered ? panel.claimants.find((c) => c && c.id === remembered) : null;
        if (rememberedProduct) { pick(rememberedProduct, { remember: false }); return; }
        // Step 3 — the margin decision, against every candidate's stored
        // image (palettes computed on the fly where not stored). `auto` only
        // on a clear win — and an auto pick is NEVER stored as an answer:
        // the answer store is human decisions only, or a margin-cleared guess
        // could later bypass the margin through step 2 (CodeRabbit, PR #334).
        // Only the HUMAN's tap below is remembered.
        const withPalettes = await enrichCandidates();
        const decided = selectByColourAffinity(withPalettes, colours);
        if (decided.kind === "auto") { pick(decided.product, { remember: false }); return; }
        setAutoNote("The photo can't separate these on colour — tap the shoe in your hand.");
      }
      setPhotoColours(colours);
    } finally { setShooting(false); }
  }

  return (
    <Panel title={siblings ? "Which colourway is it?" : "One code, more than one product"} onClose={onClose}>
      <div style={{ fontSize: 14.5, color: siblings ? "#CFE0FF" : "#FDE9B0", lineHeight: 1.5, marginBottom: 14 }}>
        {siblings ? (
          <>“{panel.code}” is on <strong>{panel.claimants.length} colourways</strong> — the label can't
            tell them apart, but you can. Tap the shoe in your hand.</>
        ) : (
          <>“{panel.code}” is on <strong>{panel.claimants.length + (panel.unloadedIds?.length || 0)} products</strong>.
            Tap the one in your hand — nothing is guessed for you.</>
        )}
      </div>

      <input ref={fileRef} type="file" accept="image/*" capture="environment"
             onChange={handleShoePhoto} style={{ display: "none" }} />
      <button type="button" disabled={busy || shooting} onClick={() => fileRef.current && fileRef.current.click()}
        style={{ ...bGhost, fontSize: 12.5, minHeight: 44, marginBottom: 12, width: "100%" }}>
        {shooting ? "Reading the colours…"
          : photoColours ? "📷 Photo taken — likely match is first. Retake?"
          : siblings ? "📷 Photo the shoe — a clear colour match picks it for you"
          : "📷 Quick photo of the shoe (optional) — puts the likely match first"}
      </button>
      {autoNote && (
        <div style={{ fontSize: 12, color: AMBER, margin: "-4px 0 10px", lineHeight: 1.5 }}>{autoNote}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {ordered.map((p, i) => (
          <button key={p.id} type="button" disabled={busy} onClick={() => pick(p)}
            style={{ display: "flex", alignItems: "center", gap: 14, padding: 14, width: "100%",
                     background: CARD, border: photoColours && i === 0 ? "2px solid rgba(74,127,255,.55)" : BORDER,
                     borderRadius: 16, cursor: "pointer", textAlign: "left", fontFamily: FONT, color: "inherit" }}>
            <Photo url={p.photoUrl} size={120} radius={14} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.3 }}>{p.name}</div>
              {photoColours && i === 0 && (
                <div style={{ fontSize: 11.5, color: BLUE_L, marginTop: 4 }}>Closest colour match — check it, don't trust it</div>
              )}
            </div>
            <span style={{ fontSize: 12, fontWeight: 900, color: BLUE_L }}>TAP</span>
          </button>
        ))}
      </div>

      {(panel.unloadedIds || []).length > 0 && (
        <div style={{ fontSize: 12, color: AMBER, marginTop: 10, lineHeight: 1.5 }}>
          {panel.unloadedIds.length} more product{panel.unloadedIds.length > 1 ? "s" : ""} own this code but
          {panel.unloadedIds.length > 1 ? " aren't" : " isn't"} loaded on this device — reload before trusting this list.
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <BigButton tone="ghost" disabled={busy} onClick={onNone}>
          None of these — it's a new colourway
        </BigButton>
      </div>

      {/* The merge route survives ONLY for unexplained collisions. Registered
          siblings are two real products — offering to merge them invites
          destroying a colourway. */}
      {!siblings && (
        <button type="button" disabled={busy} onClick={onMerge}
          style={{ ...bGhost, fontSize: 12.5, minHeight: 44, marginTop: 10, width: "100%" }}>
          ⇄ These are the SAME product twice — review &amp; merge…
        </button>
      )}
    </Panel>
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
  // FACT 3 — which shop floor the display stands on (owner spec 2026-08-12:
  // one display SLOT per product per store; the count reads the slot). Required
  // for a NEW registration; on an already-registered display it is the way to
  // attach the store a legacy row never captured.
  const [dispStore, setDispStore] = useState(null);

  // ── The style-number step's state ──────────────────────────────────────────
  const codeOnFile = product.styleCodeNormalised || null;
  const [chosenCode, setChosenCode] = useState(null);      // display form, chosen or typed
  const [codeSource, setCodeSource] = useState(null);      // "label" | "manual"
  const [labelPhoto, setLabelPhoto] = useState(null);      // prepareLabelPhoto result, evidence
  const [skipReason, setSkipReason] = useState(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [aliasTokens, setAliasTokens] = useState(null);    // a label READING (no printed code)
  const [allCodes, setAllCodes] = useState(null);          // every code token on a multi-token label
  const [onFileReaderOpen, setOnFileReaderOpen] = useState(false); // optional alias capture for coded products

  // The shared tongue-label reader hands back the chosen code — one capture
  // path for BOTH passes (owner reversal 2026-08-06), never a second build.
  const takeCode = (code, { source, labelPhoto: photo, allCodes: codes = null }) => {
    setChosenCode(code);
    setCodeSource(source);
    setLabelPhoto(source === "label" ? photo : null);
    // Every code-shaped token the label printed (multi-token labels) — the
    // save files them ALL as identities of this product (owner spec 2026-08-08).
    setAllCodes(Array.isArray(codes) && codes.length > 1 ? codes : null);
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

  // The collision fence — but no longer a wall. A code some OTHER live product
  // carries CHANGES MEANING here (owner spec 2026-08-07): the operator has
  // already found and selected this product, a human has vouched for the
  // identity, so the collision is a QUESTION — "same shoe, or a different
  // colourway?" — never an automatic duplicate and never a silent save.
  //   same shoe          → the genuine duplicate: route to the existing merge.
  //   different colourway → registered as a SIBLING owner via styleCodeSibling;
  //                         both keep the code, neither is flagged.
  const conflictOwners = chosenCode ? styleCodeOwners(chosenCode, products, product.id) : [];
  // Answered "different colourway" for THIS code (or the index already lists
  // this product as a sibling owner — checked below). Keyed by the normalised
  // code so re-entering a different code re-asks.
  const [siblingOkFor, setSiblingOkFor] = useState(null);
  const [siblingBusy, setSiblingBusy] = useState(false);
  const [siblingErr, setSiblingErr] = useState(null);
  const chosenNormalised = chosenCode ? normaliseStyleCode(chosenCode) : null;
  const siblingOk = !!chosenNormalised && siblingOkFor === chosenNormalised;

  // If the index ALREADY registers this product and the conflicting owner(s)
  // as siblings of this code — a previously answered pair — don't re-ask.
  useEffect(() => {
    let stale = false;
    if (!chosenNormalised || !conflictOwners.length || siblingOk) return undefined;
    lookupStyleClaim(chosenNormalised).then((claim) => {
      if (stale || !claim) return;
      const ids = [product.id, ...conflictOwners.map((p) => p.id)];
      if (allRegisteredSiblings(claim, ids)) setSiblingOkFor(chosenNormalised);
    }).catch(() => {});
    return () => { stale = true; };
    // conflictOwners is derived from chosenCode+products; the code is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenNormalised, product.id, siblingOk]);

  // Order matters: a captured READING outranks the null default even when a
  // code is on file — the store files it as an alias alongside the code.
  const styleCodePayload = skipReason
    ? { skipped: skipReason }
    : chosenCode
      ? { code: chosenCode, source: codeSource || "manual", labelPhoto: codeSource === "label" ? labelPhoto : null,
          ...(allCodes ? { allCodes } : {}) }
      : aliasTokens
        ? { aliasTokens }
        : null;
  const styleReady = styleStepSatisfied(product, styleCodePayload)
    && collisionQuestion({ conflictOwners, siblingOk }) !== "ask";

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
      ) : chosenCode && conflictOwners.length > 0 && !siblingOk ? (
        /* ── THE COLLISION QUESTION (owner spec 2026-08-07) ─────────────────
           The operator has the shoe in hand and has already vouched for the
           product above. The code being on another product is therefore ONE
           question, answered by a human, recorded either way — never a block,
           never an automatic merge, never silent. Both products are shown
           LARGE with photos: colour lives in the photo, not the name. */
        <div style={{ background: "rgba(74,127,255,.06)", border: "1px solid rgba(74,127,255,.35)", borderRadius: 13,
                      padding: "14px", marginBottom: 18 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 10 }}>
            {chosenCode} is already on {conflictOwners.length > 1 ? `${conflictOwners.length} shoes` : "this shoe"}:
          </div>
          {/* EVERY conflicting owner is shown — the answer below covers all of
              them, so the operator must see all of them. Showing one of three
              and resolving three would be a silent decision about the other two. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
            {[...conflictOwners, product].map((p, i) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: 12,
                                       background: CARD, border: BORDER, borderRadius: 14 }}>
                <Photo url={p.photoUrl} size={110} radius={12} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15.5, fontWeight: 800, lineHeight: 1.3 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: GRAY, marginTop: 3 }}>
                    {i < conflictOwners.length ? "Already carries this code" : "The product you selected"}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13.5, color: "#CFE0FF", lineHeight: 1.55, marginBottom: 12 }}>
            <strong>Is {conflictOwners.length > 1 ? "any of those the same shoe" : "that the same shoe"}, or a
            different colourway?</strong> The tongue label prints no colour, so one code on several
            colourways is normal — look at the photos.
          </div>
          {siblingErr && (
            <div style={{ fontSize: 12.5, color: RED, marginBottom: 10 }}>{siblingErr}</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <BigButton tone="blue" disabled={busy || siblingBusy}
              onClick={async () => {
                // DIFFERENT COLOURWAY → registered as a sibling, both keep the
                // code, neither is flagged. The answer is recorded server-side.
                setSiblingBusy(true); setSiblingErr(null);
                try {
                  // ONE answer per conflicting owner: with three products on a
                  // code, "different colourway" must register this product
                  // against EVERY one of them, or the unanswered pairs would be
                  // resolved silently the moment styleReady opens. (The first
                  // call registers the sibling; the rest are idempotent
                  // alreadyOwner confirmations that record the answer.)
                  for (const other of conflictOwners) {
                    await answerStyleCodeSibling({
                      action: "differentColourway", code: chosenNormalised,
                      productId: product.id, otherId: other.id,
                    });
                  }
                  setSiblingOkFor(chosenNormalised);
                } catch (err) {
                  setSiblingErr(`Couldn't record that (${err?.message || err}) — try again.`);
                } finally { setSiblingBusy(false); }
              }}>
              {siblingBusy ? "Recording…" : conflictOwners.length > 1 ? "DIFFERENT colourway to ALL of these — keep them all" : "DIFFERENT colourway — keep both"}
            </BigButton>
            <BigButton tone="ghost" disabled={busy || siblingBusy}
              onClick={async () => {
                // SAME SHOE → the genuine duplicate. Record the answer, then the
                // EXISTING merge flow takes over — nothing merges from here.
                answerStyleCodeSibling({
                  action: "sameShoe", code: chosenNormalised,
                  productId: product.id, otherId: conflictOwners[0].id,
                }).catch(() => {});
                onMerge(product, conflictOwners[0]);
              }}>
              {conflictOwners.length > 1 ? "SAME as one of these — review & merge…" : "SAME shoe — review & merge…"}
            </BigButton>
            <button type="button" onClick={() => { setChosenCode(null); setCodeSource(null); setSiblingErr(null); }}
              style={{ ...bGhost, fontSize: 13, minHeight: 44 }}>Re-enter the code</button>
          </div>
        </div>
      ) : chosenCode && conflictOwners.length > 0 && siblingOk ? (
        <div style={{ background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.3)", borderRadius: 13,
                      padding: "12px 14px", marginBottom: 18, fontSize: 14, color: "#B7F0CC" }}>
          ✓ Style number: <strong>{chosenCode}</strong> — shared with{" "}
          {conflictOwners.map((p) => p.name).join(", ")} as a
          <strong> different colourway</strong>. All keep the code; none is flagged.
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

      {/* ── FACT 3 — WHICH SHOP the display stands on ─────────────────────
          Feeds the display SLOT (one per product per store) that the count
          reads as "1 on display at Marathon PE". Required on a new
          registration; on an existing one it attaches the store a legacy
          row never captured (no stock moves — the movement id dedupes). */}
      {size && (
        <div style={{ margin: "18px 0 0" }}>
          <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".05em", margin: "0 0 10px" }}>
            3 · WHICH SHOP IS THIS DISPLAY AT?
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {DISPLAY_STORES.map((s) => (
              <button key={s} type="button" disabled={busy} onClick={() => setDispStore(s)}
                style={{ flex: 1, minHeight: 56, borderRadius: 14, cursor: "pointer", fontSize: 16, fontWeight: 800, fontFamily: FONT,
                         background: dispStore === s ? "rgba(74,222,128,.22)" : "rgba(74,127,255,.13)",
                         border: dispStore === s ? "2px solid rgba(74,222,128,.9)" : "2px solid rgba(74,127,255,.45)",
                         color: dispStore === s ? "#B7F0CC" : "#D7E3FF" }}>
                {DISPLAY_STORE_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
      )}

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
          {/* ONE action, ALL THREE facts. Disabled until the style-number step
              is satisfied (on file, captured, or deliberately skipped), a size
              is picked AND the shop is named — never split into a second
              screen. */}
          <BigButton tone="green" disabled={busy || !styleReady || !dispStore}
                     onClick={() => onRegister({ product, size, qty, styleCode: styleCodePayload, store: dispStore })}
                     style={{ minHeight: 68, fontSize: 19 }}>
            ✓ REGISTER — size {size}{codeOnFile || chosenCode ? " + style number" : aliasTokens ? " + label reading" : ""}
          </BigButton>
          {!styleReady && (
            <div style={{ fontSize: 12, color: AMBER, marginTop: 8 }}>
              {conflictOwners.length > 0 && !siblingOk
                ? "Answer the question above first — same shoe, or a different colourway?"
                : "Capture the style number off the tongue label first (or mark it unreadable)."}
            </div>
          )}
          {styleReady && !dispStore && (
            <div style={{ fontSize: 12, color: AMBER, marginTop: 8 }}>
              Pick which shop the display stands at — the count needs to know where it is.
            </div>
          )}
        </>
      )}

      {size && existing && (
        <div style={{ marginTop: 20 }}>
          <div style={{ background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.3)", borderRadius: 13,
                        padding: "12px 14px", margin: "18px 0 12px", fontSize: 14, color: "#B7F0CC" }}>
            ✓ Already registered — {existing.qty} unit{existing.qty > 1 ? "s" : ""} of size <SizeTag size={size} />.
            Registering it again adds nothing.
          </div>
          {/* Attaching the store to an existing registration is the supported
              migration for pre-slot rows: no stock moves, only the slot files. */}
          <BigButton tone="blue" disabled={busy || !dispStore}
                     onClick={() => onRegister({ product, size, qty: existing.qty || 1, styleCode: styleCodePayload, store: dispStore })}>
            Save which shop this display is at{dispStore ? ` — ${DISPLAY_STORE_LABELS[dispStore]}` : ""}
          </BigButton>
          <div style={{ height: 10 }} />
          <BigButton tone="ghost" disabled={busy} onClick={() => onExtra({ product, size, store: dispStore })}>
            This is a SECOND physical display — add one more
          </BigButton>
        </div>
      )}
    </Panel>
  );
}

// ─── COUNT PANEL — scan → size (dominant) → confirm the SHELF → continue ─────
// The counter is only ever asked about what should physically be in front of
// them: booked − known off-shelf = EXPECTED ON SHELF (owner spec 2026-08-12).
// The breakdown renders in plain warehouse language ("12 booked · 1 on display
// at Marathon PE · expect 11 here"), the big number is the SHELF expectation,
// and every write carries offShelf so an adjustment moves the shelf figure and
// never destroys a unit the system knows is elsewhere.
function CountPanel({ panel, hub, hubStock, counted, busy, canAdjust, offSources, offError, onRetryOffShelf, registry, onRecord, onClose }) {
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

  // A display can change size MID-COUNT (one sells, another goes out). The
  // slots half of the off-shelf picture is re-read one-shot when this panel
  // opens, so the count reads the slot's CURRENT state — no floor re-walk.
  const [freshSlots, setFreshSlots] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadDisplaySlots()
      .then((s) => { if (!cancelled) setFreshSlots(s); })
      .catch(() => { /* the entry-time snapshot still answers */ });
    return () => { cancelled = true; };
  }, [product.id]);

  const sources = useMemo(() => {
    if (!offSources) return null;
    return freshSlots ? { ...offSources, slots: freshSlots } : offSources;
  }, [offSources, freshSlots]);

  const expected = sizeKey ? qtyOf(cells[sizeKey]) : 0;
  const rawRecord = sizeKey ? counted[cellKey(product.id, sizeKey)] : null;
  // A record staled by a shipment release is NOT a count any more — the shelf
  // gained units this counter never saw. The panel reopens the cell and says
  // what changed and when (owner spec 2026-08-12, the shelve-then-count race).
  const staleRecord = rawRecord && rawRecord.staleAt ? rawRecord : null;
  const record = recordIsCurrent(rawRecord) ? rawRecord : null;

  const labelOf = (s) => labelFor(s, registry);
  const off = sizeKey && sources
    ? offShelfForCell({ hub, productId: product.id, sizeKey, sources, labelOf })
    : { total: 0, parts: [] };
  const offNote = off.parts.map((p) => `${p.qty} ${p.label}`).join(" · ") || null;
  const shelfRaw = expectedOnShelf(expected, off);
  const shelfExpected = Math.max(0, shelfRaw);
  const hasUnverifiable = off.parts.some((p) => !p.verified);

  const marks = {};
  for (const k of sizeKeys) {
    const r = counted[cellKey(product.id, k)];
    if (recordIsCurrent(r)) marks[sizeLabelOf(k)] = "✓";
    else if (r && r.staleAt) marks[sizeLabelOf(k)] = "↻";     // changed since counting
  }

  const labels = sizeKeys.map(sizeLabelOf);
  const keyByLabel = Object.fromEntries(sizeKeys.map((k) => [sizeLabelOf(k), k]));

  const record_ = ({ actualCount }) => onRecord({
    product, sizeKey, expected, actual: actualCount,
    offShelf: off.total, offShelfNote: offNote,
  });

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
              ✓ Already counted this session ({record.action} · {record.actual} on the shelf
              {Number(record.offShelf) > 0 ? ` + ${record.offShelf} off-shelf` : ""}).
            </div>
          )}
          {staleRecord && (
            <div style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.35)", borderRadius: 13,
                          padding: "12px 14px", marginBottom: 12, fontSize: 13, color: "#FDE9B0", lineHeight: 1.55 }}>
              ↻ Counted {staleRecord.actual} on {String(staleRecord.at || "").slice(0, 10)}, then{" "}
              <strong>+{Number(staleRecord.staleDelta) || 0} landed from a released shipment</strong>
              {staleRecord.staleAt ? ` on ${String(staleRecord.staleAt).slice(0, 10)}` : ""} — count this shelf again.
            </div>
          )}
          {/* The off-shelf picture is LOAD-BEARING: counting against the bare
              booked number is the exact unit-destroying bug this rework
              removes, so the panel refuses to take a count before it knows
              what is off the shelf. A failed load blocks with a retry — never
              a silent booked-totals fallback (CodeRabbit, PR #347). */}
          {!record && !sources && !offError && (
            <div style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.35)", borderRadius: 13,
                          padding: "12px 14px", marginBottom: 12, fontSize: 13, color: "#FDE9B0" }}>
              Loading the off-shelf picture (displays, waiting orders)… one moment.
            </div>
          )}
          {!record && !sources && offError && (
            <div style={{ background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.4)", borderRadius: 13,
                          padding: "12px 14px", marginBottom: 12, fontSize: 13, color: "#FFC9C9", lineHeight: 1.55 }}>
              The off-shelf picture could not load ({offError}). Counting is paused — recording against
              bare booked totals is how display units get destroyed.
              <BigButton tone="ghost" disabled={busy} style={{ marginTop: 10, minHeight: 48 }} onClick={onRetryOffShelf}>
                ↻ Retry loading
              </BigButton>
            </div>
          )}
          {!record && sources && (
            <>
              <div style={{ textAlign: "center", margin: "6px 0 16px" }}>
                <div style={{ fontSize: 13, color: GRAY }}>Expect on this shelf</div>
                <div style={{ fontSize: 44, fontWeight: 900, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{shelfExpected}</div>
                <div style={{ fontSize: 13, color: GRAY }}>pairs of size {sizeLabelOf(sizeKey)}</div>
                {off.total > 0 && (
                  <div style={{ fontSize: 12.5, color: BLUE_L, marginTop: 8, lineHeight: 1.5 }}>
                    {Math.max(0, expected)} booked{off.parts.map((p, i) => (
                      <span key={i}> · {p.qty} {p.label}</span>
                    ))} · expect {shelfExpected} here
                  </div>
                )}
                {hasUnverifiable && (
                  <div style={{ fontSize: 11.5, color: AMBER, marginTop: 6, lineHeight: 1.5 }}>
                    Part of this cell is a display with no shop on record — you cannot check it from here.
                    Count the shelf in front of you; the display unit stays booked.
                  </div>
                )}
                {shelfRaw < 0 && (
                  <div style={{ fontSize: 11.5, color: AMBER, marginTop: 6, lineHeight: 1.5 }}>
                    The books disagree: {Math.max(0, expected)} booked but {off.total} known to be off the
                    shelf. Count what you see — the difference is recorded honestly.
                  </div>
                )}
              </div>
              {/* Books-disagree cells get NO one-tap confirm — a "matches 0"
                  tap would notarise an inconsistent cell. The typed count
                  below routes through adjust/flag (CodeRabbit, PR #347). */}
              {shelfRaw >= 0 && (
                <BigButton tone="green" disabled={busy} style={{ minHeight: 68, fontSize: 19 }}
                  onClick={() => record_({ actualCount: shelfExpected })}>
                  ✓ SHELF MATCHES — {shelfExpected}
                </BigButton>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <input inputMode="numeric" pattern="[0-9]*" value={actual} placeholder="Different? Enter the real count"
                       onChange={(e) => setActual(e.target.value.replace(/\D/g, ""))}
                       style={{ ...input, flex: 1, minHeight: 56, fontSize: 17, textAlign: "center" }} />
                <button type="button" disabled={busy || actual === ""}
                  onClick={() => record_({ actualCount: Number(actual) })}
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
