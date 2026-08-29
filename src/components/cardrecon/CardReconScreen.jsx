// ─── CARD RECON — the phone submit screen for the FNB batch slip ─────────────
// A manager settles the till's card machine, tears off the Batch Report, and
// captures it here: pick the TILL, shoot the detail roll (the default ask) and
// the summary, confirm the OCR read the slip correctly, submit. Done.
//
// CAPTURE ONLY — THE MANAGER SEES NOTHING BACK. No variance, no expected
// figure, no comparison, no verdict on whether the till balanced. That is
// deliberate: the owner reviews reconciliation on his own account
// (marathon-pos-app → Reports → Card reconciliation, super-admin only) and
// takes it up with whoever it concerns. A manager who can see the variance
// their own till produced is a manager who can be tempted to manage it.
//
// The server enforces this, not this screen: the callable simply does not
// return expected/variance/cashiers/lines any more. Every figure IS still
// computed and stored on the record — it just never travels to the phone.
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
// the server's OCR of the terminal's own printout — and every one of them is
// something the manager can check against the paper in their hand, which is
// the entire purpose of the review step. There is no editable money field, and
// the submit phase takes the server-parked draft verbatim. A bad read is a
// retake, never a correction by keyboard.
//
// NO CARD NUMBERS. The detail roll's per-transaction masked PAN is parsed and
// stored for the matcher's line identity, and is never sent to this client.
//
// SLIPS THAT ARRIVE BY EMAIL LAND HERE TOO. The terminals email their batch
// report to the shop's mailbox and a poller on the Mac mini submits each PDF
// through the same callable, with nobody involved. That path can REFUSE — an
// unregistered terminal, a duplicate batch, lines that do not sum — and a
// refusal nobody sees is a terminal quietly not reconciling, which is the
// failure this whole feature exists to prevent. So the panel below shows what
// the mailbox produced, worst first. It shows OUTCOMES and never figures: the
// screen stays capture-only.
//
// Gate: the dedicated `card_recon` permission (permFlags pattern) — checked by
// the tile, by the route, and independently by the callable. Everything
// money-shaped happens in functions/cardRecon/cardRecon.js; this file is
// capture UX only.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ref as dbRef, onValue } from "firebase/database";
import { decodeImageFile, isAcceptedImageFile, describePickedFile } from "../shopify/imageDecode";
import { planPhotoIntake, mergeIntake, payloadRefusal, MAX_DETAIL_PHOTOS, MAX_SUMMARY_PHOTOS } from "./photoIntake";
import { httpsCallable } from "firebase/functions";
import { database, functions } from "../../firebase";
import EmailedSlips from "./EmailedSlips";
import { S, fmtTime } from "./cardReconStyles";

const cardBatchCaptureFn = httpsCallable(functions, "cardBatchCapture", { timeout: 300000 });


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

/**
 * A picked file → a ~2000px JPEG, whatever the phone handed over.
 *
 * THE DOWNSCALE IS THE POINT, and it applies to every source equally: this runs
 * on the File objects the input produces, and the input does not record whether
 * they came from the camera or the library. A 12-megapixel library photo of a
 * long roll is reduced here, before it is ever base64'd or sent, which is what
 * keeps a capture uploadable on shop wifi.
 *
 * DECODING GOES THROUGH THE SHARED DECODER, not FileReader + `new Image()`.
 * That mattered the moment gallery selection became a first-class path: an
 * iPhone's library stores HEIC, and while the camera hands back a JPEG through
 * a file input, the library hands back what it has. `new Image()` cannot decode
 * HEIC anywhere but Safari, so the old path would have failed on exactly the
 * phones this change is for. decodeImageFile falls back to a lazily-imported
 * wasm decoder, and resizes DURING decode where the browser supports it — which
 * on a phone is the difference between one upload and three.
 *
 * That resize is gated on the picture's own PIXELS, not on the file's size, so
 * a slip photographed as a heavy but modest-resolution file is no longer
 * UPSCALED on the way in. It matters most here: the clamp below limits the
 * longer side only, so an upscaled bitmap would have been uploaded upscaled —
 * a blurrier photograph of 8pt thermal print, for more bytes.
 */
