// ─── SPECIALS CARD — START AND END SPECIALS ──────────────────────────────────
// The operator surface for /specials (contract in src/utils/specials.js). Top
// half: every ACTIVE special — its price, the parked wasPrice it will return
// to, who started it and when, the advisory planned end (flagged OVERDUE when
// past) — with select-and-end. Bottom half: put products ON special — search
// the catalogue, select, one % off or one fixed price, optional planned end
// date. Both directions preview first and land as one audited batch
// (special_start / special_end); ending restores the pre-special retail price
// exactly. The TV and the sale screen read /specials; this card is its only
// writer.
//
// Reads: one-shot get() of /specials (compact by design — measured ~9 KB at 20
// active specials) with a Refresh button; the catalogue comes from the
// existing products subscription via props. No new onValue anywhere.

import { useEffect, useMemo, useState } from "react";
import { loadSpecials, startSpecials, endSpecials } from "./priceStore";
import { buildSpecialStartPlan, buildSpecialEndPlan } from "../../utils/specials";
import BulkPricePreview from "./BulkPricePreview";
import { serverNowIso } from "../../utils/serverTime";
import { auth } from "../../firebase";

const fmt = (v) => (typeof v === "number" ? `R${v.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : "—");
const INPUT = { background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 8, color: "#fff", padding: "8px 10px", fontSize: 12 };
const BTN = (on) => ({ background: on ? "#4A7FFF" : "rgba(255,255,255,.06)", border: "1px solid " + (on ? "#4A7FFF" : "rgba(255,255,255,.15)"), borderRadius: 8, color: on ? "#fff" : "rgba(255,255,255,.65)", padding: "8px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" });

export default function SpecialsTab({ products = [] }) {
  const [specials, setSpecials] = useState(null); // null = loading
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  // End flow
  const [endSelected, setEndSelected] = useState(() => new Set());
  const [endPreview, setEndPreview] = useState(null); // a built plan
  // Start flow
  const [search, setSearch] = useState("");
  const [addSelected, setAddSelected] = useState(() => new Set());
  const [mode, setMode] = useState("percent");
  const [percentDraft, setPercentDraft] = useState("");
  const [priceDraft, setPriceDraft] = useState("");
  const [plannedEnd, setPlannedEnd] = useState("");
  const [startPreview, setStartPreview] = useState(null); // a built plan

  const refresh = () => {
    loadSpecials().then((s) => {
      setSpecials(s || {});
      setEndSelected(new Set());
    }).catch((e) => setNotice({ kind: "err", text: `Could not load specials: ${e?.message || e}` }));
  };
  useEffect(() => { refresh(); }, []);

  const active = useMemo(() => Object.entries(specials || {})
    .map(([pid, e]) => ({ pid, ...e }))
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || ""))), [specials]);

  const nowIso = serverNowIso();
  const today = nowIso.slice(0, 10);
  const overdue = (e) => e.plannedEndAt && String(e.plannedEndAt).slice(0, 10) < today;

  // Start-flow candidates: catalogue minus active specials, searched.
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => p && p.id && !(specials || {})[p.id])
      .filter((p) => (p.name || "").toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q) || (p.barcode || "").toLowerCase().includes(q))
      .slice(0, 30);
  }, [products, specials, search]);
  const selectedProducts = useMemo(() => {
    const byId = new Map(products.filter((p) => p && p.id).map((p) => [p.id, p]));
    return [...addSelected].map((id) => byId.get(id)).filter(Boolean);
  }, [products, addSelected]);

  const toggle = (set, setter) => (id) => setter((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAdd = toggle(addSelected, setAddSelected);
  const toggleEnd = toggle(endSelected, setEndSelected);

  const openStartPreview = () => {
    const user = auth.currentUser;
    const plan = buildSpecialStartPlan({
      products, specials: specials || {}, selectedIds: [...addSelected],
      mode, percentDraft, priceDraft, plannedEndAt: plannedEnd.trim() || null,
      startedAt: serverNowIso(), startedBy: user ? user.uid : null, startedByEmail: user?.email || null,
    });
    if (!plan.ok) { setNotice({ kind: "err", text: plan.error }); return; }
    setNotice(null);
    setStartPreview(plan);
  };

  // try/finally on every handler so a rejection can never strand the controls
  // disabled (CodeRabbit, PR #355).
  const doStart = async () => {
    if (!startPreview || busy) return;
    setBusy(true);
    try {
      const res = await startSpecials(startPreview);
      setStartPreview(null);
      if (!res.ok) { setNotice({ kind: "err", text: "Nothing was written: " + res.message }); refresh(); return; }
      setNotice({ kind: "ok", text: `Special started on ${res.count} product${res.count === 1 ? "" : "s"} (batch ${res.batchId}). End it from the list above — the old price comes back exactly.` });
      setAddSelected(new Set()); setSearch(""); setPercentDraft(""); setPriceDraft(""); setPlannedEnd("");
      refresh();
    } catch (e) {
      setNotice({ kind: "err", text: "Nothing was written: " + (e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const openEndPreview = () => {
    const plan = buildSpecialEndPlan({ products, specials: specials || {}, selectedIds: [...endSelected] });
    if (!plan.ok) { setNotice({ kind: "err", text: plan.error }); return; }
    setNotice(null);
    setEndPreview(plan);
  };

  const doEnd = async () => {
    if (!endPreview || busy) return;
    setBusy(true);
    try {
      const res = await endSpecials(endPreview);
      setEndPreview(null);
      if (!res.ok) { setNotice({ kind: "err", text: "Nothing was written: " + res.message }); refresh(); return; }
      setNotice({ kind: "ok", text: `Special ended on ${res.count} product${res.count === 1 ? "" : "s"} — normal prices restored (batch ${res.batchId}).` });
      refresh();
    } catch (e) {
      setNotice({ kind: "err", text: "Nothing was written: " + (e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "0 14px 30px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0 8px" }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>Specials</span>
        <span style={{ background: "rgba(74,202,122,.15)", border: "1px solid rgba(74,202,122,.35)", color: "#4ACA7A", fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 12 }}>{active.length} active</span>
        <button onClick={refresh} style={{ ...BTN(false), marginLeft: "auto" }}>Refresh</button>
      </div>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,.45)", marginBottom: 12 }}>
        A special changes the shelf price the till charges; the normal price is parked and comes back exactly when you end it.
        Specials end here, by you — the planned end date is a reminder on the card, not an automatic stop.
      </div>

      {notice && (
        <div style={{ background: notice.kind === "ok" ? "rgba(74,202,122,.08)" : "rgba(255,99,99,.08)", border: `1px solid ${notice.kind === "ok" ? "rgba(74,202,122,.35)" : "rgba(255,99,99,.4)"}`, borderRadius: 10, padding: "9px 12px", marginBottom: 12, fontSize: 12, color: notice.kind === "ok" ? "#4ACA7A" : "#FF8A8A", display: "flex", gap: 10 }}>
          <span style={{ flex: 1, overflowWrap: "anywhere" }}>{notice.text}</span>
          <button onClick={() => setNotice(null)} style={{ background: "none", border: "none", color: "rgba(255,255,255,.4)", cursor: "pointer" }}>✕</button>
        </div>
      )}

      {/* ── Active specials ── */}
      {specials === null && <div style={{ fontSize: 12, color: "rgba(255,255,255,.4)", padding: "10px 0" }}>Loading…</div>}
      {specials !== null && active.length === 0 && (
        <div style={{ textAlign: "center", padding: "26px 0", color: "rgba(255,255,255,.4)", fontSize: 13, background: "rgba(255,255,255,.02)", border: "1px dashed rgba(255,255,255,.12)", borderRadius: 12, marginBottom: 18 }}>
          No specials running. Search below to put products on special.
        </div>
      )}
      {active.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {active.map((e) => (
              <div key={e.pid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, background: endSelected.has(e.pid) ? "rgba(255,99,99,.07)" : "rgba(255,255,255,.03)", border: "1px solid " + (endSelected.has(e.pid) ? "rgba(255,99,99,.4)" : "rgba(255,255,255,.07)") }}>
                <input type="checkbox" checked={endSelected.has(e.pid)} onChange={() => toggleEnd(e.pid)}
                  aria-label={`End special on ${e.name || e.pid}`}
                  style={{ width: 16, height: 16, accentColor: "#FF6363", cursor: "pointer", flexShrink: 0 }} />
                {e.photoUrl
                  ? <img src={e.photoUrl} alt="" loading="lazy" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", background: "rgba(255,255,255,.08)", flexShrink: 0 }} />
                  : <div style={{ width: 40, height: 40, borderRadius: 8, background: "rgba(255,255,255,.08)", flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)", marginTop: 2 }}>
                    Started {e.startedAt ? new Date(e.startedAt).toLocaleDateString() : "—"}{e.startedByEmail ? ` by ${e.startedByEmail}` : ""}
                    {e.plannedEndAt ? <> · planned end {String(e.plannedEndAt).slice(0, 10)}{overdue(e) && <b style={{ color: "#FBBF24" }}> · OVERDUE</b>}</> : null}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#4ACA7A" }}>{fmt(e.price)}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,.45)", textDecoration: "line-through" }}>{fmt(e.wasPrice)}</div>
                </div>
              </div>
            ))}
          </div>
          {endSelected.size > 0 && (
            <button onClick={openEndPreview} disabled={busy}
              style={{ marginTop: 10, background: "#B33", color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              End special on {endSelected.size} product{endSelected.size === 1 ? "" : "s"}…
            </button>
          )}
        </div>
      )}

      {/* ── Put products on special ── */}
      <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", margin: "4px 0 8px" }}>Put products on special</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, SKU, barcode…" style={{ ...INPUT, flex: 1, minWidth: 150 }} />
      </div>
      {candidates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10 }}>
          {candidates.map((p) => (
            <label key={p.id}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 9px", borderRadius: 9, cursor: "pointer", background: addSelected.has(p.id) ? "rgba(74,127,255,.08)" : "rgba(255,255,255,.03)", border: "1px solid " + (addSelected.has(p.id) ? "rgba(74,127,255,.4)" : "rgba(255,255,255,.07)") }}>
              <input type="checkbox" checked={addSelected.has(p.id)} onChange={() => toggleAdd(p.id)}
                aria-label={`Select ${p.name || p.id}`}
                style={{ width: 15, height: 15, accentColor: "#4A7FFF", flexShrink: 0 }} />
              {p.photoUrl
                ? <img src={p.photoUrl} alt="" loading="lazy" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover", background: "rgba(255,255,255,.08)", flexShrink: 0 }} />
                : <div style={{ width: 34, height: 34, borderRadius: 7, background: "rgba(255,255,255,.08)", flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)", fontVariantNumeric: "tabular-nums" }}>{fmt(typeof p.retailPrice === "number" && p.retailPrice > 0 ? p.retailPrice : null)}</div>
            </label>
          ))}
        </div>
      )}
      {search.trim() && candidates.length === 0 && <div style={{ fontSize: 12, color: "rgba(255,255,255,.4)", marginBottom: 10 }}>No matching products (already-on-special ones are hidden).</div>}

      {addSelected.size > 0 && (
        <div style={{ background: "rgba(74,127,255,.07)", border: "1px solid rgba(74,127,255,.35)", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#9DBCFF" }}>{addSelected.size} selected</span>
            {selectedProducts.slice(0, 4).map((p) => <span key={p.id} style={{ fontSize: 11, color: "rgba(255,255,255,.55)" }}>{(p.name || "").slice(0, 22)}</span>)}
            {addSelected.size > 4 && <span style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>+{addSelected.size - 4} more</span>}
            <button onClick={() => setAddSelected(new Set())} style={{ background: "none", border: "none", color: "rgba(255,255,255,.45)", fontSize: 12, cursor: "pointer", marginLeft: "auto" }}>Clear</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => setMode("percent")} style={BTN(mode === "percent")}>% off</button>
            <button onClick={() => setMode("absolute")} style={BTN(mode === "absolute")}>Sale price</button>
            {mode === "percent"
              ? <input value={percentDraft} onChange={(e) => setPercentDraft(e.target.value)} placeholder="% off e.g. 20" inputMode="decimal" style={{ ...INPUT, width: 100 }} />
              : <input value={priceDraft} onChange={(e) => setPriceDraft(e.target.value)} placeholder="Sale price (R)" inputMode="decimal" style={{ ...INPUT, width: 110 }} />}
            <label style={{ fontSize: 11.5, color: "rgba(255,255,255,.6)", display: "flex", alignItems: "center", gap: 6 }}>
              Planned end
              <input type="date" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} style={{ ...INPUT, colorScheme: "dark" }} />
            </label>
            <button onClick={openStartPreview} style={{ background: "#4A7FFF", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Preview…</button>
          </div>
        </div>
      )}

      {/* Start preview */}
      {startPreview && (
        <BulkPricePreview
          title={mode === "percent" ? `Start special — ${percentDraft.trim()}% off` : `Start special at ${fmt(Number(priceDraft))}`}
          subtitle={plannedEnd.trim() ? `Planned end ${plannedEnd.trim()} (reminder only)` : "No planned end — runs until you end it"}
          plan={startPreview}
          busy={busy}
          confirmLabel="Start special"
          onConfirm={doStart}
          onCancel={() => setStartPreview(null)}
        />
      )}
      {/* End preview */}
      {endPreview && (
        <BulkPricePreview
          title="End special — normal prices come back"
          plan={endPreview}
          busy={busy}
          confirmLabel="End special"
          onConfirm={doEnd}
          onCancel={() => setEndPreview(null)}
        />
      )}
    </div>
  );
}
