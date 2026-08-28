// ─── CARD RECON — the phone submit screen for the FNB batch slip ─────────────
// A manager settles the till's card machine, tears off the Batch Report, and
// captures it here: pick the TILL, shoot the detail roll (the default ask) and
// the summary, review what the OCR read, submit, see the variance immediately.
//
// KEYED BY TILL, NEVER BY A NAME. The slip prints a TID and no cashier, so the
// picker offers the registered terminals (/config/cardTerminals) and the
// server rejects a slip whose printed TID is not the till that was picked —
// the wrong slip on the wrong till refuses itself. Who worked the till during
// the batch window is DERIVED server-side from the POS tender ledger and shown
// read-only below the review; nobody selects a person anywhere in this
// feature.
//
// NOBODY TYPES THE CARD TOTAL. Every figure on this screen is rendered from
// the server's OCR of the terminal's own printout; there is no editable money
// field, and the submit phase takes the server-parked draft verbatim. A bad
// read is a retake, never a correction by keyboard.
//
// Gate: the dedicated `card_recon` permission (permFlags pattern) — checked by
// the tile, by the route, and independently by the callable. Everything
// money-shaped happens in functions/cardRecon/cardRecon.js; this file is
// capture UX only.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ref as dbRef, onValue } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { database, functions } from "../../firebase";

const cardBatchCaptureFn = httpsCallable(functions, "cardBatchCapture", { timeout: 300000 });

const FONT = "'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,sans-serif";

// Slip photos need legible 8pt thermal print, so the downscale budget is wider
// than the label reader's 1024px. ~2000px keeps a full receipt column sharp
// and a JPEG comfortably under the callable's per-photo ceiling.
const MAX_PHOTO_DIM = 2000;

