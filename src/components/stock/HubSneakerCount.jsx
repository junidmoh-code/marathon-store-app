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
  canSeeHubCountVariance,
  canAdjustHubCount,
} from "../../config/hubSneakerCount";
import {
  hubOptions, buildHubRows, seededRowFor, mergeSeededRows, progressOf,
  isRowSettled, varianceRows, filterRows, cellKey, recoverSeededRows,
} from "./hubCountCore";
import {
  loadHubStock, openOrResumeSession, loadCounted, publishSessionTotal,
  confirmCell, adjustCell, useLocationRegistryOnce, rememberHub, rememberedHub,
} from "./hubCountStore";

function Thumb({ url }) {
  // "Image if cheap": the catalogue's existing thumbnail URL, lazy-loaded, and
  // only ever for the ≤50 rows on the current page. No fetching, no resizing.
  if (url) {
    return <img src={url} alt="" loading="lazy" decoding="async"
      onError={(e) => { e.currentTarget.style.display = "none"; }}
      style={{ width: 38, height: 38, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />;
  }
  return <div style={{ width: 38, height: 38, borderRadius: 8, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>👟</div>;
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
  useEffect(() => {
    if (!hub) { setSnapshot(null); setSession(null); setCounted({}); return; }
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
    // `products` is deliberately NOT a dependency: it is frozen at entry (see the
    // header note). Re-running on every catalogue tick is exactly what this
    // feature must not do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub]);

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
  const variance = useMemo(() => varianceRows(counted, productsById), [counted, productsById]);
  const canSeeVariance = canSeeHubCountVariance(viewer);
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

      {/* The rules read the STORED stockRole, not the app's super-admin email
          shortcut. Say so at the door rather than on the fortieth box. */}
      {!canAdjust && (
        <div style={{ background: "rgba(251,191,36,.1)", border: "1px solid rgba(251,191,36,.4)", borderRadius: 11, padding: "9px 11px", margin: "10px 0", fontSize: 12, color: AMBER, lineHeight: 1.45 }}>
          <strong>Corrections are disabled for this account.</strong> Writing an adjustment needs
          <code style={{ margin: "0 4px" }}>stockRole: "admin"</code> on your <code>/users</code> record, which the security
          rules check directly — being a super-admin in the app does not grant it. You can still count
          cells that already match, and read the variance list.
        </div>
      )}

      {!hub ? (
        <Empty>Pick a hub to start. The count list loads once and stays put — no live updates while you work.</Empty>
      ) : loading ? (
        <Empty>Loading {labelFor(hub, registry)}…</Empty>
      ) : loadError ? (
        <Empty><span style={{ color: RED }}>Could not load: {loadError}</span></Empty>
      ) : (
        <>
          <div style={{ display: "flex", gap: 7, margin: "12px 0", alignItems: "center" }}>
            <button onClick={() => setTab("count")} style={tab === "count" ? tabOn : tabOff}>Count</button>
            {canSeeVariance && (
              <button onClick={() => setTab("variance")} style={tab === "variance" ? tabOn : tabOff}>
                Variance{variance.length ? ` (${variance.length})` : ""}
              </button>
            )}
            <button onClick={refreshRecorded} style={{ ...tabOff, marginLeft: "auto" }}
              title="Re-read what every counter has recorded (one-shot, no live subscription)">↻ Refresh</button>
          </div>

          {tab === "count" ? (
            <CountList
              rows={visible} totalRows={filtered.length} counted={counted} query={query} setQuery={setQuery}
              page={safePage} pageCount={pageCount} setPage={setPage}
              openRow={openRow} setOpenRow={setOpenRow}
              inputs={inputs} setInputs={setInputs} busyCell={busyCell}
              onConfirm={onConfirm} onAdjust={onAdjust} onRecount={onRecount}
              recounting={recounting} canAdjust={canAdjust}
              addQuery={addQuery} setAddQuery={setAddQuery} addMatches={addMatches} onAdd={addProduct}
            />
          ) : (
            <VarianceList rows={variance} />
          )}
        </>
      )}
      <Toast msg={toast} />
    </div>
  );
}

// ── The paginated product list ────────────────────────────────────────────────
function CountList({
  rows, totalRows, counted, query, setQuery, page, pageCount, setPage,
  openRow, setOpenRow, inputs, setInputs, busyCell, onConfirm, onAdjust, onRecount,
  recounting, canAdjust, addQuery, setAddQuery, addMatches, onAdd,
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
                <Thumb url={p.photoUrl} />
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
        <Empty>No sneaker products hold stock cells here.</Empty>
      ) : (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
          {rows.map((row) => (
            <ProductRow key={row.id} row={row} counted={counted}
              open={openRow === row.id} onToggle={() => setOpenRow(openRow === row.id ? "" : row.id)}
              inputs={inputs} setInputs={setInputs} busyCell={busyCell}
              onConfirm={onConfirm} onAdjust={onAdjust} onRecount={onRecount}
              recounting={recounting} canAdjust={canAdjust} />
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
function ProductRow({ row, counted, open, onToggle, inputs, setInputs, busyCell, onConfirm, onAdjust, onRecount, recounting, canAdjust }) {
  const settled = isRowSettled(row, counted);
  const doneCount = row.sizes.filter((s) => counted[cellKey(row.id, s.sizeKey)]).length;

  return (
    <div style={{ background: CARD, border: settled ? "1px solid rgba(74,222,128,.3)" : BORDER, borderRadius: 11, opacity: settled && !open ? 0.55 : 1 }}>
      <button onClick={onToggle}
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "9px 10px", cursor: "pointer" }}>
        <Thumb url={row.photoUrl} />
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
          <div style={{ fontSize: 15, fontWeight: 700, color: row.total < 0 ? RED : "#fff" }}>{row.total}</div>
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
function SizeRow({ size, record, recounting, canAdjust, value, onChange, busy, onConfirm, onAdjust, onRecount }) {
  const typed = String(value ?? "").trim();
  const parsed = /^\d+$/.test(typed) ? parseInt(typed, 10) : null;
  const isAdjust = parsed != null && parsed !== Number(size.expected);
  const done = !!record && !recounting;
  // A negative cell cannot be "confirmed" — no shelf holds −3 pairs, so the only
  // honest action is to type what is actually there.
  const negative = Number(size.expected) < 0;
  const blocked = isAdjust && !canAdjust;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: done ? 0.5 : 1 }}>
      <div style={{ width: 44, fontSize: 13, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{size.label}</div>
      <div style={{ width: 66, flexShrink: 0 }}>
        <div style={{ fontSize: 13, color: negative ? RED : "#fff" }}>{size.expected}</div>
        <div style={{ fontSize: 9, color: GRAY }}>expected</div>
      </div>

      {done ? (
        <>
          <div style={{ flex: 1, fontSize: 11.5, color: record.settled === false ? RED : record.actual === record.expected ? GREEN : AMBER }}>
            {record.settled === false ? "⚠ re-check shelf" : "✓ counted"} {record.actual}
            {record.actual !== record.expected && ` (was ${record.expected}, ${record.actual > record.expected ? "+" : ""}${record.actual - record.expected})`}
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
            placeholder="actual" autoFocus={recounting}
            style={{ ...input, flex: 1, minWidth: 0, padding: "8px 10px", fontSize: "0.85rem" }} />
          <button disabled={busy || blocked || (typed !== "" && parsed == null) || (negative && !isAdjust)}
            title={blocked ? "This account cannot write stock corrections" : negative && !isAdjust ? "Type what is on the shelf — a negative cell cannot be confirmed" : ""}
            onClick={() => (isAdjust ? onAdjust(parsed) : onConfirm())}
            style={{ ...(isAdjust ? bBlue : bGreen), padding: "8px 12px", flexShrink: 0,
                     opacity: busy || blocked || (negative && !isAdjust) ? 0.45 : 1 }}>
            {busy ? "…" : isAdjust ? "Adjust" : "Confirm"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Variance: every recorded cell whose actual disagreed with the system ──────
function VarianceList({ rows }) {
  if (!rows.length) return <Empty>No variances recorded in this session — every counted cell matched.</Empty>;
  const net = rows.reduce((t, r) => t + r.delta, 0);
  const unsettled = rows.filter((r) => r.unsettled).length;
  return (
    <Card>
      <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>
        {rows.length} variance{rows.length === 1 ? "" : "s"} · net {net > 0 ? "+" : ""}{net} pairs
      </div>
      {unsettled > 0 && (
        <div style={{ fontSize: 11.5, color: RED, marginBottom: 8, lineHeight: 1.45 }}>
          ⚠ {unsettled} cell{unsettled === 1 ? "" : "s"} did not settle at the counted number — another write landed at the
          same moment. Walk back to {unsettled === 1 ? "it" : "them"} and re-count.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map((r) => (
          <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {r.unsettled && <span style={{ color: RED, marginRight: 4 }}>⚠</span>}{r.name}
              </div>
              <div style={{ fontSize: 10, color: GRAY }}>
                size {r.sizeLabel} · expected {r.expected} → counted {r.actual}
                {r.unsettled && <span style={{ color: RED }}> · cell reads {r.live}</span>}
              </div>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: r.delta > 0 ? GREEN : RED, flexShrink: 0 }}>
              {r.delta > 0 ? "+" : ""}{r.delta}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
