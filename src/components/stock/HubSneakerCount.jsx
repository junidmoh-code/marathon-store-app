// ─── HUB SNEAKER COUNT — THE COUNT VIEW ───────────────────────────────────────
// TEMPORARY module for one physical sneaker stock-take at the hubs. Behind the
// single master flag in src/config/hubSneakerCount.js — flip it off and this
// screen and its home card both disappear.
//
// ── READ MODEL: ONE SHOT, THEN FROZEN ────────────────────────────────────────
// There is NO onValue in this feature. On entering a hub we take three one-shot
// reads — /stock/{hub}, the session record, the session's recorded cells — and
// hold them in component state for the rest of the count. The catalogue comes in
// as a prop (App already holds it; opening a second subscription would just
// re-download 3,952 products) and is FROZEN into state on entry, so a background
// catalogue update cannot re-order the list under a counter's thumb mid-tap.
//
// The only thing ever re-read is the single cell being written, at the moment of
// writing it — that re-read IS the concurrency fence (see hubCountStore.js).
//
// ── RENDER MODEL: PAGINATED ──────────────────────────────────────────────────
// Hub 2 holds cells for 1,971 products. Rows are paginated at 50 rather than
// windowed, because a row's height changes when it expands into size rows and a
// windowed list would have to re-measure on every tap.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, ref } from "firebase/database";
import { database } from "../../firebase";
import { setUpdateBusy } from "../../update/updateChecker";
import { searchProducts } from "../../utils/productSearch";
import { isFootwearProduct } from "./missingFootwearCore";
import { labelFor } from "./locations";
import { Card, Empty, Toast } from "./widgets";
import { FONT, BG, CARD, BORDER, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGray, bBlue, bGhost, input, tabOn, tabOff } from "./ui";
import {
  HUB_COUNT_PAGE_SIZE,
  canAdjustHubCount,
} from "../../config/hubSneakerCount";
import {
  hubOptions, buildHubRows, seededRowFor, mergeSeededRows, progressOf,
  isRowSettled, historyRows, filterRows, cellKey, recoverSeededRows,
} from "./hubCountCore";
import {
  loadHubStock, openOrResumeSession, loadCounted, publishSessionTotal,
  confirmCell, adjustCell, flagCell, useLocationRegistryOnce, rememberHub, rememberedHub,
} from "./hubCountStore";

function Thumb({ url, onOpen, size = 44 }) {
  // "Image if cheap": the catalogue's existing thumbnail URL, lazy-loaded, and
  // only ever for the ≤50 rows on the current page. Tappable when a photo
  // exists — a counter matching a physical shoe to a row needs to SEE the shoe,
  // and a 44px thumb is not seeing it.
  if (url) {
    return (
      <img src={url} alt="" loading="lazy" decoding="async"
        onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(url); } : undefined}
        onError={(e) => { e.currentTarget.style.display = "none"; }}
        style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0,
                 cursor: onOpen ? "zoom-in" : "default", border: "1px solid rgba(255,255,255,.08)" }} />
    );
  }
  return <div style={{ width: size, height: size, borderRadius: 10, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>👟</div>;
}

// Full-screen photo view. Tap anywhere to close — a counter holding a shoe in
// one hand gets a one-thumb close, no hunt for an ✕.
function PhotoLightbox({ url, onClose }) {
  if (!url) return null;
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.9)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 18, cursor: "zoom-out" }}>
      <img src={url} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 14 }} />
    </div>
  );
}

// The boxed size label. Owner feedback 2026-08-03: a bare "8" sitting beside
// "expected 4" read as just another quantity — the word "Size" plus the box is
// what separates WHICH SHOE from HOW MANY.
function SizeBox({ label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 62,
                   padding: "7px 10px", borderRadius: 9, background: "rgba(74,127,255,.13)",
                   border: "1px solid rgba(74,127,255,.4)", color: "#CFE0FF",
                   fontSize: 12, fontWeight: 800, flexShrink: 0, whiteSpace: "nowrap" }}>
      Size {label}
    </span>
  );
}