async function downscalePhoto(file) {
  const decoded = await decodeImageFile(file, MAX_PHOTO_DIM);
  try {
    const { source, width, height } = decoded;
    // decodeImageFile may already have resized during decode; scale from what
    // it actually returned rather than assuming it did or did not.
    const scale = Math.min(1, MAX_PHOTO_DIM / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.88);
    return { dataUrl: jpeg, base64: jpeg.split(",")[1] || "" };
  } finally {
    // An ImageBitmap holds its pixels outside the JS heap; the collector is in
    // no hurry. Six roll sections on a phone is where that shows.
    decoded.release();
  }
}


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
  const [preparing, setPreparing] = useState(0);           // decodes in flight
  // THE PDF PATH. One file is the whole slip — header, totals and detail roll —
  // so it never coexists with photos: adding one clears and disables them, and
  // adding photos disables it. One path per submission, decided here and
  // enforced again in the callable.
  const [pdfFile, setPdfFile] = useState(null);            // { name, size, base64 }
  const pdfRef = useRef(null);
  const [reject, setReject] = useState(null);              // plain server reason
  const [error, setError] = useState(null);                // transport/unexpected
  const [draft, setDraft] = useState(null);                // { draftId, review }
  const [result, setResult] = useState(null);              // submit response
  const [offerCorrection, setOfferCorrection] = useState(false);
  const detailRef = useRef(null);
  const summaryRef = useRef(null);

  // The DECISION is planPhotoIntake (pure, tested on its own). This owns only
  // the parts that need the browser: decoding and state.
  const addPhotos = (setter, current, cap, { replace = false } = {}) => async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setError(null);

    const { keep, take, refusal, notice } = planPhotoIntake({
      current, files, cap, replace,
      isImage: isAcceptedImageFile, describe: describePickedFile,
    });
    if (refusal) { setError(refusal); return; }

    setPreparing((n) => n + 1);
    try {
      const prepared = [];
      for (const f of take) prepared.push(await downscalePhoto(f));
      // FUNCTIONAL, against live state — never `setter([...keep, ...prepared])`.
      // Decoding takes real time (a HEIC goes through a wasm decoder), the
      // picker can be reopened while it runs, and two overlapping picks that
      // each wrote their own stale copy would leave only the second one's
      // photos with nothing said about it.
      setter(mergeIntake({ prepared, cap, replace }));
      if (notice) setError(notice);
    } catch (err) {
      setError(`Could not read that photo (${err?.message || err}).`);
    } finally {
      setPreparing((n) => n - 1);
    }
  };

  // The terminal's emailed batch report. Read as base64 and sent whole — the
  // TEXT is extracted server-side, so the figures never depend on this device
  // and the file itself is what gets stored as evidence.
  const hasPhotos = detailPhotos.length > 0 || summaryPhotos.length > 0;

  const addPdf = async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name || "")) {
      setError(`${file.name || "That file"} is not a PDF. Attach the terminal's emailed batch report.`);
      return;
    }
    setPreparing((n) => n + 1);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = () => reject(new Error("could not read the file"));
        r.readAsDataURL(file);
      });
      const tooBig = payloadRefusal([{ base64 }]);
      if (tooBig) { setError(tooBig); return; }
      setPdfFile({ name: file.name || "batch report.pdf", size: file.size, base64 });
      // ONE PATH: a PDF covers the whole slip, so anything already photographed
      // is cleared rather than left to look as though it will be sent too.
      setDetailPhotos([]); setSummaryPhotos([]); setSummaryOnly(false);
    } catch (err) {
      setError(`Could not read that file (${err?.message || err}).`);
    } finally {
      setPreparing((n) => n - 1);
    }
  };

  const extract = async (correction = false) => {
    setBusy("extract");
    setReject(null); setError(null); setOfferCorrection(false);
    try {
      const photos = [...detailPhotos, ...summaryPhotos].map((p) => ({ base64: p.base64 }));
      // Refused HERE rather than as a transport error the manager cannot read.
      const tooBig = payloadRefusal(pdfFile ? [pdfFile] : photos);
      if (tooBig) { setError(tooBig); setBusy(null); return; }
      const { data } = await cardBatchCaptureFn(pdfFile
        ? { action: "extract", pickedTid: tid, pdf: { base64: pdfFile.base64 }, correction }
        : {
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

  // "Capture another slip" must leave NOTHING of the last one behind — the PDF
  // included. It was missed when the file input was added, and a retained
  // pdfFile meant the next capture would silently re-submit the PREVIOUS
  // terminal's report against a freshly picked till. (CodeRabbit, PR #509.)
  const reset = () => {
    setTid(null); setDetailPhotos([]); setSummaryPhotos([]); setSummaryOnly(false);
    setPdfFile(null);
    setReject(null); setError(null); setDraft(null); setResult(null); setOfferCorrection(false);
  };

  const term = terminalList.find((t) => t.tid === tid) || null;

  // ── RESULT — recorded. Not a verdict. ──
  // CAPTURE ONLY: the manager's job ends when the slip is in. Whether the till
  // balanced is not shown here — the owner reviews that on his own account and
  // takes it up with whoever it concerns. The only thing said back is the one
  // fact that changes what the manager should DO: is the slip recorded, and did
  // the detail roll make it in.
  if (result) {
    return (
      <div style={S.page}>
        <button onClick={onExit} style={{ ...S.btnGhost, width: "auto", padding: "0 16px", minHeight: 40 }}>← Home</button>
        <div style={{ ...S.card, textAlign: "center", padding: "28px 16px" }}>
          <div style={{ fontSize: 44, lineHeight: 1 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 900, margin: "14px 0 6px", color: "#B7F0CC" }}>
            Slip recorded
          </div>
          <div style={{ fontSize: 14, color: "rgba(233,238,255,.65)", lineHeight: 1.6 }}>
            Batch {result.batchKey}{result.revision > 1 ? ` (correction, rev ${result.revision})` : ""} for{" "}
            {term?.label || term?.tid}. Nothing else to do.
          </div>
          {!result.linesCaptured && (
            <div style={{ ...S.warn, textAlign: "left", marginTop: 14 }}>
              Summary only — the transaction lines were not captured. If you can still get
              the detail roll, shoot it and resubmit as a correction.
            </div>
          )}
        </div>
        {(result.warnings || []).map((w, i) => <div key={i} style={S.warn}>{w}</div>)}
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

      <EmailedSlips />

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
          {/* THE FAST PATH, FIRST AND SMALL. FNB terminals can email their batch
              report; that file is the whole slip, so it needs neither the
              detail/summary split nor a large drop area. One line. The photo
              uploads below are the fallback for terminals that cannot email. */}
          <div style={{ ...S.card, padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", flex: "0 0 auto" }}>2 · The PDF</div>
              <div style={{ ...S.sub, flex: "1 1 140px", fontSize: 12 }}>
                {pdfFile ? pdfFile.name : "If the terminal emailed its batch report, this is the whole slip in one file."}
              </div>
              <input ref={pdfRef} type="file" accept="application/pdf,.pdf"
                     onChange={addPdf} style={{ display: "none" }} />
              {pdfFile ? (
                <button style={{ ...S.btnGhost, width: "auto", minHeight: 34, padding: "0 12px", flex: "0 0 auto" }}
                        onClick={() => setPdfFile(null)}>Remove</button>
              ) : (
                <button style={{ ...S.btnGhost, width: "auto", minHeight: 34, padding: "0 14px", flex: "0 0 auto",
                                 opacity: hasPhotos || preparing ? 0.45 : 1 }}
                        disabled={hasPhotos || preparing > 0}
                        onClick={() => pdfRef.current?.click()}>
                  {preparing > 0 ? "Reading…" : "Add file"}
                </button>
              )}
            </div>
            {hasPhotos && !pdfFile && (
              <div style={{ ...S.sub, fontSize: 11.5, marginTop: 6 }}>
                Remove the photos below to attach a PDF instead — one or the other, never both.
              </div>
            )}
          </div>

          <div style={{ ...S.card, opacity: pdfFile ? 0.45 : 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 4 }}>3 · The detail roll</div>
            <div style={S.sub}>The printed transaction list, in overlapping sections — every line, sharp. Shoot it here or pick it from your photos. This is the point of the capture.</div>
            {/* No `capture` attribute: with it, the OS opens the camera and
                nothing else. Without it the manager gets the normal picker and
                can shoot the whole roll in the Photos app first, then pick the
                frames — which is how a long roll actually gets photographed. */}
            <input ref={detailRef} type="file" accept="image/*" multiple
                   onChange={addPhotos(setDetailPhotos, detailPhotos, MAX_DETAIL_PHOTOS)}
                   style={{ display: "none" }} />
            <button style={{ ...S.btn, marginTop: 10, opacity: preparing ? 0.6 : 1 }}
                    disabled={!!pdfFile || preparing > 0 || detailPhotos.length >= MAX_DETAIL_PHOTOS}
                    onClick={() => detailRef.current?.click()}>
              {preparing > 0 ? "Preparing photos…" : `📷 ${detailPhotos.length
                    ? `Add another section (${detailPhotos.length} of ${MAX_DETAIL_PHOTOS})`
                    : "Shoot or choose the detail roll"}`}
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
            {detailPhotos.length === 0 && !pdfFile && (
              <label style={{ ...S.sub, display: "flex", gap: 8, alignItems: "center", marginTop: 12, fontSize: 12.5 }}>
                <input type="checkbox" checked={summaryOnly} onChange={(e) => setSummaryOnly(e.target.checked)} />
                Summary only (fallback) — the record will be flagged: no line-level match can ever run for this batch.
              </label>
            )}
          </div>

          <div style={{ ...S.card, opacity: pdfFile ? 0.45 : 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 4 }}>4 · The summary</div>
            <div style={S.sub}>The header + totals section: MID, TID, batch number, Opened/Closed, Payment Type Summary, CARD TOTALS.</div>
            {/* One slot, and no `capture` here either — same reason. Picking
                again replaces the shot rather than being refused. */}
            <input ref={summaryRef} type="file" accept="image/*"
                   onChange={addPhotos(setSummaryPhotos, summaryPhotos, MAX_SUMMARY_PHOTOS, { replace: true })}
                   style={{ display: "none" }} />
            <button style={{ ...S.btn, marginTop: 10, opacity: preparing ? 0.6 : 1 }}
                    disabled={!!pdfFile || preparing > 0}
                    onClick={() => summaryRef.current?.click()}>
              {preparing > 0 ? "Preparing photos…" : `📷 ${summaryPhotos.length ? "Replace the summary shot" : "Shoot or choose the summary"}`}
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
              // Either path may proceed. A PDF is the whole slip, so it needs
              // no summary photo and no detail roll; the photo path still
              // requires a summary and either a roll or the summary-only tick.
              disabled={busy === "extract" || preparing > 0 || (pdfFile
                ? false
                : summaryPhotos.length === 0 || (detailPhotos.length === 0 && !summaryOnly))}
              onClick={() => extract(false)}>
              {busy === "extract" ? "Reading the slip…" : "Read the slip"}
            </button>
            {pdfFile && <div style={{ ...S.sub, marginTop: 8, fontSize: 12 }}>Reading {pdfFile.name} — the file covers the whole slip, so no photos are needed.</div>}
            {!pdfFile && summaryPhotos.length === 0 && <div style={{ ...S.sub, marginTop: 8, fontSize: 12 }}>The summary photo is required.</div>}
            {!pdfFile && summaryPhotos.length > 0 && detailPhotos.length === 0 && !summaryOnly && (
              <div style={{ ...S.sub, marginTop: 8, fontSize: 12 }}>Add the detail roll, or tick summary-only.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
