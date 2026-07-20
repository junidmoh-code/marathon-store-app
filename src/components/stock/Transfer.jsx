// ─── TRANSFER (source-first, scan + search into one cart) ─────────────────────
// Pick the SOURCE first → build a cart by SCANNING barcodes and/or manual search
// (both feed the SAME cart) → pick a clean DESTINATION → confirm. Each cart line
// becomes ONE atomic `transfer_out` movement carrying a REAL from + to + size.
// Totals conserve via applyMovement's paired −from/+to.
//
// TRANSIT LANES (2026-07-19): a cross-building send from Central's building
// (isTransitLane) goes TWO-STEP — each line lands in the `in_transit` holding
// and a /transfers/{tId} doc records destination + manifest; stock reaches the
// destination only when the receiver confirms in the In Transit screen
// (InTransit.jsx). Same-building moves keep the instant one-step write — the
// `transit` flag below is the only branch.
//
// SIZE INTEGRITY: a scanned barcode resolves via /barcodes/{code} → {productId,
// size?}. Per-size codes (shoes) carry the size; product-level codes (much
// clothing) do NOT — so a sized-clothing scan PROMPTS for size (scanResolve), and
// can never silently move the "_" no-size cell. One-size products transfer the "_"
// cell explicitly (correct), and are now reachable in the manual grid too.
//
// OVER-SCAN: scanning/editing past what the source holds is ALLOWED but the line is
// flagged; applyMovement's negative floor is the hard backstop that blocks an
// impossible transfer at commit.

import React, { useState, useMemo, useEffect, useRef } from "react";
import { ref, update, push, child, get } from "firebase/database";
import { database, auth } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { transferMovementId, loadDraft, saveDraft, clearDraft } from "./transferDraft";
import { useStockCells, useTransitConfig } from "./useStock";
import { transferTargets, labelFor, IN_TRANSIT } from "./locations";
import { isTransitLane } from "./transitLanes";
import { stockSizeKey } from "../../utils/sizeKey";
import { Toast, Empty } from "./widgets";
import { GLASS, GLASS_SOLID, CARD, BLUE_L, GREEN, GRAY, AMBER, BORDER, FONT, input, bGreen, bGhost } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { SizeTag } from "../SizeTag";
import { resolveScan, realSizesOf, forgivingBarcodeCandidates } from "./scanResolve";
import { installBarcodeListener, subscribeBarcode } from "./barcodeListener";
import FilterPicker from "./FilterPicker";
import { serverNowIso } from "../../utils/serverTime";