export default function HubSneakerCount({ products = [], actorRole, viewer, onExit }) {
  // One-shot registry read (the app's useLocations is an onValue subscription,
  // which this feature does not use). Falls back to the seed until it resolves.
  const registry = useLocationRegistryOnce();
  const hubs = useMemo(() => hubOptions(registry), [registry]);
  // Opens on the hub the home card chose — and, after a reload mid-count, on the
  // hub that was being counted, so resuming is one tap rather than a re-pick.
  const [hub, setHubRaw] = useState(() => rememberedHub());
  const setHub = useCallback((id) => { rememberHub(id); setHubRaw(id); }, []);

  // ── The frozen snapshot for this hub ──────────────────────────────────────
  const [snapshot, setSnapshot] = useState(null);   // { hubStock, catalogue }
  const [session, setSession] = useState(null);
  const [counted, setCounted] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [seeded, setSeeded] = useState([]);         // manually added rows (no cell at this hub)
  const [query, setQuery] = useState("");
  const [addQuery, setAddQuery] = useState("");
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState("");
  const [inputs, setInputs] = useState({});         // { "pid::sizeKey": "3" }
  const [busyCell, setBusyCell] = useState("");
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState("count");
  const [photo, setPhoto] = useState(null);           // tapped product photo, full-screen
  // Cells the counter has chosen to re-count. A recorded cell is otherwise
  // read-only; this is the escape hatch for a mistyped quantity.
  const [recounting, setRecounting] = useState(() => new Set());

  const toastTimer = useRef(null);
  const flash = useCallback((kind, text, ms = 4200) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Auto-update gate: a typed-but-uncommitted quantity lives only in this
  // component's state, so an auto-reload mid-count would drop it silently. Same
  // guard the existing Count tab uses.
  const hasTyped = Object.values(inputs).some((v) => String(v ?? "").trim() !== "");
  useEffect(() => {
    setUpdateBusy("hub-sneaker-count", hasTyped);
    return () => setUpdateBusy("hub-sneaker-count", false);
  }, [hasTyped]);

  // ── ENTRY: the one-shot load, once per hub ────────────────────────────────
  // ⚠️ WAITS FOR A NON-EMPTY CATALOGUE. `hub` can be set on the very first
  // render (resumed from sessionStorage after a mid-count reload), and at that
  // moment App's products subscription has not delivered yet — `products` is
  // still []. Freezing THAT is catastrophic in a quiet way: every stock cell
  // fails to find its product record, every row is skipped, and the counter is
  // told "No sneaker products hold stock cells here" for a hub holding thousands
  // of cells. Since the freeze is deliberately permanent, the empty array would
  // never be replaced.
  //
  // So the freeze waits for the first non-empty catalogue. The guarantee the
  // freeze exists for — the list cannot re-order under a counter's thumb — is
  // unchanged; it just starts from a catalogue that exists.
  const loadedFor = useRef("");
  useEffect(() => {
    if (!hub) { setSnapshot(null); setSession(null); setCounted({}); loadedFor.current = ""; return; }
    if (loadedFor.current === hub) return;      // already frozen for this hub
    if (!products.length) return;               // catalogue not in yet — wait, don't freeze []
    loadedFor.current = hub;
    let cancelled = false;
    setLoading(true); setLoadError("");
    setSeeded([]); setInputs({}); setOpenRow(""); setPage(0); setQuery("");
    setRecounting(new Set());

    (async () => {
      try {
        const [hubStock, sess] = await Promise.all([loadHubStock(hub), openOrResumeSession(hub)]);
        const recorded = await loadCounted(hub, sess.sessionId);
        if (cancelled) return;
        setSnapshot({ hubStock, catalogue: products });
        setSession(sess);
        setCounted(recorded || {});
        // Rebuild the added-from-zero rows this session already recorded, so a
        // reload — or the second counter's tablet — sees them. Without this the
        // records exist in RTDB but no row does, and the same shelf gets counted
        // twice while progress quietly disagrees with itself.
        setSeeded(recoverSeededRows({ counted: recorded || {}, hubStock, products }));
      } catch (err) {
        if (!cancelled) setLoadError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // Depends on whether the catalogue has ARRIVED, never on its contents — so a
    // later catalogue tick cannot re-run this and re-order the list mid-count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, products.length > 0]);

  const catalogue = snapshot?.catalogue || [];
  const productsById = useMemo(
    () => new Map(catalogue.filter((p) => p && p.id).map((p) => [p.id, p])),
    [catalogue]
  );

  const hubRows = useMemo(
    () => (snapshot ? buildHubRows({ products: catalogue, hubStock: snapshot.hubStock }) : []),
    [snapshot, catalogue]
  );
  const rows = useMemo(() => mergeSeededRows(hubRows, seeded), [hubRows, seeded]);
  const progress = useMemo(() => progressOf(rows, counted), [rows, counted]);

  // Publish the cell total once per hub load so the home card can show N of M
  // without reading the hub's whole stock node itself.
  useEffect(() => {
    if (!hub || !session?.sessionId || !hubRows.length) return;
    const total = progressOf(hubRows, {}).total;
    if (Number(session.totalCells) === total) return;
    publishSessionTotal(hub, session.sessionId, total)
      .then(() => setSession((s) => (s ? { ...s, totalCells: total } : s)))
      .catch(() => {/* cosmetic only — the count view computes its own total */});
  }, [hub, session, hubRows]);

  const filtered = useMemo(() => filterRows(rows, query), [rows, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / HUB_COUNT_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => filtered.slice(safePage * HUB_COUNT_PAGE_SIZE, (safePage + 1) * HUB_COUNT_PAGE_SIZE),
    [filtered, safePage]
  );

  // ── ADD A PRODUCT THAT IS PRESENT BUT HAS NO CELL HERE ────────────────────
  const alreadyListed = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const addMatches = useMemo(
    () => searchProducts(catalogue, addQuery, {
      limit: 12,
      predicate: (p) => isFootwearProduct(p) && !alreadyListed.has(p.id),
    }),
    [catalogue, addQuery, alreadyListed]
  );

  const addProduct = (p) => {
    const row = seededRowFor(p);
    if (!row) return flash("err", `${p.name} has no countable sizes.`);
    setSeeded((s) => (s.some((r) => r.id === row.id) ? s : [...s, row]));
    setAddQuery("");
    setOpenRow(row.id);
    flash("ok", `${row.name} added from zero — count its sizes.`);
  };

  // ── WRITES ────────────────────────────────────────────────────────────────
  // Both paths refresh the row's `expected` from the live value when the fence
  // rejects, so the counter immediately sees the number they must now reconcile
  // against instead of being told "try again" with the same stale figure.
  const refreshExpected = useCallback(async (productId, sizeKey) => {
    try {
      const snap = await get(ref(database, `stock/${hub}/${productId}/${sizeKey}`));
      const cell = snap.val();
      const qty = cell && typeof cell.qty === "number" ? cell.qty : 0;
      setSnapshot((s) => {
        if (!s) return s;
        const hubStock = { ...s.hubStock };
        const node = { ...(hubStock[productId] || {}) };
        node[sizeKey] = { ...(node[sizeKey] || {}), qty };
        hubStock[productId] = node;
        return { ...s, hubStock };
      });
      setSeeded((list) => list.map((r) => (r.id !== productId ? r : {
        ...r,
        sizes: r.sizes.map((s) => (s.sizeKey === sizeKey ? { ...s, expected: qty } : s)),
        total: r.sizes.reduce((t, s) => t + (s.sizeKey === sizeKey ? qty : s.expected), 0),
      })));
    } catch { /* the fence already told the counter what happened */ }
  }, [hub]);

  const runWrite = async (row, size, fn) => {
    const key = cellKey(row.id, size.sizeKey);
    setBusyCell(key);
    try {
      const res = await fn();
      if (res.ok) {
        setCounted((c) => ({ ...c, [key]: res.record }));
        setInputs((i) => ({ ...i, [key]: "" }));
        setRecounting((s) => { if (!s.has(key)) return s; const n = new Set(s); n.delete(key); return n; });
        // An Adjust moved the cell, so the row's on-hand total is now stale in
        // the frozen snapshot. Pull just that one cell back — the header number
        // must agree with what was actually written.
        if (res.record?.action === "adjust") await refreshExpected(row.id, size.sizeKey);
        if (res.warning) flash("err", res.warning, 9000);
        else if (res.record?.action === "flag")
          flash("ok", `${row.name} · size ${size.label} recorded — the difference goes to an admin to apply.`, 3400);
        else flash("ok", `${row.name} · size ${size.label} recorded.`, 2200);
      } else {
        flash("err", res.message || "Could not record that count.", 7000);
        if (res.stale) await refreshExpected(row.id, size.sizeKey);
      }
    } catch (err) {
      flash("err", String(err?.message || err), 7000);
    } finally {
      setBusyCell("");
    }
  };

  const onConfirm = (row, size) => runWrite(row, size, () =>
    confirmCell({ hub, sessionId: session.sessionId, productId: row.id, sizeKey: size.sizeKey, expected: size.expected }));

  const onAdjust = (row, size, actual) => runWrite(row, size, () =>
    adjustCell({ hub, sessionId: session.sessionId, productId: row.id, sizeKey: size.sizeKey, expected: size.expected, actual, actorRole }));

  // The warehouse counter's mismatch path: record the shelf truth, move no
  // stock. The difference queues in Variance for an admin to apply.
  const onFlag = (row, size, actual) => runWrite(row, size, () =>
    flagCell({ hub, sessionId: session.sessionId, productId: row.id, sizeKey: size.sizeKey, expected: size.expected, actual }));

  // ADMIN: apply a counter's flagged correction. Same adjustCell, same fence —
  // if the cell moved since the counter looked at the shelf, this rejects and
  // the row needs a fresh count, never a blind write of an old number.
  const [busyVariance, setBusyVariance] = useState("");
  const applyVariance = async (row) => {
    setBusyVariance(row.key);
    try {
      const res = await adjustCell({
        hub, sessionId: session.sessionId, productId: row.productId, sizeKey: row.sizeKey,
        expected: row.expected, actual: row.actual, actorRole,
      });
      if (res.ok) {
        setCounted((c) => ({ ...c, [row.key]: res.record }));
        await refreshExpected(row.productId, row.sizeKey);
        flash(res.warning ? "err" : "ok",
          res.warning || `Applied — ${row.name} size ${row.sizeLabel} corrected to ${row.actual}.`,
          res.warning ? 9000 : 3200);
      } else {
        flash("err", res.stale
          ? `${row.name} size ${row.sizeLabel}: stock moved since it was counted — recount it before applying.`
          : (res.message || "Could not apply."), 7000);
        if (res.stale) await refreshExpected(row.productId, row.sizeKey);
      }
    } finally {
      setBusyVariance("");
    }
  };

  // Re-count a cell that was already recorded: pull the CURRENT value (the old
  // `expected` is meaningless now — stock moved) and reopen the input. Writing
  // overwrites the record at the same key, which is not a delete, so the
  // never-delete invariant is untouched.
  const onRecount = async (row, size) => {
    const key = cellKey(row.id, size.sizeKey);
    setBusyCell(key);
    await refreshExpected(row.id, size.sizeKey);
    setRecounting((s) => new Set(s).add(key));
    setBusyCell("");
  };

  // Re-read what OTHER counters have recorded, without a subscription. The
  // one-shot model means a second counter's work is otherwise invisible until
  // the hub is re-entered, which nobody would discover.
  const refreshRecorded = async () => {
    if (!session?.sessionId) return;
    try {
      const recorded = await loadCounted(hub, session.sessionId);
      setCounted(recorded || {});
      setSeeded(recoverSeededRows({ counted: recorded || {}, hubStock: snapshot?.hubStock || {}, products: catalogue }));
      flash("ok", "Refreshed — showing what every counter has recorded.", 2400);
    } catch (err) {
      flash("err", `Could not refresh: ${String(err?.message || err)}`);
    }
  };

  // ── RENDER ────────────────────────────────────────────────────────────────
  const history = useMemo(() => historyRows(counted, productsById), [counted, productsById]);
  const pendingApply = useMemo(() => history.filter((r) => r.pending).length, [history]);
  const canAdjust = canAdjustHubCount(viewer);

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT, padding: "14px 12px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button onClick={onExit} style={{ ...bGray, padding: "7px 12px" }}>← Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Hub Sneaker Count</div>
          <div style={{ fontSize: 11, color: GRAY }}>Temporary stock-take · counts are recorded, corrections are ledgered</div>
        </div>
      </div>

      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {hubs.map((h) => (
            <button key={h.id} onClick={() => setHub(h.id)} style={hub === h.id ? tabOn : tabOff}>{h.label}</button>
          ))}
        </div>
        {hub && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: "#fff" }}>
            <strong style={{ color: progress.done === progress.total && progress.total > 0 ? GREEN : BLUE_L }}>
              {progress.done} of {progress.total}
            </strong>{" "}
            size cells counted at {labelFor(hub, registry)}
            {session?.sessionId && <span style={{ color: GRAY }}> · session {session.sessionId.slice(-6)}</span>}
          </div>
        )}
      </Card>

      {/* For non-admin counters this is a supported flow, not a failure — say
          what their taps do, in their language, once, at the door. */}
      {!canAdjust && (
        <div style={{ background: "rgba(74,127,255,.08)", border: "1px solid rgba(74,127,255,.3)", borderRadius: 11, padding: "9px 11px", margin: "10px 0", fontSize: 12, color: BLUE_L, lineHeight: 1.5 }}>
          <strong>Count freely — nothing you enter here moves stock.</strong> Where your count matches, tap
          Confirm. Where it differs, type what is really on the shelf and tap Record — an admin applies the
          correction afterwards.
        </div>
      )}

      {!hub ? (
        <Empty>Pick a hub to start. The count list loads once and stays put — no live updates while you work.</Empty>
      ) : loadError ? (
        <Empty><span style={{ color: RED }}>Could not load: {loadError}</span></Empty>
      ) : loading || !snapshot ? (
        // `!snapshot` also covers waiting for the catalogue on a resumed session.
        // Without it the list would render empty and claim the hub holds nothing.
        <Empty>Loading {labelFor(hub, registry)}…</Empty>
      ) : (
        <>
          <div style={{ display: "flex", gap: 7, margin: "12px 0", alignItems: "center" }}>
            <button onClick={() => setTab("count")} style={tab === "count" ? tabOn : tabOff}>Count</button>
            <button onClick={() => setTab("history")} style={tab === "history" ? tabOn : tabOff}>
              History{history.length ? ` (${history.length})` : ""}{pendingApply && canAdjust ? ` · ${pendingApply} to apply` : ""}
            </button>
            <button onClick={refreshRecorded} style={{ ...tabOff, marginLeft: "auto" }}
              title="Re-read what every counter has recorded (one-shot, no live subscription)">↻ Refresh</button>
          </div>

          {tab === "count" ? (
            <CountList
              rows={visible} totalRows={filtered.length} counted={counted} query={query} setQuery={setQuery}
              page={safePage} pageCount={pageCount} setPage={setPage}
              openRow={openRow} setOpenRow={setOpenRow}
              inputs={inputs} setInputs={setInputs} busyCell={busyCell}
              onConfirm={onConfirm} onAdjust={onAdjust} onFlag={onFlag} onRecount={onRecount}
              recounting={recounting} canAdjust={canAdjust} onOpenPhoto={setPhoto}
              addQuery={addQuery} setAddQuery={setAddQuery} addMatches={addMatches} onAdd={addProduct}
            />
          ) : (
            <HistoryList rows={history} canAdjust={canAdjust} onApply={applyVariance} busyKey={busyVariance} />
          )}
        </>
      )}
      <PhotoLightbox url={photo} onClose={() => setPhoto(null)} />
      <Toast msg={toast} />
    </div>
  );
}

// ── The paginated product list ────────────────────────────────────────────────
function CountList({
  rows, totalRows, counted, query, setQuery, page, pageCount, setPage,
  openRow, setOpenRow, inputs, setInputs, busyCell, onConfirm, onAdjust, onFlag, onRecount,
  recounting, canAdjust, onOpenPhoto, addQuery, setAddQuery, addMatches, onAdd,
}) {
  return (
    <>
      <Card>
        <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          placeholder="Filter this hub's list — name or code…"
          style={{ ...input, width: "100%", boxSizing: "border-box" }} />

        <div style={{ marginTop: 10, fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em" }}>
          On the shelf but not on the list?
        </div>
        <input value={addQuery} onChange={(e) => setAddQuery(e.target.value)}
          placeholder="Search any sneaker to add it from zero…"
          style={{ ...input, width: "100%", boxSizing: "border-box", marginTop: 5 }} />
        {addQuery.trim() && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5, maxHeight: 220, overflowY: "auto" }}>
            {addMatches.length === 0 ? (
              <div style={{ fontSize: 12, color: GRAY, padding: "5px 2px" }}>
                No sneaker matches “{addQuery.trim()}” that isn’t already listed.
              </div>
            ) : addMatches.map((p) => (
              <button key={p.id} onClick={() => onAdd(p)}
                style={{ display: "flex", alignItems: "center", gap: 9, textAlign: "left", background: CARD, border: BORDER, borderRadius: 9, padding: "6px 9px", cursor: "pointer" }}>
                <Thumb url={p.photoUrl} onOpen={onOpenPhoto} size={38} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: GRAY }}>no stock cell at this hub — seeds from 0</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {totalRows === 0 ? (
        // Two different states, and conflating them tells the counter something
        // false: a filtered-out list is not an empty hub.
        <Empty>
          {query.trim()
            ? <>Nothing on this hub’s list matches “{query.trim()}”.</>
            : "No sneaker products hold stock cells here."}
        </Empty>
      ) : (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
          {rows.map((row) => (
            <ProductRow key={row.id} row={row} counted={counted}
              open={openRow === row.id} onToggle={() => setOpenRow(openRow === row.id ? "" : row.id)}
              inputs={inputs} setInputs={setInputs} busyCell={busyCell}
              onConfirm={onConfirm} onAdjust={onAdjust} onFlag={onFlag} onRecount={onRecount}
              recounting={recounting} canAdjust={canAdjust} onOpenPhoto={onOpenPhoto} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 14 }}>
          <button disabled={page === 0} onClick={() => setPage(page - 1)} style={{ ...bGray, opacity: page === 0 ? 0.4 : 1 }}>← Prev</button>
          <div style={{ fontSize: 12, color: GRAY }}>Page {page + 1} of {pageCount} · {totalRows} products</div>
          <button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} style={{ ...bGray, opacity: page >= pageCount - 1 ? 0.4 : 1 }}>Next →</button>
        </div>
      )}
    </>
  );
}

// ── One product, collapsed to a summary until tapped ──────────────────────────
function ProductRow({ row, counted, open, onToggle, inputs, setInputs, busyCell, onConfirm, onAdjust, onFlag, onRecount, recounting, canAdjust, onOpenPhoto }) {
  const settled = isRowSettled(row, counted);
  const doneCount = row.sizes.filter((s) => counted[cellKey(row.id, s.sizeKey)]).length;

  return (
    <div style={{ background: CARD, border: settled ? "1px solid rgba(74,222,128,.3)" : BORDER, borderRadius: 11, opacity: settled && !open ? 0.55 : 1 }}>
      <button onClick={onToggle}
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "9px 10px", cursor: "pointer" }}>
        <Thumb url={row.photoUrl} onOpen={onOpenPhoto} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {settled && <span style={{ color: GREEN, marginRight: 5 }}>✓</span>}{row.name}
          </div>
          <div style={{ fontSize: 10.5, color: GRAY }}>
            {row.code ? `${row.code} · ` : ""}{row.sizes.length} size{row.sizes.length === 1 ? "" : "s"}
            {row.seeded && <span style={{ color: AMBER }}> · added from zero</span>}
            {doneCount > 0 && !settled && <span style={{ color: BLUE_L }}> · {doneCount} done</span>}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {/* displayTotal: below-zero cells count as 0 here — no negatives on screen. */}
          <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{row.displayTotal}</div>
          <div style={{ fontSize: 9.5, color: GRAY }}>on hand</div>
        </div>
      </button>

      {open && (
        <div style={{ borderTop: BORDER, padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
          {row.sizes.map((size) => (
            <SizeRow key={size.sizeKey} row={row} size={size}
              record={counted[cellKey(row.id, size.sizeKey)]}
              recounting={recounting.has(cellKey(row.id, size.sizeKey))}
              canAdjust={canAdjust}
              value={inputs[cellKey(row.id, size.sizeKey)] ?? ""}
              onChange={(v) => setInputs((i) => ({ ...i, [cellKey(row.id, size.sizeKey)]: v }))}
              busy={busyCell === cellKey(row.id, size.sizeKey)}
              onConfirm={() => onConfirm(row, size)}
              onAdjust={(actual) => onAdjust(row, size, actual)}
              onFlag={(actual) => onFlag(row, size, actual)}
              onRecount={() => onRecount(row, size)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── One size cell: expected, an actual-qty input, and the one action button ───
// The button is a Confirm until the typed number differs from expected, at which
// point it becomes an Adjust. One control, so a counter can never confirm a
// number they have just contradicted.
// One size cell. Reads left to right as a sentence: WHICH size → what the
// SYSTEM expects → what the SHELF says → one action. The size sits in a labeled
// box so it can never be mistaken for a quantity (owner feedback), and the
// expected number is boxed with its own caption for the same reason.
function SizeRow({ size, record, recounting, canAdjust, value, onChange, busy, onConfirm, onAdjust, onFlag, onRecount }) {
  const typed = String(value ?? "").trim();
  const parsed = /^\d+$/.test(typed) ? parseInt(typed, 10) : null;
  const done = !!record && !recounting;
  // No negative numbers on screen (owner direction): a below-zero cell DISPLAYS
  // as 0, but the TRUE value stays underneath — every write fences and computes
  // against it, which is exactly how counting the cell repairs it.
  const negative = Number(size.expected) < 0;
  const expDisp = negative ? 0 : Number(size.expected);
  // On a negative cell even "matches the shown 0" is a correction in truth, so
  // every submission routes through adjust/record — never a bare confirm, which
  // would notarize the negative.
  const isMismatch = parsed != null && (negative || parsed !== Number(size.expected));

  const pendingFlag = done && record.action === "flag";
  const doneColor = record
    ? (record.settled === false ? RED : pendingFlag ? AMBER : record.actual === record.expected ? GREEN : AMBER)
    : GREEN;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 8px", borderRadius: 10,
                  background: done ? "transparent" : "rgba(255,255,255,.025)", opacity: done ? 0.55 : 1 }}>
      <SizeBox label={size.label} />
      <div style={{ width: 64, textAlign: "center", flexShrink: 0, background: "rgba(255,255,255,.04)",
                    border: BORDER, borderRadius: 9, padding: "4px 6px" }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: "#fff" }}>{expDisp}</div>
        <div style={{ fontSize: 8.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".06em" }}>expected</div>
      </div>

      {done ? (
        <>
          <div style={{ flex: 1, fontSize: 11.5, color: doneColor }}>
            {record.settled === false ? "⚠ re-check shelf —" : pendingFlag ? "✎ counted" : "✓ counted"} {record.actual}
            {record.actual !== record.expected && ` (was ${Math.max(0, record.expected)}${record.expected < 0 ? ", under 0" : ""}, ${record.actual > record.expected ? "+" : ""}${record.actual - record.expected})`}
            {pendingFlag && <div style={{ fontSize: 10, color: AMBER }}>waiting for an admin to apply</div>}
            {record.settled === false && <div style={{ fontSize: 10, color: RED }}>cell now reads {record.live}</div>}
          </div>
          <button onClick={onRecount} disabled={busy}
            style={{ ...bGhost, padding: "6px 10px", fontSize: "0.7rem", flexShrink: 0, opacity: busy ? 0.5 : 1 }}>
            {busy ? "…" : "Recount"}
          </button>
        </>
      ) : (
        <>
          <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="numeric"
            placeholder="on shelf" autoFocus={recounting}
            style={{ ...input, flex: 1, minWidth: 0, padding: "8px 10px", fontSize: "0.85rem" }} />
          {/* One button, three faces: Confirm (matches) / Adjust (admin writes
              stock) / Record (staff — saves the difference for an admin). */}
          <button disabled={busy || (typed !== "" && parsed == null) || (negative && parsed == null)}
            title={negative && parsed == null ? "Type what is on the shelf (0 counts) — this cell needs a real count" : ""}
            onClick={() => (isMismatch ? (canAdjust ? onAdjust(parsed) : onFlag(parsed)) : onConfirm())}
            style={{ ...(isMismatch ? bBlue : bGreen), padding: "8px 13px", flexShrink: 0,
                     opacity: busy || (negative && parsed == null) ? 0.45 : 1 }}>
            {busy ? "…" : isMismatch ? (canAdjust ? "Adjust" : "Record") : "Confirm"}
          </button>
        </>
      )}
    </div>
  );
}

// ── History: every recorded cell, newest first (replaces the Variance tab) ────
// The counter's receipt roll and the admin's apply queue in one place. Pending
// rows (✎, a warehouse counter's recorded mismatch) carry Apply for admins —
// the same fenced adjust path; stale cells reject into a recount.
function relTime(iso) {
  const ms = Date.now() - new Date(iso || 0).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function HistoryList({ rows, canAdjust, onApply, busyKey }) {
  if (!rows.length) return <Empty>Nothing recorded yet — counted cells will show up here, newest first.</Empty>;
  const pending = rows.filter((r) => r.pending).length;
  const unsettled = rows.filter((r) => r.unsettled).length;
  return (
    <Card>
      <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>
        {rows.length} recorded
        {pending > 0 && <span style={{ color: AMBER }}> · {pending} awaiting apply</span>}
      </div>
      {unsettled > 0 && (
        <div style={{ fontSize: 11.5, color: RED, marginBottom: 8, lineHeight: 1.45 }}>
          ⚠ {unsettled} cell{unsettled === 1 ? "" : "s"} did not settle at the counted number — walk back and re-count.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map((r) => {
          // No negative stock numbers on screen (owner direction) — a below-zero
          // system value displays as 0; the true value still drives the write.
          const expDisp = Math.max(0, Number(r.expected));
          const wasNegative = Number(r.expected) < 0;
          const changed = Number(r.actual) !== Number(r.expected);
          return (
            <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
              <span style={{ fontSize: 13, flexShrink: 0, width: 18, textAlign: "center",
                             color: r.unsettled ? RED : r.pending ? AMBER : GREEN }}>
                {r.unsettled ? "⚠" : r.pending ? "✎" : "✓"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                <div style={{ fontSize: 10, color: GRAY }}>
                  Size {r.sizeLabel} · {changed ? `${expDisp} → ${r.actual}` : `counted ${r.actual}`}
                  {wasNegative && " · was under 0"}
                  {r.pending && <span style={{ color: AMBER }}> · stock not yet corrected</span>}
                  {r.unsettled && <span style={{ color: RED }}> · cell reads {r.live}</span>}
                  {r.at && ` · ${relTime(r.at)}`}
                </div>
              </div>
              {changed && (
                <div style={{ fontSize: 13, fontWeight: 700, color: r.delta > 0 ? GREEN : RED, flexShrink: 0 }}>
                  {r.delta > 0 ? "+" : ""}{r.delta}
                </div>
              )}
              {r.pending && canAdjust && (
                <button onClick={() => onApply(r)} disabled={busyKey === r.key}
                  style={{ ...bBlue, padding: "7px 12px", fontSize: "0.72rem", flexShrink: 0, opacity: busyKey === r.key ? 0.5 : 1 }}>
                  {busyKey === r.key ? "…" : "Apply"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
