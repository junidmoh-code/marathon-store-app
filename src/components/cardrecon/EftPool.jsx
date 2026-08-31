// ─── EFT PAYMENTS — what the mailbox's second reader did, worst first ────────
// The card recon poller also reads EFT payment notifications — sent by each
// PAYER'S OWN BANK — out of the same mailbox and pools them at /eft_pool (owner-only, Admin SDK writes only —
// the /card_batches isolation pattern). This panel is the OWNER'S window on
// that pool, rendered alongside the emailed-slip feed because the failure mode
// that matters is identical: a payment that silently fails to land.
//
// OWNER-ONLY BY RULE AND BY RENDER. The rule alone would show every manager a
// permanent "cannot read" warning; the render gate keeps the panel theirs-not-
// to-see. For the owner, a denied read is therefore never routine — it means
// the /eft_pool rule is not live, and the panel says so instead of showing an
// empty feed that reads as good news.
//
// THE CASHIER SURFACE EXISTS NOW (marathon-pos-app, via the eftPoolSearch /
// eftPoolSettle callables — never a client read on this node): a recorded
// payment moves unmatched → used when a till settles a sale against it, and
// this panel shows the settlement (slip, cashier, customer, when) on the row.
// REVERSING one is the owner's act alone and happens here: the settlement is
// kept whole under `reversals` on the record — both records survive, never a
// silent unwind. Four outcomes, four different actions:
//
//   recorded         a verified payment INTO ONE OF THE SHOP'S OWN ACCOUNTS,
//                    waiting unmatched. Nothing to do yet.
//   refused-auth     a message claiming a bank domain that failed Gmail's DKIM
//                    verification — a forgery attempt.
//   refused-parse    a real bank message no reader could read exactly — a new
//                    bank, or a changed layout. The stored raw text (account
//                    numbers struck out) is the work order for the reader.
//   refused-account  a REAL payment that credits an account that is not on
//                    the owner's allowlist (EFT_ALLOWED_ACCOUNTS in the .env
//                    on the mini) — someone else's money, or an account not
//                    yet listed.
import React, { useEffect, useState } from "react";
import { ref as dbRef, onValue, query, orderByChild, limitToLast } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { database, functions } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { S, fmtTime } from "./cardReconStyles";

const eftPoolReverseFn = httpsCallable(functions, "eftPoolReverse");
const eftPoolSettleFn = httpsCallable(functions, "eftPoolSettle");

const FEED_SIZE = 25;

