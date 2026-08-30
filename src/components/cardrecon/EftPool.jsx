// ─── EFT PAYMENTS — what the mailbox's second reader did, worst first ────────
// The card recon poller also reads FNB EFT payment notifications out of the
// same mailbox and pools them at /eft_pool (owner-only, Admin SDK writes only —
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
// NOTHING READS THE POOL BUT THIS. No matching, no cashier surface, no release
// — those are later sessions. Three outcomes, three different actions:
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
import { database } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { S, fmtTime } from "./cardReconStyles";

const FEED_SIZE = 25;

/** cents → "R1,234.56" — en-US grouping, same choice as the recon feeds. */
const fmtRands = (cents) => {
  if (!Number.isInteger(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}R${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
};

export default function EftPool() {
  const { isSuperAdmin } = usePermissions();
  const [node, setNode] = useState(undefined);   // undefined = loading
  const [denied, setDenied] = useState(false);
  const [broken, setBroken] = useState(null);
  const [open, setOpen] = useState(null);

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

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)" }}>EFT payments</div>
        <div style={{ fontSize: 12, color: refusedCount ? "#FFB3B3" : "rgba(233,238,255,.5)", fontWeight: refusedCount ? 800 : 600 }}>
          {/* These counts describe THE TAIL SHOWN, never the whole pool — the
              read is bounded at FEED_SIZE and the pool grows for ever. */}
          {refusedCount ? `${refusedCount} refused (last ${rows.length})` : `${recordedCount} recorded (last ${rows.length})`}
        </div>
      </div>
      <div style={{ ...S.sub, fontSize: 12, marginTop: 4 }}>
        FNB payment notifications sent to the shop mailbox, verified and pooled. Nothing matches or
        releases against these yet.
      </div>
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
                        : "Could not be read — no reader for this format yet"}
                  </span>
                  <span style={{ color: "rgba(233,238,255,.45)", flex: "0 0 auto", fontSize: 12 }}>{fmtTime(r.at)}</span>
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: "rgba(233,238,255,.5)", marginTop: 3 }}>
                  {r.outcome === "recorded"
                    ? `${r.payer || "payer not named"} · ${r.status}`
                    : r.from || "unknown sender"}
                </span>
              </button>
              {open === r.id && (
                <div style={{ marginTop: 8, display: "grid", gap: 5 }}>
                  {r.reason && (
                    <div style={{ fontSize: 12, lineHeight: 1.45, color: "#FFB3B3" }}>{r.reason}</div>
                  )}
                  <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.55)" }}>
                    {r.subject || "(no subject)"} · auth {r.auth?.verdict}{r.auth?.detail ? ` — ${r.auth.detail}` : ""}
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