// RTDB keys can't contain . # $ [ ] / — guard so a junk code is "not found", not a
// mis-pathed read. (Mirrors the POS barcodeLookup reader.)
const RTDB_RESERVED = /[.#$[\]/]/;
async function lookupBarcode(code) {
  const key = String(code ?? "").trim();
  if (!key || RTDB_RESERVED.test(key)) return null;
  const snap = await get(ref(database, `barcodes/${key}`));
  return snap.exists() ? snap.val() : null;
}

const ONE_SIZE = "_";                                  // the no-size /stock cell key
const keyOf = (pid, size) => `${pid}__${size}`;
const sizeLabel = (size) => (size === ONE_SIZE || size == null || size === "" ? "One size" : null);

// Size display order for the grouped cart card: letter sizes, then numeric, then
// "One size" last — so a product's breakdown reads S·M·L·… like the rest of the app.
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL", "6XL"];
function sizeRank(s) {
  if (s === ONE_SIZE) return 1000;
  const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
  if (i >= 0) return i;
  const n = Number(s);
  return Number.isFinite(n) ? 100 + n : 999;
}

// Compact filter chip (destination row).
const chip = (on) => ({
  padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontSize: 12.5, fontWeight: 700, fontFamily: FONT, whiteSpace: "nowrap",
  border: on ? "1px solid #4A7FFF" : "1px solid rgba(60,110,255,.22)",
  background: on ? "rgba(60,110,255,.22)" : "rgba(255,255,255,.03)",
  color: on ? "#fff" : "rgba(255,255,255,.5)",
});

function Thumb({ product, size = 44 }) {
  const url = product?.photoUrl;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 10, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>👟</div>;
}

// SizeTag, or a plain "One size" pill for the "_" cell.
function SizeChip({ size }) {
  const one = sizeLabel(size);
  if (one) return <span style={{ fontSize: 11, color: BLUE_L, fontWeight: 700 }}>{one}</span>;
  return <SizeTag size={size} />;
}

export default function Transfer({ products, registry, actorRole }) {
  // SOURCE — REQUIRED, no default. Every transfer must consciously pick where the
  // stock leaves from, so this starts empty and the cart tools stay hidden until a
  // source is chosen.
  const [from, setFrom] = useState("");
  const [cat, setCat] = useState("all");
  const [search, setSearch] = useState("");
  const [scan, setScan] = useState("");
  const [openId, setOpenId] = useState(null);            // expanded product id (manual grid)
  const [basket, setBasket] = useState({});              // { pid__size: { productId, productName, size, qty } }
  const [refillId, setRefillId] = useState(null);
  const [to, setTo] = useState("");                      // destination
  const [picking, setPicking] = useState(false);         // destination sheet open
  const [sizePrompt, setSizePrompt] = useState(null);    // { product } awaiting a size after a scan
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  // Stable transfer id for the CURRENT cart. Minted at the first Confirm and kept
  // across retries so every line's movement id is deterministic (idempotent retry).
  const [transferId, setTransferId] = useState(null);
  // Per-line outcome of the last Confirm attempt: { key: { status:'sent'|'failed', reason, kind } }.
  // Persisted with the draft so a reload mid-transfer restores which lines already moved.
  const [lineResults, setLineResults] = useState({});
  // Transient summary of the just-finished attempt, for the "N of M" banner phrasing.
  const [lastAttempt, setLastAttempt] = useState(null); // { sent, failed, total }
  // A draft found in storage on mount, awaiting the user's Restore / Discard choice.
  const [draftToRestore, setDraftToRestore] = useState(null);
  const scanRef = useRef(null);
  // Guard: an empty `from` would make useStockCells subscribe to the WHOLE /stock
  // node (and return a different shape). Feed a non-existent id so it resolves to
  // {} until a real source is picked.
  const srcCells = useStockCells(from || "__no_source__"); // { pid: { size: cell } } at the source
  // Transit kill switch: absent/enabled → cross-building sends go two-step;
  // an admin flips it OFF (In Transit screen) during rollout and sends fall
  // back to the instant one-step move. Receiving open transfers is unaffected.
  const transitOn = useTransitConfig()?.enabled !== false;

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3000); };
  const productsById = useMemo(() => {
    const m = {}; (products || []).forEach((p) => { if (p && p.id) m[p.id] = p; }); return m;
  }, [products]);

  const locations = useMemo(() => transferTargets(registry), [registry]);
  // On-hand at the SOURCE — the cap for the manual grid and the over-scan flag.
  const avail = (pid, size) => { const c = srcCells?.[pid]?.[size]; return c && typeof c.qty === "number" ? c.qty : 0; };
  const srcTotal = (pid) => Object.values(srcCells?.[pid] || {}).reduce((s, c) => s + (typeof c?.qty === "number" ? c.qty : 0), 0);

  // Category chips are data-driven from what's ACTUALLY at the source.
  const categories = useMemo(() => {
    const set = new Set();
    for (const p of products || []) if (p?.category && srcCells?.[p.id] && srcTotal(p.id) > 0) set.add(String(p.category));
    return [...set].sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, srcCells]);

  // SEARCH-DRIVEN ONLY (owner decision 2026-07-16): the list stays EMPTY until
  // a search is typed — no auto-dump of everything at the source when a
  // location/category is picked. Candidates are still products WITH stock at
  // the source, narrowed by the category chip; scanning bypasses this list
  // entirely (scans drop straight into the cart).
  const shown = useMemo(() => {
    if (!search.trim()) return [];
    const atSource = (products || []).filter((p) => p && p.id && p.name && srcCells?.[p.id] && srcTotal(p.id) > 0);
    const predicate = (p) => cat === "all" || p.category === cat;
    const base = searchProducts(atSource, search, { predicate, limit: 500 });
    return [...base].sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, srcCells, cat, search]);

  const lines = useMemo(() => Object.values(basket).filter((l) => l.qty > 0), [basket]);
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const overCount = lines.filter((l) => l.qty > avail(l.productId, l.size)).length;
  // Lines still in the cart that failed the last attempt, split by cause so the
  // banner can tell "network — just retry" apart from "not enough stock — fix qty".
  const failedLines = useMemo(
    () => lines.filter((l) => lineResults[keyOf(l.productId, l.size)]?.status === "failed"),
    [lines, lineResults],
  );
  const stockFails = failedLines.filter((l) => lineResults[keyOf(l.productId, l.size)]?.kind === "stock").length;
  const networkFails = failedLines.length - stockFails;

  // Cart grouped ONE card per product, sizes broken out underneath (M×2, L×1 …) —
  // mirrors the Clothing-Sold grouped card. The underlying per-size basket lines are
  // untouched, so Confirm still fires one exact transfer_out per size.
  const cartGroups = useMemo(() => {
    const byPid = new Map();
    for (const l of lines) {
      if (!byPid.has(l.productId)) byPid.set(l.productId, { productId: l.productId, productName: l.productName, sizes: [], total: 0, over: false });
      const g = byPid.get(l.productId);
      const here = avail(l.productId, l.size);
      g.sizes.push({ size: l.size, qty: l.qty, here, over: l.qty > here });
      g.total += l.qty;
      if (l.qty > here) g.over = true;
    }
    const groups = [...byPid.values()];
    groups.forEach((g) => g.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)));
    return groups.sort((a, b) => a.productName.localeCompare(b.productName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, srcCells]);

  // Editing/scanning a line invalidates any prior failed/sent mark for it — it's a
  // fresh attempt, so drop its result (this also updates the incomplete banner).
  const clearLineResult = (k) => setLineResults((r) => { if (!r[k]) return r; const n = { ...r }; delete n[k]; return n; });

  // Manual grid: capped at source stock (you can't browse-add more than is here).
  const setQty = (product, size, qty) => {
    const max = avail(product.id, size);
    const n = Math.max(0, Math.min(max, parseInt(qty, 10) || 0));
    const k = keyOf(product.id, size);
    clearLineResult(k);
    setBasket((b) => {
      const next = { ...b };
      if (n <= 0) delete next[k];
      else next[k] = { productId: product.id, productName: product.name, size, qty: n };
      return next;
    });
  };
  const bump = (product, size, delta) => setQty(product, size, (basket[keyOf(product.id, size)]?.qty || 0) + delta);

  // Cart line qty (scan/edit path): UNCAPPED so over-scan is allowed (and flagged);
  // 0 removes the line.
  const setLineQty = (k, qty) => {
    clearLineResult(k);
    setBasket((b) => {
      const line = b[k]; if (!line) return b;
      const n = Math.max(0, parseInt(qty, 10) || 0);
      if (n <= 0) { const nb = { ...b }; delete nb[k]; return nb; }
      return { ...b, [k]: { ...line, qty: n } };
    });
  };
  const removeLine = (k) => { clearLineResult(k); setBasket((b) => { const nb = { ...b }; delete nb[k]; return nb; }); };
  const removeProduct = (pid) => setBasket((b) => {
    const nb = {}; for (const [k, v] of Object.entries(b)) if (v.productId !== pid) nb[k] = v; return nb;
  });

  // Add ONE unit for a (product, size) via a scan — uncapped (over-scan allowed).
  const scanAdd = (product, size) => {
    const sz = size == null || size === "" ? ONE_SIZE : String(size);
    clearLineResult(keyOf(product.id, sz));
    setBasket((b) => {
      const k = keyOf(product.id, sz);
      const cur = b[k]?.qty || 0;
      return { ...b, [k]: { productId: product.id, productName: product.name, size: sz, qty: cur + 1 } };
    });
    flash("ok", `+1 ${product.name}${sizeLabel(sz) ? "" : " · " + sz}`);
  };

  // Full reset of the transfer session (cart + idempotency context + persisted draft).
  const clearBasket = () => {
    setBasket({}); setRefillId(null);
    setTransferId(null); setLineResults({}); setLastAttempt(null);
    clearDraft();
  };

  // Changing the source invalidates the basket (its lines were counted at the old
  // source). Reset so quantities always reflect what's actually available here.
  // Picking a source also dismisses any restore banner — the user is starting fresh.
  const pickSource = (id) => {
    setDraftToRestore(null);
    if (id === from) return;
    setFrom(id); setBasket({}); setOpenId(null); setRefillId(null);
    setTransferId(null); setLineResults({}); setLastAttempt(null);
    if (to === id) setTo("");
  };

  // Resolve a scanned/typed barcode → INSTANT cart add (POS sell-scan feel). A
  // hardware SCAN is matched EXACTLY; a slowly-TYPED code also tries leading-zero
  // variants (forgiving). Unknown code → "not found", session stays alive.
  const onScanCode = async (raw, { forgiving = false } = {}) => {
    const code = String(raw || "").trim();
    if (!code) return;
    if (sizePrompt) return;                                   // finish the open size prompt first
    if (!from) { flash("err", "Pick a source location first."); return; }
    let rec = null;
    try {
      rec = await lookupBarcode(code);
      if (!rec && forgiving) {
        for (const cand of forgivingBarcodeCandidates(code)) { rec = await lookupBarcode(cand); if (rec) break; }
      }
    } catch { rec = null; }
    if (!rec || !rec.productId) { flash("err", `Barcode not found: ${code}`); return; }
    const product = productsById[rec.productId];
    if (!product) { flash("err", `Scanned product not in catalogue (${rec.productId}).`); return; }
    const r = resolveScan(product, rec.size);
    if (r.kind === "prompt") { setSizePrompt({ product }); return; }   // sized clothing, code had no size
    scanAdd(product, r.kind === "add" ? r.size : ONE_SIZE);
  };

  // Mirror the POS omni-input: a WINDOW-level listener catches the gun's burst
  // anywhere on the screen and drops the item straight into the cart — no focused
  // box, so you can scan-scan-scan continuously. onScanRef always points at the
  // latest handler so it reads current `from`/`products` without re-subscribing.
  const onScanRef = useRef();
  onScanRef.current = onScanCode;
  useEffect(() => {
    const uninstall = installBarcodeListener();
    const unsub = subscribeBarcode((value) => onScanRef.current?.(value, { forgiving: false }));
    return () => { unsub(); uninstall(); };
  }, []);

  // (The "Open refill requests" prefill list was removed from this tab — owner
  // decision 2026-07-16: refill fulfilment lives in the Source flow, not here.
  // The refillId plumbing below stays: a restored draft that was prefilled
  // before the removal still marks its request fulfilled on confirm.)

  // Clear a stale destination if it ends up equal to the source.
  useEffect(() => { if (to && to === from) setTo(""); }, [from, to]);

  // ── DRAFT PERSISTENCE ───────────────────────────────────────────────────────
  // Covers ALL ways the cart can leave the screen: a crash, a reload, a network
  // drop, AND simply navigating to another stock tab (unmount). Persistence is
  // CONTINUOUS — every scan writes the draft below — so an unmount keeps whatever
  // was last scanned; the mount handler here re-offers it. `hydrated` gates the
  // first paint so the empty initial cart can't wipe the draft before we've read it.
  const [hydrated, setHydrated] = useState(false);

  // On mount, surface any unsent cart left behind — the user chooses Restore or
  // Discard (see the banner below). We never auto-apply, so a stale draft can't
  // silently overwrite a fresh session.
  useEffect(() => {
    const d = loadDraft();
    if (d) setDraftToRestore(d);
    setHydrated(true);
  }, []);

  // Persist the cart on every change. saveDraft removes the key when the cart is
  // empty (full success / manual Clear leave nothing to restore). Gated until
  // hydration AND paused while a restore decision is pending, so the empty cart on
  // the first render (or while the restore banner is up) can never clobber the draft.
  useEffect(() => {
    if (!hydrated || draftToRestore) return;
    saveDraft({ from, to, refillId, transferId, basket, lineResults });
  }, [hydrated, draftToRestore, from, to, refillId, transferId, basket, lineResults]);

  const restoreDraft = () => {
    const d = draftToRestore;
    if (!d) return;
    setFrom(d.from || "");                 // direct set (not pickSource) so the cart survives
    setBasket(d.basket || {});
    setTo(d.to || "");
    setRefillId(d.refillId || null);
    setTransferId(d.transferId || null);
    setLineResults(d.lineResults || {});
    setLastAttempt(null);
    setDraftToRestore(null);
  };
  const discardDraft = () => { clearDraft(); setDraftToRestore(null); };

  // Fire the transfer line-by-line. Each line is one atomic `transfer_out`
  // (applyMovement moves −from/+to in a single update — unchanged). This wrapper
  // adds the failure protection AROUND that atomic write:
  //   • a STABLE transferId (reused across retries) → deterministic movement ids
  //     → a resend of a line that already landed is a no-op (never double-moves);
  //   • per-line result tracking, persisted after every line, so a crash mid-loop
  //     leaves a resumable draft;
  //   • on partial failure the succeeded lines are dropped and the FAILED/unsent
  //     lines stay in the cart (+ draft) for a targeted Retry — never a blanket wipe.
  const doTransfer = async () => {
    if (!from) return flash("err", "Pick a source location.");
    if (!to) return flash("err", "Pick a destination.");
    if (from === to) return flash("err", "Source and destination must differ.");
    if (!lines.length) return flash("err", "Add at least one quantity.");
    setBusy(true);

    // Reuse the cart's transferId across retries so movement ids stay deterministic.
    let tId = transferId;
    if (!tId) { tId = push(child(ref(database), "transfers")).key; setTransferId(tId); }

    // TRANSIT LANE: cross-building from Central's building → stock goes to the
    // in_transit holding and the /transfers doc is the receiver's work item. The
    // doc — WITH its full manifest — is created BEFORE the first movement:
    // in_transit stock without a manifest entry would be invisible to the
    // receive screen, so writing the manifest up front removes that crash
    // window entirely (failed lines are pruned after the loop instead). A doc
    // failure aborts the send — nothing has moved yet, safe to retry.
    const transit = transitOn && isTransitLane(from, to);
    if (transit) {
      try {
        let docSnap = await get(child(ref(database), `transfers/${tId}`));
        // Destination changed after a failed transit attempt: the doc's `to` is
        // what the receiver acts on, so it must never disagree with the cart.
        // With nothing sent yet, the stale doc is deleted and a fresh id minted
        // (the rules make `to` write-once); once lines have physically left,
        // the destination is locked to the doc.
        if (docSnap.exists() && docSnap.val()?.to !== to) {
          const anySent = Object.values(lineResults).some((r) => r?.status === "sent");
          if (anySent) {
            setBusy(false);
            return flash("err", `This cart already sent lines toward ${labelFor(docSnap.val()?.to, registry)} — finish or clear it before changing destination.`);
          }
          await update(ref(database), { [`transfers/${tId}`]: null });
          tId = push(child(ref(database), "transfers")).key;
          setTransferId(tId);
          docSnap = null;
        }
        if (!docSnap || !docSnap.exists()) {
          const linesObj = {};
          for (const ln of lines) {
            if (!linesObj[ln.productId]) linesObj[ln.productId] = {};
            linesObj[ln.productId][stockSizeKey(ln.size)] = ln.qty;
          }
          await update(ref(database), {
            [`transfers/${tId}`]: {
              status: "dispatched", from, to, reason: "manual",
              createdAt: serverNowIso(), createdBy: auth.currentUser?.uid || null,
              lines: linesObj,
            },
          });
        } else {
          // Retry with an existing doc: merge THIS attempt's lines in (per-path
          // update, never a node set — already-sent lines from earlier attempts
          // must survive).
          const mergeLines = {};
          for (const ln of lines) mergeLines[`transfers/${tId}/lines/${ln.productId}/${stockSizeKey(ln.size)}`] = ln.qty;
          await update(ref(database), mergeLines);
        }
      } catch {
        setBusy(false);
        return flash("err", "Couldn't create the transit record — nothing was sent. Check connection and retry.");
      }
    }

    // Snapshot the lines up front (the loop persists against this fixed basket).
    const snapshot = { ...basket };
    const results = { ...lineResults };
    // Persist BEFORE the first write: a crash mid-loop still leaves the transferId
    // and which lines were already sent, so a restored retry resumes idempotently.
    saveDraft({ from, to, refillId, transferId: tId, basket: snapshot, lineResults: results });

    let sent = 0;
    const failed = [];
    for (const ln of lines) {
      const k = keyOf(ln.productId, ln.size);
      if (results[k]?.status === "sent") { sent++; continue; } // already moved — skip
      let res;
      try {
        // Pass ln.size straight through — ONE_SIZE is "_" (truthy, so applyMovement's
        // required-size check passes) and stockSizeKey("_") === "_" hits the no-size
        // cell. Mapping it to null would trip missing_product_or_size before encoding.
        res = await applyMovement({
          type: "transfer_out", productId: ln.productId, size: ln.size, qty: ln.qty,
          from, to: transit ? IN_TRANSIT : to, actorRole,
          movementId: transferMovementId(tId, ln.productId, ln.size), // idempotency key
          link: { transferId: tId, refillId: refillId || null },
        });
      } catch (e) {
        res = { ok: false, reason: "write_failed", error: String(e?.message || e) };
      }
      if (res.ok) {
        results[k] = { status: "sent" };
        sent++;
      } else {
        const kind = res.reason === "insufficient_stock" ? "stock"
          : res.reason === "write_failed" ? "network" : "other";
        results[k] = { status: "failed", reason: res.reason, kind };
        failed.push({ key: k });
      }
      setLineResults({ ...results });
      saveDraft({ from, to, refillId, transferId: tId, basket: snapshot, lineResults: results });
    }

    // Transit bookkeeping: a failed line never moved stock (applyMovement is
    // all-or-nothing), so its manifest entry is pruned — the doc lists exactly
    // what physically left. If nothing has EVER left on this doc, the doc
    // itself is removed so no ghost card can sit in In Transit / Health.
    if (transit && failed.length) {
      const prune = {};
      for (const f of failed) {
        const ln = snapshot[f.key];
        if (ln) prune[`transfers/${tId}/lines/${ln.productId}/${stockSizeKey(ln.size)}`] = null;
      }
      await update(ref(database), prune).catch(() => {});
    }
    if (transit && !Object.values(results).some((r) => r?.status === "sent")) {
      await update(ref(database), { [`transfers/${tId}`]: null }).catch(() => {});
    }

    // Only mark the refill fulfilled when EVERY line moved — a partial transfer
    // must not close the request. Transit lanes never stamp here: the stock is
    // parked in in_transit, not at the requesting location, and closing the
    // request on dispatch is exactly the zombie-refill shape (#234). The legacy
    // refillId path predates transit lanes, so a transit send simply leaves the
    // request open.
    if (refillId && failed.length === 0 && sent > 0 && !transit) {
      await update(ref(database), {
        [`refill_requests/${refillId}/status`]: "fulfilled",
        [`refill_requests/${refillId}/fulfilledBy`]: { transferId: tId },
        [`refill_requests/${refillId}/resolvedAt`]: serverNowIso(),
      }).catch(() => {});
    }

    setBusy(false);
    setPicking(false);
    setLastAttempt({ sent, failed: failed.length, total: lines.length });

    if (failed.length === 0) {
      // Full success — clear the cart, idempotency context and draft.
      clearBasket();
      setTo("");
      flash("ok", transit
        ? `Sent ${sent} line(s) — in transit to ${labelFor(to, registry)} until received there`
        : `Transferred ${sent} line(s) → ${labelFor(to, registry)}`);
    } else {
      // Partial / total failure — keep ONLY the unsent lines so they can be retried.
      const remaining = {};
      for (const [key, ln] of Object.entries(snapshot)) if (results[key]?.status !== "sent") remaining[key] = ln;
      setBasket(remaining);
      saveDraft({ from, to, refillId, transferId: tId, basket: remaining, lineResults: results });
      flash("err", `Transfer incomplete — ${sent}/${lines.length} moved, ${failed.length} saved to retry`);
    }
  };

  return (
    <div>
      {/* Restore banner — an unsent cart survived a crash / reload / network drop. */}
      {draftToRestore && (() => {
        const dl = Object.values(draftToRestore.basket || {}).filter((l) => l.qty > 0);
        const units = dl.reduce((s, l) => s + l.qty, 0);
        return (
          <div style={{ ...GLASS, padding: 12, marginBottom: 12, border: "1px solid rgba(74,222,128,.5)", background: "rgba(74,222,128,.06)" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 3 }}>Unsent transfer found</div>
            <div style={{ fontSize: 12, color: GRAY, marginBottom: 10 }}>
              {dl.length} line{dl.length === 1 ? "" : "s"} · {units} unit{units === 1 ? "" : "s"}
              {draftToRestore.from ? <> from <span style={{ color: "#fff" }}>{labelFor(draftToRestore.from, registry)}</span></> : null}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={restoreDraft} style={{ ...bGreen, flex: 2, padding: "8px 12px" }}>Restore cart</button>
              <button onClick={discardDraft} style={{ ...bGhost, flex: 1, padding: "8px 12px" }}>Discard</button>
            </div>
          </div>
        );
      })()}

      {/* Source (pick first — the grid + scan act on this location). */}
      <FilterPicker label="Transfer from" value={from} onChange={pickSource} placeholder="Choose source…" defaultOpen={!from}
        options={locations.map((l) => ({ id: l.id, label: labelFor(l.id, registry) }))} />

      {!from ? (
        <Empty>Pick a source location above to start a transfer.</Empty>
      ) : (
      <>
      {/* SCAN — the gun works ANYWHERE on this screen (global omni-listener, POS
          sell-scan feel): each scan drops straight into the cart, no focus needed,
          so you can scan-scan-scan. The box is a manual-entry fallback (leading
          zeros optional) and stays armed. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        <input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} autoFocus
               onKeyDown={(e) => { if (e.key === "Enter") { onScanCode(e.currentTarget.value, { forgiving: true }); setScan(""); requestAnimationFrame(() => scanRef.current?.focus()); } }}
               placeholder="Scan or type a barcode… ↵"
               style={{ ...input, flex: 1, boxSizing: "border-box", borderColor: "rgba(74,222,128,.4)" }} />
        <button onClick={() => { onScanCode(scan, { forgiving: true }); setScan(""); scanRef.current?.focus(); }} style={{ ...bGreen, padding: "0 16px", whiteSpace: "nowrap" }}>Add</button>
      </div>
      <div style={{ fontSize: 10.5, color: GRAY, marginBottom: 10 }}>Scanner armed — scan any item and it drops into the cart. Same product + size stacks.</div>

      {/* Transfer-incomplete banner — moved lines are gone from the cart; the
          failed/unsent lines remain here for a targeted, idempotent retry. */}
      {failedLines.length > 0 && !busy && (
        <div style={{ ...GLASS, padding: 12, marginBottom: 12, border: "1px solid rgba(255,139,139,.5)", background: "rgba(255,139,139,.07)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 3 }}>
            Transfer incomplete{lastAttempt ? ` — ${lastAttempt.sent}/${lastAttempt.total} moved` : ""}
          </div>
          <div style={{ fontSize: 12, color: GRAY, marginBottom: 8 }}>
            {failedLines.length} line{failedLines.length === 1 ? "" : "s"} saved — already-moved lines are done and won’t re-send.
          </div>
          {networkFails > 0 && <div style={{ fontSize: 12, color: "#FFB4B4", marginBottom: 4 }}>{networkFails} didn’t send (network) — tap Retry.</div>}
          {stockFails > 0 && <div style={{ fontSize: 12, color: AMBER, marginBottom: 4 }}>{stockFails} exceed stock at {labelFor(from, registry)} — lower the qty, then retry.</div>}
          <button onClick={doTransfer} disabled={busy || !to} style={{ ...bGreen, marginTop: 6, padding: "8px 14px", opacity: to ? 1 : 0.5 }}>
            Retry {failedLines.length} line{failedLines.length === 1 ? "" : "s"}
          </button>
        </div>
      )}

      {/* CART — ONE card per product, sizes broken out (M×2, L×1 …) + product total.
          Per-size ± / remove and remove-whole-product. Confirm still moves each size
          cell exactly. Over-source sizes are flagged (floor blocks them at commit). */}
      {cartGroups.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>
            Cart · {cartGroups.length} product{cartGroups.length !== 1 ? "s" : ""} · {totalUnits} unit(s){overCount > 0 ? ` · ${overCount} over source` : ""}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {cartGroups.map((g) => (
              <div key={g.productId} style={{ ...GLASS, padding: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 8 }}>
                  <Thumb product={productsById[g.productId]} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.productName}</div>
                    <div style={{ fontSize: 11, color: g.over ? AMBER : GRAY }}>{g.total} unit{g.total !== 1 ? "s" : ""} · {g.sizes.length} size{g.sizes.length !== 1 ? "s" : ""}{g.over ? " · over source" : ""}</div>
                  </div>
                  <button onClick={() => removeProduct(g.productId)} title="Remove product" style={{ ...bGhost, padding: "6px 10px", fontSize: 13, lineHeight: 1 }}>Remove</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {g.sizes.map((s) => {
                    const k = keyOf(g.productId, s.size);
                    const lr = lineResults[k];
                    const failedLine = lr?.status === "failed";
                    return (
                      <div key={s.size} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: BORDER }}>
                        <div style={{ minWidth: 62 }}><SizeChip size={s.size} /></div>
                        <div style={{ flex: 1, fontSize: 10.5, color: failedLine ? (lr.kind === "stock" ? AMBER : "#FF8B8B") : (s.over ? AMBER : GRAY) }}>
                          {failedLine
                            ? (lr.kind === "stock" ? "not enough stock — lower qty" : lr.kind === "network" ? "didn’t send — retry" : "failed — retry")
                            : <>{s.here} at source{s.over ? " · over!" : ""}</>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <button onClick={() => setLineQty(k, s.qty - 1)} style={stepBtn}>−</button>
                          <input type="number" inputMode="numeric" min="0" value={s.qty}
                                 onChange={(e) => setLineQty(k, e.target.value)}
                                 style={{ ...input, width: 44, minWidth: 0, boxSizing: "border-box", textAlign: "center", padding: "6px 2px", borderColor: s.over ? "rgba(245,158,11,.5)" : undefined }} />
                          <button onClick={() => setLineQty(k, s.qty + 1)} style={stepBtn}>+</button>
                        </div>
                        <button onClick={() => removeLine(k)} title="Remove size" style={{ ...bGhost, padding: "5px 8px", fontSize: 13, lineHeight: 1 }}>×</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {categories.length > 1 && (
        <FilterPicker label="Category" value={cat} onChange={setCat}
          options={[{ id: "all", label: "All" }, ...categories.map((c) => ({ id: c, label: c }))]} />
      )}

      {/* Search */}
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search in ${labelFor(from, registry)}…`}
             style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 12 }} />

      {/* Product list — search results only (empty until a search is typed). */}
      {shown.length === 0 ? (
        <Empty>{search.trim() ? "No products match." : "Search above or scan to add items to the transfer."}</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: lines.length ? 84 : 8 }}>
          {shown.map((p) => {
            const expanded = openId === p.id;
            // Real sizes with stock here, PLUS a synthetic "One size" cell when this
            // product holds no-size ("_") stock — so one-size items are transferable.
            const realSizes = realSizesOf(p).filter((sz) => avail(p.id, sz) > 0);
            const sizes = avail(p.id, ONE_SIZE) > 0 ? [...realSizes, ONE_SIZE] : realSizes;
            const inBasket = sizes.reduce((s, sz) => s + (basket[keyOf(p.id, sz)]?.qty || 0), 0);
            return (
              <div key={p.id} style={{ ...GLASS, padding: 0, overflow: "hidden" }}>
                <div onClick={() => setOpenId(expanded ? null : p.id)} style={{ display: "flex", alignItems: "center", gap: 11, padding: 11, cursor: "pointer" }}>
                  <Thumb product={p} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: GRAY }}>{srcTotal(p.id)} in stock · {sizes.length} size{sizes.length === 1 ? "" : "s"}</div>
                  </div>
                  {inBasket > 0 && <span style={{ background: "rgba(74,222,128,.16)", color: GREEN, border: "1px solid rgba(74,222,128,.4)", borderRadius: 20, padding: "2px 9px", fontSize: 12, fontWeight: 700 }}>{inBasket}</span>}
                  <span style={{ color: BLUE_L, transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
                </div>
                {expanded && (
                  <div style={{ padding: "0 11px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: 8 }}>
                    {sizes.map((sz) => {
                      const max = avail(p.id, sz);
                      const qty = basket[keyOf(p.id, sz)]?.qty || 0;
                      return (
                        <div key={sz} style={{ background: CARD, border: qty ? "1px solid rgba(74,222,128,.4)" : BORDER, borderRadius: 10, padding: "7px 8px" }}>
                          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
                            <span style={{ fontSize: 12, color: BLUE_L, fontWeight: 700 }}><SizeChip size={sz} /></span>
                            <span style={{ fontSize: 9, color: GRAY }}>{max} here</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <button onClick={() => bump(p, sz, -1)} style={stepBtn}>−</button>
                            <input type="number" inputMode="numeric" min="0" max={max} value={qty || ""} placeholder="0"
                                   onChange={(e) => setQty(p, sz, e.target.value)}
                                   style={{ ...input, width: "100%", minWidth: 0, boxSizing: "border-box", textAlign: "center", padding: "6px 2px" }} />
                            <button onClick={() => bump(p, sz, +1)} style={{ ...stepBtn, opacity: qty >= max ? 0.4 : 1 }}>+</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </>
      )}

      {/* Sticky action bar */}
      {lines.length > 0 && (
        <div style={{ position: "fixed", left: 12, right: 12, bottom: 14, zIndex: 40, ...GLASS, padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{lines.length} line(s) · {totalUnits} unit(s)</div>
            <div style={{ fontSize: 11, color: overCount ? AMBER : GRAY }}>from {labelFor(from, registry)}{overCount ? ` · ${overCount} over source` : ""}</div>
          </div>
          <button onClick={clearBasket} style={{ ...bGhost, padding: "8px 12px", fontSize: 12 }}>Clear</button>
          <button onClick={() => setPicking(true)} style={{ ...bGreen, padding: "10px 18px" }}>Destination →</button>
        </div>
      )}

      {/* Size prompt — a sized-clothing scan whose barcode carried no size. */}
      {sizePrompt && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
             onClick={() => setSizePrompt(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...GLASS_SOLID, width: "100%", maxWidth: 520, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 16, maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>Which size?</div>
            <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 14 }}>{sizePrompt.product.name} — the barcode didn't carry a size. Pick the one you scanned.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 8, marginBottom: 12 }}>
              {realSizesOf(sizePrompt.product).map((sz) => {
                const here = avail(sizePrompt.product.id, sz);
                return (
                  <button key={sz} onClick={() => { scanAdd(sizePrompt.product, sz); setSizePrompt(null); scanRef.current?.focus(); }}
                          style={{ ...chip(false), padding: "10px 8px", display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
                    <SizeTag size={sz} />
                    <span style={{ fontSize: 9, color: GRAY }}>{here} here</span>
                  </button>
                );
              })}
            </div>
            <button onClick={() => setSizePrompt(null)} style={{ ...bGhost, width: "100%" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Destination sheet — source is already set, so this only picks TO. */}
      {picking && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
             onClick={() => !busy && setPicking(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...GLASS_SOLID, width: "100%", maxWidth: 520, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 16, maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>Send {totalUnits} unit(s)</div>
            <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 14 }}>from <span style={{ color: "#fff", fontWeight: 600 }}>{labelFor(from, registry)}</span> to…</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginBottom: 16 }}>
              {locations.filter((l) => l.id !== from).map((l) => (
                <button key={l.id} onClick={() => setTo(l.id)} style={chip(to === l.id)}>{labelFor(l.id, registry)}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setPicking(false)} disabled={busy} style={{ ...bGhost, flex: 1 }}>Back</button>
              <button onClick={doTransfer} disabled={busy || !to} style={{ ...bGreen, flex: 2, opacity: (busy || !to) ? 0.5 : 1 }}>
                {busy ? "Transferring…" : `Confirm → ${to ? labelFor(to, registry) : "…"}`}
              </button>
            </div>
            <div style={{ fontSize: 11, color: AMBER, marginTop: 10 }}>
              {to && transitOn && isTransitLane(from, to)
                ? `Cross-building — leaves ${labelFor(from, registry)} now, lands at ${labelFor(to, registry)} when they confirm receipt (In Transit screen).`
                : "Moves immediately (no in-transit confirm step)."}
              {overCount ? ` ${overCount} line(s) exceed source stock — those will be blocked at commit.` : ""}
            </div>
          </div>
        </div>
      )}

      <Toast msg={toast} />
    </div>
  );
}

const stepBtn = {
  width: 26, height: 30, flexShrink: 0, borderRadius: 8, border: "1px solid rgba(60,110,255,.3)",
  background: "rgba(60,110,255,.1)", color: "#9CB8FF", fontSize: 16, fontWeight: 700, cursor: "pointer",
  fontFamily: FONT, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
};