/** cents → "R1,234.56" — en-US grouping, same choice as the recon feeds. */
const fmtRands = (cents) => {
  if (!Number.isInteger(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}R${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
};

/** One sentence saying where the unapplied part of a consumed payment went.
 *  `fallbackCents` covers records settled BEFORE remainders existed — those
 *  have the arithmetic but no plan, and must still read as money to chase. */
function describeRemainder(rem, fallbackCents) {
  if (!rem) return `${fmtRands(fallbackCents)} overpaid with NO remainder plan (settled before remainders were tracked, or the attach never ran) — reverse and re-settle to resolve it`;
  const amt = fmtRands(rem.cents);
  if (rem.disposition === "credit") {
    if (rem.status === "issued") return `${amt} issued as store credit to ${rem.customerName || "the customer"} (${rem.creditId})`;
    return `${amt} BECOMING store credit for ${rem.customerName || "the customer"} — not issued yet; the POS sweep or a retried attach finishes it`;
  }
  if (rem.status === "held") return `${amt} HELD UNALLOCATED — no customer on the sale; assign one below`;
  return `${amt} unallocated and NOT YET HELD (the follow-up write is pending)`;
}

export default function EftPool() {
  const { isSuperAdmin } = usePermissions();
  const [node, setNode] = useState(undefined);   // undefined = loading
  const [denied, setDenied] = useState(false);
  const [broken, setBroken] = useState(null);
  const [open, setOpen] = useState(null);
  // Reversal flow: which record has the reason box open, the typed reason,
  // in-flight flag and the last error — reversal is deliberate, two taps and
  // a written reason that stays on the record for ever.
  const [revFor, setRevFor] = useState(null);
  const [revReason, setRevReason] = useState("");
  const [revBusy, setRevBusy] = useState(false);
  const [revErr, setRevErr] = useState(null);
  // UNALLOCATED REMAINDERS — money customers overpaid on settlements with no
  // customer attached, held at /eft_unallocated until the owner assigns a
  // customer here (the "allocate" action mints the store credit server-side).
  const [unalloc, setUnalloc] = useState(null);
  const [allocFor, setAllocFor] = useState(null);
  const [allocPhone, setAllocPhone] = useState("");
  const [allocBusy, setAllocBusy] = useState(false);
  const [allocMsg, setAllocMsg] = useState(null);

  async function reverse(id) {
    if (revBusy) return;
    setRevBusy(true);
    setRevErr(null);
    try {
      const { data } = await eftPoolReverseFn({ poolKey: id, reason: revReason.trim() });
      // The onValue listener repaints the row from the database — the record,
      // not this component, is the truth about what happened.
      setRevFor(null);
      setRevReason("");
      // A remainder credit that was already issued is NOT clawed back by a
      // reversal (it may be spent) — say so, or the owner double-pays it back.
      if (data?.creditStands) {
        setRevErr(`Reversed. Store credit ${data.creditStands} was already issued from this payment and STANDS — remove it from the customer (Remove credit at a till) if that is wrong.`);
      }
    } catch (e) {
      setRevErr(e?.message || "The reversal did not go through.");
    } finally {
      setRevBusy(false);
    }
  }

  async function allocate(poolKey) {
    const phone = allocPhone.trim();
    if (allocBusy || !phone) return;
    setAllocBusy(true);
    setAllocMsg(null);
    try {
      const { data } = await eftPoolSettleFn({ poolKey, action: "allocate", customerPhone: phone });
      setAllocMsg({ ok: true, text: `${fmtRands(data?.remainder?.cents)} issued as store credit to ${data?.customer?.name || data?.customer?.id}.` });
      setAllocFor(null);
      setAllocPhone("");
    } catch (e) {
      setAllocMsg({ ok: false, text: e?.message || "The allocation did not go through." });
    } finally {
      setAllocBusy(false);
    }
  }

  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    const off = onValue(
      // The TAIL, never the node — this grows by a record per payment for ever.
      query(dbRef(database, "eft_pool"), orderByChild("at"), limitToLast(FEED_SIZE)),
      (snap) => { setNode(snap.val() || {}); setDenied(false); setBroken(null); },
      (err) => {
        const code = err?.code || "";
        const isDenied = /^permission[-_]denied$/i.test(code);
        setNode(null);
        setDenied(isDenied);
        setBroken(isDenied ? null : (code || "the pool could not be read"));
        console.warn("eft pool: read failed", code || err);
      },
    );
    return () => off();
  }, [isSuperAdmin]);

  // The unallocated list is read WHOLE, not as a tail — it is small by
  // construction (each entry is a settlement the owner has not resolved yet,
  // and resolving removes it), and a held remainder must never age out of
  // sight the way a pool-tail row does.
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    const off = onValue(
      dbRef(database, "eft_unallocated"),
      (snap) => setUnalloc(snap.val() || {}),
      (err) => {
        // Same rule split as the pool: absent rule = warning, not silence.
        setUnalloc(null);
        console.warn("eft unallocated: read failed", err?.code || err);
      },
    );
    return () => off();
  }, [isSuperAdmin]);

  // Managers never see this panel at all — the pool is owner material, and a
  // permanent permission warning on every manager's screen teaches everyone to
  // ignore warnings.
  if (!isSuperAdmin) return null;

  if (denied) {
    return (
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 6 }}>EFT payments</div>
        <div style={S.warn}>
          The /eft_pool rule is not live — this account is the owner and was still refused. Run
          scripts/cardrecon/apply-eft-pool-rules.mjs, or check what changed. Payments themselves are
          unaffected; what is missing is this window on them.
        </div>
      </div>
    );
  }
  if (broken) {
    return (
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 6 }}>EFT payments</div>
        <div style={S.warn}>
          The payment pool could not be read just now ({broken}). This says nothing about the payments
          themselves — try again in a moment.
        </div>
      </div>
    );
  }
  if (node === undefined) return null;

  const rows = Object.entries(node || {})
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const refusedCount = rows.filter((r) => r.outcome !== "recorded").length;
  const recordedCount = rows.length - refusedCount;
  // Settled but never linked to a sale — a till crash between settling and
  // completing, OR a sale that committed and only the slip link failed. Either
  // way it needs eyes: this is the one state the till cannot repair itself.
  const stuckCount = rows.filter((r) => r.status === "used" && r.used && !r.used.sale).length;

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)" }}>EFT payments</div>
        <div style={{ fontSize: 12, color: refusedCount ? "#FFB3B3" : "rgba(233,238,255,.5)", fontWeight: refusedCount ? 800 : 600 }}>
          {/* These counts describe THE TAIL SHOWN, never the whole pool — the
              read is bounded at FEED_SIZE and the pool grows for ever. */}
          {stuckCount ? `${stuckCount} used with NO SALE ATTACHED · ` : ""}
          {refusedCount ? `${refusedCount} refused (last ${rows.length})` : `${recordedCount} recorded (last ${rows.length})`}
        </div>
      </div>
      <div style={{ ...S.sub, fontSize: 12, marginTop: 4 }}>
        Payment notifications from customers' banks, verified, account-checked and pooled. Tills
        settle EFT sales against these; a used payment shows its slip, cashier and customer here.
      </div>
      {/* ── UNALLOCATED REMAINDERS — money owed to a customer nobody named ──
          Read whole (small by construction: resolving removes the entry), so a
          hold can never age out of the pool tail and vanish. Allocating mints
          the customer's store credit through the same mint as everything else. */}
      {unalloc && Object.keys(unalloc).length > 0 && (
        <div style={{ marginTop: 10, border: "1px solid rgba(255,204,102,.45)", background: "rgba(255,204,102,.08)",
                      borderRadius: 11, padding: "9px 11px" }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: "#FFD98A" }}>
            UNALLOCATED EFT MONEY — {Object.keys(unalloc).length} remainder(s) waiting for a customer
          </div>
          {Object.entries(unalloc).sort(([, a], [, b]) => (b.at || 0) - (a.at || 0)).map(([k, u]) => (
            <div key={k} style={{ marginTop: 7, fontSize: 12, lineHeight: 1.5, color: "rgba(233,238,255,.8)" }}>
              <strong>{fmtRands(u.amountCents)}</strong> left over from a {fmtRands(u.paymentCents)} payment
              {u.payer ? ` by ${u.payer}` : ""}{u.reference ? ` (ref ${u.reference})` : ""} —
              slip {u.receiptNumber || "—"}, {u.cashierName || "cashier unknown"}, {fmtTime(u.settledAt)}.
              {allocFor !== k ? (
                <button type="button" disabled={allocBusy}
                        onClick={() => { setAllocFor(k); setAllocPhone(""); setAllocMsg(null); }}
                        style={{ display: "inline-block", marginLeft: 8, font: "inherit", fontSize: 12, color: "#FFD98A",
                                 background: "none", border: "1px solid rgba(255,204,102,.5)", borderRadius: 8,
                                 padding: "2px 9px", cursor: "pointer" }}>
                  Give it to a customer…
                </button>
              ) : (
                <span style={{ display: "flex", gap: 6, marginTop: 5 }}>
                  <input value={allocPhone} onChange={(e) => setAllocPhone(e.target.value)}
                         placeholder="Customer's phone number"
                         inputMode="tel"
                         style={{ font: "inherit", fontSize: 12, padding: "4px 8px", borderRadius: 8, flex: 1,
                                  border: "1px solid rgba(255,255,255,.15)", background: "rgba(0,0,0,.25)", color: "inherit" }} />
                  <button type="button" disabled={allocBusy || !allocPhone.trim()} onClick={() => allocate(k)}
                          style={{ font: "inherit", fontSize: 12, fontWeight: 700, color: "#B7F0CC",
                                   background: "rgba(90,220,140,.12)", border: "1px solid rgba(90,220,140,.5)",
                                   borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>
                    {allocBusy ? "Issuing…" : "Issue store credit"}
                  </button>
                  <button type="button" disabled={allocBusy} onClick={() => { setAllocFor(null); setAllocMsg(null); }}
                          style={{ font: "inherit", fontSize: 12, color: "rgba(233,238,255,.6)",
                                   background: "none", border: "1px solid rgba(255,255,255,.15)",
                                   borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>
                    Not now
                  </button>
                </span>
              )}
            </div>
          ))}
          {allocMsg && (
            <div style={{ marginTop: 6, fontSize: 12, color: allocMsg.ok ? "#B7F0CC" : "#FFB3B3" }}>{allocMsg.text}</div>
          )}
        </div>
      )}
      {rows.length === 0 && (
        <div style={{ ...S.sub, fontSize: 12.5, marginTop: 10 }}>No payment notifications have arrived yet.</div>
      )}
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {rows.map((r) => {
          const bad = r.outcome !== "recorded";
          const isForgery = r.outcome === "refused-auth";
          return (
            // The toggle is a BUTTON; the expanded detail is its SIBLING, not
            // its child — the raw-text region scrolls, and a scroll-drag
            // inside a button is a click that collapses the very thing being
            // read. (Independent adversarial review.)
            <div key={r.id}
                 style={{ border: `1px solid ${bad ? "rgba(255,107,107,.35)" : "rgba(255,255,255,.09)"}`,
                          background: bad ? "rgba(255,107,107,.07)" : "rgba(255,255,255,.03)",
                          borderRadius: 11, padding: "9px 11px" }}>
              <button type="button"
                   onClick={() => setOpen(open === r.id ? null : r.id)}
                   aria-expanded={open === r.id}
                   style={{ display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit",
                            border: "none", background: "none", padding: 0, cursor: "pointer" }}>
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                  <span style={{ fontWeight: 700, color: bad ? "#FFB3B3" : "#B7F0CC", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.outcome === "recorded"
                      ? `${fmtRands(r.amountCents)}${r.reference ? ` · ${r.reference}` : " · (no reference)"}`
                      : isForgery ? "FAILED AUTHENTICATION — forgery attempt"
                      : r.outcome === "refused-account"
                        ? `${fmtRands(r.amountCents)} INTO A DIFFERENT ACCOUNT${r.destination?.accountMask ? ` (${r.destination.accountMask})` : ""}`
                        : "Could not be read exactly — open for the reason"}
                  </span>
                  <span style={{ color: "rgba(233,238,255,.45)", flex: "0 0 auto", fontSize: 12 }}>{fmtTime(r.at)}</span>
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: "rgba(233,238,255,.5)", marginTop: 3 }}>
                  {r.outcome === "recorded"
                    ? (r.status === "used" && r.used
                        ? `USED ${fmtTime(r.used.at)} · slip ${r.used.sale?.receiptNumber || "not attached"} · ${r.used.cashierName || "cashier unknown"}${r.used.customerName ? ` · ${r.used.customerName}` : ""}`
                        : `${r.payer || "payer not named"} · ${r.status}${r.reversals ? ` · ${Object.keys(r.reversals).length} reversal(s)` : ""}`)
                    : r.from || "unknown sender"}
                </span>
              </button>
              {open === r.id && (
                <div style={{ marginTop: 8, display: "grid", gap: 5 }}>
                  {r.status === "used" && r.used && (
                    <div style={{ fontSize: 12, lineHeight: 1.5, color: "rgba(233,238,255,.75)" }}>
                      Settled {fmtTime(r.used.at)} by {r.used.cashierName || "an unknown cashier"}
                      {/* THE WHOLE AMOUNT, ACCOUNTED FOR. A payment bigger
                          than the sale is consumed whole; the difference must
                          say exactly where it went — store credit (whose,
                          which credit, issued or still pending) or held
                          unallocated — never a bare "overpaid". */}
                      {Number.isInteger(r.used.appliedCents) && Number.isInteger(r.amountCents) && r.used.appliedCents < r.amountCents
                        ? ` — applied ${fmtRands(r.used.appliedCents)} of ${fmtRands(r.amountCents)}; ${describeRemainder(r.used.remainder, r.amountCents - r.used.appliedCents)}`
                        : ""}
                      {r.used.tillId ? ` (${r.used.storeId || "?"} / ${r.used.tillId})` : ""}
                      {r.used.customerName ? ` for ${r.used.customerName}` : ""} —
                      {r.used.sale
                        ? ` sale ${r.used.sale.saleId}, slip ${r.used.sale.receiptNumber || "—"}`
                        : " no sale attached — either the sale never completed, OR it completed and only the slip link failed. Check Sale History for a matching sale before reversing; reversing frees the payment to be used again."}
                      {revFor !== r.id ? (
                        <button type="button" disabled={revBusy}
                                onClick={() => { setRevFor(r.id); setRevReason(""); setRevErr(null); }}
                                style={{ display: "block", marginTop: 6, font: "inherit", fontSize: 12, color: "#FFB3B3",
                                         background: "none", border: "1px solid rgba(255,107,107,.4)", borderRadius: 8,
                                         padding: "4px 10px", cursor: "pointer" }}>
                          Reverse this settlement…
                        </button>
                      ) : (
                        <span style={{ display: "grid", gap: 5, marginTop: 6 }}>
                          {/* The callable retains 300 chars — cap the input so
                              no part of an audit reason is silently dropped. */}
                          <input value={revReason} onChange={(e) => setRevReason(e.target.value)}
                                 maxLength={300}
                                 placeholder="Why — this stays on the record"
                                 style={{ font: "inherit", fontSize: 12, padding: "5px 8px", borderRadius: 8,
                                          border: "1px solid rgba(255,255,255,.15)", background: "rgba(0,0,0,.25)", color: "inherit" }} />
                          <span style={{ display: "flex", gap: 6 }}>
                            <button type="button" disabled={revBusy || !revReason.trim()} onClick={() => reverse(r.id)}
                                    style={{ font: "inherit", fontSize: 12, fontWeight: 700, color: "#FFB3B3",
                                             background: "rgba(255,107,107,.12)", border: "1px solid rgba(255,107,107,.5)",
                                             borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>
                              {revBusy ? "Reversing…" : "Confirm reverse"}
                            </button>
                            <button type="button" disabled={revBusy} onClick={() => { setRevFor(null); setRevErr(null); }}
                                    style={{ font: "inherit", fontSize: 12, color: "rgba(233,238,255,.6)",
                                             background: "none", border: "1px solid rgba(255,255,255,.15)",
                                             borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>
                              Keep it
                            </button>
                          </span>
                          {revErr && <span style={{ fontSize: 12, color: "#FFB3B3" }}>{revErr}</span>}
                        </span>
                      )}
                    </div>
                  )}
                  {r.reversals && (
                    <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "rgba(233,238,255,.55)" }}>
                      {Object.entries(r.reversals).sort(([a], [b]) => Number(a) - Number(b)).map(([ts, v]) => (
                        <div key={ts}>
                          Reversed {fmtTime(Number(ts))}: was settled by {v.cashierName || "?"}
                          {v.sale?.receiptNumber ? ` (slip ${v.sale.receiptNumber})` : ""} — {v.reason || "no reason recorded"}
                        </div>
                      ))}
                    </div>
                  )}
                  {r.reason && (
                    <div style={{ fontSize: 12, lineHeight: 1.45, color: "#FFB3B3" }}>{r.reason}</div>
                  )}
                  <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.55)" }}>
                    {r.subject || "(no subject)"} · auth {r.auth?.verdict}
                    {r.reader ? ` · ${r.reader} reader` : ""}
                    {r.auth?.detail ? ` — ${r.auth.detail}` : ""}
                  </div>
                  {r.rawText && (
                    <div style={{ fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap",
                                  color: "rgba(233,238,255,.45)", maxHeight: 180, overflowY: "auto" }}>
                      {r.rawText}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