function fmtR(cents) {
  if (!Number.isInteger(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}R${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
function fmtTime(ms) {
  if (!Number.isInteger(ms)) return "—";
  return new Date(ms).toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

async function downscalePhoto(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("could not read the photo"));
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("could not decode the photo"));
    i.src = dataUrl;
  });
  const scale = Math.min(1, MAX_PHOTO_DIM / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = canvas.toDataURL("image/jpeg", 0.88);
  return { dataUrl: jpeg, base64: jpeg.split(",")[1] || "" };
}

const S = {
  page: { minHeight: "100vh", background: "#05070D", color: "#E9EEFF", fontFamily: FONT, padding: "18px 14px 40px", maxWidth: 560, margin: "0 auto" },
  h1: { fontSize: 20, fontWeight: 800, margin: "6px 0 2px" },
  sub: { fontSize: 13, color: "rgba(233,238,255,.55)", lineHeight: 1.5 },
  card: { background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.09)", borderRadius: 14, padding: 14, marginTop: 14 },
  btn: { width: "100%", minHeight: 54, borderRadius: 13, fontSize: 16, fontWeight: 800, fontFamily: FONT, cursor: "pointer", border: "2px solid rgba(74,127,255,.55)", background: "rgba(74,127,255,.18)", color: "#D7E3FF" },
  btnGhost: { width: "100%", minHeight: 46, borderRadius: 13, fontSize: 14, fontWeight: 700, fontFamily: FONT, cursor: "pointer", border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.04)", color: "rgba(233,238,255,.75)" },
  warn: { background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.3)", borderRadius: 11, padding: "10px 12px", fontSize: 13, color: "#FDE9B0", marginTop: 10, lineHeight: 1.5 },
  err: { background: "rgba(255,107,107,.08)", border: "1px solid rgba(255,107,107,.35)", borderRadius: 11, padding: "10px 12px", fontSize: 13.5, color: "#FFB3B3", marginTop: 10, lineHeight: 1.5 },
  row: { display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.06)", fontSize: 14 },
  k: { color: "rgba(233,238,255,.55)" },
  v: { fontWeight: 700, fontVariantNumeric: "tabular-nums", textAlign: "right" },
};

function Row({ k, v, tone }) {
  return (
    <div style={S.row}>
      <span style={S.k}>{k}</span>
      <span style={{ ...S.v, color: tone || "#E9EEFF" }}>{v}</span>
    </div>
  );
}

export default function CardReconScreen({ onExit }) {
  // ── terminal registry (the till picker's source) ──
  const [terminals, setTerminals] = useState(null); // null = loading
  useEffect(() => {
    const off = onValue(dbRef(database, "config/cardTerminals"),
      (snap) => setTerminals(snap.val() || {}),
      () => setTerminals({}));
    return () => off();
  }, []);
  const terminalList = useMemo(
    () => Object.entries(terminals || {}).map(([tid, t]) => ({ tid, ...t }))
      .sort((a, b) => String(a.label || a.tid).localeCompare(String(b.label || b.tid))),
    [terminals],
  );

  const [tid, setTid] = useState(null);
  const [detailPhotos, setDetailPhotos] = useState([]);   // [{dataUrl, base64}]
  const [summaryPhotos, setSummaryPhotos] = useState([]);
  const [summaryOnly, setSummaryOnly] = useState(false);
  const [busy, setBusy] = useState(null);                  // "extract" | "submit" | null
  const [reject, setReject] = useState(null);              // plain server reason
  const [error, setError] = useState(null);                // transport/unexpected
  const [draft, setDraft] = useState(null);                // { draftId, review }
  const [result, setResult] = useState(null);              // submit response
  const [offerCorrection, setOfferCorrection] = useState(false);
  const detailRef = useRef(null);
  const summaryRef = useRef(null);

  const addPhotos = (setter) => async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setError(null);
    try {
      const prepared = [];
      for (const f of files) prepared.push(await downscalePhoto(f));
      setter((prev) => [...prev, ...prepared]);
    } catch (err) {
      setError(`Could not read that photo (${err?.message || err}).`);
    }
  };

  const extract = async (correction = false) => {
    setBusy("extract");
    setReject(null); setError(null); setOfferCorrection(false);
    try {
      const photos = [...detailPhotos, ...summaryPhotos].map((p) => ({ base64: p.base64 }));
      const { data } = await cardBatchCaptureFn({
        action: "extract", pickedTid: tid, photos,
        summaryOnly: summaryOnly || detailPhotos.length === 0,
        correction,
      });
      if (!data.ok) {
        setReject(data.reason);
        if (/already captured/i.test(data.reason || "")) setOfferCorrection(true);
        return;
      }
      setDraft({ draftId: data.draftId, review: data.review, correction });
    } catch (err) {
      setError(err?.message || String(err));
    } finally { setBusy(null); }
  };

  const submit = async () => {
    if (!draft) return;
    setBusy("submit");
    setReject(null); setError(null);
    try {
      const { data } = await cardBatchCaptureFn({ action: "submit", draftId: draft.draftId });
      if (!data.ok) { setReject(data.reason); return; }
      setResult(data);
    } catch (err) {
      setError(err?.message || String(err));
    } finally { setBusy(null); }
  };

  const reset = () => {
    setTid(null); setDetailPhotos([]); setSummaryPhotos([]); setSummaryOnly(false);
    setReject(null); setError(null); setDraft(null); setResult(null); setOfferCorrection(false);
  };

  const term = terminalList.find((t) => t.tid === tid) || null;

  // ── RESULT — the variance, immediately ──
  if (result) {
    const v = result.varianceCents;
    const balanced = v === 0;
    return (
      <div style={S.page}>
        <button onClick={onExit} style={{ ...S.btnGhost, width: "auto", padding: "0 16px", minHeight: 40 }}>← Home</button>
        <div style={{ ...S.card, textAlign: "center", padding: "26px 16px" }}>
          <div style={{ fontSize: 15, color: "rgba(233,238,255,.6)" }}>Batch {result.batchKey}{result.revision > 1 ? ` (correction, rev ${result.revision})` : ""} recorded</div>
          <div style={{ fontSize: 40, fontWeight: 900, margin: "14px 0 4px", color: balanced ? "#4ADE80" : "#FF6B6B", fontVariantNumeric: "tabular-nums" }}>
            {balanced ? "R0.00" : fmtR(v)}
          </div>
          <div style={{ fontSize: 14, color: balanced ? "#B7F0CC" : "#FFB3B3", fontWeight: 700 }}>
            {balanced ? "Slip matches the POS card takings." : v > 0 ? "The machine settled MORE than the POS card takings." : "The machine settled LESS than the POS card takings."}
          </div>
          <div style={{ marginTop: 16, fontSize: 13.5, color: "rgba(233,238,255,.6)", lineHeight: 1.6 }}>
            Slip total {fmtR(result.slipTotalCents)} · POS expected {fmtR(result.expectedCardCents)}
            {!result.linesCaptured && <div style={{ color: "#FDE9B0", marginTop: 6 }}>Summary-only capture — no transaction lines were recorded, so no line-level match can run for this batch.</div>}
          </div>
        </div>
        {result.expectedChangedSinceReview && (
          <div style={S.warn}>
            The POS card takings for this window changed between the review screen and this
            record — the figure above is the one computed at the moment of record.
          </div>
        )}
        {result.cashiers && result.cashiers.length > 0 && (
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 4 }}>On this till during the batch (from POS activity — read-only)</div>
            {result.cashiers.map((c, i) => (
              <Row key={i} k={c.name || c.uid || "unknown"} v={`${fmtTime(c.firstAt)} → ${fmtTime(c.lastAt)}`} />
            ))}
          </div>
        )}
        <div style={{ marginTop: 16 }}><button style={S.btn} onClick={reset}>Capture another slip</button></div>
      </div>
    );
  }

  // ── REVIEW — what the OCR read; nothing here is editable ──
  if (draft) {
    const r = draft.review;
    return (
      <div style={S.page}>
        <button onClick={() => setDraft(null)} style={{ ...S.btnGhost, width: "auto", padding: "0 16px", minHeight: 40 }}>← Back to photos</button>
        <div style={S.h1}>Check what was read</div>
        <div style={S.sub}>Read from the slip itself. If anything is wrong, go back and reshoot — figures cannot be edited here, by design.</div>
        <div style={S.card}>
          <Row k="Terminal" v={`${r.tid}${r.terminal?.label ? ` · ${r.terminal.label}` : ""}`} />
          <Row k="Batch" v={`#${r.batchNo}${r.revision > 1 ? ` (correction rev ${r.revision})` : ""}`} />
          <Row k="Opened" v={r.openedText || fmtTime(r.openedAt)} />
          <Row k="Closed" v={r.closedText || fmtTime(r.closedAt)} />
          <Row k="Transactions" v={r.txnCount} />
          <Row k="Purchases" v={fmtR(r.purchasesCents)} />
          {r.cashCents !== 0 && <Row k="Cash" v={fmtR(r.cashCents)} />}
          <Row k="Refunds" v={fmtR(-Math.abs(r.refundsCents))} />
          <Row k="Slip TOTAL" v={fmtR(r.totalCents)} />
          {r.reconLine && <Row k="Reconciliation" v={r.reconLine} />}
          <Row k="Lines captured" v={r.summaryOnly ? "none (summary only)" : `${r.lineCount} · TSN contiguous ✓`} tone={r.summaryOnly ? "#FDE9B0" : "#B7F0CC"} />
        </div>
        <div style={S.card}>
          <Row k="POS expected (card)" v={fmtR(r.expectedCardCents)} />
          <Row k="Variance" v={fmtR(r.varianceCents)} tone={r.varianceCents === 0 ? "#4ADE80" : "#FF6B6B"} />
        </div>
        {r.cashiers && r.cashiers.length > 0 && (
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 4 }}>On this till during the batch (from POS activity — read-only)</div>
            {r.cashiers.map((c, i) => (
              <Row key={i} k={c.name || c.uid || "unknown"} v={`${fmtTime(c.firstAt)} → ${fmtTime(c.lastAt)}`} />
            ))}
          </div>
        )}
        {(r.warnings || []).map((w, i) => <div key={i} style={S.warn}>{w}</div>)}
        {reject && <div style={S.err}>{reject}</div>}
        {error && <div style={S.err}>Something went wrong: {error}</div>}
        <div style={{ marginTop: 16 }}>
          <button style={S.btn} disabled={busy === "submit"} onClick={submit}>
            {busy === "submit" ? "Recording…" : "Submit this batch"}
          </button>
        </div>
      </div>
    );
  }

  // ── CAPTURE — pick the till, shoot the roll and the summary ──
  return (
    <div style={S.page}>
      <button onClick={onExit} style={{ ...S.btnGhost, width: "auto", padding: "0 16px", minHeight: 40 }}>← Home</button>
      <div style={S.h1}>Card machine batch slip</div>
      <div style={S.sub}>
        Settle the machine, then capture its Batch Report here. The card total is read off
        the slip itself — nothing is typed.
      </div>

      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 8 }}>1 · Which till?</div>
        {terminals === null ? (
          <div style={S.sub}>Loading terminals…</div>
        ) : terminalList.length === 0 ? (
          <div style={S.warn}>No card terminals are registered yet. An admin must map each machine's TID to its till under /config/cardTerminals (see docs/CARD-RECON.md) before slips can be captured.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {terminalList.map((t) => (
              <button key={t.tid} onClick={() => setTid(t.tid)}
                style={{ ...S.btnGhost, textAlign: "left", padding: "12px 14px",
                         ...(tid === t.tid ? { border: "2px solid rgba(74,127,255,.65)", background: "rgba(74,127,255,.14)", color: "#D7E3FF" } : {}) }}>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{t.label || `${t.storeId} · ${t.tillId}`}</div>
                <div style={{ fontSize: 12, color: "rgba(233,238,255,.5)", marginTop: 2 }}>TID {t.tid}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {tid && (
        <>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 4 }}>2 · The detail roll</div>
            <div style={S.sub}>Shoot the printed transaction list in overlapping sections — every line, sharp. This is the point of the capture.</div>
            <input ref={detailRef} type="file" accept="image/*" capture="environment" multiple
                   onChange={addPhotos(setDetailPhotos)} style={{ display: "none" }} />
            <button style={{ ...S.btn, marginTop: 10 }} onClick={() => detailRef.current?.click()}>
              📷 {detailPhotos.length ? `Add another section (${detailPhotos.length} shot)` : "Shoot the detail roll"}
            </button>
            {detailPhotos.length > 0 && (
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {detailPhotos.map((p, i) => (
                  <img key={i} src={p.dataUrl} alt={`detail ${i + 1}`}
                       onClick={() => setDetailPhotos((prev) => prev.filter((_, j) => j !== i))}
                       style={{ width: 64, height: 86, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,.15)" }} />
                ))}
                <div style={{ ...S.sub, alignSelf: "center", fontSize: 11.5 }}>tap a photo to remove it</div>
              </div>
            )}
            {detailPhotos.length === 0 && (
              <label style={{ ...S.sub, display: "flex", gap: 8, alignItems: "center", marginTop: 12, fontSize: 12.5 }}>
                <input type="checkbox" checked={summaryOnly} onChange={(e) => setSummaryOnly(e.target.checked)} />
                Summary only (fallback) — the record will be flagged: no line-level match can ever run for this batch.
              </label>
            )}
          </div>

          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 4 }}>3 · The summary</div>
            <div style={S.sub}>The header + totals section: MID, TID, batch number, Opened/Closed, Payment Type Summary, CARD TOTALS.</div>
            <input ref={summaryRef} type="file" accept="image/*" capture="environment" multiple
                   onChange={addPhotos(setSummaryPhotos)} style={{ display: "none" }} />
            <button style={{ ...S.btn, marginTop: 10 }} onClick={() => summaryRef.current?.click()}>
              📷 {summaryPhotos.length ? `Add another (${summaryPhotos.length} shot)` : "Shoot the summary"}
            </button>
            {summaryPhotos.length > 0 && (
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {summaryPhotos.map((p, i) => (
                  <img key={i} src={p.dataUrl} alt={`summary ${i + 1}`}
                       onClick={() => setSummaryPhotos((prev) => prev.filter((_, j) => j !== i))}
                       style={{ width: 64, height: 86, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,.15)" }} />
                ))}
              </div>
            )}
          </div>

          {reject && <div style={S.err}>{reject}</div>}
          {offerCorrection && (
            <button style={{ ...S.btnGhost, marginTop: 10 }} disabled={busy === "extract"} onClick={() => extract(true)}>
              The earlier capture was wrong — resubmit as a correction (keeps both)
            </button>
          )}
          {error && <div style={S.err}>Something went wrong: {error}</div>}

          <div style={{ marginTop: 16 }}>
            <button style={S.btn}
              disabled={busy === "extract" || summaryPhotos.length === 0 || (detailPhotos.length === 0 && !summaryOnly)}
              onClick={() => extract(false)}>
              {busy === "extract" ? "Reading the slip…" : "Read the slip"}
            </button>
            {summaryPhotos.length === 0 && <div style={{ ...S.sub, marginTop: 8, fontSize: 12 }}>The summary photo is required.</div>}
            {summaryPhotos.length > 0 && detailPhotos.length === 0 && !summaryOnly && (
              <div style={{ ...S.sub, marginTop: 8, fontSize: 12 }}>Shoot the detail roll, or tick summary-only.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
